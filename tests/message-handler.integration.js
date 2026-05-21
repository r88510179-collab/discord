const assert = require('assert');
const path = require('path');

function loadHandlerWithMocks({ parseBetText, parseBetSlipImage, createBetWithLegs, sendStagingEmbed, events }) {
  const aiPath = path.resolve(__dirname, '../services/ai.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const embedsPath = path.resolve(__dirname, '../utils/embeds.js');
  const dashboardPath = path.resolve(__dirname, '../services/dashboard.js');
  const handlerPath = path.resolve(__dirname, '../handlers/messageHandler.js');
  const pipelineEventsPath = path.resolve(__dirname, '../services/pipeline-events.js');

  delete require.cache[handlerPath];
  require.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
      parseBetText,
      parseBetSlipImage,
      evaluateTweet: () => 'valid',
      validateParsedBet: () => ({ valid: true, issues: [] }),
    },
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getOrCreateCapper: async () => ({ id: 'capper_1' }),
      createBetWithLegs,
      isDuplicateBet: () => false,
      isAuditMode: () => false,
    },
  };
  require.cache[embedsPath] = { id: embedsPath, filename: embedsPath, loaded: true, exports: { betEmbed: (b) => ({ title: b.description }) } };
  require.cache[dashboardPath] = { id: dashboardPath, filename: dashboardPath, loaded: true, exports: { postPickTracked: async () => {} } };

  const warRoomPath = path.resolve(__dirname, '../services/warRoom.js');
  require.cache[warRoomPath] = { id: warRoomPath, filename: warRoomPath, loaded: true, exports: { sendStagingEmbed } };

  // Capture pipeline_events emissions for the pure-slip gate tests. The real module is kept
  // (real STAGES enum + makeIngestId); only the three write helpers are swapped for capturing
  // versions. The harness's database stub already makes the real writers no-op, so this just
  // makes the stage/drop calls observable without touching production behavior.
  if (events) {
    // eslint-disable-next-line global-require
    const pe = require(pipelineEventsPath);
    pe.recordStage = ({ stage, eventType, dropReason, payload } = {}) =>
      events.push({ fn: 'stage', stage, eventType: eventType || 'STAGE_ENTER', dropReason: dropReason || null, payload });
    pe.recordDrop = ({ stage, dropReason, payload } = {}) =>
      events.push({ fn: 'drop', stage: stage || 'DROPPED', eventType: 'DROP', dropReason: dropReason || 'BOUNCER_REJECTED', payload });
    pe.recordError = ({ stage, error, payload } = {}) =>
      events.push({ fn: 'error', stage: stage || 'ERROR', eventType: 'ERROR', dropReason: 'EXCEPTION_THROWN', payload, error });
  }

  // eslint-disable-next-line global-require
  return require(handlerPath);
}

// Count captured stage/drop events by stage name.
function countStage(events, stage) {
  return events.filter(e => e.stage === stage).length;
}

function makeMessage({ messageId = 'msg_1', withImage = false } = {}) {
  const replyCalls = [];
  const reactCalls = [];
  const imageMap = new Map();
  if (withImage) {
    imageMap.set('att_1', { contentType: 'image/png', url: 'https://example.com/slip.png' });
  }

  return {
    guild: { id: 'guild_1' },
    id: messageId,
    content: 'Lakers -3.5 -110 1u lock',
    channel: { id: 'channel_1', name: 'picks' },
    attachments: imageMap,
    embeds: [],
    reference: null,
    createdTimestamp: Date.now(),
    author: {
      id: 'user_1',
      bot: false,
      displayName: 'Tester',
      displayAvatarURL: () => null,
    },
    client: { user: { id: 'bot_1' } },
    react: async (emoji) => { reactCalls.push(emoji); },
    reply: async (payload) => { replyCalls.push(payload); },
    _replyCalls: replyCalls,
    _reactCalls: reactCalls,
  };
}

