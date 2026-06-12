// approveBet() must hand the grader a CLEAN-SLATE bet.
//
// Legacy damage: before 2026-06-12 the AutoGrader claimed review_status=
// 'needs_review' bets, accruing grading_attempts (and grading_state=
// 'quarantined' at attempts>=20 via applyBackoff, services/grading.js). The
// old approveBet reset grading_state only WHERE grading_state='done', so a
// damaged bet either (a) stayed invisible forever after Approve (quarantined
// is not in getPendingBets' IN ('ready','backoff')), or (b) was insta-voided
// right after approval by scheduleRecheckAfterDenial's RETRY_CAP=15 /
// shouldAutoVoidNoData's MIN_ATTEMPTS=5 firing on carried-over attempts.
// Separately, a bet older than SWEEP_DAYS=7 at approval time (review-queue
// dwell or a recovered bet's backdated created_at) would be 7-day-swept to a
// FALSE loss in its first visible cycle — approveBet now stamps the same
// 3-day sweep grace recoverHold uses, measured from the approval moment.
//
// Mirrors tests/grader-skips-needs-review-validation.js (PR #89 companion).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-approve-reset-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const database = require('../services/database');
const { _internal } = require('../services/grading');
const { evaluateSweep } = _internal;

function selectedIds() {
  return new Set(database.getPendingBets().map(b => b.id));
}

function stampGradingState(betId, fields) {
  database.db.prepare(`UPDATE bets SET
    grading_state = ?,
    grading_attempts = ?,
    grading_lock_until = ?,
    grading_next_attempt_at = ?,
    grading_last_failure_reason = ?
    WHERE id = ?`).run(
    fields.state, fields.attempts, fields.lock || null,
    fields.nextAttempt || null, fields.failure || null, betId,
  );
}

function gradingRow(betId) {
  return database.db.prepare(`SELECT result, review_status, grading_state,
    grading_attempts, grading_lock_until, grading_next_attempt_at,
    grading_last_failure_reason, sweep_exempt_until
    FROM bets WHERE id = ?`).get(betId);
}

function makeNeedsReviewBet(description) {
  return database.createBet({
    capper_id: CAPPER_ID,
    sport: 'NBA',
    bet_type: 'straight',
    description,
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: 'needs_review',
    raw_text: description,
  });
}

const CAPPER_ID = database.getOrCreateCapper('approve_reset_test_user', 'Approve Reset Tester', null).id;

