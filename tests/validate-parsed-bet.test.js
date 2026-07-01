// ═══════════════════════════════════════════════════════════
// P1: validateParsedBet slip-share exemption.
//
// VALIDATOR_ENTITY_MISMATCH was the largest "missed slips" bucket
// (98 hits/7d) before this fix. Image-bearing posts (Hard Rock Bet
// shares, PrizePicks slips, twitter slip-share screenshots) carry
// the bet content in the image, not in the message text — so vision-
// extracted entities are absent from sourceText and the entity check
// false-positively rejected them. The brand check below already had
// a slip-share exemption; this test enforces that the entity check
// has the same exemption (slipExempt = slipShape || hasMedia), and
// that the exemption does NOT extend to checks that should still run
// (placeholder, offseason).
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { validateParsedBet } = require('../services/ai');

// Every season-state expectation in this suite is pinned to an explicit date
// (opts.now → isInSeason) so the suite is hermetic to the wall clock. May 7,
// 2026 — the date this suite was authored against — makes every scenario here
// true at once: MLB in season, NBA in season, NFL out of season.
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

console.log('validateParsedBet slip-share exemption:');

// Case 1: Image-only Hard Rock slip with caption — bet lives in image,
// caption only mentions "LOCK OF THE NIGHT". Without the exemption,
// entity_mismatch would reject because none of giants/dodgers appear in
// the caption. With hasMedia=true, slipExempt skips the check.
run('image-only Hard Rock slip with caption → pass (hasMedia exemption)', () => {
  const pick = {
    sport: 'MLB',
    type: 'parlay',
    description: '• Giants ML\n• Dodgers ML',
    odds: null,
    units: 1,
    legs: [
      { description: 'Giants ML', team: 'Giants' },
      { description: 'Dodgers ML', team: 'Dodgers' },
    ],
  };
  const r = validateParsedBet(pick, '🚨 LOCK OF THE NIGHT', { hasMedia: true, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// Case 2: Plain text post with matching entities — entity check runs and passes.
run('text post with matching entities → pass', () => {
  const pick = {
    sport: 'NBA',
    type: 'straight',
    description: 'Lakers ML',
    odds: -150,
    units: 1,
    legs: [{ description: 'Lakers ML', team: 'Lakers' }],
  };
  const r = validateParsedBet(pick, 'Lakers tonight ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// Case 3: Plain text post, NO matching entities, no media, no slip shape.
// Entity check correctly rejects — this is the path we did NOT want to break.
// Source must be >10 chars to trigger the check; "🚨 LOCK 🚨" (literal from
// the prompt sketch) is exactly 10 UTF-16 units and would skip — extended.
run('text post with no matching entities → reject (entity_mismatch)', () => {
  const pick = {
    sport: 'MLB',
    type: 'parlay',
    description: '• Giants ML\n• Dodgers ML',
    odds: null,
    units: 1,
    legs: [
      { description: 'Giants ML', team: 'Giants' },
      { description: 'Dodgers ML', team: 'Dodgers' },
    ],
  };
  const r = validateParsedBet(pick, '🚨 LOCK PICK 🚨', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'entity_mismatch', `expected entity_mismatch, got: ${r.reason}`);
});

// Case 4: PrizePicks slip-share, text-only — slipShape pattern matches
// "40x slip", so slipExempt is true even without media. The entity check
// would otherwise reject because "lebron" is not in source text.
run('text-only PrizePicks slip-share → pass (slipShape exemption)', () => {
  const pick = {
    sport: 'NBA',
    type: 'straight',
    description: 'Lebron over 25.5',
    odds: -110,
    units: 1,
    legs: [{ description: 'Lebron over 25.5', team: 'Lakers', player: 'Lebron James' }],
  };
  const r = validateParsedBet(pick, 'PrizePicks 40x slip 🔒', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// Case 5: Empty source text + image post — vision extracted everything from
// the image, source is blank. Without the exemption, the entity check would
// short-circuit on src.length<=10 anyway, but verify the path is healthy.
run('empty sourceText with hasMedia → pass', () => {
  const pick = {
    sport: 'MLB',
    type: 'parlay',
    description: '• Giants ML\n• Dodgers ML',
    odds: null,
    units: 1,
    legs: [
      { description: 'Giants ML', team: 'Giants' },
      { description: 'Dodgers ML', team: 'Dodgers' },
    ],
  };
  const r = validateParsedBet(pick, '', { hasMedia: true, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// Case 6: Placeholder description — exemption MUST NOT bypass the placeholder
// check. ("[bet description]" in the prompt is illustrative; FORBIDDEN_
// PLACEHOLDERS matches words like 'placeholder' or 'tbd', so we use one
// of those to actually trigger the check.)
run('placeholder description with hasMedia → reject (placeholder still runs)', () => {
  const pick = {
    sport: 'MLB',
    type: 'straight',
    description: 'placeholder bet',
    odds: null,
    units: 1,
    legs: [],
  };
  const r = validateParsedBet(pick, 'PrizePicks 40x slip', { hasMedia: true, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'placeholder', `expected placeholder, got: ${r.reason}`);
});

// Case 7: Out-of-season sport — exemption MUST NOT bypass the offseason check.
// NFL season runs Sep 1 → Feb 15; TEST_NOW (May 7) is outside that window, so
// the reject expectation holds on every run date.
run('NFL out-of-season with hasMedia → reject (offseason still runs)', () => {
  const pick = {
    sport: 'NFL',
    type: 'straight',
    description: 'Chiefs ML',
    odds: -150,
    units: 1,
    legs: [{ description: 'Chiefs ML', team: 'Chiefs' }],
  };
  const r = validateParsedBet(pick, 'PrizePicks 40x slip', { hasMedia: true, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// ── Live repro: the two datdude posts that motivated this fix ──
console.log('\nlive repro (2026-05-07 16:39-16:40 UTC):');

run('datdudestill #ig-dave-picks → pass with hasMedia', () => {
  const pick = {
    sport: 'MLB',
    type: 'parlay',
    description: '• Giants to win\n• Los Angeles Dodgers to win\n• Diamondbacks to win\n• Rockies to win',
    odds: null,
    units: 1,
    legs: [
      { description: 'Giants to win', team: 'Giants' },
      { description: 'Los Angeles Dodgers to win', team: 'Dodgers' },
      { description: 'Diamondbacks to win', team: 'Diamondbacks' },
      { description: 'Rockies to win', team: 'Rockies' },
    ],
  };
  // Hard Rock slip caption with no team names in text body.
  const r = validateParsedBet(pick, '🚨 LOCK OF THE NIGHT 🔒', { hasMedia: true, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
});

// ═══════════════════════════════════════════════════════════
// Offseason bouncer: ambiguous shared nicknames resolve to an
// in-season league before an offseason drop.
//
// Production evidence (pipeline_events 76871, recurring for weeks on
// GNP / LockedIn): "GNP\nSF Giants ML" was dropped at BOUNCER_REJECTED
//   {"validator":"offseason","issues":["NFL is out of season"], ... }
// The shared nickname "Giants" was resolved to the out-of-season NFL New
// York Giants, but the pick is the in-season MLB San Francisco Giants.
// Same drop on bare "Giants ML", "Cardinals", "Cubs … SF Giants U10.5".
//
// The bug window these cases need — MLB in season AND NFL out of season
// (≈ Mar 20 – Aug 31) — is guaranteed by pinning every call to TEST_NOW
// (May 7), so all cases run unconditionally on any wall-clock date.
// ═══════════════════════════════════════════════════════════
console.log('\noffseason ambiguous-team disambiguation:');

// Regression A — direct repro of pipeline_events 76871. Declared sport NFL
// (the mislabel: "NFL is out of season"), description the literal "SF Giants ML".
// Pre-fix: dropped as offseason. Post-fix: in-season-wins adopts MLB.
run('SF Giants ML (declared NFL) → not dropped, resolves MLB (76871)', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'SF Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'GNP\nSF Giants ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// Regression B — bare ambiguous nickname, no qualifier. In-season-wins rule:
// "Giants" maps to {MLB, NFL}; MLB is in season, so it must not drop.
run('Giants ML bare (declared NFL) → not dropped, in-season wins (MLB)', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Giants ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// Regression C — a different ambiguous team (Cardinals = MLB + NFL). MLB in
// season → must not drop, adopts MLB.
run('Cardinals ML (declared NFL) → not dropped, resolves MLB', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Cardinals ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Cardinals ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// No-weakening D — a real single-league out-of-season pick. "Chiefs" is NFL-only,
// so there is no in-season league to fall back to: it must still drop. (Identical
// behavior pre- and post-fix — this is the invariant guard, not a regression.)
run('Chiefs ML (declared NFL, single-league) → still drops (no weakening)', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Chiefs ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Chiefs ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// No-weakening E — a qualifier that pins the OUT-OF-SEASON franchise still drops.
// "New York Giants" disambiguates to the NFL Giants (full "<city> <nickname>"
// phrase); the fix must not blanket-rescue every ambiguous nickname. This is the
// genuine NFL-in-June case from the spec — it must still drop.
run('New York Giants ML (declared NFL, qualifier-pinned NFL) → still drops', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'New York Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'New York Giants ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// No-weakening E2 — multi-team genuine NFL pick whose nickname collides with an
// in-season league. "Patriots" is NFL-only and PINS the bet to NFL, so it must
// still drop in the NFL offseason even though "Jets" also names the in-season
// NHL Winnipeg Jets. (Without the unique-nickname pin this would be falsely rescued as NHL —
// this guards that pin.)
run('Patriots vs Jets (declared NFL, NFL-pinned vs NHL "Jets") → still drops', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Patriots vs Jets', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Patriots vs Jets', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// No-weakening E3 — a full-city IN-SEASON qualifier must NOT rescue a pick that
// also names an out-of-season, league-unique team. "San Francisco Giants" → MLB
// (in season) co-occurs with "Cowboys" (NFL-only, out of season): the definite
// out-of-season NFL team keeps the drop. (Guards against the qualifier check
// short-circuiting ahead of the unique-nickname pin — caught in adversarial
// review.)
run('Cowboys + San Francisco Giants (declared NFL) → still drops (definite NFL out)', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Cowboys -7, San Francisco Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Cowboys -7, San Francisco Giants ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// Resolution F — the full-city in-season qualifier is adopted outright (step 1),
// independent of the in-season-wins fallback: "San Francisco Giants" → MLB.
run('San Francisco Giants ML (declared NFL) → not dropped, resolves MLB', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'San Francisco Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'San Francisco Giants ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// Resolution G — substring-collision rescue (the #103/#114 whole-word fix, now
// extended to this offseason bouncer). A real IN-SEASON team ("Nationals" → MLB)
// co-occurs with a player surname that CONTAINS an out-of-season nickname as a
// bare substring ("CJ Ab*rams*" ⊃ NFL "rams"). Pre-fix the substring scan
// registered NFL as a DEFINITE out-of-season team and the offseason drop STOOD,
// silently killing a valid in-season MLB pick. Post-fix the \b-anchored
// legTextHasTeamWord ignores "rams" inside "Abrams", so only the real MLB
// Nationals leg remains → in-season-wins adopts MLB. (Control "Nationals ML" with
// no surname already passes above-style; the surname is the only difference.)
run('Nationals CJ Abrams Over 1.5 Total Bases (declared NFL) → rescues MLB (surname "Abrams" ⊅ NFL "rams")', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Nationals CJ Abrams Over 1.5 Total Bases', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Nationals CJ Abrams Over 1.5 Total Bases', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// No-weakening G2 — the whole-word matcher must still catch a BARE real nickname.
// "Rams ML" is the genuine NFL Rams (a whole word, not a surname substring) and is
// NFL-only, so it pins the pick out of season and the drop must still STAND. This
// guards that the substring fix narrowed the match to whole words WITHOUT losing
// real-team detection (the inverse of Resolution G).
run('Rams ML (declared NFL, real whole-word nickname) → still drops (no weakening)', () => {
  const pick = { sport: 'NFL', type: 'straight', description: 'Rams ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Rams ML', { hasMedia: false, now: TEST_NOW });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
