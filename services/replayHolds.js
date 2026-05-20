// services/replayHolds.js
// Powers `/admin replay-holds`: re-emits the v463 MANUAL_REVIEW_HOLD admin embed
// for unresolved hold rows in pipeline_events so the backlog can be cleared with
// the existing Release / Dismiss button machinery in services/holdReview.js.
//
// Key invariants (see prompts/replay-holds-command.md):
//   - Button customIds are byte-identical to v463: `hold:release:<ingestId>` /
//     `hold:dismiss:<ingestId>` + a View Original link. holdReview.js parses these
//     unchanged. ingest_id is preserved, so Release/Dismiss act on the original row.
//   - No new MANUAL_REVIEW_HOLD rows are written. Replay is read-only against the
//     pipeline_events table; the only writes happen later, when the admin clicks a
//     button (handled entirely by holdReview.js).
//   - created_at is INTEGER unix-epoch seconds (migration 018); we filter with
//     epoch math, never datetime('now', ...) strings.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
// `db` is lazy-required inside replayUnresolvedHolds so importing this module for
// the pure helpers (guessDisposition etc.) doesn't boot the SQLite layer.

// Pattern-based guess at what a held slip actually is. Informational ONLY — it
// drives the embed color + description line so a human can triage 20+ holds fast,
// but it never auto-decides. The admin still clicks Release or Dismiss.
function guessDisposition(text) {
  const t = (text || '').toLowerCase();
  // Recap patterns
  if (/\b(cashed|hit|won|lost|fell short|came up short|yesterday|last night|recap)\b/.test(t)) {
    return { hint: 'Looks like a recap (past-tense / "yesterday" / "cashed")', color: 0x6c757d };
  }
  // Promo patterns
  if (/\b(bank builder|profit boost|sheet|algorithm|fanduel|draftkings|hit ❤️|hit heart|load here)\b/.test(t)) {
    return { hint: 'Looks like promo / sheet / marketing', color: 0x6c757d };
  }
  // Sweat / commentary
  if (/\b(needed for this to cash|is there time|let'?s go|sweat|if these guys|if he hits)\b/.test(t)) {
    return { hint: 'Looks like sweat / commentary on existing bet', color: 0x6c757d };
  }
  // Empty text usually means image-only HRB slip
  if (!t.trim()) {
    return { hint: 'Image-only slip — check attachment', color: 0xF59E0B };
  }
  // Default: looks like a real pick
  return { hint: 'No obvious recap/promo markers — likely a pick', color: 0xF59E0B };
}

// First image attachment on the re-fetched Discord message, if any.
function firstImageUrl(message) {
  if (!message?.attachments?.size) return null;
  const img = [...message.attachments.values()].find(a =>
    (a.contentType && a.contentType.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url || a.name || '')
  );
  return img?.url || null;
}

// Build the richer-than-live replay embed.
//
// DEVIATION from the spec's literal field list: the spec asks for a "Full text"
// field capped at 4000 chars, but Discord caps a single embed field value at
// 1024 chars (a 4000-char field makes the API reject the whole message). The
// embed *description* caps at 4096, so the full slip text lives there — led by
// the italic heuristic hint line — which is the only place the spec's intended
// ~4000-char body actually fits. All other fields match the spec.
function buildReplayEmbed(originalMessage, payload, createdAt, ingestId) {
  const fullText = (originalMessage?.content || payload?.sample || '').trim();
  const { hint, color } = guessDisposition(fullText);

  const hintLine = `_${hint}_`;
  const body = fullText ? `\n\n${fullText.slice(0, 3800)}` : '';
  const description = (hintLine + body).slice(0, 4096);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('⚠️ Slip Held for Review (replay)')
    .setDescription(description)
    .addFields(
      { name: 'Capper', value: (payload?.capper || 'unknown').slice(0, 256), inline: true },
      { name: 'Channel', value: payload?.channelId ? `<#${payload.channelId}>` : 'unknown', inline: true },
      { name: 'Held', value: `<t:${createdAt}:R>` },
      { name: 'AI verdict', value: (payload?.reason || 'unknown').slice(0, 1024) },
    )
    .setFooter({ text: `ingest_id: ${ingestId}` });

  const img = firstImageUrl(originalMessage);
  if (img) embed.setImage(img);

  return embed;
}

// Buttons identical to v463 so holdReview.js handles them with zero changes.
// View Original is only added when we have a valid URL (older rows may lack one;
// .setURL throws on an empty/invalid URL).
function buildReplayButtons(ingestId, messageUrl) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hold:release:${ingestId}`).setLabel('Release as Bet').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hold:dismiss:${ingestId}`).setLabel('Dismiss as Non-Bet').setStyle(ButtonStyle.Secondary),
  );
  if (messageUrl && /^https?:\/\//.test(messageUrl)) {
    row.addComponents(new ButtonBuilder().setLabel('View Original').setStyle(ButtonStyle.Link).setURL(messageUrl));
  }
  return [row];
}

