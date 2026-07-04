const assert = require('assert');
const path = require('path');

function loadHandlerWithMocks({ parseBetText, parseBetSlipImage, processImageForAI, createBetWithLegs, sendStagingEmbed, events }) {
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
      // Onyx-vision fix: pure-slip re-extraction calls processImageForAI(url,
      // {skipDedup}) → parseBetSlipImage(base64,...). Default stub returns a fake
      // base64 so the real Sharp/fetch pipeline is bypassed; tests that exercise the
      // re-extraction rely on this default while mocking parseBetSlipImage's bets.
      processImageForAI: processImageForAI || (async () => ({ base64: 'ZmFrZQ==', mediaType: 'image/png' })),
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
  // sendUntrackedWinEmbed is required inline inside processAggregatedMessage's
  // untracked_win branch (F17 test); stub it so the branch's side-effect no-ops.
  require.cache[warRoomPath] = { id: warRoomPath, filename: warRoomPath, loaded: true, exports: { sendStagingEmbed, sendUntrackedWinEmbed: async () => {} } };

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

function makeMessage({
  messageId = 'msg_1',
  withImage = false,
  content = 'Lakers -3.5 -110 1u lock',
  channelId = 'channel_1',
  channelName = 'picks',
  webhookId = undefined,
  bot = false,
  authorId = 'user_1',
} = {}) {
  const replyCalls = [];
  const reactCalls = [];
  const imageMap = new Map();
  if (withImage) {
    imageMap.set('att_1', { contentType: 'image/png', url: 'https://example.com/slip.png' });
  }

  return {
    guild: { id: 'guild_1' },
    id: messageId,
    webhookId,
    content,
    channel: { id: channelId, name: channelName },
    attachments: imageMap,
    embeds: [],
    reference: null,
    createdTimestamp: Date.now(),
    author: {
      id: authorId,
      bot,
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

// getImageAttachments tags origin so OCR-first multi-image eligibility counts
// REAL slip attachments and ignores share-embed thumbnails. This guards the
// contract end-to-end: the HRB shape (1 slip attachment + 1 share-embed
// thumbnail) must tag origins correctly so eligibleImageCount collapses it to 1.
async function testGetImageAttachmentsTagsOrigin() {
  const { getImageAttachments } = loadHandlerWithMocks({
    parseBetText: async () => ({ is_bet: false }),
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: dedupeWriter(),
    sendStagingEmbed: async () => {},
  });
  const { eligibleImageCount } = require('../services/ocrFirstWiring');

  // HRB shape: one real slip attachment + one Discord share-embed thumbnail.
  const atts = new Map();
  atts.set('a1', { contentType: 'image/webp', url: 'https://cdn.discordapp.com/attachments/1/2/slip.webp' });
  const hrb = {
    attachments: atts,
    embeds: [{ image: { url: 'https://media.discordapp.net/external/abc/share-card.png' } }],
  };
  const imgs = getImageAttachments(hrb);
  assert.strictEqual(imgs.length, 2, 'getImageAttachments still surfaces both images');
  assert.strictEqual(imgs[0].origin, 'attachment', 'direct upload tagged origin=attachment');
  assert.strictEqual(imgs[1].origin, 'embed', 'share-embed thumbnail tagged origin=embed');
  assert.strictEqual(eligibleImageCount(imgs), 1, 'HRB slip+embed collapses to 1 (scope=single)');

  // A genuine 2-attachment post must stay multi.
  const twoAtts = new Map();
  twoAtts.set('a1', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/slipA.png' });
  twoAtts.set('a2', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/3/slipB.png' });
  const multi = getImageAttachments({ attachments: twoAtts, embeds: [] });
  assert.strictEqual(multi.every((i) => i.origin === 'attachment'), true, 'both real uploads tagged attachment');
  assert.strictEqual(eligibleImageCount(multi), 2, 'two real attachments stay multi');
}

// ── GUARD 5 human bare-total bypass (incident 2026-06-11) ───────────────────
// A bare total ("MLB: Yankees Cleveland O7.5") scores 0 pick signals, so GUARD 5
// would drop it. In a DUBCLUB_SPLIT_CHANNEL_IDS channel a human-typed bare total
// IS a complete pick: the bypass must route it to processAggregatedMessage just
// like a webhook post. Outside those channels the heuristic still drops it — now
// with the queryable GUARD5_INSUFFICIENT_SIGNALS reason instead of a silent loss.

// 1. Human bare total in a DubClub-split channel → bypasses GUARD 5, reaches the
//    AI parser, persists. (channel is also in HUMAN_SUBMISSION so the human author
//    is authorized — exactly the live #lockedin-slips config.)
async function testDubclubHumanBareTotalBypassesGuard5() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'dubclub_ch';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = 'dubclub_ch';
  process.env.PURE_SLIP_CHANNEL_IDS = '';
  process.env.PICKS_CHANNEL_IDS = '';

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  let parseCalls = 0;
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => { parseCalls += 1; return { bets: [{ sport: 'MLB', bet_type: 'straight', description: 'Yankees/Cleveland Over 7.5', odds: null, units: 1, legs: [] }] }; },
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'dub_human_total_1', content: 'MLB: Yankees Cleveland O7.5', channelId: 'dubclub_ch', channelName: 'lockedin-slips' });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(!events.some(e => e.fn === 'drop' && e.dropReason === 'GUARD5_INSUFFICIENT_SIGNALS'), 'human bare total in a DubClub-split channel must NOT be dropped by GUARD 5');
  assert.strictEqual(parseCalls, 1, 'human bare total must reach the AI parser (bypass routed it to processAggregatedMessage)');
  assert.strictEqual(writer.insertedCount(), 1, 'human bare total must persist as a bet');
  assert.strictEqual(staged.length, 1, 'human bare total must stage one War Room embed');
}

// 2. Human bare total in a NON-DubClub channel → still rejected, but now emits a
//    DROP with the new GUARD5_INSUFFICIENT_SIGNALS reason (no silent loss).
async function testHumanBareTotalNonCapperDropped() {
  process.env.PICKS_CHANNEL_IDS = 'picks_ch';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = '';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  process.env.PURE_SLIP_CHANNEL_IDS = '';

  const events = [];
  const writer = dedupeWriter();
  let parseCalls = 0;
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => { parseCalls += 1; return { bets: [] }; },
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId: 'noncapper_total_1', content: 'MLB: Reds Padres O8.5', channelId: 'picks_ch', channelName: 'general-picks' });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'GUARD5_INSUFFICIENT_SIGNALS');
  assert.ok(drop, 'human bare total in a non-DubClub channel must drop with GUARD5_INSUFFICIENT_SIGNALS');
  assert.strictEqual(parseCalls, 0, 'GUARD 5 drop must happen before the AI parser');
  assert.strictEqual(writer.insertedCount(), 0, 'rejected bare total must not persist a bet');
}

