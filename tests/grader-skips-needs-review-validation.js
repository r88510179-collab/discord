// PR A — grader candidate selection must skip bets in the human review queue.
//
// Incident (2026-06-12): bet 453e0952… ("Bosnia +.5", review_status='needs_review',
// war-room embed posted) was auto-voided 10 minutes later by the grading path
// (sport=Unknown unscoped void), flipping review_status to 'auto_void_unscoped_bet'
// and staling the war-room Approve buttons.
//
// Contract under test: getPendingBets() — the single candidate query feeding
// runAutoGrade (per-bet grading, the unscoped-sport void, the no-data void,
// the retry-cap void, and the 7-day sweeper) — must never return a
// review_status='needs_review' bet, in BOTH the state-machine query and the
// GRADING_STATE_MACHINE_ENABLED=false kill-switch path. NULL review_status
// stays selectable (legacy rows). approveBet() makes the bet selectable again.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-grader-skip-review-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const database = require('../services/database');

function selectedIds() {
  return new Set(database.getPendingBets().map(b => b.id));
}

function run() {
  const capper = database.getOrCreateCapper('grader_skip_test_user', 'Grader Skip Tester', null);

  // ── Fixtures: one needs_review, one confirmed, one legacy NULL ───────────
  const reviewBet = database.createBet({
    capper_id: capper.id,
    sport: 'Unknown',
    bet_type: 'straight',
    description: 'Bosnia +.5',
    odds: -110,
    units: 1,
    source: 'discord',
    review_status: 'needs_review',
    raw_text: 'GNP Bosnia +.5',
  });
  assert.ok(reviewBet.id, 'needs_review bet should be created');

  const confirmedBet = database.createBet({
    capper_id: capper.id,
    sport: 'NHL',
    bet_type: 'straight',
    description: 'Vegas / Carolina over 6.5',
    odds: -115,
    units: 1,
    source: 'discord',
    review_status: 'confirmed',
    raw_text: 'Vegas / Carolina over 6.5',
  });
  assert.ok(confirmedBet.id, 'confirmed bet should be created');

  const legacyNullBet = database.createBet({
    capper_id: capper.id,
    sport: 'NBA',
    bet_type: 'straight',
    description: 'Lakers ML legacy row',
    odds: -120,
    units: 1,
    source: 'discord',
    review_status: 'confirmed',
    raw_text: 'Lakers ML legacy',
  });
  // Simulate a legacy row that predates review_status (schema default bypassed).
  database.db.prepare('UPDATE bets SET review_status = NULL WHERE id = ?').run(legacyNullBet.id);

  // ── TEST 1: state-machine selector excludes only needs_review ────────────
  let ids = selectedIds();
  assert.ok(ids.has(confirmedBet.id),
    'confirmed bet must be selectable by the grader (positive control)');
  assert.ok(ids.has(legacyNullBet.id),
    'NULL review_status bet must stay selectable (NULL-safe predicate)');
  assert.ok(!ids.has(reviewBet.id),
    'needs_review bet must be invisible to the grader candidate query');
  assert.ok(database.getPendingBets().every(b => b.review_status !== 'needs_review'),
    'no needs_review bet may appear in grader selection');
  console.log('  ✓ state-machine selector returns confirmed + NULL rows, never needs_review');

  // ── TEST 2: kill-switch path applies the same exclusion ──────────────────
  process.env.GRADING_STATE_MACHINE_ENABLED = 'false';
  try {
    ids = selectedIds();
    assert.ok(ids.has(confirmedBet.id),
      'kill-switch path: confirmed bet must be selectable');
    assert.ok(ids.has(legacyNullBet.id),
      'kill-switch path: NULL review_status bet must stay selectable');
    assert.ok(!ids.has(reviewBet.id),
      'kill-switch path: needs_review bet must be invisible to the grader');
  } finally {
    delete process.env.GRADING_STATE_MACHINE_ENABLED;
  }
  console.log('  ✓ GRADING_STATE_MACHINE_ENABLED=false kill-switch path excludes needs_review too');

  // ── TEST 3: getAllPendingBets (dashboards/admin) is unchanged ────────────
  const broad = new Set(database.getAllPendingBets().map(b => b.id));
  assert.ok(broad.has(reviewBet.id),
    'getAllPendingBets must still include needs_review bets (dashboards unchanged)');
  console.log('  ✓ getAllPendingBets broad selector still sees the needs_review bet');

  // ── TEST 4: approveBet makes the bet selectable again ────────────────────
  const approved = database.approveBet(reviewBet.id);
  assert.ok(approved, 'approveBet should succeed on the needs_review bet');
  assert.strictEqual(approved.review_status, 'confirmed',
    'approved bet should be confirmed');
  ids = selectedIds();
  assert.ok(ids.has(reviewBet.id),
    'after approveBet() the bet must become selectable by the grader');
  console.log('  ✓ approveBet() returns the bet to the grader queue');

  console.log('Grader skips needs_review validation passed.');
}

try {
  run();
} finally {
  database.db.close();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
}
