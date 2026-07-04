// ═══════════════════════════════════════════════════════════
// 🔄 re-ingest reaction — reingestSlipMessage core + handleReingestReaction gate.
//
// Feature: an operator reacts 🔄 on a message in a HUMAN_SUBMISSION_CHANNEL_IDS
// channel → the bot re-fetches it, re-extracts via the Onyx-aware bets-only
// vision path (processImageForAI → parseBetSlipImage), and stages fresh to the
// War Room (the SAME TYPE 1 vision_slip path), bypassing the green-check
// parseBetText win-classifier. See handlers/messageHandler.js.
//
// Harness: the same require.cache injection idiom as message-handler.integration.js
// — ai / database / warRoom / embeds / dashboard are mocked BEFORE requiring the
// handler; pipeline-events is kept real (real STAGES enum + makeIngestId) with its
// three write helpers swapped for capturing versions. No real DB or Discord calls.
//
// Run:  node tests/reingest-reaction.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

// Fully mocked database → the real database.js body never runs, but set a
// throwaway DB_PATH anyway (belt-and-suspenders, mirrors sibling tests).
process.env.DB_PATH = path.join(os.tmpdir(), `reingest-reaction-${process.pid}-${Date.now()}.db`);

// ── require.cache injection loader ──────────────────────────
function loadHandler({ parseBetSlipImage, processImageForAI, createBetWithLegs, getOrCreateCapper, db, sendStagingEmbed, events }) {
  const p = (rel) => path.resolve(__dirname, rel);
  const aiPath = p('../services/ai.js');
  const dbPath = p('../services/database.js');
  const warRoomPath = p('../services/warRoom.js');
  const embedsPath = p('../utils/embeds.js');
  const dashboardPath = p('../services/dashboard.js');
  const handlerPath = p('../handlers/messageHandler.js');
  const pePath = p('../services/pipeline-events.js');

  delete require.cache[handlerPath];
  delete require.cache[pePath];

  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      parseBetText: async () => ({ bets: [] }),
      parseBetSlipImage,
      // Default stub returns a fake base64 so the real Sharp/fetch pipeline is
      // bypassed; the re-extraction relies on this while mocking the bets.
      processImageForAI: processImageForAI || (async () => ({ base64: 'ZmFrZQ==', mediaType: 'image/png' })),
      evaluateTweet: () => 'valid',
      validateParsedBet: () => ({ valid: true, issues: [] }),
    },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getOrCreateCapper: getOrCreateCapper || (async () => ({ id: 'capper_1' })),
      createBetWithLegs,
      isAuditMode: () => false,
      db,
    },
  };
  require.cache[warRoomPath] = { id: warRoomPath, filename: warRoomPath, loaded: true, exports: { sendStagingEmbed, sendUntrackedWinEmbed: async () => {} } };
  require.cache[embedsPath] = { id: embedsPath, filename: embedsPath, loaded: true, exports: { betEmbed: (b) => ({ title: b.description }) } };
  require.cache[dashboardPath] = { id: dashboardPath, filename: dashboardPath, loaded: true, exports: { postPickTracked: async () => {} } };

  // Keep pipeline-events real (real STAGES + makeIngestId) but capture writes.
  // eslint-disable-next-line global-require
  const pe = require(pePath);
  pe.recordStage = ({ stage, eventType, betId, dropReason, payload } = {}) =>
    events.push({ fn: 'stage', stage, eventType: eventType || 'STAGE_ENTER', betId: betId || null, dropReason: dropReason || null, payload });
  pe.recordDrop = ({ stage, dropReason, betId, payload } = {}) =>
    events.push({ fn: 'drop', stage: stage || 'DROPPED', eventType: 'DROP', dropReason: dropReason || null, betId: betId || null, payload });
  pe.recordError = ({ stage, error, payload } = {}) =>
    events.push({ fn: 'error', stage: stage || 'ERROR', eventType: 'ERROR', error, payload });

  // eslint-disable-next-line global-require
  return require(handlerPath);
}

// ── fakes ───────────────────────────────────────────────────
function makeWriter() {
  const calls = [];
  let n = 0;
  const fn = (betData, legs, props) => {
    n += 1;
    calls.push({ betData, legs, props });
    return { id: `newbet_${n}`, description: betData.description, _deduped: false };
  };
  fn.calls = calls;
  return fn;
}

