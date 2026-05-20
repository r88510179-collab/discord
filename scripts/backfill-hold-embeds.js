#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════
// scripts/backfill-hold-embeds.js
//
// One-shot backfill of MANUAL_REVIEW_HOLD admin-log embeds for the
// v447 deploy gap.
//
// v447 (dc33047, 2026-05-15) added the MANUAL_REVIEW_HOLD stage and the
// Release/Dismiss embed (handlers/messageHandler.js → sendHoldReviewEmbed),
// but ADMIN_LOG_CHANNEL_ID lived in Fly as a "Staged" (not deployed) secret
// until v472 (2026-05-20). sendHoldReviewEmbed early-returns when that env
// is unset, so every hold since v447 wrote its pipeline_events row but never
// posted an embed. This script reposts an embed for each still-unresolved
// hold so the owner can Release/Dismiss them from Discord.
//
// Run inside the Fly machine (the script + bot share the deployed image):
//   fly ssh console -a bettracker-discord-bot -C "node scripts/backfill-hold-embeds.js --dry-run"
//   fly ssh console -a bettracker-discord-bot -C "node scripts/backfill-hold-embeds.js --commit"
//
// READ-ONLY w.r.t. the DB: it SELECTs holds and POSTs embeds. No
// INSERT/UPDATE/DELETE anywhere. The Release/Dismiss buttons (handled by
// services/holdReview.js) are what later writes the resolution rows.
//
// Deviations from prompts/backfill-hold-embeds.md (documented):
//  - Discord ready event is `clientReady`, NOT `ready`. discord.js 14.25.1
//    renamed it (bot.js:498 uses Events.ClientReady; scripts/review-holds.js
//    does the same); `ready` is a deprecation-warning alias. The prompt's
//    literal "ready" would still fire here but emits a warning — `clientReady`
//    matches the rest of the repo.
//  - The 2026-05-15 cutoff is computed in JS as epoch seconds and bound as an
//    integer param, NOT `strftime('%s','2026-05-15')`. pipeline_events.created_at
//    is INTEGER epoch seconds (migration 018); per docs/CODEMAP.md ("Database —
//    quirky things") and DEPLOY_CHECKLIST §3a, JS-computed epoch comparison is
//    the house rule and matches loadUnresolvedHolds in scripts/review-holds.js.
//    Result is identical to the prompt's SQL.
//  - Unresolved-hold loading mirrors scripts/review-holds.js loadUnresolvedHolds:
//    dedup by ingest_id keeping the MOST RECENT hold row, then sort ASC (oldest
//    first). Same semantics as holdReview.loadHoldEvent (ORDER BY created_at DESC).
//  - aiVerdict is the raw payload `reason` ("ai_is_bet_false" /
//    "ai_indeterminate_no_bets") per the prompt. The live ingest-time embed
//    passes a prettier string ("ignore (is_bet=false)"); backfilled embeds show
//    the raw reason. Cosmetic only.
//  - `sample` is the stored 80-char payload sample (cleanText.slice(0,80) at
//    ingest). The live embed slices the full cleanText to 200; backfill can only
//    use what was persisted. Cosmetic.
//  - Intents are [Guilds] only — the script posts, it never reads messages.
//  - ADMIN_LOG_CHANNEL_ID unset: in --commit this is a hard abort (exit 1, posts
//    nothing) per the prompt; in --dry-run it WARNS but still lists holds, since
//    a dry-run posts nothing and the list is its whole point.
// ═══════════════════════════════════════════════════════════

// v447 ship date (UTC midnight). Holds before this predate the feature.
const SINCE_ISO = '2026-05-15T00:00:00Z';
const SINCE_EPOCH = Math.floor(Date.parse(SINCE_ISO) / 1000);
const POST_DELAY_MS = 1000; // pace embed posts to avoid Discord rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Arg parsing ───────────────────────────────────────────────
// Default is dry-run. --commit is required to actually post. An explicit
// --dry-run overrides --commit (fail safe toward not posting).
function parseArgs(argv) {
  const rest = (argv || []).slice(2);
  const commit = rest.includes('--commit') && !rest.includes('--dry-run');
  return { commit, dryRun: !commit };
}

