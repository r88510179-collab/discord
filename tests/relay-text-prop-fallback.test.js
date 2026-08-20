'use strict';

const assert = require('assert');
const {
  parseBetText,
  parseRelayTextPropCandidate,
  shouldUseRelayTextPropFallback,
  regexParseBet,
} = require('../services/ai');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function onlyBet(text) {
  const parsed = parseRelayTextPropCandidate(text);
  assert.ok(parsed, `expected candidate for: ${text}`);
  assert.strictEqual(parsed.type, 'bet');
  assert.strictEqual(parsed.is_bet, true);
  assert.strictEqual(parsed.ticket_status, 'new');
  assert.strictEqual(parsed.bets.length, 1);
  return parsed.bets[0];
}

console.log('relay-text player-prop candidate extraction');

test('emoji NBA header + compact O-line extracts a clean PR bet', () => {
  const bet = onlyBet('🏀 NBA Best Bet\n🟠 OG Anunoby O20.5 PRs');
  assert.strictEqual(bet.sport, 'NBA');
  assert.strictEqual(bet.description, 'OG Anunoby Over 20.5 PTS + REB');
  assert.strictEqual(bet.odds, null);
  assert.strictEqual(bet.units, 1);
  assert.deepStrictEqual(bet.legs, [{
    description: 'OG Anunoby Over 20.5 PTS + REB',
    odds: null,
    team: 'OG Anunoby',
    line: 'Over 20.5',
    type: 'prop',
  }]);
  assert.deepStrictEqual(bet.props, [{
    player_name: 'OG Anunoby',
    stat_category: 'points_rebounds',
    line: 20.5,
    direction: 'over',
    odds: null,
  }]);
});

test('commentary header + Over line extracts the actionable line only', () => {
  const bet = onlyBet("🏀 Here's my favorite NBA straight tonight…\n🗡️ Evan Mobley Over 27.5 PRAs");
  assert.strictEqual(bet.description, 'Evan Mobley Over 27.5 PRA');
  assert.strictEqual(bet.props[0].stat_category, 'points_rebounds_assists');
});

test('Pick of the Day wrapper does not pollute player or description', () => {
  const bet = onlyBet('🏀 NBA Pick of the Day…\n👉🏼 Karl-Anthony Towns o10.5 Rebounds');
  assert.strictEqual(bet.description, 'Karl-Anthony Towns Over 10.5 Rebounds');
  assert.strictEqual(bet.legs[0].team, 'Karl-Anthony Towns');
});

test('apostrophized PRA alias is canonicalized', () => {
  const bet = onlyBet("🏀 NBA Pick of the Day…\nDylan Harper o19.5 PRA's");
  assert.strictEqual(bet.description, 'Dylan Harper Over 19.5 PRA');
  assert.strictEqual(bet.props[0].stat_category, 'points_rebounds_assists');
});

test('single-token nickname is accepted when the sport header is explicit', () => {
  const bet = onlyBet('🏀 NBA Pick of the Day…\n👉🏼 iHart Over 8.5 Rebounds');
  assert.strictEqual(bet.description, 'iHart Over 8.5 Rebounds');
});

test('spaced slash relay format and explicit price/units are preserved', () => {
  const bet = onlyBet('🏀 NBA Best Bet / 🟠 OG Anunoby O20.5 PRs (-115) 2u');
  assert.strictEqual(bet.odds, -115);
  assert.strictEqual(bet.units, 2);
  assert.strictEqual(bet.legs[0].odds, -115);
});

test('twitter vision wrapper can use the original relay text source', () => {
  const wrapped = 'Tweet from @Harry: "🏀 NBA Pick of the Day…\n👉🏼 iHart Over 8.5 Rebounds"\n\nRead the attached betting slip image.';
  const bet = onlyBet(wrapped);
  assert.strictEqual(bet.description, 'iHart Over 8.5 Rebounds');
});