// 3. Webhook bare total in a DubClub-split channel → behavior unchanged: still
//    bypasses GUARD 5 (empty image arg, exactly as ffddb09) and persists.
async function testDubclubWebhookBareTotalUnchanged() {
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'dubclub_ch';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = 'dubclub_ch';
  process.env.PURE_SLIP_CHANNEL_IDS = '';
  process.env.PICKS_CHANNEL_IDS = '';
  process.env.ALLOWED_WEBHOOK_IDS = 'wh_1';

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  let parseCalls = 0;
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => { parseCalls += 1; return { bets: [{ sport: 'MLB', bet_type: 'straight', description: 'Red Sox/Rays Over 7.5', odds: null, units: 1, legs: [] }] }; },
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'dub_webhook_total_1', content: 'MLB: Red Sox Rays O7.5', channelId: 'dubclub_ch', channelName: 'lockedin-slips', webhookId: 'wh_1', bot: true, authorId: 'wh_user' });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(!events.some(e => e.fn === 'drop' && e.dropReason === 'GUARD5_INSUFFICIENT_SIGNALS'), 'webhook bare total must keep bypassing GUARD 5 (unchanged)');
  assert.strictEqual(parseCalls, 1, 'webhook bare total still routed through processAggregatedMessage');
  assert.strictEqual(writer.insertedCount(), 1, 'webhook bare total persists as a bet (unchanged)');
  assert.strictEqual(staged.length, 1, 'webhook bare total stages one War Room embed (unchanged)');
}

