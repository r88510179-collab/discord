// ═══════════════════════════════════════════════════════════
// Twitter/X Poller — twitterapi.io (credit-conserving)
// Polls every 2h during active hours (8AM-12AM ET).
// Single batch of ALL handles per cycle to minimize API calls.
// Credit budget tracked via settings table.
//
// Safety: in-flight lock, circuit breaker, budget hard stop
// ═══════════════════════════════════════════════════════════

const { db, getTrackedTwitterAccounts, getSetting, setSetting } = require('./database');
const { handleTwitterWebhookPayload } = require('./twitter-handler');
const { recordDrop, makeIngestId } = require('./pipeline-events');

const delay = ms => new Promise(r => setTimeout(r, ms));

const API_BASE = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const CREDITS_PER_TWEET = 15;
const MIN_CREDITS_PER_CALL = 15;

// ── State flags ──
let isPolling = false;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// ── Credit tracking ──
function getCreditsUsed() {
  return parseInt(getSetting('twitterapi_credits_used') || '0', 10);
}
function addCredits(amount) {
  const current = getCreditsUsed();
  setSetting('twitterapi_credits_used', String(current + amount));
  return current + amount;
}
function getCreditBudget() {
  return parseInt(process.env.TWITTERAPI_CREDIT_BUDGET || '10000', 10);
}
function getCreditPct() {
  const budget = getCreditBudget();
  return budget > 0 ? Math.round(getCreditsUsed() / budget * 100) : 100;
}

// Alert thresholds (only alert once per threshold)
const alertedThresholds = new Set(
  (getSetting('twitterapi_alerted_thresholds') || '').split(',').filter(Boolean).map(Number)
);
function checkCreditThresholds(client) {
  const pct = getCreditPct();
  for (const threshold of [50, 75, 90, 100]) {
    if (pct >= threshold && !alertedThresholds.has(threshold)) {
      alertedThresholds.add(threshold);
      setSetting('twitterapi_alerted_thresholds', [...alertedThresholds].join(','));
      if (client && process.env.OWNER_ID) {
        const msg = threshold >= 100
          ? `🚨 **twitterapi.io budget EXHAUSTED** (${getCreditsUsed()}/${getCreditBudget()} credits). Twitter polling paused.\nOptions: 1) Add credits at twitterapi.io 2) Switch to Surface Book scraper 3) Reduce frequency`
          : `⚠️ **twitterapi.io ${threshold}% budget used** (${getCreditsUsed()}/${getCreditBudget()} credits)`;
        client.users.fetch(process.env.OWNER_ID).then(o => o.send(msg)).catch(() => {});
      }
    }
  }
}

async function searchTweets(query, apiKey) {
  const url = `${API_BASE}?query=${encodeURIComponent(query)}&queryType=Latest`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(20000),
    headers: { 'X-API-Key': apiKey },
  });

  if (res.status === 429) {
    console.warn('[Twitter Poller] 429 — rate limited');
    return { tweets: [], rateLimited: true, error: false };
  }
  if (res.status === 402) {
    console.error('[Twitter Poller] 402 — credits exhausted');
    return { tweets: [], rateLimited: false, error: 'credits_exhausted' };
  }
  if (!res.ok) {
    console.warn(`[Twitter Poller] HTTP ${res.status}`);
    return { tweets: [], rateLimited: false, error: true };
  }

  const data = await res.json();
  const tweets = data?.data?.tweets || data?.tweets || data?.results || [];
  return { tweets: Array.isArray(tweets) ? tweets : [], rateLimited: false, error: false };
}

