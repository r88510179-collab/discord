// ═══════════════════════════════════════════════════════════
// processSlipImage return-contract test.
//
// Regression guard for the /slip command's dead success path: commands/slip.js
// gates on `result.ocrText`, but processSlipImage's return object had silently
// drifted to `{ bets }` (and later `{ bets, drops }`) without ever carrying
// `ocrText` — so every successful /slip scan hit "OCR could not read any text".
// The doc comment above processSlipImage promised `{ bets, ocrText }` the whole
// time; this test pins that contract on BOTH return paths so it can't drift again.
//
// Mocks the handler's heavy deps via require.cache (same technique as
// tests/message-handler.integration.js) so CI never touches OCR/vision/SQLite.
//
// Run:  node tests/slip-ocrtext-return.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Insurance: a valid temp DB_PATH in case any un-stubbed real require touches it.
const DB_FILE = path.join(os.tmpdir(), `slip-ocrtext-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.OCR_FIRST_MODE = 'off'; // keep the (dormant) OCR-first compare block skipped

const KNOWN_OCR = 'PARLAY\nLakers ML -150\nCeltics -3.5 -110';

// Re-require handlers/messageHandler with its leaf deps stubbed. `parseBetText`
// and the OCR text are configurable per case; everything else is a no-op so the
// only thing under test is processSlipImage's own return shape.
function loadHandler({ parseBetText, ocrText }) {
  const P = (m) => path.resolve(__dirname, m);
  const set = (file, exports) => {
    const id = P(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };

  delete require.cache[P('../handlers/messageHandler.js')];

  set('../services/ai.js', {
    parseBetText,
    parseBetSlipImage: async () => ({ bets: [] }),
    evaluateTweet: () => 'valid',
    validateParsedBet: () => ({ valid: true, issues: [] }),
  });
  set('../services/database.js', {
    getOrCreateCapper: async () => ({ id: 'capper_1' }),
    createBetWithLegs: async (b) => ({ id: 'bet_1', description: b.description, _deduped: false }),
    isDuplicateBet: () => false,
    isAuditMode: () => false,
  });
  set('../utils/embeds.js', { betEmbed: (b) => ({ title: b.description }), COLORS: {} });
  set('../services/dashboard.js', { postPickTracked: async () => {} });
  set('../services/warRoom.js', { sendStagingEmbed: async () => {} });
  set('../services/ocr.js', { extractTextFromImage: async () => ocrText });

  // Keep the real pipeline-events module (real makeIngestId + STAGES) but silence
  // its DB writers — the stubbed database has no live `db` handle.
  const pe = require(P('../services/pipeline-events.js'));
  pe.recordStage = () => {};
  pe.recordDrop = () => {};
  pe.recordError = () => {};

  return require(P('../handlers/messageHandler.js'));
}

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

(async () => {
  console.log('processSlipImage return contract (ocrText surfaced for /slip):');

  // ── success: vision yields a bet → { bets:[1], ocrText } ──
  await run('vision yields a bet → result carries the OCR text alongside bets', async () => {
    const h = loadHandler({
      ocrText: KNOWN_OCR,
      parseBetText: async () => ({ bets: [{ sport: 'NBA', league: null, bet_type: 'straight', description: 'Lakers ML', odds: -150, units: 1, legs: [] }] }),
    });
    const res = await h.processSlipImage({}, 'https://example.com/slip.png', 'capper_1', 'Tester', { channelId: 'c', messageId: 'm_ok' });
    assert.ok(res && typeof res === 'object', 'returns an object');
    assert.strictEqual(res.bets.length, 1, 'one saved bet');
    assert.strictEqual(res.ocrText, KNOWN_OCR, 'success path surfaces ocrText (was missing → /slip dead-ended)');
  });

  // ── vision-empty: no bets → { bets:[], ocrText } (the "No bets detected. Raw OCR" branch) ──
  await run('vision yields no bets → result still carries the OCR text for the no-bets echo', async () => {
    const h = loadHandler({ ocrText: KNOWN_OCR, parseBetText: async () => ({ bets: [] }) });
    const res = await h.processSlipImage({}, 'https://example.com/slip.png', 'capper_1', 'Tester', { channelId: 'c', messageId: 'm_empty' });
    assert.strictEqual(res.bets.length, 0, 'no bets');
    assert.strictEqual(res.ocrText, KNOWN_OCR, 'vision-empty path also surfaces ocrText');
  });

  // ── the /slip gate `!result.ocrText` now passes for a real scan ──
  await run('commands/slip.js gate (!result.ocrText) no longer dead-ends a real scan', async () => {
    const h = loadHandler({
      ocrText: KNOWN_OCR,
      parseBetText: async () => ({ bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers ML', odds: -150, units: 1, legs: [] }] }),
    });
    const res = await h.processSlipImage({}, 'https://example.com/slip.png', 'capper_1', 'Tester', { channelId: 'c', messageId: 'm_gate' });
    // mirror commands/slip.js:51 — this used to be unconditionally true (undefined)
    assert.ok(!(!res || !res.ocrText), 'the gate that returned "OCR could not read any text" is no longer hit');
  });

  // ── cleanup ──
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
  }

  console.log(`\nslip-ocrtext-return: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
