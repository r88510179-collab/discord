const assert = require('assert');
const { normalizeTeam, normalizeDescription, reloadMappings } = require('../services/normalization');

// Ensure mappings are loaded
reloadMappings();

// ═══════════════════════════════════════════════════════════
// TEST 1: normalizeTeam — NBA aliases resolve to canonical
// ═══════════════════════════════════════════════════════════
function testNBATeamAliases() {
  const cases = [
    ['LAL', 'Los Angeles Lakers'],
    ['lal', 'Los Angeles Lakers'],
    ['Lakers', 'Los Angeles Lakers'],
    ['lakers', 'Los Angeles Lakers'],
    ['lake show', 'Los Angeles Lakers'],
    ['GSW', 'Golden State Warriors'],
    ['Warriors', 'Golden State Warriors'],
    ['dubs', 'Golden State Warriors'],
    ['golden state', 'Golden State Warriors'],
    ['Celtics', 'Boston Celtics'],
    ['76ers', 'Philadelphia 76ers'],
    ['sixers', 'Philadelphia 76ers'],
    ['Cavs', 'Cleveland Cavaliers'],
    ['OKC', 'Oklahoma City Thunder'],
    ['Knicks', 'New York Knicks'],
    ['NYK', 'New York Knicks'],
    ['Mavs', 'Dallas Mavericks'],
    ['Grizz', 'Memphis Grizzlies'],
    ['Pels', 'New Orleans Pelicans'],
    ['Nugs', 'Denver Nuggets'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizeTeam(input);
    assert.strictEqual(result, expected,
      `normalizeTeam("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ NBA team aliases resolve to canonical names');
}

// ═══════════════════════════════════════════════════════════
// TEST 2: normalizeTeam — NFL, MLB, NHL aliases
// ═══════════════════════════════════════════════════════════
function testOtherLeagueAliases() {
  const cases = [
    // NFL
    ['Chiefs', 'Kansas City Chiefs'],
    ['KC', 'Kansas City Chiefs'],
    ['49ers', 'San Francisco 49ers'],
    ['niners', 'San Francisco 49ers'],
    ['Philly', 'Philadelphia Eagles'],
    ['Eagles', 'Philadelphia Eagles'],
    ['Cowboys', 'Dallas Cowboys'],
    ['Boys', 'Dallas Cowboys'],
    ['Cincy', 'Cincinnati Bengals'],
    ['Phins', 'Miami Dolphins'],
    ['NYJ', 'New York Jets'],
    // MLB
    ['Yankees', 'New York Yankees'],
    ['NYY', 'New York Yankees'],
    ['Yanks', 'New York Yankees'],
    ['Bronx Bombers', 'New York Yankees'],
    ['Dodgers', 'Los Angeles Dodgers'],
    ['Stros', 'Houston Astros'],
    ['Phillies', 'Philadelphia Phillies'],
    ['Phils', 'Philadelphia Phillies'],
    ['Red Sox', 'Boston Red Sox'],
    ['Cards', 'St. Louis Cardinals'],
    ['STL', 'St. Louis Cardinals'],
    ['Blue Jays', 'Toronto Blue Jays'],
    ['Jays', 'Toronto Blue Jays'],
    // NHL
    ['Oilers', 'Edmonton Oilers'],
    ['Avs', 'Colorado Avalanche'],
    ['Leafs', 'Toronto Maple Leafs'],
    ['Bruins', 'Boston Bruins'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizeTeam(input);
    assert.strictEqual(result, expected,
      `normalizeTeam("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ NFL, MLB, NHL aliases resolve to canonical names');
}

// ═══════════════════════════════════════════════════════════
// TEST 2b: Ambiguous cross-league abbreviations pass through
// ═══════════════════════════════════════════════════════════
function testAmbiguousAbbreviations() {
  // PHI and TOR map to different teams across leagues — should pass through
  const ambiguous = ['PHI', 'TOR'];
  for (const abbr of ambiguous) {
    const result = normalizeTeam(abbr);
    assert.strictEqual(result, abbr,
      `Ambiguous abbreviation "${abbr}" should pass through unchanged but got "${result}"`);
  }
  // Non-ambiguous abbreviations that only appear in one league should still resolve
  assert.strictEqual(normalizeTeam('BOS'), 'Boston Red Sox');
  assert.strictEqual(normalizeTeam('DAL'), 'Dallas Cowboys');
  assert.strictEqual(normalizeTeam('MIA'), 'Miami Dolphins');
  assert.strictEqual(normalizeTeam('ATL'), 'Atlanta Braves');
  console.log('  ✓ Ambiguous abbreviations pass through, unique ones resolve');
}

// ═══════════════════════════════════════════════════════════
// TEST 3: normalizeTeam — case insensitivity
// ═══════════════════════════════════════════════════════════
function testCaseInsensitivity() {
  assert.strictEqual(normalizeTeam('LAKERS'), 'Los Angeles Lakers');
  assert.strictEqual(normalizeTeam('lAkErS'), 'Los Angeles Lakers');
  assert.strictEqual(normalizeTeam('gsw'), 'Golden State Warriors');
  assert.strictEqual(normalizeTeam('GSW'), 'Golden State Warriors');
  console.log('  ✓ Normalization is case-insensitive');
}

// ═══════════════════════════════════════════════════════════
// TEST 4: normalizeTeam — unknown names pass through
// ═══════════════════════════════════════════════════════════
function testUnknownPassthrough() {
  assert.strictEqual(normalizeTeam('Some Random Team'), 'Some Random Team');
  assert.strictEqual(normalizeTeam('LeBron James'), 'LeBron James');
  assert.strictEqual(normalizeTeam(''), '');
  assert.strictEqual(normalizeTeam(null), '');
  console.log('  ✓ Unknown names pass through unchanged');
}

// ═══════════════════════════════════════════════════════════
// TEST 5: normalizeDescription — inline replacements
// ═══════════════════════════════════════════════════════════
function testDescriptionNormalization() {
  const cases = [
    ['LAL -3.5 vs GSW', 'Los Angeles Lakers -3.5 vs Golden State Warriors'],
    ['Lakers ML', 'Los Angeles Lakers ML'],
    ['Celtics over 220.5', 'Boston Celtics over 220.5'],
    ['Chiefs -7 lock', 'Kansas City Chiefs -7 lock'],
    ['Cavs +4.5 1u', 'Cleveland Cavaliers +4.5 1u'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizeDescription(input);
    assert.strictEqual(result, expected,
      `normalizeDescription("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ Descriptions have team aliases replaced inline');
}

// ═══════════════════════════════════════════════════════════
// TEST 6: normalizeDescription — preserves non-team text
// ═══════════════════════════════════════════════════════════
function testDescriptionPreservesOther() {
  const input = 'LeBron James 25+ points -115';
  const result = normalizeDescription(input);
  assert.strictEqual(result, input,
    'Non-team text should pass through unchanged');
  console.log('  ✓ Non-team text in descriptions preserved');
}

// ═══════════════════════════════════════════════════════════
// TEST 6b: normalizeDescription — unmodeled-league sport gate
//   A bet declared in a league we don't model (KBO/KHL/NPB/…) must NOT have its
//   nicknames expanded: "Eagles"/"Lions" in a KBO slip are Hanwha Eagles /
//   Samsung Lions, not Philadelphia Eagles / Detroit Lions. Expanding splices a
//   real, wrong US team into the slip (incident 2026-06-11, ingest
//   disc_1514481735335805030). Modeled leagues + the no-sport call must be
//   byte-identical to the prior behavior.
// ═══════════════════════════════════════════════════════════
function testUnmodeledLeagueSportGate() {
  // Unmodeled leagues → raw passthrough (suppression).
  const suppress = [
    ['Hanwha Eagles +1.5', 'KBO'],
    ['Samsung Lions ML', 'KBO'],
    ['Samsung Lions ML', 'kbo'], // case-insensitive
    ['Hanwha Eagles +1.5 / SSG Landers +1.5 / Samsung Lions ML', 'KBO'], // live 3-leg repro
    ['Kings ML', 'KHL'],
    ['Giants -1.5', 'NPB'],
    ['Eagles ML', 'MLB/KBO'], // compound with an unmodeled part → suppress
  ];
  for (const [input, sport] of suppress) {
    const result = normalizeDescription(input, sport);
    assert.strictEqual(result, input,
      `normalizeDescription("${input}", "${sport}") must pass through unchanged but got "${result}"`);
  }

  // Modeled leagues → still expand exactly as before.
  assert.strictEqual(normalizeDescription('Eagles ML', 'NFL'), 'Philadelphia Eagles ML');
  assert.strictEqual(normalizeDescription('Lions -3.5', 'NFL'), 'Detroit Lions -3.5');
  assert.strictEqual(normalizeDescription('Cards ML', 'MLB'), 'St. Louis Cardinals ML');
  assert.strictEqual(normalizeDescription('Eagles ML', 'MLB/NHL'), 'Philadelphia Eagles ML');
  // Long-form modeled labels expand via whole-word league CODE match.
  assert.strictEqual(normalizeDescription('Lakers -3.5', 'NBA Basketball'), 'Los Angeles Lakers -3.5');
  // Generic / full league NAMES for a modeled league expand ("Baseball" is a real
  // stored sport — tests/s1b-measure-fixture.test.js). Bare "Football" is omitted
  // on purpose (soccer-ambiguous), and foreign-qualified names never match.
  assert.strictEqual(normalizeDescription('Cards ML', 'Baseball'), 'St. Louis Cardinals ML');
  assert.strictEqual(normalizeDescription('Oilers ML', 'Hockey'), 'Edmonton Oilers ML');
  assert.strictEqual(normalizeDescription('Cards ML', 'Major League Baseball'), 'St. Louis Cardinals ML');
  assert.strictEqual(normalizeDescription('Eagles ML', 'American Football'), 'Philadelphia Eagles ML');
  assert.strictEqual(normalizeDescription('Eagles ML', 'Football'), 'Eagles ML'); // soccer-ambiguous → suppress
  assert.strictEqual(normalizeDescription('Cards ML', 'Korean Baseball'), 'Cards ML'); // foreign → suppress

  // 'Unknown'/placeholder = NO league signal (detectSport's value for abbreviation/
  // slang/player-prop text) → must keep expanding, else the common LAL/GSW/Dubs
  // class silently loses canonicalization vs main.
  assert.strictEqual(normalizeDescription('LAL -3.5 vs GSW', 'Unknown'),
    'Los Angeles Lakers -3.5 vs Golden State Warriors');
  assert.strictEqual(normalizeDescription('Dubs ML', 'Unknown'), 'Golden State Warriors ML');
  assert.strictEqual(normalizeDescription('Cards ML', 'N/A'), 'St. Louis Cardinals ML');
  assert.strictEqual(normalizeDescription('Cards ML', 'Pending'), 'St. Louis Cardinals ML');

  // No declared sport → prior behavior preserved (expand). This is the shape
  // every existing caller (and TEST 5/6) uses, so the param is purely additive.
  assert.strictEqual(normalizeDescription('Eagles ML'), 'Philadelphia Eagles ML');
  assert.strictEqual(normalizeDescription('LAL -3.5 vs GSW'),
    'Los Angeles Lakers -3.5 vs Golden State Warriors');

  // Sponsor-prefix guard (sport-independent): a KBO-club nickname right after a
  // sponsor corporate name stays raw even when detectSport mislabels the sport as
  // a modeled US league on the bare-text path. Real US teams are unaffected.
  assert.strictEqual(normalizeDescription('Hanwha Eagles +1.5', 'NFL'), 'Hanwha Eagles +1.5');
  assert.strictEqual(normalizeDescription('Hanwha Eagles +1.5'), 'Hanwha Eagles +1.5');
  assert.strictEqual(normalizeDescription('Samsung Lions ML', 'NFL'), 'Samsung Lions ML');
  assert.strictEqual(normalizeDescription('KT Wiz ML'), 'KT Wiz ML');
  assert.strictEqual(normalizeDescription('Philadelphia Eagles ML', 'NFL'), 'Philadelphia Eagles ML');
  // Guard is SAME-LINE only — a bare sponsor ending a leg never guards the next line.
  assert.strictEqual(normalizeDescription('KT\nLions ML'), 'KT\nDetroit Lions ML');

  console.log('  ✓ Unmodeled-league slips skip expansion; Unknown/placeholder + modeled expand; sponsor-prefix guard holds');
}

// ═══════════════════════════════════════════════════════════
// TEST 7: Canonical names map to themselves
// ═══════════════════════════════════════════════════════════
function testCanonicalSelfMap() {
  const canonicals = [
    'Los Angeles Lakers',
    'Golden State Warriors',
    'Kansas City Chiefs',
    'New York Yankees',
    'Edmonton Oilers',
  ];
  for (const name of canonicals) {
    assert.strictEqual(normalizeTeam(name), name,
      `Canonical name "${name}" should map to itself`);
  }
  console.log('  ✓ Canonical names map to themselves');
}

// ═══════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════
console.log('Normalization validation:');
testNBATeamAliases();
testOtherLeagueAliases();
testAmbiguousAbbreviations();
testCaseInsensitivity();
testUnknownPassthrough();
testDescriptionNormalization();
testDescriptionPreservesOther();
testUnmodeledLeagueSportGate();
testCanonicalSelfMap();
console.log('Normalization validation passed.');
