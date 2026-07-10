// ═══════════════════════════════════════════════════════════
// ocrFirstWiring — gates services/ocrFirst.extractViaOcr into the slip-ingest
// path behind the tri-state OCR_FIRST_MODE flag (off | shadow | cutover).
//
//   off      (default) — no-op. extractViaOcr is NEVER called. The seam guards
//                        on `MODE !== 'off'` so off-mode is truly zero-cost.
//   shadow             — fire-and-forget. Kicks off extractViaOcr WITHOUT
//                        awaiting on the request path, compares the OCR decision
//                        to the live vision parse, and emits one
//                        `ocr_shadow_decision` event. NEVER mutates the staged
//                        bet. NEVER throws. Adds ZERO latency to ingest (the OCR
//                        ~4s floor runs entirely off the request path).
//   cutover  (dormant) — awaits extractViaOcr within an OCR_TIMEOUT_MS budget.
//                        Replaces the staged bet ONLY when ALL eligibility guards
//                        pass: live parse is a NEW bet (not a result/recap),
//                        single-image, and OCR produced a SUPPORTED sport. Any
//                        other case → null → caller stays on the live path.
//
// This module is the SINGLE tested code path shared by both slip seams
// (handlers/messageHandler.js: processAggregatedMessage + processSlipImage), so
// the per-seam edit is one guarded call. See docs/specs/ocr-first.md §6/§8.
//
// SAFETY: applyOcrFirst / runShadow / runCutover NEVER throw and NEVER return
// null-for-parsed — a thrown or null-y ocrFirst can never break the live path in
// ANY mode. All network/OCR work is dependency-injectable for unit tests
// (deps.{fetchImageBytes, extractViaOcr, inferSport, callOcrService,
// callGroqParse}); the recordStage sink is injectable too (recordStageFn) so
// wiring tests need no DB.
// ═══════════════════════════════════════════════════════════

'use strict';

const { extractViaOcr, callGroqParse, extractHeaderLegCount, ReasonCode } = require('./ocrFirst');
const { evaluateSgpGate } = require('./sgpGate');

// ── Mode (read at module load; prod reads env once at boot) ──
const VALID_MODES = new Set(['off', 'shadow', 'cutover']);
function resolveMode(raw) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase();
  return VALID_MODES.has(m) ? m : 'off';
}
const MODE = resolveMode(process.env.OCR_FIRST_MODE);

// ── SGP drop→hold mode (PR 2b, design D2) ──
// Separate flag from OCR_FIRST_MODE ON PURPOSE: the drop→hold flip is gated on
// the SGP gate's own shadow validation (PR 2a's ocr_sgp_would_hold split +
// docs/regrades/sgp-audit-20260710.json), NOT on the full OCR-first cutover bar
// (spec §8.1) — riding OCR_FIRST_MODE=cutover would couple the rescue to an
// unrelated flip. Same tri-state idiom, but read PER CALL (the
// EVENT_AWARE_RECHECK variant, not this module's read-at-load MODE) so ops can
// flip without a restart and tests can toggle per case.
//   off     (default) — no calls, no events, byte-identical ingest.
//   shadow            — fire-and-forget: run the chain at the EXACT enforce
//                       seam, emit one `ocr_sgp_hold_shadow` event, never
//                       change routing. (PR 2a's ocr_sgp_would_hold measures a
//                       different population — every SGP bail in runShadow —
//                       and is THROWAWAY once 2b is live.)
//   enforce           — on a gate PASS return { hold:true, sgp } so the caller
//                       stages MANUAL_REVIEW_HOLD instead of the drop/skip; on
//                       FAIL or ANY error return { hold:false } with no event —
//                       fail-safe is always what happens today.
const SGP_HOLD_MODES = new Set(['off', 'shadow', 'enforce']);
function resolveSgpHoldMode(raw = process.env.SGP_HOLD_MODE) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase();
  return SGP_HOLD_MODES.has(m) ? m : 'off';
}

// ── Wiring-level reason codes (distinct from ocrFirst's ReasonCode; surfaced in
//    the shadow/cutover events so each fallback route is attributable). ──
const WiringReason = Object.freeze({
  NO_IMAGE_BYTES: 'OCR_NO_IMAGE_BYTES',
  IMAGE_HOST_BLOCKED: 'OCR_IMAGE_HOST_BLOCKED',   // Fix 1: non-https / non-allowlisted host — never fetched
  IMAGE_TOO_LARGE: 'OCR_IMAGE_TOO_LARGE',         // Fix 1: content-length or streamed bytes exceed cap — aborted
  IMAGE_TIMEOUT: 'OCR_IMAGE_TIMEOUT',             // Fix 1: fetch AbortController fired — fetch aborted
  CUTOVER_SKIP_NONBET: 'OCR_CUTOVER_SKIP_NONBET', // Fix 2: live parse is result/recap — never restage as new bet
  CUTOVER_SKIP_MULTI_IMAGE: 'OCR_CUTOVER_SKIP_MULTI_IMAGE', // Fix 3: >1 image — OCR saw only image[0]
  CUTOVER_SKIP_SPORT: 'OCR_CUTOVER_SKIP_SPORT',   // Fix 4: OCR-derived sport unresolved/unsupported
  CUTOVER_EXCEPTION: 'OCR_CUTOVER_EXCEPTION',
  CONVERT_EMPTY: 'OCR_CONVERT_EMPTY',
});

