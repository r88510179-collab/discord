// ═══════════════════════════════════════════════════════════
// apply-tierb-corrections — correction-table parse/shape test (NO DB).
//
// The script's runtime requires (better-sqlite3, gradeOverride) live inside
// main() behind require.main, so requiring it here is side-effect-free and
// needs no node_modules — this test runs in `npm run check` on any machine.
// It pins the embedded table to the 4 externally-verified PINNED rows of
// docs/audits/2026-07-03-pregate-tierb-reanchor.md: count, directions,
// evidence sources, payout-math consistency, and the net delta (-7.64u).
// ═══════════════════════════════════════════════════════════
'use strict';

const {
  CORRECTIONS,
  calcProfit, round2, validateCorrectionTable,
  ARCHIVED_BY, PU_TOLERANCE,
} = require('../scripts/apply-tierb-corrections.js');

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
  check('1: exactly 4 correction rows', CORRECTIONS.length === 4);
  check('1: directions 1 loss→win', dir && dir.lossToWin === 1);
  check('1: directions 3 win→loss', dir && dir.winToLoss === 3);
  check('1: directions 0 win→void (no void rows in Tier B pinned set)', dir && dir.winToVoid === 0);
}

// ── 2. The exact 4 pinned ids, and 2c12a667 is NOT present ──
{
  const ids = CORRECTIONS.map(r => r.id).sort();
  check('2: table ids are exactly {320bc36b, b5bb1ad7, d7bf7159, f4946029}',
    JSON.stringify(ids) === JSON.stringify(['320bc36b', 'b5bb1ad7', 'd7bf7159', 'f4946029']));
  check('2: reclassified 2c12a667 (Angels ML) is deliberately absent',
    !CORRECTIONS.some(r => r.id === '2c12a667'));
  // Per-row stored→new direction pinned to the audit's disagreement table.
  const byId = Object.fromEntries(CORRECTIONS.map(r => [r.id, r]));
  check('2: 320bc36b NHL game_total win→loss', byId['320bc36b'] && byId['320bc36b'].sport === 'NHL' && byId['320bc36b'].market === 'game_total' && byId['320bc36b'].expect_stored_result === 'win' && byId['320bc36b'].new_result === 'loss');
  check('2: d7bf7159 NBA spread loss→win', byId['d7bf7159'] && byId['d7bf7159'].sport === 'NBA' && byId['d7bf7159'].market === 'spread' && byId['d7bf7159'].expect_stored_result === 'loss' && byId['d7bf7159'].new_result === 'win');
  check('2: b5bb1ad7 NBA game_total win→loss', byId['b5bb1ad7'] && byId['b5bb1ad7'].sport === 'NBA' && byId['b5bb1ad7'].market === 'game_total' && byId['b5bb1ad7'].expect_stored_result === 'win' && byId['b5bb1ad7'].new_result === 'loss');
  check('2: f4946029 NBA game_total win→loss', byId['f4946029'] && byId['f4946029'].sport === 'NBA' && byId['f4946029'].market === 'game_total' && byId['f4946029'].expect_stored_result === 'win' && byId['f4946029'].new_result === 'loss');
}

// ── 3. Every reason carries the Tier B provenance + a date ──
{
  check('3: every reason cites "Tier B re-anchor + external verify"',
    CORRECTIONS.every(r => /Tier B re-anchor \+ external verify/.test(r.reason)));
  check('3: every reason carries the snowflake re-anchor note',
    CORRECTIONS.every(r => /snowflake corrected \d\d-\d\d→\d\d-\d\d/.test(r.reason)));
}

