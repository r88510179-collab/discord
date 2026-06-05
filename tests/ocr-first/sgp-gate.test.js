// ═══════════════════════════════════════════════════════════
// SGP deterministic gate unit tests — services/sgpGate.js evaluateSgpGate.
//
// Pure function: no network, no DB, no env. Fixtures are derived from real
// captured HRB SGP parses (reports/sgp-content-spotcheck.json — 16 slips / 98
// legs); the OCR text snippets are verbatim from that report so the
// entity-in-OCR confidence check is exercised against genuine space-dropping OCR.
//
// Covers the build-prompt matrix:
//   • exact count match PASS
//   • count mismatch FAIL — the spot-check phantom-leg case (slip 12)
//   • missing entity / market / line FAIL
//   • market-in-selection normalized → PASS (spot-check slip 10)
//   • Over+Under contradiction FAIL
//   • boost/total-odds "leg" excluded, count still matches → PASS
//   • entity not in OCR text → FAIL
// plus the guard reasons (OCR empty, no declared count, no legs) and the
// normalizedBet shape.
//
// Run:  node tests/ocr-first/sgp-gate.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const { evaluateSgpGate, SgpGateReason } = require('../../services/sgpGate');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

// A real leg shape (raw Groq OCR parse): { matchup, player, market, selection, odds }.
const leg = (player, market, selection, odds) => ({
  matchup: 'Angels vs Rockies', player, market, selection, odds: odds || null, start_time: null,
});

// Real OCR text — spot-check slip 16 (SGPMAX 5-Bet, msg 1510948471442772120),
// verbatim incl. the OCR's dropped/extra spaces ("Diamondbacks vsDodgers").
const SLIP16_OCR = `Hard Rock
BET
5-Bet Parlay
+340
SGPMAX
Wager
Payout
$10
$43.96
-129
SGP
Angels vs Rockies
Today,9:38pmEDT
Over 0.5
NICK MADRIGAL-HITS
Over 0.5
MIKE TROUT-TO RECORD 1+ HITS
-153
SGP
Diamondbacks vsDodgers
Today,9:40pmEDT
Over 0.5
SHOHEI OHTANI -TO RECORD 1+ HITS
Over 0.5
FREDDIE FREEMAN -TO RECORD 1+ HITS
Over 0.5
-200
WILLIAM CONTRERAS -HITS
Brewers vs Giants
Today,7:40pmEDT`;

// Slip 16's five legs as Groq actually returned them (normal market+selection split).
const slip16Legs = () => [
  leg('Nick Madrigal', 'HITS', 'Over 0.5', '-129'),
  leg('Mike Trout', 'TO RECORD 1+ HITS', 'Over 0.5', null),
  leg('Shohei Ohtani', 'TO RECORD 1+ HITS', 'Over 0.5', null),
  leg('Freddie Freeman', 'TO RECORD 1+ HITS', 'Over 0.5', null),
  leg('William Contreras', 'HITS', 'Over 0.5', '-200'),
];

