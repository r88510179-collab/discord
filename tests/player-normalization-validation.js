const assert = require('assert');
const { normalizePlayer, normalizePlayerDescription, reloadMappings } = require('../services/normalization');

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
// TEST 3: Ambiguous cross-sport aliases pass through
// ═══════════════════════════════════════════════════════════
function testAmbiguousPlayerAliases() {
  // "The Alien" is used for both Wembanyama (NBA) and De La Cruz (MLB)
  const result = normalizePlayer('The Alien');
  assert.strictEqual(result, 'The Alien',
    `Ambiguous alias "The Alien" should pass through but got "${result}"`);
  console.log('  ✓ Ambiguous player aliases (The Alien) pass through safely');
}

// ═══════════════════════════════════════════════════════════
// TEST 4: Punctuation normalization (C.J. vs CJ)
// ═══════════════════════════════════════════════════════════
function testPunctuationNormalization() {
  // Both "C.J. Stroud" and "CJ Stroud" should resolve
  assert.strictEqual(normalizePlayer('C.J. Stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('CJ Stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('c.j. stroud'), 'C.J. Stroud');
  assert.strictEqual(normalizePlayer('cj stroud'), 'C.J. Stroud');
  console.log('  ✓ Punctuation variants (C.J. vs CJ) both resolve');
}

// ═══════════════════════════════════════════════════════════
// TEST 5: Player description inline replacement
// ═══════════════════════════════════════════════════════════
function testPlayerDescriptionInline() {
  assert.strictEqual(
    normalizePlayerDescription('SGA over 30 points'),
    'Shai Gilgeous-Alexander over 30 points'
  );
  assert.strictEqual(
    normalizePlayerDescription('LeBron over 25 points'),
    'LeBron James over 25 points'
  );
  assert.strictEqual(
    normalizePlayerDescription('Skenes 8+ strikeouts'),
    'Paul Skenes 8+ strikeouts'
  );
  assert.strictEqual(
    normalizePlayerDescription('Stroud 250+ passing yards'),
    'C.J. Stroud 250+ passing yards'
  );
  console.log('  ✓ Player aliases replaced inline in bet descriptions');
}

// ═══════════════════════════════════════════════════════════
// TEST 6: Canonical names map to themselves
// ═══════════════════════════════════════════════════════════
function testCanonicalPlayerSelfMap() {
  const canonicals = [
    'LeBron James',
    'Shai Gilgeous-Alexander',
    'C.J. Stroud',
    'Paul Skenes',
    'Elly De La Cruz',
  ];
  for (const name of canonicals) {
    assert.strictEqual(normalizePlayer(name), name,
      `Canonical name "${name}" should map to itself`);
  }
  console.log('  ✓ Canonical player names map to themselves');
}

// ═══════════════════════════════════════════════════════════
// TEST 7: Unknown players pass through
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
testAmbiguousPlayerAliases();
testPunctuationNormalization();
testPlayerDescriptionInline();
testCanonicalPlayerSelfMap();
testUnknownPlayerPassthrough();
console.log('Player normalization validation passed.');
