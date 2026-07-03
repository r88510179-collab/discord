// ═══════════════════════════════════════════════════════════
// P1 — pure ai.js guards:
//   (A) reassignDollarStakeUnits — the twitter TEXT-path dollar-stake fix.
//       The TEXT path bypasses normalizeBet's [0.01,100] units clamp, so a
//       model reading "$5,000 on X" as units sent units=5000 to the insert
//       (bet 3e5c01a0). When a raw dollar amount equals the parsed units, move
//       it to `wager` and reset units to 1.
//   (B) validateParsedBet TEASE_NO_SELECTION — a promo tease ("find out here")
//       that names no selection (no odds, no market token) is not a bet
//       (bet 3f78b923: "…50 units pending on an NBA Champion. Find out here."
//       graded a bare "NBA Champion" WIN pre-gates).
//
// Pure — no DB, no network. Run: node tests/p1-dollar-stake-tease.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Throwaway DB before requiring ai.js (it transitively pulls database.js via
// pipeline-events). These tests are pure — the DB is never touched — but this
// keeps the migrator off the repo-root bettracker.db.
const DB_FILE = path.join(os.tmpdir(), `p1-dollar-tease-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { reassignDollarStakeUnits, validateParsedBet } = require('../services/ai');

// Pin season checks (validateParsedBet runs an offseason gate AFTER the tease
// guard). May 7 2026 → NBA in season, so a non-tease NBA pick is not offseason-
// dropped and the tease reason is isolated.
const TEST_NOW = new Date(2026, 4, 7);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e && e.stack ? e.stack : e}`); failed++; }
}

console.log('P1 (A) reassignDollarStakeUnits:');

// ── The 3e5c01a0 repro: "$5,000" mis-parsed as units=5000 → wager 5000, units 1
run('3e5c01a0 raw string → wager 5000, units 1', () => {
  const pick = { description: 'Spurs moneyline', units: 5000, odds: '-110' };
  reassignDollarStakeUnits(pick, 'I have $5,000 on Spurs moneyline.');
  assert.strictEqual(pick.wager, 5000, 'dollar stake moved to wager');
  assert.strictEqual(pick.units, 1, 'units reset to 1');
});

// ── comma + decimal variants
run('$5000 (no comma) equal to units → reassigns', () => {
  const pick = { description: 'X', units: 5000 };
  reassignDollarStakeUnits(pick, 'dropping $5000 on the over');
  assert.strictEqual(pick.wager, 5000);
  assert.strictEqual(pick.units, 1);
});
run('$100.00 equal to units → reassigns (decimal)', () => {
  const pick = { description: 'X', units: 100 };
  reassignDollarStakeUnits(pick, '$100.00 play');
  assert.strictEqual(pick.wager, 100);
  assert.strictEqual(pick.units, 1);
});

// ── conservative: no `$`, or dollar ≠ units → UNTOUCHED
run('real "5u" (no dollar sign) → untouched', () => {
  const pick = { description: 'Lakers ML', units: 5 };
  reassignDollarStakeUnits(pick, '5u on Lakers ML');
  assert.strictEqual(pick.units, 5, 'legit unit figure preserved');
  assert.strictEqual(pick.wager, undefined, 'no wager invented');
});
run('dollar present but != units → untouched ("$100 to win, 2u play")', () => {
  const pick = { description: 'X', units: 2 };
  reassignDollarStakeUnits(pick, '$100 to win, 2u play');
  assert.strictEqual(pick.units, 2, 'units untouched when dollar != units');
  assert.strictEqual(pick.wager, undefined);
});
run('real capper "50 units" with no $50 → untouched (B3)', () => {
  const pick = { description: 'NBA Champion', units: 50 };
  reassignDollarStakeUnits(pick, 'I have 50 units pending on an NBA Champion.');
  assert.strictEqual(pick.units, 50);
  assert.strictEqual(pick.wager, undefined);
});
run('ladder pick with no top-level units → no-op', () => {
  const pick = { is_ladder: true, ladder_steps: [{ description: 'x', units: 4 }] };
  const r = reassignDollarStakeUnits(pick, '$5,000 whatever');
  assert.strictEqual(r, pick, 'returns pick unchanged');
  assert.strictEqual(pick.units, undefined);
});
run('units as numeric string "5000" still reassigns', () => {
  const pick = { description: 'X', units: '5000' };
  reassignDollarStakeUnits(pick, '$5,000 on it');
  assert.strictEqual(pick.wager, 5000);
  assert.strictEqual(pick.units, 1);
});

console.log('\nP1 (B) validateParsedBet TEASE_NO_SELECTION:');

// ── The 3f78b923 repro → fails TEASE_NO_SELECTION
run('3f78b923 raw fails TEASE_NO_SELECTION', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'NBA Champion', odds: null, units: 50, legs: [] };
  const r = validateParsedBet(pick, "It's official.\n\nI have 50 units pending on an NBA Champion.\n\nFind out here.", { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'TEASE_NO_SELECTION');
});

