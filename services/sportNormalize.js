// services/sportNormalize.js
// Single source of truth for SPORT-STRING CASING.
//
// Why this exists (2026-06-15): the `sport` label for a bet is persisted in two
// places with divergent casing, and one of them forks live:
//   • `bets.sport` — ingestion writes the Title-Case form ("Soccer", "Tennis").
//     A handful of May-era relics ("soccer", "SOCCER", "TENNIS") survive from
//     older single-source writers that have since stopped.
//   • `grading_audit.sport_out` — the grader copies `bet.sport`, but the grade
//     path first runs `reclassifySport()` (services/ai.js), which returns a
//     `SPORT_TEAM_MAP` *key* — and those keys are UPPERCASE. So a soccer pick
//     that ingests as sport="Unknown"/"Soccer" and gets reclassified is written
//     as sport_out="SOCCER", while one that is NOT reclassified keeps "Soccer".
//     Both spellings are produced every day, splitting analytics grouping.
//
// The fix is a single canonicalization map applied at the persist points (plus a
// one-shot, idempotent backfill — scripts/backfill-sport-casing.js). This module
// is that map and its only consumer-facing function, imported everywhere; never
// reimplemented.
//
// HARD CONSTRAINT — the acronym leagues MLB / NBA / NHL / NFL MUST stay
// UPPERCASE. The deterministic adapter dispatch in services/sportsdata/index.js
// compares the (already-uppercased) sport against the literals 'MLB' / 'NBA' /
// 'NHL', and the `SPORT_MAP` / `SUPPORTED_SPORTS` lookups in services/grading.js
// key on the uppercase form. So this is a NORMALIZE MAP — never a blanket
// `.toUpperCase()` / `.toLowerCase()`. Word-sports take Title-Case (the de-facto
// "Soccer"/"Tennis" ingestion convention); an input we do not recognize is
// returned UNCHANGED (trimmed only) so we never mangle a value we have not
// enumerated (compound "MLB/NHL", "KBO", "Unknown", a future league, …).

'use strict';

// Lookup key = input.trim().toUpperCase(); value = the canonical spelling.
// Vocabulary = grading.js SUPPORTED_SPORTS ∪ SPORT_MAP keys ∪ SPORT_TEAM_MAP keys
// (the codebase's authoritative sport labels), with casing assigned by rule:
// acronym leagues UPPERCASE, real-word sports / proper-noun leagues Title-Case.
const CANONICAL_SPORT_BY_KEY = {
  // ── Acronym leagues → UPPERCASE (dispatch / SPORT_MAP / SUPPORTED_SPORTS) ──
  MLB: 'MLB', NBA: 'NBA', NHL: 'NHL', NFL: 'NFL',
  NCAAB: 'NCAAB', NCAAF: 'NCAAF', NCAAM: 'NCAAM', NCAAW: 'NCAAW',
  MLS: 'MLS', EPL: 'EPL', UCL: 'UCL', UEL: 'UEL',
  F1: 'F1', NASCAR: 'NASCAR',
  UFC: 'UFC', MMA: 'MMA',
  // ── Word sports → Title-Case (the de-facto "Soccer"/"Tennis" convention) ──
  SOCCER: 'Soccer', TENNIS: 'Tennis', GOLF: 'Golf', BOXING: 'Boxing',
  // ── Multi-word league proper nouns → Title-Case (downstream lookups all
  //    uppercase the key, so the stored spelling is free to be natural).
  //    Includes the labels detectSport emits via SPORT_KEYWORDS (services/ai.js)
  //    that are NOT in SUPPORTED_SPORTS/SPORT_MAP — e.g. "Copa America". ──
  'LA LIGA': 'La Liga', 'SERIE A': 'Serie A', BUNDESLIGA: 'Bundesliga',
  'LIGUE 1': 'Ligue 1', 'WORLD CUP': 'World Cup', 'COPA AMERICA': 'Copa America',
  'CHAMPIONS LEAGUE': 'Champions League', 'EUROPA LEAGUE': 'Europa League',
};

/**
 * Canonicalize the CASING of a sport label.
 *
 * @param {*} sport  the raw sport string (any casing), or null/undefined.
 * @returns the canonical spelling for a recognized sport; otherwise the input
 *          trimmed and otherwise UNCHANGED. null / undefined pass through as-is;
 *          an empty / whitespace-only string returns ''.
 *
 * Pure and side-effect-free. Case-insensitive lookup (the key is upper-cased for
 * comparison only — the returned value is the canonical spelling).
 */
function canonicalizeSport(sport) {
  if (sport == null) return sport;               // null / undefined → unchanged (safe)
  const trimmed = String(sport).trim();
  if (!trimmed) return trimmed;                  // empty / whitespace → '' (safe)
  const key = trimmed.toUpperCase();
  return Object.prototype.hasOwnProperty.call(CANONICAL_SPORT_BY_KEY, key)
    ? CANONICAL_SPORT_BY_KEY[key]
    : trimmed;                                   // unknown → trimmed input, case preserved
}

module.exports = { canonicalizeSport, CANONICAL_SPORT_BY_KEY };
