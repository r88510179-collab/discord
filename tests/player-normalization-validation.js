const assert = require('assert');
const { normalizePlayer, normalizeDescription, reloadMappings } = require('../services/normalization');

reloadMappings();

// ═══════════════════════════════════════════════════════════
// TEST 1: NBA player aliases
// ═══════════════════════════════════════════════════════════
function testNBAPlayerAliases() {
  const cases = [
    ['LeBron', 'LeBron James'],
    ['LBJ', 'LeBron James'],
    ['Steph', 'Stephen Curry'],
    ['KD', 'Kevin Durant'],
    ['Giannis', 'Giannis Antetokounmpo'],
    ['Jokic', 'Nikola Jokic'],
    ['Luka', 'Luka Doncic'],
    ['Wemby', 'Victor Wembanyama'],
    ['SGA', 'Shai Gilgeous-Alexander'],
    ['Shai', 'Shai Gilgeous-Alexander'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizePlayer(input);
    assert.strictEqual(result, expected,
      `normalizePlayer("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ NBA player aliases resolve correctly (including SGA)');
}

// ═══════════════════════════════════════════════════════════
// TEST 2: NFL + MLB player aliases
// ═══════════════════════════════════════════════════════════
function testNFLMLBPlayerAliases() {
  const cases = [
    ['Mahomes', 'Patrick Mahomes'],
    ['CMC', 'Christian McCaffrey'],
    ['Tyreek', 'Tyreek Hill'],
    ['Lamar', 'Lamar Jackson'],
    ['Stroud', 'C.J. Stroud'],
    ['Ohtani', 'Shohei Ohtani'],
    ['Judge', 'Aaron Judge'],
    ['Skenes', 'Paul Skenes'],
    ['Elly', 'Elly De La Cruz'],
  ];

  for (const [input, expected] of cases) {
    const result = normalizePlayer(input);
    assert.strictEqual(result, expected,
      `normalizePlayer("${input}") should return "${expected}" but got "${result}"`);
  }
  console.log('  ✓ NFL and MLB player aliases resolve correctly');
}

// ═══════════════════════════════════════════════════════════
// TEST 3: "The Alien" -> Victor Wembanyama
// ═══════════════════════════════════════════════════════════
function testTheAlienAlias() {
  assert.strictEqual(normalizePlayer('The Alien'), 'Victor Wembanyama');
  assert.strictEqual(normalizePlayer('the alien'), 'Victor Wembanyama');
  console.log('  ✓ "The Alien" resolves to Victor Wembanyama');
}

// ═══════════════════════════════════════════════════════════
// TEST 4: "SGA" -> Shai Gilgeous-Alexander
// ═══════════════════════════════════════════════════════════
function testSGAAlias() {
  assert.strictEqual(normalizePlayer('SGA'), 'Shai Gilgeous-Alexander');
  assert.strictEqual(normalizePlayer('sga'), 'Shai Gilgeous-Alexander');
  assert.strictEqual(normalizePlayer('Shai'), 'Shai Gilgeous-Alexander');
  console.log('  ✓ "SGA" resolves to Shai Gilgeous-Alexander');
}

// ═══════════════════════════════════════════════════════════
// TEST 5: Punctuation normalization (C.J. vs CJ)
// ═══════════════════════════════════════════════════════════
function testPunctuationNormalization() {
  assert.strictEqual(normalizePlayer('C.J. Stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('CJ Stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('c.j. stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('cj stroud'), 'C.J. Stroud');
  console.log('  ✓ Punctuation variants (C.J. vs CJ) both resolve');
}

// ═══════════════════════════════════════════════════════════
// TEST 6: Player description inline replacement via normalizeDescription
// ═══════════════════════════════════════════════════════════
function testPlayerDescriptionInline() {
  assert.strictEqual(
    normalizeDescription('SGA over 30 points'),
    'Shai Gilgeous-Alexander over 30 points'
  );
  assert.strictEqual(
    normalizeDescription('LeBron over 25 points'),
    'LeBron James over 25 points'
  );
  assert.strictEqual(
    normalizeDescription('Skenes 8+ strikeouts'),
    'Paul Skenes 8+ strikeouts'
  );
  assert.strictEqual(
    normalizeDescription('Stroud 250+ passing yards'),
    'C.J. Stroud 250+ passing yards'
  );
  console.log('  ✓ Player aliases replaced inline in bet descriptions');
}

// ═══════════════════════════════════════════════════════════
// TEST 7: Canonical names map to themselves
// ═══════════════════════════════════════════════════════════
function testCanonicalPlayerSelfMap() {
  const canonicals = [
    'LeBron James',
    'Shai Gilgeous-Alexander',
    'C.J. Stroud',
    'Paul Skenes',
    'Elly De La Cruz',
    'Victor Wembanyama',
  ];
  for (const name of canonicals) {
    assert.strictEqual(normalizePlayer(name), name,
      `Canonical name "${name}" should map to itself`);
  }
  console.log('  ✓ Canonical player names map to themselves');
}

// ═══════════════════════════════════════════════════════════
// TEST 8: Unknown players pass through
// ═══════════════════════════════════════════════════════════
function testUnknownPlayerPassthrough() {
  assert.strictEqual(normalizePlayer('Random Rookie'), 'Random Rookie');
  assert.strictEqual(normalizePlayer(''), '');
  assert.strictEqual(normalizePlayer(null), '');
  console.log('  ✓ Unknown player names pass through unchanged');
}

// ═══════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════
console.log('Player normalization validation:');
testNBAPlayerAliases();
testNFLMLBPlayerAliases();
testTheAlienAlias();
testSGAAlias();
testPunctuationNormalization();
testPlayerDescriptionInline();
testCanonicalPlayerSelfMap();
testUnknownPlayerPassthrough();
console.log('Player normalization validation passed.');
