const assert = require('assert');
const path = require('path');

function loadHandlerWithMocks({ parseBetText, parseBetSlipImage, createBetWithLegs, postPickTracked }) {
  const aiPath = path.resolve(__dirname, '../services/ai.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const embedsPath = path.resolve(__dirname, '../utils/embeds.js');
  const dashboardPath = path.resolve(__dirname, '../services/dashboard.js');
  const handlerPath = path.resolve(__dirname, '../handlers/messageHandler.js');

  delete require.cache[handlerPath];
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { parseBetText, parseBetSlipImage } };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getOrCreateCapper: async () => ({ id: 'capper_1' }),
      createBetWithLegs,
    },
  };
  require.cache[embedsPath] = { id: embedsPath, filename: embedsPath, loaded: true, exports: { betEmbed: (b) => ({ title: b.description }) } };
  require.cache[dashboardPath] = { id: dashboardPath, filename: dashboardPath, loaded: true, exports: { postPickTracked } };

  // eslint-disable-next-line global-require
  return require(handlerPath);
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
  const tracked = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    postPickTracked: async (...args) => tracked.push(args),
  });

  const msg = makeMessage({ messageId: 'replay_1', withImage: false });
  await handleMessage(msg);
  await handleMessage(msg);

  assert.strictEqual(writer.insertedCount(), 1, 'replay should not insert duplicate bet rows');
  assert.strictEqual(msg._reactCalls.length, 1, 'replay should not react twice');
  assert.strictEqual(msg._replyCalls.length, 1, 'replay should not reply twice');
  assert.strictEqual(tracked.length, 1, 'replay should not post tracked pick twice');
}

async function testTextAndImageSinglePersistedSet() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';

  const writer = dedupeWriter();
  const tracked = [];
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    createBetWithLegs: writer,
    postPickTracked: async (...args) => tracked.push(args),
  });

  const msg = makeMessage({ messageId: 'mix_1', withImage: true });
  await handleMessage(msg);

  assert.strictEqual(writer.insertedCount(), 1, 'text+image same message should persist only one bet set');
  assert.strictEqual(msg._reactCalls.length, 1, 'single processing should react once');
  assert.strictEqual(msg._replyCalls.length, 1, 'single processing should reply once');
  assert.strictEqual(tracked.length, 1, 'single processing should post one tracked pick');
}

async function testNearSimultaneousReplaySingleSideEffects() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';

  const writer = concurrentSafeWriter();
  const tracked = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    postPickTracked: async (...args) => tracked.push(args),
  });

  const msg = makeMessage({ messageId: 'concurrent_1', withImage: false });
  await Promise.all([handleMessage(msg), handleMessage(msg)]);

  assert.strictEqual(writer.insertedCount(), 1, 'concurrent replay should persist exactly one write');
  assert.strictEqual(msg._reactCalls.length, 1, 'concurrent replay should react once');
  assert.strictEqual(msg._replyCalls.length, 1, 'concurrent replay should reply once');
  assert.strictEqual(tracked.length, 1, 'concurrent replay should post tracked pick once');
}

(async () => {
  await testReplayNoDuplicateSideEffects();
  await testTextAndImageSinglePersistedSet();
  await testNearSimultaneousReplaySingleSideEffects();
  console.log('messageHandler integration validation passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
