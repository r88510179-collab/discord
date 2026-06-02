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
//                        On USE_OCR, returns OCR-derived bets to stage in place
//                        of Gemini (emits `ocr_used`). On FALLBACK / timeout /
//                        throw, returns null so the caller falls through to the
//                        existing live path unchanged (emits `ocr_fallback`).
//
// This module is the SINGLE tested code path shared by both slip seams
// (handlers/messageHandler.js: processAggregatedMessage + processSlipImage), so
// the per-seam edit is one guarded call. See docs/specs/ocr-first.md §6/§8.
//
// SAFETY: applyOcrFirst / runShadow / runCutover NEVER throw and NEVER return
// null-for-parsed — a thrown or null-y ocrFirst can never break the live path in
// ANY mode. All network/OCR work is dependency-injectable for unit tests
// (deps.{fetchImageBytes, extractViaOcr, callOcrService, callGroqParse}); the
// recordStage sink is injectable too (recordStageFn) so wiring tests need no DB.
// ═══════════════════════════════════════════════════════════

'use strict';

const { extractViaOcr } = require('./ocrFirst');

// ── Mode (read at module load; prod reads env once at boot) ──
const VALID_MODES = new Set(['off', 'shadow', 'cutover']);
function resolveMode(raw) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase();
  return VALID_MODES.has(m) ? m : 'off';
}
const MODE = resolveMode(process.env.OCR_FIRST_MODE);