function dedupeWriter() {
  const seen = new Map();
  let counter = 0;
  let inserted = 0;

  const fn = async (betData) => {
    const key = [
      betData.capper_id,
      betData.source_channel_id,
      betData.source_message_id,
      betData.description,
      betData.odds,
      betData.units,
    ].join('|');

    if (seen.has(key)) {
      return { ...seen.get(key), _deduped: true };
    }

    counter += 1;
    inserted += 1;
    const bet = { id: `bet_${counter}`, description: betData.description, _deduped: false };
    seen.set(key, bet);
    return bet;
  };

  fn.insertedCount = () => inserted;
  return fn;
}

function concurrentSafeWriter() {
  const seen = new Map();
  const inFlight = new Map();
  let inserted = 0;
  let counter = 0;

  const fn = async (betData) => {
    const key = [
      betData.capper_id,
      betData.source_channel_id,
      betData.source_message_id,
      betData.description,
      betData.odds,
      betData.units,
    ].join('|');

    if (seen.has(key)) return { ...seen.get(key), _deduped: true };
    if (inFlight.has(key)) {
      await inFlight.get(key);
      return { ...seen.get(key), _deduped: true };
    }

    const pending = new Promise((resolve) => {
      setTimeout(() => {
        counter += 1;
        inserted += 1;
        const bet = { id: `bet_${counter}`, description: betData.description, _deduped: false };
        seen.set(key, bet);
        inFlight.delete(key);
        resolve();
      }, 20);
    });
    inFlight.set(key, pending);
    await pending;
    return seen.get(key);
  };

  fn.insertedCount = () => inserted;
  return fn;
}

async function testReplayNoDuplicateSideEffects() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';

  const writer = dedupeWriter();
  const staged = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
  });

  const msg = makeMessage({ messageId: 'replay_1', withImage: false });
  await handleMessage(msg);
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(writer.insertedCount(), 1, 'replay should not insert duplicate bet rows');
  assert.strictEqual(msg._reactCalls.length, 1, 'replay should not react twice');
  assert.strictEqual(msg._replyCalls.length, 0, 'replay should not send chat replies');
  assert.strictEqual(staged.length, 1, 'replay should not stage War Room embed twice');
}

async function testTextAndImageSinglePersistedSet() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';

  const writer = dedupeWriter();
  const staged = [];
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
  });

  const msg = makeMessage({ messageId: 'mix_1', withImage: true });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(writer.insertedCount(), 1, 'text+image same message should persist only one bet set');
  assert.strictEqual(msg._reactCalls.length, 1, 'single processing should react once');
  assert.strictEqual(msg._replyCalls.length, 0, 'single processing should not send chat replies');
  assert.strictEqual(staged.length, 1, 'single processing should stage one War Room embed');
}

async function testNearSimultaneousReplaySingleSideEffects() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';

  const writer = concurrentSafeWriter();
  const staged = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
  });

  const msg = makeMessage({ messageId: 'concurrent_1', withImage: false });
  await Promise.all([handleMessage(msg), handleMessage(msg)]);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(writer.insertedCount(), 1, 'concurrent replay should persist exactly one write');
  assert.strictEqual(msg._reactCalls.length, 1, 'concurrent replay should react once');
  assert.strictEqual(msg._replyCalls.length, 0, 'concurrent replay should not send chat replies');
  assert.strictEqual(staged.length, 1, 'concurrent replay should stage War Room embed once');
}

// ── PR #2: pure-slip channel hold-skip gate ─────────────────────────────────
// Channel is in HUMAN_SUBMISSION_CHANNEL_IDS (authorizes it + enables the hold path).
// PURE_SLIP_CHANNEL_IDS toggles the skip. Content is a normal pick so GUARD 5 buffers it;
// the mocked parseBetText forces which branch (is_bet=false / indeterminate / valid) hits.

