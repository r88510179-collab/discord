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
const { validateParsedBet, isInSeason } = require('../services/ai');

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
  const r = validateParsedBet(pick, '🚨 LOCK OF THE NIGHT', { hasMedia: true });
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
  const r = validateParsedBet(pick, 'Lakers tonight ML', { hasMedia: false });
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
  const r = validateParsedBet(pick, '🚨 LOCK PICK 🚨', { hasMedia: false });
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
  const r = validateParsedBet(pick, 'PrizePicks 40x slip 🔒', { hasMedia: false });
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
  const r = validateParsedBet(pick, '', { hasMedia: true });
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
  const r = validateParsedBet(pick, 'PrizePicks 40x slip', { hasMedia: true });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'placeholder', `expected placeholder, got: ${r.reason}`);
});

// Case 7: Out-of-season sport — exemption MUST NOT bypass the offseason check.
// NFL season runs Sep 1 → Feb 15; this test will pass any time outside that
// window. (Run date when authored: 2026-05-07.)
run('NFL out-of-season with hasMedia → reject (offseason still runs)', () => {
  const now = new Date();
  const m = now.getMonth() + 1;
  // Skip the assertion if NFL is in season — defensive against time-of-year
  // flakiness if this test is ever revisited Sept-Feb.
  if (m >= 9 || m <= 2) {
    console.log('    (skipped — NFL is currently in season)');
    return;
  }
  const pick = {
    sport: 'NFL',
    type: 'straight',
    description: 'Chiefs ML',
    odds: -150,
    units: 1,
    legs: [{ description: 'Chiefs ML', team: 'Chiefs' }],
  };
  const r = validateParsedBet(pick, 'PrizePicks 40x slip', { hasMedia: true });
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
  const r = validateParsedBet(pick, '🚨 LOCK OF THE NIGHT 🔒', { hasMedia: true });
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
// These tests are date-sensitive (isInSeason reads the real clock, exactly
// like Case 7 above). They run only inside the window where the bug
// manifests — MLB in season AND NFL out of season (≈ Mar 20 – Aug 31) —
// and skip otherwise, so the suite never goes red outside that window.
// ═══════════════════════════════════════════════════════════
console.log('\noffseason ambiguous-team disambiguation:');

const mlbIn = isInSeason('MLB');
const nflOut = !isInSeason('NFL');
const inBugWindow = mlbIn && nflOut; // MLB in season, NFL out — the 76871 window

// Regression A — direct repro of pipeline_events 76871. Declared sport NFL
// (the mislabel: "NFL is out of season"), description the literal "SF Giants ML".
// Pre-fix: dropped as offseason. Post-fix: in-season-wins adopts MLB.
run('SF Giants ML (declared NFL) → not dropped, resolves MLB (76871)', () => {
  if (!inBugWindow) { console.log('    (skipped — outside MLB-in/NFL-out window)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'SF Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'GNP\nSF Giants ML', { hasMedia: false });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// Regression B — bare ambiguous nickname, no qualifier. In-season-wins rule:
// "Giants" maps to {MLB, NFL}; MLB is in season, so it must not drop.
run('Giants ML bare (declared NFL) → not dropped, in-season wins (MLB)', () => {
  if (!inBugWindow) { console.log('    (skipped — outside MLB-in/NFL-out window)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Giants ML', { hasMedia: false });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// Regression C — a different ambiguous team (Cardinals = MLB + NFL). MLB in
// season → must not drop, adopts MLB.
run('Cardinals ML (declared NFL) → not dropped, resolves MLB', () => {
  if (!inBugWindow) { console.log('    (skipped — outside MLB-in/NFL-out window)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'Cardinals ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Cardinals ML', { hasMedia: false });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

// No-weakening D — a real single-league out-of-season pick. "Chiefs" is NFL-only,
// so there is no in-season league to fall back to: it must still drop. (Identical
// behavior pre- and post-fix — this is the invariant guard, not a regression.)
run('Chiefs ML (declared NFL, single-league) → still drops (no weakening)', () => {
  if (!nflOut) { console.log('    (skipped — NFL is currently in season)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'Chiefs ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Chiefs ML', { hasMedia: false });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// No-weakening E — a qualifier that pins the OUT-OF-SEASON franchise still drops.
// "New York Giants" disambiguates to the NFL Giants (full "<city> <nickname>"
// phrase); the fix must not blanket-rescue every ambiguous nickname. This is the
// genuine NFL-in-June case from the spec — it must still drop.
run('New York Giants ML (declared NFL, qualifier-pinned NFL) → still drops', () => {
  if (!nflOut) { console.log('    (skipped — NFL is currently in season)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'New York Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'New York Giants ML', { hasMedia: false });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// No-weakening E2 — multi-team genuine NFL pick whose nickname collides with an
// in-season league. "Patriots" is NFL-only and PINS the bet to NFL, so it must
// still drop in June even though "Jets" also names the in-season NHL Winnipeg
// Jets. (Without the unique-nickname pin this would be falsely rescued as NHL —
// this guards that pin.)
run('Patriots vs Jets (declared NFL, NFL-pinned vs NHL "Jets") → still drops', () => {
  if (!nflOut) { console.log('    (skipped — NFL is currently in season)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'Patriots vs Jets', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Patriots vs Jets', { hasMedia: false });
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
  if (!nflOut) { console.log('    (skipped — NFL is currently in season)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'Cowboys -7, San Francisco Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'Cowboys -7, San Francisco Giants ML', { hasMedia: false });
  assert.strictEqual(r.valid, false, `expected reject, got: ${JSON.stringify(r)}`);
  assert.strictEqual(r.reason, 'offseason', `expected offseason, got: ${r.reason}`);
});

// Resolution F — the full-city in-season qualifier is adopted outright (step 1),
// independent of the in-season-wins fallback: "San Francisco Giants" → MLB.
run('San Francisco Giants ML (declared NFL) → not dropped, resolves MLB', () => {
  if (!inBugWindow) { console.log('    (skipped — outside MLB-in/NFL-out window)'); return; }
  const pick = { sport: 'NFL', type: 'straight', description: 'San Francisco Giants ML', odds: null, units: 1, legs: [] };
  const r = validateParsedBet(pick, 'San Francisco Giants ML', { hasMedia: false });
  assert.strictEqual(r.valid, true, `expected pass, got: ${JSON.stringify(r)}`);
  assert.strictEqual(pick.sport, 'MLB', `expected sport adopted to MLB, got: ${pick.sport}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
