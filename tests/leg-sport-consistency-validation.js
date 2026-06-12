// ═══════════════════════════════════════════════════════════
// Leg-sport-consistency validator tests
// Repro: 2026-04-30 msg=1499418573469388810 — "Giants ML" + MLB
// parlay was wrongly dropped because 'giants' lived only in NFL.
// Fix: 'giants'/'cardinals'/'jets' added to MLB/NFL/NHL respectively,
// and the validator now passes when the declared sport is among the
// sports whose keyword list matched the leg.
//
// Repro 2: 2026-06-10 21:44 UTC · ingest twit_2064504565593219458 ·
// @lockedin — a real 7-leg parlay declared sport "MLB/NHL" was dropped
// with leg_sport_mismatch: 'Leg references team(s) "marlins" which exist
// in MLB but not in declared parlay sport MLB/NHL' — self-contradictory.
// Fix: the declared sport is parsed as a SET (split on / & ,) so a
// compound declaration admits a leg from ANY of its sports; single-sport
// declarations are a one-element set and behave exactly as before.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { validateLegSportConsistency, reclassifySport, matchesKboTeam, normalizeKboLeg, validateParsedBet } = require('../services/ai');

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

console.log('Leg sport consistency validator:');

// ── Multi-sport teams in their declared sport → pass ──
run('Giants ML + MLB → pass (live repro msg=1499418573469388810)', () => {
  const r = validateLegSportConsistency({ description: 'Giants ML' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Cardinals -1.5 + NFL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Cardinals -1.5 -110' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Jets +1.5 + NHL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Jets +1.5 puck line' }, 'NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Rangers ML + NHL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Rangers ML -120' }, 'NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Panthers -3 + NFL → pass', () => {
  const r = validateLegSportConsistency({ description: 'Panthers -3 -105' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Kings ML + NBA → pass', () => {
  const r = validateLegSportConsistency({ description: 'Kings ML +110' }, 'NBA');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Multi-sport team in a non-matching declared sport → fire ──
run('Rangers ML + NBA → fire (rangers is MLB/NHL, neither is NBA)', () => {
  const r = validateLegSportConsistency({ description: 'Rangers ML' }, 'NBA');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /Rangers|rangers/i);
  assert.match(r.reason, /NBA/);
});

// ── Clean single-sport pass ──
run('Cubs -1.5 + MLB → pass', () => {
  const r = validateLegSportConsistency({ description: 'Cubs -1.5 -110' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Clean single-sport fire (existing correct catch) ──
run('Browns -3 + MLB → fire', () => {
  const r = validateLegSportConsistency({ description: 'Browns -3' }, 'MLB');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /browns/i);
  assert.match(r.reason, /NFL/);
  assert.match(r.reason, /MLB/);
});

// ── No team keyword at all → pass (out of this validator's scope) ──
run('Pure player prop "Mookie Betts hit" + MLB → pass', () => {
  const r = validateLegSportConsistency({ description: 'Mookie Betts hit -110' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('Pure player prop "Mookie Betts hit" + NFL → pass (out of scope)', () => {
  const r = validateLegSportConsistency({ description: 'Mookie Betts hit' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Empty / null safety ──
run('Empty description → pass', () => {
  const r = validateLegSportConsistency({ description: '' }, 'MLB');
  assert.strictEqual(r.valid, true);
});

run('Missing description → pass', () => {
  const r = validateLegSportConsistency({}, 'MLB');
  assert.strictEqual(r.valid, true);
});

// ── Cleveland Browns in MLB-only matched set → fire (single-sport mismatch) ──
run('"Cleveland Browns -3" + MLB → fire (single-sport mismatch)', () => {
  const r = validateLegSportConsistency({ description: 'Cleveland Browns -3' }, 'MLB');
  assert.strictEqual(r.valid, false);
});

// ═══════════════════════════════════════════════════════════
// Compound multi-sport declarations — declared sport is a SET.
// Live repro: ingest twit_2064504565593219458 (declared "MLB/NHL").
// A leg passes when its team's sport is ANY of the declared sports;
// it still fires when none of the declared sports matches.
// ═══════════════════════════════════════════════════════════
console.log('\nCompound multi-sport declarations:');

// ── The four prompt cases (marlins=MLB-only, bruins=NHL-only, lakers=NBA-only) ──
run('LIVE BUG: "marlins" + MLB/NHL → pass (MLB ∈ {MLB,NHL})', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'MLB/NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"bruins" + MLB/NHL → pass (NHL ∈ {MLB,NHL})', () => {
  const r = validateLegSportConsistency({ description: 'Boston Bruins ML' }, 'MLB/NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"lakers" + MLB/NHL → fire (NBA ∉ {MLB,NHL}) — no loosening', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'MLB/NHL');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /lakers/i);
  assert.match(r.reason, /NBA/);
  assert.match(r.reason, /MLB\/NHL/); // raw declared string preserved in message
});

run('"marlins" + MLB (single) → pass (behavior unchanged)', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"lakers" + MLB (single) → fire (behavior unchanged)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'MLB');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /lakers/i);
  assert.match(r.reason, /MLB/);
});

// ── Separator + normalization coverage ──
run('"&" separator + spaces: "marlins" + "MLB & NHL" → pass', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'MLB & NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"," separator + spaces: "bruins" + "MLB, NHL" → pass', () => {
  const r = validateLegSportConsistency({ description: 'Boston Bruins ML' }, 'MLB, NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('spaces around "/": "marlins" + "MLB / NHL" → pass', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'MLB / NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('lowercase compound: "marlins" + "mlb/nhl" → pass', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'mlb/nhl');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('three-way compound: "lakers" + "NBA/MLB/NHL" → pass', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'NBA/MLB/NHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Shared-nickname behavior is identical inside a compound ──
run('"kings" (NBA+NHL) + NBA/MLB → pass (NBA ∈ matched)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Kings ML' }, 'NBA/MLB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"browns" (NFL-only) + MLB/NHL → fire (NFL ∉ {MLB,NHL})', () => {
  const r = validateLegSportConsistency({ description: 'Cleveland Browns -3' }, 'MLB/NHL');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /browns/i);
});

// ═══════════════════════════════════════════════════════════
// KBO awareness — KBO clubs aren't in SPORT_TEAM_MAP and six share a
// US nickname (Eagles/Tigers/Twins/Lions/Giants/Bears). A declared-KBO
// parlay leg naming a KBO club (sponsor prefix is decisive) must PASS,
// even against the city-injected Vision corruption "Hanwha Philadelphia
// Eagles". The escape is KBO-gated, so non-KBO parlays are unchanged and
// genuine cross-sport contamination still drops.
// Incident: 2026-06-11, ingest disc_1514481735335805030 (3-leg KBO parlay
// dropped as 'eagles exist in NFL but not declared sport KBO').
// ═══════════════════════════════════════════════════════════
console.log('\nKBO awareness (declared-KBO + shared-nickname clubs):');

// ── Clean KBO legs pass under declared KBO (all six shared-nickname clubs) ──
const KBO_CLEAN = [
  'Hanwha Eagles +1.5 (-170)',
  'Kia Tigers ML',
  'LG Twins -1.5',
  'Samsung Lions ML (-190)',
  'Lotte Giants +1.5',
  'Doosan Bears ML',
];
for (const desc of KBO_CLEAN) {
  run(`clean "${desc}" + KBO → pass`, () => {
    const r = validateLegSportConsistency({ description: desc }, 'KBO');
    assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  });
}

// ── KBO clubs with UNIQUE nicknames (no SPORT_TEAM_MAP collision) also pass ──
run('SSG Landers +1.5 + KBO → pass (unique nickname, out of US scope)', () => {
  const r = validateLegSportConsistency({ description: 'SSG Landers +1.5 (-170)' }, 'KBO');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── The exact corrupted leg from the incident: resolves to Hanwha Eagles ──
run('normalizeKboLeg strips the injected US city: "Hanwha Philadelphia Eagles +1.5" → "Hanwha Eagles +1.5"', () => {
  assert.strictEqual(normalizeKboLeg('Hanwha Philadelphia Eagles +1.5'), 'Hanwha Eagles +1.5');
  assert.strictEqual(normalizeKboLeg('Samsung Detroit Lions ML (-190)'), 'Samsung Lions ML (-190)');
});

run('corrupted "Hanwha Philadelphia Eagles +1.5" + KBO → pass (sponsor wins)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Philadelphia Eagles +1.5' }, 'KBO');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── End-to-end through validateParsedBet: the stored leg/desc are cleaned AND
//    the bet passes validation (the real incident's 3-leg KBO parlay). ──
run('validateParsedBet: corrupted 3-leg KBO parlay → valid + descriptions cleaned in place', () => {
  const pick = {
    sport: 'KBO',
    bet_type: 'parlay',
    description: 'Hanwha Philadelphia Eagles +1.5 / SSG Landers +1.5 / Samsung Detroit Lions ML',
    legs: [
      { description: 'Hanwha Philadelphia Eagles +1.5 (-170)' },
      { description: 'SSG Landers +1.5 (-170)' },
      { description: 'Samsung Detroit Lions ML (-190)' },
    ],
  };
  const r = validateParsedBet(pick, '', { hasMedia: true });
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason} | ${JSON.stringify(r.issues)}`);
  assert.strictEqual(pick.legs[0].description, 'Hanwha Eagles +1.5 (-170)', 'leg 1 city stripped');
  assert.strictEqual(pick.legs[2].description, 'Samsung Lions ML (-190)', 'leg 3 city stripped');
  assert.ok(!/Philadelphia|Detroit/.test(pick.description), 'top-level description has no injected US city');
});

// ── matchesKboTeam guards against false positives ──
run('matchesKboTeam: real NFL "Philadelphia Eagles" (no sponsor) is NOT a KBO match', () => {
  assert.strictEqual(matchesKboTeam('Philadelphia Eagles -3 -110'), false);
});
run('matchesKboTeam: "NC State Wolfpack" does not false-positive on the NC sponsor', () => {
  assert.strictEqual(matchesKboTeam('NC State Wolfpack -7'), false);
});

// ── The KBO escape is GATED on declared KBO — no behavior change elsewhere ──
run('corrupted leg + NFL → pass UNCHANGED (eagles ∈ NFL; KBO escape not engaged)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Philadelphia Eagles +1.5' }, 'NFL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});
run('corrupted leg + MLB → FIRE (KBO escape does not leak to non-KBO declared sports)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Philadelphia Eagles +1.5' }, 'MLB');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /eagles/i);
  assert.match(r.reason, /NFL/);
  assert.match(r.reason, /MLB/);
});

// ── A genuine US team in a declared-KBO parlay STILL drops (no blanket pass) ──
run('genuine cross-sport: "Los Angeles Lakers ML" + KBO → FIRE (KBO ≠ blanket pass)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'KBO');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /lakers/i);
  assert.match(r.reason, /NBA/);
});

// ── Compound declaration "MLB/KBO" admits a KBO leg too ──
run('compound "MLB/KBO" + Hanwha Eagles → pass (KBO ∈ declared set)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Eagles +1.5' }, 'MLB/KBO');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ═══════════════════════════════════════════════════════════
// reclassifySport regression — adding 'giants' to MLB must NOT
// cause an MLB Giants leg to get reclassified to NFL.
// ═══════════════════════════════════════════════════════════
console.log('\nreclassifySport regression (multi-sport keyword):');

run('reclassifySport("MLB", "Giants ML") → MLB (multi-sport keeps original)', () => {
  const out = reclassifySport('MLB', 'Giants ML');
  assert.strictEqual(out, 'MLB');
});

run('reclassifySport("NFL", "Giants -3") → NFL (multi-sport keeps original)', () => {
  const out = reclassifySport('NFL', 'Giants -3');
  assert.strictEqual(out, 'NFL');
});

run('reclassifySport("MLB", "Cardinals -1.5") → MLB', () => {
  const out = reclassifySport('MLB', 'Cardinals -1.5');
  assert.strictEqual(out, 'MLB');
});

run('reclassifySport("NHL", "Jets +1.5") → NHL', () => {
  const out = reclassifySport('NHL', 'Jets +1.5');
  assert.strictEqual(out, 'NHL');
});

// Single-sport reclassification still works (no regression)
run('reclassifySport("MLB", "Cowboys -3") → NFL (single-sport reclassify)', () => {
  const out = reclassifySport('MLB', 'Cowboys -3');
  assert.strictEqual(out, 'NFL');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
