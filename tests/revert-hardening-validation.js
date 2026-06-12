// /admin revert-by-id + approveBet hardening (incident 2026-06-12).
//
// Incident 1 (bet 45cef7b2): /admin revert-by-id reset result + grading state
// but LEFT review_status='auto_void_unscoped_bet'. getPendingBets (PR #89)
// shields only 'needs_review', so the grader re-claimed the reverted bet
// while sport was still Unknown and the unscoped auto-void re-voided it
// before a human could Edit the sport. revertBetToPending now parks every
// revert in the protected review queue (review_status='needs_review').
//
// Incident 2 (bet 453e0952): war-room Approve reported success on a bet whose
// result was no longer 'pending' (the retry-cap void writes result='void'
// without touching review_status, so 'needs_review' survives): the confirm
// UPDATE matched, then the result-gated clean-slate reset matched 0 rows and
// was silently swallowed — confirmed, no reset, no grace stamp. approveBet is
// now ONE atomic UPDATE gated on review_status='needs_review' AND
// result='pending'; a gate mismatch returns null and writes NOTHING.
//
// Companion to tests/grader-skips-needs-review-validation.js (PR #89) and
// tests/approve-resets-grading-state-validation.js (PR #92).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-revert-hardening-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const database = require('../services/database');

const CAPPER_ID = database.getOrCreateCapper('revert_hardening_test_user', 'Revert Hardening Tester', null).id;

function makeBet(description, reviewStatus) {
  return database.createBet({
    capper_id: CAPPER_ID,
    sport: 'Unknown',
    bet_type: 'straight',
    description,
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: reviewStatus,
    raw_text: description,
  });
}

function selectedIds() {
  return new Set(database.getPendingBets().map(b => b.id));
}

function fullRow(betId) {
  return database.db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
}

// Mirror of the unscoped-sport auto-void write (services/grading.js).
function unscopedAutoVoid(betId) {
  database.db.prepare(`UPDATE bets SET
    result = 'void', profit_units = 0, graded_at = datetime('now'),
    grade = 'VOID', grade_reason = 'Auto-voided: sport=Unknown not in supported set',
    review_status = 'auto_void_unscoped_bet',
    grading_state = 'done', grading_lock_until = NULL
    WHERE id = ? AND (result = 'pending' OR result IS NULL)`).run(betId);
}

function run() {
  // ── TEST 1: revert lands the bet in the protected review queue ───────────
  const incidentBet = makeBet('Unscoped incident pick', 'confirmed');
  unscopedAutoVoid(incidentBet.id);
  assert.strictEqual(fullRow(incidentBet.id).review_status, 'auto_void_unscoped_bet',
    'precondition: bet carries the terminal auto-void label');

  const reverted = database.revertBetToPending(incidentBet.id, 'REVERTED manually via /admin revert-by-id');
  assert.strictEqual(reverted, true, 'revert reports a row change');
  let row = fullRow(incidentBet.id);
  assert.strictEqual(row.result, 'pending', 'revert resets result to pending');
  assert.strictEqual(row.review_status, 'needs_review',
    'revert must replace the terminal auto_void label with needs_review');
  assert.strictEqual(row.graded_at, null, 'revert clears graded_at');
  assert.strictEqual(row.grading_state, 'ready', 'revert resets grading_state');
  assert.strictEqual(row.grading_attempts, 0, 'revert resets attempts');
  assert.ok(!selectedIds().has(incidentBet.id),
    'reverted bet must be INVISIBLE to getPendingBets until a human approves — the 45cef7b2 re-void race');
  console.log('  ✓ revert → needs_review; getPendingBets does NOT select it (grader cannot re-void)');

  // ── TEST 2: Approve after revert re-arms grading with the clean slate ────
  const approved = database.approveBet(incidentBet.id);
  assert.ok(approved, 'post-revert Approve succeeds (needs_review + result=pending)');
  row = fullRow(incidentBet.id);
  assert.strictEqual(row.review_status, 'confirmed', 'Approve confirms');
  assert.strictEqual(row.grading_state, 'ready', 'Approve leaves the bet ready');
  assert.ok(row.sweep_exempt_until, 'Approve stamps the 3-day sweep grace');
  assert.ok(selectedIds().has(incidentBet.id), 'approved bet re-enters the grader queue');
  console.log('  ✓ revert → Approve → confirmed + grace stamp + grader-visible (protected flow round trip)');

  // ── TEST 3: approveBet on an auto_void-labeled bet → null, zero writes ───
  // The 45cef7b2 war-room Approve: pending again after an old-code revert,
  // label still auto_void_unscoped_bet.
  const labeledBet = makeBet('Auto-void labeled pending pick', 'confirmed');
  unscopedAutoVoid(labeledBet.id);
  database.db.prepare(`UPDATE bets SET
    result = 'pending', profit_units = NULL, graded_at = NULL, grade = NULL,
    review_status = 'auto_void_unscoped_bet', grading_state = 'ready', grading_attempts = 0
    WHERE id = ?`).run(labeledBet.id);
  const labeledBefore = JSON.stringify(fullRow(labeledBet.id));
  assert.strictEqual(database.approveBet(labeledBet.id), null,
    'approveBet must return null for review_status=auto_void_unscoped_bet');
  assert.strictEqual(JSON.stringify(fullRow(labeledBet.id)), labeledBefore,
    'approveBet must write NOTHING on refusal');
  console.log('  ✓ approveBet(auto_void_unscoped_bet) → null, row untouched');

  // ── TEST 4: the swallowed-reset false success is dead ────────────────────
  // The 453e0952 shape: retry-cap void leaves result='void' with
  // review_status still 'needs_review'.
  const capVoidBet = makeBet('Retry-cap voided review pick', 'needs_review');
  // Mirror of the retry-cap void write (services/grading.js, scheduleRecheckAfterDenial).
  database.db.prepare(`UPDATE bets SET
    grading_state = 'backoff',
    grading_next_attempt_at = datetime('now', '+24 hours'),
    grading_last_failure_reason = 'celebration_pending_legs_capped',
    grading_lock_until = NULL,
    result = 'void', grade = 'VOID',
    grade_reason = 'Auto-voided after retry cap exhausted (no evidence found after 15+ attempts).',
    graded_at = CURRENT_TIMESTAMP
    WHERE id = ? AND result = 'pending'`).run(capVoidBet.id);
  assert.strictEqual(fullRow(capVoidBet.id).result, 'void', 'precondition: retry-cap void landed');
  const capBefore = JSON.stringify(fullRow(capVoidBet.id));
  assert.strictEqual(database.approveBet(capVoidBet.id), null,
    'approveBet must REFUSE a needs_review bet whose result is no longer pending — confirming it while the reset swallows is the 453e0952 false success');
  const capAfter = fullRow(capVoidBet.id);
  assert.strictEqual(JSON.stringify(capAfter), capBefore, 'refusal writes nothing');
  assert.strictEqual(capAfter.review_status, 'needs_review', 'review_status must NOT flip to confirmed');
  assert.strictEqual(capAfter.sweep_exempt_until, null, 'no grace stamp on refusal');
  console.log('  ✓ needs_review + result=void → approveBet null, no confirm leak, no stamp (swallowed-reset path dead)');

  console.log('Revert hardening validation passed.');
}

try {
  run();
} finally {
  database.db.close();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
}
