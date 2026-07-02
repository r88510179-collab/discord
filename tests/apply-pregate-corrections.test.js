// ═══════════════════════════════════════════════════════════
// apply-pregate-corrections — correction-table parse/shape test (NO DB).
//
// The script's runtime requires (better-sqlite3, gradeOverride) live inside
// main() behind require.main, so requiring it here is side-effect-free and
// needs no node_modules — this test runs in `npm run check` on any machine.
// It pins the embedded table to the 24 high-confidence rows of
// docs/audits/2026-07-02-pregate-shadow-regrade.md: counts, directions,
// carve-out, default-odds flags, payout-math consistency, net delta.
// ═══════════════════════════════════════════════════════════
'use strict';

const {
  CORRECTIONS, RETRO_ARCHIVE,
  calcProfit, round2, validateCorrectionTable, validateRetroTable,
  ARCHIVED_BY, RETRO_ARCHIVED_BY, PU_TOLERANCE,
} = require('../scripts/apply-pregate-corrections.js');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}
function near(a, b, eps = 0.005) { return Math.abs(a - b) < eps; }
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

// ── 1. Shape validation passes on the shipped tables ────────
{
  let dir = null, ok = true;
  try { dir = validateCorrectionTable(CORRECTIONS); } catch (e) { ok = false; console.log(`  (threw: ${e.message})`); }
  check('1: validateCorrectionTable(CORRECTIONS) passes', ok);
  check('1: validateRetroTable(RETRO_ARCHIVE) passes', !throws(() => validateRetroTable(RETRO_ARCHIVE)));
  check('1: exactly 24 correction rows', CORRECTIONS.length === 24);
  check('1: exactly 3 retro-archive rows', RETRO_ARCHIVE.length === 3);
  check('1: directions 12 loss→win', dir && dir.lossToWin === 12);
  check('1: directions 11 win→loss', dir && dir.winToLoss === 11);
  check('1: directions 1 win→void (23 flips + 1 void)', dir && dir.winToVoid === 1);
}

// ── 2. Carve-out row: 223d9043 = VOID pu 0, cites no-selection precedent ──
{
  const voids = CORRECTIONS.filter(r => r.new_result === 'void');
  check('2: exactly one void row', voids.length === 1);
  const v = voids[0] || {};
  check('2: void row is 223d9043', v.id === '223d9043');
  check('2: void row pu is 0', v.new_pu === 0);
  check('2: void row was stored win', v.expect_stored_result === 'win');
  check('2: reason cites no-selection promo, not the shadow loss', /no-selection/i.test(v.reason || '') && /promo/i.test(v.reason || ''));
  check('2: reason cites 3f78b923 precedent', /3f78b923/.test(v.reason || ''));
}

// ── 3. default-odds rows keep the flag in reason ────────────
{
  const flagged = ['9ab2ddf8', '913416b4', 'f694f90a'];
  for (const id of flagged) {
    const r = CORRECTIONS.find(x => x.id === id);
    check(`3: ${id} reason carries default_odds flag`, !!r && /default[_-]odds/i.test(r.reason));
  }
  const others = CORRECTIONS.filter(r => !flagged.includes(r.id));
  check('3: no other row carries the flag', others.every(r => !/default[_-]odds/i.test(r.reason)));
}

// ── 4. Every row has evidence; net delta matches the audit ──
{
  const evPat = /statsapi\.mlb\.com|site\.api\.espn\.com|api-web\.nhle\.com|docs\/audits\/2026-07-02-pregate-shadow-regrade\.md/;
  check('4: every evidence_url is a known source (or the audit doc for the void carve-out)',
    CORRECTIONS.every(r => evPat.test(r.evidence_url)));
  check('4: only the void row cites the audit doc instead of a score source',
    CORRECTIONS.every(r => r.new_result === 'void' || /statsapi|espn|nhle/.test(r.evidence_url)));
  // Audit: high-confidence subset nets 1.79u (unrounded 1.80) with the shadow
  // LOSS on 223d9043; the void carve-out (0 instead of -1) shifts it +1.00 → +2.80u.
  const net = CORRECTIONS.reduce((s, r) => s + (r.new_pu - r.expect_stored_pu), 0);
  check(`4: net pu delta vs stored is +2.80u (audit 1.80u + 1.00 void shift) — got ${round2(net)}`, near(net, 2.80));
}

