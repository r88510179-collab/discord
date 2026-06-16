// ═══════════════════════════════════════════════════════════
// Unmodeled-league bets → manual review (NOT auto-void).
//
// Background: gradePropWithAI's supported-sport gate
// (`if (!isSupportedSport(bet.sport))`) auto-voids to
// review_status='auto_void_unscoped_bet'. For an intentionally-UNMODELED real
// league (KBO/KHL/NPB) isSupportedSport returns false, so the bet was
// force-voided — a silent, often FALSE settled result for a real bet. Live
// casualty: IgDave KBO parlay, ingest disc_1514481735335805030 (the instant it
// is confirmed the grader voids it). The codebase already deliberately excludes
// these leagues from alias-rescue (grading.js SPORT_ALIAS_TO_CANONICAL :527-529 +
// normalization.js isUnmodeledSportPart); the missing half is that "unmodeled"
// must mean "a human grades it", NOT "void it".
//
// Fix: BEFORE the auto-void write, declaresAnyUnmodeledLeague(bet.sport) (ANY
// part of a compound — a parlay can't settle while one leg is unmodeled) diverts
// to a terminal manual-review state: review_status='manual_review_unmodeled_sport',
// grading_state='done' (grader won't re-pick), result stays 'pending' (NO
// grade/profit written), DROP reason GRADE_MANUAL_REVIEW_UNMODELED. The state is
// sweeper-safe — getPendingBets (the autograder + 7-day sweeper's only source)
// excludes it in BOTH selector paths. Null/Unknown/garbage sports STILL auto-void
// exactly as before.
//
// Covers:
//   A. Unit — declaresAnyUnmodeledLeague: real unmodeled leagues (incl. ANY part
//      of a compound) → true; placeholders/null/empty + modeled-code labels
//      ("MLB Wednesday picks") → false (no regression).
//   B. Quantifier duality with declaresOnlyUnmodeledLeagues (.some vs .every).
//   C. Gate composition — the exact divert vs void vs pass-through condition.
//   D. Composition with #110 — "World Cup" is canonicalized to SOCCER before the
//      gate, so the divert never fires for it (no conflict).
//   E. Integration — gradePropWithAI parks KBO + MLB/KBO in manual review
//      (result pending, no grade), STILL auto-voids Unknown/garbage, stamps the
//      distinct drop reasons.
//   F. Sweeper-safety — getPendingBets excludes the parked bet in BOTH the
//      state-machine and kill-switch paths, even when backdated past the 7-day
//      sweep cutoff; a normal confirmed/ready bet is still returned (control).
//
// Behaviour-change assertions FAIL on pre-fix code: declaresAnyUnmodeledLeague
// does not exist (A/B/C), and pre-fix the KBO bet is auto_void_unscoped_bet (E).
//
// Run:  node tests/unmodeled-sport-manual-review.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — required only because requiring grading.js pulls in ai.js;
// the divert/void branches return BEFORE any grader dispatch, but reject the wire
// so a stray downstream path fails fast instead of hanging.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB for the integration write-path checks. Set BEFORE requiring
// database/grading so the real production DB is never opened.
const dbFile = path.join(os.tmpdir(), `bettracker-unmodeled-mr-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
// Default production mode (state machine ON). Tests flip it explicitly for the
// kill-switch path and restore it.
delete process.env.GRADING_STATE_MACHINE_ENABLED;

const grading = require('../services/grading');
const { isSupportedSport, canonicalizeSportForGrading, gradePropWithAI } = grading;
const { evaluateSweep } = grading._internal;
const normalization = require('../services/normalization');
const { declaresAnyUnmodeledLeague, declaresOnlyUnmodeledLeagues } = normalization;
const database = require('../services/database');
const { getPendingBets } = database;

// Fail FAST and LOUD on pre-fix code: pre-fix the predicate is undefined, so
// assert its presence up front with an explicit message rather than a raw
// TypeError mid-suite. (The suite still exits non-zero on pre-fix — a valid red.)
assert.strictEqual(
  typeof declaresAnyUnmodeledLeague, 'function',
  'declaresAnyUnmodeledLeague must be exported from services/normalization.js',
);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// ── A. Unit: declaresAnyUnmodeledLeague ─────────────────────────────────
console.log('A. declaresAnyUnmodeledLeague — real unmodeled leagues → true');
check('KBO → true', declaresAnyUnmodeledLeague('KBO'), true);
check('KHL → true', declaresAnyUnmodeledLeague('KHL'), true);
check('NPB → true', declaresAnyUnmodeledLeague('NPB'), true);
check('lowercase "kbo" → true (case-insensitive)', declaresAnyUnmodeledLeague('kbo'), true);
check('"Korean Baseball" → true (foreign-qualified name, not a modeled alias)', declaresAnyUnmodeledLeague('Korean Baseball'), true);
check('compound "MLB/KBO" → true (ANY part unmodeled)', declaresAnyUnmodeledLeague('MLB/KBO'), true);
check('compound "KBO/KHL" → true', declaresAnyUnmodeledLeague('KBO/KHL'), true);
check('compound "NHL & KHL" → true (& separator)', declaresAnyUnmodeledLeague('NHL & KHL'), true);

console.log('A. declaresAnyUnmodeledLeague — placeholders/null/modeled → false');
check('Unknown → false (placeholder)', declaresAnyUnmodeledLeague('Unknown'), false);
check('"N/A" → false (placeholder; whole-label pre-check, not split on /)', declaresAnyUnmodeledLeague('N/A'), false);
check('"TBD" → false (placeholder)', declaresAnyUnmodeledLeague('TBD'), false);
check('null → false', declaresAnyUnmodeledLeague(null), false);
check('undefined → false', declaresAnyUnmodeledLeague(undefined), false);
check('"" → false', declaresAnyUnmodeledLeague(''), false);
check('"   " → false', declaresAnyUnmodeledLeague('   '), false);
check('MLB → false (modeled code)', declaresAnyUnmodeledLeague('MLB'), false);
check('NBA → false (modeled code)', declaresAnyUnmodeledLeague('NBA'), false);
check('"MLB Wednesday picks" → false (only part carries the whole-word code MLB)', declaresAnyUnmodeledLeague('MLB Wednesday picks'), false);
check('compound "MLB/NHL" → false (every part modeled)', declaresAnyUnmodeledLeague('MLB/NHL'), false);
check('"Baseball" → false (generic name for a modeled league)', declaresAnyUnmodeledLeague('Baseball'), false);

// ── B. Quantifier duality with declaresOnlyUnmodeledLeagues ──────────────
console.log('B. duality — .some (Any) vs .every (Only)');
// The discriminating case: a mixed modeled+unmodeled compound is ANY-true but
// ONLY-false. This is exactly why the gate uses the ANY predicate (the KBO leg
// blocks settlement) rather than reusing declaresOnlyUnmodeledLeagues.
check('MLB/KBO: Any=true', declaresAnyUnmodeledLeague('MLB/KBO'), true);
check('MLB/KBO: Only=false', declaresOnlyUnmodeledLeagues('MLB/KBO'), false);
// Where they agree.
check('KBO: Any=Only=true', [declaresAnyUnmodeledLeague('KBO'), declaresOnlyUnmodeledLeagues('KBO')], [true, true]);
check('MLB: Any=Only=false', [declaresAnyUnmodeledLeague('MLB'), declaresOnlyUnmodeledLeagues('MLB')], [false, false]);
check('Unknown: Any=Only=false', [declaresAnyUnmodeledLeague('Unknown'), declaresOnlyUnmodeledLeagues('Unknown')], [false, false]);

// ── C. Gate composition — divert vs void vs pass-through ─────────────────
console.log('C. gate composition: isSupportedSport × declaresAnyUnmodeledLeague');
// DIVERT branch: unsupported AND a real unmodeled league.
for (const s of ['KBO', 'KHL', 'NPB', 'MLB/KBO']) {
  ok(`"${s}" enters the gate (unsupported)`, isSupportedSport(s) === false);
  ok(`"${s}" diverts to manual review (declaresAnyUnmodeledLeague)`, declaresAnyUnmodeledLeague(s) === true);
}
// VOID branch: unsupported but NOT a real unmodeled league (garbage/placeholder).
for (const s of ['Unknown', 'MLB Wednesday picks']) {
  ok(`"${s}" enters the gate (unsupported)`, isSupportedSport(s) === false);
  ok(`"${s}" still auto-voids (NOT diverted)`, declaresAnyUnmodeledLeague(s) === false);
}
// PASS-THROUGH: a supported sport never enters the gate at all.
ok('NBA supported → gate not entered (neither divert nor void)', isSupportedSport('NBA') === true);

// ── D. Composition with #110 (canonicalizeSportForGrading) ──────────────
console.log('D. composes with #110 — "World Cup" canonicalized to SOCCER before the gate');
// gradePropWithAI canonicalizes the sport BEFORE the supported-sport gate, so a
// "World Cup"-LABELED pick is SOCCER (supported) by then and the divert never
// fires for it — even though declaresAnyUnmodeledLeague('World Cup') alone is true.
check('canonicalize("World Cup") → SOCCER', canonicalizeSportForGrading('World Cup'), 'SOCCER');
ok('canonicalized SOCCER is supported → gate not entered', isSupportedSport(canonicalizeSportForGrading('World Cup')) === true);

// ── E + F. Integration (async) ──────────────────────────────────────────
database.db.pragma('foreign_keys = OFF');

async function gradeRow(betRow) {
  // The divert/void branches return their sentinel BEFORE any grader dispatch
  // (no network). try/catch only guards a hypothetical downstream path.
  try { await gradePropWithAI({ ...betRow }); } catch (_) { /* offline downstream */ }
  return database.db.prepare(
    'SELECT result, review_status, grading_state, grade, profit_units, graded_at, grade_reason, drop_reason FROM bets WHERE id = ?',
  ).get(betRow.id);
}

(async () => {
  // ── E. gradePropWithAI write path ─────────────────────────────────────
  console.log('E. integration — gradePropWithAI divert vs void');

  // KBO single pick (clean description: no US-team nickname, so reclassifySport
  // leaves sport='KBO'). FAILS pre-fix → auto_void_unscoped_bet + result void.
  const kbo = database.createBet({
    capper_id: 'test-capper', sport: 'KBO',
    description: 'KBO run line first five innings test-unmodeled',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  const kboAfter = await gradeRow(kbo);
  ok('KBO → manual_review_unmodeled_sport', kboAfter.review_status === 'manual_review_unmodeled_sport');
  ok('KBO NOT voided (result stays pending)', kboAfter.result === 'pending');
  ok('KBO grading_state=done (grader won\'t re-pick)', kboAfter.grading_state === 'done');
  ok('KBO no grade written', kboAfter.grade === null);
  // profit_units is REAL DEFAULT 0; the divert never touches it, so it stays at
  // the ungraded default 0 (no win/loss profit computed). result='pending' also
  // keeps it out of all SETTLED_BET / ROI math regardless.
  ok('KBO no settled profit written (stays default 0)', kboAfter.profit_units === 0);
  ok('KBO not graded_at', kboAfter.graded_at === null);
  ok('KBO grade_reason names manual review', /manual review/i.test(kboAfter.grade_reason || ''));
  ok('KBO drop_reason = GRADE_MANUAL_REVIEW_UNMODELED', kboAfter.drop_reason === 'GRADE_MANUAL_REVIEW_UNMODELED');

  // Idempotent: a SECOND grade of the same already-parked bet must be a no-op —
  // it stays manual_review and does NOT emit a second DROP (the review_status
  // guard in the divert UPDATE makes changes=0 on the re-run).
  const mrDropCount = (id) => database.db.prepare(
    "SELECT COUNT(*) AS c FROM pipeline_events WHERE bet_id = ? AND event_type = 'DROP' AND drop_reason = 'GRADE_MANUAL_REVIEW_UNMODELED'",
  ).get(id).c;
  ok('one GRADE_MANUAL_REVIEW_UNMODELED drop after first grade', mrDropCount(kbo.id) === 1);
  const kboAgain = await gradeRow(kbo);
  ok('re-grade keeps manual_review (idempotent)', kboAgain.review_status === 'manual_review_unmodeled_sport');
  ok('re-grade does NOT emit a second drop', mrDropCount(kbo.id) === 1);

  // Compound MLB/KBO — the unmodeled KBO leg blocks settlement → manual review.
  const compound = database.createBet({
    capper_id: 'test-capper', sport: 'MLB/KBO',
    description: 'MLB run line and KBO total over test-unmodeled',
    bet_type: 'parlay', odds: '+150', units: 1, source: 'test',
  });
  const compoundAfter = await gradeRow(compound);
  ok('MLB/KBO → manual_review (unmodeled leg blocks settlement)', compoundAfter.review_status === 'manual_review_unmodeled_sport');
  ok('MLB/KBO result stays pending', compoundAfter.result === 'pending');

  // Unknown — STILL auto-voids (placeholder, no real unmodeled league).
  const unknown = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown',
    description: 'random qwerty chatter no teams here test-unmodeled',
    bet_type: 'straight', odds: '-120', units: 1, source: 'test',
  });
  const unknownAfter = await gradeRow(unknown);
  ok('Unknown STILL auto_void_unscoped_bet (no regression)', unknownAfter.review_status === 'auto_void_unscoped_bet');
  ok('Unknown result void', unknownAfter.result === 'void');
  ok('Unknown drop_reason = GRADE_AUTOVOID_UNSCOPED (distinct from divert)', unknownAfter.drop_reason === 'GRADE_AUTOVOID_UNSCOPED');

  // null sport — createBet coerces null → 'Unknown', which STILL auto-voids.
  const nullSport = database.createBet({
    capper_id: 'test-capper', sport: null,
    description: 'free wednesday slate nothing here test-unmodeled',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  const nullAfter = await gradeRow(nullSport);
  ok('null sport (→Unknown) STILL auto-voids', nullAfter.review_status === 'auto_void_unscoped_bet');

  // Garbage caption that happens to carry a modeled code → STILL auto-voids.
  const garbage = database.createBet({
    capper_id: 'test-capper', sport: 'MLB Wednesday picks',
    description: 'free wednesday slate promo test-unmodeled',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  const garbageAfter = await gradeRow(garbage);
  ok('"MLB Wednesday picks" STILL auto-voids (modeled-code label, not unmodeled)', garbageAfter.review_status === 'auto_void_unscoped_bet');
  ok('"MLB Wednesday picks" result void', garbageAfter.result === 'void');

  // ── F. Sweeper-safety — getPendingBets exclusion ──────────────────────
  console.log('F. sweeper-safety — getPendingBets excludes the parked bet (both paths)');

  // The KBO bet is now result='pending' but parked. getPendingBets is the ONLY
  // source for both the autograder loop and the 7-day sweeper, so excluding it
  // here makes it sweeper-safe. State-machine path (default):
  const inDefault = getPendingBets().some(b => b.id === kbo.id);
  ok('state-machine getPendingBets EXCLUDES the parked KBO bet', inDefault === false);

  // Kill-switch path (GRADING_STATE_MACHINE_ENABLED='false') — the broad
  // result='pending' statement filtered only on review_status. Must also exclude.
  process.env.GRADING_STATE_MACHINE_ENABLED = 'false';
  const inKillSwitch = getPendingBets().some(b => b.id === kbo.id);
  delete process.env.GRADING_STATE_MACHINE_ENABLED;
  ok('kill-switch getPendingBets EXCLUDES the parked KBO bet', inKillSwitch === false);

  // Backdate past the 7-day sweep cutoff — still excluded, so the sweeper (which
  // filters getPendingBets) never sees it → can never settle it to a FALSE loss.
  database.db.prepare("UPDATE bets SET created_at = datetime('now','-10 days') WHERE id = ?").run(kbo.id);
  const inDefaultStale = getPendingBets().some(b => b.id === kbo.id);
  process.env.GRADING_STATE_MACHINE_ENABLED = 'false';
  const inKillStale = getPendingBets().some(b => b.id === kbo.id);
  delete process.env.GRADING_STATE_MACHINE_ENABLED;
  ok('parked KBO bet stays excluded even when stale (state-machine)', inDefaultStale === false);
  ok('parked KBO bet stays excluded even when stale (kill-switch)', inKillStale === false);

  // Control — a normal confirmed/ready/pending bet IS returned (exclusion is
  // specific to the parked state, not a blanket drop). Backdate it too to show a
  // genuinely stale confirmed bet WOULD reach the sweeper.
  const control = database.createBet({
    capper_id: 'test-capper', sport: 'NBA',
    description: 'a normal confirmed pending bet test-unmodeled',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  database.db.prepare("UPDATE bets SET created_at = datetime('now','-10 days') WHERE id = ?").run(control.id);
  const controlIncludedDefault = getPendingBets().some(b => b.id === control.id);
  process.env.GRADING_STATE_MACHINE_ENABLED = 'false';
  const controlIncludedKill = getPendingBets().some(b => b.id === control.id);
  delete process.env.GRADING_STATE_MACHINE_ENABLED;
  ok('control confirmed/ready bet IS returned by getPendingBets (state-machine)', controlIncludedDefault === true);
  ok('control confirmed/ready bet IS returned by getPendingBets (kill-switch)', controlIncludedKill === true);

  // ── F2. In-cycle sweeper race — the live-state guard in evaluateSweep ──
  // getPendingBets only protects FUTURE cycles. runAutoGrade snapshots `pending`
  // ONCE, then its grader loop diverts a bet mid-cycle; that bet is still in the
  // STALE array the 7-day sweeper filters via evaluateSweep. The divert keeps
  // result='pending', so canFinalizeBet (which re-checks only result) can't stop
  // the sweep — evaluateSweep must refuse it by re-reading the live grading_state.
  // Reproduce with a stale snapshot object (old created_at) for the already-
  // diverted (grading_state='done'), backdated kbo bet:
  const staleKbo = { id: kbo.id, created_at: '2020-01-01 00:00:00', bet_type: 'straight', description: 'KBO run line first five innings test-unmodeled' };
  const kboVerdict = evaluateSweep(staleKbo);
  ok('evaluateSweep refuses to sweep the parked KBO bet (reason=parked)', kboVerdict.eligible === false && kboVerdict.reason === 'parked');
  // Control: a same-age confirmed/ready bet IS sweep-eligible — proving it is the
  // parked grading_state='done', not the age, that spares the diverted bet.
  const staleControl = { id: control.id, created_at: '2020-01-01 00:00:00', bet_type: 'straight', description: 'a normal confirmed pending bet test-unmodeled' };
  const controlVerdict = evaluateSweep(staleControl);
  ok('evaluateSweep WOULD sweep the same-age confirmed/ready control (reason=eligible)', controlVerdict.eligible === true && controlVerdict.reason === 'eligible');
  // The guard is bet-type-agnostic — a diverted compound PARLAY (incl. a no-leg
  // parlay, which canFinalizeBet would clear) is parked too.
  const staleCompound = { id: compound.id, created_at: '2020-01-01 00:00:00', bet_type: 'parlay', description: 'MLB run line and KBO total over test-unmodeled' };
  const compoundVerdict = evaluateSweep(staleCompound);
  ok('evaluateSweep refuses to sweep the parked compound parlay (reason=parked)', compoundVerdict.eligible === false && compoundVerdict.reason === 'parked');

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\nunmodeled-sport-manual-review: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