// db.prepare dispatcher covering exactly the three SQL shapes reingestSlipMessage
// uses: the source_message_id SELECT + the two war-room-mirror DELETEs. Also
// emulates db.transaction(fn) INCLUDING rollback-on-throw so the atomicity test
// can prove a create failure leaves the old bet un-deleted (better-sqlite3
// semantics: a throw inside the txn fn rolls back every write it made).
function makeFakeDb(existingRows = []) {
  const deletedLegs = [];
  const deletedBets = [];
  let journal = null; // records deletes during an open txn, for rollback
  const doDeleteLeg = (id) => { deletedLegs.push(id); if (journal) journal.legs.push(id); };
  const doDeleteBet = (id) => { deletedBets.push(id); if (journal) journal.bets.push(id); };
  const db = {
    deletedLegs,
    deletedBets,
    prepare(sql) {
      if (/SELECT[\s\S]*FROM bets WHERE source_message_id/i.test(sql)) {
        return { all: (mid) => existingRows.filter((r) => r.source_message_id === mid) };
      }
      if (/DELETE FROM parlay_legs WHERE bet_id/i.test(sql)) {
        return { run: (id) => { doDeleteLeg(id); } };
      }
      if (/DELETE FROM bets WHERE id/i.test(sql)) {
        return { run: (id) => { doDeleteBet(id); } };
      }
      return { run: () => {}, all: () => [], get: () => undefined };
    },
    transaction(fn) {
      return (...args) => {
        const prev = journal;
        journal = { legs: [], bets: [] };
        try {
          const out = fn(...args);
          journal = prev;
          return out;
        } catch (e) {
          // Roll back the deletes recorded during this txn.
          for (const id of journal.bets) { const i = deletedBets.lastIndexOf(id); if (i >= 0) deletedBets.splice(i, 1); }
          for (const id of journal.legs) { const i = deletedLegs.lastIndexOf(id); if (i >= 0) deletedLegs.splice(i, 1); }
          journal = prev;
          throw e;
        }
      };
    },
  };
  return db;
}

function makeSlipMessage({ messageId = 'm1', channelId = 'humanchan', withImage = true, content = '' } = {}) {
  const attachments = new Map();
  if (withImage) attachments.set('a1', { contentType: 'image/png', url: 'https://cdn.discordapp.com/slip1.png' });
  return {
    id: messageId,
    url: `https://discord.com/channels/g/${channelId}/${messageId}`,
    content,
    channel: { id: channelId, name: 'smokke-slips' },
    attachments,
    embeds: [],
    author: { id: 'author_1', bot: false, displayName: 'Capper', displayAvatarURL: () => null },
    client: { user: { id: 'bot_1' }, channels: { fetch: async () => null } },
  };
}

const oneBet = () => ({ bets: [{ sport: 'NBA', league: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [], props: [] }] });

// ── runner ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed += 1;
  }
}

const stagesOf = (events) => events.filter((e) => e.fn === 'stage').map((e) => e.stage);

