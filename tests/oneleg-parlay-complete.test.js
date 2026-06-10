// ═══════════════════════════════════════════════════════════
// Complete 1-leg parlays must grade; genuine missing-legs must keep rejecting.
//
// Bug this closes: a single pick (e.g. "• Marlins ML +130") stored as a parlay
// with exactly ONE parlay_legs row was permanently ungradeable — the early
// dispatch guard rejected every parlay with ≤1 recorded leg with
// "Parlay has N recorded legs — cannot grade without leg data. Manual review
// required." Live specimens (read-only verified 2026-06-10 against
// /data/bettracker.db):
//   ee2f755db6288a02418d429c17329508  "• New York Yankees ML (-145)"   1 bullet / 1 leg
//   f71cbbc54012de3ddc14c8232ba36364  "• Marlins ML +130"              1 bullet / 1 leg
//   a1f9255b09b83dad46e2151e190aa0a7  "• Colorado Avalanche ML -125"   1 bullet / 1 leg
// Counter-specimen (MUST keep rejecting): a multi-pick caption collapsed to one
// leg row —
//   7b04366b0a8d7d5211e7c60a782f8450  "Nikola Jokic, Jalen Brunson & Donovan
//                                       Mitchell to Combine for 100+ Points,
//                                       25+ Rebounds & 25+ Assists"     0 bullets / 1 leg
//
// "Expected" pick count is the description's bullet (•) count — the same signal
// the leg-explosion guard uses. Complete ⇔ expected == recorded (≥1 leg).
//
// Stub the network BEFORE requiring grading.js so the complete-path dispatch
// assertion never touches the wire. Throwaway DB_PATH because requiring
// grading.js loads database.js transitively.
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network: any fetch rejects fast. The complete-path dispatch test
// only needs to confirm the leg-data guard did NOT short-circuit; a thrown
// error or a non-guard PENDING both prove that (the guard returns, never throws).
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