// Discord CDN image hosts — slip images arrive as direct uploads
// (getImageAttachments → att.url on cdn.discordapp.com; media.discordapp.net is
// the refreshed/proxied variant). Embed images are external tweet previews, NOT
// slips, so they are intentionally NOT allowlisted. No arbitrary-host fetch.
const ALLOWED_IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

// Sports the grader supports (mirrors services/ai.js SPORT_TEAM_MAP keys). The
// cutover converter must resolve one of these or it falls back (Fix 4).
const SUPPORTED_SPORTS = new Set(['MLB', 'NBA', 'NFL', 'NHL', 'SOCCER', 'TENNIS', 'GOLF', 'MMA']);

// ── Config getters (read at call time so secrets hot-swap) ──
function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function baseTimeoutMs() { return intEnv('OCR_TIMEOUT_MS', 8000); }
// Cutover total-orchestration budget: ONE deadline shared across fetch + extract.
function cutoverBudgetMs() { return baseTimeoutMs(); }
// Shadow fetch abort deadline (fire-and-forget path); falls back to OCR_TIMEOUT_MS.
function shadowTimeoutMs() { return intEnv('OCR_SHADOW_TIMEOUT_MS', baseTimeoutMs()); }
// Hard ceiling on fetched image bytes (content-length AND streamed). Default 10MB.
function imageMaxBytes() { return intEnv('OCR_IMAGE_MAX_BYTES', 10 * 1024 * 1024); }

// Lazy pipeline-events require — keeps this module (and the wiring unit tests)
// free of the database.js require chain unless an emit actually fires with the
// default sink. Tests inject recordStageFn and never hit this.
let _recordStage = null;
function defaultRecordStage(evt) {
  if (!_recordStage) _recordStage = require('./pipeline-events').recordStage;
  return _recordStage(evt);
}

// Lazy ai.js require for sport inference — ai.js carries no DB dep but is heavy
// (sharp); load it only when the cutover converter actually runs. Never throws.
let _inferLegSport = null;
function lazyInferLegSport(desc) {
  try {
    if (!_inferLegSport) _inferLegSport = require('./ai').inferLegSport;
    return _inferLegSport(desc);
  } catch (_) {
    return null;
  }
}

