// ═══════════════════════════════════════════════════════════
// Bouncer Rejection Tests — settled check runs BEFORE structure check.
// Imports the production evaluateTweet from services/ai so tests
// catch any drift between source and tests.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { evaluateTweet } = require('../services/ai');

// ── SETTLED BETS (must reject) ──
console.log('Test 1: Settled bets...');
const settledCases = [
  ['1-0 ON UCL.\n\nDiaz Goal or Assist (-105) 4u ✅\n\nWhop.com/bobbylocks', 'Bobby Diaz'],
  ['STOP PLAYING WITH ME.\n\nHarry Kane Goal (-110) 4u ✅', 'Bobby Kane'],
  ['BAANGGGG\n\nLakers ML +145 5u ✅\nNuggets +3.5 -110 3u ✅', 'Multi settled'],
  ['CASHED IT!\n\nDodgers -1.5 (-120) 3u ✅', 'Cashed header'],
  ['What a night!\n\nCeltics ML -150 ✅\nHeat +5.5 -110 ✅', 'What a night header'],
  ['Easy W!\n\nJokic Over 28.5 Pts -115 2u ✅', 'Easy W header'],
  // Bobby tweet with emoji preserved (per prompt example)
  ['WAY TOO EASY.\n\nArthur Fils S1 ML (-165) 12u ✅🔨\n\n5 likes for more', 'Bobby Fils (with emoji)'],
  ['1-0 ON UCL.\n\nDiaz Goal or Assist (-105) 4u ✅', 'Score header'],
  ['STOP PLAYING WITH ME.\n\nHarry Kane Goal (-110) 4u ✅', 'Stop playing'],
  ['BAANGGGG\n\nLakers ML +145 5u ✅\nNuggets +3.5 -110 3u ✅', 'Bang multi'],
  ['TRUST ME.\n\nRuud S2 ML (-185) 5u ✅', 'Trust me header + settled'],
  // Strong-header alone — emoji stripped by scraper but text unambiguously retrospective
  ['WAY TOO EASY.\n\nArthur Fils S1 ML (-165) 12u \n\n5 likes for more', 'Bobby Fils (emoji stripped)'],
  ['CASHED IT.\n\nDodgers -1.5 (-120) 3u', 'Cashed header, no marker'],
  ['STOP PLAYING WITH ME.\n\nHarry Kane Goal (-110) 4u', 'Stop playing, no marker'],
  // Word-form settled markers (won/lost/push/cashed)
  ['Lakers ML -150 5u won me $750 last night', 'Word-form: won'],
  ['Celtics -7 -110 3u lost a heartbreaker', 'Word-form: lost'],
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
  ['BANG lets go! Ohtani over 8.5 Ks -120 2u', 'Celebration + pick (no marker)'],
  ['Arthur Fils S1 ML (-165) 12u', 'Plain pick'],
  ['Tonight: Lakers ML -150 3u, Celtics -7 -110 2u', 'Inline multi'],
  ['LFG\n\nKentucky -7 (-110) 5u', 'LFG header alone'],
  ['HUGE W coming\n\nLakers ML -150 5u', 'Huge W header alone'],
  ['TRUST ME\n\nRuud S2 ML (-185) 5u', 'Trust me alone (ambiguous → valid)'],
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

// ── False-positive guards on word-form SETTLED_MARKERS ──
console.log('Test 5: Word-form false-positive guards...');
{
  // "won't" must NOT count as a settled marker
  const wontCase = evaluateTweet("Lakers ML -150 5u won't be close tonight");
  assert.strictEqual(wontCase, 'valid', `"won't" should not match \\bwon\\b: got ${wontCase}`);
  console.log('  PASS: "won\'t" did not match settled marker');
}

console.log('\n✅ All bouncer tests passed!');