// ── F17: silent vision-extraction loss in the relay-image path ──────────────
// audit 2026-06-16: 65 relay/image ingests traversed RECEIVED→AUTHORIZED→BUFFERED→
// EXTRACTED then vanished — zero bets, NO terminal pipeline_event. The cause: three
// post-EXTRACTED `return`s in processAggregatedMessage (vision classified the parse as
// type:'result' / type:'untracked_win' / ticket_status:winner|loser) plus the narrow
// is_bet===true && bets:[] fall-through, none of which recorded a terminal event. Each
// must now record a terminal DROP. These tests drive a real image message through the
// buffer→processAggregatedMessage path with a mocked parseBetText that forces each
// classification, and assert the ingest reaches EXTRACTED AND a terminal event.
//
// Every assertion below FAILS on pre-fix code (no terminal event recorded) except the
// thrown-error guard, which documents the pre-existing EXCEPTION_THROWN coverage.
async function runVisionRelayMessage(parseBetText, messageId) {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = '';
  process.env.PURE_SLIP_CHANNEL_IDS = '';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const events = [];
  const writer = dedupeWriter();
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText,
    parseBetSlipImage: async () => ({ bets: [] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async () => {},
    events,
  });

  const msg = makeMessage({ messageId, withImage: true });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));
  return { events, writer };
}

// 1. Vision says type:'result' → terminal DROP VISION_RESULT_RECAP (was a silent return).
async function testVisionResultRecapRecordsDrop() {
  const { events, writer } = await runVisionRelayMessage(
    async () => ({ type: 'result', outcome: 'win', subject: [] }),
    'f17_result_1',
  );
  assert.ok(countStage(events, 'EXTRACTED') >= 1, 'image message must reach the EXTRACTED stage (vision path)');
  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'VISION_RESULT_RECAP');
  assert.ok(drop, 'vision type:result must record a terminal DROP VISION_RESULT_RECAP (FAILS pre-fix)');
  assert.strictEqual(drop.stage, 'DROPPED', 'VISION_RESULT_RECAP must be a DROPPED-stage DROP');
  assert.strictEqual(writer.insertedCount(), 0, 'result recap must not persist a bet (no behavior change)');
}

// 2. Vision says type:'untracked_win' → terminal DROP VISION_UNTRACKED_WIN.
async function testVisionUntrackedWinRecordsDrop() {
  const { events, writer } = await runVisionRelayMessage(
    async () => ({ type: 'untracked_win', description: 'Someone hit a +1200 parlay' }),
    'f17_untracked_1',
  );
  assert.ok(countStage(events, 'EXTRACTED') >= 1, 'image message must reach the EXTRACTED stage (vision path)');
  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'VISION_UNTRACKED_WIN');
  assert.ok(drop, 'vision type:untracked_win must record a terminal DROP VISION_UNTRACKED_WIN (FAILS pre-fix)');
  assert.strictEqual(writer.insertedCount(), 0, 'untracked win must not persist a bet (no behavior change)');
}

// 3. Vision says ticket_status:'winner' → terminal DROP VISION_TICKET_RECAP.
async function testVisionTicketRecapRecordsDrop() {
  const { events, writer } = await runVisionRelayMessage(
    async () => ({ ticket_status: 'winner', bets: [] }),
    'f17_ticket_1',
  );
  assert.ok(countStage(events, 'EXTRACTED') >= 1, 'image message must reach the EXTRACTED stage (vision path)');
  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'VISION_TICKET_RECAP');
  assert.ok(drop, 'vision ticket_status:winner must record a terminal DROP VISION_TICKET_RECAP (FAILS pre-fix)');
  assert.strictEqual(writer.insertedCount(), 0, 'ticket recap must not persist a bet (no behavior change)');
}