// ── Small parse helpers (cutover converter) ──
function parseAmericanOdds(v) {
  if (v == null) return null;
  const m = String(v).match(/[+-]?\d{2,5}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}
function parseMoney(v) {
  if (v == null) return null;
  const m = String(v).replace(/[, ]/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function s(v) { return v == null ? '' : String(v).trim(); }

// One human-readable description line from an OCR leg.
function legLine(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const entity = s(leg.player) || s(leg.matchup);
  const parts = [entity, s(leg.selection), s(leg.market)].filter(Boolean);
  // De-dup the common case where selection already contains the market text.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function mapBetType(ocrBetType, legCount) {
  const t = s(ocrBetType).toLowerCase();
  if (t === 'single') return legCount > 1 ? 'parlay' : 'straight';
  if (t === 'parlay' || t === 'sgp' || t === 'sgpmax') return 'parlay';
  return legCount > 1 ? 'parlay' : 'straight';
}

// First supported sport inferred across the leg descriptions, else null.
function inferSportFromLegs(internalLegs, inferFn) {
  const fn = inferFn || lazyInferLegSport;
  for (const l of internalLegs) {
    const sport = fn(l.description || '');
    if (sport && SUPPORTED_SPORTS.has(String(sport).toUpperCase())) return String(sport).toUpperCase();
  }
  return null;
}
function isSupportedSport(sport) {
  return !!sport && SUPPORTED_SPORTS.has(String(sport).toUpperCase().trim());
}

/**
 * True slip-image count for multi-image eligibility (and the shadow `scope`
 * label). HRB-style share posts arrive as 1 real slip attachment + 1 Discord
 * share-embed THUMBNAIL; counting the embed inflates the count to 2, so cutover
 * would skip the slip (`OCR_CUTOVER_SKIP_MULTI_IMAGE`) and shadow would force
 * `scope=image[0]_of_multi` + `agreement=false`, making the OCR-vs-vision signal
 * unreadable. The rescue replay confirmed real attachment count = 1 on all 25
 * HRB failures — the "2nd image" lives in `message.embeds[]`, not attachments.
 *
 * Counts only REAL slip attachments: image objects tagged `origin:'attachment'`
 * by handlers/messageHandler.js `getImageAttachments` (direct `message.attachments[]`
 * uploads + forwarded snapshot attachments). Share-embed / link-preview
 * thumbnails are tagged `origin:'embed'` and excluded, so the slip+embed artifact
 * collapses to 1 while a genuine 2-attachment post still counts as 2.
 *
 * Fail-safe — NEVER wrongly collapse a real multi-image slip: when no image is
 * tagged as a real attachment (an untagged/legacy list, or a slip that arrived
 * purely as embed images), fall back to the TOTAL image count (the prior
 * behavior). The returned count is therefore always ≤ the total, so this can
 * only ever flip multi→single, never single→multi.
 */
function eligibleImageCount(images) {
  const list = Array.isArray(images) ? images : [];
  const attachments = list.reduce((n, img) => n + (img && img.origin === 'attachment' ? 1 : 0), 0);
  return attachments >= 1 ? attachments : list.length;
}

/**
 * Convert a Groq OCR parsedBet (docs/specs/ocr-first.md §4 schema) into the
 * internal bet shape consumed by the existing staging pipeline
 * (createBetWithLegs). Returns an ARRAY (one slip = one bet w/ legs) so a
 * multi-image merge upstream is a no-op (length 1). Returns [] if unusable.
 *
 * Sport is inferred lazily from the leg text via ai.js inferLegSport (Fix 4); it
 * stays 'Unknown' when nothing resolves, and the cutover path then falls back
 * rather than staging an Unknown-sport bet. `opts.inferSport` overrides the
 * inferrer for tests.
 */
function ocrBetToInternalBets(ocr, opts = {}) {
  if (!ocr || typeof ocr !== 'object') return [];
  const legs = Array.isArray(ocr.legs) ? ocr.legs.filter(Boolean) : [];
  if (legs.length === 0) return [];

  const betType = mapBetType(ocr.bet_type, legs.length);
  const internalLegs = legs.map((l) => ({
    description: legLine(l),
    odds: parseAmericanOdds(l.odds),
  })).filter((l) => l.description);
  if (internalLegs.length === 0) return [];

  const description = internalLegs.map((l) => l.description).join('\n');
  const sport = inferSportFromLegs(internalLegs, opts.inferSport) || 'Unknown';

  // event_date: the Groq schema already captures each leg's printed
  // start_time ("Today, 4:05pm EDT" — ocrFirst.js OCR_PARSE_SYSTEM); pass the
  // FIRST non-empty one through VERBATIM as the bet-level slate anchor (same
  // first-leg convention the vision parser follows on multi-leg slips, spec
  // §5.5). No parsing here: normalizeEventDateForStorage resolves the string
  // against created_at at insert (its relative-token branch matches exactly
  // this HRB format) and gap-guards it — an unparseable/implausible value
  // stores NULL, the pre-threading behavior.
  const firstStartTime = legs
    .map((l) => (l && typeof l.start_time === 'string' ? l.start_time.trim() : ''))
    .find((t) => t.length > 0) || null;

  return [{
    sport,
    league: null,
    bet_type: betType,
    description,
    odds: parseAmericanOdds(ocr.total_odds),
    units: null,              // never invent stake → defaults to 1 downstream
    wager: parseMoney(ocr.stake),
    payout: parseMoney(ocr.payout),
    event_date: firstStartTime,
    legs: internalLegs,
  }];
}

function guessMediaType(url) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.gif')) return 'image/gif';
  return null;
}

/**
 * Fetch slip image bytes (URL → base64 + mediaType). NEVER throws — returns a
 * typed result `{ ok:true, base64, mediaType }` or `{ ok:false, reason }`.
 *
 * Hardened (Fix 1):
 *  - HTTPS + host allowlist (Discord CDN). Disallowed/non-https → IMAGE_HOST_BLOCKED
 *    with NO network attempt.
 *  - AbortController that actually ABORTS the underlying fetch at `timeoutMs`
 *    (shadow: OCR_SHADOW_TIMEOUT_MS; cutover: remaining OCR_TIMEOUT_MS budget).
 *  - Byte cap (OCR_IMAGE_MAX_BYTES): content-length pre-check AND a streaming
 *    ceiling that aborts mid-download; never buffers unbounded.
 */
async function fetchImageBytes(imageUrl, fallbackMediaType, timeoutMs) {
  if (!imageUrl) return { ok: false, reason: WiringReason.NO_IMAGE_BYTES };
  let parsedUrl;
  try {
    parsedUrl = new URL(String(imageUrl));
  } catch (_) {
    return { ok: false, reason: WiringReason.IMAGE_HOST_BLOCKED };
  }
  if (parsedUrl.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return { ok: false, reason: WiringReason.IMAGE_HOST_BLOCKED }; // never fetched
  }

  const max = imageMaxBytes();
  const controller = new AbortController();
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : baseTimeoutMs();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch (_) { /* noop */ } }, ms);

  try {
    const res = await fetch(String(imageUrl), { signal: controller.signal });
    if (!res || !res.ok) { clearTimeout(timer); return { ok: false, reason: WiringReason.NO_IMAGE_BYTES }; }

    // mediaType: prefer the response content-type, then caller hint, then ext, then png.
    let mediaType = '';
    try {
      const ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
      if (ct && ct.toLowerCase().startsWith('image/')) mediaType = ct.split(';')[0].trim();
    } catch (_) { /* header read optional */ }
    if (!mediaType) mediaType = s(fallbackMediaType) || guessMediaType(imageUrl) || 'image/png';

    // content-length pre-check — reject before downloading a known-oversized body.
    let clen = NaN;
    try { clen = parseInt(res.headers && res.headers.get ? res.headers.get('content-length') : '', 10); } catch (_) { /* noop */ }
    if (Number.isFinite(clen) && clen > max) {
      try { controller.abort(); } catch (_) { /* noop */ }
      clearTimeout(timer);
      return { ok: false, reason: WiringReason.IMAGE_TOO_LARGE };
    }

    // Streaming ceiling — abort mid-download if the body exceeds the cap.
    let buf = null;
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (reader) {
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > max) {
            try { controller.abort(); } catch (_) { /* noop */ }
            try { await reader.cancel(); } catch (_) { /* noop */ }
            clearTimeout(timer);
            return { ok: false, reason: WiringReason.IMAGE_TOO_LARGE };
          }
          chunks.push(Buffer.from(value));
        }
      }
      buf = Buffer.concat(chunks);
    } else {
      // No streaming reader available — buffer then post-check the cap.
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) { clearTimeout(timer); return { ok: false, reason: WiringReason.IMAGE_TOO_LARGE }; }
    }

    clearTimeout(timer);
    if (!buf || buf.length === 0) return { ok: false, reason: WiringReason.NO_IMAGE_BYTES };
    return { ok: true, base64: buf.toString('base64'), mediaType };
  } catch (err) {
    clearTimeout(timer);
    if (timedOut || (err && err.name === 'AbortError')) return { ok: false, reason: WiringReason.IMAGE_TIMEOUT };
    return { ok: false, reason: WiringReason.NO_IMAGE_BYTES }; // unreachable / reset
  }
}