function run() {
  // ── TEST 1: quarantined legacy bet becomes gradeable on Approve ──────────
  const quarantinedBet = makeNeedsReviewBet('Quarantined legacy pick');
  stampGradingState(quarantinedBet.id, {
    state: 'quarantined',
    attempts: 20,
    nextAttempt: "2030-01-01 00:00:00",
    failure: 'no_result_capped',
  });
  assert.ok(!selectedIds().has(quarantinedBet.id),
    'quarantined bet must be invisible to the grader before approval');

  const approved = database.approveBet(quarantinedBet.id);
  assert.ok(approved, 'approveBet should succeed');
  assert.strictEqual(approved.review_status, 'confirmed', 'bet should be confirmed');

  let row = gradingRow(quarantinedBet.id);
  assert.strictEqual(row.grading_state, 'ready', 'quarantined → ready on approval');
  assert.strictEqual(row.grading_attempts, 0, 'attempts reset to 0 on approval');
  assert.strictEqual(row.grading_lock_until, null, 'lock cleared on approval');
  assert.strictEqual(row.grading_next_attempt_at, null, 'backoff schedule cleared on approval');
  assert.strictEqual(row.grading_last_failure_reason, null, 'failure reason cleared on approval');
  assert.ok(selectedIds().has(quarantinedBet.id),
    'approved bet must be selectable by getPendingBets');
  console.log('  ✓ quarantined legacy bet (attempts=20) becomes selectable with attempts=0 after Approve');

  // ── TEST 2: carried-over attempts can no longer insta-void post-approval ─
  const backoffBet = makeNeedsReviewBet('Backoff legacy pick');
  stampGradingState(backoffBet.id, {
    state: 'backoff',
    attempts: 15, // == scheduleRecheckAfterDenial RETRY_CAP, > shouldAutoVoidNoData MIN_ATTEMPTS
    nextAttempt: "2030-01-01 00:00:00",
    failure: 'ai_pending',
  });
  database.approveBet(backoffBet.id);
  row = gradingRow(backoffBet.id);
  assert.strictEqual(row.grading_attempts, 0,
    'carried-over attempts (>= RETRY_CAP 15 / MIN_ATTEMPTS 5) must reset so void thresholds cannot fire on pre-approval history');
  assert.ok(selectedIds().has(backoffBet.id),
    'approved backoff bet must be selectable immediately (next_attempt cleared)');
  console.log('  ✓ backoff bet with attempts=15 resets to 0 — retry-cap/no-data thresholds cannot fire on approval');

  // ── TEST 3: sweep grace stamped from the approval moment ─────────────────
  // Simulate a bet that dwelled in the review queue past SWEEP_DAYS=7 (same
  // shape as a recovered bet's backdated created_at).
  const oldBet = makeNeedsReviewBet('Old review-queue dweller');
  database.db.prepare("UPDATE bets SET created_at = datetime('now', '-10 days') WHERE id = ?").run(oldBet.id);
  database.approveBet(oldBet.id);
  row = gradingRow(oldBet.id);
  assert.ok(row.sweep_exempt_until, 'approval must stamp sweep_exempt_until');
  const windowOk = database.db.prepare(
    "SELECT datetime('now') < ? AND ? <= datetime('now', '+3 days') AS ok",
  ).pluck().get(row.sweep_exempt_until, row.sweep_exempt_until);
  assert.strictEqual(windowOk, 1, 'grace window must be (now, now+3d] measured from approval');
  const oldRow = database.db.prepare('SELECT * FROM bets WHERE id = ?').get(oldBet.id);
  const verdict = evaluateSweep(oldRow);
  assert.strictEqual(verdict.eligible, false,
    'a >7-day-old bet must NOT be sweep-eligible in its first post-approval cycle');
  assert.strictEqual(verdict.reason, 'grace', 'sweep skip must come from the grace window');
  console.log('  ✓ >7-day-old bet approved → sweep grace stamped, evaluateSweep says grace not eligible');

  // ── TEST 4: finalized bets are not resurrected ────────────────────────────
  const voidBet = makeNeedsReviewBet('Already voided pick');
  database.db.prepare("UPDATE bets SET result = 'void', grading_state = 'done' WHERE id = ?").run(voidBet.id);
  const voidApproved = database.approveBet(voidBet.id);
  assert.strictEqual(voidApproved, null,
    'approveBet must REFUSE (null) a bet whose result is no longer pending — a success here is the 453e0952 false-success');
  row = gradingRow(voidBet.id);
  assert.strictEqual(row.review_status, 'needs_review',
    'refused bet must keep needs_review — no confirm without the clean-slate reset');
  assert.strictEqual(row.result, 'void', 'result must stay void');
  assert.strictEqual(row.grading_state, 'done', 'grading_state must stay done for finalized bets');
  assert.strictEqual(row.sweep_exempt_until, null, 'no grace stamp on finalized bets');
  assert.ok(!selectedIds().has(voidBet.id), 'finalized bet must not re-enter the grader queue');
  console.log('  ✓ approveBet on a finalized bet refuses (null) and writes nothing (atomic result=pending gate)');

  // ── TEST 5: normal fresh-bet path unchanged ──────────────────────────────
  const freshBet = makeNeedsReviewBet('Fresh normal pick');
  const freshApproved = database.approveBet(freshBet.id);
  assert.strictEqual(freshApproved.review_status, 'confirmed', 'fresh bet confirms');
  row = gradingRow(freshBet.id);
  assert.strictEqual(row.grading_state, 'ready', 'fresh bet ready');
  assert.strictEqual(row.grading_attempts, 0, 'fresh bet attempts 0');
  assert.ok(selectedIds().has(freshBet.id), 'fresh approved bet selectable');
  console.log('  ✓ fresh needs_review bet approves and grades as before (regression control)');

  console.log('Approve resets grading state validation passed.');
}

try {
  run();
} finally {
  database.db.close();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
}
