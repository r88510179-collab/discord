const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-review-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const database = require('../services/database');

function run() {
  const capper = database.getOrCreateCapper('review_test_user', 'Review Tester', null);

  // ── Insert a needs_review bet ────────────────────────────
  const reviewBet = database.createBet({
    capper_id: capper.id,
    sport: 'NBA',
    bet_type: 'straight',
    description: 'Ambiguous Lakers pick',
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: 'needs_review',
    raw_text: 'maybe lakers tonight',
  });
  assert.ok(reviewBet.id, 'Review bet should be created');

  // ── Insert a confirmed bet (should NOT appear in review queue) ──
  const confirmedBet = database.createBet({
    capper_id: capper.id,
    sport: 'NFL',
    bet_type: 'straight',
    description: 'Chiefs -7 lock',
    odds: -115,
    units: 2,
    source: 'discord',
    review_status: 'confirmed',
    raw_text: 'Chiefs -7 -115 2u lock',
  });

  // ── TEST 1: getPendingReviews returns only needs_review bets ──
  const pending = database.getPendingReviews();
  assert.ok(pending.length >= 1, 'Should have at least 1 pending review');
  assert.ok(pending.every(b => b.review_status === 'needs_review'),
    'getPendingReviews should only return needs_review bets');
  assert.ok(pending.some(b => b.id === reviewBet.id),
    'Review bet should be in pending reviews');
  assert.ok(!pending.some(b => b.id === confirmedBet.id),
    'Confirmed bet should NOT be in pending reviews');
  // Verify capper_name is joined
  const reviewRow = pending.find(b => b.id === reviewBet.id);
  assert.strictEqual(reviewRow.capper_name, 'Review Tester',
    'getPendingReviews should join capper display_name');
  console.log('  ✓ getPendingReviews returns only needs_review bets with capper info');

  // ── TEST 2: approveBet changes status to confirmed ────────
  const approved = database.approveBet(reviewBet.id);
  assert.ok(approved, 'approveBet should return the updated bet');
  assert.strictEqual(approved.review_status, 'confirmed',
    'Approved bet should have confirmed status');
  assert.strictEqual(approved.capper_name, 'Review Tester',
    'Approved bet should include capper_name');

  // After approval, review queue should be empty for this bet
  const afterApprove = database.getPendingReviews();
  assert.ok(!afterApprove.some(b => b.id === reviewBet.id),
    'Approved bet should no longer appear in review queue');
  console.log('  ✓ approveBet correctly updates status and returns bet with capper info');

  // ── TEST 3: approveBet on non-existent ID returns null ────
  const bogus = database.approveBet('nonexistent_id_12345');
  assert.strictEqual(bogus, null, 'approveBet with bad ID should return null');
  console.log('  ✓ approveBet returns null for non-existent bet');

  // ── TEST 4: approveBet on already-confirmed bet returns null ──
  const reapprove = database.approveBet(reviewBet.id);
  assert.strictEqual(reapprove, null,
    'approveBet on already-confirmed bet should return null (no-op)');
  console.log('  ✓ approveBet is idempotent — no-op on already confirmed bets');

  // ── TEST 5: rejectBet deletes the bet ─────────────────────
  const rejectTarget = database.createBet({
    capper_id: capper.id,
    sport: 'Unknown',
    bet_type: 'straight',
    description: 'Very ambiguous text',
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: 'needs_review',
    raw_text: 'idk something',
  });
  const rejected = database.rejectBet(rejectTarget.id);
  assert.strictEqual(rejected, true, 'rejectBet should return true on success');

  // Bet should be gone from database entirely
  const gone = database.db.prepare('SELECT * FROM bets WHERE id = ?').get(rejectTarget.id);
  assert.strictEqual(gone, undefined, 'Rejected bet should be deleted from database');
  console.log('  ✓ rejectBet deletes the bet from the database');

  // ── TEST 6: rejectBet on non-existent ID returns false ────
  const bogusReject = database.rejectBet('nonexistent_id_12345');
  assert.strictEqual(bogusReject, false, 'rejectBet with bad ID should return false');
  console.log('  ✓ rejectBet returns false for non-existent bet');

  // ── TEST 7: rejectBet cannot delete confirmed bets ────────
  const safeReject = database.rejectBet(confirmedBet.id);
  assert.strictEqual(safeReject, false,
    'rejectBet should not delete confirmed bets');
  const stillThere = database.db.prepare('SELECT * FROM bets WHERE id = ?').get(confirmedBet.id);
  assert.ok(stillThere, 'Confirmed bet should still exist after reject attempt');
  console.log('  ✓ rejectBet cannot delete confirmed bets (safety guard)');

  console.log('Review commands validation passed.');
}

try {
  run();
} finally {
  database.db.close();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
}
