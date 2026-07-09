// ═══════════════════════════════════════════════════════════
// slateResplit — gated recovery for a mixed-sport recap SHEET that Vision
// collapsed into ONE dominant-sport PARLAY.
//
// ROOT CAUSE (docs: prompts/fix-mixed-slate-ingest.md, bet 8436c0c7):
// @Bobby_tracker posts a recap slate — a LIST of INDEPENDENT picks, each with
// its OWN stake ("... 5u | ... 10u | ..."). The vision prompt (services/ai.js
// GEMMA_SLIP_PROMPT / parseBetText) is told to split a multi-sport SHEET into
// per-pick straights (each with its own sport), but on a genuinely mixed
// soccer+MMA slate it instead returns ONE bet_type:parlay with N legs and the
// SLATE's DOMINANT sport (Soccer). twitter-handler stages bets[0] verbatim, so:
//   1. every leg — including the MMA fighters — inherits the dominant sport, and
//   2. the per-pick stakes (5u/10u/3u) are lost (a parlay carries one top stake).
// (The all-MMA sibling tweet parses as a UFC parlay — same picks, correct sport —
// proving the sport is decided ONCE per slate, never per leg. Verified via
// pipeline_events ingest_id=twit_2068786490960945493: PARSED legCount:8
// betType:parlay sport:Soccer.)
//
// This module is a deterministic post-parse safety net. When the raw tweet text
// is a delimited list of INDEPENDENTLY-staked picks (≥2 segments each carrying
// their own "Nu" token — the discriminator that a "parlay" is really a sheet),
// it re-parses the RAW TEXT into per-pick straights with:
//   • per-pick units recovered from the stake token, and
//   • per-pick sport = ITD/finish-method → MMA; a modeled team → its league
//     (inferLegSport); a national team → Soccer; else INHERIT the vision sport
//     flagged low-confidence (a bare "<fighter> ML" — e.g. "Christian Rodriguez",
//     also a real footballer — is NOT deterministically MMA without a roster; a
//     data-driven roster is a documented follow-up, not this module).
//
// GATED, mirroring services/ocrFirstWiring.js (OCR_FIRST_MODE):
//   SLATE_RESPLIT_MODE = off | shadow | cutover  (unset → off)
//     off      (default) — no-op. Zero cost, byte-identical live behavior.
//                          MERGING THIS MODULE CHANGES NOTHING.
//     shadow             — measure only. Emits one `slate_resplit_shadow` event
//                          per multi-leg vision parlay (would-split decision +
//                          per-pick sport/units sample). NEVER re-splits; the
//                          parlay stages exactly as today.
//     cutover            — re-split: stage each pick as its own straight instead
//                          of the single parlay. Emits `slate_resplit_used`.
//
// SAFETY: applySlateResplit NEVER throws; on ANY error it returns a no-op result
// so the live path is untouched. All ai.js lookups are lazy + dependency-
// injectable (deps.{inferLegSport, descNamesNationalTeam}); the recordStage sink
// is injectable (recordStageFn) so unit tests need no DB.
// ═══════════════════════════════════════════════════════════

'use strict';

// ── Mode (read at module load; prod reads env once at boot) ──
const VALID_MODES = new Set(['off', 'shadow', 'cutover']);
function resolveMode(raw) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase();
  return VALID_MODES.has(m) ? m : 'off';
}
const MODE = resolveMode(process.env.SLATE_RESPLIT_MODE);

// ── Combat-sport (MMA/boxing) market markers — deterministic per-pick MMA signal.
// Each is unambiguously a FIGHT market, hardened to avoid cross-domain / natural-
// English collisions (adversarial review): finish methods keep their "by …"
// context; decision types require "by" so prose ("a split decision was needed")
// never fires; "goes the distance" requires "fight". "ITD" (Inside The Distance)
// and "UFC" are combat-only jargon that does not occur in soccer/other picks.
// Deliberately NO bare "round over/under" (golf/tennis have rounds) and NO bare
// fighter names (a bare "<name> ML" is not deterministically MMA — see header).
const MMA_MARKERS = [
  /\bitd\b/i,                                       // inside the distance
  /\binside the distance\b/i,
  /\bby (ko|tko|submission)\b/i,                    // finish method
  /\bby (unanimous |split |majority )?decision\b/i, // scorecard outcome ("by decision")
  /\bwins? by (ko|tko|submission|decision)\b/i,     // "wins by KO/…" (combat phrasing)
  /\bfight goes the distance\b/i,
  /\bufc\b/i,
];

