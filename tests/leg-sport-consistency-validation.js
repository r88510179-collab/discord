// ═══════════════════════════════════════════════════════════
// Leg-sport-consistency validator tests
// Repro: 2026-04-30 msg=1499418573469388810 — "Giants ML" + MLB
// parlay was wrongly dropped because 'giants' lived only in NFL.
// Fix: 'giants'/'cardinals'/'jets' added to MLB/NFL/NHL respectively,
// and the validator now passes when the declared sport is among the
// sports whose keyword list matched the leg.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { validateLegSportConsistency, reclassifySport } = require('../services/ai');

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

console.log('Leg sport consistency validator:');

// ── Multi-sport teams in their declared sport → pass ──
run('Giants ML + MLB → pass (live repro msg=1499418573469388810)', () => {
  const r = validateLegSportConsistency({ description: 'Giants ML' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Cardinals -1.5 + NFL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Cardinals -1.5 -110' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Jets +1.5 + NHL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Jets +1.5 puck line' }, 'NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Rangers ML + NHL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Rangers ML -120' }, 'NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Panthers -3 + NFL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Panthers -3 -105' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Kings ML + NBA → pass', () => {
  const r = validateLegSportConsistency({ description: 'Kings ML +110' }, 'NBA');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Multi-sport team in a non-matching declared sport → fire ──
run('Rangers ML + NBA → fire (rangers is MLB/NHL, neither is NBA)', () => {
  const r = validateLegSportConsistency({ description: 'Rangers ML' }, 'NBA');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /Rangers|rangers/i);
  assert.match(r.reason, /NBA/);
});

// ── Clean single-sport pass ──
run('Cubs -1.5 + MLB → pass', () => {
  const r = validateLegSportConsistency({ description: 'Cubs -1.5 -110' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Clean single-sport fire (existing correct catch) ──
run('Browns -3 + MLB → fire', () => {
  const r = validateLegSportConsistency({ description: 'Browns -3' }, 'MLB');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /browns/i);
  assert.match(r.reason, /NFL/);
  assert.match(r.reason, /MLB/);
});

// ── No team keyword at all → pass (out of this validator's scope) ──
run('Pure player prop "Mookie Betts hit" + MLB → pass', () => {
  const r = validateLegSportConsistency({ description: 'Mookie Betts hit -110' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Pure player prop "Mookie Betts hit" + NFL → pass (out of scope)', () => {
  const r = validateLegSportConsistency({ description: 'Mookie Betts hit' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Empty / null safety ──
run('Empty description → pass', () => {
  const r = validateLegSportConsistency({ description: '' }, 'MLB');
  assert.strictEqual(r.valid, true);
});

run('Missing description → pass', () => {
  const r = validateLegSportConsistency({}, 'MLB');
  assert.strictEqual(r.valid, true);
});

// ── Cleveland Browns in MLB-only matched set → fire (single-sport mismatch) ──
run('"Cleveland Browns -3" + MLB → fire (single-sport mismatch)', () => {
  const r = validateLegSportConsistency({ description: 'Cleveland Browns -3' }, 'MLB');
  assert.strictEqual(r.valid, false);
});

// ═══════════════════════════════════════════════════════════
// reclassifySport regression — adding 'giants' to MLB must NOT
// cause an MLB Giants leg to get reclassified to NFL.
// ═══════════════════════════════════════════════════════════
console.log('\nreclassifySport regression (multi-sport keyword):');

run('reclassifySport("MLB", "Giants ML") → MLB (multi-sport keeps original)', () => {
  const out = reclassifySport('MLB', 'Giants ML');
  assert.strictEqual(out, 'MLB');
});

run('reclassifySport("NFL", "Giants -3") → NFL (multi-sport keeps original)', () => {
  const out = reclassifySport('NFL', 'Giants -3');
  assert.strictEqual(out, 'NFL');
});

run('reclassifySport("MLB", "Cardinals -1.5") → MLB', () => {
  const out = reclassifySport('MLB', 'Cardinals -1.5');
  assert.strictEqual(out, 'MLB');
});

run('reclassifySport("NHL", "Jets +1.5") → NHL', () => {
  const out = reclassifySport('NHL', 'Jets +1.5');
  assert.strictEqual(out, 'NHL');
});

// Single-sport reclassification still works (no regression)
run('reclassifySport("MLB", "Cowboys -3") → NFL (single-sport reclassify)', () => {
  const out = reclassifySport('MLB', 'Cowboys -3');
  assert.strictEqual(out, 'NFL');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
