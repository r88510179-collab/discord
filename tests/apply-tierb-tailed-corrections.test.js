// ═══════════════════════════════════════════════════════════
// apply-tierb-tailed-corrections — correction-table + fade-inversion test (NO DB).
//
// The script's runtime requires (better-sqlite3, gradeOverride) live inside
// main() behind require.main, so requiring it here is side-effect-free and needs
// no node_modules — this test runs in `npm run check` on any machine. It pins the
// embedded table to the 3 TAIL-GATED PINNED rows of
// docs/audits/2026-07-03-pregate-tierb-reanchor.md (#172's 4 pinned rows minus the
// 0-tail 320bc36b it already applied): count, directions, evidence, payout-math,
// the fade-inversion settlement mapping, and BOTH net figures (ΔPU -1.91u and the
// Σ-new-profit-units -1.09u the audit doc quotes).
// ═══════════════════════════════════════════════════════════
'use strict';

const {
  CORRECTIONS,
  calcProfit, round2, validateCorrectionTable, settleTailStatus,
  ARCHIVED_BY, PU_TOLERANCE, SYNTHETIC_USER_ID, SETTLED_STATUSES,
} = require('../scripts/apply-tierb-tailed-corrections.js');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}
function near(a, b, eps = 0.005) { return Math.abs(a - b) < eps; }
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

// ── 1. Shape validation passes on the shipped table ─────────
{
  let dir = null, ok = true;
  try { dir = validateCorrectionTable(CORRECTIONS); } catch (e) { ok = false; console.log(`  (threw: ${e.message})`); }
  check('1: validateCorrectionTable(CORRECTIONS) passes', ok);
  check('1: exactly 3 tail-gated correction rows', CORRECTIONS.length === 3);
  check('1: directions 1 loss→win', dir && dir.lossToWin === 1);
  check('1: directions 2 win→loss', dir && dir.winToLoss === 2);
  check('1: directions 0 win→void (no void rows in the tailed pinned set)', dir && dir.winToVoid === 0);
}

// ── 2. The exact 3 tailed ids; the 0-tail 320bc36b and the reclassified
//      2c12a667 are BOTH absent ──────────────────────────────
{
  const ids = CORRECTIONS.map(r => r.id).sort();
  check('2: table ids are exactly {b5bb1ad7, d7bf7159, f4946029}',
    JSON.stringify(ids) === JSON.stringify(['b5bb1ad7', 'd7bf7159', 'f4946029']));
  check('2: 0-tail 320bc36b (applied by #172) is absent',
    !CORRECTIONS.some(r => r.id === '320bc36b'));
  check('2: reclassified 2c12a667 (Angels ML) is absent',
    !CORRECTIONS.some(r => r.id === '2c12a667'));
  // Per-row stored→new direction pinned to the audit's disagreement table.
  const byId = Object.fromEntries(CORRECTIONS.map(r => [r.id, r]));
  check('2: d7bf7159 NBA spread loss→win', byId['d7bf7159'] && byId['d7bf7159'].sport === 'NBA' && byId['d7bf7159'].market === 'spread' && byId['d7bf7159'].expect_stored_result === 'loss' && byId['d7bf7159'].new_result === 'win');
  check('2: b5bb1ad7 NBA game_total win→loss', byId['b5bb1ad7'] && byId['b5bb1ad7'].sport === 'NBA' && byId['b5bb1ad7'].market === 'game_total' && byId['b5bb1ad7'].expect_stored_result === 'win' && byId['b5bb1ad7'].new_result === 'loss');
  check('2: f4946029 NBA game_total win→loss', byId['f4946029'] && byId['f4946029'].sport === 'NBA' && byId['f4946029'].market === 'game_total' && byId['f4946029'].expect_stored_result === 'win' && byId['f4946029'].new_result === 'loss');
}

// ── 3. Every reason carries the Tier B provenance + a snowflake note ──
{
  check('3: every reason cites "Tier B re-anchor + external verify"',
    CORRECTIONS.every(r => /Tier B re-anchor \+ external verify/.test(r.reason)));
  check('3: every reason carries the snowflake re-anchor note',
    CORRECTIONS.every(r => /snowflake corrected \d\d-\d\d→\d\d-\d\d/.test(r.reason)));
}

// ── 4. Evidence sources + BOTH net figures ──────────────────
{
  check('4: every evidence_url is ESPN (all 3 rows are NBA)',
    CORRECTIONS.every(r => /site\.api\.espn\.com/.test(r.evidence_url)));
  // ΔPU (running-total impact) = Σ(new − stored) = +1.9091 −1.9091 −1.9091 = −1.9091u.
  const netDelta = CORRECTIONS.reduce((s, r) => s + (r.new_pu - r.expect_stored_pu), 0);
  check(`4: net ΔPU vs stored is -1.91u (±0.01) — got ${round2(netDelta)}`, near(netDelta, -1.9091, 0.01));
  // Σ(new_pu) = what the 3 corrected rows now CARRY = +0.9091 −1.00 −1.00 = −1.0909u.
  // This is the audit doc's "-1.09u"; it is NOT the running-total delta above.
  const sumNewPu = CORRECTIONS.reduce((s, r) => s + r.new_pu, 0);
  check(`4: Σ new profit_units is -1.09u (±0.01) — got ${round2(sumNewPu)}`, near(sumNewPu, -1.0909, 0.01));
  // Combined with #172's 320bc36b (-5.7273u ΔPU) the pinned set totals the full
  // pre-tail estimate — the tail gate deferred, it did not drop, any correction.
  check('4: #172 (-5.7273) + this (ΔPU) = -7.64u pre-tail estimate',
    near(-5.7273 + netDelta, -7.6364, 0.01));
}