// ── Live-vs-OCR comparison (shadow) ──
function countLiveLegs(parsed) {
  const bets = parsed && Array.isArray(parsed.bets) ? parsed.bets : [];
  if (bets.length === 0) return 0;
  return bets.reduce((n, b) => n + (b && Array.isArray(b.legs) && b.legs.length ? b.legs.length : 1), 0);
}
function liveBetType(parsed) {
  const b = parsed && Array.isArray(parsed.bets) && parsed.bets[0];
  return b && b.bet_type ? String(b.bet_type).toLowerCase() : null;
}
function betTypeFamily(t) {
  const x = String(t || '').toLowerCase();
  if (x.includes('parlay') || x === 'sgp' || x === 'sgpmax') return 'parlay';
  if (x === 'single' || x === 'straight' || x === 'moneyline' || x === 'spread' || x === 'total') return 'single';
  if (x.includes('prop')) return 'prop';
  return x || null;
}
function compareToLive(decision, parsed) {
  const ocrLegCount = decision && decision.parsedBet && Array.isArray(decision.parsedBet.legs)
    ? decision.parsedBet.legs.length
    : (decision && decision.evidence && Number.isFinite(decision.evidence.parsedLegCount)
      ? decision.evidence.parsedLegCount : 0);
  const liveLegCount = countLiveLegs(parsed);
  const mismatchFields = [];
  if (decision && decision.action === 'USE_OCR') {
    if (ocrLegCount !== liveLegCount) mismatchFields.push('legCount');
    const lbt = betTypeFamily(liveBetType(parsed));
    const obt = betTypeFamily(decision.parsedBet && decision.parsedBet.bet_type);
    if (lbt && obt && lbt !== obt) mismatchFields.push('betType');
  }
  const agreement = !!(decision && decision.action === 'USE_OCR' && liveLegCount > 0 && mismatchFields.length === 0);
  return { ocrLegCount, liveLegCount, agreement, mismatchFields };
}

// Live parse is a settled result / recap, not a new bet to stage.
function isNonNewBet(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.type === 'result' || parsed.type === 'untracked_win') return true;
  if (parsed.ticket_status === 'winner' || parsed.ticket_status === 'loser') return true;
  return false;
}

// ── Event emitters (lean payloads; never throw) ──
function emit(recordStageFn, eventType, requestId, sourceRef, payload) {
  try {
    (recordStageFn || defaultRecordStage)({
      ingestId: requestId,
      sourceType: 'discord',
      sourceRef: sourceRef || null,
      stage: 'OCR_FIRST',
      eventType,
      payload,
    });
  } catch (_) { /* observability must never break ingest */ }
}

/**
 * SGP would-hold MEASUREMENT (PR 2a — shadow-only, NO behavior change). à la the
 * Gate-3 B0 would-fire pattern (#37): emit one trace event, act on nothing.
 *
 * extractViaOcr bails SGP/SGPMAX slips to FALLBACK_GEMINI *before* Groq runs
 * (services/ocrFirst.js "SGP gate — BEFORE Groq"), so SGP slips get no parse and
 * the gate has never run on real traffic. This re-uses the OCR text that bail
 * already produced to run the skipped chain — Groq parse → declaredLegCount
 * (N-Bet header) → evaluateSgpGate — and emits ONE `ocr_sgp_would_hold` event so
 * we can confirm on live traffic that the gate PASSes rescuable SGP slips and
 * FAILs junk, BEFORE PR 2b flips drop→hold on a PASS.
 *
 * PURE OBSERVABILITY: the caller's returned decision stays FALLBACK_GEMINI; this
 * never mutates the staged bet, never awaits on the request path, and SWALLOWS
 * every error (one warn, never throws). The added Groq call is shadow-only. A
 * missing N-Bet header → evaluateSgpGate returns pass:false SGP_NO_DECLARED_COUNT
 * (no rescue, recorded) — same fail-safe spirit as the gate guardrail.
 *
 * @param {object} args
 * @param {object} args.decision  the FALLBACK_GEMINI/OCR_SGP_GATE decision (carries ocrText + timingsMs)
 * @param {string} args.scope     'single' | 'image[0]_of_multi' (carried for analysis)
 */
