// ═══════════════════════════════════════════════════════════
// Twitter/X Scraper — uses agent-twitter-client to poll cappers
// Feeds new tweets through the AI Bouncer → War Room pipeline
// ═══════════════════════════════════════════════════════════

const { Scraper } = require('agent-twitter-client');
const { extractPickFromTweet } = require('./ai');
const { db, getOrCreateCapper, createBetWithLegs } = require('./database');
const { sendStagingEmbed } = require('./warRoom');

const scraper = new Scraper();
let isLoggedIn = false;

async function loginTwitter() {
  if (isLoggedIn) return true;
  const { TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL } = process.env;
  if (!TWITTER_USERNAME || !TWITTER_PASSWORD) {
    console.log('[Twitter] Skipped — no TWITTER_USERNAME/TWITTER_PASSWORD set');
    return false;
  }
  try {
    console.log('[Twitter] Logging into burner account...');
    await scraper.login(TWITTER_USERNAME, TWITTER_PASSWORD, TWITTER_EMAIL || undefined);
    isLoggedIn = true;
    console.log('[Twitter] Login successful!');
    return true;
  } catch (err) {
    console.error('[Twitter] Login failed:', err.message);
    return false;
  }
}

async function pollCappers(client) {
  const loggedIn = await loginTwitter();
  if (!loggedIn) return;

  // Parse capper handles from env: "handle1:DisplayName,handle2:DisplayName"
  const raw = process.env.TWITTER_CAPPER_HANDLES || '';
  const cappers = raw.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const [handle, name] = entry.split(':');
    return { handle: handle.trim(), name: (name || handle).trim() };
  });

  if (cappers.length === 0) {
    console.log('[Twitter] No TWITTER_CAPPER_HANDLES configured');
    return;
  }

  for (const { handle, name } of cappers) {
    try {
      console.log(`[Twitter] Checking @${handle} for new tweets...`);
      const tweets = scraper.getTweets(handle, 5);

      for await (const tweet of tweets) {
        // 1. Already processed?
        const exists = db.prepare('SELECT tweet_id FROM processed_tweets WHERE tweet_id = ?').get(tweet.id);
        if (exists) continue;

        // 2. Mark as processed immediately
        db.prepare('INSERT OR IGNORE INTO processed_tweets (tweet_id) VALUES (?)').run(tweet.id);

        // 3. Skip retweets and replies
        if (tweet.isRetweet || tweet.isReply) continue;

        // 4. AI Bouncer
        console.log(`[Twitter] New tweet from @${handle}: "${(tweet.text || '').slice(0, 60)}..."`);
        const pickData = await extractPickFromTweet(tweet.text || '', name);

        if (!pickData) {
          console.log(`[Twitter] Rejected — not a bet.`);
          continue;
        }

        // 5. Save to DB + stage to War Room
        const capper = getOrCreateCapper(`twitter_${handle.toLowerCase()}`, name, null);
        const saved = createBetWithLegs({
          capper_id: capper.id,
          sport: pickData.sport || 'Unknown',
          bet_type: pickData.type || 'straight',
          description: pickData.description,
          odds: pickData.odds ? parseInt(pickData.odds, 10) : null,
          units: pickData.units || 1,
          source: 'twitter_scraper',
          source_url: `https://x.com/${handle}/status/${tweet.id}`,
          raw_text: (tweet.text || '').slice(0, 500),
          review_status: 'needs_review',
        }, pickData.legs || []);

        if (saved && !saved._deduped && client) {
          await sendStagingEmbed(client, saved, name, `https://x.com/${handle}/status/${tweet.id}`);
          console.log(`[Twitter] Staged: "${pickData.description?.slice(0, 50)}" from @${handle}`);
        }
      }
    } catch (error) {
      console.error(`[Twitter] Error scraping @${handle}:`, error.message);
    }
  }
}

module.exports = { pollCappers, loginTwitter };