test('regex fast path uses the clean deterministic candidate', () => {
  const raw = '🏀 NBA Best Bet\n🟠 OG Anunoby O20.5 PRs';
  const parsed = regexParseBet(raw);
  assert.ok(parsed);
  assert.strictEqual(parsed.bets[0].description, 'OG Anunoby Over 20.5 PTS + REB');
  assert.strictEqual(parsed._sourceText, raw);
});

console.log('relay-text false-positive fences');

for (const [name, text] of [
  ['promo with no actionable line', 'Join VIP for 50% off — NBA picks all week'],
  ['historical stat sentence', 'NBA recap: OG Anunoby had 21 PRs last night — what a game'],
  ['direction-less numeric', 'NBA Pick of the Day / J. Wetherholt .5 Hits'],
  ['team total', 'NBA Best Bet / Lakers Over 220.5 Points'],
  ['modeled soccer team total', 'UCL Best Bet / Real Madrid Over 1.5 Goals'],
  ['unmodeled college team total', 'NCAAB Best Bet / Duke Over 75.5 Points'],
  ['settled candidate line', 'NBA Best Bet / OG Anunoby O20.5 PRs ✅'],
  ['two candidates must defer instead of collapsing', 'NBA Picks:\nLeBron James O24.5 Points\nAnthony Davis O10.5 Rebounds'],
  ['missing sport context', 'OG Anunoby O20.5 PRs'],
]) {
  test(name, () => assert.strictEqual(parseRelayTextPropCandidate(text), null));
}

console.log('relay-text fallback selection');

const candidate = { type: 'bet', is_bet: true, bets: [{ description: 'candidate' }] };

for (const [name, parsed, expected] of [
  ['AI unavailable', null, true],
  ['AI ignore', { type: 'ignore', is_bet: false, bets: [] }, true],
  ['AI indeterminate empty', { bets: [] }, true],
  ['AI bet shape emptied by normalization', { type: 'bet', is_bet: true, bets: [] }, true],
  ['explicit result is preserved', { type: 'result', is_bet: false, outcome: 'win', bets: [] }, false],
  ['untracked winner is preserved', { type: 'untracked_win', is_bet: false, bets: [] }, false],
  ['usable AI bet wins', { type: 'bet', is_bet: true, bets: [{ description: 'AI bet' }] }, false],
]) {
  test(name, () => assert.strictEqual(shouldUseRelayTextPropFallback(parsed, candidate), expected));
}

test('no deterministic candidate means no fallback', () => {
  assert.strictEqual(shouldUseRelayTextPropFallback({ type: 'ignore', bets: [] }, null), false);
});

async function finish() {
  console.log('relay-text production-path fallback');

  await testAsync('image-bearing relay survives an unavailable AI tier', async () => {
    const source = '🏀 NBA Pick of the Day…\n👉🏼 iHart Over 8.5 Rebounds';
    const wrapped = `Tweet from @Harry: "${source}"\n\nRead the attached betting slip image.`;
    const providerEnv = [
      'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
      'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'OLLAMA_URL',
    ];
    const savedEnv = Object.fromEntries(providerEnv.map((key) => [key, process.env[key]]));
    providerEnv.forEach((key) => delete process.env[key]);

    try {
      const parsed = await parseBetText(wrapped, 'data:text/plain,not-an-image', {
        textFallbackSource: source,
      });
      assert.strictEqual(parsed.type, 'bet');
      assert.strictEqual(parsed.is_bet, true);
      assert.strictEqual(parsed._parse_source, 'relay_text_prop_fallback');
      assert.strictEqual(parsed.bets[0].description, 'iHart Over 8.5 Rebounds');
    } finally {
      for (const key of providerEnv) {
        if (savedEnv[key] == null) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });

  if (process.exitCode) {
    console.error(`relay-text-prop-fallback: ${passed} passed, failures above`);
  } else {
    console.log(`relay-text-prop-fallback: ${passed} passed, 0 failed`);
  }
}

finish().catch((err) => {
  console.error(`relay-text-prop-fallback: unexpected failure: ${err.message}`);
  process.exitCode = 1;
});