function parsePayload(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// Mirrors scripts/review-holds.js loadUnresolvedHolds, with a fixed since-epoch
// instead of a rolling --hours window. Returns deduped, unresolved holds sorted
// oldest-first.
function loadUnresolvedHoldsSince(db, sinceEpoch) {
  const holdRows = db.prepare(`
    SELECT ingest_id, payload, created_at
    FROM pipeline_events
    WHERE stage = 'MANUAL_REVIEW_HOLD' AND created_at >= ?
    ORDER BY created_at ASC
  `).all(sinceEpoch);

  const candidateIds = [...new Set(holdRows.map((r) => r.ingest_id))];
  let resolved = new Set();
  if (candidateIds.length) {
    const placeholders = candidateIds.map(() => '?').join(',');
    resolved = new Set(
      db.prepare(`
        SELECT DISTINCT ingest_id FROM pipeline_events
        WHERE stage IN ('MANUAL_REVIEW_RELEASED','MANUAL_REVIEW_DISMISSED')
          AND ingest_id IN (${placeholders})
      `).all(...candidateIds).map((r) => r.ingest_id),
    );
  }

  // Dedup by ingest_id (keep most recent hold row), drop resolved, sort ASC.
  const byId = new Map();
  for (const row of holdRows) {
    const prev = byId.get(row.ingest_id);
    if (!prev || row.created_at > prev.created_at) byId.set(row.ingest_id, row);
  }
  return [...byId.values()]
    .filter((h) => !resolved.has(h.ingest_id))
    .sort((a, b) => a.created_at - b.created_at);
}

// A hold is postable only if it has a usable messageUrl — sendHoldReviewEmbed
// builds a Link button with .setURL(messageUrl), which throws on an empty/invalid
// URL. Rows without one are reported SKIP rather than crashing the run.
function buildPlan(holds) {
  return holds.map((h) => {
    const payload = parsePayload(h.payload);
    const messageUrl = typeof payload.messageUrl === 'string' ? payload.messageUrl.trim() : '';
    const postable = /^https?:\/\//i.test(messageUrl);
    return { ingestId: h.ingest_id, createdAt: h.created_at, payload, messageUrl, postable };
  });
}

function printLine(p, channelDisplay, status) {
  const capper = p.payload.capper || 'unknown';
  const reason = p.payload.reason || '—';
  console.log(`[${p.ingestId}] [${capper}] [${channelDisplay || 'unknown'}] [${reason}] [${status}]`);
}

// Resolve channel names once (one REST fetch per unique id, best-effort) so the
// summary shows #channel-name instead of a raw snowflake. Falls back to the id.
async function buildChannelNameCache(client, channelIds) {
  const cache = new Map();
  for (const id of [...new Set(channelIds.filter(Boolean))]) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch && ch.name) cache.set(id, ch.name);
  }
  return cache;
}

