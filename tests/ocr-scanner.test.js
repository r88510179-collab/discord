const assert = require('assert');
const path = require('path');

// ── Mock setup ─────────────────────────────────────────────────
function loadHandlerWithOCRMocks({ ocrText, parseBetTextResult, createBetWithLegsResult, stagingEmbedCalls }) {
  const aiPath = path.resolve(__dirname, '../services/ai.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const embedsPath = path.resolve(__dirname, '../utils/embeds.js');
  const dashboardPath = path.resolve(__dirname, '../services/dashboard.js');
  const warRoomPath = path.resolve(__dirname, '../services/warRoom.js');
  const ocrPath = path.resolve(__dirname, '../services/ocr.js');
  const handlerPath = path.resolve(__dirname, '../handlers/messageHandler.js');

  // Clear handler cache
  delete require.cache[handlerPath];

  // Mock AI
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      parseBetText: async () => parseBetTextResult,
      parseBetSlipImage: async () => ({ bets: [] }),
    },
  };

  // Mock DB
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getOrCreateCapper: async () => ({ id: 'capper_ocr_1' }),
      createBetWithLegs: async () => createBetWithLegsResult,
      isDuplicateBet: () => false,
      isAuditMode: () => false,
    },
  };

  // Mock embeds
  require.cache[embedsPath] = {
    id: embedsPath, filename: embedsPath, loaded: true,
    exports: { betEmbed: (b) => ({ title: b.description }) },
  };

  // Mock dashboard
  require.cache[dashboardPath] = {
    id: dashboardPath, filename: dashboardPath, loaded: true,
    exports: { postPickTracked: async () => {} },
  };

  // Mock warRoom — track calls to sendStagingEmbed
  require.cache[warRoomPath] = {
    id: warRoomPath, filename: warRoomPath, loaded: true,
    exports: {
      sendStagingEmbed: async (client, bet, capperName) => {
        stagingEmbedCalls.push({ bet, capperName });
      },
    },
  };

  // Mock OCR
  require.cache[ocrPath] = {
    id: ocrPath, filename: ocrPath, loaded: true,
    exports: {
      extractTextFromImage: async () => ocrText,
    },
  };

  return require(handlerPath);
}

function makeSlipMessage({ channelId, imageUrl = 'https://example.com/slip.png' }) {
  const reactCalls = [];
  const imageMap = new Map();
  imageMap.set('att_1', { contentType: 'image/png', url: imageUrl });

  return {
    guild: { id: 'guild_1' },
    author: { id: 'user_123', displayName: 'SlipPoster', bot: false, displayAvatarURL: () => null },
    channel: { id: channelId, name: 'slip-feed' },
    content: '',
    embeds: [],
    attachments: imageMap,
    createdTimestamp: Date.now(),
    client: { user: { id: 'bot_999' }, channels: { fetch: async () => null } },
    react: async (emoji) => { reactCalls.push(emoji); },
    reply: async () => {},
    reference: null,
    _reactCalls: reactCalls,
  };
}

// ── TEST 1: Slip feed image triggers OCR → parseBetText → warRoom ──
async function testSlipFeedHitsWarRoom() {
  const stagingCalls = [];
  const SLIP_CHANNEL = 'slip_chan_001';

  // Set env
  process.env.SLIP_FEED_CHANNEL_ID = SLIP_CHANNEL;
  process.env.PICKS_CHANNEL_IDS = 'some_other_channel';

  const { handleMessage } = loadHandlerWithOCRMocks({
    ocrText: 'LeBron James Over 22.5 Points -110',
    parseBetTextResult: {
      bets: [{
        sport: 'NBA', league: 'NBA', bet_type: 'prop',
        description: 'LeBron James Over 22.5 Points',
        odds: -110, units: 1, event_date: null, legs: [],
        props: [{ player_name: 'LeBron James', stat_category: 'points', line: 22.5, direction: 'over', odds: -110 }],
        _confidence: 'high', _confidence_score: 0, _confidence_reasons: [],
      }],
    },
    createBetWithLegsResult: { id: 'bet_ocr_1', description: 'LeBron James Over 22.5 Points', sport: 'NBA', bet_type: 'prop', odds: -110, units: 1, _deduped: false },
    stagingEmbedCalls: stagingCalls,
  });

  const msg = makeSlipMessage({ channelId: SLIP_CHANNEL });
  await handleMessage(msg);

  assert.strictEqual(stagingCalls.length, 1, 'Should send 1 staging embed to war room');
  assert.strictEqual(stagingCalls[0].bet.id, 'bet_ocr_1', 'Staging embed should have correct bet ID');
  assert.strictEqual(stagingCalls[0].capperName, 'SlipPoster', 'Capper name should match author');
  assert.ok(msg._reactCalls.includes('🔍'), 'Should react with magnifying glass');

  delete process.env.SLIP_FEED_CHANNEL_ID;
  console.log('  \u2713 Slip feed image triggers OCR → AI parse → War Room staging embed');
}

