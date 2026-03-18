const { getTrackedTwitterAccounts, updateLastTweetId, getOrCreateCapper, createBet } = require('./database');
const { parseTwitterPick } = require('./ai');

const TWITTER_API = 'https://api.twitter.com/2';

// ── Fetch recent tweets from a user ─────────────────────────
async function fetchUserTweets(handle, sinceId) {
  const bearer = process.env.TWITTER_BEARER_TOKEN;
  if (!bearer) return [];

  try {
    // First get user ID from handle
    const userRes = await fetch(`${TWITTER_API}/users/by/username/${handle}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!userRes.ok) return [];
    const userData = await userRes.json();
    const userId = userData.data?.id;
    if (!userId) return [];

    // Fetch recent tweets
    let url = `${TWITTER_API}/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text`;
    if (sinceId) url += `&since_id=${sinceId}`;

    const tweetsRes = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!tweetsRes.ok) return [];
    const tweetsData = await tweetsRes.json();
    return tweetsData.data || [];
  } catch (err) {
    console.error(`[Twitter] Error fetching @${handle}:`, err.message);
    return [];
  }
}

// ── Poll all tracked accounts for new picks ─────────────────
async function pollTwitterPicks(discordClient) {
  const accounts = await getTrackedTwitterAccounts();
  if (accounts.length === 0) return;

  console.log(`[Twitter] Polling ${accounts.length} tracked accounts...`);

  for (const account of accounts) {
    const tweets = await fetchUserTweets(account.twitter_handle, account.last_tweet_id);
    if (tweets.length === 0) continue;

    // Update last tweet ID to most recent
    await updateLastTweetId(account.twitter_handle, tweets[0].id);

    for (const tweet of tweets) {
      // Use AI to parse the tweet for picks
      const parsed = await parseTwitterPick(tweet.text, account.twitter_handle);

      if (!parsed.contains_picks || parsed.bets.length === 0) continue;

      // Get or create the capper
      const capper = require('./database').getOrCreateCapperByTwitter(account.twitter_handle);

      // Save each detected bet
      const savedBets = [];
      for (const bet of parsed.bets) {
        const saved = await createBet({
          capper_id: capper.id,
          sport: bet.sport || 'Unknown',
          league: bet.league,
          bet_type: bet.bet_type || 'straight',
          description: bet.description,
          odds: bet.odds || -110,
          units: bet.units || 1,
          source: 'twitter',
          source_url: `https://x.com/${account.twitter_handle}/status/${tweet.id}`,
          raw_text: tweet.text,
        });
        savedBets.push(saved);
      }

      // Post to Discord channel
      try {
        const channel = await discordClient.channels.fetch(account.channel_id);
        if (channel) {
          const betList = parsed.bets
            .map(b => `• **${b.description}** (${b.odds > 0 ? '+' : ''}${b.odds}) ${b.units}u`)
            .join('\n');

          await channel.send({
            embeds: [{
              color: 0x1DA1F2,
              author: {
                name: `@${account.twitter_handle}`,
                url: `https://x.com/${account.twitter_handle}`,
                icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
              },
              title: '🐦 New Picks Detected',
              description: betList,
              footer: { text: `${savedBets.length} bet(s) auto-tracked • Source: Twitter` },
              timestamp: new Date().toISOString(),
              url: `https://x.com/${account.twitter_handle}/status/${tweet.id}`,
            }],
          });
        }
      } catch (err) {
        console.error(`[Twitter] Discord post error:`, err.message);
      }
    }
  }
}

module.exports = { pollTwitterPicks, fetchUserTweets };
