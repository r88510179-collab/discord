// ═══════════════════════════════════════════════════════════
// Leg-sport validator — team-name SUBSTRING false positive
//
// Repro: 2026-06-15 · ingest disc_1510607698473914429 · a real 4-leg MLB
// "Over 0.5 Hits" parlay (Fernando Tatis Jr. / CJ Abrams / James Wood / Ramon
// Laureano, source vision_slip) was dropped VALIDATOR_SPORT_MISMATCH:
//   'Leg references team(s) "rams" which exist in NFL but not in declared
//    parlay sport MLB'
// There is NO Rams leg. The team-name lookup matched the NFL nickname "rams" as
// a SUBSTRING of the player surname "CJ Ab*rams*" because the scan used a bare
// `desc.includes(keyword)`. Any leg whose text contains a team nickname inside a
// longer token false-positived (Abrams→Rams, Wheaton→Heat, …), mis-dropping
// clean slips across all cappers.
//
// Fix: the SPORT_TEAM_MAP scan in validateLegSportConsistency now matches a
// nickname/team only as a WHOLE WORD or whole multi-word phrase (`\b`-anchored,
// regex-escaped, case-insensitive). "\brams\b" matches "Rams -3.5" / a bare
// "rams" token but never "abrams". The genuine cross-sport contradiction path
// and the #98 market-phrase / Unknown-adoption logic are unchanged.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { validateLegSportConsistency, validateParsedBet } = require('../services/ai');

// validateParsedBet's offseason check runs before the leg-sport check; pin the
// season evaluation to a date with MLB in season so the end-to-end cases below
// don't flip to reason 'offseason' when the wall clock leaves the MLB window.
const TEST_NOW = new Date(2026, 4, 7); // 2026-05-07, local time

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

console.log('Leg-sport validator — substring (word-boundary) matching:');

// The verbatim live-drop parlay: all four legs are MLB "Over 0.5 Hits" props.
const ABRAMS_LEGS = [
  { description: 'Fernando Tatis Jr. - Over 0.5 Hits' },
  { description: 'CJ Abrams - Over 0.5 Hits' },
  { description: 'James Wood - Over 0.5 Hits' },
  { description: 'Ramon Laureano - Over 0.5 Hits' },
];

// ── 1. Regression fixed: the live-drop 4-leg parlay no longer mis-fires ──
run('4-leg MLB hits parlay (incl. "CJ Abrams") → NOT leg_sport_mismatch (validateParsedBet, ingest disc_1510607698473914429)', () => {
  const bet = { sport: 'MLB', description: 'MLB 4-leg hits parlay', legs: ABRAMS_LEGS.map(l => ({ ...l })) };
  const r = validateParsedBet(bet, '', { now: TEST_NOW });
  assert.notStrictEqual(r.reason, 'leg_sport_mismatch', `parlay wrongly dropped: ${r.reason} — ${r.issues && r.issues.join('; ')}`);
  assert.strictEqual(r.valid, true, `parlay should pass clean: ${JSON.stringify(r)}`);
});

run('"CJ Abrams - Over 0.5 Hits" + MLB → valid (the substring "rams" no longer matches)', () => {
  const r = validateLegSportConsistency({ description: 'CJ Abrams - Over 0.5 Hits' }, 'MLB');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

// A second real substring collision in the same class: "Wheaton" ⊃ "heat" (NBA).
run('"Tyler Wheaton Over 1.5 TB" + MLB → valid ("heat" inside "Wheaton" no longer matches)', () => {
  const r = validateLegSportConsistency({ description: 'Tyler Wheaton Over 1.5 TB' }, 'MLB');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

// ── 2. Real cross-sport detection preserved: "Rams" as a WHOLE WORD still drops ──
run('"Rams -3.5" + MLB → leg_sport_mismatch (genuine NFL leg, whole word)', () => {
  const r = validateLegSportConsistency({ description: 'Rams -3.5' }, 'MLB');
  assert.strictEqual(r.valid, false, JSON.stringify(r));
  assert.ok(/"rams"/.test(r.reason) && /NFL/.test(r.reason), r.reason);
});

run('"rams ML" + MLB → leg_sport_mismatch (bare lowercase nickname, whole word)', () => {
  const r = validateLegSportConsistency({ description: 'rams ML' }, 'MLB');
  assert.strictEqual(r.valid, false, JSON.stringify(r));
});

run('parlay declared MLB with a real "Rams -3.5" leg → dropped leg_sport_mismatch (validateParsedBet)', () => {
  const bet = { sport: 'MLB', description: 'MLB parlay with a stray NFL leg', legs: [
    { description: 'Fernando Tatis Jr. - Over 0.5 Hits' },
    { description: 'Rams -3.5' },
  ] };
  const r = validateParsedBet(bet, '', { now: TEST_NOW });
  assert.strictEqual(r.reason, 'leg_sport_mismatch', JSON.stringify(r));
});

run('"Rams -3.5" + NFL → valid (real Rams leg in its own sport)', () => {
  const r = validateLegSportConsistency({ description: 'Rams -3.5' }, 'NFL');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

// ── 3. No collateral: whole player names produce no team-sport mismatch ──
run('"James Wood - Over 0.5 Hits" + MLB → valid', () => {
  const r = validateLegSportConsistency({ description: 'James Wood - Over 0.5 Hits' }, 'MLB');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

run('"Ramon Laureano - Over 0.5 Hits" + MLB → valid', () => {
  const r = validateLegSportConsistency({ description: 'Ramon Laureano - Over 0.5 Hits' }, 'MLB');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

run('"Fernando Tatis Jr. - Over 0.5 Hits" + MLB → valid', () => {
  const r = validateLegSportConsistency({ description: 'Fernando Tatis Jr. - Over 0.5 Hits' }, 'MLB');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

// ── Word-boundary semantics preserved for legitimate matches ──
run('multi-word phrase still matches: "Boston Red Sox -1.5" + NHL → leg_sport_mismatch (MLB ∉ {NHL})', () => {
  const r = validateLegSportConsistency({ description: 'Boston Red Sox -1.5' }, 'NHL');
  assert.strictEqual(r.valid, false, JSON.stringify(r));
  assert.ok(/red sox/.test(r.reason) && /MLB/.test(r.reason), r.reason);
});

run('digit-leading nickname still matches: "San Francisco 49ers ML" + NFL → valid', () => {
  const r = validateLegSportConsistency({ description: 'San Francisco 49ers ML' }, 'NFL');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
});

// ── #98 logic untouched: Unknown-declaration market-phrase adoption still works ──
run('"USA / Paraguay both teams to score NO" + Unknown → valid, adopts Soccer (PR #98 preserved)', () => {
  const r = validateLegSportConsistency({ description: 'USA / Paraguay both teams to score NO' }, 'Unknown');
  assert.strictEqual(r.valid, true, JSON.stringify(r));
  assert.strictEqual(r.adoptedSport, 'Soccer', JSON.stringify(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
