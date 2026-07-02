// ═══════════════════════════════════════════════════════════
// Admin Read-API — token-guarded, READ-ONLY endpoints under /api/admin/*
// Mounted at /api/admin in bot.js (Phase 2a-1). Feeds a private Surface
// dashboard with the hold queue, recent bets, scraper handles, the
// admin-log channel tail, and (Phase A of the dashboard buildout) the
// season leaderboard, recent pipeline drops, and a grader-health snapshot.
//
// HARD CONSTRAINT — strictly read-only:
//   - No POST / PATCH / DELETE routes are defined here.
//   - No DB writes. No Discord writes. Mutations arrive in Phase 2b via a
//     separate adminCommands layer; do not add them to this file.
//
// AUTH (adminAuth below, applied to EVERY route on this router):
//   - Bearer token in the Authorization header, timing-safe compared to
//     process.env.ADMIN_API_SECRET.
//   - FAIL CLOSED: if ADMIN_API_SECRET is unset/empty, every request 503s —
//     this router is never open.
//   - 401 missing/malformed header, 403 token mismatch. Failures are logged
//     ([AdminAPI] auth fail) WITHOUT echoing the presented token.
//   - ADMIN_API_SECRET is a NEW secret, SEPARATE from MOBILE_SCRAPER_SECRET
//     (used by routes/api.js). It is read from env here; it is set out of band
//     via `fly secrets set` — this code never sets it.
//
// CORS: this router sets no Access-Control-Allow-Origin header, and bot.js
// installs no global CORS middleware, so a browser on another origin cannot
// read these endpoints. Do NOT add permissive CORS here.
//
// `db` is lazy-required inside each handler (mirrors routes/api.js) so that
// merely requiring this module does not couple route loading to SQLite boot
// order. The bot is fully booted before any HTTP request arrives.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

// Auth (fail-closed bearer) is shared with the Phase 2b write router
// (routes/adminCommands.js) — extracted verbatim into routes/adminAuth.js.
const { adminAuth } = require('./adminAuth');

router.use(adminAuth);

// ── Hold-queue selection (pure, exported for testing) ─────────
// Trailing message-id segment of a Discord permalink (.../channels/G/C/<id>).
// Mirrors scripts/backfill-hold-embeds.js urlMessageId so the queue collapse
// picks the SAME representative the embed backfill does.
function urlMessageId(messageUrl) {
  const tail = String(messageUrl || '').split('/').pop() || '';
  const m = tail.match(/^(\d+)/);
  return m ? m[1] : null;
}

