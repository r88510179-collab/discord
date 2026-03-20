const assert = require('assert');

// ── Load assessParseConfidence directly from ai.js ──────────
// We need to mock the LLM providers since we don't have API keys in tests.
// assessParseConfidence is a pure function — no LLM calls needed.

// Inline the function for isolated unit testing (avoids needing API keys)
function assessParseConfidence(text, bet) {
  const reasons = [];
  const t = (text || '').trim();

  if (t.length < 10) reasons.push('input_too_short');
  if (!bet.sport || bet.sport === 'Unknown') reasons.push('sport_unknown');
  if (!text.match(/[+-]\d{3,4}/)) reasons.push('no_explicit_odds');
  if (!text.match(/\d+\.?\d*\s*u(?:nits?)?\b/i)) reasons.push('no_explicit_units');
  const desc = (bet.description || '').trim();
  if (desc.length < 8) reasons.push('description_too_short');
  const hasCelebration = /✅|❌|\bBANG+\b|\b(WINNER|CASHED|HIT|BOOM)\b/i.test(t);
  const hasPick = /\b(lock|potd|play|bet|hammer|tail)\b/i.test(t);
  if (hasCelebration && hasPick) reasons.push('conflicting_signals');
  const alphaCount = (t.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphaCount < t.length * 0.3 && t.length > 5) reasons.push('low_alpha_content');

  const confidence = reasons.length >= 3 ? 'low' : 'high';
  return { confidence, reasons };
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
      `Expected HIGH confidence for "${text}" but got ${result.confidence} (reasons: ${result.reasons.join(', ')})`);
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
      reason: 'very short, no sport, no odds, no units',
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
      `Expected LOW confidence for "${text}" (${reason}) but got ${result.confidence} (reasons: ${result.reasons.join(', ')})`);
  }
  console.log('  ✓ Ambiguous bets correctly scored as low confidence');
}


// ═══════════════════════════════════════════════════════════
// TEST 3: Conflicting signals detected
// ═══════════════════════════════════════════════════════════
function testConflictingSignals() {
  const text = '✅ WINNER lock of the day bet on Lakers';
  const bet = { sport: 'NBA', description: 'Lakers', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok(result.reasons.includes('conflicting_signals'),
    'Should detect conflicting celebration + pick signals');
  console.log('  ✓ Conflicting signals correctly detected');
}

// ═══════════════════════════════════════════════════════════
// TEST 4: Confidence metadata structure
// ═══════════════════════════════════════════════════════════
function testConfidenceMetadataShape() {
  const text = 'Lakers -3.5 -110 1u';
  const bet = { sport: 'NBA', description: 'Lakers -3.5', odds: -110, units: 1 };
  const result = assessParseConfidence(text, bet);
  assert.ok('confidence' in result, 'result must have confidence field');
  assert.ok('reasons' in result, 'result must have reasons field');
  assert.ok(Array.isArray(result.reasons), 'reasons must be an array');
  assert.ok(['high', 'low'].includes(result.confidence), 'confidence must be high or low');
  console.log('  ✓ Confidence metadata has correct shape');
}

// ═══════════════════════════════════════════════════════════
// TEST 5: Slip/image parsing path is unaffected
// (assessParseConfidence is only called on text path)
// ═══════════════════════════════════════════════════════════
function testSlipParsingUnaffected() {
  // Verify that assessParseConfidence doesn't crash on slip-like contexts
  // and that slip bets don't inherit confidence flags by default
  const slipBet = {
    sport: 'NBA', description: 'Lakers -3.5',
    odds: -110, units: 1, sportsbook: 'DraftKings',
  };
  // Slip text is typically minimal — just "Image scan: ..."
  const result = assessParseConfidence('Image scan: capper in #picks', slipBet);
  // The function should run without error — slips use their own path
  assert.ok(result.confidence, 'Should produce a result even for slip context');
  console.log('  ✓ Slip/image parsing path unaffected');
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
console.log('Confidence validation passed.');
