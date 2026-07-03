// ═══════════════════════════════════════════════════════════
// Multi-pick straight → manual review (NOT graded as a lone leg).
//
// Background: the ingest parser is told to type 2+ picks as 'parlay' (ai.js),
// but on raw tweet text it misfires and stores a whole card as ONE 'straight'.
// Live case (pre-gate bet 9aa55f5b): "Pistons/Magic UNDER 209.5, Rockets -3.5,
// Cavaliers -3.5" was stored bet_type='straight'; the grader graded only the
// first market (the UNDER hit) and minted a false WIN — the real 3-leg parlay
// LOST (Rockets and Cavaliers both missed their -3.5). The existing parlay
// completeness guard (parlayLegDataComplete) never sees it: it is scoped to
// bet_type parlay/sgp and counts picks by `•` bullets (a comma card has none).
//
// Fix: in gradePropWithAI, AFTER the parlay dispatch and BEFORE gradeSingleBet,
// looksLikeMultiPickStraight(description) diverts a comma/list-separated card to
// a terminal manual-review state: review_status='needs_review', grading_state=
// 'done' (grader won't re-pick), result stays 'pending' (NO grade written),
// DROP reason GRADE_MANUAL_REVIEW_MULTIPICK. Sweeper-safe — getPendingBets (the
// autograder + 7-day sweeper's only source) excludes needs_review in BOTH
// selector paths, and evaluateSweep refuses grading_state='done'. Kill-switch
// MULTIPICK_STRAIGHT_GUARD=off reverts to grading it as a single.
//
// Covers:
//   A. Unit — looksLikeMultiPickStraight: the live card + 2/3-pick shapes → true;
//      single matchup total, odds tail, F5 qualifier, compound player prop,
//      single spread/ML, empty/null → false (HIGH-PRECISION, no over-trigger).
//   B. Unit — segmentIsPick: subject+market → true; bare odds / lone total /
//      qualifier → false.
//   C. Integration — gradePropWithAI parks the multi-pick straight (pending, no
//      grade, distinct drop) and is idempotent.
//   D. Sweeper-safety — getPendingBets excludes the parked bet (both paths, even
//      when stale); evaluateSweep refuses it; a control single bet is returned.
//   E. Precision integration — a genuine single-pick straight is NOT diverted.
//   F. Kill-switch — MULTIPICK_STRAIGHT_GUARD=off does not divert.
//
// Behaviour-change assertions FAIL on pre-fix code: looksLikeMultiPickStraight /
// segmentIsPick do not exist (A/B), and pre-fix the multi-pick straight is NOT
// parked to needs_review (C).
//
// Run:  node tests/multipick-straight-guard.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — required only because requiring grading.js pulls in ai.js;
// the divert returns its sentinel BEFORE any grader dispatch, and the negative
// controls short-circuit at GUARD 3 (too-recent) before any search.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB — set BEFORE requiring database/grading so the real prod DB is
// never opened.
const dbFile = path.join(os.tmpdir(), `bettracker-multipick-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.MULTIPICK_STRAIGHT_GUARD; // default (enforce) unless a case flips it

const grading = require('../services/grading');
const { gradePropWithAI } = grading;
const { looksLikeMultiPickStraight, segmentIsPick, evaluateSweep } = grading._internal;
const database = require('../services/database');
const { getPendingBets } = database;

assert.strictEqual(
  typeof looksLikeMultiPickStraight, 'function',
  'looksLikeMultiPickStraight must be exported from services/grading.js _internal',
);
assert.strictEqual(
  typeof segmentIsPick, 'function',
  'segmentIsPick must be exported from services/grading.js _internal',
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

// ── A. Unit: looksLikeMultiPickStraight ─────────────────────────────────
console.log('A. looksLikeMultiPickStraight — multi-pick cards → true');
check('live 9aa55f5b 3-pick comma card → true',
  looksLikeMultiPickStraight('Pistons/Magic UNDER 209.5, Rockets -3.5, Cavaliers -3.5'), true);
check('2 spreads, comma → true', looksLikeMultiPickStraight('Rockets -3.5, Cavaliers -3.5'), true);
check('3 mixed markets, comma → true', looksLikeMultiPickStraight('Dodgers -1.5, Padres +1.5, Giants ML'), true);
check('two ML picks joined by "and" → true', looksLikeMultiPickStraight('Yankees ML and Red Sox ML'), true);
check('two picks joined by "&" → true', looksLikeMultiPickStraight('Lakers -5.5 & Celtics ML'), true);
check('newline-separated picks → true', looksLikeMultiPickStraight('Rockets -3.5\nCavaliers -3.5'), true);

console.log('A. looksLikeMultiPickStraight — single bets → false (no over-trigger)');
check('single matchup total (slash, no comma) → false',
  looksLikeMultiPickStraight('Pistons/Magic UNDER 209.5'), false);
check('single spread with parenthesized odds → false',
  looksLikeMultiPickStraight('San Antonio Spurs -6.5 (-110)'), false);
check('single ML with odds + units → false', looksLikeMultiPickStraight('Canadiens ML (+170) 2u'), false);
check('spread then bare odds tail → false (2nd seg has no subject)',
  looksLikeMultiPickStraight('Lakers -5.5, -110'), false);
check('spread then teamless total tail → false',
  looksLikeMultiPickStraight('Lakers -5.5, over 220'), false);
check('spread then segment qualifier → false (no market in 2nd seg)',
  looksLikeMultiPickStraight('Yankees -1.5, first 5 innings'), false);
check('compound player prop ("and 2.5 total bases") → false',
  looksLikeMultiPickStraight('Aaron Judge over 1.5 hits and 2.5 total bases'), false);
check('single game total (two teams named, one segment) → false',
  looksLikeMultiPickStraight('Bulls Knicks Over 237.5'), false);
check('total then matchup restatement → false',
  looksLikeMultiPickStraight('Over 9.5, Yankees vs Red Sox'), false);
check('empty → false', looksLikeMultiPickStraight(''), false);
check('null → false', looksLikeMultiPickStraight(null), false);
check('undefined → false', looksLikeMultiPickStraight(undefined), false);

// ── B. Unit: segmentIsPick ──────────────────────────────────────────────
console.log('B. segmentIsPick — subject + market indicator required');
check('"Rockets -3.5" → pick', segmentIsPick('Rockets -3.5'), true);
check('"Pistons/Magic UNDER 209.5" → pick', segmentIsPick('Pistons/Magic UNDER 209.5'), true);
check('"Yankees ML" → pick', segmentIsPick('Yankees ML'), true);
check('"LeBron James 25+ points" → pick (N+ stat)', segmentIsPick('LeBron James 25+ points'), true);
check('"-110" (bare odds) → not a pick', segmentIsPick('-110'), false);
check('"over 220" (no subject) → not a pick', segmentIsPick('over 220'), false);
check('"first 5 innings" (no market) → not a pick', segmentIsPick('first 5 innings'), false);
check('"" → not a pick', segmentIsPick(''), false);

// ── C + D + E + F. Integration (async) ──────────────────────────────────
database.db.pragma('foreign_keys = OFF');

async function gradeRow(betRow) {
  try { await gradePropWithAI({ ...betRow }); } catch (_) { /* offline downstream */ }
  return database.db.prepare(
    'SELECT result, review_status, grading_state, grade, profit_units, graded_at, grade_reason, drop_reason FROM bets WHERE id = ?',
  ).get(betRow.id);
}
const mrDropCount = (id) => database.db.prepare(
  "SELECT COUNT(*) AS c FROM pipeline_events WHERE bet_id = ? AND event_type = 'DROP' AND drop_reason = 'GRADE_MANUAL_REVIEW_MULTIPICK'",
).get(id).c;

(async () => {
  // ── C. gradePropWithAI divert write path ──────────────────────────────
  console.log('C. integration — multi-pick straight parked for manual review');
  const card = database.createBet({
    capper_id: 'test-capper', sport: 'NBA',
    description: 'Pistons/Magic UNDER 209.5, Rockets -3.5, Cavaliers -3.5',
    bet_type: 'straight', odds: '', units: 5, source: 'twitter_text',
  });
  const cardAfter = await gradeRow(card);
  ok('multi-pick straight → review_status=needs_review', cardAfter.review_status === 'needs_review');
  ok('multi-pick straight NOT graded (result stays pending)', cardAfter.result === 'pending');
  ok('multi-pick straight grading_state=done (grader won\'t re-pick)', cardAfter.grading_state === 'done');
  ok('multi-pick straight no grade written', cardAfter.grade === null);
  ok('multi-pick straight no settled profit (stays default 0)', cardAfter.profit_units === 0);
  ok('multi-pick straight not graded_at', cardAfter.graded_at === null);
  ok('multi-pick straight grade_reason names multi-pick manual review', /multi-pick/i.test(cardAfter.grade_reason || ''));
  ok('multi-pick straight drop_reason = GRADE_MANUAL_REVIEW_MULTIPICK', cardAfter.drop_reason === 'GRADE_MANUAL_REVIEW_MULTIPICK');

  // Idempotent — a second grade of the already-parked bet is a 0-change no-op
  // (the review_status guard in the divert UPDATE) and emits no second drop.
  ok('one GRADE_MANUAL_REVIEW_MULTIPICK drop after first grade', mrDropCount(card.id) === 1);
  const cardAgain = await gradeRow(card);
  ok('re-grade keeps needs_review (idempotent)', cardAgain.review_status === 'needs_review');
  ok('re-grade does NOT emit a second drop', mrDropCount(card.id) === 1);

  // ── D. Sweeper-safety ─────────────────────────────────────────────────
  console.log('D. sweeper-safety — getPendingBets excludes the parked bet');
  ok('state-machine getPendingBets EXCLUDES the parked card', getPendingBets().every(b => b.id !== card.id));
  process.env.GRADING_STATE_MACHINE_ENABLED = 'false';
  const inKill = getPendingBets().some(b => b.id === card.id);
  delete process.env.GRADING_STATE_MACHINE_ENABLED;
  ok('kill-switch getPendingBets EXCLUDES the parked card', inKill === false);

  // Backdate past the 7-day cutoff — still excluded, and evaluateSweep refuses
  // it (grading_state='done' → reason=parked), so it can never be swept to a
  // false loss.
  database.db.prepare("UPDATE bets SET created_at = datetime('now','-10 days') WHERE id = ?").run(card.id);
  ok('parked card stays excluded when stale', getPendingBets().every(b => b.id !== card.id));
  const staleCard = { id: card.id, created_at: '2020-01-01 00:00:00', bet_type: 'straight', description: 'Pistons/Magic UNDER 209.5, Rockets -3.5, Cavaliers -3.5' };
  const cardVerdict = evaluateSweep(staleCard);
  ok('evaluateSweep refuses to sweep the parked card (reason=parked)', cardVerdict.eligible === false && cardVerdict.reason === 'parked');

  // ── E. Precision integration — a genuine single straight is NOT diverted ─
  console.log('E. precision — a real single-pick straight is NOT parked');
  const single = database.createBet({
    capper_id: 'test-capper', sport: 'NBA',
    description: 'San Antonio Spurs -6.5 (-110)',
    bet_type: 'straight', odds: '-110', units: 5, source: 'twitter_text',
  });
  const singleAfter = await gradeRow(single); // created now → GUARD 3 too-recent → PENDING, no divert
  ok('single straight NOT parked to needs_review', singleAfter.review_status !== 'needs_review');
  ok('single straight has no multi-pick drop', singleAfter.drop_reason !== 'GRADE_MANUAL_REVIEW_MULTIPICK');
  ok('single straight not graded (stays pending, no divert)', singleAfter.result === 'pending');

  // ── F. Kill-switch ────────────────────────────────────────────────────
  console.log('F. kill-switch — MULTIPICK_STRAIGHT_GUARD=off does not divert');
  process.env.MULTIPICK_STRAIGHT_GUARD = 'off';
  const cardOff = database.createBet({
    capper_id: 'test-capper', sport: 'NBA',
    description: 'Rockets -3.5, Cavaliers -3.5, Wizards +7.5',
    bet_type: 'straight', odds: '', units: 3, source: 'twitter_text',
  });
  const cardOffAfter = await gradeRow(cardOff);
  delete process.env.MULTIPICK_STRAIGHT_GUARD;
  ok('kill-switch off → multi-pick straight NOT parked', cardOffAfter.review_status !== 'needs_review');
  ok('kill-switch off → no multi-pick drop', cardOffAfter.drop_reason !== 'GRADE_MANUAL_REVIEW_MULTIPICK');
  // Sanity: the description still IS a multi-pick — proving only the flag suppressed the divert.
  ok('kill-switch control description is genuinely multi-pick', looksLikeMultiPickStraight('Rockets -3.5, Cavaliers -3.5, Wizards +7.5') === true);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\nmultipick-straight-guard: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