// ── exact count match → PASS ──────────────────────────────────────────────────
run('exact count match (5 real legs vs declared 5) → PASS', () => {
  const r = evaluateSgpGate({ declaredLegCount: 5, parsedBet: { bet_type: 'sgpmax', total_odds: '+340', legs: slip16Legs() }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, true, `expected PASS, got ${r.reason}`);
  assert.strictEqual(r.reason, SgpGateReason.PASS);
});

run('PASS normalizedBet carries cleaned legs + ticket metadata', () => {
  const r = evaluateSgpGate({ declaredLegCount: 5, parsedBet: { bet_type: 'sgpmax', total_odds: '+340', stake: '$10', payout: '$43.96', legs: slip16Legs() }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, true);
  assert.ok(r.normalizedBet, 'normalizedBet present on PASS');
  assert.strictEqual(r.normalizedBet.legs.length, 5);
  assert.strictEqual(r.normalizedBet.declaredLegCount, 5);
  assert.strictEqual(r.normalizedBet.total_odds, '+340');
  const first = r.normalizedBet.legs[0];
  assert.deepStrictEqual(
    { entity: first.entity, market: first.market, line: first.line },
    { entity: 'Nick Madrigal', market: 'HITS', line: 'Over 0.5' },
  );
});

// ── count mismatch → FAIL (the spot-check phantom-leg case, slip 12) ──────────
run('phantom game-odds leg inflates count (4 vs declared 3) → SGP_COUNT_MISMATCH', () => {
  // Slip 12: three real player legs + a 4th "leg" that is really the game SGP
  // odds line "-118 / Orioles vs Blue Jays" (matchup entity, no market/selection).
  const legs = [
    leg('Bryan Reynolds', 'HITS', 'Over 0.5', null),
    leg('Nick Gonzales', 'HITS', 'Over 0.5', null),
    leg('Taylor Ward', 'HITS', 'Over 0.5', '-240'),
    { matchup: 'Orioles vs Blue Jays', player: null, market: '', selection: '', odds: '-118' },
  ];
  const ocr = `Hard Rock\nBET\nSGPMAX\n3-Bet Parlay\n+162\n-118\nSGP\nPirates vs Cubs\nOver 0.5\nBRYAN REYNOLDS - HITS\nOver 0.5\nNICK GONZALES - HITS\nOver 0.5\n-240\nTAYLOR WARD -HITS\nOrioles vs Blue Jays`;
  const r = evaluateSgpGate({ declaredLegCount: 3, parsedBet: { bet_type: 'sgpmax', legs }, ocrText: ocr });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.COUNT_MISMATCH);
  assert.strictEqual(r.detail.parsed, 4, 'phantom matchup leg is counted, not excluded');
});

run('parsed fewer legs than declared → SGP_COUNT_MISMATCH', () => {
  const r = evaluateSgpGate({ declaredLegCount: 5, parsedBet: { legs: slip16Legs().slice(0, 4) }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.COUNT_MISMATCH);
});

// ── missing entity / market / line → FAIL ────────────────────────────────────
run('leg missing entity (no player + no matchup) → SGP_LEG_MISSING_FIELD', () => {
  const legs = [{ matchup: '', player: '', market: 'HITS', selection: 'Over 0.5', odds: null }];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Hard Rock 1-Bet Over 0.5 HITS' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.LEG_MISSING_FIELD);
  assert.strictEqual(r.detail.hasMarket, true);
});

run('leg missing market AND line (both empty, nothing to promote) → SGP_LEG_MISSING_FIELD', () => {
  const legs = [{ matchup: 'Angels vs Rockies', player: 'Mike Trout', market: '', selection: '', odds: null }];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Mike Trout 1-Bet Parlay' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.LEG_MISSING_FIELD);
  assert.strictEqual(r.detail.hasMarket, false);
  assert.strictEqual(r.detail.hasLine, false);
});

run('leg with market but missing line (empty selection) → SGP_LEG_MISSING_FIELD', () => {
  const legs = [{ matchup: 'Angels vs Rockies', player: 'Mike Trout', market: 'HITS', selection: '', odds: null }];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Mike Trout HITS 1-Bet Parlay' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.LEG_MISSING_FIELD);
  assert.strictEqual(r.detail.hasMarket, true);
  assert.strictEqual(r.detail.hasLine, false);
});

// ── market-in-selection normalized → PASS (spot-check slip 10) ────────────────
run('market empty + prop type in selection (slip-10 split) → normalized PASS', () => {
  // Real slip 10: every leg market:"" with the prop type living in `selection`.
  const legs = [
    { matchup: 'Angels vs Athletics', player: 'Lawrence Butler', market: '', selection: 'TO RECORD 1+ HITS', odds: '+110' },
    { matchup: 'Angels vs Athletics', player: 'Zach Neto', market: '', selection: 'HITS', odds: null },
  ];
  const ocr = `Hard Rock\nBET\nSGPMAX\n2-Bet Parlay\n+1435\nSGP\nAngels vs Athletics\nO0ver0.5\nLAWRENCE BUTLER -TO RECORD 1+HITS\nO0ver0.5\nZACH NETO -HITS`;
  const r = evaluateSgpGate({ declaredLegCount: 2, parsedBet: { bet_type: 'sgpmax', legs }, ocrText: ocr });
  assert.strictEqual(r.pass, true, `expected PASS, got ${r.reason}`);
  // The promoted market is the prop type pulled out of selection.
  assert.strictEqual(r.normalizedBet.legs[0].market, 'TO RECORD 1+ HITS');
  assert.strictEqual(r.normalizedBet.legs[0].line, 'TO RECORD 1+ HITS');
});

// ── Over+Under contradiction → FAIL ──────────────────────────────────────────
run('leg carrying both Over and Under → SGP_CONTRADICTION', () => {
  const legs = [{ matchup: 'Angels vs Rockies', player: 'Mike Trout', market: 'Total Bases', selection: 'Over 1.5 Under 1.5', odds: null }];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Mike Trout Total Bases Over Under 1.5 1-Bet' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.CONTRADICTION);
});

// ── boost/total-odds "leg" excluded, count still matches → PASS ───────────────
run('stray boost/total-odds "leg" excluded → count matches → PASS', () => {
  // Groq occasionally emits the boosted total ("+3305") as a contentless odds-only
  // leg; it must be dropped (not counted) so a clean 5-leg slip still passes.
  const legs = [
    ...slip16Legs(),
    { matchup: '', player: '', market: '', selection: '+3305', odds: '+3305' },
  ];
  const r = evaluateSgpGate({ declaredLegCount: 5, parsedBet: { bet_type: 'sgpmax', total_odds: '+3305', legs }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, true, `expected PASS, got ${r.reason}`);
  assert.strictEqual(r.detail.excluded, 1, 'the odds-only leg was excluded');
  assert.strictEqual(r.normalizedBet.legs.length, 5);
});

// ── entity not in OCR text → FAIL ────────────────────────────────────────────
run('hallucinated entity absent from OCR → SGP_ENTITY_NOT_IN_OCR', () => {
  const legs = [leg('Imaginary Person', 'HITS', 'Over 0.5', '-110')];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Hard Rock 1-Bet Parlay Over 0.5 HITS Nick Madrigal' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.ENTITY_NOT_IN_OCR);
  assert.strictEqual(r.detail.entity, 'Imaginary Person');
});

run('entity present but with OCR-dropped spaces still matches (whitespace-insensitive)', () => {
  // OCR rendered the name with no internal space ("WILLYADAMES"); the verbatim
  // check folds whitespace on both sides so the leg is NOT flagged hallucinated.
  const legs = [leg('Willy Adames', 'TO RECORD 1+ HITS', 'Over 0.5', '-250')];
  const r = evaluateSgpGate({ declaredLegCount: 1, parsedBet: { legs }, ocrText: 'Hard Rock 1-Bet Over 0.5\nWILLYADAMES-TO RECORD 1+HITS' });
  assert.strictEqual(r.pass, true, `expected PASS, got ${r.reason}`);
});

// ── guard reasons ────────────────────────────────────────────────────────────
run('empty OCR text → SGP_OCR_EMPTY', () => {
  const r = evaluateSgpGate({ declaredLegCount: 5, parsedBet: { legs: slip16Legs() }, ocrText: '   ' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.OCR_EMPTY);
});

run('missing declared leg count (no slip header) → SGP_NO_DECLARED_COUNT', () => {
  const r = evaluateSgpGate({ declaredLegCount: null, parsedBet: { legs: slip16Legs() }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.NO_DECLARED_COUNT);
});

run('non-integer declared leg count → SGP_NO_DECLARED_COUNT', () => {
  const r = evaluateSgpGate({ declaredLegCount: 0, parsedBet: { legs: slip16Legs() }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.NO_DECLARED_COUNT);
});

run('parsedBet with no legs → SGP_NO_LEGS', () => {
  const r = evaluateSgpGate({ declaredLegCount: 3, parsedBet: { legs: [] }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.NO_LEGS);
});

run('missing parsedBet entirely → SGP_NO_LEGS (never throws)', () => {
  const r = evaluateSgpGate({ declaredLegCount: 3, parsedBet: undefined, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.NO_LEGS);
});

run('called with no args → fails closed, does not throw', () => {
  const r = evaluateSgpGate();
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, SgpGateReason.OCR_EMPTY);
});

run('every FAIL returns normalizedBet:null (only PASS yields a bet)', () => {
  const r = evaluateSgpGate({ declaredLegCount: 9, parsedBet: { legs: slip16Legs() }, ocrText: SLIP16_OCR });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.normalizedBet, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
