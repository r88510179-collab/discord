// Disposable unit-check for services/replayHolds.js#guessDisposition.
// No Discord / DB calls — pure function over fixed strings.
//   node scripts/test-replay-heuristic.js
// Exits non-zero if any case misclassifies.

const { guessDisposition } = require('../services/replayHolds');

// Each case asserts a substring the hint MUST contain, per the function spec.
const cases = [
  { label: 'recap',     text: 'Both legs cashed yesterday — great night last night!', expect: 'recap' },
  { label: 'promo',     text: 'Join the Bank Builder, profit boost on FanDuel today', expect: 'promo' },
  { label: 'sweat',     text: "Let's go boys, just needed for this to cash now", expect: 'sweat' },
  { label: 'empty',     text: '', expect: 'Image-only' },
  { label: 'real-pick', text: 'Lakers -4.5 -110, 2 units', expect: 'likely a pick' },
];

let failures = 0;
for (const c of cases) {
  const { hint, color } = guessDisposition(c.text);
  const ok = hint.includes(c.expect);
  if (!ok) failures++;
  const colorHex = '0x' + color.toString(16).toUpperCase();
  console.log(`${ok ? 'PASS' : 'FAIL'} [${c.label.padEnd(10)}] color=${colorHex} hint="${hint}"`);
  if (!ok) console.log(`        expected hint to contain "${c.expect}"`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
