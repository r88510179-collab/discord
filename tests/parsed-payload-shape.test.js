// Verifies the PARSED pipeline_events payload shape produced by
// handlers/messageHandler.js#buildParsedPayload.
//
// Background: a v340 production trace showed
//   PARSED payload={"type":"bet","isBet":false,"betCount":1,"ticketStatus":"new"}
// because parseBetText's normalizeParsedBets() strips `is_bet` from the
// returned object. The fix drops `isBet` from the payload entirely; the
// new invariant is that `type` and `betCount` cannot disagree.

const assert = require('assert');
const { buildParsedPayload } = require('../handlers/messageHandler');

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

check('one parsed bet — payload reports betCount:1, no isBet field', () => {
  // Mirrors the post-normalizeParsedBets shape that triggered the prod bug:
  // is_bet missing, type set to 'bet', bets has one entry.
  const parsed = { type: 'bet', bets: [{ description: 'Lakers -3.5' }] };
  const out = buildParsedPayload(parsed);
  assert.strictEqual(out.type, 'bet');
  assert.strictEqual(out.betCount, 1);
  assert.strictEqual(out.ticketStatus, 'new');
  assert.ok(!('isBet' in out), 'isBet must not appear in the payload');
});

check('zero bets — payload reports betCount:0, no isBet field', () => {
  const parsed = { type: 'ignore', bets: [] };
  const out = buildParsedPayload(parsed);
  assert.strictEqual(out.type, 'ignore');
  assert.strictEqual(out.betCount, 0);
  assert.strictEqual(out.ticketStatus, 'new');
  assert.ok(!('isBet' in out), 'isBet must not appear in the payload');
});

check('multi-bet parlay carries through betCount and ticketStatus', () => {
  const parsed = {
    type: 'bet',
    bets: [{ description: 'A' }, { description: 'B' }, { description: 'C' }],
    ticket_status: 'winner',
  };
  const out = buildParsedPayload(parsed);
  assert.strictEqual(out.betCount, 3);
  assert.strictEqual(out.ticketStatus, 'winner');
});

check('missing type defaults to bet (preserves prior emit behavior)', () => {
  const out = buildParsedPayload({ bets: [{}] });
  assert.strictEqual(out.type, 'bet');
});

console.log('parsed-payload-shape validation passed.');