async function runSgpWouldHold({ decision, scope, requestId, sourceRef, recordStageFn, deps }) {
  try {
    const ocrText = decision && typeof decision.ocrText === 'string' ? decision.ocrText : '';
    const groqParse = (deps && deps.callGroqParse) || callGroqParse;
    const parseRes = await groqParse(ocrText, requestId);
    const parsedBet = parseRes && parseRes.ok === true && parseRes.parsed ? parseRes.parsed : null;
    const parsedLegCount = parsedBet && Array.isArray(parsedBet.legs) ? parsedBet.legs.length : null;
    // Runtime declared-count source: the advisory "N-Bet Parlay" header (null when absent).
    const declaredLegCount = extractHeaderLegCount(ocrText);
    const gate = evaluateSgpGate({ declaredLegCount, parsedBet, ocrText });
    emit(recordStageFn, 'ocr_sgp_would_hold', requestId, sourceRef, {
      pass: gate.pass,
      reason: gate.reason,
      declaredLegCount: declaredLegCount != null ? declaredLegCount : null,
      parsedLegCount,
      scope,
      // ocrMs mirrors ocr_shadow_decision (timingsMs.total) so one query reads both events.
      ocrMs: decision && decision.timingsMs ? decision.timingsMs.total : null,
    });
  } catch (err) {
    // Measurement must NEVER affect ingest — swallow EVERYTHING (incl. the emit path).
    try { console.warn(`[ocrFirst/shadow] sgp would-hold swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
  }
}

// One human-readable description line from a NORMALIZED sgpGate leg
// ({ entity, market, line, odds } — evaluateSgpGate's normalizedBet shape, NOT
// the raw Groq leg legLine() takes). Mirrors legLine's ordering + case-folded
// dedup so the promoted market-in-selection case ("TO RECORD 1+ HITS" as both
// market and line) renders once.
function sgpHoldLegLine(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const parts = [s(leg.entity), s(leg.line), s(leg.market)].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The SGP drop→hold chain (shared verbatim by shadow and enforce so the shadow
 * population ≡ the enforce population): fetch image bytes → extractViaOcr →
 * REQUIRE the pre-Groq SGP bail (reason OCR_SGP_GATE — anything else means "not
 * an SGP slip / OCR failed", not a gate FAIL) → Groq parse the bail's ocrText →
 * declaredLegCount from the N-Bet header → evaluateSgpGate. Exactly the PR 2a
 * would-hold chain (runSgpWouldHold), run synchronously with a fresh OCR pass
 * because at the vision-failure seam the shadow decision is long gone.
 *
 * Returns { ran:false, reason } when the chain never reached the gate, else
 * { ran:true, pass, gateReason, normalizedBet, sgpToken, declaredLegCount,
 *   parsedLegCount, ocrMs }. May reject — callers wrap it.
 */
async function evaluateSgpHold({ imageUrl, mediaType, requestId, deps }) {
  const fetchBytes = (deps && deps.fetchImageBytes) || fetchImageBytes;
  const extract = (deps && deps.extractViaOcr) || extractViaOcr;
  const groqParse = (deps && deps.callGroqParse) || callGroqParse;

  const img = await fetchBytes(imageUrl, mediaType, baseTimeoutMs());
  if (!img || img.ok !== true) {
    return { ran: false, reason: (img && img.reason) || WiringReason.NO_IMAGE_BYTES };
  }
  const decision = await extract(img.base64, img.mediaType, requestId, deps);
  if (!decision || decision.reason !== ReasonCode.SGP_GATE) {
    // Non-SGP slip (any other reason incl. OCR_PARSE_OK) or OCR failure — the
    // rescue is scoped to SGP/SGPMAX bails only. No Groq call is spent.
    return { ran: false, reason: decision ? decision.reason : 'OCR_UNKNOWN' };
  }
  const ocrText = typeof decision.ocrText === 'string' ? decision.ocrText : '';
  const parseRes = await groqParse(ocrText, requestId);
  const parsedBet = parseRes && parseRes.ok === true && parseRes.parsed ? parseRes.parsed : null;
  const parsedLegCount = parsedBet && Array.isArray(parsedBet.legs) ? parsedBet.legs.length : null;
  const declaredLegCount = extractHeaderLegCount(ocrText);
  const gate = evaluateSgpGate({ declaredLegCount, parsedBet, ocrText });
  return {
    ran: true,
    pass: gate.pass === true && gate.normalizedBet != null,
    gateReason: gate.reason,
    normalizedBet: gate.normalizedBet,
    sgpToken: decision.evidence ? decision.evidence.sgpToken : null,
    declaredLegCount: declaredLegCount != null ? declaredLegCount : null,
    parsedLegCount,
    ocrMs: decision.timingsMs ? decision.timingsMs.total : null,
  };
}

/**
 * SGP drop→hold (PR 2b, design D2 — #41 Option A, at the vision-failure seam).
 * The ONLY behavior change of the SGP-rescue arc: on a deterministic gate PASS
 * the caller routes the slip to MANUAL_REVIEW_HOLD (carrying the OCR-parsed
 * legs) instead of today's hold-without-legs / PURE_SLIP_SKIP_HOLD→drop.
 *
 * ALWAYS returns { hold, mode, sgp?, shadowPromise? } — NEVER throws, NEVER
 * rejects. Guardrail (the #41 contract): ONLY a gate PASS may return hold:true;
 * every FAIL, every guard skip, and every error returns { hold:false } so the
 * caller falls through to today's behavior byte-identically (on those paths no
 * event is emitted either — PENDING routing must stay indistinguishable from
 * today; the shadow mode + PR 2a pulse are the measurement surfaces).
 *
 *   off     → { hold:false }, zero calls, zero events.
 *   shadow  → { hold:false, shadowPromise } immediately; the chain + ONE
 *             `ocr_sgp_hold_shadow` emit run off the request path (kind =
 *             would_hold | would_skip | not_applicable). Callers MUST NOT await
 *             shadowPromise (tests do).
 *   enforce → awaited. Gate PASS → { hold:true, sgp } + ONE `ocr_sgp_hold`
 *             event (à la cutover's ocr_used). sgp carries the gate's
 *             normalizedBet fields + a precomputed newline-joined `description`
 *             (the modal prefill / release-legs source, holdReview.js).
 *
 * Guards (both live modes, cheapest first): no imageUrl → skip; imageCount > 1
 * → skip (Fix-3 mirror: OCR sees only image[0]; never hold a multi-image post
 * on one image's legs). Deviation from PR 2a noted: the would-hold pulse ran on
 * multi-image bails with scope=image[0]_of_multi; this seam skips them.
 */
async function runSgpDropToHold({ imageUrl, mediaType, imageCount, requestId, sourceRef, mode, deps, recordStageFn } = {}) {
  const m = mode || resolveSgpHoldMode();
  try {
    if (m === 'off') return { hold: false, mode: m };
    if (!imageUrl) return { hold: false, mode: m };
    const count = Number(imageCount) > 0 ? Number(imageCount) : 1;
    if (count > 1) return { hold: false, mode: m };

    if (m === 'shadow') {
      const shadowPromise = Promise.resolve()
        .then(() => evaluateSgpHold({ imageUrl, mediaType, requestId, deps }))
        .then((res) => {
          emit(recordStageFn, 'ocr_sgp_hold_shadow', requestId, sourceRef, {
            kind: !res || res.ran !== true ? 'not_applicable' : (res.pass ? 'would_hold' : 'would_skip'),
            pass: !!(res && res.ran === true && res.pass),
            reason: res ? (res.ran === true ? res.gateReason : res.reason) : 'OCR_UNKNOWN',
            declaredLegCount: res && res.declaredLegCount != null ? res.declaredLegCount : null,
            parsedLegCount: res && res.parsedLegCount != null ? res.parsedLegCount : null,
            ocrMs: res && res.ocrMs != null ? res.ocrMs : null,
            imageCount: count,
          });
        })
        .catch((err) => {
          // Measurement must NEVER affect ingest — swallow EVERYTHING.
          try { console.warn(`[ocrFirst/sgpHold] shadow swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
        });
      return { hold: false, mode: m, shadowPromise };
    }

    // enforce — synchronous: the caller is deciding hold-vs-drop right now.
    // Every stage below is individually deadline-bounded (fetch abort, OCR
    // abort, Groq 15s×2), so no extra wrapper timeout is needed.
    const res = await evaluateSgpHold({ imageUrl, mediaType, requestId, deps });
    if (!res || res.ran !== true || res.pass !== true || !res.normalizedBet) {
      return { hold: false, mode: m }; // FAIL / not-SGP / OCR failure → today's behavior
    }
    const nb = res.normalizedBet;
    const legs = Array.isArray(nb.legs) ? nb.legs : [];
    // pipeline_events payloads are sliced at 4000 chars (safeJson) — an
    // oversized hold payload would TRUNCATE to invalid JSON and break
    // loadHoldEvent (Release modal + recovery read it). Keep the sgp block
    // comfortably under that: cap the description, and past the budget drop
    // the structured legs array — the description still carries every leg
    // line, and sgpReleasePlan keys on gate+description lines, not legs.
    const description = legs.map(sgpHoldLegLine).filter(Boolean).join('\n').slice(0, 1800);
    // Gate PASS guarantees non-empty entity+market+line per leg; stay defensive.
    if (!legs.length || !description) return { hold: false, mode: m };
    let sgp = {
      gate: res.gateReason, // SGP_PASS
      sgpToken: res.sgpToken || null,
      declaredLegCount: nb.declaredLegCount != null ? nb.declaredLegCount : res.declaredLegCount,
      parsedLegCount: res.parsedLegCount != null ? res.parsedLegCount : null,
      bet_type: nb.bet_type || null,
      total_odds: nb.total_odds || null,
      stake: nb.stake || null,
      payout: nb.payout || null,
      legCount: legs.length, // survives the legs-array cap below
      legs,
      description,
      ocrMs: res.ocrMs != null ? res.ocrMs : null,
    };
    try {
      if (JSON.stringify(sgp).length > 2800) sgp = { ...sgp, legs: [], legsOmitted: legs.length };
    } catch (_) { sgp = { ...sgp, legs: [], legsOmitted: legs.length }; }
    emit(recordStageFn, 'ocr_sgp_hold', requestId, sourceRef, {
      pass: true,
      reason: res.gateReason,
      sgpToken: sgp.sgpToken,
      declaredLegCount: sgp.declaredLegCount,
      parsedLegCount: sgp.parsedLegCount,
      legCount: legs.length,
      ocrMs: sgp.ocrMs,
      imageCount: count,
    });
    return { hold: true, mode: m, sgp };
  } catch (err) {
    // The added path must NEVER throw into ingest — runSgpWouldHold discipline.
    try { console.warn(`[ocrFirst/sgpHold] swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
    return { hold: false, mode: m };
  }
}

/**
 * SHADOW — fire-and-forget. Returns the background promise (for tests to await),
 * but PRODUCTION CALLERS MUST NOT AWAIT IT. Never rejects; never touches the
 * staged bet. Emits exactly one `ocr_shadow_decision` per invocation.
 *
 * Fix 1: the fetch is hardened + abort-bounded by OCR_SHADOW_TIMEOUT_MS.
 * Fix 3: when imageCount > 1 the OCR saw only image[0] while the live parse
 *        merged all images — the event is labelled `scope:image[0]_of_multi`,
 *        agreement is forced false, and `multiImage` is added to mismatchFields
 *        so the comparison is not misread as agreement.
 */
function runShadow({ imageUrl, mediaType, requestId, sourceRef, liveParsed, deps, recordStageFn, imageCount }) {
  const fetchBytes = (deps && deps.fetchImageBytes) || fetchImageBytes;
  const extract = (deps && deps.extractViaOcr) || extractViaOcr;
  const count = Number(imageCount) > 0 ? Number(imageCount) : 1;
  const multi = count > 1;
  const scope = multi ? 'image[0]_of_multi' : 'single';
  return Promise.resolve()
    .then(async () => {
      const img = await fetchBytes(imageUrl, mediaType, shadowTimeoutMs());
      if (!img || img.ok !== true) {
        emit(recordStageFn, 'ocr_shadow_decision', requestId, sourceRef, {
          action: 'FALLBACK_GEMINI', reason: (img && img.reason) || WiringReason.NO_IMAGE_BYTES,
          ocrLegCount: 0, liveLegCount: countLiveLegs(liveParsed),
          agreement: false, mismatchFields: ['noImageBytes'], imageCount: count, scope,
        });
        return;
      }
      const decision = await extract(img.base64, img.mediaType, requestId, deps);
      const cmp = compareToLive(decision, liveParsed);
      emit(recordStageFn, 'ocr_shadow_decision', requestId, sourceRef, {
        action: decision.action,
        reason: decision.reason,
        ocrLegCount: cmp.ocrLegCount,
        liveLegCount: cmp.liveLegCount,
        agreement: multi ? false : cmp.agreement,
        mismatchFields: multi ? [...new Set([...cmp.mismatchFields, 'multiImage'])] : cmp.mismatchFields,
        ocrMs: decision.timingsMs ? decision.timingsMs.total : null,
        imageCount: count,
        scope,
        validationErrors: decision.validationErrors && decision.validationErrors.length ? decision.validationErrors : undefined,
      });
      // PR 2a — SGP would-hold measurement (additive). When the live path bailed an
      // SGP/SGPMAX slip to FALLBACK_GEMINI *before* Groq, run the skipped parse+gate
      // on the same OCR text and emit a second `ocr_sgp_would_hold` trace. The
      // returned decision is untouched (still FALLBACK_GEMINI); this only observes.
      // runSgpWouldHold is self-swallowing so it can never break the shadow path.
      if (decision && decision.reason === ReasonCode.SGP_GATE) {
        await runSgpWouldHold({ decision, scope, requestId, sourceRef, recordStageFn, deps });
      }
    })
    .catch((err) => {
      // Shadow must NEVER affect ingest — swallow EVERYTHING (incl. the emit path).
      try { console.warn(`[ocrFirst/shadow] swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
    });
}

