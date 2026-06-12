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
//
// Repro 3: 2026-06-12 14:06 UTC · ingest disc_1514481735335805030 ·
// held IgDave KBO slip re-dropped VALIDATOR_SPORT_MISMATCH on every
// hold-recovery retry: 'Leg references team(s) "eagles" which exist in
// NFL but not in declared parlay sport KBO'. The leg-team matcher only
// knows teams.json's leagues, so ANY unmodeled-league slip with a
// colliding nickname failed forever. Fix: when the declared set contains
// NO modeled league (declaresOnlyUnmodeledLeagues, mirroring #85's
// derivation), leg-team matching is skipped — war-room review is the gate.
//
// Repro 4: 2026-06-12 · pipeline_events 71398 · GNP "USA / Paraguay both
// teams to score NO 5u" (declared sport "Unknown") was DROPPED VALIDATOR_
// SPORT_MISMATCH: 'Leg references team(s) "both teams to score" which exist
// in SOCCER but not in declared parlay sport Unknown'. The market phrase
// "both teams to score" lives in SPORT_TEAM_MAP's SOCCER list (a sport
// signal) and was wrongly treated as a soccer TEAM. Fired 5× on 06-12, 1×
// on 06-11. Two fixes: (1) market/wager phrases are never treated as teams
// for the contradiction check (MARKET_PHRASE_EXCLUSIONS); (2) an Unknown/
// placeholder declaration ADOPTS a single-sport signal (isSportPlaceholder)
// instead of dropping — there is no declared sport for a leg to contradict.
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
// Eagles". The escape is KBO-gated, so non-KBO parlays are unchanged.
// Incident: 2026-06-11, ingest disc_1514481735335805030 (3-leg KBO parlay
// dropped as 'eagles exist in NFL but not declared sport KBO').
// NOTE: pure-KBO declarations now pass earlier via the unmodeled-
// declaration skip (Repro 3); the sponsor-table carve-out remains load-
// bearing for COMPOUND declarations like "MLB/KBO".
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

// ── SUPERSEDED (was #86: "KBO ≠ blanket pass" — Lakers + KBO fired) ──
// The unmodeled-declaration skip supersedes that: declared "KBO" contains no
// modeled league, so leg-team matching is skipped entirely. We carry no team
// data that could distinguish a genuine Lakers leg from a foreign club under
// an unmodeled declaration — war-room review is the gate for those slips.
// Compound declarations that mix in a modeled league still validate fully
// (see "MLB/KBO + Lakers → FIRE" below).
run('"Los Angeles Lakers ML" + KBO → pass (unmodeled declaration skips leg-team matching; supersedes the #86 fire)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'KBO');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Compound declaration "MLB/KBO" admits a KBO leg too ──
run('compound "MLB/KBO" + Hanwha Eagles → pass (KBO ∈ declared set)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Eagles +1.5' }, 'MLB/KBO');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ═══════════════════════════════════════════════════════════
// Unmodeled-league declarations — when EVERY declared element names a
// league we don't model (no element maps to a teams.json league under
// #85's canonicalization — declaresOnlyUnmodeledLeagues), leg-team
// matching is SKIPPED: SPORT_TEAM_MAP knows only the modeled US leagues,
// so a nickname hit under such a declaration can only be a same-nickname
// foreign club — a structural false positive. War-room review is the
// gate for these slips.
// Live repro: 2026-06-12 14:06 UTC, ingest disc_1514481735335805030
// (declared "KBO") re-dropped on every hold-recovery retry, ~12 cycles.
// ═══════════════════════════════════════════════════════════
console.log('\nUnmodeled-league declarations (leg-team matching skipped):');

// ── The live repro — exact leg strings from the Jun 12 14:06 drop payload ──
const LIVE_KBO_LEGS = ['Hanwha Eagles +1.5', 'SSG Landers +1.5', 'Samsung Lions ML'];
for (const desc of LIVE_KBO_LEGS) {
  run(`LIVE: "${desc}" + KBO → pass (no modeled league declared)`, () => {
    const r = validateLegSportConsistency({ description: desc }, 'KBO');
    assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  });
}

