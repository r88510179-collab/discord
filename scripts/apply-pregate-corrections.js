#!/usr/bin/env node
// scripts/apply-pregate-corrections.js
// ═══════════════════════════════════════════════════════════
// Operator-run, in-container correction pass for the 24 high-confidence
// disagreements in docs/audits/2026-07-02-pregate-shadow-regrade.md
// (23 result flips + 1 no-selection VOID carve-out), plus a retro-archive of
// the 3 prior manual corrections that predate any bet_grade_history trail.
//
// THE OPERATOR RUNS THIS — never an agent, never CI. Upload to the Fly
// container and run there per docs/RUNBOOKS/db-interventions.md.
//
// Usage (in-container):
//   node apply-pregate-corrections.js            # DRY RUN (db opened readonly)
//   node apply-pregate-corrections.js --apply    # writes, ONE transaction
//
// Env: APP_ROOT (default /app), DB_PATH (default /data/bettracker.db).
// Self-contained for sftp upload: requires better-sqlite3 and
// services/gradeOverride.js from APP_ROOT only; no other app module loads.
//
// Write scope: bets + bet_grade_history ONLY. No pipeline_events, no Discord,
// no network, no bankrolls / daily_snapshots / parlay_legs / user_bets writes.
//
// Reuse decision (side-effect audit of services/gradeOverride.js):
//   applyGradeOverride is pure + dependency-injected — no Discord client, no
//   module-level db, no import-time side effects — so --apply REUSES its
//   archive→update transaction core instead of reimplementing it. Two deps
//   are deliberately neutered to hold the write scope above:
//     • getBankroll → () => null. Bankroll reconciliation is OUT OF SCOPE:
//       these are pre-gate (Beta-era) bets and bankrolls were season-reset to
//       a fresh S2 slate (docs/SEASON-RESET.md) — shifting `current` by a
//       prior-era delta would corrupt the live slate. updateBankroll /
//       saveDailySnapshot are throwing stubs (unreachable while getBankroll
//       returns null), so any future widening of applyGradeOverride's write
//       scope aborts the transaction instead of writing silently.
//     • calcProfit — inline mirror of services/grading.js calcProfit()
//       (grading.js is not require-safe standalone: it pulls the full grader
//       import graph). The mirrored math is asserted per row against the
//       report's suggested_pu (±0.02) before any write.
//   applyGradeOverride does NOT reconcile user_bets (tails) — hence the HARD
//   GATE below: rows with user_bets rows are refused, never silently flipped.
//
// Row gates (evaluated identically in both modes; per-row, run continues):
//   skip   : id not found · stored result != expect_stored_result (already
//            corrected / drifted) · grader_version NOT NULL (post-gate write)
//   refuse : user_bets rows exist (manual decision) · bet_type != straight
//            (legs out of scope) · mirrored calcProfit differs from the
//            embedded new_pu by > 0.02 (odds/units drifted vs the export)
//   fatal  : an id prefix matches more than one bets row (table unsafe —
//            abort before any write)
//
// Idempotent: a second --apply run skips every row (stored result no longer
// equals expect_stored_result; retro rows skip on an existing history row).
// ═══════════════════════════════════════════════════════════

'use strict';

const APP_ROOT = process.env.APP_ROOT || '/app';
const DB_PATH = process.env.DB_PATH || '/data/bettracker.db';

const ARCHIVED_BY = 'shadow-regrade-2026-07-02';
const RETRO_ARCHIVED_BY = 'operator-retro-2026-07-02';
const PU_TOLERANCE = 0.02;
const VALID_RESULTS = ['win', 'loss', 'push', 'void'];