// 1. Bypass channel + is_bet=false → no MANUAL_REVIEW_HOLD, one PURE_SLIP_SKIP_HOLD, drop runs.
async function testPureSlipSkipsHoldOnIsBetFalse() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'channel_1';

  const events = [];
  const writer = dedupeWriter();
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ is_bet: false }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId: 'pureslip_nobet_1', withImage: false });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0, 'pure-slip is_bet=false must NOT stage a hold');
  assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 1, 'pure-slip is_bet=false must emit exactly one PURE_SLIP_SKIP_HOLD');
  const skip = events.find(e => e.stage === 'PURE_SLIP_SKIP_HOLD');
  assert.strictEqual(skip.eventType, 'STAGE_ENTER', 'PURE_SLIP_SKIP_HOLD must be a STAGE_ENTER, not a DROP');
  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_NO_BET_CONTENT');
  assert.ok(drop, 'pure-slip is_bet=false must fall through to the existing PRE_FILTER_NO_BET_CONTENT drop');
  assert.strictEqual(writer.insertedCount(), 0, 'pure-slip is_bet=false must not persist a bet');
}

// 2. Bypass channel + ai_indeterminate → no hold, one PURE_SLIP_SKIP_HOLD, drop runs.
async function testPureSlipSkipsHoldOnIndeterminate() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'channel_1';

  const events = [];
  const writer = dedupeWriter();
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ type: 'bet', bets: [] }), // is_bet undefined + no bets → indeterminate branch
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId: 'pureslip_indeterm_1', withImage: false });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0, 'pure-slip indeterminate must NOT stage a hold');
  assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 1, 'pure-slip indeterminate must emit exactly one PURE_SLIP_SKIP_HOLD');
  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_AI_EMPTY_RESULT');
  assert.ok(drop, 'pure-slip indeterminate must fall through to the existing PRE_FILTER_AI_EMPTY_RESULT drop');
  assert.strictEqual(writer.insertedCount(), 0, 'pure-slip indeterminate must not persist a bet');
}

// 3. Bypass channel + valid bets → unchanged from baseline (persists, no hold, no skip).
async function testPureSlipValidBetsUnchanged() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'channel_1';

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'pureslip_valid_1', withImage: false });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 0, 'valid bets must not emit PURE_SLIP_SKIP_HOLD');
  assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0, 'valid bets must not stage a hold');
  assert.strictEqual(writer.insertedCount(), 1, 'valid bets in a pure-slip channel persist exactly as baseline');
  assert.strictEqual(staged.length, 1, 'valid bets stage one War Room embed');
}

// 4. Non-bypass channel (not in PURE_SLIP_CHANNEL_IDS), is_bet=false → baseline hold, no skip.
async function testNonBypassChannelStillHolds() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'some_other_channel';

  const events = [];
  const writer = dedupeWriter();
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ is_bet: false }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId: 'nonbypass_nobet_1', withImage: false });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 0, 'non-bypass channel must not emit PURE_SLIP_SKIP_HOLD');
  assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 1, 'non-bypass human channel must stage MANUAL_REVIEW_HOLD as baseline');
}

// 5. Empty PURE_SLIP_CHANNEL_IDS → gate disabled, baseline hold, no skip.
async function testEmptyPureSlipUnchanged() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = '';

  const events = [];
  const writer = dedupeWriter();
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ is_bet: false }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId: 'emptypureslip_nobet_1', withImage: false });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 0, 'empty PURE_SLIP_CHANNEL_IDS must emit no skip events');
  assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 1, 'empty PURE_SLIP_CHANNEL_IDS must leave MANUAL_REVIEW_HOLD staging unchanged');
}

(async () => {
  await testReplayNoDuplicateSideEffects();
  await testTextAndImageSinglePersistedSet();
  await testNearSimultaneousReplaySingleSideEffects();
  await testPureSlipSkipsHoldOnIsBetFalse();
  await testPureSlipSkipsHoldOnIndeterminate();
  await testPureSlipValidBetsUnchanged();
  await testNonBypassChannelStillHolds();
  await testEmptyPureSlipUnchanged();
  console.log('messageHandler integration validation passed.');
  // Production handler installs a 10-minute alertCooldowns prune setInterval that
  // keeps the event loop alive. Force-exit so the test runner advances.
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