// ── Generalizes beyond KBO: no sponsor table needed for other leagues ──
run('"KHL" + bare colliding nickname "Eagles ML" → pass (unmodeled league)', () => {
  const r = validateLegSportConsistency({ description: 'Eagles ML' }, 'KHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"NPB" + "Yomiuri Giants ML" → pass (giants collides with MLB/NFL; NPB unmodeled)', () => {
  const r = validateLegSportConsistency({ description: 'Yomiuri Giants ML' }, 'NPB');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('"Korean Baseball" + Hanwha Eagles → pass (foreign-qualified name is NOT generic "Baseball" — #85-consistent)', () => {
  const r = validateLegSportConsistency({ description: 'Hanwha Eagles +1.5' }, 'Korean Baseball');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

run('all-unmodeled compound "KBO/KHL" + Eagles ML → pass (no modeled element)', () => {
  const r = validateLegSportConsistency({ description: 'Eagles ML' }, 'KBO/KHL');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
});

// ── Boundaries: the skip engages ONLY for confidently-unmodeled sets ──
run('"NBA" + marlins → still FIRES (modeled declaration, unchanged)', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'NBA');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /marlins/i);
  assert.match(r.reason, /MLB/);
  assert.match(r.reason, /NBA/);
});

run('mixed compound "MLB/KBO" + Lakers → still FIRES (a modeled element keeps full validation)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'MLB/KBO');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /lakers/i);
  assert.match(r.reason, /NBA/);
});

// Generic "Baseball" is a MODELED-league signal per #85 (LEAGUE_NAME_ALIASES →
// MLB), so the unmodeled skip does NOT engage and the pre-existing exact-key
// set matching is unchanged: "BASEBALL" ∉ matched {MLB} → fire, same as before
// this fix. (Not loosened here on purpose — see PR notes.)
run('"Baseball" + marlins → still FIRES (modeled-generic name, #85-consistent; behavior unchanged)', () => {
  const r = validateLegSportConsistency({ description: 'Miami Marlins ML' }, 'Baseball');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /marlins/i);
});

// Placeholder declarations ("Unknown", "N/A", null, empty) carry NO declared
// sport, so there is nothing for a leg's team to CONTRADICT — the wrong-sport
// DROP path is structurally inapplicable. When the leg's signal resolves to
// exactly one sport, that sport is ADOPTED (returned as adoptedSport) and the
// leg passes. SUPERSEDES the prior "placeholders still FIRE" assertions: those
// predated the Unknown→adopt fix (Repro 4). A genuine cross-sport contradiction
// still requires a REAL declared sport — see lakers+MLB / rangers+NBA /
// marlins+NBA fires above, all unchanged.
run('placeholder "Unknown" + lakers → PASS + adopt NBA (was: FIRES; superseded by Unknown→adopt)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'Unknown');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  assert.strictEqual(r.adoptedSport, 'NBA');
});

run('placeholder "N/A" + lakers → PASS + adopt NBA (whole-label placeholder, not the "/" split)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, 'N/A');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  assert.strictEqual(r.adoptedSport, 'NBA');
});

run('empty declared sport + lakers → PASS + adopt NBA (no declared sport to contradict)', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers ML' }, '');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  assert.strictEqual(r.adoptedSport, 'NBA');
});

// ═══════════════════════════════════════════════════════════
// Market-phrase exclusion + Unknown-sport adoption (Repro 4, GNP).
// (1) A market/wager phrase ("both teams to score", "btts", "corners", …) is
//     never treated as a TEAM for the cross-sport contradiction check.
// (2) An Unknown/placeholder declaration ADOPTS a single-sport signal instead
//     of dropping it. Behavior-change tests below FAIL on the pre-fix code at
//     the marked assertion; the no-weakening guard is unchanged by design.
// ═══════════════════════════════════════════════════════════
console.log('\nMarket-phrase exclusion + Unknown-sport adoption (Repro 4):');