// 4. Vision says is_bet:true with an empty bets array (normalizeBet filtered all out) →
//    the only way past the is_bet=false + indeterminate guards with no bets. Terminal DROP
//    PRE_FILTER_AI_EMPTY_RESULT tagged filter:'ai_is_bet_true_no_bets'.
async function testVisionIsBetTrueNoBetsRecordsDrop() {
  const { events, writer } = await runVisionRelayMessage(
    async () => ({ is_bet: true, bets: [] }),
    'f17_isbettrue_empty_1',
  );
  assert.ok(countStage(events, 'EXTRACTED') >= 1, 'image message must reach the EXTRACTED stage (vision path)');
  const drop = events.find(e => e.fn === 'drop'
    && e.dropReason === 'PRE_FILTER_AI_EMPTY_RESULT'
    && e.payload?.filter === 'ai_is_bet_true_no_bets');
  assert.ok(drop, 'is_bet=true with empty bets must record a terminal DROP (FAILS pre-fix)');
  assert.strictEqual(writer.insertedCount(), 0, 'empty-bets extraction must not persist a bet');
}

// 5. Regression guard (NOT a fix): a thrown vision parse is ALREADY terminal via the outer
//    catch (EXCEPTION_THROWN). Documents the prompt's "(b) thrown error" case — passes pre AND
//    post-fix, proving the exception path was never the silent hole (the recap returns were).
async function testVisionThrowRecordsError() {
  const { events, writer } = await runVisionRelayMessage(
    async () => { throw new Error('vision backend exploded'); },
    'f17_throw_1',
  );
  assert.ok(countStage(events, 'EXTRACTED') >= 1, 'image message must reach the EXTRACTED stage (vision path)');
  const err = events.find(e => e.fn === 'error' && e.dropReason === 'EXCEPTION_THROWN');
  assert.ok(err, 'a thrown vision parse must record a terminal EXCEPTION_THROWN event');
  assert.strictEqual(writer.insertedCount(), 0, 'a thrown vision parse must not persist a bet');
}

// ── Onyx-vision fix: pure-slip authoritative re-extraction ──────────────────
// In pure-slip capper channels the win-classifier (parseBetText) mislabels an
// OPEN Onyx "Pick Receipt" (green ✓ on every placed pick) as type:'result' /
// 'untracked_win' with bets:[] — the legs are discarded and the ingest diverts
// (VISION_RESULT_RECAP / VISION_UNTRACKED_WIN) with no tracked bet. The fix, in a
// PURE_SLIP channel with images, re-runs bets-only parseBetSlipImage and stages
// the recovered bet through the TYPE 1 vision_slip path instead of diverting.

// A. pure-slip + image + parseBetText→untracked_win(bets:[]) + parseBetSlipImage→1 bet
//    ⇒ bet staged, NO untracked_win divert, exactly one reclassify marker.
async function testPureSlipReclassifiesUntrackedWinToStagedBet() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'channel_1';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  let slipCalls = 0;
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ type: 'untracked_win', description: 'Onyx pick receipt', outcome: 'win', subject: ['Lakers'], bets: [] }),
    parseBetSlipImage: async () => { slipCalls += 1; return { bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }; },
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'onyx_untracked_1', withImage: true });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.ok(slipCalls >= 1, 'pure-slip untracked_win must invoke parseBetSlipImage for authoritative re-extraction');
  assert.ok(!events.some(e => e.fn === 'drop' && e.dropReason === 'VISION_UNTRACKED_WIN'), 'recovered pure-slip bet must NOT divert to VISION_UNTRACKED_WIN');
  assert.strictEqual(countStage(events, 'PURE_SLIP_RECLASSIFIED_EXTRACT'), 1, 'exactly one PURE_SLIP_RECLASSIFIED_EXTRACT marker');
  assert.strictEqual(writer.insertedCount(), 1, 're-extracted bet must be staged via createBetWithLegs');
  assert.strictEqual(staged.length, 1, 're-extracted bet must send exactly one War Room staging embed');
  assert.ok(events.some(e => e.stage === 'STAGED'), 're-extracted bet must emit a STAGED pipeline event');
}

