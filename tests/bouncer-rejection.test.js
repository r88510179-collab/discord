// ═══════════════════════════════════════════════════════════
// Bouncer Rejection Tests — settled check runs BEFORE structure check
// ═══════════════════════════════════════════════════════════

const assert = require('assert');

const STRUCTURE = [
  /[+-]\d{3,}/, /\b\d+\.?\d*\s*u\b/i, /\b\d+\s*units?\b/i,
  /\b(over|under|o|u)\s*\d+\.?\d*/i, /[+-]\d+\.?\d*\s*\(/,
  /\b\w+\s+(ml|moneyline)\b/i, /\b(parlay|sgp|same game|nrfi|yrfi)\b/i,
  /\(\s*[+-]\d{3,}\s*\)/, /\b[A-Z][a-z]+\s+[+-]\d+\.?\d*/, /\bML\s*[+-]\d+/i, /\d+\.5\b/,
];
const SETTLED_MARKERS = /✅|❌|⚪|✔|✓|☑/;
const WIN_HEADERS = [
  /^\d+-\d+\s+(ON|on)\s+\w+/, /^STOP\s+PLAYING/i, /^BAANGG+/i,
  /^CASH(ED)?\b/i, /^WHAT\s+A\s+(NIGHT|DAY|WIN)/i, /^EASY\s+(W|MONEY|WIN)/i,
  /^BOOM+/i, /\d+\s+(for|of)\s+\d+\s+(today|tonight|yesterday)/i,
];

function evaluateTweet(text) {
  const lines = text.split(/[\n]+/).map(l => l.trim()).filter(l => l.length > 0);
  const bettingLines = lines.filter(l => STRUCTURE.some(p => p.test(l)));
  const settledLines = bettingLines.filter(l => SETTLED_MARKERS.test(l));

  if (bettingLines.length > 0 && settledLines.length === bettingLines.length) return 'reject_settled';

  const firstLine = lines[0] || '';
  const hasWinHeader = WIN_HEADERS.some(p => p.test(firstLine));
  if (hasWinHeader && settledLines.length > 0) return 'reject_settled';

  if (bettingLines.length > 0) return 'valid';
  return 'reject_recap';
}

// ── SETTLED BETS (must reject) ──
console.log('Test 1: Settled bets...');
const settledCases = [
  ['1-0 ON UCL.\n\nDiaz Goal or Assist (-105) 4u ✅\n\nWhop.com/bobbylocks', 'Bobby Diaz'],
  ['STOP PLAYING WITH ME.\n\nHarry Kane Goal (-110) 4u ✅', 'Bobby Kane'],
  ['BAANGGGG\n\nLakers ML +145 5u ✅\nNuggets +3.5 -110 3u ✅', 'Multi settled'],
  ['CASHED IT!\n\nDodgers -1.5 (-120) 3u ✅', 'Cashed header'],
  ['What a night!\n\nCeltics ML -150 ✅\nHeat +5.5 -110 ✅', 'What a night header'],
  ['Easy W!\n\nJokic Over 28.5 Pts -115 2u ✅', 'Easy W header'],
];
for (const [text, label] of settledCases) {
  const result = evaluateTweet(text);
  assert.strictEqual(result, 'reject_settled', `Should REJECT SETTLED [${label}]: got ${result}`);
}
console.log(`  PASS: All ${settledCases.length} settled bets rejected`);

// ── NEW PICKS (must accept) ──
console.log('Test 2: New picks...');
const validCases = [
  ['NBA LIVE LOCK.\n\nNuggets -3.5 (-105) 5u', 'Standard pick'],
  ['Tonight: Lakers ML -150 3u, Celtics -7 -110 2u', 'Multi picks inline'],
  ['+1009 NRFI Parlay ready to go', 'NRFI parlay'],
  ['Dinger Tuesday +5097 odds parlay', 'Dinger parlay'],
  ['BANG lets go! Ohtani over 8.5 Ks -120 2u', 'Celebration + pick (no ✅)'],
];
for (const [text, label] of validCases) {
  const result = evaluateTweet(text);
  assert.strictEqual(result, 'valid', `Should be VALID [${label}]: got ${result}`);
}
console.log(`  PASS: All ${validCases.length} new picks accepted`);

// ── MIXED (some settled, some new — must accept) ──
console.log('Test 3: Mixed settled/new...');
{
  const mixed = evaluateTweet('Recap so far:\nLakers ML -150 ✅\nCeltics -7 -110');
  assert.strictEqual(mixed, 'valid', `Mixed should be VALID: got ${mixed}`);
  console.log('  PASS: Mixed tweet accepted');
}

// ── PURE RECAPS (no structure — must reject) ──
console.log('Test 4: Pure recaps...');
const recapCases = [
  'Nice W on Jalen Green!',
  '20/27 Pick of the Days in March',
  'Happy Dinger Tuesday everybody!',
];
for (const text of recapCases) {
  assert.strictEqual(evaluateTweet(text), 'reject_recap', `Should reject recap: "${text.slice(0, 30)}"`);
}
console.log(`  PASS: All ${recapCases.length} pure recaps rejected`);

console.log('\n✅ All bouncer tests passed!');
