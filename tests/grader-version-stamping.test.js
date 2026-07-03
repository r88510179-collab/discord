// ═══════════════════════════════════════════════════════════
// P1 (B2) — grader_version stamping on the non-main-grader finalize sites.
//
// Before this change only the main AI grader stamped grader_version
// ('phase1-gates-v1'); every other terminal write left it NULL. This pins the
// new stamps at each touched finalize helper (where DB-feasible):
//   sweeper-v1     — services/grading.js sweepExpiredBet
//   celebration-v1 — services/grading.js autoGradeFromRecap (celebration/graphic)
//   retry-void-v1  — services/grading.js scheduleRecheckAfterDenial (retry cap)
//   manual-v1      — services/gradeOverride.js applyGradeOverride
//   war-room-v1    — services/database.js gradeBetRecord provenance passthrough
//                    (the wiring the warRoom untracked-win call relies on)
//
// Real functions, real migrated temp DB. No Discord, no AI, no network.
// Run: node tests/grader-version-stamping.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

const DB_FILE = path.join(os.tmpdir(), `grader-version-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
delete process.env.WAR_ROOM_CHANNEL_ID;

const database = require('../services/database');
const { db, createBetWithLegs, getOrCreateCapper, setBankroll, getBankroll, updateBankroll, saveDailySnapshot, gradeBet } = database;
const grading = require('../services/grading');
const { calcProfit, autoGradeFromRecap } = grading;
const { sweepExpiredBet, scheduleRecheckAfterDenial } = grading._internal;
const { applyGradeOverride } = require('../services/gradeOverride');

const CAPPER_ID = getOrCreateCapper('cap_grader_version', 'Grader Version Tester', null).id;
setBankroll(CAPPER_ID, 1000, 25);

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e && e.stack ? e.stack : e}`); failed++; }
}

let seq = 0;
function seedPending({ description, betType = 'straight', reviewStatus = 'confirmed', agedDays = 0 }) {
  seq += 1;
  const bet = createBetWithLegs({
    capper_id: CAPPER_ID, sport: 'NBA', bet_type: betType, description,
    odds: -110, units: 1, event_date: null, source: 'gv_test',
    source_message_id: `gv_${process.pid}_${seq}`, review_status: reviewStatus,
  }, []);
  assert.ok(bet && bet.id && !bet._deduped, `seed creates a fresh bet (${description})`);
  if (agedDays > 0) db.prepare('UPDATE bets SET created_at = ? WHERE id = ?').run('2020-01-01 00:00:00', bet.id);
  return bet.id;
}
const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);

async function main() {
  console.log('P1 (B2) — grader_version stamping:');

  // ── sweeper-v1 ───────────────────────────────────────────────
  await run('sweeper sweepExpiredBet → grader_version=sweeper-v1', () => {
    const id = seedPending({ description: 'Alcaraz ML stale', agedDays: 8 });
    const res = sweepExpiredBet(rowOf(id));
    assert.strictEqual(res.swept, true);
    const after = rowOf(id);
    assert.strictEqual(after.result, 'void');
    assert.strictEqual(after.grader_version, 'sweeper-v1', `got "${after.grader_version}"`);
  });

  // ── celebration-v1 ───────────────────────────────────────────
  await run('autoGradeFromRecap (graphic/celebration) → grader_version=celebration-v1', async () => {
    const id = seedPending({ description: 'Lakers ML tonight' });
    const res = await autoGradeFromRecap(null, { capperId: CAPPER_ID, outcome: 'win', subjects: ['Lakers'], source: 'graphic_auto' });
    assert.ok(res && res.bet.id === id, 'single in-scope match auto-grades');
    const after = rowOf(id);
    assert.strictEqual(after.result, 'win');
    assert.strictEqual(after.grader_version, 'celebration-v1', `got "${after.grader_version}"`);
  });

  // ── retry-void-v1 ────────────────────────────────────────────
  await run('scheduleRecheckAfterDenial at retry cap → grader_version=retry-void-v1', () => {
    const id = seedPending({ description: 'Sinner ML retry-cap probe' });
    db.prepare('UPDATE bets SET grading_attempts = 15 WHERE id = ?').run(id); // at RETRY_CAP
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    const after = rowOf(id);
    assert.strictEqual(after.result, 'void', 'cap forces a terminal VOID');
    assert.strictEqual(after.grader_version, 'retry-void-v1', `got "${after.grader_version}"`);
  });

  // ── manual-v1 (override of an already-graded bet) ────────────
  await run('applyGradeOverride → grader_version=manual-v1', () => {
    // Seed a FINALIZED bet (override only touches non-pending rows).
    seq += 1;
    const id = `gvov${String(seq).padStart(28, '0')}`.slice(0, 32);
    db.prepare(`INSERT INTO bets (id, capper_id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason, season, graded_at)
      VALUES (?, ?, 'NBA', 'straight', 'Manual override probe', -110, 1, 'loss', -1, 'B', 'orig', 'Beta', '2026-06-25 12:00:00')`).run(id, CAPPER_ID);
    const deps = { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit };
    const out = applyGradeOverride(deps, { betId: id, result: 'win', reason: 'operator correction', invokerId: 'owner-1' });
    assert.ok(out.ok, `override should succeed: ${JSON.stringify(out)}`);
    const after = rowOf(id);
    assert.strictEqual(after.result, 'win');
    assert.strictEqual(after.grader_version, 'manual-v1', `got "${after.grader_version}"`);
  });

  // ── war-room-v1 (gradeBetRecord provenance passthrough) ──────
  await run('gradeBet provenance {graderVersion:war-room-v1} stamps (untracked-win wiring)', () => {
    const id = seedPending({ description: 'Knicks ML untracked-win wiring probe' });
    const gr = gradeBet(id, 'win', 0.91, null, 'Logged as untracked win via War Room', true, { graderVersion: 'war-room-v1' });
    assert.ok(gr.graded, 'grade lands');
    assert.strictEqual(rowOf(id).grader_version, 'war-room-v1', `got "${rowOf(id).grader_version}"`);
  });

  console.log(`\ngrader_version stamping: ${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => { console.error(err); failed++; })
  .finally(() => {
    try { database.db.close(); } catch (_) {}
    try { fs.unlinkSync(DB_FILE); } catch (_) {}
    if (failed > 0) process.exit(1);
  });
