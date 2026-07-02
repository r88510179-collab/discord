// ═══════════════════════════════════════════════════════════
// DP-01/V1 + T6-01/V6 — the 7-Day Sweeper terminal write.
//
// The pre-fix sweeper wrote an evidence-free LOSS (bankroll debited, W-L/ROI
// counted) on nothing but age — 61 such grades in the 30d audit window, all
// NULL event_date. The adjudicated fix (PR #164): sweep to VOID, the
// codebase's bankroll-neutral grade, and emit terminal telemetry
// (pipeline_events GRADING_COMPLETE + grading_audit) on every sweep.
//
// Exercises the REAL terminal write (services/grading.js sweepExpiredBet —
// the exact function runAutoGrade's sweep loop calls) against a migrated
// temp DB. No Discord, no AI.
//
// Run:  node tests/sweeper-void.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — set before requiring database so the migrator builds the
// schema we read back.
const DB_FILE = path.join(os.tmpdir(), `sweeper-void-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const database = require('../services/database');
const { db, createBetWithLegs, getOrCreateCapper, setBankroll, getBankroll, getCapperStats } = database;
const { _internal } = require('../services/grading');
const { sweepExpiredBet } = _internal;

const CAPPER = getOrCreateCapper('cap_sweeper_void', 'Sweep Void Tester', null);
const CAPPER_ID = CAPPER.id;
setBankroll(CAPPER_ID, 1000, 25);

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

let seq = 0;
function seedBet({ description, betType = 'straight', reviewStatus = 'confirmed' }) {
  seq += 1;
  const bet = createBetWithLegs({
    capper_id: CAPPER_ID,
    sport: 'Tennis', // the dominant swept sport in the audit cohort
    bet_type: betType,
    description,
    odds: -110,
    units: 1,
    event_date: null,
    source: 'sweeper_void_test',
    source_message_id: `swv_${process.pid}_${seq}`, // unique → no fingerprint dedup
    review_status: reviewStatus,
  }, []);
  assert.ok(bet && bet.id && !bet._deduped, `seed should create a fresh bet (${description})`);
  db.prepare('UPDATE bets SET created_at = ? WHERE id = ?').run(OLD, bet.id);
  return db.prepare('SELECT * FROM bets WHERE id = ?').get(bet.id);
}

const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
const pipelineRowsFor = id => db.prepare('SELECT * FROM pipeline_events WHERE bet_id = ?').all(id);
const auditRowsFor = id => db.prepare('SELECT * FROM grading_audit WHERE bet_id = ?').all(id);

console.log('DP-01 — sweeper sweeps to VOID with terminal telemetry');

// ── 1. aged pending bet → VOID, not LOSS ─────────────────────
run('aged pending bet sweeps to result=void, profit 0, grade VOID, Auto-swept marker kept', () => {
  const bet = seedBet({ description: 'Alcaraz ML stale futures' });
  const res = sweepExpiredBet(bet);
  assert.strictEqual(res.swept, true, 'aged confirmed pending bet must sweep');

  const after = rowOf(bet.id);
  assert.strictEqual(after.result, 'void', 'swept outcome is the neutral grade, never loss');
  assert.strictEqual(after.profit_units, 0, 'a sweep must not debit units');
  assert.strictEqual(after.grade, 'VOID');
  assert.ok(after.graded_at, 'terminal write stamps graded_at');
  assert.strictEqual(after.grading_state, 'done');
  assert.ok(
    /^Auto-swept: pending >7 days/.test(after.grade_reason),
    `sweep marker (grade_reason 'Auto-swept:' prefix, the marker on the historical swept rows) must be preserved — got "${after.grade_reason}"`,
  );
});

// ── 2. bankroll + W-L/ROI untouched by a sweep ───────────────
run('sweep leaves bankroll, W-L, and ROI unchanged', () => {
  const bankrollBefore = getBankroll(CAPPER_ID).current;
  const statsBefore = getCapperStats(CAPPER_ID);

  const bet = seedBet({ description: 'Sinner ML stale bankroll probe' });
  const res = sweepExpiredBet(bet);
  assert.strictEqual(res.swept, true);

  assert.strictEqual(getBankroll(CAPPER_ID).current, bankrollBefore,
    'bankroll must be byte-identical after a sweep — a swept bet never debits bankroll');
  const statsAfter = getCapperStats(CAPPER_ID);
  assert.strictEqual(statsAfter.wins, statsBefore.wins, 'wins unchanged');
  assert.strictEqual(statsAfter.losses, statsBefore.losses, 'a sweep must never count as a loss');
  assert.strictEqual(statsAfter.pushes, statsBefore.pushes, 'pushes unchanged (void ≠ push: push enters the ROI denominator)');
  assert.strictEqual(statsAfter.total_profit_units, statsBefore.total_profit_units, 'profit unchanged');
  assert.strictEqual(statsAfter.roi_pct, statsBefore.roi_pct, 'ROI unchanged — void is excluded from the SETTLED_BET set');
});

// ── 3. terminal telemetry present (T6-01) ────────────────────
run('sweep emits pipeline_events GRADING_COMPLETE + grading_audit row (source sweeper_7d, sweep-timeout reason)', () => {
  const bet = seedBet({ description: 'Zverev ML stale telemetry probe' });
  assert.strictEqual(pipelineRowsFor(bet.id).length, 0, 'no pipeline rows before the sweep');
  assert.strictEqual(auditRowsFor(bet.id).length, 0, 'no audit rows before the sweep');

  sweepExpiredBet(bet);

  const events = pipelineRowsFor(bet.id);
  const terminal = events.filter(e => e.stage === 'GRADING_COMPLETE');
  assert.strictEqual(terminal.length, 1, 'exactly one GRADING_COMPLETE row per sweep');
  assert.strictEqual(terminal[0].event_type, 'STAGE_EXIT');
  assert.strictEqual(terminal[0].source_type, 'grading');
  const payload = JSON.parse(terminal[0].payload);
  assert.strictEqual(payload.source, 'sweeper_7d', 'payload names the writer');
  assert.strictEqual(payload.result, 'void');
  assert.ok(/sweep_timeout/.test(payload.reason), 'payload carries the explicit sweep-timeout reason');
  assert.strictEqual(payload.bankroll_changed, false);

  const audits = auditRowsFor(bet.id);
  assert.strictEqual(audits.length, 1, 'exactly one grading_audit row per sweep');
  assert.strictEqual(audits[0].provider_used, 'sweeper_7d', 'grading_audit source is the sweeper');
  assert.strictEqual(audits[0].final_status, 'VOID');
  assert.ok(/^sweep_timeout:/.test(audits[0].final_evidence), 'audit evidence carries the sweep-timeout reason');
});

// ── 4. write-time revert gate intact (requireGraderEligible) ──
run('a mid-cycle-reverted needs_review bet is not swept (write gate no-op)', () => {
  const bet = seedBet({ description: 'Djokovic ML parked in review', reviewStatus: 'needs_review' });
  const before = JSON.stringify(rowOf(bet.id));
  const res = sweepExpiredBet(bet);
  assert.strictEqual(res.swept, false, 'needs_review bets are invisible to the sweeper write');
  assert.strictEqual(JSON.stringify(rowOf(bet.id)), before, 'row byte-identical after the refused sweep');
  assert.strictEqual(auditRowsFor(bet.id).length, 0, 'no telemetry for a refused sweep');
});

// ── 5. parlay with pending legs → denied, rechecked, no grade ──
run('parlay with pending legs is denied by canFinalizeBet (no void written)', () => {
  seq += 1;
  const parlay = createBetWithLegs({
    capper_id: CAPPER_ID,
    sport: 'Tennis',
    bet_type: 'parlay',
    description: 'Ruud ML + Rune ML stale parlay',
    odds: -110,
    units: 1,
    source: 'sweeper_void_test',
    source_message_id: `swv_${process.pid}_${seq}`,
    review_status: 'confirmed',
  }, [{ description: 'Ruud ML' }, { description: 'Rune ML' }]);
  db.prepare('UPDATE bets SET created_at = ? WHERE id = ?').run(OLD, parlay.id);

  const res = sweepExpiredBet(rowOf(parlay.id));
  assert.strictEqual(res.swept, false, 'pending legs deny the terminal write');
  assert.strictEqual(res.reason, 'pending_legs');
  assert.strictEqual(rowOf(parlay.id).result, 'pending', 'parlay stays pending');
});

console.log(`\nDP-01 sweeper void: ${passed} passed, ${failed} failed`);
try { fs.unlinkSync(DB_FILE); } catch (_) {}
if (failed > 0) process.exit(1);
