const assert = require('assert');
const { normalizeTeam, normalizeDescription, normalizePlayer, reloadMappings } = require('../services/normalization');

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
    ['Chiefs', 'Kansas City Chiefs'],
    ['KC', 'Kansas City Chiefs'],
    ['49ers', 'San Francisco 49ers'],
    ['niners', 'San Francisco 49ers'],
    ['Yankees', 'New York Yankees'],
    ['NYY', 'New York Yankees'],
    ['Dodgers', 'Los Angeles Dodgers'],
    ['Oilers', 'Edmonton Oilers'],
    ['Avs', 'Colorado Avalanche'],
    ['Leafs', 'Toronto Maple Leafs'],
    ['Bruins', 'Boston Bruins'],
    ['Red Sox', 'Boston Red Sox'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizeTeam(input);
    assert.strictEqual(result, expected,
      `normalizeTeam("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ NFL, MLB, NHL aliases resolve to canonical names');
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
// TEST 7: normalizePlayer — basic cleanup
// ═══════════════════════════════════════════════════════════
function testPlayerNormalization() {
  assert.strictEqual(normalizePlayer('  LeBron  James  '), 'LeBron James');
  assert.strictEqual(normalizePlayer(''), '');
  assert.strictEqual(normalizePlayer(null), '');
  console.log('  ✓ Player names cleaned up correctly');
}

// ═══════════════════════════════════════════════════════════
// TEST 8: Canonical names map to themselves
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
testCaseInsensitivity();
testUnknownPassthrough();
testDescriptionNormalization();
testDescriptionPreservesOther();
testPlayerNormalization();
testCanonicalSelfMap();
console.log('Normalization validation passed.');
