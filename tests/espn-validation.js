// ═══════════════════════════════════════════════════════════
// ESPN grading validation — exercises parseBetDescription,
// matchTeamsToEvent, gradeFromScore with synthetic data.
// No network calls. No real ESPN API hits.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { parseBetDescription, matchTeamsToEvent, gradeFromScore } = require('../services/espn');

// ── Helper: build ESPN-shaped event ──
function mkEvent(home, away, homeScore, awayScore, completed = true) {
  const mkTeam = (name) => ({
    displayName: name,
    shortDisplayName: name.split(' ').pop(),
    abbreviation: name.split(' ').map(w => w[0]).join('').toUpperCase(),
  });
  return {
    competitions: [{
      competitors: [
        { team: mkTeam(home), score: String(homeScore), homeAway: 'home', winner: homeScore > awayScore },
        { team: mkTeam(away), score: String(awayScore), homeAway: 'away', winner: awayScore > homeScore },
      ],
      status: { type: { completed, description: completed ? 'Final' : 'In Progress' } },
    }],
  };
}

const MLB_EVENTS = [
  mkEvent('New York Yankees', 'Oakland Athletics', 5, 3),
  mkEvent('Los Angeles Dodgers', 'Miami Marlins', 2, 4),
];
const NBA_EVENTS = [
  mkEvent('Cleveland Cavaliers', 'Indiana Pacers', 118, 112),
];
const NHL_EVENTS = [
  mkEvent('Colorado Avalanche', 'Dallas Stars', 4, 2),
  mkEvent('Tampa Bay Lightning', 'Florida Panthers', 1, 3, false), // in progress
];

