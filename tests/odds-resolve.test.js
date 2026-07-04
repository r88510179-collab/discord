// Smoke test for resolveOdds (services/ai.js) — the odds-resolution fix that
// replaced the fabricated -110 default / >9999 clamp. American odds are always
// |o| >= 100; unknown odds must resolve to null, NEVER a fabricated -110 (a
// fabricated -110 silently corrupts P&L — a winning +10372 would grade +0.91u).
// See prompts/fix-intake-doubling-odds.md.
const assert = require('assert');
const { resolveOdds } = require('../services/ai.js');

// Cape Verde class: all legs priced → exact combination
assert.strictEqual(resolveOdds({ bet_type:'parlay', legs:[{odds:180},{odds:750},{odds:340}], wager:100, payout:10472 }), 10372);
// Same, but model emitted a stale -110 top-level default → still combines to 10372
assert.strictEqual(resolveOdds({ bet_type:'parlay', odds:-110, legs:[{odds:180},{odds:750},{odds:340}], wager:100, payout:10472 }), 10372);
// Cody SGP class: legs unpriced (correlated), derive from total payout. 100→284 = +184 exact.
assert.strictEqual(resolveOdds({ bet_type:'parlay', odds:-110, legs:[{odds:null},{odds:null},{odds:null}], wager:100, payout:284 }), 184);
// A sub-100 junk leg (invalid American: |o|<100) makes the leg-combination unpriced,
// so we DON'T compute garbage combined odds — fall through to payout derivation (→184),
// not the +1748 a naive combine of [180,50,340] would produce.
assert.strictEqual(resolveOdds({ bet_type:'parlay', legs:[{odds:180},{odds:50},{odds:340}], wager:100, payout:284 }), 184);
// Straight with a real -110 → kept
assert.strictEqual(resolveOdds({ bet_type:'straight', odds:-110 }), -110);
// Straight, no odds, derive from payout: 50→100 = +100
assert.strictEqual(resolveOdds({ bet_type:'straight', odds:null, wager:50, payout:100 }), 100);
// Decimal-odds confusion (2.84 is not valid American) → rejected, no payout → null
assert.strictEqual(resolveOdds({ bet_type:'straight', odds:2.84 }), null);
// Nothing usable → null, NOT -110
assert.strictEqual(resolveOdds({ bet_type:'parlay', odds:null, legs:[], wager:null, payout:null }), null);

console.log('odds-resolve: all assertions passed');
