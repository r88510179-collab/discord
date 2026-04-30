// ═══════════════════════════════════════════════════════════
// Grader player-prop guard — G6 sub-check.
//
// Regression: 2026-04-30, bet ada01c0f9dbefb16a5b8a2444f3c819f
// ("OVER 14.5 POINTS SCOOT HENDERSON") was graded WIN by Cerebras
// on team-only evidence ("Spurs 114, Trail Blazers 93"). G7 was
// skipped (no teams in description), G8 was skipped (NBA is not
// in the INDIVIDUAL_SPORTS list). The new G6 sub-check requires
// the player surname to appear in evidence whenever the
// description matches a player-prop pattern.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { evaluatePlayerPropEvidence } = require('../services/grading');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    fail++;
  }
}

console.log('grader-player-prop-guard:');

// FAIL: team-only evidence on player point prop (the Scoot Henderson case)
check(
  'team box score does not satisfy player point prop',
  evaluatePlayerPropEvidence(
    'OVER 14.5 POINTS SCOOT HENDERSON',
    'Spurs 114, Trail Blazers 93 per search results',
  ).passed,
  false,
);

// FAIL: evidence about a different player
check(
  'wrong player does not satisfy player point prop',
  evaluatePlayerPropEvidence(
    'OVER 24.5 POINTS LEBRON JAMES',
    'Stephen Curry scored 38 points',
  ).passed,
  false,
);

// PASS: evidence names the right player by full name
check(
  'right player named in evidence passes',
  evaluatePlayerPropEvidence(
    'OVER 14.5 POINTS SCOOT HENDERSON',
    'Scoot Henderson scored 18 points per ESPN',
  ).passed,
  true,
);

// PASS: evidence names the player by surname only
check(
  'surname-only match passes',
  evaluatePlayerPropEvidence(
    'Stephen Curry Over 25.5 Points',
    'Curry scored 31 points per ESPN',
  ).passed,
  true,
);

// PASS: not a player prop, guard does not apply
check(
  'team ML is not subject to player guard',
  evaluatePlayerPropEvidence(
    'Lakers ML -150',
    'Lakers won 118-110 per ESPN',
  ).passed,
  true,
);

// FAIL: rebound prop, evidence omits player
check(
  'rebound prop without player name fails',
  evaluatePlayerPropEvidence(
    'Nikola Jokic Over 11.5 Rebounds',
    'Nuggets beat Lakers 122-118 in OT',
  ).passed,
  false,
);

// PASS: N+ format with player named in evidence
check(
  'N+ HITS prop with player surname in evidence passes',
  evaluatePlayerPropEvidence(
    'Aaron Judge 2+ Hits',
    'Judge went 2-for-4 with a single and a double',
  ).passed,
  true,
);

// PASS: anytime goal — player named in evidence
check(
  'anytime-goal prop with surname in evidence passes',
  evaluatePlayerPropEvidence(
    'Erling Haaland Anytime Goal',
    'Haaland scored in the 32nd minute',
  ).passed,
  true,
);

// FAIL: anytime goal — evidence is team-only
check(
  'anytime-goal prop with team-only evidence fails',
  evaluatePlayerPropEvidence(
    'Erling Haaland Anytime Goal',
    'Manchester City beat Arsenal 2-1',
  ).passed,
  false,
);

// PASS: empty evidence on non-player-prop description (guard skipped)
check(
  'guard returns passed on non-player-prop with empty evidence',
  evaluatePlayerPropEvidence('Over 8.5 Total Goals', '').passed,
  true,
);

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
