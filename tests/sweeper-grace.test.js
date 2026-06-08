// ═══════════════════════════════════════════════════════════
// Phase 2b-2 — 7-Day Smart Sweeper grace for recovered bets.
//
// recoverHold backdates a recovered bet's created_at to the original slip
// post time (PR #59). Without a grace window the 7-Day Smart Sweeper
// (services/grading.js runAutoGrade) would see that backdated created_at,
// judge the bet > SWEEP_DAYS old, and auto-grade it a FALSE loss before the
// grader ever runs. Migration 028 adds bets.sweep_exempt_until; recoverHold
// stamps it now+GRACE_DAYS; the sweeper skips any bet still inside the window.
//
// This exercises the REAL policy (services/grading.evaluateSweep /
// sweepGraceUntil) and the REAL recovery stamp (services/holdReview.
// _graceMarkRecoveredBets) against a migrated temp DB. No Discord, no AI.
//
// Run:  node tests/sweeper-grace.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — set before requiring database so the migrator (incl.
// migration 028) builds the schema we read back.
const DB_FILE = path.join(os.tmpdir(), `sweeper-grace-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db, createBetWithLegs, getOrCreateCapper } = require('../services/database');
const { _internal } = require('../services/grading');
const { _graceMarkRecoveredBets, GRACE_DAYS } = require('../services/holdReview');

const { evaluateSweep, sweepGraceUntil } = _internal;

const CAPPER = getOrCreateCapper('cap_sweeper_grace', 'Sweep Grace Tester', null);
const CAPPER_ID = CAPPER.id;

const OLD = '2020-01-01 00:00:00'; // unambiguously > SWEEP_DAYS (7d) ago

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

// ── seed helpers ─────────────────────────────────────────────
let seq = 0;
function seedBet({ description, betType = 'straight' }) {
  seq += 1;
  const bet = createBetWithLegs({
    capper_id: CAPPER_ID,
    sport: 'NBA',
    league: null,
    bet_type: betType,
    description,
    odds: -110,
    units: 1,
    event_date: null,
    source: 'sweeper_grace_test',
    source_url: null,
    source_channel_id: null,
    source_message_id: `swp_${process.pid}_${seq}`, // unique → no fingerprint dedup
    raw_text: null,
    review_status: 'confirmed',
    wager: null,
    payout: null,
    is_ladder: false,
    ladder_step: 0,
  }, []);
  assert.ok(bet && bet.id && !bet._deduped, `seed should create a fresh bet (${description})`);
  return bet.id;
}

const setCreatedAt = (id, createdAt) =>
  db.prepare('UPDATE bets SET created_at = ? WHERE id = ?').run(createdAt, id);
const setExemptSql = (id, modifier) => // modifier like '+2 days' / '-1 days'
  db.prepare("UPDATE bets SET sweep_exempt_until = datetime('now', ?) WHERE id = ?").run(modifier, id);
const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);

console.log('Phase 2b-2 — sweeper grace');

// ── 1. recovered bet WITHIN grace, created_at > 7d → NOT swept ──
run('within grace + old created_at → not swept (reason=grace)', () => {
  const id = seedBet({ description: 'Lakers ML grace-active' });
  setCreatedAt(id, OLD);
  setExemptSql(id, '+2 days');
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, false, 'in-grace recovered bet must not be swept');
  assert.strictEqual(v.reason, 'grace');
  assert.ok(typeof v.graceUntil === 'string' && v.graceUntil.length >= 19, 'graceUntil should be the datetime string');
  assert.ok(sweepGraceUntil(id), 'sweepGraceUntil returns the timestamp while the window is open');
});

// ── 2. recovered bet PAST grace, created_at > 7d → swept (fallback intact) ──
run('past grace + old created_at → swept (reason=eligible)', () => {
  const id = seedBet({ description: 'Celtics ML grace-expired' });
  setCreatedAt(id, OLD);
  setExemptSql(id, '-1 days');
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, true, 'a bet past its grace window sweeps normally');
  assert.strictEqual(v.reason, 'eligible');
  assert.strictEqual(sweepGraceUntil(id), null, 'expired window → sweepGraceUntil null');
});

// ── 3. normal pending bet > 7d, sweep_exempt_until NULL → still swept ──
run('normal old bet, exempt NULL → swept (no regression)', () => {
  const id = seedBet({ description: 'Heat ML normal-stale' });
  setCreatedAt(id, OLD);
  assert.strictEqual(rowOf(id).sweep_exempt_until, null, 'normal bet carries no grace marker');
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, true, 'a normal long-stale bet must still be swept');
  assert.strictEqual(v.reason, 'eligible');
  assert.strictEqual(sweepGraceUntil(id), null);
});

// ── 4. prop bet > 7d → still exempt (both branches: bet_type and keyword) ──
run('prop bet (bet_type=prop) old → exempt (no regression)', () => {
  const id = seedBet({ description: 'LeBron over the line', betType: 'prop' });
  setCreatedAt(id, OLD);
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, false, 'prop bets are sweep-exempt regardless of age');
  assert.strictEqual(v.reason, 'prop');
});
run('prop-by-keyword (description "points") old → exempt (no regression)', () => {
  const id = seedBet({ description: 'LeBron James over 25.5 points' });
  setCreatedAt(id, OLD);
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, false, 'PROP_KEYWORDS match keeps the bet exempt');
  assert.strictEqual(v.reason, 'prop');
});

// ── 5. fresh normal bet (< 7d) → not swept (age gate intact) ──
run('fresh normal bet (<7d) → not swept (reason=fresh)', () => {
  const id = seedBet({ description: 'Knicks ML fresh' });
  db.prepare("UPDATE bets SET created_at = datetime('now') WHERE id = ?").run(id);
  const v = evaluateSweep(rowOf(id));
  assert.strictEqual(v.eligible, false, 'a fresh bet is never swept');
  assert.strictEqual(v.reason, 'fresh');
});

// ── 6. migration applied: column present + existing rows NULL ──
run('migration 028: sweep_exempt_until column present, defaults NULL', () => {
  const cols = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  assert.ok(cols.includes('sweep_exempt_until'), 'bets table must include sweep_exempt_until');
  const id = seedBet({ description: 'Default NULL probe' });
  assert.strictEqual(rowOf(id).sweep_exempt_until, null, 'a normally-created bet defaults to NULL grace');
});

// ── 7. recoverHold stamp: _graceMarkRecoveredBets opens the window ──
run('_graceMarkRecoveredBets stamps now+GRACE_DAYS → grace active', () => {
  assert.strictEqual(GRACE_DAYS, 3, 'GRACE_DAYS default is 3 (recovery time + grace)');
  const id = seedBet({ description: 'Recovered backlog slip' });
  setCreatedAt(id, OLD); // simulate the #59 backdate to a >7d-old slip date
  // pre-condition: without the marker this old bet would be swept
  assert.strictEqual(evaluateSweep(rowOf(id)).eligible, true, 'backdated bet is sweep-eligible before the stamp');
  _graceMarkRecoveredBets('disc_recover_test', [id]);
  const after = rowOf(id);
  assert.ok(after.sweep_exempt_until, 'recovery must set sweep_exempt_until');
  const v = evaluateSweep(after);
  assert.strictEqual(v.eligible, false, 'after recovery stamp the backdated bet is no longer sweep-eligible');
  assert.strictEqual(v.reason, 'grace');
});

console.log(`\nPhase 2b-2 sweeper grace: ${passed} passed, ${failed} failed`);
try { fs.unlinkSync(DB_FILE); } catch (_) {}
if (failed > 0) process.exit(1);
