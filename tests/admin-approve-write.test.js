// ═══════════════════════════════════════════════════════════
// Admin bet-approve WRITE-route tests (dashboard release path).
//
// Exercises routes/adminCommands.handleApproveRoute directly with a mock
// req/res (the repo has no HTTP/supertest harness, mirroring
// tests/hold-dismiss.test.js + tests/admin-handles-write.test.js). The route
// releases a needs_review bet by calling the EXACT atomic approveBet() the
// /admin approve-by-id slash command uses — no parallel write path.
//
// Uses the standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds a fresh bets table we seed via
// createBet (needs_review/pending) and read back.
//
// Status contract under test:
//   truthy row → 200 { ok:true,  status:'approved',       bet }
//   null       → 409 { ok:false, status:'not_approvable', error }
//   empty id   → 400 { ok:false, status:'malformed',      error }
//   throw      → 500 { ok:false, status:'error',          error }
//
// Run:  node tests/admin-approve-write.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `admin-approve-write-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const database = require('../services/database');
const { db } = database;
const adminCommands = require('../routes/adminCommands');
const { handleApproveRoute } = adminCommands;

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

// ── seed / read helpers ──────────────────────────────────────
const CAPPER_ID = database.getOrCreateCapper('approve_ep_test_user', 'Approve EP Tester', null).id;

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
function betRow(id) {
  return db.prepare('SELECT id, review_status, result, grading_state, grading_attempts FROM bets WHERE id = ?').get(id);
}
function countConfirmed() {
  return db.prepare("SELECT COUNT(*) AS c FROM bets WHERE review_status = 'confirmed'").get().c;
}
function mockRes() {
  return {
    _code: null,
    _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}
function call(id) {
  const res = mockRes();
  handleApproveRoute({ params: { id } }, res);
  return res;
}

// ── (a) valid needs_review/pending bet → 200 approved, approveBet ran ────────
run('valid needs_review/pending bet → 200 approved, DB row confirmed + clean-slate reset', () => {
  const bet = makeNeedsReviewBet('Releasable pick');
  // Dirty the grading state FIRST so the post-approve assertions actually PROVE
  // approveBet's atomic clean-slate reset ran through the route. createBet
  // already defaults a pending bet's grading_state to 'ready' (database.js
  // ~L395), so asserting 'ready' on a fresh bet would pass even if approveBet
  // never touched the column. quarantined/attempts=20 can only have been
  // cleared by approveBet.
  db.prepare("UPDATE bets SET grading_state = 'quarantined', grading_attempts = 20, grading_last_failure_reason = 'no_result_capped' WHERE id = ?").run(bet.id);
  assert.strictEqual(betRow(bet.id).review_status, 'needs_review', 'precondition: needs_review');
  assert.strictEqual(betRow(bet.id).result, 'pending', 'precondition: result pending');
  assert.strictEqual(betRow(bet.id).grading_state, 'quarantined', 'precondition: grading state dirtied');

  const res = call(bet.id);
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.ok, true);
  assert.strictEqual(res._json.status, 'approved');
  assert.ok(res._json.bet, 'the confirmed bet row is returned in the body');
  assert.strictEqual(res._json.bet.id, bet.id, 'returned row is the approved bet');
  assert.strictEqual(res._json.bet.review_status, 'confirmed', 'returned row is confirmed');

  // approveBet actually ran: atomic confirm + clean-slate reset observable in DB.
  const row = betRow(bet.id);
  assert.strictEqual(row.review_status, 'confirmed', 'DB row is confirmed');
  assert.strictEqual(row.grading_state, 'ready', 'quarantined → ready (clean-slate reset ran via the route)');
  assert.strictEqual(row.grading_attempts, 0, 'attempts 20 → 0 (clean-slate reset ran via the route)');
});