// Resolve `p` but give up with `fallback` after `ms`. extractViaOcr is
// contractually no-throw, so this only fires on a genuinely slow path.
function withTimeout(p, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } },
    );
  });
}

/**
 * CUTOVER (dormant) — replace the staged bet with an OCR parse ONLY when every
 * eligibility guard passes; otherwise return null (→ caller stays on the live
 * path). NEVER throws. Emits `ocr_used` / `ocr_fallback`.
 *
 * Eligibility (in order, cheapest first so we skip the OCR call when we already
 * know we'll fall back):
 *   Fix 2 — live parse must be a NEW bet (not result/untracked_win/winner/loser).
 *   Fix 3 — single image only (imageCount <= 1).
 *   then fetch (Fix 1) + extractViaOcr within the shared OCR_TIMEOUT_MS deadline.
 *   Fix 4 — the OCR-derived bet must resolve a SUPPORTED sport.
 */
async function runCutover({ imageUrl, mediaType, requestId, sourceRef, deps, recordStageFn, liveParsed, imageCount }) {
  const fetchBytes = (deps && deps.fetchImageBytes) || fetchImageBytes;
  const extract = (deps && deps.extractViaOcr) || extractViaOcr;
  try {
    // Fix 2 — never restage a settled result / recap slip as a new bet.
    if (isNonNewBet(liveParsed)) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, {
        reason: WiringReason.CUTOVER_SKIP_NONBET,
        liveType: (liveParsed && liveParsed.type) || null,
        ticketStatus: (liveParsed && liveParsed.ticket_status) || null,
      });
      return null;
    }
    // Fix 3 — single-image OCR must not replace a merged multi-image parse.
    if (Number(imageCount) > 1) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, {
        reason: WiringReason.CUTOVER_SKIP_MULTI_IMAGE, imageCount: Number(imageCount),
      });
      return null;
    }

    // ONE total budget shared across fetch + extract (the "OCR_TIMEOUT_MS budget").
    const deadline = Date.now() + cutoverBudgetMs();
    const remainingMs = () => Math.max(0, deadline - Date.now());

    const img = await fetchBytes(imageUrl, mediaType, remainingMs());
    if (!img || img.ok !== true) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: (img && img.reason) || WiringReason.NO_IMAGE_BYTES });
      return null;
    }
    const decision = await withTimeout(
      Promise.resolve().then(() => extract(img.base64, img.mediaType, requestId, deps)),
      remainingMs(),
      { action: 'FALLBACK_GEMINI', reason: 'OCR_TIMEOUT', parsedBet: null },
    );
    if (!(decision && decision.action === 'USE_OCR' && decision.parsedBet)) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: decision ? decision.reason : 'OCR_UNKNOWN' });
      return null;
    }

    const bets = ocrBetToInternalBets(decision.parsedBet, { inferSport: deps && deps.inferSport });
    if (!bets.length) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: WiringReason.CONVERT_EMPTY });
      return null;
    }
    // Fix 4 — do not stage an Unknown/unsupported-sport bet.
    if (!isSupportedSport(bets[0].sport)) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, {
        reason: WiringReason.CUTOVER_SKIP_SPORT, sport: bets[0].sport || null,
      });
      return null;
    }

    emit(recordStageFn, 'ocr_used', requestId, sourceRef, {
      reason: decision.reason, sport: bets[0].sport, legCount: bets[0].legs ? bets[0].legs.length : 0,
    });
    return { useOcr: true, parsed: { type: 'bet', is_bet: true, bets, ticket_status: 'new' }, decision };
  } catch (err) {
    // Cutover must degrade to the live path on ANY failure.
    emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: WiringReason.CUTOVER_EXCEPTION, error: s(err && err.message).slice(0, 120) });
    return null;
  }
}