// Stake token: "10u", "5 u", "3 units", "2.5u". The presence of a PER-PICK stake
// on ≥2 segments is what tells us a "parlay" is really an independently-staked
// sheet (a real parlay has ONE stake for the whole ticket).
const STAKE_RE = /(\d+(?:\.\d+)?)\s*u(?:nits?)?\b/i;
const STAKE_RE_G = /(\d+(?:\.\d+)?)\s*u(?:nits?)?\b/gi;
const ODDS_RE = /([+-]\d{3,4})\b/;

function clampUnits(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0.01), 100);
}

// Recover the per-pick stake from a pick segment, else null (no explicit stake).
function parseUnits(segment) {
  const m = String(segment == null ? '' : segment).match(STAKE_RE);
  if (!m) return null;
  return clampUnits(parseFloat(m[1]));
}

// First American-odds token in a segment, else null.
function parseOdds(segment) {
  const m = String(segment == null ? '' : segment).match(ODDS_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Strip the stake token(s) to recover the stored description (matches the shape
// the pipeline already stores: "Christian Rodriguez ML (-215) 10u" →
// "Christian Rodriguez ML (-215)"). Mirrors regexParseBet's stake strip.
function stripStake(segment) {
  return String(segment == null ? '' : segment).replace(STAKE_RE_G, '').replace(/\s{2,}/g, ' ').trim();
}

// Split a raw slate into pick segments: pipe OR newline delimited.
function splitSegments(rawText) {
  return String(rawText == null ? '' : rawText)
    .split(/\s*\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Lazy ai.js sport helpers (dependency-injectable for tests) ──
let _ai = null;
function lazyAi() {
  if (!_ai) {
    try { _ai = require('./ai'); } catch (_) { _ai = {}; }
  }
  return _ai;
}
function lazyInferLegSport(desc) {
  try { const fn = lazyAi().inferLegSport; return fn ? fn(desc) : null; } catch (_) { return null; }
}
function lazyNationalTeam(desc) {
  try { const fn = lazyAi().descNamesNationalTeam; return fn ? !!fn(desc) : false; } catch (_) { return false; }
}
// Single source of truth for the pitcher-record / stat-line shape lives in
// services/ai.js (PITCHER_RECORD_PATTERN). Import it lazily (never redefine it) so
// the record/promo guard here matches the twitter validator's exact regex.
function lazyPitcherRecordPattern() {
  try { return lazyAi().PITCHER_RECORD_PATTERN || null; } catch (_) { return null; }
}

// Per-pick sport, with a confidence flag. Order = strongest signal first:
//   1. MMA finish/ITD/round marker → MMA (high).
//   2. Modeled-league team name (inferLegSport, whole-word) → its league (high).
//   3. National team (descNamesNationalTeam, whole-word) → Soccer (high).
//   4. No deterministic signal → INHERIT the vision/slate sport, low-confidence.
//      (A bare "<fighter> ML" lands here — kept as vision's sport by design;
//      see module header. Never force-guessed to MMA without a roster.)
function inferPickSport(text, fallbackSport, deps) {
  const inferLeg = (deps && deps.inferLegSport) || lazyInferLegSport;
  const isNational = (deps && deps.descNamesNationalTeam) || lazyNationalTeam;
  const d = String(text == null ? '' : text);
  for (const re of MMA_MARKERS) if (re.test(d)) return { sport: 'MMA', confidence: 'high' };
  let leg = null;
  try { leg = inferLeg(d); } catch (_) { leg = null; }
  if (leg) return { sport: String(leg), confidence: 'high' };
  let national = false;
  try { national = !!isNational(d); } catch (_) { national = false; }
  if (national) return { sport: 'Soccer', confidence: 'high' };
  return { sport: fallbackSport || 'Unknown', confidence: 'low' };
}

// Record/promo/stat-line markers — a capper's "record" line, NOT a bet. Its
// units-won token ("+41.4u") is a "Nu"-shaped stake to parseUnits, so without this
// guard the segment→pick step counts "Last 52 Free Plays 38-14 (73%) +41.4u" as a
// 41.4u pick and (under cutover) emits it as a fake straight.
const WL_RECORD_RE = /\b\d+-\d+(?:-\d+)?\b/;  // W-L(-T) record token, e.g. "38-14"
const PLAYS_RE = /\bplays?\b/i;               // capper record vocab ("Free Plays", "N plays")

// True when a segment is a record/promo/stat line rather than a bet. Pure: relies
// only on the injected-once PITCHER_RECORD_PATTERN (from ai.js) + local shape REs.
//
// TIGHTNESS is the governing constraint here (prompt mandate: "must not exclude real
// picks"). Two unambiguous record shapes classify as non-picks:
//   1. The ai.js validator's exact "N-N (NN%)" pattern (PITCHER_RECORD_PATTERN) —
//      catches the reported FP ("… 38-14 (73%) …") with the same regex the twitter
//      path already trusts; a real bet never combines N-N with a parenthesized %.
//   2. A record recap that lacks that parenthesised % ("Free Plays 38-14",
//      "Last 30 plays 20-10") — a W-L token BESIDE "plays" record vocabulary.
// Requiring BOTH a W-L token AND "plays" (not a bare W-L token, and not a bare '%')
// is deliberate: a correct-score "2-1", a set score "3-2 sets", a "5-2 in last 7"
// trend line, a date "7-5", and any "%"-annotated prop ("Jokic 25-30 pts 65% to hit",
// "Sinner 3-2 sets 68% hold") all carry a W-L-shaped token but no "plays" vocab, so
// they STAY picks. This is intentionally NARROW: exotic record phrasings without the
// "(NN%)" shape or "plays" vocab ("38-14 on the year", "ROI 12%", spelled-out records)
// are left as picks rather than risk dropping a real one — out of scope for this
// filter, whose sole job is the reported FP class. (This is why the prompt's
// suggested standalone "free plays"/"last \\d+"/"W-L-token+%" markers were tightened:
// each provably dropped a real pick — verified via adversarial review — while the
// exact FP is still caught by both branches above.)
function isNonPickSegment(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  const pitcherRecord = lazyPitcherRecordPattern();
  if (pitcherRecord && pitcherRecord.test(s)) return true;   // "N-N (NN%)" — the exact FP
  if (WL_RECORD_RE.test(s) && PLAYS_RE.test(s)) return true; // record recap: W-L token + "plays"
  return false;
}

// ── Stats-footer filter — SLATE_RESPLIT cutover precondition 1 (docs/BACKLOG.md
// "SLATE_RESPLIT cutover verdict: STAY SHADOW", 2026-07-09 spot-check). Capper
// ROI/recap FOOTERS carry SIGNED running-P&L units tokens — "Total: +48.7u",
// "Since Jun 11: -2.87u", "SGP Parlay: -1.6u" — whose "Nu" shape parseUnits
// reads as a stake, so each footer line minted a phantom pick (u=1.6, 2.87,
// even 48.7) and inflated pickCount into a false wouldSplit. Evidence events:
// twit_2074867391738105896, twit_2074483275452633352, twit_2073780065347747969,
// twit_2074119944707391954, twit_2073408453779812573.
//
// CONSERVATIVE BY DESIGN (a missed footer line = the FP persists, acceptable;
// eating a real pick = a new false negative, NOT acceptable — when unsure,
// KEEP). A segment is footer ONLY on one of three tight shapes:
//   A. FOOTER_PNL_LINE_RE — the ENTIRE segment is "<recap-label …>: ±N[.N]u":
//      a recap label from a closed vocab (the BACKLOG fix list Total/Since/
//      Record/SGP/Parlay plus safe siblings ROI/Profit/Units/Last/…/month
//      names), a short qualifier, a colon, then a SIGNED units token as the
//      only content (leading bullets/emoji and trailing punctuation allowed).
//      TWO independent discriminators must both hold: real stakes are UNSIGNED
//      ("5u") — the sign is P&L vocabulary — and a real pick always names a
//      selection somewhere, so it can never be whole-line "label: ±Nu".
//      ("Total goals: Over 2.5 (-110) 2u", "Parlay: Lakers ML + Celtics ML
//      (+264) 2u" both KEEP: content after the colon is not a lone signed
//      units token. "Lakers: +6.5u" also KEEPS — team labels are deliberately
//      NOT in the vocab.) The qualifier between label and colon is NOT
//      free-form: every word must itself be recap vocab, a month, or a
//      number, so a selection can't hide BEFORE the colon either —
//      adversarial review proved a permissive [^:]{0,24} qualifier ate
//      date-/name-prefixed picks ("Jun 9 Padres: +1.5u", "May 6 Yankees ML:
//      +1.5u", "Jun Yong Park ITD: +1.5u", "May o5.5 Ks: +1.5u" — month stem
//      matched the label, the selection hid in the qualifier); all four must
//      KEEP, while "Since Jun 11: -2.87u" / "SGP Parlay: -1.6u" /
//      "Last 30 days: +12.4u" still strip.
//   B. isNonPickSegment — the existing record/promo guard ("N-N (NN%)" via
//      ai.js PITCHER_RECORD_PATTERN, W-L token + "plays" vocab), already
//      pick-safe per its own adversarial review above. Catches the BACKLOG
//      "Grass Record 72-32 (69%)" footer shape.
//   C. FOOTER_URL_RE + NO stake token — a capper-page/telegram link block.
//      Safe by construction: a stake-less segment can never parse into a pick
//      (parsePick requires a units token), so stripping it cannot eat one. A
//      URL segment that DOES carry a stake token KEEPS (unsure → keep).
const FOOTER_PNL_MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|' +
  'sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const FOOTER_PNL_LABEL =
  '(?:totals?|since|records?|sgps?|parlays?|straights?|roi|profits?|units?|last|overall|season|ytd|this|months?|weeks?|' +
  FOOTER_PNL_MONTH + ')';
// Qualifier words allowed between the label and the colon: recap vocab, months,
// or plain numbers/ordinals ONLY — never a team/player/market word, so a
// selection can't hide before the colon (see header, adversarial review).
const FOOTER_PNL_QUALIFIER_WORD =
  '(?:days?|weeks?|months?|years?|plays?|picks?|bets?|parlays?|straights?|sgps?|props?|records?|totals?|units?|free|vip|roi|' +
  FOOTER_PNL_MONTH + '|\\d{1,4}(?:st|nd|rd|th)?)';
const FOOTER_PNL_LINE_RE = new RegExp(
  '^[^A-Za-z0-9]*' +                                        // leading bullets/emoji only
  FOOTER_PNL_LABEL + '\\b' +
  '(?:[\\s.,-]+' + FOOTER_PNL_QUALIFIER_WORD + '\\b)*' +    // qualifier: closed vocab/month/number words only
  '[\\s.,-]*:' +                                            // then the colon
  '\\s*[+-]\\s?\\d+(?:[.,]\\d+)?\\s*u(?:nits?)?\\b' +       // SIGNED P&L units token
  '[^A-Za-z0-9]*$',                                         // trailing punctuation/emoji only
  'i'
);
const FOOTER_URL_RE = /\b(?:https?:\/\/\S+|www\.[^\s|]+|t\.me\/\S+)/i;

// True when a segment is stats-footer/recap-footer content, not a pick.
function isStatsFooterSegment(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (FOOTER_PNL_LINE_RE.test(s)) return true;                     // A: "<label>: ±Nu" whole-segment
  if (isNonPickSegment(s)) return true;                            // B: record/promo line
  if (FOOTER_URL_RE.test(s) && parseUnits(s) == null) return true; // C: stake-less link block
  return false;
}

// Pure: remove stats-footer segments from a raw slate text. Returns
// { text, removedCount, removed } — `text` re-joined with '\n' is equivalent
// under splitSegments (which splits on pipe OR newline), so detection over the
// filtered text sees exactly the kept segments.
function stripStatsFooter(rawText) {
  const segments = splitSegments(rawText);
  const kept = [];
  const removed = [];
  for (const seg of segments) (isStatsFooterSegment(seg) ? removed : kept).push(seg);
  return { text: kept.join('\n'), removedCount: removed.length, removed };
}

// Parse ONE segment into a pick, or null. A segment is a sheet pick only when it
// is NOT a record/promo/stat line AND carries its OWN stake token (the per-pick-
// stake discriminator) and a usable description; that gate keeps genuine
// single-stake parlays from being re-split and record lines from becoming picks.
function parsePick(segment, fallbackSport, deps) {
  const raw = String(segment == null ? '' : segment).trim();
  if (raw.length < 3) return null;
  if (isNonPickSegment(raw)) return null;
  const units = parseUnits(raw);
  if (units == null) return null;
  const description = stripStake(raw);
  if (description.length < 3) return null;
  const odds = parseOdds(raw);
  const { sport, confidence } = inferPickSport(description, fallbackSport, deps);
  return { description, odds, units, sport, sportConfidence: confidence, raw };
}

// Decide whether a vision result (`pick`) + its raw tweet text is really a
// multi-pick sheet, and return the re-split picks. isSheet requires a multi-leg
// vision bet AND ≥2 independently-staked pick segments.
function detectSheet({ pick, rawText, deps } = {}) {
  const legs = Array.isArray(pick && pick.legs) ? pick.legs : [];
  const multiLeg = (pick && String(pick.type || pick.bet_type || '').toLowerCase() === 'parlay') || legs.length >= 2;
  const fallbackSport = (pick && pick.sport) || 'Unknown';
  const segments = splitSegments(rawText);
  const picks = [];
  for (const seg of segments) {
    const p = parsePick(seg, fallbackSport, deps);
    if (p) picks.push(p);
  }
  const sports = [...new Set(picks.map((p) => p.sport))];
  const isSheet = multiLeg && picks.length >= 2;
  return {
    isSheet,
    multiLeg,
    picks,
    legCount: legs.length,
    segmentCount: segments.length,
    unitBearing: picks.length,
    distinctSports: sports.length,
    sports,
    fallbackSport,
  };
}

// ── pipeline-events emitter (lazy require; never throws) ──
let _recordStage = null;
function defaultRecordStage(evt) {
  if (!_recordStage) _recordStage = require('./pipeline-events').recordStage;
  return _recordStage(evt);
}
function emit(recordStageFn, eventType, ingestId, sourceRef, payload) {
  try {
    (recordStageFn || defaultRecordStage)({
      ingestId,
      sourceType: 'twitter',
      sourceRef: sourceRef || null,
      stage: 'SLATE_RESPLIT',
      eventType,
      payload,
    });
  } catch (_) { /* observability must never break ingest */ }
}

function shadowPayload(det, footer) {
  return {
    wouldSplit: det.isSheet,
    multiLeg: det.multiLeg,
    legCount: det.legCount,
    pickCount: det.unitBearing,
    // segmentCount counts the KEPT segments (post footer-strip); the stripped
    // ones are accounted for by footerRemovedCount below.
    segmentCount: det.segmentCount,
    distinctSports: det.distinctSports,
    sports: det.sports.slice(0, 12),
    dominantSport: det.fallbackSport,
    sample: det.picks.slice(0, 4).map((p) => ({
      d: (p.description || '').slice(0, 48), u: p.units, s: p.sport, c: p.sportConfidence,
    })),
    // Stats-footer filter observability (cutover precondition 1) — lets the
    // next spot-check measure the filter's effect straight from events.
    footerStripped: !!(footer && footer.removedCount > 0),
    footerRemovedCount: footer ? footer.removedCount : 0,
    footerRemovedSample: footer ? footer.removed.slice(0, 4).map((s) => s.slice(0, 48)) : [],
  };
}

/**
 * The twitter-handler seam. ONE call after the vision parse. ALWAYS returns
 * { ran, isSheet, picks, detection } — never throws.
 *   off     → no-op ({ isSheet:false }); nothing computed downstream acts on.
 *   shadow  → emits one `slate_resplit_shadow`; returns isSheet:false so the
 *             caller NEVER re-splits (parlay stages as today) — measurement only.
 *   cutover → on a detected sheet, emits `slate_resplit_used` and returns
 *             isSheet:true + the per-pick straights for the caller to stage.
 */
function applySlateResplit({ pick, rawText, ingestId, sourceRef, mode = MODE, recordStageFn, deps } = {}) {
  try {
    if (mode === 'off') return { ran: false, isSheet: false, picks: [], detection: null };
    if (mode === 'shadow') {
      // Cutover precondition 1: strip stats-footer segments BEFORE detection so
      // a footer's signed P&L "u" token cannot mint phantom picks / inflate
      // pickCount into a false wouldSplit. SHADOW-ONLY by design — this refines
      // what shadow WOULD decide; the cutover branch below still detects on the
      // raw text, byte-identical to before.
      const footer = stripStatsFooter(rawText);
      const det = detectSheet({ pick, rawText: footer.text, deps });
      // Measure only the candidate population (multi-leg vision parlays) so the
      // shadow volume tracks parlays, not every single-bet tweet. NEVER re-splits.
      if (det.multiLeg) emit(recordStageFn, 'slate_resplit_shadow', ingestId, sourceRef, shadowPayload(det, footer));
      return { ran: true, isSheet: false, picks: det.picks, detection: det };
    }
    if (mode === 'cutover') {
      const det = detectSheet({ pick, rawText, deps });
      if (det.isSheet) {
        emit(recordStageFn, 'slate_resplit_used', ingestId, sourceRef, {
          legCount: det.legCount, pickCount: det.unitBearing,
          distinctSports: det.distinctSports, sports: det.sports.slice(0, 12),
          dominantSport: det.fallbackSport,
        });
      }
      return { ran: true, isSheet: det.isSheet, picks: det.picks, detection: det };
    }
    return { ran: false, isSheet: false, picks: [], detection: null };
  } catch (err) {
    try { console.warn(`[slateResplit] swallowed: ${err && err.message}`); } catch (_) { /* noop */ }
    return { ran: false, isSheet: false, picks: [], detection: null };
  }
}

module.exports = {
  MODE,
  resolveMode,
  applySlateResplit,
  detectSheet,
  parsePick,
  isNonPickSegment,
  isStatsFooterSegment,
  stripStatsFooter,
  inferPickSport,
  splitSegments,
  parseUnits,
  parseOdds,
  stripStake,
  MMA_MARKERS,
};
