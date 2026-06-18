// ═══════════════════════════════════════════════════════════
// Structured pre-check gate must admit NBA/NHL player props, not just MLB.
//
// The grader runs the structured-data pre-check (services/grading.js ~2899)
// only when `looksLikePlayerProp(bet)` is true AND the sport ∈ {MLB,NBA,NHL}.
// `looksLikePlayerProp` keys on the regex PLAYER_PROP_STAT_HINTS, which used to
// list ONLY MLB stat words (hits/runs/rbis/strikeouts/…). So NBA props
// ("Stephen Curry O 25.5 Points") and NHL props ("Connor McDavid O 0.5 Goals")
// never tripped the gate → never reached tryStructured → the per-sport
// looksLikePlayerProp routing added in PR #120 (services/sportsdata/{nba,nhl}.js)
// was inert in production. This is the "MLB-bias gap" the s1b diagnostic sized.
//
// Fix: PLAYER_PROP_STAT_HINTS now covers MLB + NBA + NHL. This test proves the
// full path — gate admits → isPropBet routes to the structured PROP grader —
// without misrouting team totals (those route to the team grader via the
// sportsdata isPropBet guard) and without regressing MLB (incl. pitching stats).
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

console.log('grader-prop-gate-cross-sport:');

if (typeof gate !== 'function') {
  check('grading._internal.looksLikePlayerProp is a function', false, typeof gate);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(1);
}

const SPORT_OK = (s) => ['MLB', 'NBA', 'NHL'].includes(String(s || '').toUpperCase());

// Effective structured routing, mirroring the grading.js call site verbatim:
//   if (looksLikePlayerProp(bet) && sport ∈ {MLB,NBA,NHL}) → tryStructured → isPropBet
function effectiveRoute(desc, sport) {
  const reachesStructured = gate({ description: desc, sport }) && SPORT_OK(sport);
  if (!reachesStructured) return 'search'; // structured skipped → ESPN+AI fall-through
  return isPropBet(desc, sport) ? 'prop' : 'team';
}
const admits = (desc, sport) => gate({ description: desc, sport }) === true;

// ── 1. The gap is closed: gate now admits NBA/NHL props ──
console.log(' gate admits NBA/NHL props (was the MLB-bias gap):');
check('NBA "Stephen Curry O 25.5 Points" admitted', admits('Stephen Curry O 25.5 Points', 'NBA'));
check('NBA "Nikola Jokic O 10.5 Rebounds" admitted', admits('Nikola Jokic O 10.5 Rebounds', 'NBA'));
check('NBA "Luka Doncic O 39.5 PRA" admitted', admits('Luka Doncic O 39.5 PRA', 'NBA'));
check('NBA "Jayson Tatum 2+ Threes" admitted', admits('Jayson Tatum 2+ Threes', 'NBA'));
check('NHL "Connor McDavid O 0.5 Goals" admitted', admits('Connor McDavid O 0.5 Goals', 'NHL'));
check('NHL "Auston Matthews O 3.5 Shots on Goal" admitted', admits('Auston Matthews O 3.5 Shots on Goal', 'NHL'));
check('NHL "Igor Shesterkin O 29.5 Saves" admitted', admits('Igor Shesterkin O 29.5 Saves', 'NHL'));

// ── 2. End-to-end: NBA/NHL props now route to the structured PROP grader ──
console.log(' NBA/NHL props → structured prop grader (end-to-end):');
check('NBA Points → prop', effectiveRoute('Stephen Curry O 25.5 Points', 'NBA') === 'prop');
check('NBA Rebounds → prop', effectiveRoute('Nikola Jokic O 10.5 Rebounds', 'NBA') === 'prop');
check('NBA Assists → prop', effectiveRoute('Trae Young O 9.5 Assists', 'NBA') === 'prop');
check('NHL Goals → prop', effectiveRoute('Connor McDavid O 0.5 Goals', 'NHL') === 'prop');
check('NHL Saves → prop', effectiveRoute('Igor Shesterkin O 29.5 Saves', 'NHL') === 'prop');

// ── 3. Team totals are admitted but route to the TEAM grader (guard holds) ──
console.log(' team totals → team grader, NOT prop (isPropBet guard):');
check('NBA "Los Angeles Lakers Over 220.5 Points" → team', effectiveRoute('Los Angeles Lakers Over 220.5 Points', 'NBA') === 'team');
check('NHL "Edmonton Oilers Over 6.5 Goals" → team', effectiveRoute('Edmonton Oilers Over 6.5 Goals', 'NHL') === 'team');

// ── 4. Plain team bets (no stat word) are NOT admitted as props ──
console.log(' plain team bets → gate blocked (no stat hint):');
check('NBA "Lakers -5.5" not admitted', admits('Lakers -5.5', 'NBA') === false);
check('NHL "Bruins ML" not admitted', admits('Bruins ML', 'NHL') === false);
check('MLB "Atlanta Braves ML" not admitted', admits('Atlanta Braves ML', 'MLB') === false);

// ── 5. MLB regression guard — extend, don't replace (pitching stats survive) ──
console.log(' MLB still works (incl. pitching stats — extend not replace):');
check('MLB "Aaron Judge O 0.5 Hits" → prop', effectiveRoute('Aaron Judge O 0.5 Hits', 'MLB') === 'prop');
check('MLB "Spencer Strider O 6.5 Strikeouts" → prop', effectiveRoute('Spencer Strider O 6.5 Strikeouts', 'MLB') === 'prop');
check('MLB "Tarik Skubal O 17.5 Pitching Outs" → prop', effectiveRoute('Tarik Skubal O 17.5 Pitching Outs', 'MLB') === 'prop');
check('MLB "Some Pitcher O 5.5 Walks" admitted (pitching stat kept)', admits('Some Pitcher O 5.5 Walks', 'MLB'));
check('MLB "Los Angeles Dodgers Over 8.5 Runs" → team', effectiveRoute('Los Angeles Dodgers Over 8.5 Runs', 'MLB') === 'team');

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