async function pollCappers(client) {
  // ── Kill switch ──
  if (process.env.TWITTER_POLLER_DISABLED === 'true') {
    console.log('[Twitter Poller] DISABLED via env var — skipping');
    return;
  }

  // ── Choose API key ──
  const apiKey = process.env.TWITTERAPI_KEY || process.env.APITWITTER_KEY;
  if (!apiKey) {
    console.log('[Twitter Poller] Skipped — no TWITTERAPI_KEY or APITWITTER_KEY');
    return;
  }

  if (isPolling) { console.log('[Twitter Poller] Already running — skipping'); return; }
  if (consecutiveFailures >= MAX_FAILURES) { console.log('[Twitter Poller] Circuit breaker OPEN'); return; }

  // ── Budget check ──
  if (getCreditPct() >= 100) {
    console.log('[Twitter Poller] Credit budget exhausted — polling paused');
    checkCreditThresholds(client);
    return;
  }

  // ── Active hours gate: 8AM-12AM ET (12:00-04:00 UTC next day) ──
  const utcHour = new Date().getUTCHours();
  const inActiveWindow = utcHour >= 12 || utcHour < 4; // 8AM-12AM ET
  if (!inActiveWindow) {
    console.log(`[Twitter Poller] Outside active hours (UTC ${utcHour}, window 12-04)`);
    return;
  }

  isPolling = true;
  try {
    const tracked = getTrackedTwitterAccounts();
    if (tracked.length === 0) { console.log('[Twitter Poller] No tracked cappers.'); return; }

    // Cleanup dedup
    try { db.prepare("DELETE FROM processed_tweets WHERE processed_at < datetime('now', '-30 days')").run(); } catch (_) {}

    // Build lookup
    const handleMap = {};
    const freshHandles = new Set();
    for (const row of tracked) {
      const h = row.twitter_handle.toLowerCase();
      handleMap[h] = row.display_name || row.twitter_handle;
      if (!row.last_tweet_id) freshHandles.add(h);
    }
    const allHandles = Object.keys(handleMap);

    console.log(`[Twitter Poller] Polling ${allHandles.length} capper(s) via twitterapi.io (${getCreditPct()}% budget used)`);

    // ── Single batch: all handles in one query to save credits ──
    const searchQuery = allHandles.map(h => `from:${h}`).join(' OR ');
    console.log(`[Twitter Poller] Query: "${searchQuery.slice(0, 100)}..." (${allHandles.length} handles)`);

    const { tweets, rateLimited, error } = await searchTweets(searchQuery, apiKey);

    if (error === 'credits_exhausted') {
      addCredits(MIN_CREDITS_PER_CALL); // At minimum we were charged
      checkCreditThresholds(client);
      return;
    }
    if (rateLimited) { await delay(30000); return; }
    if (error) { consecutiveFailures++; return; }

    // Track credits: 15 per tweet returned, minimum 15
    const creditCost = Math.max(tweets.length * CREDITS_PER_TWEET, MIN_CREDITS_PER_CALL);
    const totalUsed = addCredits(creditCost);
    console.log(`[Twitter Poller] Got ${tweets.length} tweet(s) | Cost: ${creditCost} credits | Total: ${totalUsed}/${getCreditBudget()}`);
    checkCreditThresholds(client);

    if (tweets.length === 0) { consecutiveFailures = 0; return; }

    // ── Group by author, filter RTs/replies, age-gate fresh handles ──
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
    const tweetsByHandle = {};
    let ageFiltered = 0;

    for (const tweet of tweets) {
      // twitterapi.io: retweet detection via retweeted_tweet field
      if (tweet.retweeted_tweet) continue;
      if (tweet.isReply) continue;

      const author = (tweet.author?.userName || '').replace(/@/g, '').toLowerCase();
      if (!author || !handleMap[author]) continue;

      // Age gate for fresh handles
      if (freshHandles.has(author)) {
        const tweetTime = tweet.createdAt ? new Date(tweet.createdAt).getTime() : (tweet.created_at ? new Date(tweet.created_at).getTime() : 0);
        if (tweetTime && tweetTime < sixHoursAgo) {
          const ageTweetId = String(tweet.id || tweet.tweet_id || tweet.rest_id || tweet.id_str || '');
          const ageIngestId = makeIngestId('twitter', ageTweetId || `${author}_${tweetTime || Date.now()}`);
          recordDrop({
            ingestId: ageIngestId,
            sourceType: 'twitter',
            sourceRef: ageTweetId || null,
            stage: 'DROPPED',
            dropReason: 'AGE_GATE',
            payload: { handle: author, tweetTime, cutoff: sixHoursAgo, reason: 'fresh_handle_older_than_6h' },
          });
          ageFiltered++;
          continue;
        }
      }

      if (!tweetsByHandle[author]) tweetsByHandle[author] = [];
      tweetsByHandle[author].push(tweet);
    }
    if (ageFiltered > 0) console.log(`[Twitter Poller] Age-filtered ${ageFiltered} old tweet(s)`);

    let totalStaged = 0, totalSkipped = 0, totalAiCalls = 0;

    for (const [handle, capperTweets] of Object.entries(tweetsByHandle)) {
      const result = await handleTwitterWebhookPayload(
        { handle, displayName: handleMap[handle], tweets: capperTweets.slice(0, 5) },
        client,
      );
      totalStaged += result.staged;
      totalSkipped += result.skipped;
      totalAiCalls += result.aiCalls;
    }

    consecutiveFailures = 0;
    console.log(`[Twitter Poller] Done — staged ${totalStaged}, skipped ${totalSkipped}, AI ${totalAiCalls}, ${allHandles.length} cappers`);

  } catch (err) {
    consecutiveFailures++;
    console.error('[Twitter Poller] Error:', err.message);
    if (consecutiveFailures >= MAX_FAILURES && client && process.env.OWNER_ID) {
      client.users.fetch(process.env.OWNER_ID).then(o => o.send(`🚨 Twitter Poller circuit breaker tripped (${consecutiveFailures} errors).`)).catch(() => {});
    }
  } finally {
    isPolling = false;
  }
}

function getTwitterCreditStats() {
  return { used: getCreditsUsed(), budget: getCreditBudget(), pct: getCreditPct() };
}

module.exports = { pollCappers, getTwitterCreditStats };