const dbFile = path.join(os.tmpdir(), `bettracker-oneleg-parlay-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const database = require('../services/database');
const { parlayLegDataComplete } = grading._internal;

// Throwaway DB: we only need parlay_legs rows so the dispatcher's leg COUNT is
// right (gradePropWithAI reads the bet itself from the object we pass, never the
// bets table). Skip FK enforcement so we don't have to seed bets/cappers rows.
database.db.pragma('foreign_keys = OFF');

const GUARD_RE = /cannot grade without leg data/i;
const insertLeg = database.db.prepare('INSERT INTO parlay_legs (id, bet_id, description, odds) VALUES (?, ?, ?, ?)');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}

(async () => {
  try {
    console.log('oneleg-parlay-complete:');

    // ── Pure decision: parlayLegDataComplete(description, legCount) ──
    console.log(' parlayLegDataComplete (pure):');
    // Live specimens — single pick stored as a 1-leg parlay → COMPLETE.
    check('"• New York Yankees ML (-145)" / 1 leg  -> complete', parlayLegDataComplete('• New York Yankees ML (-145)', 1), true);
    check('"• Marlins ML +130" / 1 leg            -> complete', parlayLegDataComplete('• Marlins ML +130', 1), true);
    check('"• Colorado Avalanche ML -125" / 1 leg -> complete', parlayLegDataComplete('• Colorado Avalanche ML -125', 1), true);

    // Counter-specimen — caption names 3 players, 0 bullets, 1 leg → INCOMPLETE.
    check('7b04366b combine-prop caption / 1 leg  -> incomplete',
      parlayLegDataComplete('Nikola Jokic, Jalen Brunson & Donovan Mitchell to Combine for 100+ Points, 25+ Rebounds & 25+ Assists', 1), false);

    // Genuine missing legs — description names 3 picks (3 bullets) but 1 leg row.
    check('3 bullets / 1 leg                      -> incomplete', parlayLegDataComplete('• A\n• B\n• C', 1), false);
    // No leg data at all.
    check('1 bullet / 0 legs                      -> incomplete', parlayLegDataComplete('• Marlins ML +130', 0), false);
    check('any desc / 0 legs                      -> incomplete', parlayLegDataComplete('• A\n• B', 0), false);
    // Complete multi-leg (bypasses the ≤1 branch at dispatch, but the pure
    // predicate still recognizes coverage).
    check('3 bullets / 3 legs                     -> complete',   parlayLegDataComplete('• A\n• B\n• C', 3), true);
    // Defensive: non-integer / negative counts are never complete.
    check('null desc / 1 leg                      -> incomplete', parlayLegDataComplete(null, 1), false);
    check('1 bullet / null count                  -> incomplete', parlayLegDataComplete('• A', null), false);

    // ── Dispatch through the real gradePropWithAI ──
    // The reject path short-circuits BEFORE any network, so these are fully
    // offline + deterministic, and assert the evidence string is byte-identical
    // to the pre-fix guard message.
    console.log(' gradePropWithAI dispatch:');

    // Counter-specimen shape: 1 leg, 0 bullets, supported sport → still rejects.
    const counterId = 'test_oneleg_counter_7b04366b';
    insertLeg.run(`${counterId}-l1`, counterId, 'Nikola Jokic, Jalen Brunson & Donovan Mitchell to Combine for 100+ Points, 25+ Rebounds & 25+ Assists', 4000);
    const counterBet = {
      id: counterId,
      bet_type: 'parlay',
      sport: 'NBA',
      description: 'Nikola Jokic, Jalen Brunson & Donovan Mitchell to Combine for 100+ Points, 25+ Rebounds & 25+ Assists',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const counterRes = await grading.gradePropWithAI(counterBet);
    check('counter-specimen (0 bullets / 1 leg) -> PENDING, unchanged reason',
      counterRes,
      { status: 'PENDING', evidence: 'Parlay has 1 recorded legs — cannot grade without leg data. Manual review required.' });

    // Zero-leg parlay → still rejects, unchanged reason (count = 0).
    const zeroId = 'test_oneleg_zero';
    const zeroBet = {
      id: zeroId,
      bet_type: 'parlay',
      sport: 'MLB',
      description: '• Marlins ML +130',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const zeroRes = await grading.gradePropWithAI(zeroBet);
    check('zero-leg parlay -> PENDING, unchanged reason',
      zeroRes,
      { status: 'PENDING', evidence: 'Parlay has 0 recorded legs — cannot grade without leg data. Manual review required.' });

    // bet_type 'sgp' rides the SAME guard as 'parlay' (gradePropWithAI dispatch
    // is `betType === 'parlay' || betType === 'sgp'`): an incomplete SGP
    // (0 bullets / 1 leg) still rejects with the unchanged reason.
    const sgpId = 'test_oneleg_sgp';
    insertLeg.run(`${sgpId}-l1`, sgpId, 'Magic @ Pistons SGP — combine for a Wagner PR', 250);
    const sgpBet = {
      id: sgpId,
      bet_type: 'sgp',
      sport: 'NBA',
      description: 'Magic @ Pistons SGP — combine for a Wagner PR',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const sgpRes = await grading.gradePropWithAI(sgpBet);
    check('incomplete SGP (0 bullets / 1 leg) -> PENDING, unchanged reason',
      sgpRes,
      { status: 'PENDING', evidence: 'Parlay has 1 recorded legs — cannot grade without leg data. Manual review required.' });

    // Complete 1-leg parlay (1 bullet, 1 leg, supported sport) → NOT rejected by
    // the leg-data guard; control proceeds into gradeParlay. With the network
    // stubbed the leg can't resolve, so the bet settles to some non-guard
    // outcome (or throws) — either way the guard was bypassed. The decisive
    // assertion: the evidence is NOT the "cannot grade without leg data" reason.
    const completeId = 'test_oneleg_complete';
    insertLeg.run(`${completeId}-l1`, completeId, 'Marlins ML +130', 130);
    const completeBet = {
      id: completeId,
      bet_type: 'parlay',
      sport: 'MLB',
      description: '• Marlins ML +130',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    let completeEvidence = '';
    let bypassed = false;
    try {
      const r = await grading.gradePropWithAI(completeBet);
      completeEvidence = (r && r.evidence) || '';
      bypassed = !GUARD_RE.test(completeEvidence);
    } catch (e) {
      // A throw means we got past the guard into live grading (the guard returns).
      bypassed = true;
      completeEvidence = `threw: ${e.message}`;
    }
    check('complete 1-leg parlay is NOT rejected by the leg-data guard (dispatched to gradeParlay)',
      bypassed, true);
    if (!bypassed) console.log(`    complete-path evidence: ${completeEvidence}`);

    console.log(`\n${pass} passed / ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('1-leg parlay completeness validation passed.');
  } finally {
    try { database.db.close(); } catch (_) {}
    try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  }
})();
