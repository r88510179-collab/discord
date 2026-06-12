// gradeFromCelebration() must NOT grade review-queue bets.
//
// Its candidate pool was the ONE auto-grade path that bypassed the PR #89
// shield: getPendingBets excludes review_status='needs_review' (the design
// contract says review-queue bets are invisible to "every auto-void path
// until approveBet() confirms them"), but the celebration pool selected
// review_status IN ('confirmed','needs_review') and graded matches with
// allowAutoConfirm=true. Consequences:
//   (a) a bet parked in needs_review — including bets parked by /admin
//       revert-by-id (PR #93), typically with a WRONG sport/description
//       awaiting human Edit — could be fuzzy-matched (any shared >=3-char
//       word) against a same-capper celebration, graded win/loss,
//       bankroll-updated, and auto-confirmed before any human repair;
//   (b) the pending_legs denial path (scheduleRecheckAfterDenial) could
//       retry-cap-void a needs_review bet, leaving result='void' with
//       review_status still 'needs_review' — the row shape behind the
//       2026-06-12 bet 453e0952 false-success incident.
//
// Companion to tests/grader-skips-needs-review-validation.js (PR #89) and
// tests/revert-hardening-validation.js (PR #93).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-celebration-skip-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.WAR_ROOM_CHANNEL_ID; // keep the notification block inert

const database = require('../services/database');
const { gradeFromCelebration } = require('../services/grading');

const CAPPER_ID = database.getOrCreateCapper('celebration_skip_test_user', 'Celebration Skip Tester', null).id;

function makeBet(description, reviewStatus) {
  return database.createBet({
    capper_id: CAPPER_ID,
    sport: 'NBA',
    bet_type: 'straight',
    description,
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: reviewStatus,
    raw_text: description,
  });
}

function fullRow(betId) {
  return database.db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
}

async function run() {
  // ── TEST 1: needs_review bet + matching celebration → untouched ──────────
  const parkedBet = makeBet('Lakers ML tonight', 'needs_review');
  const parkedBefore = JSON.stringify(fullRow(parkedBet.id));

  const skipResult = await gradeFromCelebration(null, CAPPER_ID, 'win', ['Lakers']);
  assert.strictEqual(skipResult, null,
    'celebration must NOT grade a needs_review bet — the review queue is invisible to every auto-grade path until Approve');
  const parkedAfter = fullRow(parkedBet.id);
  assert.strictEqual(JSON.stringify(parkedAfter), parkedBefore,
    'needs_review bet must be byte-identical after a matching celebration (no grade, no confirm, no attempts/backoff pressure)');
  assert.strictEqual(parkedAfter.result, 'pending', 'result stays pending');
  assert.strictEqual(parkedAfter.review_status, 'needs_review', 'review_status must NOT flip to confirmed');
  assert.strictEqual(parkedAfter.graded_at, null, 'no graded_at stamp');
  console.log('  ✓ needs_review bet + matching celebration → null, row untouched');

  // ── TEST 2: older needs_review bet must not shadow-grade before a newer
  //            confirmed one ───────────────────────────────────────────────
  // The pool is ORDER BY created_at ASC (oldest first). Pre-fix, the OLDER
  // needs_review bet matched first and got graded + auto-confirmed; the
  // confirmed bet a human actually vetted was skipped.
  database.db.prepare("UPDATE bets SET created_at = datetime('now', '-2 days') WHERE id = ?").run(parkedBet.id);
  const confirmedBet = makeBet('Lakers -4.5 spread', 'confirmed');

  const graded = await gradeFromCelebration(null, CAPPER_ID, 'win', ['Lakers']);
  assert.ok(graded, 'celebration must still grade the confirmed bet (regression control)');
  assert.strictEqual(graded.bet.id, confirmedBet.id,
    'the CONFIRMED bet must be the one graded, not the older parked needs_review bet');
  const confirmedRow = fullRow(confirmedBet.id);
  assert.strictEqual(confirmedRow.result, 'win', 'confirmed bet graded win');
  assert.ok(confirmedRow.graded_at, 'confirmed bet has graded_at');
  assert.strictEqual(confirmedRow.review_status, 'confirmed', 'confirmed bet stays confirmed');
  const parkedFinal = fullRow(parkedBet.id);
  assert.strictEqual(parkedFinal.result, 'pending', 'parked bet still pending after the celebration graded its sibling');
  assert.strictEqual(parkedFinal.review_status, 'needs_review', 'parked bet still needs_review');
  console.log('  ✓ celebration grades the confirmed sibling; the older parked bet stays pending + needs_review');

  // ── TEST 3: pool empty when the capper has ONLY needs_review bets ────────
  const soloCapper = database.getOrCreateCapper('celebration_skip_solo', 'Celebration Solo Tester', null).id;
  const soloBet = database.createBet({
    capper_id: soloCapper,
    sport: 'NBA',
    bet_type: 'straight',
    description: 'Celtics ML parlay leg',
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: 'needs_review',
    raw_text: 'Celtics ML parlay leg',
  });
  const soloResult = await gradeFromCelebration(null, soloCapper, 'loss', ['Celtics']);
  assert.strictEqual(soloResult, null, 'capper with only needs_review bets → celebration finds nothing');
  const soloRow = fullRow(soloBet.id);
  assert.strictEqual(soloRow.grading_next_attempt_at, null,
    'no scheduleRecheckAfterDenial backoff pressure on a parked bet — the retry-cap-void factory (453e0952 shape) is closed');
  assert.strictEqual(soloRow.grading_attempts, 0, 'no attempts accrued');
  console.log('  ✓ only-needs_review capper → null; no backoff/retry-cap pressure on parked bets');

  console.log('Celebration skips needs_review validation passed.');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    database.db.close();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  });
