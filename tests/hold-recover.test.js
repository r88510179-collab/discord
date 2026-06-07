// ═══════════════════════════════════════════════════════════
// On-demand Unfurl Recovery core + admin API route tests (Phase 2b-2).
//
// Exercises the transport-agnostic core services/holdReview.recoverHold and the
// admin write route handler routes/adminCommands.handleRecoverRoute.
//
// recoverHold's Discord fetch + vision_slip extraction are injected via `deps`
// so CI never touches Discord or a vision provider. The REAL pieces under test
// are recoverHold's own logic: state ordering, idempotency keyed on
// bets.source_message_id, the MANUAL_REVIEW_RELEASED stage advance, and the
// hold_review_decisions actor trail. The injected `extract` calls the REAL
// createBetWithLegs(source:'vision_slip') so the bet rows the idempotency keys
// on are genuine.
//
// Uses the standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds fresh pipeline_events + bets +
// hold_review_decisions tables we can seed and read back.
//
// Run:  node tests/hold-recover.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `hold-recover-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { recordStage } = require('../services/pipeline-events');
const { db, createBetWithLegs, getOrCreateCapper } = require('../services/database');
const { recoverHold } = require('../services/holdReview');
const { handleRecoverRoute } = require('../routes/adminCommands');

// A real capper to satisfy the bets FK (createBetWithLegs enforces it).
const CAPPER = getOrCreateCapper('cap_recover_test', 'Recover Tester', null);
const CAPPER_ID = CAPPER.id;

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

// ── fixtures / seed / read helpers ───────────────────────────
let fixtureSeq = 0;
function holdFixture() {
  fixtureSeq += 1;
  const guildId = '111';
  const channelId = '1355182920163262664'; // #datdude-slips
  const messageId = `900000000000000${String(1000 + fixtureSeq)}`;
  return {
    ingestId: `disc_${messageId}`,
    channelId,
    messageId,
    messageUrl: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  };
}

function seedHold(f) {
  recordStage({
    ingestId: f.ingestId,
    sourceType: 'discord',
    sourceRef: f.messageId,
    stage: 'MANUAL_REVIEW_HOLD',
    eventType: 'STAGE_ENTER',
    payload: { reason: 'ai_is_bet_false', channelId: f.channelId, capper: 'DatDude', messageUrl: f.messageUrl, sample: 'Check out this bet I placed on Hard Rock Bet!' },
  });
}
function seedReleased(f) {
  recordStage({ ingestId: f.ingestId, sourceType: 'discord', sourceRef: f.messageId, stage: 'MANUAL_REVIEW_RELEASED', eventType: 'STAGE_ENTER', payload: { released_by: 'someone', bet_id: 'bet_seed' } });
}
function seedDismissed(f) {
  recordStage({ ingestId: f.ingestId, sourceType: 'discord', sourceRef: f.messageId, stage: 'MANUAL_REVIEW_DISMISSED', eventType: 'STAGE_ENTER', payload: { dismissed_by: 'someone' } });
}

