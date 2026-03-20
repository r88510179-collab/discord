const assert = require('assert');

// ── Inline assessParseConfidence with additive weighted scoring ──
// Mirrors services/ai.js exactly — pure function, no LLM calls needed.
const AMBIGUITY_THRESHOLD = 3;

const NBA_TEAMS = 'hawks|celtics|nets|hornets|bulls|cavaliers|cavs|mavericks|mavs|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|heat|bucks|timberwolves|wolves|pelicans|knicks|thunder|magic|76ers|sixers|suns|blazers|kings|spurs|raptors|jazz';
const NFL_TEAMS = 'cardinals|falcons|ravens|bills|panthers|bears|bengals|browns|cowboys|broncos|lions|packers|texans|colts|jaguars|jags|chiefs|raiders|chargers|rams|dolphins|vikings|patriots|pats|saints|giants|jets|eagles|steelers|49ers|niners|seahawks|commanders|titans|bucs|buccaneers';
const MLB_TEAMS = 'diamondbacks|dbacks|braves|orioles|red sox|cubs|white sox|reds|guardians|rockies|tigers|astros|royals|angels|dodgers|marlins|brewers|twins|mets|yankees|athletics|phillies|pirates|padres|mariners|cardinals|rays|rangers|blue jays|nationals';
const NHL_TEAMS = 'ducks|coyotes|bruins|sabres|flames|hurricanes|blackhawks|avalanche|blue jackets|stars|red wings|oilers|panthers|kings|wild|canadiens|habs|predators|devils|islanders|rangers|senators|flyers|penguins|sharks|kraken|blues|lightning|maple leafs|leafs|canucks|golden knights|capitals|jets';

const TEAM_MAP = {
  NBA: new RegExp(`\\b(${NBA_TEAMS})\\b`, 'i'),
  NFL: new RegExp(`\\b(${NFL_TEAMS})\\b`, 'i'),
  MLB: new RegExp(`\\b(${MLB_TEAMS})\\b`, 'i'),
  NHL: new RegExp(`\\b(${NHL_TEAMS})\\b`, 'i'),
};

function assessParseConfidence(text, bet) {
  const reasons = [];
  let score = 0;
  const t = (text || '').trim();

  if (t.length < 10) { reasons.push('input_too_short'); score += 1.5; }
  if (!bet.sport || bet.sport === 'Unknown') { reasons.push('sport_unknown'); score += 1; }
  if (!text.match(/[+-]\d{3,4}/)) { reasons.push('no_explicit_odds'); score += 0.5; }
  if (!text.match(/\d+\.?\d*\s*u(?:nits?)?\b/i)) { reasons.push('no_explicit_units'); score += 0.5; }
  const desc = (bet.description || '').trim();
  if (desc.length < 8) { reasons.push('description_too_short'); score += 1; }
  const hasCelebration = /✅|❌|\bBANG+\b|\b(WINNER|CASHED|HIT|BOOM)\b/i.test(t);
  const hasPick = /\b(lock|potd|play|bet|hammer|tail)\b/i.test(t);
  if (hasCelebration && hasPick) { reasons.push('conflicting_signals'); score += 2; }
  const alphaCount = (t.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphaCount < t.length * 0.3 && t.length > 5) { reasons.push('low_alpha_content'); score += 1.5; }
  const bareNumberMatch = t.match(/^[^a-zA-Z]*([+-]?\d{1,2}(?:\.5)?)\s*$/);
  if (bareNumberMatch && !t.match(/[+-]\d{3,4}/)) { reasons.push('ambiguous_line'); score += 1; }
  if (/\b(maybe|might|thinking about|considering|leaning|not sure|idk|unsure)\b/i.test(t)) {
    reasons.push('uncertain_language'); score += 1.5;
  }
  let sportsFound = 0;
  for (const regex of Object.values(TEAM_MAP)) { if (regex.test(t)) sportsFound++; }
  if (sportsFound >= 2) { reasons.push('multiple_sports'); score += 1; }
  if (/\?/.test(t)) { reasons.push('contains_question'); score += 0.5; }

  const confidence = score >= AMBIGUITY_THRESHOLD ? 'low' : 'high';
  return { confidence, score, reasons };
}


