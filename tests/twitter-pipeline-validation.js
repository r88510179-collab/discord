const assert = require('assert');
const path = require('path');

function loadAi() {
  const aiPath = path.resolve(__dirname, '../services/ai.js');
  delete require.cache[aiPath];
  // eslint-disable-next-line global-require
  return require(aiPath);
}

async function testMultiPickTweetMapsToParlay() {
  const { extractPickFromTweet } = loadAi();

  const parsed = await extractPickFromTweet(
    'Lakers ML + Celtics -3.5 + Over 220.5',
    'capper',
    [],
    {
      parseBetText: async () => ({
        type: 'bet',
        bets: [{
          sport: 'NBA',
          bet_type: 'parlay',
          description: '• Lakers ML\n• Celtics -3.5\n• Over 220.5',
          odds: 510,
          units: 1,
          legs: [
            { description: 'Lakers ML', odds: -140 },
            { description: 'Celtics -3.5', odds: -110 },
            { description: 'Over 220.5', odds: -110 },
          ],
        }],
      }),
    },
  );

  assert.ok(parsed, 'expected tweet parser to return a bet');
  assert.strictEqual(parsed.type, 'parlay', 'multi-pick tweet should map to parlay bet_type');
  assert.strictEqual(parsed.legs.length, 3, 'parlay should retain all individual legs');
  assert.strictEqual(parsed.odds, 510, 'top-level odds should keep parlay total odds');
}

async function testSinglePickTweetMapsToStraight() {
  const { extractPickFromTweet } = loadAi();

  const parsed = await extractPickFromTweet(
    'Lakers -3.5 (-110) 1u',
    'capper',
    [],
    {
      parseBetText: async () => ({
        type: 'bet',
        bets: [{
          sport: 'NBA',
          bet_type: 'straight',
          description: 'Lakers -3.5',
          odds: -110,
          units: 1,
          legs: [{ description: 'Lakers -3.5', odds: -110 }],
        }],
      }),
    },
  );

  assert.ok(parsed, 'expected tweet parser to return a bet');
  assert.strictEqual(parsed.type, 'straight', 'single-pick tweet should remain straight');
  assert.strictEqual(parsed.legs.length, 1, 'straight bet should have exactly one leg');
}

function loadTwitterWithMocks({ tweets, extractPickFromTweet }) {
  const twitterPath = path.resolve(__dirname, '../services/twitter.js');
  const scraperModulePath = require.resolve('agent-twitter-client');
  const aiPath = path.resolve(__dirname, '../services/ai.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const warRoomPath = path.resolve(__dirname, '../services/warRoom.js');

  delete require.cache[twitterPath];

  class MockScraper {
    async login() {}

    async *getTweets() {
      for (const tweet of tweets) {
        yield tweet;
      }
    }
  }

  require.cache[scraperModulePath] = {
    id: scraperModulePath,
    filename: scraperModulePath,
    loaded: true,
    exports: { Scraper: MockScraper },
  };
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { extractPickFromTweet } };

  const processed = new Set();
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      db: {
        prepare: (sql) => {
          if (sql.includes('SELECT tweet_id')) {
            return { get: (id) => (processed.has(id) ? { tweet_id: id } : undefined) };
          }
          if (sql.includes('INSERT OR IGNORE INTO processed_tweets')) {
            return { run: (id) => processed.add(id) };
          }
          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      getOrCreateCapper: () => ({ id: 'capper_1' }),
      createBetWithLegs: () => ({ id: 'bet_1', _deduped: false }),
    },
  };

  require.cache[warRoomPath] = {
    id: warRoomPath,
    filename: warRoomPath,
    loaded: true,
    exports: { sendStagingEmbed: async () => {} },
  };

  // eslint-disable-next-line global-require
  return require(twitterPath);
}

async function testTwitterForwardsMediaUrlsToParser() {
  const calls = [];
  const tweets = [{
    id: 't1',
    text: 'Slip attached',
    isRetweet: false,
    isReply: false,
    media: [{ url: 'https://img.example/slip.png' }],
  }];

  const { pollCappers } = loadTwitterWithMocks({
    tweets,
    extractPickFromTweet: async (...args) => {
      calls.push(args);
      return {
        sport: 'NBA',
        type: 'straight',
        description: 'Lakers -3.5',
        odds: -110,
        units: 1,
        legs: [{ description: 'Lakers -3.5', odds: -110 }],
      };
    },
  });

  process.env.TWITTER_USERNAME = 'bot';
  process.env.TWITTER_PASSWORD = 'pass';
  process.env.TWITTER_CAPPER_HANDLES = 'capper1:Capper One';

  await pollCappers(null);

  assert.strictEqual(calls.length, 1, 'expected one parser call for one tweet');
  assert.deepStrictEqual(calls[0][2], ['https://img.example/slip.png'], 'tweet media URL should be forwarded to AI parser');
}

(async () => {
  await testMultiPickTweetMapsToParlay();
  await testSinglePickTweetMapsToStraight();
  await testTwitterForwardsMediaUrlsToParser();
  console.log('twitter pipeline validation passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
