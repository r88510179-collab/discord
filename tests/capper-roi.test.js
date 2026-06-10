// ═══════════════════════════════════════════════════════════
// Capper ROI — calculation + display correctness (fix/capper-roi-display)
//
// ROI% = 100 × Σ(profit_units) ÷ Σ(units risked), over SETTLED bets
//        (result IN win/loss/push AND profit_units IS NOT NULL). Defined ONCE in
//        services/database.js (CAPPER_STATS_COLUMNS) and shared verbatim by
//        getCapperStats() + getLeaderboard().
//
// Regressions this guards (all reproduced read-only against /data/bettracker.db
// 2026-06-10, season "Beta"):
//   • Arbitrary per-bet MAX(units,1) floor inflated risked capital — capperledger
//     (0W-4L, stakes 0.09/1/1/1u, lost it all) read -77.3% instead of -100%.
//   • Numerator counted push profit but denominator excluded push stake — the two
//     halves now read the identical row set.
//   • Non-numeric `units` ("N/A") leaked through SQLite's scalar MAX(); now CAST
//     to REAL → 0, and graded-but-unpriced (profit_units NULL) rows drop out of
//     BOTH halves instead of counting stake with no profit.
//   • No silent ROI cap: dangambleai's real +2498.5% (a +5097 hit on 1u) is shown,
//     not clamped to 500%.
//   • Zero-risk capper → 0% (no division by zero, roi_pct is a finite number,
//     never NULL — render sites do `${roi_pct}%`).
//
// Each scenario uses its own capper so getCapperStats() is isolated. Rows are
// created the real way (createBet → all columns/defaults) then "settled" via a
// second connection to the same DB file for exact control over result /
// profit_units / units (incl. NULL profit and text "N/A" stakes).
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbFile = path.join(os.tmpdir(), `bettracker-capper-roi-${process.pid}-${Math.floor(process.hrtime()[1])}.db`);
process.env.DB_PATH = dbFile;
// Leave ACTIVE_SEASON unset → defaults to 'Beta' in both createBet and the
// stats queries, so seeded bets and the read line up.

const database = require('../services/database');
const raw = new Database(dbFile); // second handle for precise settlement writes
const setResult = raw.prepare('UPDATE bets SET result = ?, profit_units = ?, units = ? WHERE id = ?');

let capperSeq = 0;
function newCapper(name) {
  capperSeq += 1;
  return database.getOrCreateCapper(`roi-test-${process.pid}-${capperSeq}`, name).id;
}

// Create a confirmed bet then stamp its settled state directly.
//   result      — 'win' | 'loss' | 'push' | 'void' | 'pending'
//   profitUnits — number, or null (graded-but-unpriced anomaly)
//   units       — number, or a string like 'N/A' (legacy text-garbage stake)
function seedBet(capperId, { result, profitUnits, units, desc }) {
  const bet = database.createBet({
    capper_id: capperId,
    description: desc,
    sport: 'NBA',
    odds: -110,
    units: 1,
    event_date: null,
  });
  assert.ok(bet && bet.id && !bet._deduped, `fixture bet should be freshly created: ${desc}`);
  if (result === 'pending') {
    // createBet already stores result='pending'; only adjust units if needed.
    setResult.run('pending', null, units, bet.id);
  } else {
    setResult.run(result, profitUnits, units, bet.id);
  }
  return bet.id;
}

const results = [];
function check(label, fn) {
  try { fn(); results.push(`  ✓ ${label}`); }
  catch (e) { results.push(`  ✗ ${label}\n      ${e.message}`); throw e; }
}