// ── Correction table ────────────────────────────────────────
// The 24 high-confidence disagreement rows (every row NOT flagged LC) of
// docs/audits/2026-07-02-pregate-shadow-regrade.md, transcribed verbatim:
// expect_stored_* = the audit's "stored / pu" column; new_result/new_pu = the
// shadow verdict + suggested_pu. Rows flagged default-odds keep the flag in
// `reason` (stored odds empty → pu is 0.909×units at the -110 default).
// CARVE-OUT — 223d9043: stored win, shadow LOSS, but the "description" is a
// play-in promo naming NO selection; applied as VOID pu=0 (3f78b923
// precedent: no selection → nothing gradeable), NOT the shadow loss.
const CORRECTIONS = [
  { id: '9ab2ddf8', sport: 'MLB', market: 'game_total', desc: 'DODGERS / DBACKS OVER 9',
    expect_stored_result: 'loss', expect_stored_pu: -3, new_result: 'win', new_pu: 2.73,
    reason: 'shadow-regrade 2026-07-02: Total 11 > 9 (over) — Los Angeles Dodgers 6, Arizona Diamondbacks 5 [default_odds: stored odds empty, pu = 0.909×units]',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-02' },
  { id: 'f0402e60', sport: 'MLB', market: 'game_total', desc: 'Athletics / Giants Under 9.5',
    expect_stored_result: 'win', expect_stored_pu: 3.64, new_result: 'loss', new_pu: -4,
    reason: 'shadow-regrade 2026-07-02: Total 10 > 9.5 (under missed) — San Francisco Giants 6, Athletics 4',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16' },
  { id: '5668fb16', sport: 'MLB', market: 'ML', desc: 'LockedIn Los Angeles Dodgers -120',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.83,
    reason: 'shadow-regrade 2026-07-02: Los Angeles Dodgers 6, Arizona Diamondbacks 5 (ML win)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-02' },
  { id: '6a6a7585', sport: 'MLB', market: 'ML', desc: 'Dodgers ML',
    expect_stored_result: 'loss', expect_stored_pu: -2, new_result: 'win', new_pu: 1.67,
    reason: 'shadow-regrade 2026-07-02: Los Angeles Dodgers 9, Philadelphia Phillies 1 (ML win)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31' },
  { id: '6f371722', sport: 'MLB', market: 'ML', desc: 'Mariners ML',
    expect_stored_result: 'loss', expect_stored_pu: -5, new_result: 'win', new_pu: 4.55,
    reason: 'shadow-regrade 2026-07-02: Seattle Mariners 7, Texas Rangers 3 (ML win; stored grade cited a different game of the series)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-18' },
  { id: '8e5a432d', sport: 'MLB', market: 'ML', desc: 'Pittsburgh Pirates ML',
    expect_stored_result: 'win', expect_stored_pu: 0.77, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Pittsburgh Pirates 7, Tampa Bay Rays 8 (ML loss)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-18' },
  { id: '90a1dc1b', sport: 'MLB', market: 'ML', desc: 'Red Sox ML',
    expect_stored_result: 'win', expect_stored_pu: 3.64, new_result: 'loss', new_pu: -4,
    reason: 'shadow-regrade 2026-07-02: Boston Red Sox 6, Atlanta Braves 7 (ML loss)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-26' },
  { id: 'fd1e117f', sport: 'MLB', market: 'ML', desc: 'LockedIn Atlanta Braves -135',
    expect_stored_result: 'win', expect_stored_pu: 0.74, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Atlanta Braves 4, Cincinnati Reds 6 (ML loss)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31' },
  { id: '30f94776', sport: 'MLB', market: 'spread', desc: 'New York Yankees -1.5 -105',
    expect_stored_result: 'win', expect_stored_pu: 0.95, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: New York Yankees 0 + (-1.5) vs Athletics 1 (spread missed)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-09' },
  { id: '313a8f64', sport: 'MLB', market: 'spread', desc: 'LockedIn Cincinnati Reds -1.5',
    expect_stored_result: 'win', expect_stored_pu: 0.91, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Cincinnati Reds 2 + (-1.5) vs Kansas City Royals 9 (spread missed)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01' },
  { id: '415eee8d', sport: 'MLB', market: 'spread', desc: 'LockedIn Los Angeles Dodgers -1.5',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91,
    reason: 'shadow-regrade 2026-07-02: Los Angeles Dodgers 9 + (-1.5) vs Philadelphia Phillies 1 (spread covered)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31' },
  { id: '5eabd576', sport: 'MLB', market: 'spread', desc: 'GNP Royals +1.5',
    expect_stored_result: 'loss', expect_stored_pu: -2, new_result: 'win', new_pu: 1.82,
    reason: 'shadow-regrade 2026-07-02: Kansas City Royals 9 + (1.5) vs Cincinnati Reds 2 (spread covered)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01' },
  { id: 'a498c100', sport: 'MLB', market: 'spread', desc: 'Angels +1.5',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.87,
    reason: 'shadow-regrade 2026-07-02: Los Angeles Angels 10 + (1.5) vs New York Yankees 11 (spread covered)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-13' },
  { id: 'e8aef1d0', sport: 'MLB', market: 'spread', desc: 'LockedIn New York Yankees -1.5',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91,
    reason: 'shadow-regrade 2026-07-02: New York Yankees 13 + (-1.5) vs Athletics 8 (spread covered)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31' },
  { id: 'ff6350ec', sport: 'MLB', market: 'spread', desc: 'LockedIn Tampa Bay Rays -1.5',
    expect_stored_result: 'win', expect_stored_pu: 0.91, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Tampa Bay Rays 9 + (-1.5) vs Detroit Tigers 10 (spread missed)',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01' },
  { id: '913416b4', sport: 'MLB', market: 'team_total', desc: 'Athletics Team Total UNDER 4.5',
    expect_stored_result: 'loss', expect_stored_pu: -2, new_result: 'win', new_pu: 1.82,
    reason: 'shadow-regrade 2026-07-02: Athletics team total 4 vs 4.5 (under) — St. Louis Cardinals 5, Athletics 4; stored grade used game-total math (b6065d701c class) [default_odds: stored odds empty, pu = 0.909×units]',
    evidence_url: 'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-14' },
  { id: '6ed630f9', sport: 'NBA', market: 'game_total', desc: 'Minnesota Timberwolves / San Antonio Spurs UNDER 218.5',
    expect_stored_result: 'win', expect_stored_pu: 3.64, new_result: 'loss', new_pu: -4,
    reason: 'shadow-regrade 2026-07-02: Total 223 > 218.5 (under missed) — Minnesota Timberwolves 97, San Antonio Spurs 126',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: 'c3c0726d', sport: 'NBA', market: 'game_total', desc: 'New York Knicks Philadelphia 76ers O214',
    expect_stored_result: 'win', expect_stored_pu: 0.91, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Total 202 < 214 (over missed) — New York Knicks 108, Philadelphia 76ers 94',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: 'f694f90a', sport: 'NBA', market: 'ML', desc: 'Timberwolves ML',
    expect_stored_result: 'loss', expect_stored_pu: -3, new_result: 'win', new_pu: 2.73,
    reason: 'shadow-regrade 2026-07-02: Minnesota Timberwolves 110, Denver Nuggets 98 (ML win) [default_odds: stored odds empty, pu = 0.909×units]',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: '0a965916', sport: 'NBA', market: 'nba_prop', desc: 'Jayson Tatum O 30.5 Points',
    expect_stored_result: 'win', expect_stored_pu: 3.07, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Jayson Tatum had 25 points (line: over 30.5 — missed)',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: '07cec57a', sport: 'NBA', market: 'spread', desc: 'Miami Heat +5.5',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91,
    reason: 'shadow-regrade 2026-07-02: Miami Heat 126 + (5.5) vs Charlotte Hornets 127 (spread covered; stored grade called a 1-pt loss a spread miss)',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  // CARVE-OUT: no-selection promo text — VOID, not the shadow LOSS.
  { id: '223d9043', sport: 'NBA', market: 'spread', desc: '🏀 Here’s all the data you need to win money on the play-in',
    expect_stored_result: 'win', expect_stored_pu: 0.91, new_result: 'void', new_pu: 0,
    reason: 'no-selection promo text — "Here\'s all the data you need to win money on the play-in" names no pick, so nothing is gradeable; VOID per 3f78b923 precedent (shadow LOSS deliberately NOT applied)',
    evidence_url: 'docs/audits/2026-07-02-pregate-shadow-regrade.md' },
  { id: '1dfe1ffa', sport: 'NHL', market: 'game_total', desc: 'Dallas Stars Wild O5.5',
    expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91,
    reason: 'shadow-regrade 2026-07-02: Total 7 > 5.5 (over hit) — Stars 2, Wild 5',
    evidence_url: 'api-web.nhle.com/v1/score/2026-04-30' },
  { id: 'f3411adc', sport: 'NHL', market: 'ML', desc: 'Ottawa Senators ML',
    expect_stored_result: 'win', expect_stored_pu: 0.77, new_result: 'loss', new_pu: -1,
    reason: 'shadow-regrade 2026-07-02: Senators 3, Devils 4 (ML loss)',
    evidence_url: 'api-web.nhle.com/v1/score/2026-04-12' },
];

// ── Retro-archive table ─────────────────────────────────────
// The 3 manual corrections already applied directly to `bets` with no
// bet_grade_history trail. Inserts archive the documented PRE-correction
// state; skipped when ANY history row already exists for the bet (e.g. the
// correction went through applyGradeOverride after all). Rows whose CURRENT
// stored result is not the expected corrected value are skipped too — an
// archive row claiming "was win, corrected" would mislead if the correction
// was since reverted.
const RETRO_ARCHIVE = [
  { id: '3e5c01a0', old_result: 'win', old_profit_units: 4545.45, expect_current_result: 'void',
    reason: 'retro-archive of 2026-07-02 manual correction: "$5,000 on Spurs moneyline" ingested units=5000 with empty odds → false win +4545.45u at the -110 default (dollar stake stored as units); manually voided (BACKLOG P1 units-intake sanity guard)' },
  { id: '3f78b923', old_result: 'win', old_profit_units: 45.45, expect_current_result: 'void',
    reason: 'retro-archive of 2026-07-02 manual correction: no-selection paywall tease graded win +45.45u at the -110 default off a hallucinated match; manually voided (BACKLOG P1 no-selection gradeability guard)' },
  { id: 'b6065d701', old_result: 'win', old_profit_units: 3.64, expect_current_result: 'loss',
    reason: 'retro-archive of 2026-07-02 manual correction: Athletics team total graded with game-total math → false win +3.64u; corrected to loss -4.0u (pre-gate audit n=15 sample find)' },
];

// ── Payout math (inline mirror) ─────────────────────────────
// Byte-equivalent mirror of services/grading.js calcProfit(). Injected into
// applyGradeOverride (grading.js itself is not require-safe standalone) and
// used for the per-row cross-check against the embedded new_pu.
function calcProfit(odds, units, result) {
  if (result === 'push') return 0;
  if (result === 'loss') return -units;
  if (result === 'void') return 0;

  // Win
  if (odds > 0) return units * (odds / 100);
  if (odds < 0) return units * (100 / Math.abs(odds));
  return 0;
}

function round2(x) { return Math.round(x * 100) / 100; }

// ── Table shape validation (unit-tested, DB-free) ───────────
function validateCorrectionTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('corrections: not a non-empty array');
  const seen = new Set();
  const dir = { lossToWin: 0, winToLoss: 0, winToVoid: 0 };
  for (const r of rows) {
    const tag = `corrections[${r && r.id}]`;
    if (!r || typeof r.id !== 'string' || !/^[0-9a-f]{8,12}$/.test(r.id)) throw new Error(`${tag}: bad id`);
    if (seen.has(r.id)) throw new Error(`${tag}: duplicate id`);
    seen.add(r.id);
    if (!VALID_RESULTS.includes(r.expect_stored_result)) throw new Error(`${tag}: bad expect_stored_result`);
    if (!VALID_RESULTS.includes(r.new_result)) throw new Error(`${tag}: bad new_result`);
    if (r.new_result === r.expect_stored_result) throw new Error(`${tag}: new_result equals expect_stored_result`);
    if (typeof r.expect_stored_pu !== 'number' || Number.isNaN(r.expect_stored_pu)) throw new Error(`${tag}: bad expect_stored_pu`);
    if (typeof r.new_pu !== 'number' || Number.isNaN(r.new_pu)) throw new Error(`${tag}: bad new_pu`);
    if (r.new_result === 'win' && !(r.new_pu > 0)) throw new Error(`${tag}: win must have new_pu > 0`);
    if (r.new_result === 'loss' && !(r.new_pu < 0)) throw new Error(`${tag}: loss must have new_pu < 0`);
    if ((r.new_result === 'void' || r.new_result === 'push') && r.new_pu !== 0) throw new Error(`${tag}: void/push must have new_pu 0`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${tag}: empty reason`);
    if (typeof r.evidence_url !== 'string' || !r.evidence_url.trim()) throw new Error(`${tag}: empty evidence_url`);
    if (r.expect_stored_result === 'loss' && r.new_result === 'win') dir.lossToWin++;
    else if (r.expect_stored_result === 'win' && r.new_result === 'loss') dir.winToLoss++;
    else if (r.expect_stored_result === 'win' && r.new_result === 'void') dir.winToVoid++;
    else throw new Error(`${tag}: unexpected flip direction ${r.expect_stored_result}→${r.new_result}`);
  }
  return dir;
}

function validateRetroTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('retro: not a non-empty array');
  const seen = new Set();
  for (const r of rows) {
    const tag = `retro[${r && r.id}]`;
    if (!r || typeof r.id !== 'string' || !/^[0-9a-f]{8,12}$/.test(r.id)) throw new Error(`${tag}: bad id`);
    if (seen.has(r.id)) throw new Error(`${tag}: duplicate id`);
    seen.add(r.id);
    if (!VALID_RESULTS.includes(r.old_result)) throw new Error(`${tag}: bad old_result`);
    if (typeof r.old_profit_units !== 'number' || Number.isNaN(r.old_profit_units)) throw new Error(`${tag}: bad old_profit_units`);
    if (!VALID_RESULTS.includes(r.expect_current_result)) throw new Error(`${tag}: bad expect_current_result`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${tag}: empty reason`);
  }
}

module.exports = {
  CORRECTIONS, RETRO_ARCHIVE,
  calcProfit, round2, validateCorrectionTable, validateRetroTable,
  ARCHIVED_BY, RETRO_ARCHIVED_BY, PU_TOLERANCE,
};

// ═════════════════════════ runtime ══════════════════════════
if (require.main === module) main();

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const unknown = argv.filter(a => a !== '--apply');
  if (unknown.length) {
    console.error(`unknown arg(s): ${unknown.join(' ')}\nUsage: node apply-pregate-corrections.js [--apply]`);
    process.exit(2);
  }

  const dirTotals = validateCorrectionTable(CORRECTIONS);
  validateRetroTable(RETRO_ARCHIVE);

  // Preflight both requires in BOTH modes so a dry run surfaces a missing
  // module before the operator reaches --apply.
  let Database, applyGradeOverride;
  try {
    Database = require(APP_ROOT + '/node_modules/better-sqlite3');
    ({ applyGradeOverride } = require(APP_ROOT + '/services/gradeOverride.js'));
  } catch (err) {
    console.error(`preflight require failed (APP_ROOT=${APP_ROOT}): ${err.message}`);
    process.exit(2);
  }

  let db;
  try {
    db = new Database(DB_PATH, { readonly: !apply, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open DB_PATH=${DB_PATH}: ${err.message}`);
    process.exit(2);
  }

  console.log(`apply-pregate-corrections — ${apply ? 'APPLY' : 'DRY RUN (readonly)'}`);
  console.log(`  db: ${DB_PATH}   app: ${APP_ROOT}   rows: ${CORRECTIONS.length} corrections + ${RETRO_ARCHIVE.length} retro-archive\n`);

  const findByPrefix = db.prepare(`
    SELECT id, description, bet_type, sport, odds, units, result, profit_units,
           grade, grade_reason, graded_at, grader_version
    FROM bets WHERE id LIKE ?
  `);
  const tailCount = db.prepare('SELECT COUNT(*) AS n FROM user_bets WHERE bet_id = ?');
  const historyCount = db.prepare('SELECT COUNT(*) AS n FROM bet_grade_history WHERE bet_id = ?');

  // Prefix → exactly one bets row, or fatal on ambiguity (no writes yet — safe).
  function resolve(prefix) {
    const rows = findByPrefix.all(prefix + '%');
    if (rows.length > 1) {
      console.error(`FATAL: id prefix ${prefix} matches ${rows.length} bets — correction table is unsafe, aborting.`);
      process.exit(2);
    }
    return rows[0] || null;
  }

  // ── Evaluate corrections (shared by both modes) ───────────
  const plans = CORRECTIONS.map((row) => {
    const bet = resolve(row.id);
    if (!bet) return { row, status: 'skip', why: 'not_found' };
    if (bet.grader_version != null) return { row, bet, status: 'skip', why: `grader_version=${bet.grader_version} (not a pre-gate row)` };
    if (bet.result !== row.expect_stored_result) return { row, bet, status: 'skip', why: `stored result '${bet.result}' != expected '${row.expect_stored_result}' (already corrected?)` };

    const refusals = [];
    const warns = [];
    if (bet.bet_type !== 'straight') refusals.push(`bet_type='${bet.bet_type}' (export was straights; legs out of scope)`);
    const writeValue = calcProfit(bet.odds || -110, bet.units || 1, row.new_result);
    if (Math.abs(round2(writeValue) - row.new_pu) > PU_TOLERANCE) {
      refusals.push(`pu mismatch: calcProfit(odds=${bet.odds}, units=${bet.units}) = ${round2(writeValue)} vs table new_pu ${row.new_pu} (odds/units drifted vs export?)`);
    }
    const tails = tailCount.get(bet.id).n;
    if (tails > 0) refusals.push(`HARD GATE: ${tails} user_bets row(s) — applyGradeOverride does not reconcile user_bets; manual decision required`);
    const storedPu = bet.profit_units == null ? null : parseFloat(bet.profit_units);
    if (storedPu != null && Math.abs(storedPu - row.expect_stored_pu) > 0.005) {
      warns.push(`stored pu ${storedPu} != audit's ${row.expect_stored_pu} (informational)`);
    }
    return { row, bet, tails, writeValue, storedPu, warns, refusals, status: refusals.length ? 'refuse' : 'ok' };
  });

  // ── Evaluate retro-archive rows ───────────────────────────
  const retroPlans = RETRO_ARCHIVE.map((row) => {
    const bet = resolve(row.id);
    if (!bet) return { row, status: 'skip', why: 'not_found' };
    if (historyCount.get(bet.id).n > 0) return { row, bet, status: 'skip', why: 'bet_grade_history row already exists' };
    if (bet.result !== row.expect_current_result) return { row, bet, status: 'skip', why: `current result '${bet.result}' != expected corrected '${row.expect_current_result}'` };
    return { row, bet, status: 'ok' };
  });

  // ── Report ────────────────────────────────────────────────
  let i = 0;
  for (const p of plans) {
    i++;
    const head = `[${String(i).padStart(2)}/${plans.length}] ${p.row.id}  ${p.row.sport} ${p.row.market}`;
    if (p.status === 'skip') { console.log(`${head}  SKIP — ${p.why}`); continue; }
    const flip = `${p.row.expect_stored_result}→${p.row.new_result.toUpperCase()}`;
    console.log(`${head}  ${p.status === 'refuse' ? 'REFUSE' : 'FLIP'} ${flip}`);
    console.log(`        desc:   ${String(p.bet.description).slice(0, 100)}`);
    console.log(`        stored: ${p.bet.result} / ${p.storedPu}  →  ${p.row.new_result} / ${round2(p.writeValue)} (table ${p.row.new_pu})`);
    console.log(`        tails:  ${p.tails}`);
    console.log(`        ev:     ${p.row.evidence_url}`);
    for (const w of p.warns) console.log(`        WARN:   ${w}`);
    for (const r of p.refusals) console.log(`        REFUSE: ${r}`);
  }

  console.log('\nretro-archive:');
  for (const p of retroPlans) {
    if (p.status === 'skip') console.log(`  ${p.row.id}  SKIP — ${p.why}`);
    else console.log(`  ${p.row.id}  ARCHIVE old ${p.row.old_result} / ${p.row.old_profit_units} (current: ${p.bet.result})`);
  }

  const ok = plans.filter(p => p.status === 'ok');
  const refused = plans.filter(p => p.status === 'refuse');
  const skipped = plans.filter(p => p.status === 'skip');
  const netDelta = ok.reduce((s, p) => s + (p.writeValue - (p.storedPu || 0)), 0);
  const tailsTotal = plans.reduce((s, p) => s + (p.tails || 0), 0);
  const dirOk = { lossToWin: 0, winToLoss: 0, winToVoid: 0 };
  for (const p of ok) {
    if (p.row.new_result === 'win') dirOk.lossToWin++;
    else if (p.row.new_result === 'loss') dirOk.winToLoss++;
    else dirOk.winToVoid++;
  }

  console.log('\ntotals:');
  console.log(`  table:      loss→win ${dirTotals.lossToWin}, win→loss ${dirTotals.winToLoss}, win→void ${dirTotals.winToVoid}`);
  console.log(`  actionable: loss→win ${dirOk.lossToWin}, win→loss ${dirOk.winToLoss}, win→void ${dirOk.winToVoid}  (skipped ${skipped.length}, refused ${refused.length})`);
  console.log(`  net profit_units delta (actionable rows): ${round2(netDelta) >= 0 ? '+' : ''}${round2(netDelta)}u`);
  console.log(`  user_bets tails across evaluated rows: ${tailsTotal}`);
  const retroOk = retroPlans.filter(p => p.status === 'ok');
  console.log(`  retro-archive: ${retroOk.length} to insert, ${retroPlans.length - retroOk.length} skipped`);

  if (refused.length) {
    console.log('\nREFUSED rows (manual decision required, NOT applied):');
    for (const p of refused) console.log(`  ${p.row.id} — ${p.refusals.join(' | ')}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  // ── Apply (ONE transaction for everything) ────────────────
  const deps = {
    db,
    getBankroll: () => null, // bankroll reconciliation out of scope — see header
    updateBankroll: () => { throw new Error('write-scope violation: updateBankroll called'); },
    saveDailySnapshot: () => { throw new Error('write-scope violation: saveDailySnapshot called'); },
    calcProfit,
  };
  const insertHistory = db.prepare(`
    INSERT INTO bet_grade_history
      (bet_id, old_result, old_profit_units, old_grade, old_grade_reason, old_graded_at, archived_by, reason)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
  `);

  const runAll = db.transaction(() => {
    let flips = 0, retros = 0;
    for (const p of ok) {
      const res = applyGradeOverride(deps, {
        betId: p.bet.id,
        result: p.row.new_result,
        reason: `${p.row.reason} — ${p.row.evidence_url}`,
        invokerId: ARCHIVED_BY,
      });
      if (!res.ok) throw new Error(`applyGradeOverride failed on ${p.row.id}: ${res.error}`);
      // Belt-and-braces: the neutered deps + straight-only gate make these
      // unreachable; a hit means the write scope was violated — roll back all.
      if (res.bankrollApplied || res.legsTouched) throw new Error(`write-scope violation on ${p.row.id}: bankrollApplied=${res.bankrollApplied} legsTouched=${res.legsTouched}`);
      if (Math.abs(res.newProfit - p.writeValue) > 1e-9) throw new Error(`profit drift on ${p.row.id}: wrote ${res.newProfit}, planned ${p.writeValue}`);
      flips++;
    }
    for (const p of retroPlans) {
      if (p.status !== 'ok') continue;
      insertHistory.run(p.bet.id, p.row.old_result, p.row.old_profit_units, RETRO_ARCHIVED_BY, p.row.reason);
      retros++;
    }
    return { flips, retros };
  });

  try {
    const { flips, retros } = runAll();
    console.log(`\nAPPLIED: ${flips} bets corrected (archive+update), ${retros} retro-archive rows inserted — one transaction, committed.`);
  } catch (err) {
    console.error(`\nAPPLY FAILED — transaction rolled back, nothing written: ${err.message}`);
    db.close();
    process.exit(2);
  }
  db.close();
}