// Cutover total-orchestration budget. extractViaOcr has its own internal OCR +
// Groq timeouts; this caps the whole await so cutover never blocks staging past
// the deadline. Read at call time so it tracks OCR_TIMEOUT_MS hot-swaps.
function cutoverBudgetMs() {
  const n = parseInt(process.env.OCR_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

// Lazy pipeline-events require — keeps this module (and the wiring unit tests)
// free of the database.js require chain unless an emit actually fires with the
// default sink. Tests inject recordStageFn and never hit this.
let _recordStage = null;
function defaultRecordStage(evt) {
  if (!_recordStage) _recordStage = require('./pipeline-events').recordStage;
  return _recordStage(evt);
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

/**
 * Convert a Groq OCR parsedBet (docs/specs/ocr-first.md §4 schema) into the
 * internal bet shape consumed by the existing staging pipeline
 * (createBetWithLegs). Returns an ARRAY (one slip = one bet w/ legs) so a
 * multi-image merge upstream is a no-op (length 1). Returns [] if unusable.
 *
 * CUTOVER GAPS (dormant — must clear before flipping the flag, see spec §8):
 *  - The OCR/Groq schema carries NO sport → bets default to sport 'Unknown'
 *    (a known grading void-driver). Sport inference is a pre-cutover requirement.
 *  - validateParsedBet runs against the Discord message text, not the OCR text;
 *    OCR slips rely on its hasMedia:true slip-exemption. Shadow must confirm OCR
 *    bets survive that validator before cutover.
 */
function ocrBetToInternalBets(ocr) {
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

  return [{
    sport: 'Unknown',         // OCR schema has no sport — see CUTOVER GAPS above
    league: null,
    bet_type: betType,
    description,
    odds: parseAmericanOdds(ocr.total_odds),
    units: null,              // never invent stake → defaults to 1 downstream
    wager: parseMoney(ocr.stake),
    payout: parseMoney(ocr.payout),
    event_date: null,
    legs: internalLegs,
  }];
}

// ── Image fetch (URL → base64 + mediaType). NEVER throws. ──
// The slip seam has the image as a Discord CDN URL, not base64; OCR needs bytes.
// In shadow this runs in the background (off the request path); in cutover it
// runs inside the timeout budget.
async function fetchImageBytes(imageUrl, fallbackMediaType) {
  try {
    if (!imageUrl) return null;
    const res = await fetch(imageUrl);
    if (!res || !res.ok) return null;
    let mediaType = s(fallbackMediaType) || null;
    try {
      const ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
      if (ct && ct.toLowerCase().startsWith('image/')) mediaType = ct.split(';')[0].trim();
    } catch (_) { /* header read optional */ }
    if (!mediaType) mediaType = guessMediaType(imageUrl) || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length === 0) return null;
    return { base64: buf.toString('base64'), mediaType };
  } catch (_) {
    return null; // unreachable / aborted — caller degrades to live path
  }
}
function guessMediaType(url) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.gif')) return 'image/gif';
  return null;
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
 * SHADOW — fire-and-forget. Returns the background promise (for tests to await),
 * but PRODUCTION CALLERS MUST NOT AWAIT IT. Never rejects; never touches the
 * staged bet. Emits exactly one `ocr_shadow_decision` per invocation.
 */
function runShadow({ imageUrl, mediaType, requestId, sourceRef, liveParsed, deps, recordStageFn }) {
  const fetchBytes = (deps && deps.fetchImageBytes) || fetchImageBytes;
  const extract = (deps && deps.extractViaOcr) || extractViaOcr;
  return Promise.resolve()
    .then(async () => {
      const img = await fetchBytes(imageUrl, mediaType);
      if (!img) {
        emit(recordStageFn, 'ocr_shadow_decision', requestId, sourceRef, {
          action: 'FALLBACK_GEMINI', reason: 'OCR_NO_IMAGE_BYTES',
          ocrLegCount: 0, liveLegCount: countLiveLegs(liveParsed),
          agreement: false, mismatchFields: ['noImageBytes'],
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
        agreement: cmp.agreement,
        mismatchFields: cmp.mismatchFields,
        ocrMs: decision.timingsMs ? decision.timingsMs.total : null,
        validationErrors: decision.validationErrors && decision.validationErrors.length ? decision.validationErrors : undefined,
      });
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
 * CUTOVER (dormant) — await extractViaOcr within the OCR_TIMEOUT_MS budget.
 * Returns { useOcr:true, parsed:<bet>, decision } on a usable USE_OCR, else null
 * (→ caller stays on the live path). NEVER throws. Emits `ocr_used`/`ocr_fallback`.
 */
async function runCutover({ imageUrl, mediaType, requestId, sourceRef, deps, recordStageFn }) {
  const fetchBytes = (deps && deps.fetchImageBytes) || fetchImageBytes;
  const extract = (deps && deps.extractViaOcr) || extractViaOcr;
  // ONE total budget shared across fetch + extract (the "OCR_TIMEOUT_MS budget"):
  // each stage gets only the remaining time, so cutover staging is bounded at
  // ~OCR_TIMEOUT_MS total, not 2× (fetch then extract each getting the full budget).
  const deadline = Date.now() + cutoverBudgetMs();
  const remainingMs = () => Math.max(0, deadline - Date.now());
  try {
    const img = await withTimeout(fetchBytes(imageUrl, mediaType), remainingMs(), null);
    if (!img) {
      emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: 'OCR_NO_IMAGE_BYTES' });
      return null;
    }
    const decision = await withTimeout(
      Promise.resolve().then(() => extract(img.base64, img.mediaType, requestId, deps)),
      remainingMs(),
      { action: 'FALLBACK_GEMINI', reason: 'OCR_TIMEOUT', parsedBet: null },
    );
    if (decision && decision.action === 'USE_OCR' && decision.parsedBet) {
      const bets = ocrBetToInternalBets(decision.parsedBet);
      if (!bets.length) {
        emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: 'OCR_CONVERT_EMPTY' });
        return null;
      }
      emit(recordStageFn, 'ocr_used', requestId, sourceRef, {
        reason: decision.reason, legCount: bets[0].legs ? bets[0].legs.length : 0,
      });
      return { useOcr: true, parsed: { type: 'bet', is_bet: true, bets, ticket_status: 'new' }, decision };
    }
    emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: decision ? decision.reason : 'OCR_UNKNOWN' });
    return null;
  } catch (err) {
    // Cutover must degrade to the live path on ANY failure.
    emit(recordStageFn, 'ocr_fallback', requestId, sourceRef, { reason: 'OCR_CUTOVER_EXCEPTION', error: s(err && err.message).slice(0, 120) });
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
 *   cutover        → awaited; on USE_OCR `parsed` is REPLACED with OCR bets,
 *                    else returned unchanged.
 */
async function applyOcrFirst({ parsed, imageUrl, mediaType, requestId, sourceRef, mode = MODE, deps, recordStageFn } = {}) {
  try {
    if (mode === 'off' || !imageUrl) return { parsed, ranOcr: false, shadowPromise: null };

    if (mode === 'shadow') {
      const shadowPromise = runShadow({ imageUrl, mediaType, requestId, sourceRef, liveParsed: parsed, deps, recordStageFn });
      return { parsed, ranOcr: true, shadowPromise };
    }

    if (mode === 'cutover') {
      const ocr = await runCutover({ imageUrl, mediaType, requestId, sourceRef, deps, recordStageFn });
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
  applyOcrFirst,
  runShadow,
  runCutover,
  ocrBetToInternalBets,
  compareToLive,
  fetchImageBytes,
  // exposed for tests / introspection
  parseAmericanOdds,
  parseMoney,
  mapBetType,
  legLine,
};