/**
 * The slip-path seam dispatch. ONE call from both seams; ONE tested code path.
 * ALWAYS returns { parsed, ranOcr, shadowPromise } — never throws, never returns
 * a null `parsed`.
 *   off / no image → no-op; extractViaOcr never called.
 *   shadow         → fire-and-forget; `parsed` returned UNCHANGED (same ref);
 *                    `shadowPromise` is the bg task (callers DO NOT await it).
 *   cutover        → awaited; on an ELIGIBLE USE_OCR `parsed` is REPLACED with
 *                    OCR bets, else returned unchanged.
 */
async function applyOcrFirst({ parsed, imageUrl, mediaType, imageCount, requestId, sourceRef, mode = MODE, deps, recordStageFn } = {}) {
  try {
    if (mode === 'off' || !imageUrl) return { parsed, ranOcr: false, shadowPromise: null };

    if (mode === 'shadow') {
      const shadowPromise = runShadow({ imageUrl, mediaType, imageCount, requestId, sourceRef, liveParsed: parsed, deps, recordStageFn });
      return { parsed, ranOcr: true, shadowPromise };
    }

    if (mode === 'cutover') {
      const ocr = await runCutover({ imageUrl, mediaType, imageCount, requestId, sourceRef, deps, recordStageFn, liveParsed: parsed });
      if (ocr && ocr.useOcr) return { parsed: ocr.parsed, ranOcr: true, shadowPromise: null, decision: ocr.decision };
      return { parsed, ranOcr: true, shadowPromise: null, decision: ocr ? ocr.decision : null };
    }

    return { parsed, ranOcr: false, shadowPromise: null };
  } catch (err) {
    // Belt-and-suspenders: applyOcrFirst must NEVER break the live path.
    try { console.warn(`[ocrFirst/wiring] applyOcrFirst swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
    return { parsed, ranOcr: false, shadowPromise: null };
  }
}

module.exports = {
  MODE,
  resolveMode,
  resolveSgpHoldMode,
  applyOcrFirst,
  runShadow,
  runSgpWouldHold,
  runSgpDropToHold,
  sgpHoldLegLine,
  runCutover,
  ocrBetToInternalBets,
  compareToLive,
  fetchImageBytes,
  isNonNewBet,
  isSupportedSport,
  eligibleImageCount,
  inferSportFromLegs,
  WiringReason,
  ALLOWED_IMAGE_HOSTS,
  SUPPORTED_SPORTS,
  // exposed for tests / introspection
  parseAmericanOdds,
  parseMoney,
  mapBetType,
  legLine,
};