// selectHoldQueue(rows, isResolved) — turns the raw MANUAL_REVIEW_HOLD rows
// (SELECTed created_at DESC, id DESC) into the representative rows to render,
// newest first, ≤100. Exported as a pure function (mirrors how
// routes/adminCommands.js exports handleDismissRoute) so it can be unit-tested
// without an HTTP harness. `isResolved(ingestId, createdAt)` is injected — the
// handler passes a closure over its resolvedStmt.
//
// Operations (the prose order in prompts/holds-dedup-messageurl.md, reconciled
// with its acceptance tests):
//   b. dedup by ingest_id, keep newest (rows arrive newest first; NULL-ingest
//      rows are never deduped — each stays distinct).
//   c. DEDUP-MSGURL (holds queue collapse): collapse the survivors by
//      messageUrl. A buffered multi-message post (image-album split, or
//      TweetShift posting text + media as separate messages) writes N
//      MANUAL_REVIEW_HOLD rows with DISTINCT ingest_ids but ONE shared primary
//      messageUrl (stageAll records the hold per constituent for trace), while
//      the live pipeline calls sendHoldReviewEmbed only ONCE per aggregated
//      post — so collapsing the queue by messageUrl is LOSSLESS and matches
//      live behavior. Representative = the ingest_id equal to
//      `disc_<urlMessageId(messageUrl)>` (the permalink's own message), else the
//      OLDEST row (min created_at, tiebreak min id) — same rule as
//      scripts/backfill-hold-embeds.js dedupByMessageUrl.
//   a. drop resolved — evaluated on the collapsed group's REPRESENTATIVE, not
//      per raw row. The `disc_<urlMessageId>` primary is the ONLY ingest_id the
//      live Release/Dismiss button resolves (handlers/messageHandler.js sends
//      the embed with primaryIngestId; services/holdReview.js writes
//      MANUAL_REVIEW_RELEASED/DISMISSED for that one id), so a resolved buffered
//      post is dropped ENTIRELY rather than leaving its non-primary constituent
//      rows behind as ghosts. For a singleton group this is byte-identical to
//      the previous per-ingest "drop if newest resolved".
//   d. cap at 100 AFTER the collapse.
// Rows whose messageUrl is empty/non-string (or whose payload won't parse) are
// NEVER merged — each stays a distinct row keyed by its own event id.
function selectHoldQueue(rows, isResolved) {
  // b. dedup by ingest_id, keep newest.
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    if (r.ingest_id) {
      if (seen.has(r.ingest_id)) continue;   // dup hold for same ingest_id (older)
      seen.add(r.ingest_id);
    }
    deduped.push(r);
  }

  // c. DEDUP-MSGURL (holds queue collapse) — group survivors by messageUrl;
  // rows without a usable (non-empty string) messageUrl get a unique per-row
  // key so they are never merged.
  const messageUrlOf = (r) => {
    try {
      const p = JSON.parse(r.payload) || {};
      if (typeof p.messageUrl === 'string' && p.messageUrl.trim()) return p.messageUrl;
    } catch (_) { /* unparseable payload → not groupable */ }
    return null;
  };
  const annotated = deduped.map((r) => {
    const url = messageUrlOf(r);
    // Only collapse rows whose messageUrl identifies a SPECIFIC message — a
    // Discord permalink with a trailing numeric message id (urlMessageId != null),
    // the only shape the live hold path writes (holdPayload.messageUrl =
    // message.url) and the only shape the `disc_<urlMessageId>` rep rule can
    // attribute. A non-empty but non-permalink messageUrl (e.g. a placeholder)
    // can't be tied to one post, so each such row stays distinct rather than
    // merging unrelated holds.
    const groupable = url != null && urlMessageId(url) != null;
    return { row: r, key: groupable ? `url:${url}` : `row:${r.id}`, url: groupable ? url : null };
  });
  const groups = new Map();   // key → { url, members[] } (members in newest-first order)
  for (const a of annotated) {
    let g = groups.get(a.key);
    if (!g) { g = { url: a.url, members: [] }; groups.set(a.key, g); }
    g.members.push(a.row);
  }
  const repOf = (g) => {
    if (g.members.length === 1 || !g.url) return g.members[0];
    const mid = urlMessageId(g.url);
    const primary = mid ? g.members.find((m) => m.ingest_id === `disc_${mid}`) : null;
    if (primary) return primary;
    return g.members
      .slice()
      .sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))[0];   // oldest, tiebreak min id
  };

  // a + d. Emit each group's rep at the position of its newest member (so the
  // queue stays newest-first), dropping groups whose rep is resolved, capping
  // at 100 AFTER the collapse.
  const done = new Set();
  const out = [];
  for (const a of annotated) {
    if (done.has(a.key)) continue;
    done.add(a.key);
    const rep = repOf(groups.get(a.key));
    if (rep.ingest_id && isResolved(rep.ingest_id, rep.created_at)) continue; // resolved post → drop group
    out.push(rep);
    if (out.length >= 100) break;
  }
  return out;
}