(async () => {
  console.log('reingest-reaction:');

  // ── CORE: reingestSlipMessage ─────────────────────────────
  await run("no existing bet → 'created', createBetWithLegs called, staging embed sent", async () => {
    const events = [];
    const writer = makeWriter();
    const staged = [];
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      createBetWithLegs: writer,
      db: makeFakeDb([]),
      sendStagingEmbed: async (...args) => staged.push(args),
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'created', `status; got ${res.status}`);
    assert.strictEqual(res.betIds.length, 1, 'one bet id');
    assert.strictEqual(writer.calls.length, 1, 'createBetWithLegs called once');
    assert.strictEqual(writer.calls[0].betData.source, 'vision_slip', 'source=vision_slip');
    assert.strictEqual(writer.calls[0].betData.review_status, 'needs_review', 'review_status=needs_review');
    assert.strictEqual(staged.length, 1, 'staging embed sent once');
    const stages = stagesOf(events);
    assert.ok(stages.includes('REINGEST_ATTEMPT'), 'REINGEST_ATTEMPT emitted');
    assert.ok(stages.includes('STAGED'), 'STAGED emitted');
    assert.ok(stages.includes('REINGEST_STAGED'), 'REINGEST_STAGED emitted');
    assert.ok(!stages.includes('REINGEST_REPLACED'), 'no REINGEST_REPLACED on a fresh create');
  });

  await run("existing needs_review row → 'replaced', old legs+bet deleted, new created, REINGEST_REPLACED emitted", async () => {
    const events = [];
    const writer = makeWriter();
    const staged = [];
    const fakeDb = makeFakeDb([{ id: 'old_1', source_message_id: 'm1', review_status: 'needs_review', result: 'pending', grader_version: null }]);
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      createBetWithLegs: writer,
      db: fakeDb,
      sendStagingEmbed: async (...args) => staged.push(args),
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'replaced', `status; got ${res.status}`);
    assert.deepStrictEqual(fakeDb.deletedLegs, ['old_1'], 'old parlay_legs deleted');
    assert.deepStrictEqual(fakeDb.deletedBets, ['old_1'], 'old bets row deleted');
    assert.strictEqual(writer.calls.length, 1, 'new bet created');
    assert.strictEqual(staged.length, 1, 'staging embed sent for the new bet');
    const replaced = events.find((e) => e.stage === 'REINGEST_REPLACED');
    assert.ok(replaced, 'REINGEST_REPLACED emitted');
    assert.deepStrictEqual(replaced.payload.old_bet_id, ['old_1'], 'payload.old_bet_id');
    assert.deepStrictEqual(replaced.payload.new_bet_id, res.betIds, 'payload.new_bet_id');
  });

  await run("existing graded/approved row → 'skipped_graded', createBetWithLegs NOT called, nothing deleted", async () => {
    const events = [];
    const writer = makeWriter();
    const staged = [];
    const fakeDb = makeFakeDb([{ id: 'old_1', source_message_id: 'm1', review_status: 'confirmed', result: 'win', grader_version: 'v751' }]);
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      createBetWithLegs: writer,
      db: fakeDb,
      sendStagingEmbed: async (...args) => staged.push(args),
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'skipped_graded', `status; got ${res.status}`);
    assert.strictEqual(writer.calls.length, 0, 'createBetWithLegs NOT called');
    assert.deepStrictEqual(fakeDb.deletedBets, [], 'nothing deleted');
    assert.strictEqual(staged.length, 0, 'no staging embed');
  });

  await run("no images → 'no_images'", async () => {
    const events = [];
    const writer = makeWriter();
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      createBetWithLegs: writer,
      db: makeFakeDb([]),
      sendStagingEmbed: async () => {},
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1', withImage: false });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'no_images', `status; got ${res.status}`);
    assert.strictEqual(writer.calls.length, 0, 'createBetWithLegs NOT called');
  });

  await run("parseBetSlipImage returns no bets → 'no_bets'", async () => {
    const events = [];
    const writer = makeWriter();
    const mh = loadHandler({
      parseBetSlipImage: async () => ({ bets: [] }),
      createBetWithLegs: writer,
      db: makeFakeDb([]),
      sendStagingEmbed: async () => {},
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'no_bets', `status; got ${res.status}`);
    assert.strictEqual(writer.calls.length, 0, 'createBetWithLegs NOT called');
  });

  await run('unexpected internal error → {status:error}, never throws to caller', async () => {
    const events = [];
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      // createBetWithLegs throws → the try/catch must convert it to status:error.
      createBetWithLegs: () => { throw new Error('boom'); },
      db: makeFakeDb([]),
      sendStagingEmbed: async () => {},
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'error', `status; got ${res.status}`);
    assert.deepStrictEqual(res.betIds, [], 'betIds empty on error');
  });

  await run('REPLACE + create throws → txn rolls back, old bet NOT deleted (no data loss)', async () => {
    const events = [];
    const fakeDb = makeFakeDb([{ id: 'old_1', source_message_id: 'm1', review_status: 'needs_review', result: 'pending', grader_version: null }]);
    const mh = loadHandler({
      parseBetSlipImage: async () => oneBet(),
      // The create inside the delete+create transaction throws (e.g. a transient
      // SQLite write error). The DELETE must roll back so the old review-queue
      // bet survives — this is the atomicity fix the adversarial review flagged.
      createBetWithLegs: () => { throw new Error('SQLITE_IOERR'); },
      db: fakeDb,
      sendStagingEmbed: async () => {},
      events,
    });
    const msg = makeSlipMessage({ messageId: 'm1' });
    const res = await mh.reingestSlipMessage(msg.client, msg, { actorId: 'owner_1' });
    assert.strictEqual(res.status, 'error', `status; got ${res.status}`);
    assert.deepStrictEqual(fakeDb.deletedBets, [], 'old bets row rolled back — NOT deleted');
    assert.deepStrictEqual(fakeDb.deletedLegs, [], 'old parlay_legs rolled back — NOT deleted');
  });

  // ── GATE: handleReingestReaction ──────────────────────────
  // One handler instance is enough; inject a spy core + fixture env per case.
  const mhGate = loadHandler({
    parseBetSlipImage: async () => oneBet(),
    createBetWithLegs: makeWriter(),
    db: makeFakeDb([]),
    sendStagingEmbed: async () => {},
    events: [],
  });

  const GATE_ENV = {
    OWNER_ID: 'owner_1',
    REINGEST_EMOJI: '🔄',
    HUMAN_SUBMISSION_CHANNEL_IDS: 'humanchan, otherchan_ignored',
    ADMIN_LOG_CHANNEL_ID: 'adminlog',
  };

  function makeReaction({ emojiName = '🔄', channelId = 'humanchan' } = {}) {
    const reactCalls = [];
    const adminSends = [];
    const message = {
      id: 'm1',
      partial: false,
      channel: { id: channelId },
      client: {
        user: { id: 'bot_1' },
        channels: { fetch: async () => ({ send: async (s) => { adminSends.push(s); } }) },
      },
      react: async (e) => { reactCalls.push(e); return { users: { remove: async () => {} } }; },
    };
    return { partial: false, emoji: { name: emojiName }, message, fetch: async () => {}, _reactCalls: reactCalls, _adminSends: adminSends };
  }

  async function gateResult(opts) {
    let coreCalls = 0;
    const reaction = makeReaction(opts.reaction || {});
    const user = opts.user || { id: 'owner_1', bot: false };
    await mhGate.handleReingestReaction(reaction, user, {
      env: opts.env || GATE_ENV,
      reingest: async () => { coreCalls += 1; return { status: 'created', betIds: ['b1'] }; },
    });
    return { coreCalls, reaction };
  }

  await run('owner + 🔄 + human channel → core called once, ⏳ then ✅, admin-log posted', async () => {
    const { coreCalls, reaction } = await gateResult({});
    assert.strictEqual(coreCalls, 1, 'core called exactly once');
    assert.ok(reaction._reactCalls.includes('⏳'), '⏳ ACK added');
    assert.ok(reaction._reactCalls.includes('✅'), '✅ outcome added');
    assert.strictEqual(reaction._adminSends.length, 1, 'one admin-log line posted');
    assert.ok(/created/.test(reaction._adminSends[0]), 'admin-log line names the status');
  });

  await run('wrong emoji → core NOT called', async () => {
    const { coreCalls } = await gateResult({ reaction: { emojiName: '👍' } });
    assert.strictEqual(coreCalls, 0, 'core not called on wrong emoji');
  });

  await run('non-owner → core NOT called', async () => {
    const { coreCalls } = await gateResult({ user: { id: 'someone_else', bot: false } });
    assert.strictEqual(coreCalls, 0, 'core not called for non-owner');
  });

  await run('bot user → core NOT called', async () => {
    const { coreCalls } = await gateResult({ user: { id: 'owner_1', bot: true } });
    assert.strictEqual(coreCalls, 0, 'core not called for a bot reactor');
  });

  await run('non-human channel → core NOT called', async () => {
    const { coreCalls } = await gateResult({ reaction: { channelId: 'random_channel' } });
    assert.strictEqual(coreCalls, 0, 'core not called outside human channels');
  });

  await run('custom REINGEST_EMOJI is honored', async () => {
    const env = { ...GATE_ENV, REINGEST_EMOJI: '♻️' };
    const miss = await gateResult({ env, reaction: { emojiName: '🔄' } });
    assert.strictEqual(miss.coreCalls, 0, 'default 🔄 ignored when override set');
    const hit = await gateResult({ env, reaction: { emojiName: '♻️' } });
    assert.strictEqual(hit.coreCalls, 1, 'override emoji triggers the core');
  });

  console.log(`\nreingest-reaction: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
