// /admin approve-by-id — explicit-id Approve for review-queue bets that have
// no clickable Approve surface.
//
// /review acts on `pending.slice(0, 25)` of getPendingReviews (newest first)
// and the war-room staging card may be long deleted, so a needs_review bet
// older than the 25 newest arrivals is unreachable from any UI. After PR #93,
// /admin revert-by-id parks reverted bets in needs_review and Approve is the
// ONLY way back into grading — a reverted 7-day-swept loss is >=7 days old by
// construction, sorts below a week of newer arrivals, and the repair flow
// silently stalls. approve-by-id mirrors revert-by-id (partial-id LIKE
// lookup, OWNER_ID gate) and calls the atomic approveBet (gated on
// review_status='needs_review' AND result='pending'; null + zero writes on
// mismatch). It deliberately does NOT post to #slip-feed.
//
// Companion to tests/revert-hardening-validation.js (PR #93).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-approve-by-id-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.OWNER_ID; // default: gate open; TEST 5 sets it explicitly

const database = require('../services/database');
const adminCommand = require('../commands/admin');

const CAPPER_ID = database.getOrCreateCapper('approve_by_id_test_user', 'Approve ById Tester', null).id;

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

function fakeInteraction(sub, opts, userId = '111') {
  const replies = [];
  return {
    options: {
      getSubcommand: () => sub,
      getString: (name) => (name in opts ? opts[name] : null),
    },
    user: { id: userId, displayName: 'Approve ById Tester' },
    client: null,
    reply: async (payload) => { replies.push(typeof payload === 'string' ? payload : payload.content); },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(typeof payload === 'string' ? payload : payload.content); },
    replies,
  };
}

async function approveById(betIdArg, userId) {
  const interaction = fakeInteraction('approve-by-id', { bet_id: betIdArg }, userId);
  await adminCommand.execute(interaction);
  return interaction.replies;
}

async function run() {
  // ── Seed: a parked incident bet buried below /review's top-25 ────────────
  // Shape: auto-voided long ago, then reverted (PR #93 parks it needs_review
  // with its ORIGINAL created_at), while 25+ newer needs_review bets arrived.
  const buriedBet = makeBet('Buried incident pick', 'confirmed');
  database.db.prepare(`UPDATE bets SET
    result = 'void', profit_units = 0, graded_at = datetime('now'),
    grade = 'VOID', grade_reason = 'Auto-voided: sport=Unknown not in supported set',
    review_status = 'auto_void_unscoped_bet', grading_state = 'done'
    WHERE id = ?`).run(buriedBet.id);
  database.revertBetToPending(buriedBet.id, 'REVERTED manually via /admin revert-by-id');
  database.db.prepare("UPDATE bets SET created_at = datetime('now', '-10 days') WHERE id = ?").run(buriedBet.id);

  for (let i = 0; i < 26; i++) makeBet(`Fresh review arrival ${i}`, 'needs_review');

  // ── TEST 1: the bet really is unreachable from /review's top-25 slice ────
  const top25 = database.getPendingReviews().slice(0, 25); // mirrors commands/review.js
  assert.ok(!top25.some(b => b.id === buriedBet.id),
    'precondition: buried bet must be absent from the 25-newest /review slice');
  assert.strictEqual(fullRow(buriedBet.id).review_status, 'needs_review',
    'precondition: buried bet is parked needs_review (PR #93 revert)');
  console.log('  ✓ precondition: parked bet is buried below the /review top-25 slice');

  // ── TEST 2: approve-by-id approves it via 8-char partial id ──────────────
  const replies = await approveById(buriedBet.id.slice(0, 8));
  assert.strictEqual(replies.length, 1, 'one reply');
  assert.ok(replies[0].startsWith('✅ Approved'), `success reply, got: ${replies[0]}`);
  const row = fullRow(buriedBet.id);
  assert.strictEqual(row.review_status, 'confirmed', 'bet confirmed');
  assert.strictEqual(row.grading_state, 'ready', 'clean slate: ready');
  assert.strictEqual(row.grading_attempts, 0, 'clean slate: attempts 0');
  assert.ok(row.sweep_exempt_until, '3-day sweep grace stamped (a 10-day-old bet would otherwise sweep to a false loss)');
  assert.ok(database.getPendingBets().some(b => b.id === buriedBet.id),
    'approved bet re-enters the grader queue');
  console.log('  ✓ approve-by-id (partial id) → confirmed + clean slate + grace stamp + grader-visible');

  // ── TEST 3: refusal triage — terminal bet gets revert-first guidance ─────
  const voidBet = makeBet('Still voided pick', 'needs_review');
  database.db.prepare("UPDATE bets SET result = 'void', grading_state = 'done' WHERE id = ?").run(voidBet.id);
  const voidBefore = JSON.stringify(fullRow(voidBet.id));
  const refusal = await approveById(voidBet.id.slice(0, 8));
  assert.ok(refusal[0].startsWith('🚫 Cannot approve'), `refusal reply, got: ${refusal[0]}`);
  assert.ok(refusal[0].includes('revert-by-id'), 'refusal must point the operator at /admin revert-by-id');
  assert.ok(refusal[0].includes('result=void'), 'refusal must state WHY (result=void)');
  assert.strictEqual(JSON.stringify(fullRow(voidBet.id)), voidBefore, 'refusal writes nothing');
  console.log('  ✓ terminal bet → refusal with why + revert-first guidance, zero writes');

  // ── TEST 4: unknown id ────────────────────────────────────────────────────
  const missing = await approveById('ffffffff');
  assert.ok(missing[0].startsWith('❌ No bet found'), `not-found reply, got: ${missing[0]}`);
  console.log('  ✓ unknown id → not-found reply');

  // ── TEST 5: OWNER_ID gate ─────────────────────────────────────────────────
  const gatedBet = makeBet('Owner-gated pick', 'needs_review');
  process.env.OWNER_ID = '999';
  try {
    const gated = await approveById(gatedBet.id.slice(0, 8), '111');
    assert.strictEqual(gated[0], '🚫', 'non-owner is refused');
    assert.strictEqual(fullRow(gatedBet.id).review_status, 'needs_review', 'no write on gate refusal');
  } finally {
    delete process.env.OWNER_ID;
  }
  console.log('  ✓ OWNER_ID gate refuses non-owner with zero writes');

  console.log('Admin approve-by-id validation passed.');
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