// ── GET /holds ────────────────────────────────────────────────
// Unresolved MANUAL_REVIEW_HOLD review queue. Selection is delegated to the
// pure, exported selectHoldQueue (above): dedup duplicate holds per ingest_id
// (keep newest), collapse buffered multi-message posts that share one primary
// messageUrl into a single row (DEDUP-MSGURL — see selectHoldQueue), drop any
// whose representative ingest_id later got a MANUAL_REVIEW_RELEASED /
// MANUAL_REVIEW_DISMISSED event, then cap at 100. Newest first, ≤100.
//
// pipeline_events.created_at is INTEGER unix-epoch SECONDS (migration 018) —
// returned verbatim as `createdAt`; the dashboard formats it.
//
// `imageUrl` (joined from the EXTRACTED event by ingest_id): the bet-slip
// image URL is NOT on the MANUAL_REVIEW_HOLD event's own payload — it rides a
// separate pipeline_events row for the same ingest_id, in practice the
// EXTRACTED-stage event ({imageCount, imageUrl}). We look it up per hold (the
// most recent payload that actually parses to an imageUrl key) and surface it
// verbatim, or null when none (text-only holds, or a hold whose ingest never
// produced an image row). The URL is returned UNFILTERED — not every imageUrl
// is a real slip (promo art, tweet-video thumbnails surface too) — so the
// dashboard, not the bot, decides how to render/classify it.
//
// CAVEAT (not fixed here — this is a read-only field addition): the single-
// image relay path stores imageUrl truncated to 120 chars
// (handlers/messageHandler.js:1058), so long URLs — notably signed Discord CDN
// attachment links (cdn.discordapp.com, ~150–250 chars) that feed human-
// submission holds — arrive CLIPPED and may not load. Surfacing the stored
// value verbatim is correct; widening it is a separate write-path change.
router.get('/holds', (req, res) => {
  try {
    const { db } = require('../services/database');

    const rows = db.prepare(`
      SELECT id, ingest_id, bet_id, source_type, source_ref, drop_reason, payload, created_at
      FROM pipeline_events
      WHERE stage = 'MANUAL_REVIEW_HOLD'
      ORDER BY created_at DESC, id DESC
    `).all();

    const resolvedStmt = db.prepare(`
      SELECT 1 FROM pipeline_events
      WHERE ingest_id = ?
        AND stage IN ('MANUAL_REVIEW_RELEASED', 'MANUAL_REVIEW_DISMISSED')
        AND created_at > ?
      LIMIT 1
    `);

    // Per-hold image join (mirrors the resolvedStmt per-hold pattern; ≤100
    // lookups). The imageUrl lives on a SEPARATE pipeline_events row sharing
    // the ingest_id (in practice the EXTRACTED event). We match on the imageUrl
    // KEY appearing in the payload — a cheap, ingest-index-served LIKE
    // prefilter, with no stage-name assumption — then PARSE each candidate
    // newest-first and return the first that yields a usable string imageUrl.
    //
    // Parse-and-iterate (not substring-LIKE + LIMIT 1) is deliberate: the
    // MANUAL_REVIEW_HOLD row for the same ingest is written AFTER its EXTRACTED
    // row (created_at ≥, id >), so a hold whose `sample` text merely mentions
    // the word "imageUrl" would otherwise win LIMIT 1 and suppress the real
    // URL. Skipping rows whose parsed payload carries no usable imageUrl makes
    // the lookup immune to that shadowing. NULL when no row carries one.
    const imageUrlStmt = db.prepare(`
      SELECT payload FROM pipeline_events
      WHERE ingest_id = ?
        AND payload LIKE '%"imageUrl"%'
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `);
    const imageUrlFor = (ingestId) => {
      if (!ingestId) return null;                       // no join key → no image
      for (const row of imageUrlStmt.all(ingestId)) {
        if (!row || !row.payload) continue;
        try {
          const p = JSON.parse(row.payload);
          // Unfiltered: return whatever URL the event carries; only require a
          // non-empty string so a keyless/junk row yields null, not a bad value.
          if (p && typeof p.imageUrl === 'string' && p.imageUrl) return p.imageUrl;
        } catch (_) {
          // malformed payload → skip this candidate, never throw
        }
      }
      return null;
    };

    // Pure selection (dedup by ingest_id → DEDUP-MSGURL collapse → drop
    // resolved reps → cap 100). isResolved closes over resolvedStmt.
    const isResolved = (ingestId, createdAt) => !!resolvedStmt.get(ingestId, createdAt);
    const holds = selectHoldQueue(rows, isResolved);

    const items = holds.map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload) || {}; } catch (_) { payload = {}; }

      // Candidate parse metadata is stored only on the ai_indeterminate hold
      // variant (handlers/messageHandler.js). Surface it when present.
      const hasParse =
        payload.parsedType !== undefined ||
        payload.betCount !== undefined ||
        payload.is_bet_value !== undefined;
      const parsed = hasParse
        ? {
            type: payload.parsedType ?? null,
            betCount: payload.betCount ?? null,
            isBetValue: payload.is_bet_value ?? null,
          }
        : null;

      return {
        id: r.ingest_id || String(r.id), // actionable key (Release/Dismiss use ingest_id)
        ingestId: r.ingest_id || null,
        eventId: r.id,                   // pipeline_events PK
        capper: payload.capper || null,
        channelId: payload.channelId || null,
        messageUrl: payload.messageUrl || null,            // Discord message link, if stored
        imageUrl: imageUrlFor(r.ingest_id),                // bet-slip image, joined from EXTRACTED event by ingest_id; null when none
        reason: payload.reason || r.drop_reason || null,   // hold / failure reason
        sample: payload.sample || null,                    // extracted text (hold sample ≤400 chars as stored; ≤80 on pre-2026-06-12 holds)
        parsed,                                            // candidate parsed payload, if stored
        sourceType: r.source_type || null,
        betId: r.bet_id || null,
        createdAt: r.created_at,                           // epoch seconds
      };
    });

    return res.status(200).json({ count: items.length, holds: items });
  } catch (err) {
    console.error('[AdminAPI] /holds query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /bets ─────────────────────────────────────────────────
// Recent bets, newest first, ≤100. Optional filters (all AND-combined):
//   status      → bets.result   (pending|win|loss|push|void)
//   capper      → bets.capper_id (exact) OR cappers.display_name (case-insensitive)
//   channel     → bets.source_channel_id (exact)
//   from / to   → bets.created_at (ISO text, lexicographic >= / <=)
//   needsReview → bets.review_status = 'needs_review'  (1|true)
//
// The needs-review concept is real: bets.review_status carries a 'needs_review'
// enum value (see docs/CODEMAP.md), so the flag is honored rather than omitted.
router.get('/bets', (req, res) => {
  try {
    const { db } = require('../services/database');
    const { status, capper, channel, from, to, needsReview } = req.query;

    const where = [];
    const params = [];

    if (status) { where.push('b.result = ?'); params.push(String(status)); }
    if (channel) { where.push('b.source_channel_id = ?'); params.push(String(channel)); }
    if (capper) {
      where.push('(b.capper_id = ? OR lower(c.display_name) = lower(?))');
      params.push(String(capper), String(capper));
    }
    if (from) { where.push('b.created_at >= ?'); params.push(String(from)); }
    if (to) { where.push('b.created_at <= ?'); params.push(String(to)); }
    const needsReviewOn = needsReview === '1' || needsReview === 'true';
    if (needsReviewOn) { where.push("b.review_status = 'needs_review'"); }

    const sql = `
      SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
      FROM bets b
      LEFT JOIN cappers c ON b.capper_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.created_at DESC
      LIMIT 100
    `;
    const bets = db.prepare(sql).all(...params);

    return res.status(200).json({
      count: bets.length,
      filters: { status: status || null, capper: capper || null, channel: channel || null, from: from || null, to: to || null, needsReview: needsReviewOn },
      bets,
    });
  } catch (err) {
    console.error('[AdminAPI] /bets query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /handles ──────────────────────────────────────────────
// scraper_handles rows (migration 027). added_at is INTEGER unix-epoch
// seconds; enabled is 0/1.
router.get('/handles', (req, res) => {
  try {
    const { db } = require('../services/database');
    const handles = db
      .prepare('SELECT handle, enabled, added_at, note FROM scraper_handles ORDER BY handle ASC')
      .all();
    return res.status(200).json({ count: handles.length, handles });
  } catch (err) {
    console.error('[AdminAPI] /handles query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /logs ─────────────────────────────────────────────────
// Last 50–100 messages from ADMIN_LOG_CHANNEL_ID via the existing discord.js
// client. READ ONLY — a channel.messages.fetch with no writes of any kind.
//   ?limit=N  clamps to [1,100], default 100 (discord.js caps fetch at 100).
router.get('/logs', async (req, res) => {
  try {
    const channelId = process.env.ADMIN_LOG_CHANNEL_ID;
    if (!channelId) {
      return res.status(503).json({ error: 'ADMIN_LOG_CHANNEL_ID not configured' });
    }

    const client = global._discordClient;
    if (!client) {
      return res.status(503).json({ error: 'Discord client not ready' });
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.messages?.fetch !== 'function') {
      return res.status(502).json({ error: 'admin-log channel not reachable' });
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 100;
    limit = Math.max(1, Math.min(100, limit));

    const collection = await channel.messages.fetch({ limit });
    const messages = [...collection.values()]
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp) // newest first
      .map(m => ({
        id: m.id,
        timestamp: m.createdAt ? m.createdAt.toISOString() : null,
        content: m.content || '',
        embeds: (m.embeds || []).map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
      }));

    return res.status(200).json({ count: messages.length, channelId, messages });
  } catch (err) {
    console.error('[AdminAPI] /logs fetch error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /leaderboard ──────────────────────────────────────────
// Season-scoped capper leaderboard — the SAME getLeaderboard() the Discord
// /leaderboard surface uses (services/database.js), so the dashboard reads the
// exact truth surface the bot shows. Rows are scoped to ACTIVE_SEASON inside
// getLeaderboard; `season` is included in the envelope DELIBERATELY so the
// dashboard can label which season it is looking at.
//   ?sort=   whitelisted to getLeaderboard's own allowed set
//            (total_profit_units|roi_pct|win_pct|total_bets); anything else
//            falls back to total_profit_units — mirrors the function's own
//            silent-fallback behavior. The envelope echoes the EFFECTIVE sort.
//   ?limit=  clamps to [1,50], default 10 (getLeaderboard's own default).
router.get('/leaderboard', (req, res) => {
  try {
    const { getLeaderboard, ACTIVE_SEASON } = require('../services/database');

    const SORTS = ['total_profit_units', 'roi_pct', 'win_pct', 'total_bets'];
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'total_profit_units';

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 10;
    limit = Math.max(1, Math.min(50, limit));

    const cappers = getLeaderboard(sort, limit);
    return res.status(200).json({ season: ACTIVE_SEASON, sort, cappers });
  } catch (err) {
    console.error('[AdminAPI] /leaderboard query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /drops ────────────────────────────────────────────────
// Recent pipeline drops — the recordDrop() rows (event_type='DROP'; stage
// 'DROPPED' or 'GRADING_DROPPED'), newest first, plus a per-reason count
// breakdown over the same window. event_type='DROP' (not stage) is the filter
// so grading-side drops are included while MANUAL_REVIEW_HOLD rows (which can
// also carry a drop_reason) are not.
//
// pipeline_events.created_at is INTEGER epoch SECONDS (migration 018) — the
// cutoff is computed in JS and bound as a param so the comparison stays
// INTEGER-vs-INTEGER (a datetime('now',…) TEXT comparand silently matches
// zero rows; see docs/CODEMAP.md DB quirks).
//   ?hours=  window size, clamps to [1,168], default 24.
//   ?reason= optional exact drop_reason filter, format-validated ^[A-Z0-9_]+$
//            → 400 on mismatch. Format-only on purpose: the enum lives at
//            services/pipeline-events.js DROP_REASONS and grows — do NOT
//            hardcode it here.
//   ?limit=  row cap for `drops`, clamps to [1,200], default 50. `counts` is
//            window-wide and never capped by limit. payload stays raw TEXT —
//            the UI formats it.
router.get('/drops', (req, res) => {
  try {
    const { db } = require('../services/database');

    let hours = parseInt(req.query.hours, 10);
    if (!Number.isFinite(hours)) hours = 24;
    hours = Math.max(1, Math.min(168, hours));

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(200, limit));

    const reason = req.query.reason ? String(req.query.reason) : null;
    if (reason && !/^[A-Z0-9_]+$/.test(reason)) {
      return res.status(400).json({ error: 'Invalid reason (expected ^[A-Z0-9_]+$)' });
    }

    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const where = ["event_type = 'DROP'", 'created_at >= ?'];
    const params = [since];
    if (reason) { where.push('drop_reason = ?'); params.push(reason); }

    const counts = db.prepare(`
      SELECT drop_reason, COUNT(*) AS n
      FROM pipeline_events
      WHERE ${where.join(' AND ')}
      GROUP BY drop_reason
      ORDER BY n DESC
    `).all(...params);

    const drops = db.prepare(`
      SELECT id, ingest_id, bet_id, source_type, source_ref, drop_reason, payload, created_at
      FROM pipeline_events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit);

    return res.status(200).json({ since, counts, drops });
  } catch (err) {
    console.error('[AdminAPI] /drops query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /grader-health ────────────────────────────────────────
// One-call grader-health snapshot: the pending backlog, the last 24h of
// grader attempts, and the last 24h of search-backend calls.
//
// TIMESTAMP UNITS differ per table (the classic footgun — docs/CODEMAP.md):
//   bets.created_at          TEXT ISO       → MIN() lexicographic is correct
//   grading_audit.timestamp  INTEGER MILLIS (Date.now(), writeGradingAudit)
//   search_backend_calls.ts  INTEGER MILLIS (Date.now(), recordBackendCall)
// Both 24h windows therefore use (nowSec-86400)*1000, bound as a param.
router.get('/grader-health', (req, res) => {
  try {
    const { db } = require('../services/database');
    const cutoffMs = (Math.floor(Date.now() / 1000) - 86400) * 1000;

    const pendingTotals = db.prepare(`
      SELECT COUNT(*) AS total, MIN(created_at) AS oldest_created_at
      FROM bets WHERE result = 'pending'
    `).get();
    const pending = {
      total: pendingTotals.total,
      oldestCreatedAt: pendingTotals.oldest_created_at, // null when no pending bets
      byReviewStatus: db.prepare(`
        SELECT review_status, COUNT(*) AS n
        FROM bets WHERE result = 'pending'
        GROUP BY review_status ORDER BY n DESC
      `).all(),
    };

    const gradingTotals = db.prepare(`
      SELECT COUNT(*) AS attempts, COUNT(DISTINCT bet_id) AS distinct_bets
      FROM grading_audit WHERE timestamp >= ?
    `).get(cutoffMs);
    const grading24h = {
      attempts: gradingTotals.attempts,
      distinctBets: gradingTotals.distinct_bets,
      byProvider: db.prepare(`
        SELECT provider_used, COUNT(*) AS n
        FROM grading_audit WHERE timestamp >= ?
        GROUP BY provider_used ORDER BY n DESC
      `).all(cutoffMs),
      byFinalStatus: db.prepare(`
        SELECT final_status, COUNT(*) AS n
        FROM grading_audit WHERE timestamp >= ?
        GROUP BY final_status ORDER BY n DESC
      `).all(cutoffMs),
    };

    const backends24h = db.prepare(`
      SELECT backend, status, COUNT(*) AS n
      FROM search_backend_calls WHERE ts >= ?
      GROUP BY backend, status
      ORDER BY backend ASC, n DESC
    `).all(cutoffMs);

    return res.status(200).json({ pending, grading24h, backends24h });
  } catch (err) {
    console.error('[AdminAPI] /grader-health query error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Unknown /api/admin/* path (or any non-GET method) → clean JSON 404.
// There are deliberately no write routes; this makes that explicit.
router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
module.exports.selectHoldQueue = selectHoldQueue;
