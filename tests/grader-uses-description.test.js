// ═══════════════════════════════════════════════════════════
// Grader query construction must use bet.description, never
// bet.raw_text. raw_text is the original ingestion source (tweet
// body, message text) and may contain TweetShift relay captions,
// memes, or unrelated replies.
//
// Regression: bet ada01c0f9dbefb16a5b8a2444f3c819f, attempts 4-7,
// burned three days because the surrounding ingestion text leaked
// into the query path. Attempt 8 finally used the description and
// produced (still hallucinated, but) the correct query shape.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { buildGraderSearchQuery } = require('../services/grading');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

console.log('grader-uses-description:');

// The literal Scoot Henderson regression case.
const scootBet = {
  id: 'test-scoot',
  description: 'OVER 14.5 POINTS SCOOT HENDERSON',
  raw_text: 'Turns out walking is much more enjoyable, actually... I\'m gonna ditch the scooter',
  sport: 'NBA',
  event_date: '2026-04-15',
};
const scootQuery = buildGraderSearchQuery(scootBet);

check(
  'query references the bet description, not the unrelated raw_text',
  scootQuery.toLowerCase().includes('henderson')
    || scootQuery.toLowerCase().includes('scoot')
    || scootQuery.includes('14.5'),
  `query: "${scootQuery}"`,
);

check(
  'query does NOT contain raw_text content (walking/scooter)',
  !scootQuery.toLowerCase().includes('walking')
    && !scootQuery.toLowerCase().includes('scooter')
    && !scootQuery.toLowerCase().includes('enjoyable'),
  `query: "${scootQuery}"`,
);

// Team bet — description names teams; raw_text is misleading.
const teamBet = {
  id: 'test-teams',
  description: 'Lakers vs Warriors -3.5',
  raw_text: 'random unrelated text mentioning Celtics and Heat',
  sport: 'NBA',
  event_date: '2026-04-15',
};
const teamQuery = buildGraderSearchQuery(teamBet);

check(
  'team query does NOT leak raw_text team names (Celtics)',
  !teamQuery.toLowerCase().includes('celtics'),
  `query: "${teamQuery}"`,
);
check(
  'team query does NOT leak raw_text team names (Heat)',
  // "heat" appears in "final score" only as substring of nothing — guard literal word
  !/\bheat\b/i.test(teamQuery),
  `query: "${teamQuery}"`,
);

// Player prop where the player name overlaps with raw_text noise.
const overlapBet = {
  id: 'test-overlap',
  description: 'Aaron Judge 2+ Hits',
  raw_text: 'Bobby is a moron and his picks are terrible',
  sport: 'MLB',
  event_date: '2026-04-15',
};
const overlapQuery = buildGraderSearchQuery(overlapBet);

check(
  'player-prop query references the player name from description',
  /judge|aaron|hits/i.test(overlapQuery),
  `query: "${overlapQuery}"`,
);
check(
  'player-prop query does NOT leak raw_text content',
  !/bobby|moron|terrible/i.test(overlapQuery),
  `query: "${overlapQuery}"`,
);

// Missing event_date should not throw — falls back to bet.created_at,
// then to empty date string. Never panic.
const noDateBet = {
  id: 'test-nodate',
  description: 'OVER 14.5 POINTS SCOOT HENDERSON',
  sport: 'NBA',
};
let noDateQuery;
try {
  noDateQuery = buildGraderSearchQuery(noDateBet);
  check('builds query without event_date (no throw)', true);
} catch (err) {
  check('builds query without event_date (no throw)', false, err.message);
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
