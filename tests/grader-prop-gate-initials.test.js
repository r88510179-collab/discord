// ═══════════════════════════════════════════════════════════
// Structured pre-check gate must admit player props whose subject is an
// all-caps initial name ("CJ Abrams", "TJ Oshie", "JD Martinez").
//
// The grader runs the structured-data pre-check (services/grading.js ~2918)
// only when `looksLikePlayerProp(bet)` is true AND the sport ∈ {MLB,NBA,NHL}.
// `looksLikePlayerProp` requires a `hasPlayer` match whose regex demanded a
// capital+lowercase first token (`[A-Z][a-z…]+`). Sports slips very commonly
// use initial first names — "CJ Abrams O 0.5 Hits" — and "CJ" has no lowercase
// letter, so `hasPlayer` was false → the gate blocked the bet → tryStructured
// was never called → the bet fell through to search+LLM and looped
// (the live looping bet 0f50c2bf, "CJ Abrams returned season totals").
//
// This is the end-to-end gap left after PR #120 (router: isPropBet via the
// per-sport parser) and PR #121 (gate stat-hints broadened to MLB+NBA+NHL):
// the router classified "CJ Abrams O 0.5 Hits" as a prop correctly, but the
// gate never let it reach the router. PR #120's mandatory discovery step 4
// ("confirm the fix changes the Abrams outcome end-to-end") is exactly this.
//
// Fix: the gate's `hasPlayer` regex now accepts an all-caps initials run
// (`[A-Z]{2,3}`) as the FIRST token, keeping the surname capital+lowercase so
// all-caps pairs like "AL MVP" / "ML PK" do not spuriously match. Dotted
// initials ("A.J. Pollock") already matched the original pattern.
//
// This test proves the full path end-to-end (gate admits → isPropBet routes to
// the structured PROP grader) without regressing two-word names, N+ props, or
// team totals (which stay routed to the TEAM grader by the #120/#121 guards).
// ═══════════════════════════════════════════════════════════

process.env.DB_PATH = ':memory:'; // require grading.js without touching a real DB

const grading = require('../services/grading');
const sportsdata = require('../services/sportsdata');

const gate = grading._internal && grading._internal.looksLikePlayerProp;
const { isPropBet } = sportsdata;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

console.log('grader-prop-gate-initials:');

if (typeof gate !== 'function') {
  check('grading._internal.looksLikePlayerProp is a function', false, typeof gate);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(1);
}

const SPORT_OK = (s) => ['MLB', 'NBA', 'NHL'].includes(String(s || '').toUpperCase());
const admits = (desc, sport) => gate({ description: desc, sport }) === true;

// Effective structured routing, mirroring the grading.js call site verbatim:
//   if (looksLikePlayerProp(bet) && sport ∈ {MLB,NBA,NHL}) → tryStructured → isPropBet
function effectiveRoute(desc, sport) {
  const reachesStructured = gate({ description: desc, sport }) && SPORT_OK(sport);
  if (!reachesStructured) return 'search'; // structured skipped → ESPN+AI fall-through
  return isPropBet(desc, sport) ? 'prop' : 'team';
}

// ── 1. The gap is closed: gate now admits initial-name props ──
console.log(' gate admits initial-name props (was the all-caps-name gap):');
check('MLB "CJ Abrams O 0.5 Hits" admitted', admits('CJ Abrams O 0.5 Hits', 'MLB'));
check('MLB "JD Martinez O 1.5 Total Bases" admitted', admits('JD Martinez O 1.5 Total Bases', 'MLB'));
check('MLB "JT Realmuto O 0.5 RBIs" admitted', admits('JT Realmuto O 0.5 RBIs', 'MLB'));
check('NBA "CJ McCollum O 18.5 Points" admitted', admits('CJ McCollum O 18.5 Points', 'NBA'));
check('NBA "RJ Barrett O 1.5 Threes" admitted', admits('RJ Barrett O 1.5 Threes', 'NBA'));
check('NBA "PJ Washington O 9.5 Rebounds" admitted', admits('PJ Washington O 9.5 Rebounds', 'NBA'));
check('NHL "TJ Oshie O 2.5 Shots on Goal" admitted', admits('TJ Oshie O 2.5 Shots on Goal', 'NHL'));
check('NHL "JT Miller O 0.5 Goals" admitted', admits('JT Miller O 0.5 Goals', 'NHL'));

// ── 2. End-to-end: initial-name props route to the structured PROP grader ──
console.log(' initial-name props → structured prop grader (end-to-end):');
check('MLB CJ Abrams Hits → prop', effectiveRoute('CJ Abrams O 0.5 Hits', 'MLB') === 'prop');
check('MLB JD Martinez Total Bases → prop', effectiveRoute('JD Martinez O 1.5 Total Bases', 'MLB') === 'prop');
check('NBA CJ McCollum Points → prop', effectiveRoute('CJ McCollum O 18.5 Points', 'NBA') === 'prop');
check('NBA RJ Barrett Threes → prop', effectiveRoute('RJ Barrett O 1.5 Threes', 'NBA') === 'prop');
check('NHL TJ Oshie SOG → prop', effectiveRoute('TJ Oshie O 2.5 Shots on Goal', 'NHL') === 'prop');

// ── 3. Regression: two-word names, N+ props, and the named MLB bet still work ──
console.log(' regression — existing prop shapes unchanged:');
check('MLB "Fernando Tatis Jr. O 0.5 Hits" → prop', effectiveRoute('Fernando Tatis Jr. O 0.5 Hits', 'MLB') === 'prop');
check('NBA "Naz Reid 15+ PTS + REB" → prop', effectiveRoute('Naz Reid 15+ PTS + REB', 'NBA') === 'prop');
check('NBA "Stephen Curry O 25.5 Points" → prop', effectiveRoute('Stephen Curry O 25.5 Points', 'NBA') === 'prop');
check('NHL "Connor McDavid O 0.5 Goals" → prop', effectiveRoute('Connor McDavid O 0.5 Goals', 'NHL') === 'prop');

// ── 4. Team totals still route to the TEAM grader (guard holds) ──
console.log(' team totals → team grader, NOT prop:');
check('MLB "Los Angeles Dodgers Over 8.5 Runs" → team', effectiveRoute('Los Angeles Dodgers Over 8.5 Runs', 'MLB') === 'team');
check('NHL "Edmonton Oilers Over 6.5 Goals" → team', effectiveRoute('Edmonton Oilers Over 6.5 Goals', 'NHL') === 'team');

// ── 5. Plain team bets (no stat word) are still NOT admitted ──
console.log(' plain team bets → gate blocked (no stat hint):');
check('MLB "New York Yankees ML" not admitted', admits('New York Yankees ML', 'MLB') === false);
check('NBA "Lakers -3.5" not admitted', admits('Lakers -3.5', 'NBA') === false);

// ── 6. All-caps non-name pairs must NOT spuriously match hasPlayer ──
console.log(' all-caps non-name pairs → not admitted (surname must be cap+lowercase):');
check('"AL MVP" not admitted (no real player/surname)', admits('AL MVP', 'MLB') === false);
check('"NL ROY" not admitted', admits('NL ROY', 'MLB') === false);

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