function run() {
  let pass = 0;

  // ═══ parseBetDescription ═══

  // Explicit ML
  const p1 = parseBetDescription('Marlins ML +130', ['miami marlins']);
  assert.strictEqual(p1.type, 'ml'); pass++;

  // Spread with .5
  const p2 = parseBetDescription('Yankees -1.5 +110', ['new york yankees']);
  assert.strictEqual(p2.type, 'spread');
  assert.strictEqual(p2.line, -1.5); pass++;

  // Total Over
  const p3 = parseBetDescription('Phoenix Suns Houston Rockets O220.5', ['phoenix suns', 'houston rockets']);
  assert.strictEqual(p3.type, 'total');
  assert.strictEqual(p3.line, 220.5);
  assert.strictEqual(p3.direction, 'over'); pass++;

  // Total Under
  const p4 = parseBetDescription('Under 7.5', []);
  assert.strictEqual(p4.type, 'total');
  assert.strictEqual(p4.direction, 'under');
  assert.strictEqual(p4.line, 7.5); pass++;

  // Implied ML (team + 3-digit odds, no spread)
  const p5 = parseBetDescription('Atlanta Braves -115', ['atlanta braves']);
  assert.strictEqual(p5.type, 'ml'); pass++;

  // Spread — positive
  const p6 = parseBetDescription('Los Angeles Angels +1.5', ['los angeles angels']);
  assert.strictEqual(p6.type, 'spread');
  assert.strictEqual(p6.line, 1.5); pass++;

  // Player prop → null
  const p7 = parseBetDescription('Mashack 7+ Assists (+125)', []);
  assert.strictEqual(p7.type, null);
  assert.strictEqual(p7.reason, 'player_prop'); pass++;

  // NRFI → null (exotic)
  const p8 = parseBetDescription('CLE-ATL NRFI', []);
  assert.strictEqual(p8.type, null); pass++;

  // SGP → null (exotic)
  const p9 = parseBetDescription('Miami Heat @ Charlotte Hornets SGP', ['miami heat', 'charlotte hornets']);
  assert.strictEqual(p9.type, null); pass++;

  // Multi-team in single line → null
  const p10 = parseBetDescription('Hornets -6 and Blazers +3.5', ['charlotte hornets', 'portland trail blazers']);
  assert.strictEqual(p10.type, null); pass++;

  // Placeholder/promo junk → null
  const p11 = parseBetDescription('2x NBA Straights', []);
  assert.strictEqual(p11.type, null); pass++;

  console.log(`✅ parseBetDescription: ${pass} passed`);

  // ═══ matchTeamsToEvent ═══
  let mPass = 0;

  // Full name match
  const m1 = matchTeamsToEvent(MLB_EVENTS, ['miami marlins']);
  assert.ok(m1, 'full name Marlins'); mPass++;

  // Nickname match
  const m2 = matchTeamsToEvent(MLB_EVENTS, ['new york yankees']);
  assert.ok(m2, 'full name Yankees'); mPass++;

  // Single-word nickname match
  const m3 = matchTeamsToEvent(MLB_EVENTS, ['yankees']);
  assert.ok(m3, 'nickname Yankees'); mPass++;

  // No match — team not playing
  const m4 = matchTeamsToEvent(MLB_EVENTS, ['boston red sox']);
  assert.strictEqual(m4, null, 'Red Sox not in events'); mPass++;

  // In-progress game → null
  const m5 = matchTeamsToEvent(NHL_EVENTS, ['tampa bay lightning']);
  assert.strictEqual(m5, null, 'in-progress not matched'); mPass++;

  // Completed game matches
  const m6 = matchTeamsToEvent(NHL_EVENTS, ['colorado avalanche']);
  assert.ok(m6, 'Avs completed'); mPass++;

  // Empty teams → null
  const m7 = matchTeamsToEvent(MLB_EVENTS, []);
  assert.strictEqual(m7, null); mPass++;

  console.log(`✅ matchTeamsToEvent: ${mPass} passed`);

  // ═══ gradeFromScore ═══
  let gPass = 0;

  // MLB ML: Marlins won 4-2 → WIN
  const marlinsMatch = matchTeamsToEvent(MLB_EVENTS, ['miami marlins']);
  const g1 = gradeFromScore({ type: 'ml', team: 'miami marlins' }, marlinsMatch, ['miami marlins']);
  assert.strictEqual(g1.result, 'WIN');
  assert.ok(g1.evidence.includes('ESPN')); gPass++;

  // MLB ML: Dodgers lost 2-4 → LOSS
  const dodgersMatch = matchTeamsToEvent(MLB_EVENTS, ['los angeles dodgers']);
  const g2 = gradeFromScore({ type: 'ml', team: 'los angeles dodgers' }, dodgersMatch, ['los angeles dodgers']);
  assert.strictEqual(g2.result, 'LOSS'); gPass++;

  // MLB spread: Yankees -1.5, won 5-3 → 5+(-1.5)-3 = 0.5 > 0 → WIN
  const yanksMatch = matchTeamsToEvent(MLB_EVENTS, ['new york yankees']);
  const g3 = gradeFromScore({ type: 'spread', team: 'new york yankees', line: -1.5 }, yanksMatch, ['new york yankees']);
  assert.strictEqual(g3.result, 'WIN'); gPass++;

  // Spread: Yankees -2.5, won 5-3 → 5+(-2.5)-3 = -0.5 → LOSS
  const g4 = gradeFromScore({ type: 'spread', team: 'new york yankees', line: -2.5 }, yanksMatch, ['new york yankees']);
  assert.strictEqual(g4.result, 'LOSS'); gPass++;

  // Spread push: Yankees -2, won 5-3 → 5+(-2)-3 = 0 → PUSH
  const g5 = gradeFromScore({ type: 'spread', team: 'new york yankees', line: -2 }, yanksMatch, ['new york yankees']);
  assert.strictEqual(g5.result, 'PUSH'); gPass++;

  // NBA total over: 118+112=230 > 220.5 → WIN
  const nbaMatch = matchTeamsToEvent(NBA_EVENTS, ['cleveland cavaliers']);
  const g6 = gradeFromScore({ type: 'total', line: 220.5, direction: 'over' }, nbaMatch, ['cleveland cavaliers']);
  assert.strictEqual(g6.result, 'WIN'); gPass++;

  // NBA total under 220.5: 230 > 220.5 → LOSS
  const g7 = gradeFromScore({ type: 'total', line: 220.5, direction: 'under' }, nbaMatch, ['cleveland cavaliers']);
  assert.strictEqual(g7.result, 'LOSS'); gPass++;

  // Total push: line = exact game total
  const g8 = gradeFromScore({ type: 'total', line: 230, direction: 'over' }, nbaMatch, ['cleveland cavaliers']);
  assert.strictEqual(g8.result, 'PUSH'); gPass++;

  // NHL ML: Avs won 4-2 → WIN
  const avMatch = matchTeamsToEvent(NHL_EVENTS, ['colorado avalanche']);
  const g9 = gradeFromScore({ type: 'ml', team: 'colorado avalanche' }, avMatch, ['colorado avalanche']);
  assert.strictEqual(g9.result, 'WIN'); gPass++;

  // Unparseable bet → gradeFromScore returns null (safe)
  const g10 = gradeFromScore({ type: null }, nbaMatch, ['cleveland cavaliers']);
  assert.strictEqual(g10, null); gPass++;

  console.log(`✅ gradeFromScore: ${gPass} passed`);

  const total = pass + mPass + gPass;
  console.log(`\nESPN validation passed — all ${total} assertions.`);
}

try {
  run();
} catch (err) {
  console.error('❌ FAILED:', err.message);
  console.error(err.stack?.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
}