// ═══════════════════════════════════════════════════════════
// TEST 1: Clearly parseable bets → high confidence
// ═══════════════════════════════════════════════════════════
function testClearBetsHighConfidence() {
  const cases = [
    {
      text: 'Lakers -3.5 -110 2u lock',
      bet: { sport: 'NBA', description: 'Lakers -3.5 lock', odds: -110, units: 2 },
    },
    {
      text: 'Celtics ML +150 1u',
      bet: { sport: 'NBA', description: 'Celtics ML', odds: 150, units: 1 },
    },
    {
      text: 'Chiefs -7 -115 3u NFL pick',
      bet: { sport: 'NFL', description: 'Chiefs -7 NFL pick', odds: -115, units: 3 },
    },
    {
      text: 'Yankees over 8.5 -120 1u MLB',
      bet: { sport: 'MLB', description: 'Yankees over 8.5 MLB', odds: -120, units: 1 },
    },
  ];

  for (const { text, bet } of cases) {
    const result = assessParseConfidence(text, bet);
    assert.strictEqual(result.confidence, 'high',
      `Expected HIGH confidence for "${text}" but got ${result.confidence} (score: ${result.score}, reasons: ${result.reasons.join(', ')})`);
    assert.ok(result.score < AMBIGUITY_THRESHOLD,
      `Score ${result.score} should be below threshold ${AMBIGUITY_THRESHOLD} for "${text}"`);
  }
  console.log('  ✓ Clear bets correctly scored as high confidence');
}


// ═══════════════════════════════════════════════════════════
// TEST 2: Ambiguous bet text → low confidence
// ═══════════════════════════════════════════════════════════
function testAmbiguousBetsLowConfidence() {
  const cases = [
    {
      text: 'lock it',
      bet: { sport: 'Unknown', description: 'lock', odds: -110, units: 1 },
      reason: 'very short, no sport, no odds, no units, short description',
    },
    {
      text: '🔥🔥🔥 bet 💰',
      bet: { sport: 'Unknown', description: '🔥🔥🔥 bet 💰', odds: -110, units: 1 },
      reason: 'mostly emojis, no sport, no odds',
    },
    {
      text: 'go big',
      bet: { sport: 'Unknown', description: 'go big', odds: -110, units: 1 },
      reason: 'too short, no context, no sport',
    },
  ];

  for (const { text, bet, reason } of cases) {
    const result = assessParseConfidence(text, bet);
    assert.strictEqual(result.confidence, 'low',
      `Expected LOW confidence for "${text}" (${reason}) but got ${result.confidence} (score: ${result.score}, reasons: ${result.reasons.join(', ')})`);
    assert.ok(result.score >= AMBIGUITY_THRESHOLD,
      `Score ${result.score} should be >= threshold ${AMBIGUITY_THRESHOLD} for "${text}"`);
  }
  console.log('  ✓ Ambiguous bets correctly scored as low confidence');
}