// ── (1) The exact dropped GNP leg, direct — adopt Soccer, retain the leg.
//        Pre-fix: DROPS ('both teams to score' → SOCCER ∉ {Unknown}). ──
run('GNP regression: "USA / Paraguay both teams to score NO" + Unknown → PASS + adopt Soccer', () => {
  const r = validateLegSportConsistency({ description: 'USA / Paraguay both teams to score NO' }, 'Unknown');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`); // FAILS pre-fix
  assert.strictEqual(r.adoptedSport, 'Soccer', 'soccer market phrase adopts Soccer under Unknown');
});

// ── End-to-end through validateParsedBet: pick.sport is rewritten to Soccer. ──
run('GNP regression (end-to-end): Unknown parlay with a BTTS leg → valid + pick.sport adopted Soccer', () => {
  const pick = {
    sport: 'Unknown',
    bet_type: 'parlay',
    description: 'USA / Paraguay both teams to score NO 5u',
    legs: [{ description: 'USA / Paraguay both teams to score NO' }],
  };
  const r = validateParsedBet(pick, '', { hasMedia: false });
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason} | ${JSON.stringify(r.issues)}`); // FAILS pre-fix
  assert.strictEqual(pick.sport, 'Soccer', 'parlay sport adopted from the soccer market phrase');
});

// ── (2) A bare market phrase is NEVER a team — even under a mismatching declared
//        sport. Both phrases live in SPORT_TEAM_MAP, so pre-fix DROPS them. ──
run('bare market phrase "both teams to score" + NBA → PASS (market phrase ≠ soccer team)', () => {
  const r = validateLegSportConsistency({ description: 'both teams to score' }, 'NBA');
  assert.strictEqual(r.valid, true, `market phrase must not be treated as a team, got: ${r.reason}`); // FAILS pre-fix
});

run('bare market phrase "corners over 9.5" + NBA → PASS (no team match)', () => {
  const r = validateLegSportConsistency({ description: 'corners over 9.5' }, 'NBA');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`); // FAILS pre-fix
});

// ── (3) No weakening. The simple real-team contradiction guard already exists
//        above ("lakers + MLB → fire"); here we prove the reject still fires
//        AND that the reason names only the REAL team's sport, never a
//        co-occurring market phrase. Pre-fix names {NBA,SOCCER} → fails the
//        doesNotMatch assertion. ──
run('contradiction excludes market phrases: "Lakers both teams to score" + MLB → DROPS naming NBA, not SOCCER', () => {
  const r = validateLegSportConsistency({ description: 'Los Angeles Lakers both teams to score' }, 'MLB');
  assert.strictEqual(r.valid, false);
  assert.match(r.reason, /lakers/i);
  assert.match(r.reason, /NBA/);
  assert.doesNotMatch(r.reason, /SOCCER|both teams to score/i, 'market phrase must not appear as a contradicting team'); // FAILS pre-fix
});

// ── (4) Adoption is sport-agnostic — a non-soccer single signal adopts too.
//        Pre-fix: DROPS ('yankees' → MLB ∉ {Unknown}). ──
run('non-soccer adoption: "New York Yankees -1.5" + Unknown → PASS + adopt MLB', () => {
  const r = validateLegSportConsistency({ description: 'New York Yankees -1.5' }, 'Unknown');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`); // FAILS pre-fix
  assert.strictEqual(r.adoptedSport, 'MLB');
});

// ── Ambiguity guard — a shared nickname spanning 2 sports under Unknown does
//    NOT adopt (and still does not drop). Pre-fix DROPS it. ──
run('ambiguous "Rangers ML" + Unknown → PASS, no adoption (MLB+NHL — not exactly one sport)', () => {
  const r = validateLegSportConsistency({ description: 'Rangers ML' }, 'Unknown');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`); // FAILS pre-fix
  assert.strictEqual(r.adoptedSport, undefined, 'ambiguous signal must not adopt a sport');
});

// ── Conservative gate — a leg with NO team/market signal under Unknown passes
//    untouched (no sport stamped). Already passed pre-fix; guards the gate. ──
run('signal-less player prop "Mookie Betts over 1.5 hits" + Unknown → PASS, no adoption', () => {
  const r = validateLegSportConsistency({ description: 'Mookie Betts over 1.5 hits' }, 'Unknown');
  assert.strictEqual(r.valid, true, `expected pass, got: ${r.reason}`);
  assert.strictEqual(r.adoptedSport, undefined, 'no signal must not adopt a sport');
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