function betsForMessage(messageId) {
  return db.prepare('SELECT id, source, review_status FROM bets WHERE source_message_id = ?').all(messageId);
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
function latestStage(id) {
  const row = db.prepare(`SELECT stage FROM pipeline_events WHERE ingest_id = ? AND stage IN ('MANUAL_REVIEW_HOLD','MANUAL_REVIEW_RELEASED','MANUAL_REVIEW_DISMISSED') ORDER BY created_at DESC, id DESC LIMIT 1`).get(id);
  return row ? row.stage : null;
}
function mockRes() {
  return {
    _code: null, _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}

// ── injectable seams ─────────────────────────────────────────
function fakeMessage(images) {
  return {
    id: 'm', channel: { id: 'c', name: 'datdude-slips' },
    author: { id: 'u', displayName: 'DatDude', bot: false, displayAvatarURL: () => null },
    _images: images || [],
  };
}
const ATTACH_IMG = [{ url: 'https://cdn.discordapp.com/attachments/slip.png', type: 'image/png', origin: 'attachment' }];

// extract that runs the REAL createBetWithLegs(source:'vision_slip') for each row
function extractCreates(rows) {
  return async ({ messageId, channelId, messageUrl }) => ({
    bets: rows.map((r, i) => createBetWithLegs({
      capper_id: CAPPER_ID, sport: r.sport || 'NBA', league: null, bet_type: 'straight',
      description: r.description || `Recovered HRB leg ${i}`, odds: r.odds || -110, units: r.units || 1,
      event_date: null, source: 'vision_slip',
      source_channel_id: channelId, source_message_id: messageId, source_url: messageUrl,
      raw_text: 'recovered ocr text', review_status: 'needs_review',
    }, [])),
  });
}
const extractNoBet = async () => ({ bets: [] });

// deps for a happy-path recover (image present + bet extracted)
function depsCreates(rows, images) {
  return {
    client: {},
    fetchMessage: async () => fakeMessage(images || ATTACH_IMG),
    getImageAttachments: (m) => m._images,
    extract: extractCreates(rows),
  };
}

(async () => {
  // ── CORE: slip-image message → ONE vision_slip bet + hold resolved ──
  await run('slip-image message → recover creates ONE vision_slip bet + resolves hold', async () => {
    const f = holdFixture();
    seedHold(f);
    const r = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'Lakers ML' }]));

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'recovered');
    assert.ok(r.betId, 'returns the created betId');

    const bets = betsForMessage(f.messageId);
    assert.strictEqual(bets.length, 1, 'exactly one bet created');
    assert.strictEqual(bets[0].source, 'vision_slip', "reuses the vision_slip create path");
    assert.strictEqual(bets[0].review_status, 'needs_review', 'lands in needs_review like any slip ingest');

    assert.strictEqual(countStage(f.ingestId, 'MANUAL_REVIEW_RELEASED'), 1, 'hold advanced to RELEASED once');
    assert.strictEqual(countDecisions(f.ingestId), 1, 'one decision row');
    const d = latestDecision(f.ingestId);
    assert.strictEqual(d.human_decision, 'recovered');
    assert.strictEqual(d.reviewed_by, 'dashboard', 'actor recorded in reviewed_by');
    assert.strictEqual(d.bet_id, r.betId, 'decision links the recovered bet');
    assert.strictEqual(d.reparse_input_source, 'image');
    assert.strictEqual(d.source_label, 'unfurl_recovery');
  });

  // ── CORE: re-run is idempotent → already_recovered, no duplicate bet ──
  await run('re-run recover → already_recovered, no duplicate bet, no second mutation', async () => {
    const f = holdFixture();
    seedHold(f);
    const r1 = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'Celtics -3' }]));
    assert.strictEqual(r1.status, 'recovered');
    assert.strictEqual(betsForMessage(f.messageId).length, 1);

    const r2 = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'Celtics -3' }]));
    assert.strictEqual(r2.ok, true, 'already-recovered is a safe ok:true');
    assert.strictEqual(r2.status, 'already_recovered');
    assert.strictEqual(r2.betId, r1.betId, 'returns the same bet');
    assert.strictEqual(betsForMessage(f.messageId).length, 1, 'no duplicate bet');
    assert.strictEqual(countStage(f.ingestId, 'MANUAL_REVIEW_RELEASED'), 1, 'no second stage advance');
    assert.strictEqual(countDecisions(f.ingestId), 1, 'no duplicate decision row');
  });

  // ── CORE: already-resolved (released) hold is refused ──
  await run('already-released hold → already_resolved, mutates nothing', async () => {
    const f = holdFixture();
    seedHold(f);
    seedReleased(f);
    const r = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'should not run' }]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'already_resolved');
    assert.strictEqual(betsForMessage(f.messageId).length, 0, 'no bet created');
    assert.strictEqual(countDecisions(f.ingestId), 0, 'no decision row');
  });

  // ── CORE: already-resolved (dismissed) hold is refused ──
  await run('already-dismissed hold → already_resolved, mutates nothing', async () => {
    const f = holdFixture();
    seedHold(f);
    seedDismissed(f);
    const r = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'should not run' }]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'already_resolved');
    assert.strictEqual(betsForMessage(f.messageId).length, 0);
    assert.strictEqual(countDecisions(f.ingestId), 0);
  });

  // ── CORE: no-image message → no_image_yet, nothing created, hold untouched ──
  await run('no-image message → no_image_yet, nothing created, hold untouched', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => fakeMessage([]), getImageAttachments: (m) => m._images, extract: extractCreates([{ description: 'never' }]) };
    const r = await recoverHold(f.ingestId, 'dashboard', deps);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'no_image_yet');
    assert.strictEqual(betsForMessage(f.messageId).length, 0, 'creates nothing');
    assert.strictEqual(countStage(f.ingestId, 'MANUAL_REVIEW_RELEASED'), 0, 'hold not advanced');
    assert.strictEqual(countDecisions(f.ingestId), 0, 'no decision row');
    assert.strictEqual(latestStage(f.ingestId), 'MANUAL_REVIEW_HOLD', 'hold still open');
  });

  // ── CORE: vision yields no bet → no_bet_found, hold untouched ──
  await run('vision yields no bet → no_bet_found, hold untouched', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => fakeMessage(ATTACH_IMG), getImageAttachments: (m) => m._images, extract: extractNoBet };
    const r = await recoverHold(f.ingestId, 'dashboard', deps);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'no_bet_found');
    assert.strictEqual(betsForMessage(f.messageId).length, 0, 'creates nothing');
    assert.strictEqual(countStage(f.ingestId, 'MANUAL_REVIEW_RELEASED'), 0, 'hold not advanced');
    assert.strictEqual(countDecisions(f.ingestId), 0);
    assert.strictEqual(latestStage(f.ingestId), 'MANUAL_REVIEW_HOLD', 'hold still open');
  });

  // ── CORE: unknown ingestId → not_found ──
  await run('unknown ingestId → not_found, mutates nothing', async () => {
    const r = await recoverHold('disc_never_held_recover', 'dashboard', depsCreates([{ description: 'x' }]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'not_found');
  });

  // ── CORE: message unreachable (fetch returns null) ──
  await run('message unreachable (fetch null) → message_unreachable, hold untouched', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => null, getImageAttachments: (m) => m._images, extract: extractCreates([{ description: 'x' }]) };
    const r = await recoverHold(f.ingestId, 'dashboard', deps);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'message_unreachable');
    assert.strictEqual(betsForMessage(f.messageId).length, 0);
    assert.strictEqual(latestStage(f.ingestId), 'MANUAL_REVIEW_HOLD');
  });

  // ── CORE: no discord client → message_unreachable ──
  await run('no discord client → message_unreachable', async () => {
    const f = holdFixture();
    seedHold(f);
    const r = await recoverHold(f.ingestId, 'dashboard', { client: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'message_unreachable');
  });

  // ── CORE: self-heals a partial run (bet exists, hold still open) ──
  await run('self-heals a partial run: bet exists + hold open → already_recovered + resolves', async () => {
    const f = holdFixture();
    seedHold(f);
    // simulate a prior run that created the bet but crashed before resolving
    const bet = createBetWithLegs({
      capper_id: CAPPER_ID, sport: 'NBA', bet_type: 'straight', description: 'Partial run leg',
      odds: -110, units: 1, source: 'vision_slip', source_channel_id: f.channelId,
      source_message_id: f.messageId, source_url: f.messageUrl, raw_text: 'x', review_status: 'needs_review',
    }, []);
    assert.strictEqual(latestStage(f.ingestId), 'MANUAL_REVIEW_HOLD', 'hold still open before recover');

    const r = await recoverHold(f.ingestId, 'dashboard', depsCreates([{ description: 'should not double-create' }]));
    assert.strictEqual(r.status, 'already_recovered');
    assert.strictEqual(r.betId, bet.id);
    assert.strictEqual(betsForMessage(f.messageId).length, 1, 'no second bet');
    assert.strictEqual(countStage(f.ingestId, 'MANUAL_REVIEW_RELEASED'), 1, 'hold healed to RELEASED');
    assert.strictEqual(countDecisions(f.ingestId), 1, 'decision row written on self-heal');
  });

  // ════════════════ ROUTE: status → HTTP code mapping ════════════════
  await run('API route: recovered → 200 (defaults actor to dashboard)', async () => {
    const f = holdFixture();
    seedHold(f);
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, depsCreates([{ description: 'Heat +2.5' }]));
    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.status, 'recovered');
    assert.strictEqual(latestDecision(f.ingestId).reviewed_by, 'dashboard', "actor defaulted to 'dashboard'");
  });

  await run('API route: already_recovered → 200, honors body.actor', async () => {
    const f = holdFixture();
    seedHold(f);
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: { actor: 'smokke@dashboard' } }, mockRes(), depsCreates([{ description: 'Bucks ML' }]));
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, depsCreates([{ description: 'Bucks ML' }]));
    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.status, 'already_recovered');
    assert.strictEqual(betsForMessage(f.messageId).length, 1, 'no duplicate via the route');
  });

  await run('API route: already_resolved → 409', async () => {
    const f = holdFixture();
    seedHold(f);
    seedReleased(f);
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, depsCreates([{ description: 'x' }]));
    assert.strictEqual(res._code, 409);
    assert.strictEqual(res._json.status, 'already_resolved');
  });

  await run('API route: not_found → 404', async () => {
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: 'disc_api_missing_recover' }, body: {} }, res, {});
    assert.strictEqual(res._code, 404);
    assert.strictEqual(res._json.status, 'not_found');
  });

  await run('API route: no_image_yet → 422', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => fakeMessage([]), getImageAttachments: (m) => m._images, extract: extractCreates([{ description: 'x' }]) };
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, deps);
    assert.strictEqual(res._code, 422);
    assert.strictEqual(res._json.status, 'no_image_yet');
  });

  await run('API route: no_bet_found → 422', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => fakeMessage(ATTACH_IMG), getImageAttachments: (m) => m._images, extract: extractNoBet };
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, deps);
    assert.strictEqual(res._code, 422);
    assert.strictEqual(res._json.status, 'no_bet_found');
  });

  await run('API route: message_unreachable → 502', async () => {
    const f = holdFixture();
    seedHold(f);
    const deps = { client: {}, fetchMessage: async () => null, getImageAttachments: (m) => m._images, extract: extractCreates([{ description: 'x' }]) };
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: f.ingestId }, body: {} }, res, deps);
    assert.strictEqual(res._code, 502);
    assert.strictEqual(res._json.status, 'message_unreachable');
  });

  await run('API route: malformed ingestId → 400', async () => {
    const res = mockRes();
    await handleRecoverRoute({ params: { ingestId: '   ' }, body: {} }, res, {});
    assert.strictEqual(res._code, 400);
    assert.strictEqual(res._json.status, 'malformed');
  });

  // ── cleanup ────────────────────────────────────────────────
  try { db.close(); } catch (_) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
  }

  console.log(`\nhold-recover: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