// ── 5. Payout-math mirror is self-consistent with new_pu ────
// new_pu must be reproducible from the stored-odds implied by the audit's pu
// columns: loss = -units, void = 0, win = calcProfit at some American odds.
// Without DB odds here, assert the mirror itself + the sign/scale invariants
// the runtime cross-check (±PU_TOLERANCE) relies on.
{
  check('5: calcProfit(-110, 1, win) ≈ 0.9091', near(calcProfit(-110, 1, 'win'), 0.9091, 0.0001));
  check('5: calcProfit(+150, 2, win) = 3', calcProfit(150, 2, 'win') === 3);
  check('5: calcProfit(x, 4, loss) = -4', calcProfit(-135, 4, 'loss') === -4);
  check('5: calcProfit push/void = 0', calcProfit(-110, 3, 'push') === 0 && calcProfit(-110, 3, 'void') === 0);
  check('5: PU_TOLERANCE is 0.02', PU_TOLERANCE === 0.02);
  // Every loss row's new_pu is a negative integer-or-2dp units figure; every
  // win row's is > 0. (Sign already validated; pin the loss = -units scale.)
  check('5: loss rows carry whole-or-2dp negative pu', CORRECTIONS.filter(r => r.new_result === 'loss').every(r => r.new_pu < 0 && near(r.new_pu, round2(r.new_pu), 1e-9)));
}

// ── 6. Retro-archive table pins the documented prior state ──
{
  const byId = Object.fromEntries(RETRO_ARCHIVE.map(r => [r.id, r]));
  check('6: 3e5c01a0 was win +4545.45 → now void', byId['3e5c01a0'] && byId['3e5c01a0'].old_result === 'win' && near(byId['3e5c01a0'].old_profit_units, 4545.45) && byId['3e5c01a0'].expect_current_result === 'void');
  check('6: 3f78b923 was win +45.45 → now void', byId['3f78b923'] && byId['3f78b923'].old_result === 'win' && near(byId['3f78b923'].old_profit_units, 45.45) && byId['3f78b923'].expect_current_result === 'void');
  check('6: b6065d701 was win +3.64 → now loss', byId['b6065d701'] && byId['b6065d701'].old_result === 'win' && near(byId['b6065d701'].old_profit_units, 3.64) && byId['b6065d701'].expect_current_result === 'loss');
  check('6: archived_by constants', ARCHIVED_BY === 'shadow-regrade-2026-07-02' && RETRO_ARCHIVED_BY === 'operator-retro-2026-07-02');
}

// ── 7. Validator actually rejects malformed tables (RED half) ──
{
  const good = { id: 'abcd1234', sport: 'MLB', market: 'ML', desc: 'x', expect_stored_result: 'loss', expect_stored_pu: -1, new_result: 'win', new_pu: 0.91, reason: 'r', evidence_url: 'e' };
  check('7: rejects duplicate ids', throws(() => validateCorrectionTable([good, { ...good }])));
  check('7: rejects bad result enum', throws(() => validateCorrectionTable([{ ...good, new_result: 'won' }])));
  check('7: rejects no-op flip (new == stored)', throws(() => validateCorrectionTable([{ ...good, new_result: 'loss' }])));
  check('7: rejects win with non-positive pu', throws(() => validateCorrectionTable([{ ...good, new_pu: -0.91 }])));
  check('7: rejects void with non-zero pu', throws(() => validateCorrectionTable([{ ...good, expect_stored_result: 'win', new_result: 'void', new_pu: 0.5 }])));
  check('7: rejects non-hex id', throws(() => validateCorrectionTable([{ ...good, id: 'ZZZZZZZZ' }])));
  check('7: rejects empty reason', throws(() => validateCorrectionTable([{ ...good, reason: ' ' }])));
  check('7: retro validator rejects bad old_result', throws(() => validateRetroTable([{ id: 'abcd1234', old_result: 'w', old_profit_units: 1, expect_current_result: 'void', reason: 'r' }])));
}

console.log(`\napply-pregate-corrections: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