// ── passes: market token present in description (Spurs ML) even with a tease phrase
run('"Spurs ML -110" with tease phrase passes (market token + odds present)', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'Spurs ML', odds: '-110', units: 1, legs: [{ description: 'Spurs ML', team: 'Spurs' }] };
  const r = validateParsedBet(pick, '50 units on Spurs ML -110. Find out here.', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});

// ── passes: odds present (futures with a real price) even with a tease phrase
run('"Thunder to win the title +450" with tease phrase passes (odds present)', () => {
  const pick = { sport: 'NBA', type: 'future', description: 'Thunder to win the title', odds: '+450', units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Thunder to win the title +450 — link in bio', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});

// ── plain prompt strings (no tease phrase) pass trivially — guard inactive
run('"50 units on Spurs ML -110" (no tease phrase) passes', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'Spurs ML', odds: '-110', units: 1, legs: [{ description: 'Spurs ML', team: 'Spurs' }] };
  const r = validateParsedBet(pick, '50 units on Spurs ML -110', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});
run('"Thunder to win the title +450" (no tease phrase) passes', () => {
  const pick = { sport: 'NBA', type: 'future', description: 'Thunder to win the title', odds: '+450', units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Thunder to win the title +450', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});

// ── slip-share exemption: a real slip image with "full card" caption still extracts
run('tease phrase + no selection but hasMedia → NOT teased (slip exemption)', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'NBA Champion', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Full card on the slip 🔒 find out here', { hasMedia: true, now: TEST_NOW });
  // hasMedia short-circuits the tease guard; the placeholder/entity checks then
  // pass (empty legs, slipExempt), so it is not rejected for TEASE_NO_SELECTION.
  assert.notStrictEqual(r.reason, 'TEASE_NO_SELECTION', `must not tease-reject a slip share, got ${JSON.stringify(r)}`);
});

// ── market-token-only exemption: tease + no odds but a real market token in desc
run('tease phrase + market token in desc (no odds) passes ("Lakers over 220.5")', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'Lakers over 220.5', odds: null, units: 1, legs: [{ description: 'Lakers over 220.5', team: 'Lakers' }] };
  const r = validateParsedBet(pick, 'Lakers over 220.5 — find out here', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass (over = market token), got ${JSON.stringify(r)}`);
});

// ── no tease phrase, no selection → NOT tease-rejected (guard is tease-gated)
run('no tease phrase + bare description → not TEASE_NO_SELECTION (guard requires a tease phrase)', () => {
  const pick = { sport: 'NBA', type: 'future', description: 'NBA Champion', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'I like this one a lot', { hasMedia: false, now: TEST_NOW });
  assert.notStrictEqual(r.reason, 'TEASE_NO_SELECTION');
});

// ── market-token regex hardening (adversarial review): digit-dash-digit /
//    brand-words must NOT be read as a market token → bare teases still rejected.
run('tease + "2023-2024 season champion" (date range, no real market) → still TEASE_NO_SELECTION', () => {
  const pick = { sport: 'NBA', type: 'future', description: '2023-2024 season champion', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, '2023-2024 season champion — find out here', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'TEASE_NO_SELECTION');
});
run('tease + "Under Armour League champion" (brand word) → still TEASE_NO_SELECTION', () => {
  const pick = { sport: 'NBA', type: 'future', description: 'Under Armour League champion', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Under Armour League champion — link in bio', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'TEASE_NO_SELECTION');
});
run('tease + "Cole 5-2" (pitcher record) → still TEASE_NO_SELECTION', () => {
  const pick = { sport: 'MLB', type: 'straight', description: 'Cole 5-2', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Cole 5-2 tonight — find out here', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'TEASE_NO_SELECTION');
});
// ── the hardening must NOT drop REAL bets: over/under-with-number + spread still exempt
run('tease + "Under 6.5 goals" (real under bet) passes (over/under + number)', () => {
  const pick = { sport: 'Soccer', type: 'straight', description: 'Under 6.5 goals', odds: null, units: 1, legs: [{ description: 'Under 6.5 goals' }] };
  const r = validateParsedBet(pick, 'Under 6.5 goals — link in bio', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});
run('tease + "Lakers -3.5" (real spread) passes (sign at token boundary)', () => {
  const pick = { sport: 'NBA', type: 'straight', description: 'Lakers -3.5', odds: null, units: 1, legs: [{ description: 'Lakers -3.5', team: 'Lakers' }] };
  const r = validateParsedBet(pick, 'Lakers -3.5 — find out here', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got ${JSON.stringify(r)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { const db = require('../services/database').db; db.close(); } catch (_) {}
try { fs.unlinkSync(DB_FILE); } catch (_) {}
if (failed > 0) process.exit(1);
