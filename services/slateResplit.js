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

// Parse ONE segment into a pick, or null. A segment is a sheet pick only when it
// carries its OWN stake token (the per-pick-stake discriminator) and a usable
// description; that gate keeps genuine single-stake parlays from being re-split.
function parsePick(segment, fallbackSport, deps) {
  const raw = String(segment == null ? '' : segment).trim();
  if (raw.length < 3) return null;
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

function shadowPayload(det) {
  return {
    wouldSplit: det.isSheet,
    multiLeg: det.multiLeg,
    legCount: det.legCount,
    pickCount: det.unitBearing,
    segmentCount: det.segmentCount,
    distinctSports: det.distinctSports,
    sports: det.sports.slice(0, 12),
    dominantSport: det.fallbackSport,
    sample: det.picks.slice(0, 4).map((p) => ({
      d: (p.description || '').slice(0, 48), u: p.units, s: p.sport, c: p.sportConfidence,
    })),
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
    const det = detectSheet({ pick, rawText, deps });
    if (mode === 'shadow') {
      // Measure only the candidate population (multi-leg vision parlays) so the
      // shadow volume tracks parlays, not every single-bet tweet. NEVER re-splits.
      if (det.multiLeg) emit(recordStageFn, 'slate_resplit_shadow', ingestId, sourceRef, shadowPayload(det));
      return { ran: true, isSheet: false, picks: det.picks, detection: det };
    }
    if (mode === 'cutover') {
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
  inferPickSport,
  splitSegments,
  parseUnits,
  parseOdds,
  stripStake,
  MMA_MARKERS,
};