async function main() {
  const args = parseArgs(process.argv);
  const { db } = require('../services/database');

  const holds = loadUnresolvedHoldsSince(db, SINCE_EPOCH);
  const plan = buildPlan(holds);
  const postable = plan.filter((p) => p.postable);
  const skippable = plan.filter((p) => !p.postable);

  console.log(`\nUnresolved MANUAL_REVIEW_HOLD slips since ${SINCE_ISO} (epoch ${SINCE_EPOCH}): ${plan.length}`);
  console.log(`  postable: ${postable.length}   skipped (no messageUrl): ${skippable.length}`);
  console.log(`  mode: ${args.dryRun ? 'DRY-RUN (no posts)' : 'COMMIT (will post)'}\n`);

  // ── DRY-RUN: list only, never touch Discord ──
  if (args.dryRun) {
    for (const p of plan) {
      printLine(p, p.payload.channelId, p.postable ? 'WOULD-POST' : 'SKIP(no messageUrl)');
    }
    if (!process.env.ADMIN_LOG_CHANNEL_ID) {
      console.log('\n⚠️  ADMIN_LOG_CHANNEL_ID is NOT set here — a --commit run would abort (exit 1) and post nothing.');
    }
    console.log(`\nDRY-RUN: would post ${postable.length} embeds. Re-run with --commit to actually post.`);
    return 0;
  }

  // ── COMMIT: pre-flight aborts before any login ──
  if (!process.env.ADMIN_LOG_CHANNEL_ID) {
    console.error('ABORT: ADMIN_LOG_CHANNEL_ID is not set — refusing --commit (would post nothing). Exit 1.');
    return 1;
  }
  if (!process.env.DISCORD_TOKEN) {
    console.error('ABORT: DISCORD_TOKEN not set — cannot log in. Run inside the Fly machine (fly ssh console). Exit 1.');
    return 1;
  }
  if (postable.length === 0) {
    for (const p of skippable) printLine(p, p.payload.channelId, 'SKIP(no messageUrl)');
    console.log(`\nTotal holds found: ${plan.length}, posted: 0, failed: 0, skipped: ${skippable.length}`);
    console.log('Nothing postable. Done.');
    return 0;
  }

  const { Client, GatewayIntentBits } = require('discord.js');
  const { sendHoldReviewEmbed } = require('../handlers/messageHandler');
  if (typeof sendHoldReviewEmbed !== 'function') {
    console.error('ABORT: sendHoldReviewEmbed is not exported from handlers/messageHandler.js. Exit 1.');
    return 1;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  return await new Promise((resolve) => {
    client.once('clientReady', async () => {
      let posted = 0;
      let failed = 0;
      const skipped = skippable.length;
      try {
        // Verify the admin-log channel resolves up front, so a silent
        // early-return inside sendHoldReviewEmbed can't be miscounted as POSTED.
        const adminLog = await client.channels.fetch(process.env.ADMIN_LOG_CHANNEL_ID).catch(() => null);
        if (!adminLog) {
          console.error(`ABORT: ADMIN_LOG_CHANNEL_ID=${process.env.ADMIN_LOG_CHANNEL_ID} did not resolve to a channel. Exit 1.`);
          await client.destroy().catch(() => {});
          resolve(1);
          return;
        }

        const nameCache = await buildChannelNameCache(client, postable.map((p) => p.payload.channelId));
        const chName = (p) => nameCache.get(p.payload.channelId) || p.payload.channelId;

        for (const p of skippable) printLine(p, chName(p), 'SKIP(no messageUrl)');

        for (let i = 0; i < postable.length; i++) {
          const p = postable[i];
          try {
            await sendHoldReviewEmbed(client, {
              ingestId: p.ingestId,
              capperName: p.payload.capper,
              channelId: p.payload.channelId,
              aiVerdict: p.payload.reason,
              sample: p.payload.sample,
              messageUrl: p.messageUrl,
            });
            posted++;
            printLine(p, chName(p), 'POSTED');
          } catch (e) {
            failed++;
            printLine(p, chName(p), `FAILED(${e.message})`);
          }
          if (i < postable.length - 1) await sleep(POST_DELAY_MS);
        }
      } catch (err) {
        console.error('[backfill] fatal during posting:', err.message);
      } finally {
        console.log(`\nTotal holds found: ${plan.length}, posted: ${posted}, failed: ${failed}, skipped: ${skipped}`);
        await client.destroy().catch(() => {});
        resolve(failed > 0 ? 1 : 0);
      }
    });

    client.login(process.env.DISCORD_TOKEN).catch((e) => {
      console.error('[backfill] login failed:', e.message);
      resolve(1);
    });
  });
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  parseArgs,
  parsePayload,
  loadUnresolvedHoldsSince,
  buildPlan,
  SINCE_EPOCH,
  SINCE_ISO,
};