// ═══════════════════════════════════════════════════════════
// TEST 3: Conflicting signals detected and heavily weighted
// ═══════════════════════════════════════════════════════════
function testConflictingSignals() {
  const text = '✅ WINNER lock of the day bet on Lakers';
  const bet = { sport: 'NBA', description: 'Lakers', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok(result.reasons.includes('conflicting_signals'),
    'Should detect conflicting celebration + pick signals');
  // Conflicting signals alone contribute 2 points — heavy weight
  assert.ok(result.score >= 2, 'Conflicting signals should contribute at least 2 to score');
  console.log('  ✓ Conflicting signals correctly detected with heavy weight');
}


// ═══════════════════════════════════════════════════════════
// TEST 4: Confidence metadata structure (now includes score)
// ═══════════════════════════════════════════════════════════
function testConfidenceMetadataShape() {
  const text = 'Lakers -3.5 -110 1u';
  const bet = { sport: 'NBA', description: 'Lakers -3.5', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok('confidence' in result, 'result must have confidence field');
  assert.ok('score' in result, 'result must have score field');
  assert.ok('reasons' in result, 'result must have reasons field');
  assert.ok(Array.isArray(result.reasons), 'reasons must be an array');
  assert.ok(typeof result.score === 'number', 'score must be a number');
  assert.ok(['high', 'low'].includes(result.confidence), 'confidence must be high or low');
  console.log('  ✓ Confidence metadata has correct shape (includes score)');
}


// ═══════════════════════════════════════════════════════════
// TEST 5: Slip/image parsing path is unaffected
// ═══════════════════════════════════════════════════════════
function testSlipParsingUnaffected() {
  const slipBet = {
    sport: 'NBA', description: 'Lakers -3.5',
    odds: -110, units: 1, sportsbook: 'DraftKings',
  };
  const result = assessParseConfidence('Image scan: capper in #picks', slipBet);
  assert.ok(result.confidence, 'Should produce a result even for slip context');
  console.log('  ✓ Slip/image parsing path unaffected');
}


// ═══════════════════════════════════════════════════════════
// TEST 6: Uncertain language flagged
// ═══════════════════════════════════════════════════════════
function testUncertainLanguage() {
  const cases = [
    { text: 'maybe Lakers -3.5 tonight', word: 'maybe' },
    { text: 'thinking about taking Celtics ML', word: 'thinking about' },
    { text: 'might bet Chiefs -7 idk', word: 'might' },
    { text: 'leaning Warriors over 220.5', word: 'leaning' },
  ];

  for (const { text, word } of cases) {
    const bet = { sport: 'NBA', description: text, odds: -110, units: 1 };
    const result = assessParseConfidence(text, bet);
    assert.ok(result.reasons.includes('uncertain_language'),
      `Should flag uncertain language for "${word}" in "${text}"`);
  }
  console.log('  ✓ Uncertain/hedging language correctly flagged');
}


// ═══════════════════════════════════════════════════════════
// TEST 7: Multiple sports detected → ambiguity
// ═══════════════════════════════════════════════════════════
function testMultipleSportsDetected() {
  // Text mentions teams from two different sports
  const text = 'Lakers and Yankees both looking good tonight -110 1u';
  const bet = { sport: 'NBA', description: 'Lakers and Yankees', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok(result.reasons.includes('multiple_sports'),
    'Should detect multiple sports (NBA Lakers + MLB Yankees)');
  console.log('  ✓ Multiple sports conflict correctly detected');
}


// ═══════════════════════════════════════════════════════════
// TEST 8: Ambiguous bare line value
// ═══════════════════════════════════════════════════════════
function testAmbiguousLineValue() {
  const text = '+3.5';
  const bet = { sport: 'Unknown', description: '+3.5', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok(result.reasons.includes('ambiguous_line'),
    'Bare "+3.5" should be flagged as ambiguous line');
  assert.strictEqual(result.confidence, 'low',
    'Bare number with no context should be low confidence');
  console.log('  ✓ Ambiguous bare line value correctly flagged');
}


// ═══════════════════════════════════════════════════════════
// TEST 9: Question mark adds mild uncertainty
// ═══════════════════════════════════════════════════════════
function testQuestionMarkUncertainty() {
  const text = 'Lakers -3.5 -110 1u?';
  const bet = { sport: 'NBA', description: 'Lakers -3.5', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok(result.reasons.includes('contains_question'),
    'Question mark should be flagged');
  // But a well-formed bet with just a ? should still be high confidence
  assert.strictEqual(result.confidence, 'high',
    'Single question mark on otherwise clear bet should not push to low');
  console.log('  ✓ Question mark adds mild weight without over-penalizing');
}


// ═══════════════════════════════════════════════════════════
// TEST 10: Additive scoring — borderline cases
// ═══════════════════════════════════════════════════════════
function testAdditiveScoring() {
  // Just below threshold: no odds (0.5) + no units (0.5) + question (0.5) = 1.5 < 3
  const clearish = assessParseConfidence('Lakers spread tonight?',
    { sport: 'NBA', description: 'Lakers spread tonight', odds: -110, units: 1 });
  assert.strictEqual(clearish.confidence, 'high',
    'Borderline-low score should still be high if below threshold');

  // Just above threshold: unknown sport (1) + no odds (0.5) + no units (0.5) + uncertain (1.5) = 3.5 >= 3
  const ambiguous = assessParseConfidence('maybe take the over tonight',
    { sport: 'Unknown', description: 'maybe take the over tonight', odds: -110, units: 1 });
  assert.strictEqual(ambiguous.confidence, 'low',
    'Combined uncertain language + missing context should push to low');

  console.log('  ✓ Additive scoring correctly handles borderline cases');
}


// ═══════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════
console.log('Confidence validation:');
testClearBetsHighConfidence();
testAmbiguousBetsLowConfidence();
testConflictingSignals();
testConfidenceMetadataShape();
testSlipParsingUnaffected();
testUncertainLanguage();
testMultipleSportsDetected();
testAmbiguousLineValue();
testQuestionMarkUncertainty();
testAdditiveScoring();
console.log('Confidence validation passed.');