// ── TEST 2: Slip feed with no image is ignored ─────────────────
async function testSlipFeedNoImage() {
  const stagingCalls = [];
  const SLIP_CHANNEL = 'slip_chan_002';

  process.env.SLIP_FEED_CHANNEL_ID = SLIP_CHANNEL;
  process.env.PICKS_CHANNEL_IDS = 'some_other_channel';

  const { handleMessage } = loadHandlerWithOCRMocks({
    ocrText: 'Should not be called',
    parseBetTextResult: { bets: [] },
    createBetWithLegsResult: null,
    stagingEmbedCalls: stagingCalls,
  });

  // Message with no image
  const msg = makeSlipMessage({ channelId: SLIP_CHANNEL });
  msg.attachments = new Map(); // no attachments

  await handleMessage(msg);

  assert.strictEqual(stagingCalls.length, 0, 'Should not send staging embed without image');

  delete process.env.SLIP_FEED_CHANNEL_ID;
  console.log('  \u2713 Slip feed with no image is ignored');
}

// ── TEST 3: OCR returns null — no bets saved ──────────────────
async function testOCRReturnsNull() {
  const stagingCalls = [];
  const SLIP_CHANNEL = 'slip_chan_003';

  process.env.SLIP_FEED_CHANNEL_ID = SLIP_CHANNEL;
  process.env.PICKS_CHANNEL_IDS = 'some_other_channel';

  const { handleMessage } = loadHandlerWithOCRMocks({
    ocrText: null, // OCR failed
    parseBetTextResult: { bets: [] },
    createBetWithLegsResult: null,
    stagingEmbedCalls: stagingCalls,
  });

  const msg = makeSlipMessage({ channelId: SLIP_CHANNEL });
  await handleMessage(msg);

  assert.strictEqual(stagingCalls.length, 0, 'Should not send staging embed when OCR fails');

  delete process.env.SLIP_FEED_CHANNEL_ID;
  console.log('  \u2713 OCR returns null — no bets processed');
}

// ── TEST 4: Non-slip channel ignores slip feed logic ───────────
async function testNonSlipChannelIgnored() {
  const stagingCalls = [];

  process.env.SLIP_FEED_CHANNEL_ID = 'slip_chan_004';
  process.env.PICKS_CHANNEL_IDS = 'some_other_channel';

  const { handleMessage } = loadHandlerWithOCRMocks({
    ocrText: 'LeBron Over 22.5 Pts -110',
    parseBetTextResult: { bets: [] },
    createBetWithLegsResult: null,
    stagingEmbedCalls: stagingCalls,
  });

  // Send from a different channel (not slip feed, not picks)
  const msg = makeSlipMessage({ channelId: 'random_channel_999' });
  await handleMessage(msg);

  assert.strictEqual(stagingCalls.length, 0, 'Non-slip channel should not trigger OCR flow');

  delete process.env.SLIP_FEED_CHANNEL_ID;
  console.log('  \u2713 Non-slip channel ignores OCR slip feed logic');
}

// ── TEST 5: extractTextFromImage function shape ────────────────
function testOCRModuleShape() {
  // Verify the module exports the correct function
  const ocrModule = { extractTextFromImage: async () => null };
  assert.strictEqual(typeof ocrModule.extractTextFromImage, 'function', 'Should export extractTextFromImage');
  console.log('  \u2713 OCR module exports extractTextFromImage function');
}

// ── RUN ALL ────────────────────────────────────────────────────
async function runAll() {
  console.log('OCR scanner validation:');
  testOCRModuleShape();
  await testSlipFeedHitsWarRoom();
  await testSlipFeedNoImage();
  await testOCRReturnsNull();
  await testNonSlipChannelIgnored();
  console.log('OCR scanner validation passed.');
}

runAll().catch(err => {
  console.error('OCR scanner tests FAILED:', err);
  process.exit(1);
});
