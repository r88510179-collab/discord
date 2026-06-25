// ═══════════════════════════════════════════════════════════
// /grade override — privileged correction of an ALREADY-GRADED bet.
//
// gradeBet() no-ops once result != pending, so a finalized-wrong bet (the
// 8cac8e5d… parlay: leg 2 graded vs the prior-day game because event_date was
// null) can't be fixed via the grader. applyGradeOverride rewrites it directly
// in one transaction, archiving prior state to bet_grade_history.
//
// These tests exercise the helper against a REAL migrated throwaway DB and the
// REAL database/grading functions it depends on — proving the writes land and
// the bankroll/leg/idempotency rules hold.
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const os = require('os');
const path = require('path');

// No network at require-time (grading.js is pulled in for the real calcProfit).
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Fresh throwaway DB BEFORE requiring database.js (migrations build full schema:
// bet_grade_history (022), wager/payout (004), parlay_legs evidence (013)).
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-grade-override-${Date.now()}.db`);

const database = require('../services/database');
const { calcProfit } = require('../services/grading');
const { applyGradeOverride } = require('../services/gradeOverride');

const { db, getBankroll, updateBankroll, saveDailySnapshot } = database;
const deps = { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit };

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

const CAPPER_ID = 'cap00000000000000000000000000aaaa';
const UNIT = 25;

function seedCapper() {
  db.prepare('INSERT OR REPLACE INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)')
    .run(CAPPER_ID, 'disc-1', 'Smokke');
}
function seedBankroll(current = 1000) {
  db.prepare('INSERT OR REPLACE INTO bankrolls (id, capper_id, starting, current, unit_size) VALUES (?, ?, ?, ?, ?)')
    .run('bank0000000000000000000000000aaaa', CAPPER_ID, 1000, current, UNIT);
}
function seedBet(id, fields) {
  const f = Object.assign({
    capper_id: CAPPER_ID, sport: 'MLB', bet_type: 'straight', description: 'test bet',
    odds: -110, units: 1, result: 'loss', profit_units: -1, grade: 'B',
    grade_reason: 'original reason', payout: null, wager: null, season: 'Beta',
    graded_at: '2026-06-25 12:00:00',
  }, fields);
  db.prepare(`INSERT OR REPLACE INTO bets
    (id, capper_id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason, payout, wager, season, graded_at)
    VALUES (@id, @capper_id, @sport, @bet_type, @description, @odds, @units, @result, @profit_units, @grade, @grade_reason, @payout, @wager, @season, @graded_at)`)
    .run(Object.assign({ id }, f));
}
function seedLeg(betId, idx, result, evidence) {
  db.prepare('INSERT INTO parlay_legs (id, bet_id, description, odds, result, evidence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`leg-${betId}-${idx}`, betId, `leg ${idx}`, -110, result, evidence);
}
function historyCount(betId) {
  return db.prepare('SELECT COUNT(*) n FROM bet_grade_history WHERE bet_id = ?').get(betId).n;
}

(function run() {
  seedCapper();

  // ── 1. loss → win parlay: profit recomputed via calcProfit (UNITS) ─────────
  // odds=440, units=15 → calcProfit = 66.0 UNITS. The row's payout/wager are slip
  // DOLLARS and must NOT reach profit_units; the unit-vs-dollar divergence is
  // RED-proven in case 1c below.
  {
    seedBankroll(1000);
    const BID = 'bet00000000000000000000000000001a';
    seedBet(BID, { bet_type: 'parlay', odds: 440, units: 15, payout: 81.07, wager: 15, result: 'loss', profit_units: -15 });
    seedLeg(BID, 1, 'win', 'leg1 ev');
    seedLeg(BID, 2, 'loss', 'leg2 ev');   // the wrongly-graded leg
    seedLeg(BID, 3, 'win', null);          // null evidence → COALESCE path

    const out = applyGradeOverride(deps, { betId: BID, result: 'win', reason: 'leg 2 graded vs 6/23 game; real 6/24 total was 9 → Under hit', invokerId: 'admin-1' });

    check('1: ok', out.ok === true);
    check('1: profit = calcProfit UNITS (66.0)', near(out.newProfit, calcProfit(440, 15, 'win')));
    check('1: NOT the dollar payout−wager (66.07)', !near(out.newProfit, 81.07 - 15));
    check('1: oldResult loss', out.oldResult === 'loss');
    check('1: legsTouched = 3', out.legsTouched === 3);
    check('1: bankrollApplied', out.bankrollApplied === true);
    // delta = (66.0 - (-15)) * 25 = 81 * 25 = 2025 (UNITS delta × unit_size)
    check('1: bankroll delta units-consistent', near(out.bankrollDelta, (66.0 - (-15)) * UNIT));

    const row = db.prepare('SELECT * FROM bets WHERE id = ?').get(BID);
    check('1: bets.result = win', row.result === 'win');
    check('1: bets.profit_units recomputed (66.0 units)', near(row.profit_units, 66.0));
    check('1: grade_reason OVERRIDE-prefixed', row.grade_reason.startsWith('OVERRIDE: '));
    check('1: grade column untouched', row.grade === 'B');

    const legs = db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ? ORDER BY id').all(BID);
    check('1: all legs win', legs.every(l => l.result === 'win'));
    check('1: every leg evidence appended once', legs.every(l => (l.evidence || '').endsWith(' [overridden]')));
    check('1: null-evidence leg → " [overridden]"', legs.find(l => l.id === `leg-${BID}-3`).evidence === ' [overridden]');

    const bank = getBankroll(CAPPER_ID);
    check('1: bankroll current shifted', near(parseFloat(bank.current), 1000 + (66.0 - (-15)) * UNIT));

    const h = db.prepare('SELECT * FROM bet_grade_history WHERE bet_id = ?').get(BID);
    check('1: history archived old_result', h.old_result === 'loss');
    check('1: history archived old_profit_units', near(h.old_profit_units, -15));
    check('1: history archived old_grade_reason', h.old_grade_reason === 'original reason');
    check('1: history archived_by = invoker', h.archived_by === 'admin-1');
    check('1: history reason = provided', h.reason.startsWith('leg 2 graded'));

    // ── 2. Idempotency: re-run win → win must NOT double-apply ──────────────
    const out2 = applyGradeOverride(deps, { betId: BID, result: 'win', reason: 'second run', invokerId: 'admin-1' });
    check('2: idempotent flag', out2.idempotent === true);
    check('2: legsTouched = 0', out2.legsTouched === 0);
    check('2: bankroll NOT applied', out2.bankrollApplied === false);
    check('2: newProfit unchanged', near(out2.newProfit, 66.0));
    const bank2 = getBankroll(CAPPER_ID);
    check('2: bankroll current unchanged (no double-apply)', near(parseFloat(bank2.current), 1000 + (66.0 - (-15)) * UNIT));
    const legs2 = db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ?').all(BID);
    check('2: evidence not double-appended', legs2.every(l => (l.evidence.match(/\[overridden\]/g) || []).length === 1));
    check('2: reason still updatable (history grows)', historyCount(BID) === 2);
  }

  // ── 1c. Slip-backed win: dollar payout/wager must NOT corrupt profit_units ──
  // RED-proves the P1 (Codex). Slip dollars: payout=65, wager=25 → $40 dollar
  // profit. The bet is 1u @ +100 → calcProfit = 1.0 UNIT. The fix stores 1.0 unit,
  // so the bankroll moves the units-consistent (1 − (−1)) × $25 = $50. The OLD
  // dollars-in-units code stored 40 into profit_units and the bankroll lurched
  // (40 − (−1)) × $25 = $1025 (~$1000) — corrupting bankroll AND ROI.
  {
    seedBankroll(1000);
    const BID = 'bet00000000000000000000000000007a';
    seedBet(BID, { bet_type: 'parlay', odds: 100, units: 1, payout: 65, wager: 25, result: 'loss', profit_units: -1 });
    seedLeg(BID, 1, 'loss', 'leg1 ev');

    const out = applyGradeOverride(deps, { betId: BID, result: 'win', invokerId: 'admin-1' });
    check('1c: ok', out.ok === true);
    check('1c: profit = calcProfit UNITS (1.0)', near(out.newProfit, calcProfit(100, 1, 'win')));
    check('1c: NOT the dollar payout−wager (40)', !near(out.newProfit, 65 - 25));
    // Correct: (1 − (−1)) × 25 = 50.   Bug (dollars-in-units): (40 − (−1)) × 25 = 1025.
    check('1c: bankroll delta units-consistent ($50)', near(out.bankrollDelta, (1 - (-1)) * UNIT));
    check('1c: bankroll delta NOT the dollars-in-units bug (~$1025)', !near(out.bankrollDelta, (40 - (-1)) * UNIT));

    const row = db.prepare('SELECT * FROM bets WHERE id = ?').get(BID);
    check('1c: stored profit_units = 1.0 (units, not $40)', near(row.profit_units, 1));
    const bank = getBankroll(CAPPER_ID);
    check('1c: bankroll moved to $1050 (not ~$2025)', near(parseFloat(bank.current), 1000 + (1 - (-1)) * UNIT));
  }

  // ── 2b. Multi-transition cycle: marker never duplicates ────────────────────
  // loss→win (marker added) → win→loss (legs untouched) → loss→win again.
  // The append guard must keep exactly ONE ' [overridden]' per leg.
  {
    seedBankroll(1000);
    const BID = 'bet00000000000000000000000000002b';
    seedBet(BID, { bet_type: 'parlay', odds: 200, units: 10, result: 'loss', profit_units: -10 });
    seedLeg(BID, 1, 'loss', 'leg1 ev');
    seedLeg(BID, 2, 'loss', null);

    applyGradeOverride(deps, { betId: BID, result: 'win', invokerId: 'admin-1' });   // loss→win
    applyGradeOverride(deps, { betId: BID, result: 'loss', invokerId: 'admin-1' });  // win→loss (legs untouched)
    applyGradeOverride(deps, { betId: BID, result: 'win', invokerId: 'admin-1' });   // loss→win again

    const legs = db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ?').all(BID);
    check('2b: all legs win after cycle', legs.every(l => l.result === 'win'));
    check('2b: marker present', legs.every(l => /\[overridden\]/.test(l.evidence)));
    check('2b: marker not duplicated', legs.every(l => (l.evidence.match(/\[overridden\]/g) || []).length === 1));
  }

  // ── 3. calcProfit fallback: win with NO payout/wager → odds-based ──────────
  {
    seedBankroll(1000);
    const BID = 'bet00000000000000000000000000003c';
    seedBet(BID, { bet_type: 'straight', odds: 440, units: 15, payout: null, wager: null, result: 'loss', profit_units: -15 });
    const out = applyGradeOverride(deps, { betId: BID, result: 'win', invokerId: 'admin-1' });
    check('3: ok', out.ok === true);
    check('3: odds-based calcProfit = 66.0', near(out.newProfit, 15 * (440 / 100)));
    check('3: default reason "manual override"', out.gradeReason === 'OVERRIDE: manual override');
    check('3: straight → no legs touched', out.legsTouched === 0);
  }

  // ── 4. Non-win override (loss → void): legs untouched, profit via calcProfit ─
  {
    seedBankroll(1000);
    const BID = 'bet00000000000000000000000000004d';
    seedBet(BID, { bet_type: 'parlay', odds: -110, units: 10, result: 'loss', profit_units: -10 });
    seedLeg(BID, 1, 'loss', 'ev');
    const out = applyGradeOverride(deps, { betId: BID, result: 'void', invokerId: 'admin-1' });
    check('4: ok', out.ok === true);
    check('4: void profit = 0', near(out.newProfit, 0));
    check('4: legs untouched on non-win', out.legsTouched === 0);
    const leg = db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ?').get(BID);
    check('4: leg result unchanged (loss)', leg.result === 'loss');
    // delta = (0 - (-10)) * 25 = 250
    check('4: bankroll delta restores stake', near(out.bankrollDelta, 10 * UNIT));
  }

  // ── 5. Guard rejections ────────────────────────────────────────────────────
  {
    const nf = applyGradeOverride(deps, { betId: 'doesnotexist', result: 'win', invokerId: 'admin-1' });
    check('5: not_found', nf.ok === false && nf.error === 'not_found');

    const BID = 'bet00000000000000000000000000005e';
    seedBet(BID, { result: 'pending', profit_units: 0 });
    const pend = applyGradeOverride(deps, { betId: BID, result: 'win', invokerId: 'admin-1' });
    check('5: pending rejected', pend.ok === false && pend.error === 'pending');

    const BID2 = 'bet00000000000000000000000000006f';
    seedBet(BID2, { result: 'loss', profit_units: -1 });
    const bad = applyGradeOverride(deps, { betId: BID2, result: 'cancelled', invokerId: 'admin-1' });
    check('5: invalid_result rejected', bad.ok === false && bad.error === 'invalid_result');

    const noinv = applyGradeOverride(deps, { betId: BID2, result: 'win', invokerId: null });
    check('5: missing_invoker rejected (archived_by NOT NULL)', noinv.ok === false && noinv.error === 'missing_invoker');
    // No write happened on rejection
    check('5: rejected override wrote no history', historyCount(BID2) === 0);
    check('5: rejected override left result untouched', db.prepare('SELECT result FROM bets WHERE id = ?').get(BID2).result === 'loss');
  }

  console.log(`\ngrade-override: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