// ── 5. Payout-math mirror is self-consistent with new_pu ────
{
  check('5: calcProfit(-110, 1, win) ≈ 0.9091', near(calcProfit(-110, 1, 'win'), 0.9091, 0.0001));
  check('5: calcProfit(x, 1, loss) = -1', calcProfit(-150, 1, 'loss') === -1);
  check('5: calcProfit push/void = 0', calcProfit(-110, 1, 'push') === 0 && calcProfit(-110, 1, 'void') === 0);
  check('5: PU_TOLERANCE is 0.02', PU_TOLERANCE === 0.02);
  check('5: ARCHIVED_BY is the tierb-TAILED stamp', ARCHIVED_BY === 'tierb-tailed-2026-07-03');
  check('5: win rows carry positive pu', CORRECTIONS.filter(r => r.new_result === 'win').every(r => r.new_pu > 0));
  check('5: loss rows carry negative pu', CORRECTIONS.filter(r => r.new_result === 'loss').every(r => r.new_pu < 0 && near(r.new_pu, round2(r.new_pu), 1e-9)));
  // The lone win row's new_pu reproduces from -110 default odds (odds empty in the export).
  const win = CORRECTIONS.find(r => r.new_result === 'win');
  check('5: win row new_pu reproduces from calcProfit(-110, 1, win) within tolerance',
    win && Math.abs(round2(calcProfit(-110, 1, 'win')) - win.new_pu) <= PU_TOLERANCE);
}

// ── 6. Fade-inversion settlement mapping ────────────────────
// A fade WINS when the bet LOSES and LOSES when the bet WINS; a tail mirrors.
{
  check('6: fade + bet loss ⇒ won', settleTailStatus('fade', 'loss') === 'won');
  check('6: fade + bet win  ⇒ lost', settleTailStatus('fade', 'win') === 'lost');
  check('6: tail + bet win  ⇒ won (mirror)', settleTailStatus('tail', 'win') === 'won');
  check('6: tail + bet loss ⇒ lost (mirror)', settleTailStatus('tail', 'loss') === 'lost');
  check('6: throws on unknown action', throws(() => settleTailStatus('hedge', 'win')));
  check('6: throws on non-win/loss bet result (push/void do not settle here)',
    throws(() => settleTailStatus('fade', 'push')) && throws(() => settleTailStatus('fade', 'void')));
  // Applied to the shipped table: the 2 win→loss rows settle a fade to 'won',
  // the 1 loss→win row settles a fade to 'lost'. (All 3 real tails are fades.)
  const settled = CORRECTIONS.map(r => settleTailStatus('fade', r.new_result));
  const won = settled.filter(s => s === 'won').length;
  const lost = settled.filter(s => s === 'lost').length;
  check('6: table fade-settles to 2 won + 1 lost', won === 2 && lost === 1);
  check('6: SETTLED_STATUSES is exactly {won, lost}',
    JSON.stringify([...SETTLED_STATUSES].sort()) === JSON.stringify(['lost', 'won']));
}

// ── 7. Relaxed-gate constant is the one synthetic id ────────
{
  check('7: SYNTHETIC_USER_ID is the operator-verified synthetic identity',
    SYNTHETIC_USER_ID === '1059681615418236948');
}

// ── 8. Validator + settle actually reject malformed input (RED half) ──
{
  const good = { id: 'abcd1234', sport: 'NBA', market: 'ML', desc: 'x', expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91, reason: 'r', evidence_url: 'e' };
  check('8: rejects duplicate ids', throws(() => validateCorrectionTable([good, { ...good }])));
  check('8: rejects bad result enum', throws(() => validateCorrectionTable([{ ...good, new_result: 'won' }])));
  check('8: rejects no-op flip (new == stored)', throws(() => validateCorrectionTable([{ ...good, new_result: 'loss' }])));
  check('8: rejects win with non-positive pu', throws(() => validateCorrectionTable([{ ...good, new_pu: -0.91 }])));
  check('8: rejects loss with non-negative pu', throws(() => validateCorrectionTable([{ ...good, expect_stored_result: 'win', new_result: 'loss', new_pu: 0.5 }])));
  check('8: rejects non-hex id', throws(() => validateCorrectionTable([{ ...good, id: 'ZZZZZZZZ' }])));
  check('8: rejects empty reason', throws(() => validateCorrectionTable([{ ...good, reason: ' ' }])));
  check('8: rejects empty evidence_url', throws(() => validateCorrectionTable([{ ...good, evidence_url: ' ' }])));
  check('8: rejects empty table', throws(() => validateCorrectionTable([])));
}

console.log(`\napply-tierb-tailed-corrections: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
