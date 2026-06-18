// ═══════════════════════════════════════════════════════════
// Structured team graders must REFUSE single-team "Team Total" bets.
//
// A "Team Total" (e.g. "Warriors Team Total Over 115.5 Points") is about ONE
// team's score, not the game total. The team graders' total branch computes the
// GAME total (away + home), so grading a Team Total there gives a WRONG terminal
// result (e.g. WIN when the team's own score was a LOSS).
//
// This became reachable for NBA/NHL once fix/grader-prop-gate-nba-nhl broadened
// PLAYER_PROP_STAT_HINTS: NBA/NHL team totals now pass the structured gate, and
// isPropBet routes them (subject canonicalizes to a team) to the team grader.
// The guard makes the team graders return {resolved:false} so the caller falls
// through to ESPN+AI (which understands team totals). It runs BEFORE any network
// fetch, so this test is fully offline. It also closes the pre-existing MLB case.
// ═══════════════════════════════════════════════════════════

const mlb = require('../services/sportsdata/mlb');
const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');
const { isTeamTotalBet } = require('../services/sportsdata/teamTotal');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// Any network call means the guard did NOT short-circuit first → fail loudly.
let networkAttempted = false;
global.fetch = async () => { networkAttempted = true; throw new Error('network must not be called for team-total bets'); };

console.log('structured-team-total-guard:');

(async () => {
  const teamTotals = [
    ['mlb', () => mlb.gradeMlbBet('New York Yankees Team Total Over 4.5 Runs', '2026-05-01')],
    ['mlb TT', () => mlb.gradeMlbBet('Yankees TT Over 4.5 Runs', '2026-05-01')],
    ['nba', () => nba.gradeNbaBet('Golden State Warriors Team Total Over 115.5 Points', '2026-05-01')],
    ['nba TT', () => nba.gradeNbaBet('Lakers TT Over 115.5 Points', '2026-05-01')],
    ['nhl', () => nhl.gradeNhlBet('Edmonton Oilers Team Total Over 3.5 Goals', '2026-05-01')],
    ['nhl TT', () => nhl.gradeNhlBet('Oilers TT Under 2.5 Goals', '2026-05-01')],
  ];
  for (const [name, fn] of teamTotals) {
    let r;
    try { r = await fn(); } catch (e) { r = { error: e.message }; }
    check(`${name} team total → refused (resolved:false, team_total_unsupported)`,
      r && r.resolved === false && r.reason === 'team_total_unsupported',
      JSON.stringify(r));
  }

  check('no network was attempted (guard runs before fetch)', networkAttempted === false);

  // ── Shared helper: phrasing/rendering variants must all be caught (decline) ──
  // These slipped past the first guard regex (review round 2): hyphen, abbreviation,
  // reversed word order, plural, ITT. Locking them prevents a confident false grade.
  console.log(' isTeamTotalBet variants → caught:');
  const teamTotalPhrasings = [
    'Warriors Team Total Over 115.5 Points',
    'Warriors Team-Total Over 115.5 Points',   // hyphen (OCR/book rendering)
    'Warriors Team Tot Over 115.5 Points',     // abbreviation
    'Warriors Total Team Over 115.5 Points',   // reversed word order
    'Lakers Team Totals Over 115.5',           // plural
    'Lakers TT Over 115.5 Points',             // TT
    'Lakers ITT o4.5',                         // ITT (individual team total)
  ];
  for (const p of teamTotalPhrasings) check(`caught: "${p}"`, isTeamTotalBet(p) === true);

  // ── Negatives: must NOT be caught (those must reach the team/prop graders) ──
  console.log(' isTeamTotalBet negatives → NOT caught:');
  const negatives = [
    'golden state warriors over 220.5 points', // GAME total — graded by team grader
    'los angeles dodgers over 8.5 runs',        // GAME total
    'both teams total over 9.5',                // GAME total ("both teams" combined)
    'Juan Soto O 1.5 Total Bases',             // MLB stat "total bases", NOT a team total
    'Lakers Total Over 220.5',                 // bare game total
    'OTT ML',                                  // Ottawa abbrev contains "tt" — must not match
    'Pitt Panthers ML',                        // "tt" inside "pitt"
    'pistons -5.5',                            // spread
    'scottie barnes o 25.5 points',            // "tt" inside "scottie"
    'matt olson o 1.5 hits',                   // "tt" inside "matt"
  ];
  for (const n of negatives) check(`NOT caught: "${n}"`, isTeamTotalBet(n) === false);

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