function parsePayload(raw) {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) || {};
  } catch (_) {
    return {};
  }
}

// Re-fetch the original Discord message so we can show full text + inline image.
// Falls back to null (caller uses payload.sample) on any failure.
async function refetchOriginal(client, messageUrl) {
  const urlMatch = messageUrl?.match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (!urlMatch) return null;
  const [, channelId, messageId] = urlMatch;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

/**
 * Re-emit hold embeds for unresolved MANUAL_REVIEW_HOLD rows.
 *
 * @param {object}  args
 * @param {import('discord.js').Client} args.client
 * @param {number}  args.hoursBack        how far back to scan (epoch-seconds window)
 * @param {boolean} args.includeResolved  also re-post already released/dismissed holds
 * @returns {Promise<{found:number, skipped:number, replayed:number, error?:string}>}
 */
async function replayUnresolvedHolds({ client, hoursBack = 24, includeResolved = false } = {}) {
  const adminLogId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogId) return { found: 0, skipped: 0, replayed: 0, error: 'ADMIN_LOG_CHANNEL_ID not set' };
  const adminLog = await client.channels.fetch(adminLogId).catch(() => null);
  if (!adminLog) return { found: 0, skipped: 0, replayed: 0, error: 'admin-log channel not reachable' };

  const { db } = require('./database');
  const cutoff = Math.floor(Date.now() / 1000) - hoursBack * 3600;

  const rows = db.prepare(`
    SELECT ingest_id, payload, created_at
    FROM pipeline_events
    WHERE stage = 'MANUAL_REVIEW_HOLD'
      AND created_at >= ?
    ORDER BY created_at DESC
  `).all(cutoff);

  // Collapse duplicate holds for the same ingest_id (keep the most recent — rows
  // are DESC) so a slip that was held twice isn't double-posted.
  const seen = new Set();
  const holds = [];
  for (const r of rows) {
    if (r.ingest_id && seen.has(r.ingest_id)) continue;
    if (r.ingest_id) seen.add(r.ingest_id);
    holds.push(r);
  }

  const resolvedStmt = db.prepare(`
    SELECT 1 FROM pipeline_events
    WHERE ingest_id = ?
      AND stage IN ('MANUAL_REVIEW_RELEASED', 'MANUAL_REVIEW_DISMISSED')
      AND created_at > ?
    LIMIT 1
  `);

  let skipped = 0;
  let replayed = 0;

  for (const hold of holds) {
    const ingestId = hold.ingest_id;
    const payload = parsePayload(hold.payload);

    if (!includeResolved && ingestId && resolvedStmt.get(ingestId, hold.created_at)) {
      skipped++;
      continue;
    }

    let originalMessage = null;
    if (payload.messageUrl) {
      originalMessage = await refetchOriginal(client, payload.messageUrl);
      if (!originalMessage) {
        console.warn(`[ReplayHolds] Could not re-fetch original message for ${ingestId} — falling back to payload.sample`);
      }
    }

    const embed = buildReplayEmbed(originalMessage, payload, hold.created_at, ingestId);
    const components = buildReplayButtons(ingestId, payload.messageUrl);

    try {
      await adminLog.send({ embeds: [embed], components });
      replayed++;
    } catch (err) {
      console.error(`[ReplayHolds] Failed to post replay for ${ingestId}: ${err.message}`);
    }

    // Conservative against Discord's 5 req/s channel limit.
    await new Promise(r => setTimeout(r, 1500));
  }

  return { found: holds.length, skipped, replayed };
}

module.exports = { replayUnresolvedHolds, buildReplayEmbed, guessDisposition, buildReplayButtons };
