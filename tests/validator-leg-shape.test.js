// ═══════════════════════════════════════════════════════════
// P1c: Pitcher-record / stat-line leg shape validator.
// Repro: bet 7d96e21d1b1870f0ddb854613a417a77, @NRFIAnalytics 2026-04-30,
// vision parser misread MLB SF/PHI Game 1 NRFI graphic as a 2-leg parlay
// with legs "C. Sanchez 5-1 (83.3%)" and "L. Webb 6-0 (100.0%)" — those
// were pitcher win-loss records, not betting legs. validateLegShape rejects
// any leg matching "NAME N-N (NN%)" or "NAME N-N (NN.N%)".
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { validateLegShape, validateParsedBet } = require('../services/ai');

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

console.log('validateLegShape (pitcher-record / stat-line shape):');

// ── REJECT: pitcher records ──
run('"C. Sanchez 5-1 (83.3%)" → reject (live repro)', () => {
  const r = validateLegShape({ description: 'C. Sanchez 5-1 (83.3%)' });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
});

run('"L. Webb 6-0 (100.0%)" → reject (live repro)', () => {
  const r = validateLegShape({ description: 'L. Webb 6-0 (100.0%)' });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
});

run('"Tarik Skubal 12-3 (75%)" → reject (integer percent)', () => {
  const r = validateLegShape({ description: 'Tarik Skubal 12-3 (75%)' });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
});

run('"• C. Sanchez 5-1 (83.3%)" → reject (with bullet prefix)', () => {
  const r = validateLegShape({ description: '• C. Sanchez 5-1 (83.3%)' });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
});

run('"Webb 6-0 (100%)" → reject (no period in pct)', () => {
  const r = validateLegShape({ description: 'Webb 6-0 (100%)' });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
});

// ── ACCEPT: real betting legs (must NOT false-positive) ──
run('"Lakers -3.5 (-110)" → pass (spread + odds in parens)', () => {
  const r = validateLegShape({ description: 'Lakers -3.5 (-110)' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('"Aaron Judge Over 0.5 HR (+320)" → pass (player prop)', () => {
  const r = validateLegShape({ description: 'Aaron Judge Over 0.5 HR (+320)' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('"Maple Leafs (5-1) -110" → pass (record in parens, no %)', () => {
  const r = validateLegShape({ description: 'Maple Leafs (5-1) -110' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('"Win Probability 75% Lakers ML" → pass (% but not in N-N(%) shape)', () => {
  const r = validateLegShape({ description: 'Win Probability 75% Lakers ML' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('"Yankees Angels Over 9.5 -115" → pass (totals)', () => {
  const r = validateLegShape({ description: 'Yankees Angels Over 9.5 -115' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('"NRFI -110" → pass (the actual NRFI bet)', () => {
  const r = validateLegShape({ description: 'NRFI -110' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('empty description → pass (defensive)', () => {
  const r = validateLegShape({ description: '' });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('null leg → pass (defensive)', () => {
  const r = validateLegShape(null);
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// ── End-to-end: validateParsedBet rejects the live repro shape ──
console.log('\nvalidateParsedBet (P1c end-to-end):');

run('NRFI parlay misread → leg_shape_invalid', () => {
  const pick = {
    sport: 'MLB',
    type: 'parlay',
    description: '• C. Sanchez 5-1 (83.3%)\n• L. Webb 6-0 (100.0%)',
    odds: null,
    units: 1,
    legs: [
      { description: 'C. Sanchez 5-1 (83.3%)', odds: null, team: 'C. Sanchez' },
      { description: 'L. Webb 6-0 (100.0%)', odds: null, team: 'L. Webb' },
    ],
  };
  const sourceText = 'MLB SF/PHI Game 1 NRFI free play';
  const r = validateParsedBet(pick, sourceText, { hasMedia: true });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'leg_shape_invalid', `expected leg_shape_invalid, got: ${r.reason}`);
});

run('legitimate NRFI single-leg bet → pass', () => {
  const pick = {
    sport: 'MLB',
    type: 'straight',
    description: 'NRFI Game 1 SF/PHI -110',
    odds: -110,
    units: 1,
    legs: [
      { description: 'NRFI Game 1 SF/PHI', odds: -110, team: 'SF/PHI', line: 'NRFI' },
    ],
  };
  const sourceText = 'MLB SF/PHI Game 1 NRFI free play';
  const r = validateParsedBet(pick, sourceText, { hasMedia: true });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

run('flattened pitcher-record description (no legs) → leg_shape_invalid', () => {
  const pick = {
    sport: 'MLB',
    type: 'straight',
    description: 'C. Sanchez 5-1 (83.3%)',
    odds: null,
    units: 1,
    legs: [],
  };
  const sourceText = 'MLB SF/PHI Game 1 NRFI free play';
  const r = validateParsedBet(pick, sourceText, { hasMedia: true });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'leg_shape_invalid', `expected leg_shape_invalid, got: ${r.reason}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
