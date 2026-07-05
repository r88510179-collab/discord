const assert = require('assert');
const { regexParseBet, looksLikeMultiPick } = require('../services/ai.js');

// ── MUST defer to LLM (return null) ──
const gavin = `So I just took:\nChestnut O 70.5 hotdogs.\nFaded Canada.\nTiafoe ML.\nMbappe to score.\nAnd USA to advance vs Belgium.\nHappy birthday America. -110`;
assert.strictEqual(regexParseBet(gavin), null, 'Gavin multi-pick must defer');
assert.strictEqual(looksLikeMultiPick(gavin), true);
assert.strictEqual(looksLikeMultiPick(`Today's plays:\nLakers -3.5\nChiefs -7\nYankees o8.5`), true, 'colon preamble + 3 picks');
assert.strictEqual(looksLikeMultiPick(`Lakers -3.5\nChiefs -7\nYankees o8.5\nCeltics ML`), true, '4 pick-like lines, no colon');

// ── MUST still parse as one straight (no regression) ──
for (const t of ['Lakers -3.5 -110 2u lock', 'Celtics ML +150 1u', 'Chiefs -7 -115 3u NFL pick', 'Yankees over 8.5 -120 1u MLB']) {
  const r = regexParseBet(t);
  assert.ok(r && r.bets && r.bets.length === 1, `single pick must still parse: "${t}"`);
}
assert.strictEqual(looksLikeMultiPick('Lakers -3.5\n-110 2u'), false, 'single pick wrapped to 2 lines is NOT multi-pick');
assert.strictEqual(looksLikeMultiPick('Lakers -3.5 -110 2u lock'), false, 'one-line pick is not multi-pick');

console.log('regex-multipick: all assertions passed');