// ── 4. Every row has a known-source evidence_url; net delta = -7.64u ──
{
  const evPat = /site\.api\.espn\.com|api-web\.nhle\.com/;
  check('4: every evidence_url is a known score source (ESPN / NHL)',
    CORRECTIONS.every(r => evPat.test(r.evidence_url)));
  check('4: 320bc36b evidence is an NHL score url', /api-web\.nhle\.com/.test((CORRECTIONS.find(r => r.id === '320bc36b') || {}).evidence_url || ''));
  check('4: the 3 NBA rows cite ESPN', CORRECTIONS.filter(r => r.sport === 'NBA').every(r => /site\.api\.espn\.com/.test(r.evidence_url)));
  // Audit ΔPU column: -5.7273 + 1.9091 - 1.9091 - 1.9091 = -7.6364u, rounds to -7.64u.
  const net = CORRECTIONS.reduce((s, r) => s + (r.new_pu - r.expect_stored_pu), 0);
  check(`4: net pu delta vs stored is -7.64u (±0.01) — got ${round2(net)}`, near(net, -7.64, 0.01));
}

// ── 5. Payout-math mirror is self-consistent with new_pu ────
// Every loss row's new_pu = -units; the lone win row is a -110 default-odds
// win (0.9091×units). Assert the mirror + the sign/scale invariants the
// runtime cross-check (±PU_TOLERANCE) relies on.
{
  check('5: calcProfit(-110, 1, win) ≈ 0.9091', near(calcProfit(-110, 1, 'win'), 0.9091, 0.0001));
  check('5: calcProfit(x, 3, loss) = -3', calcProfit(-110, 3, 'loss') === -3);
  check('5: calcProfit(x, 1, loss) = -1', calcProfit(-150, 1, 'loss') === -1);
  check('5: calcProfit push/void = 0', calcProfit(-110, 3, 'push') === 0 && calcProfit(-110, 3, 'void') === 0);
  check('5: PU_TOLERANCE is 0.02', PU_TOLERANCE === 0.02);
  check('5: ARCHIVED_BY is the tierb re-anchor stamp', ARCHIVED_BY === 'tierb-reanchor-2026-07-03');
  // Win rows > 0, loss rows < 0 and whole-or-2dp on the loss = -units scale.
  check('5: win rows carry positive pu', CORRECTIONS.filter(r => r.new_result === 'win').every(r => r.new_pu > 0));
  check('5: loss rows carry negative pu', CORRECTIONS.filter(r => r.new_result === 'loss').every(r => r.new_pu < 0 && near(r.new_pu, round2(r.new_pu), 1e-9)));
  // The lone win row's new_pu reproduces from -110 default odds (odds empty in the export).
  const win = CORRECTIONS.find(r => r.new_result === 'win');
  check('5: win row new_pu reproduces from calcProfit(-110, 1, win) within tolerance',
    win && Math.abs(round2(calcProfit(-110, 1, 'win')) - win.new_pu) <= PU_TOLERANCE);
}

// ── 6. Validator actually rejects malformed tables (RED half) ──
{
  const good = { id: 'abcd1234', sport: 'NBA', market: 'ML', desc: 'x', expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91, reason: 'r', evidence_url: 'e' };
  check('6: rejects duplicate ids', throws(() => validateCorrectionTable([good, { ...good }])));
  check('6: rejects bad result enum', throws(() => validateCorrectionTable([{ ...good, new_result: 'won' }])));
  check('6: rejects no-op flip (new == stored)', throws(() => validateCorrectionTable([{ ...good, new_result: 'loss' }])));
  check('6: rejects win with non-positive pu', throws(() => validateCorrectionTable([{ ...good, new_pu: -0.91 }])));
  check('6: rejects loss with non-negative pu', throws(() => validateCorrectionTable([{ ...good, expect_stored_result: 'win', new_result: 'loss', new_pu: 0.5 }])));
  check('6: rejects non-hex id', throws(() => validateCorrectionTable([{ ...good, id: 'ZZZZZZZZ' }])));
  check('6: rejects empty reason', throws(() => validateCorrectionTable([{ ...good, reason: ' ' }])));
  check('6: rejects empty evidence_url', throws(() => validateCorrectionTable([{ ...good, evidence_url: ' ' }])));
  check('6: rejects empty table', throws(() => validateCorrectionTable([])));
}

console.log(`\napply-tierb-corrections: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
