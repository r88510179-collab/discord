// ═══════════════════════════════════════════════════════════
// API Routes — Express endpoints for external integrations
// Mounted at /api in bot.js
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { handleTwitterWebhookPayload } = require('../services/twitter-handler');

// ── Health Check ──────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Mobile Scraper Ingest ─────────────────────────────────────
// Receives tweets from a mobile/external scraper app.
// Payload: { handle: "@CodyCapper", displayName: "Cody", tweets: [...] }
// Security: x-mobile-secret header must match MOBILE_SCRAPER_SECRET
router.post('/mobile-ingest', async (req, res) => {
  // ── Security check ──
  const secret = req.headers['x-mobile-secret'];
  if (!process.env.MOBILE_SCRAPER_SECRET || secret !== process.env.MOBILE_SCRAPER_SECRET) {
    console.warn('[API] Unauthorized mobile-ingest attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Support both batch format { handle, tweets: [...] } and single-tweet format { id, text, author }
  let handle, tweets, displayName;
  if (req.body.tweets) {
    // Batch format
    handle = req.body.handle;
    tweets = req.body.tweets;
    displayName = req.body.displayName;
  } else if (req.body.id && req.body.text && req.body.author) {
    // Single-tweet format
    handle = req.body.author?.userName || req.body.author;
    displayName = req.body.author?.name || handle;
    tweets = [req.body];
  } else {
    return res.status(400).json({ error: 'Missing required fields. Send {handle, tweets:[...]} or {id, text, author}' });
  }

  if (!handle || !tweets || !Array.isArray(tweets)) {
    return res.status(400).json({ error: 'Invalid payload format' });
  }

  console.log(`[API] Mobile ingest received: @${handle} with ${tweets.length} tweet(s)`);

  // Respond 200 immediately so the mobile app doesn't timeout
  res.status(200).json({ status: 'accepted', count: Array.isArray(tweets) ? tweets.length : 0 });

  // Process asynchronously
  try {
    const client = global._discordClient || null;
    const result = await handleTwitterWebhookPayload({ handle, tweets, displayName }, client);
    console.log(`[API] Mobile ingest complete: staged ${result.staged}, skipped ${result.skipped}`);
  } catch (err) {
    console.error('[API] Mobile ingest processing error:', err.message);
  }
});

module.exports = router;
