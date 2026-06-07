// ═══════════════════════════════════════════════════════════
// Hold Dismiss core + admin API route tests (Phase 2b-1).
//
// Exercises the transport-agnostic core services/holdReview.dismissHold,
// the thin Discord wrapper (handleHoldInteraction → handleDismiss), and the
// admin write route handler routes/adminCommands.handleDismissRoute.
//
// Uses the standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds fresh pipeline_events +
// hold_review_decisions tables we can seed and read back.
//
// Run:  node tests/hold-dismiss.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `hold-dismiss-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
// The Discord wrapper's owner-gate reads OWNER_ID at call time; unset it so
// handleHoldInteraction routes through to handleDismiss in this test.
delete process.env.OWNER_ID;

const { recordStage } = require('../services/pipeline-events');
const { db } = require('../services/database');
const { dismissHold, handleHoldInteraction } = require('../services/holdReview');
const { handleDismissRoute } = require('../routes/adminCommands');

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

// ── seed / read helpers ──────────────────────────────────────
function seedHold(id, payload) {
  recordStage({
    ingestId: id,
    sourceType: 'discord',
    sourceRef: id.replace(/^disc_/, ''),
    stage: 'MANUAL_REVIEW_HOLD',
    eventType: 'STAGE_ENTER',
    payload: payload || { capper: 'Test', reason: 'is_bet=false', messageUrl: 'https://discord.com/channels/1/2/3' },
  });
}
function seedReleased(id) {
  recordStage({
    ingestId: id,
    sourceType: 'discord',
    sourceRef: id.replace(/^disc_/, ''),
    stage: 'MANUAL_REVIEW_RELEASED',
    eventType: 'STAGE_ENTER',
    payload: { released_by: 'someone', bet_id: 'bet_xyz' },
  });
}
function countDecisions(id) {
  return db.prepare('SELECT COUNT(*) AS c FROM hold_review_decisions WHERE ingest_id = ?').get(id).c;
}
function latestDecision(id) {
  return db.prepare('SELECT * FROM hold_review_decisions WHERE ingest_id = ? ORDER BY id DESC LIMIT 1').get(id);
}
function countStage(id, stage) {
  return db.prepare('SELECT COUNT(*) AS c FROM pipeline_events WHERE ingest_id = ? AND stage = ?').get(id, stage).c;
}
function mockRes() {
  return {
    _code: null,
    _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}

(async () => {
  // ── CORE: active hold dismisses once ──────────────────────
  await run('active hold dismisses once (stage advance + decision row, no bet)', () => {
    const id = 'disc_active_1';
    seedHold(id);
    const r = dismissHold(id, 'dashboard');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'dismissed');
    assert.strictEqual(r.ingestId, id);

    assert.strictEqual(countDecisions(id), 1, 'exactly one decision row');
    const d = latestDecision(id);
    assert.strictEqual(d.human_decision, 'dismissed', "human_decision matches live writer ('dismissed')");
    assert.strictEqual(d.reviewed_by, 'dashboard', 'actor recorded in reviewed_by');
    assert.strictEqual(d.bet_id, null, 'dismiss never creates/links a bet');
    assert.strictEqual(d.reparse_attempted, 0, 'admin dismiss attempts no reparse');
    assert.ok(d.hold_payload, 'durable copy of the hold payload captured');

    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 1, 'exactly one stage advance');
  });

  // ── CORE: repeat dismiss is an idempotent no-op ───────────
  await run('repeat dismiss: no duplicate decision row, no second mutation', () => {
    const id = 'disc_repeat_1';
    seedHold(id);

    const r1 = dismissHold(id, 'dashboard');
    assert.strictEqual(r1.status, 'dismissed');
    assert.strictEqual(countDecisions(id), 1);
    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 1);

    const r2 = dismissHold(id, 'dashboard');
    assert.strictEqual(r2.ok, true, 'already-dismissed is a safe no-op (ok:true)');
    assert.strictEqual(r2.status, 'already_dismissed');
    assert.strictEqual(countDecisions(id), 1, 'no duplicate decision row');
    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 1, 'no second stage advance');
  });

  // ── CORE: released hold is refused ────────────────────────
  await run('released hold is refused, mutates nothing', () => {
    const id = 'disc_released_1';
    seedHold(id);
    seedReleased(id); // resolves the hold as RELEASED (higher id → latest state)

    const r = dismissHold(id, 'dashboard');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'already_released');
    assert.strictEqual(countDecisions(id), 0, 'no decision row written for a released hold');
    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 0, 'no dismiss stage advance written');
  });

  // ── CORE: unknown ingestId → not_found ────────────────────
  await run('unknown ingestId → not_found, mutates nothing', () => {
    const id = 'disc_never_held_1';
    const r = dismissHold(id, 'dashboard');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'not_found');
    assert.strictEqual(countDecisions(id), 0);
    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 0);
  });

  // ── WRAPPER: Discord passes interaction.user.tag as actor ─
  await run('Discord wrapper passes interaction.user.tag as actor (UX preserved)', async () => {
    const id = 'disc_wrapper_1';
    seedHold(id);

    const updates = [];
    const interaction = {
      customId: `hold:dismiss:${id}`,
      isButton: () => true,
      isModalSubmit: () => false,
      user: { id: 'u-admin', tag: 'admin#4242' },
      message: { embeds: [{ title: 'Slip held', color: 0xffcc00 }], components: [] },
      update: async (payload) => { updates.push(payload); },
      reply: async () => {},
    };

    await handleHoldInteraction(interaction);

    assert.strictEqual(updates.length, 1, 'interaction.update called once (embed edit + button strip preserved)');
    const d = latestDecision(id);
    assert.ok(d, 'decision row written via the wrapper');
    assert.strictEqual(d.reviewed_by, 'admin#4242', 'actor is the Discord user tag');
    assert.strictEqual(d.human_decision, 'dismissed');
    assert.strictEqual(countStage(id, 'MANUAL_REVIEW_DISMISSED'), 1, 'stage advanced once');
  });

  // ── API ROUTE: defaults actor to 'dashboard' ──────────────
  await run("API route defaults actor to 'dashboard' (200 dismissed)", () => {
    const id = 'disc_api_default_1';
    seedHold(id);

    const res = mockRes();
    handleDismissRoute({ params: { ingestId: id }, body: {} }, res);

    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.status, 'dismissed');
    assert.strictEqual(latestDecision(id).reviewed_by, 'dashboard', "actor defaulted to 'dashboard'");
  });

  // ── API ROUTE: honors explicit body.actor ─────────────────
  await run('API route honors an explicit body.actor', () => {
    const id = 'disc_api_actor_1';
    seedHold(id);

    const res = mockRes();
    handleDismissRoute({ params: { ingestId: id }, body: { actor: 'smokke@dashboard' } }, res);

    assert.strictEqual(res._code, 200);
    assert.strictEqual(latestDecision(id).reviewed_by, 'smokke@dashboard');
  });

  // ── API ROUTE: status → HTTP code mapping ─────────────────
  await run('API route maps already_dismissed → 200', () => {
    const id = 'disc_api_again_1';
    seedHold(id);
    handleDismissRoute({ params: { ingestId: id }, body: {} }, mockRes()); // first: dismissed
    const res = mockRes();
    handleDismissRoute({ params: { ingestId: id }, body: {} }, res);       // second: already_dismissed
    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.status, 'already_dismissed');
    assert.strictEqual(countDecisions(id), 1, 'still no duplicate decision row via the route');
  });

  await run('API route maps already_released → 409', () => {
    const id = 'disc_api_released_1';
    seedHold(id);
    seedReleased(id);
    const res = mockRes();
    handleDismissRoute({ params: { ingestId: id }, body: {} }, res);
    assert.strictEqual(res._code, 409);
    assert.strictEqual(res._json.status, 'already_released');
  });

  await run('API route maps not_found → 404', () => {
    const res = mockRes();
    handleDismissRoute({ params: { ingestId: 'disc_api_missing_1' }, body: {} }, res);
    assert.strictEqual(res._code, 404);
    assert.strictEqual(res._json.status, 'not_found');
  });

  await run('API route maps malformed ingestId → 400', () => {
    const res = mockRes();
    handleDismissRoute({ params: { ingestId: '   ' }, body: {} }, res);
    assert.strictEqual(res._code, 400);
    assert.strictEqual(res._json.status, 'malformed');
  });

  // ── cleanup ────────────────────────────────────────────────
  try { db.close(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
  }

  console.log(`\nhold-dismiss: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