// B. NON-pure-slip channel, same mocks ⇒ CURRENT behavior preserved: diverts to
//    VISION_UNTRACKED_WIN, re-extraction never runs, no bet staged.
async function testNonPureSlipUntrackedWinStillDiverts() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = '';
  process.env.PURE_SLIP_CHANNEL_IDS = '';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  let slipCalls = 0;
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ type: 'untracked_win', description: 'Onyx pick receipt', outcome: 'win', subject: ['Lakers'], bets: [] }),
    parseBetSlipImage: async () => { slipCalls += 1; return { bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }; },
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'nonpure_untracked_1', withImage: true });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'VISION_UNTRACKED_WIN');
  assert.ok(drop, 'non-pure-slip untracked_win must divert to VISION_UNTRACKED_WIN (unchanged)');
  assert.strictEqual(slipCalls, 0, 'non-pure-slip channel must NOT run parseBetSlipImage re-extraction');
  assert.strictEqual(countStage(events, 'PURE_SLIP_RECLASSIFIED_EXTRACT'), 0, 'non-pure-slip must not emit the reclassify marker');
  assert.strictEqual(writer.insertedCount(), 0, 'non-pure-slip untracked_win must not stage a bet');
  assert.strictEqual(staged.length, 0, 'non-pure-slip untracked_win must not send a staging embed');
}

// C. pure-slip + image + parseBetText→result(bets:[]) + parseBetSlipImage→1 bet
//    ⇒ bet staged, NO VISION_RESULT_RECAP divert (so autoGradeFromRecap is skipped).
async function testPureSlipReclassifiesResultToStagedBet() {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = 'channel_1';
  process.env.PURE_SLIP_CHANNEL_IDS = 'channel_1';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake') });

  const events = [];
  const writer = dedupeWriter();
  const staged = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => ({ type: 'result', outcome: 'win', subject: ['Lakers'], bets: [] }),
    parseBetSlipImage: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3.5', odds: -110, units: 1, legs: [] }] }),
    createBetWithLegs: writer,
    sendStagingEmbed: async (...args) => staged.push(args),
    events,
  });

  const msg = makeMessage({ messageId: 'onyx_result_1', withImage: true });
  await handleMessage(msg);
  await new Promise((resolve) => setTimeout(resolve, 4500));

  assert.ok(!events.some(e => e.fn === 'drop' && e.dropReason === 'VISION_RESULT_RECAP'), 'recovered pure-slip bet must NOT divert to VISION_RESULT_RECAP (no autograde)');
  assert.strictEqual(countStage(events, 'PURE_SLIP_RECLASSIFIED_EXTRACT'), 1, 'exactly one PURE_SLIP_RECLASSIFIED_EXTRACT marker on the result path');
  assert.strictEqual(writer.insertedCount(), 1, 're-extracted result bet must be staged');
  assert.strictEqual(staged.length, 1, 're-extracted result bet must send one staging embed');
}

(async () => {
  await testGetImageAttachmentsTagsOrigin();
  await testPureSlipReclassifiesUntrackedWinToStagedBet();
  await testNonPureSlipUntrackedWinStillDiverts();
  await testPureSlipReclassifiesResultToStagedBet();
  await testVisionResultRecapRecordsDrop();
  await testVisionUntrackedWinRecordsDrop();
  await testVisionTicketRecapRecordsDrop();
  await testVisionIsBetTrueNoBetsRecordsDrop();
  await testVisionThrowRecordsError();
  await testReplayNoDuplicateSideEffects();
  await testTextAndImageSinglePersistedSet();
  await testNearSimultaneousReplaySingleSideEffects();
  await testPureSlipSkipsHoldOnIsBetFalse();
  await testPureSlipSkipsHoldOnIndeterminate();
  await testPureSlipValidBetsUnchanged();
  await testNonBypassChannelStillHolds();
  await testEmptyPureSlipUnchanged();
  await testDubclubHumanBareTotalBypassesGuard5();
  await testHumanBareTotalNonCapperDropped();
  await testDubclubWebhookBareTotalUnchanged();
  console.log('messageHandler integration validation passed.');
  // Production handler installs a 10-minute alertCooldowns prune setInterval that
  // keeps the event loop alive. Force-exit so the test runner advances.
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