// ── (a') id is trimmed before the exact match ────────────────────────────────
run('surrounding whitespace is trimmed → exact-id match still approves', () => {
  const bet = makeNeedsReviewBet('Whitespace-wrapped id pick');
  const res = call(`  ${bet.id}  `);
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.status, 'approved');
  assert.strictEqual(betRow(bet.id).review_status, 'confirmed');
});

// ── (b) approveBet returns null → 409 not_approvable, zero writes ────────────
run('missing id (no such bet) → 409 not_approvable, nothing confirmed', () => {
  const before = countConfirmed();
  const res = call('nonexistent_bet_id_12345');
  assert.strictEqual(res._code, 409);
  assert.strictEqual(res._json.ok, false);
  assert.strictEqual(res._json.status, 'not_approvable');
  assert.ok(/revert-by-id/.test(res._json.error), 'error names the revert-by-id remedy');
  assert.strictEqual(countConfirmed(), before, 'a missing bet confirms nothing (zero writes)');
});

run('terminal needs_review bet (result=void) → 409 not_approvable, row untouched', () => {
  // The 453e0952 shape: review_status='needs_review' but result no longer
  // 'pending'. approveBet's atomic gate REFUSES → null → 409, zero writes.
  const bet = makeNeedsReviewBet('Terminal void pick');
  db.prepare("UPDATE bets SET result = 'void', grading_state = 'done' WHERE id = ?").run(bet.id);
  const before = countConfirmed();

  const res = call(bet.id);
  assert.strictEqual(res._code, 409);
  assert.strictEqual(res._json.status, 'not_approvable');

  const row = betRow(bet.id);
  assert.strictEqual(row.review_status, 'needs_review', 'review_status untouched on refusal');
  assert.strictEqual(row.result, 'void', 'result untouched on refusal');
  assert.strictEqual(row.grading_state, 'done', 'grading_state untouched on refusal');
  assert.strictEqual(countConfirmed(), before, 'refusal writes nothing');
});

run('already-confirmed bet → 409 not_approvable (idempotent, no re-confirm)', () => {
  const bet = makeNeedsReviewBet('Double-approve pick');
  const first = call(bet.id);
  assert.strictEqual(first._code, 200, 'first approve succeeds');
  const second = call(bet.id);
  assert.strictEqual(second._code, 409, 'second approve refuses (no longer needs_review)');
  assert.strictEqual(second._json.status, 'not_approvable');
});

// ── (c) missing/empty id → 400 malformed, approveBet never reached ───────────
run('empty string id → 400 malformed', () => {
  const res = call('');
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.ok, false);
  assert.strictEqual(res._json.status, 'malformed');
});

run('whitespace-only id → 400 malformed', () => {
  const res = call('   ');
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});

run('missing id param → 400 malformed', () => {
  const res = mockRes();
  handleApproveRoute({ params: {} }, res);
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});

run('a malformed request confirms nothing (approveBet never reached)', () => {
  const before = countConfirmed();
  call('   ');
  assert.strictEqual(countConfirmed(), before, 'no bet confirmed by a malformed request');
});

// ── (d) approveBet throws → 500 internal ─────────────────────────────────────
run('approveBet throws → 500 error', () => {
  // The handler lazy-requires { approveBet } from ../services/database inside
  // the try, so swapping the live export injects the throw (mirrors how the
  // dismiss/recover handlers resolve their service at call time).
  const original = database.approveBet;
  database.approveBet = () => { throw new Error('boom'); };
  try {
    const res = call('any_id_value');
    assert.strictEqual(res._code, 500);
    assert.strictEqual(res._json.ok, false);
    assert.strictEqual(res._json.status, 'error');
  } finally {
    database.approveBet = original;
  }
});

run('handler recovers after a throw (restored approveBet still works)', () => {
  // Guards against the stub leaking past the finally restore above.
  const bet = makeNeedsReviewBet('Post-throw control pick');
  const res = call(bet.id);
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.status, 'approved');
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\nadmin-approve-write: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