// ── Scenario A — standard win/loss mix (nonzero P/L ⇒ nonzero ROI) ──
const A = newCapper('A_mix');
seedBet(A, { result: 'win',  profitUnits: 1.0, units: 1, desc: 'A win one' });
seedBet(A, { result: 'win',  profitUnits: 1.5, units: 1, desc: 'A win two' });
seedBet(A, { result: 'loss', profitUnits: -1.0, units: 1, desc: 'A loss one' });
check('standard mix: profit +1.5u / 3u risked = +50.0% ROI', () => {
  const s = database.getCapperStats(A);
  assert.strictEqual(s.wins, 2);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.total_profit_units, 1.5);
  assert.strictEqual(s.win_pct, 66.7);
  assert.strictEqual(s.roi_pct, 50.0);
  // Nonzero P/L must never render as +0% (the historical display bug).
  assert.notStrictEqual(s.roi_pct, 0);
});

// ── Scenario B — big-odds win: real ROI shown, NOT capped at 500% ──
const B = newCapper('B_bigodds');
seedBet(B, { result: 'win',  profitUnits: 50.97, units: 1, desc: 'B +5097 longshot' });
seedBet(B, { result: 'loss', profitUnits: -1.0,  units: 1, desc: 'B loss' });
check('big-odds win: +49.97u / 2u = +2498.5% (uncapped real value)', () => {
  const s = database.getCapperStats(B);
  assert.strictEqual(s.total_profit_units, 49.97);
  assert.strictEqual(s.roi_pct, 2498.5);
  assert.ok(s.roi_pct > 500, 'value above 500% is preserved, not clamped');
});

// ── Scenario C — sub-1u stake: floor removed ⇒ true -100%, not -77% ──
const C = newCapper('C_floor');
seedBet(C, { result: 'loss', profitUnits: -0.09, units: 0.09, desc: 'C parlay sub-unit' });
seedBet(C, { result: 'loss', profitUnits: -1.0,  units: 1, desc: 'C loss 1' });
seedBet(C, { result: 'loss', profitUnits: -1.0,  units: 1, desc: 'C loss 2' });
seedBet(C, { result: 'loss', profitUnits: -1.0,  units: 1, desc: 'C loss 3' });
check('sub-1u 0-4 capper: -3.09u / 3.09u risked = -100.0% (not floored -77.2%)', () => {
  const s = database.getCapperStats(C);
  assert.strictEqual(s.losses, 4);
  assert.strictEqual(s.total_profit_units, -3.09);
  assert.strictEqual(s.roi_pct, -100.0);
  // The old MAX(units,1) floor produced -77.2/-77.3 here.
  assert.ok(s.roi_pct < -90, `floor must be gone (was ~-77%), got ${s.roi_pct}`);
});

// ── Scenario D — zero-risked edge cases: no division by zero ──
const Dpending = newCapper('D_pending');
seedBet(Dpending, { result: 'pending', profitUnits: null, units: 1, desc: 'D pending 1' });
seedBet(Dpending, { result: 'pending', profitUnits: null, units: 1, desc: 'D pending 2' });
check('only pending bets: ROI 0%, finite, never NULL/NaN', () => {
  const s = database.getCapperStats(Dpending);
  assert.strictEqual(s.total_bets, 2);
  assert.strictEqual(s.pending, 2);
  assert.strictEqual(s.total_profit_units, 0);
  assert.strictEqual(s.roi_pct, 0);
  assert.strictEqual(typeof s.roi_pct, 'number');
  assert.ok(Number.isFinite(s.roi_pct), 'roi_pct must be finite');
});

const Dvoid = newCapper('D_void');
seedBet(Dvoid, { result: 'void', profitUnits: 0, units: 1, desc: 'D void 1' });
check('only void bets (capital returned): ROI 0%, no settled stake', () => {
  const s = database.getCapperStats(Dvoid);
  assert.strictEqual(s.roi_pct, 0);
  assert.strictEqual(s.total_profit_units, 0);
});

