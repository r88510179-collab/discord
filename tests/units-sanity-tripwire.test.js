// ═══════════════════════════════════════════════════════════
// P1 — UNITS_SANITY tripwire in createBetWithLegs (the sole ingest INSERT
// choke point). The twitter TEXT path bypasses normalizeBet's [0.01,100] units
// clamp, so a dollar stake mis-read as units (bet 3e5c01a0: units=5000) can land
// unclamped. The tripwire NEVER clamps/drops/mutates units — off (inert),
// shadow (log only, row unchanged), enforce (log + park in needs_review).
//
// Exercises the REAL createBetWithLegs against a migrated temp DB.
// Run: node tests/units-sanity-tripwire.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `units-sanity-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
delete process.env.UNITS_SANITY_MODE;
delete process.env.UNITS_SANITY_MAX;

const database = require('../services/database');
const { db, createBetWithLegs, getOrCreateCapper, resolveUnitsSanityMode, unitsSanityMax } = database;

const CAPPER_ID = getOrCreateCapper('cap_units_sanity', 'Units Sanity Tester', null).id;

let passed = 0;
let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e && e.stack ? e.stack : e}`); failed++; }
}

let seq = 0;
function seed({ units, mode, max, reviewStatus = 'confirmed' }) {
  seq += 1;
  if (mode === undefined) delete process.env.UNITS_SANITY_MODE; else process.env.UNITS_SANITY_MODE = mode;
  if (max === undefined) delete process.env.UNITS_SANITY_MAX; else process.env.UNITS_SANITY_MAX = String(max);
  const bet = createBetWithLegs({
    capper_id: CAPPER_ID,
    sport: 'NBA',
    bet_type: 'straight',
    description: `units-sanity probe ${seq}`,
    odds: -110,
    units,
    source: 'twitter_text',
    source_message_id: `us_${process.pid}_${seq}`, // unique → no fingerprint dedup
    review_status: reviewStatus,
  }, []);
  assert.ok(bet && bet.id && !bet._deduped, 'seed creates a fresh bet');
  return db.prepare('SELECT * FROM bets WHERE id = ?').get(bet.id);
}

// Capture console.warn so we can assert the WOULD_FIRE log fires/does-not-fire.
function withWarnCapture(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(lines); } finally { console.warn = orig; }
  return lines;
}

console.log('P1 — UNITS_SANITY tripwire:');

// ── resolver edge cases (pure) ───────────────────────────────
run('resolveUnitsSanityMode: unset → off', () => assert.strictEqual(resolveUnitsSanityMode(undefined), 'off'));
run('resolveUnitsSanityMode: "" → off', () => assert.strictEqual(resolveUnitsSanityMode(''), 'off'));
run('resolveUnitsSanityMode: "garbage" → off', () => assert.strictEqual(resolveUnitsSanityMode('garbage'), 'off'));
run('resolveUnitsSanityMode: "  SHADOW " → shadow', () => assert.strictEqual(resolveUnitsSanityMode('  SHADOW '), 'shadow'));
run('resolveUnitsSanityMode: "enforce" → enforce', () => assert.strictEqual(resolveUnitsSanityMode('enforce'), 'enforce'));
run('unitsSanityMax: unset → 100 default', () => assert.strictEqual(unitsSanityMax(undefined), 100));
run('unitsSanityMax: "garbage" → 100 default', () => assert.strictEqual(unitsSanityMax('garbage'), 100));
run('unitsSanityMax: "250" → 250', () => assert.strictEqual(unitsSanityMax('250'), 250));

// ── off: fully inert (no log, units + review_status unchanged) ──
run('off: units=5000 → no log, units unchanged, review_status unchanged', () => {
  const lines = withWarnCapture(() => {
    const row = seed({ units: 5000, mode: undefined });
    assert.strictEqual(row.units, 5000, 'units never clamped/mutated');
    assert.strictEqual(row.review_status, 'confirmed', 'review_status untouched in off');
  });
  assert.ok(!lines.some(l => l.includes('UNITS_SANITY_WOULD_FIRE')), 'off logs nothing');
});

// ── shadow: logs, but row unchanged (units + review_status) ──
run('shadow: units=5000 → WOULD_FIRE log, units unchanged, still confirmed', () => {
  const lines = withWarnCapture(() => {
    const row = seed({ units: 5000, mode: 'shadow' });
    assert.strictEqual(row.units, 5000, 'shadow never mutates units');
    assert.strictEqual(row.review_status, 'confirmed', 'shadow never diverts to review');
  });
  const fired = lines.find(l => l.includes('UNITS_SANITY_WOULD_FIRE'));
  assert.ok(fired, 'shadow emits the WOULD_FIRE log');
  assert.ok(fired.includes('mode=shadow'), 'log carries mode=shadow');
  assert.ok(fired.includes('units=5000'), 'log carries units');
  assert.ok(fired.includes('max=100'), 'log carries default max');
  assert.ok(fired.includes('source=twitter_text'), 'log carries source');
  assert.ok(fired.includes(`capper_id=${CAPPER_ID}`), 'log carries capper_id');
});

// ── enforce: logs AND forces review_status=needs_review, units still unchanged ──
run('enforce: units=5000 → WOULD_FIRE log + needs_review, units unchanged', () => {
  const lines = withWarnCapture(() => {
    const row = seed({ units: 5000, mode: 'enforce' });
    assert.strictEqual(row.units, 5000, 'enforce still never mutates units (no clamp)');
    assert.strictEqual(row.review_status, 'needs_review', 'enforce diverts THIS insert to human review');
  });
  const fired = lines.find(l => l.includes('UNITS_SANITY_WOULD_FIRE'));
  assert.ok(fired && fired.includes('mode=enforce'), 'enforce log carries mode=enforce');
});

// ── real capper 50u never fires in ANY mode (< max) ──
run('units=50 (real capper language) never fires — shadow', () => {
  const lines = withWarnCapture(() => {
    const row = seed({ units: 50, mode: 'shadow' });
    assert.strictEqual(row.units, 50);
    assert.strictEqual(row.review_status, 'confirmed');
  });
  assert.ok(!lines.some(l => l.includes('UNITS_SANITY_WOULD_FIRE')), '50 < 100 max → no fire');
});
run('units=50 never fires — enforce (stays confirmed)', () => {
  const row = seed({ units: 50, mode: 'enforce' });
  assert.strictEqual(row.review_status, 'confirmed', 'enforce leaves a normal bet alone');
});

// ── custom max lowers the threshold ──
run('UNITS_SANITY_MAX=25 makes units=50 fire in enforce', () => {
  const row = seed({ units: 50, mode: 'enforce', max: 25 });
  assert.strictEqual(row.review_status, 'needs_review', 'units=50 > max=25 → diverted');
  assert.strictEqual(row.units, 50, 'still no clamp');
});

// ── boundary: units == max does NOT fire (strictly greater) ──
run('units == max (100) does NOT fire (strict >)', () => {
  const lines = withWarnCapture(() => {
    const row = seed({ units: 100, mode: 'enforce' });
    assert.strictEqual(row.review_status, 'confirmed', 'equal to max is allowed');
  });
  assert.ok(!lines.some(l => l.includes('UNITS_SANITY_WOULD_FIRE')));
});

// ── the caller's betData object is never mutated (non-destructive clone) ──
run('enforce does not mutate the caller betData.review_status', () => {
  process.env.UNITS_SANITY_MODE = 'enforce';
  const betData = {
    capper_id: CAPPER_ID, sport: 'NBA', bet_type: 'straight',
    description: 'no-mutate probe', odds: -110, units: 9000,
    source: 'twitter_text', source_message_id: `us_${process.pid}_nm`, review_status: 'confirmed',
  };
  const saved = createBetWithLegs(betData, []);
  assert.strictEqual(betData.review_status, 'confirmed', 'caller object untouched');
  assert.strictEqual(db.prepare('SELECT review_status FROM bets WHERE id = ?').get(saved.id).review_status, 'needs_review', 'stored row diverted');
});

console.log(`\nunits-sanity tripwire: ${passed} passed, ${failed} failed`);
try { database.db.close(); } catch (_) {}
try { fs.unlinkSync(DB_FILE); } catch (_) {}
if (failed > 0) process.exit(1);