// ── Scenario E — push stake counts in the denominator ──
const E = newCapper('E_push');
seedBet(E, { result: 'win',  profitUnits: 1.0, units: 1, desc: 'E win' });
seedBet(E, { result: 'push', profitUnits: 0,   units: 4, desc: 'E push 4u' });
check('push: +1u / (1u + 4u push) = +20.0% (push stake is risked capital)', () => {
  const s = database.getCapperStats(E);
  assert.strictEqual(s.pushes, 1);
  assert.strictEqual(s.total_profit_units, 1.0);
  // Old W/L-only denominator would have read +100% (push stake ignored).
  assert.strictEqual(s.roi_pct, 20.0);
});

// ── Scenario F — graded-but-unpriced / text-garbage units excluded ──
const Fonly = newCapper('F_anomaly_only');
seedBet(Fonly, { result: 'win', profitUnits: null, units: 'N/A', desc: 'F anomaly win' });
check('lone graded win with NULL profit + "N/A" units: ROI 0%, win counted', () => {
  const s = database.getCapperStats(Fonly);
  assert.strictEqual(s.wins, 1);          // record still reflects the bet
  assert.strictEqual(s.total_profit_units, 0);
  assert.strictEqual(s.roi_pct, 0);       // excluded from both halves, no NaN
  assert.ok(Number.isFinite(s.roi_pct));
});

const Fmix = newCapper('F_anomaly_mix');
seedBet(Fmix, { result: 'win', profitUnits: 1.5,  units: 1,     desc: 'F real win' });
seedBet(Fmix, { result: 'win', profitUnits: null, units: 'N/A', desc: 'F anomaly win 2' });
check('real win + anomaly win: garbage units do not poison ⇒ +150.0%', () => {
  const s = database.getCapperStats(Fmix);
  assert.strictEqual(s.wins, 2);
  assert.strictEqual(s.total_profit_units, 1.5);
  assert.strictEqual(s.roi_pct, 150.0);   // 1.5 / 1, the "N/A" stake → 0
});

// ── Scenario G — net-zero P/L genuinely is 0% ──
const G = newCapper('G_netzero');
seedBet(G, { result: 'win',  profitUnits: 1.0,  units: 1, desc: 'G win' });
seedBet(G, { result: 'loss', profitUnits: -1.0, units: 1, desc: 'G loss' });
check('net-zero P/L: +1 - 1 = 0u / 2u = 0.0% (correctly zero)', () => {
  const s = database.getCapperStats(G);
  assert.strictEqual(s.total_profit_units, 0);
  assert.strictEqual(s.roi_pct, 0);
});

// ── Scenario H — getCapperStats and getLeaderboard agree (one formula) ──
check('unification: getLeaderboard row === getCapperStats for same capper', () => {
  const board = database.getLeaderboard('roi_pct', 100);
  for (const id of [A, B, C, E, Fmix, G]) {
    const s = database.getCapperStats(id);
    const lb = board.find(r => r.id === id);
    assert.ok(lb, `capper ${s.display_name} present on leaderboard`);
    assert.strictEqual(lb.roi_pct, s.roi_pct, `roi_pct parity for ${s.display_name}`);
    assert.strictEqual(lb.total_profit_units, s.total_profit_units, `profit parity for ${s.display_name}`);
    assert.strictEqual(lb.win_pct, s.win_pct, `win_pct parity for ${s.display_name}`);
    assert.strictEqual(lb.wins, s.wins, `wins parity for ${s.display_name}`);
    assert.strictEqual(lb.losses, s.losses, `losses parity for ${s.display_name}`);
  }
  // Sort actually orders by ROI: big-odds capper (B) outranks the mix (A).
  const ranks = board.map(r => r.id);
  assert.ok(ranks.indexOf(B) < ranks.indexOf(A), 'higher ROI sorts first');
});

raw.close();
try { fs.unlinkSync(dbFile); } catch (_) {}
try { fs.unlinkSync(`${dbFile}-wal`); } catch (_) {}
try { fs.unlinkSync(`${dbFile}-shm`); } catch (_) {}

console.log('capper-roi.test.js — all assertions passed');
console.log(results.join('\n'));
