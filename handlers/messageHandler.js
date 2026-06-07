const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { parseBetText, evaluateTweet, validateParsedBet } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs, isAuditMode, findPendingBetBySubject, gradeBet: gradeBetRecord, getBankroll, updateBankroll, db } = require('../services/database');
const { betEmbed } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');
const { sendStagingEmbed } = require('../services/warRoom');
const { extractTextFromImage } = require('../services/ocr');
const { gradeFromCelebration, finalizeBetGrading, calcProfit, canFinalizeBet, scheduleRecheckAfterDenial } = require('../services/grading');
const { recordStage, recordDrop, recordError, makeIngestId } = require('../services/pipeline-events');
const ocrFirstWiring = require('../services/ocrFirstWiring');

// Sends the admin-log embed for MANUAL_REVIEW_HOLD with Release/Dismiss/View Original buttons.
// Replaces the old plain-text notification so the admin can act on the hold from Discord.
async function sendHoldReviewEmbed(client, { ingestId, capperName, channelId, aiVerdict, sample, messageUrl }) {
  const adminLogId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogId) return;
  const adminLog = await client.channels.fetch(adminLogId).catch(() => null);
  if (!adminLog) return;

  const embed = new EmbedBuilder()
    .setColor(0xF59E0B)
    .setTitle('⚠️ Slip Held for Review')
    .addFields(
      { name: 'Capper', value: capperName || 'unknown', inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'AI verdict', value: aiVerdict || 'unknown' },
      { name: 'Sample', value: (sample || '').slice(0, 200) || '(empty)' },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hold:release:${ingestId}`).setLabel('Release as Bet').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hold:dismiss:${ingestId}`).setLabel('Dismiss as Non-Bet').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('View Original').setStyle(ButtonStyle.Link).setURL(messageUrl),
  );

  await adminLog.send({ embeds: [embed], components: [row] });
}

// Invariant: PARSED payload's `type` and `betCount` derive from the same
// `parsed` object and cannot disagree by construction. The legacy `isBet`
// field was redundant with `betCount > 0` and went stale because
// `normalizeParsedBets` strips `is_bet`, so it has been removed.
function buildParsedPayload(parsed) {
  return {
    type: parsed?.type || 'bet',
    betCount: parsed?.bets?.length || 0,
    ticketStatus: parsed?.ticket_status || 'new',
  };
}

// ── Dedup guard: prevent double-processing of the same Discord message ──
const processedMessages = new Set();

// ── Strict Mode alert cooldowns: prevent spamming admin_log ──
const alertCooldowns = new Map();
const COOLDOWN_DURATION = 5 * 60 * 1000; // 5 minutes
// Prune stale cooldowns every 10 min to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of alertCooldowns) { if (now - v > COOLDOWN_DURATION * 2) alertCooldowns.delete(k); }
}, 10 * 60 * 1000);

// ── Message Aggregation Buffer ──────────────────────────────────
// TweetShift sends text + image as separate messages a split-second apart.
// We buffer messages by user+channel for 4 seconds, then process as one.
const BUFFER_DELAY_MS = 4000;
const messageBuffer = new Map(); // key: `${userId}:${channelId}` → { texts, images, messages, timer }

function bufferMessage(message) {
  const key = `${message.author.id}:${message.channel.id}`;
  const images = getImageAttachments(message);
  const ingestId = makeIngestId('discord', message.id);
  // Mark the buffered stage for every underlying source_ref — aggregated
  // buffers still emit one event per originating message so the trace
  // stays attributable.
  recordStage({
    ingestId,
    sourceType: 'discord',
    sourceRef: message.id,
    stage: 'BUFFERED',
    eventType: 'STAGE_ENTER',
    payload: { channelId: message.channel?.id, authorTag: message.author?.tag },
  });

  if (messageBuffer.has(key)) {
    // Append to existing buffer
    const entry = messageBuffer.get(key);
    if (message.content?.trim()) entry.texts.push(message.content.trim());
    entry.images.push(...images);
    entry.messages.push(message);
    entry.ingestIds.push(ingestId);
    for (const embed of message.embeds) {
      if (embed.description) entry.texts.push(embed.description);
      if (embed.title) entry.texts.push(embed.title);
    }
    // Reset the timer — wait another 4s for more messages
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushBuffer(key), BUFFER_DELAY_MS);
    return;
  }

  // Create new buffer entry
  const texts = [];
  if (message.content?.trim()) texts.push(message.content.trim());
  for (const embed of message.embeds) {
    if (embed.description) texts.push(embed.description);
    if (embed.title) texts.push(embed.title);
  }

  const entry = { texts, images: [...images], messages: [message], ingestIds: [ingestId], timer: null };
  entry.timer = setTimeout(() => flushBuffer(key), BUFFER_DELAY_MS);
  messageBuffer.set(key, entry);
}

async function flushBuffer(key) {
  const entry = messageBuffer.get(key);
  messageBuffer.delete(key);
  if (!entry || entry.messages.length === 0) return;

  const primaryMessage = entry.messages[0];
  const ingestIds = entry.ingestIds?.length ? entry.ingestIds : [makeIngestId('discord', primaryMessage.id)];
  const primaryIngestId = ingestIds[0];

  // Re-fetch all messages to pick up late-loading FxTwitter/vxtwitter embeds
  const texts = [];
  let allImages = [...entry.images];
  for (const msg of entry.messages) {
    try {
      const fresh = await msg.channel.messages.fetch(msg.id);
      if (fresh.content?.trim()) texts.push(fresh.content.trim());
      for (const embed of fresh.embeds) {
        if (embed.description) texts.push(embed.description);
        if (embed.title) texts.push(embed.title);
      }
      // Pick up any images from embeds that loaded late (e.g., Twitter card images)
      const freshImages = getImageAttachments(fresh);
      if (freshImages.length > allImages.length) allImages = freshImages;
    } catch (err) {
      // Fallback: use original cached message object (link fixer may have deleted it)
      console.log(`[Buffer] Re-fetch failed for ${msg.id}: ${err.message} — using cached data`);
      if (msg.content?.trim()) texts.push(msg.content.trim());
      for (const embed of (msg.embeds || [])) {
        if (embed.description) texts.push(embed.description);
        if (embed.title) texts.push(embed.title);
      }
      const cachedImages = getImageAttachments(msg);
      if (cachedImages.length > allImages.length) allImages = cachedImages;
    }
  }

  const combinedText = texts.join('\n');
  const combinedImages = allImages;

  try {
    await processAggregatedMessage(primaryMessage, combinedText, combinedImages, { ingestIds, primaryIngestId });
  } catch (err) {
    if (err.message === 'DUPLICATE_IMAGE_DETECTED') {
      console.log('[Dedup] Duplicate image in buffer — skipping silently.');
      for (const id of ingestIds) {
        recordDrop({
          ingestId: id,
          sourceType: 'discord',
          sourceRef: id.replace(/^disc_/, ''),
          stage: 'DROPPED',
          dropReason: 'DUPLICATE_IMAGE',
          payload: { where: 'flushBuffer' },
        });
      }
      return;
    }
    console.error('[Buffer] Error processing aggregated message:', err.message);
    for (const id of ingestIds) {
      recordError({
        ingestId: id,
        sourceType: 'discord',
        sourceRef: id.replace(/^disc_/, ''),
        stage: 'BUFFERED',
        error: err,
        payload: { where: 'flushBuffer' },
      });
    }
  }
}

// ── Hard Scrub: strip TweetShift markdown and junk before AI parsing ──
function hardScrub(text) {
  return text
    .replace(/\[Quoted\]\([^)]*\)/gi, '')           // [Quoted](url)
    .replace(/\[@[^\]]*\]\([^)]*\)/g, '')            // [@username](url)
    .replace(/\[[^\]]*\]\(https?:\/\/[^)]*\)/g, '')  // any [text](url) markdown link
    .replace(/Retweeted @\w+/gi, '')
    .replace(/Quoted @\w+/gi, '')
    .replace(/\$[\d,]+\.?\d*/g, '')                   // dollar amounts (payouts)
    .replace(/https?:\/\/\S+/g, '')                   // bare URLs
    .replace(/\n{3,}/g, '\n\n')                       // collapse excessive newlines
    .trim();
}

const PICK_SIGNALS = [
  /\b(pick|lock|potd|play|bet|wager|hammer|tail|fade)\b/i,
  /[+-]\d{3}/,
  /\d+\.?\d*\s*u\b/i,
  /\b(ml|moneyline|spread|over|under|o\/u|rl|pk)\b/i,
  /\b(parlay|teaser|prop)\b/i,
  /🔒|🔥|💰|🎯|⚡/,
  /[+-]\d+\.?\d*/,                           // any +/- number (spreads, lines)
  /\b\d+\.5\b/,                              // half-point lines (22.5, 3.5)
  /\b(unit|units)\b/i,                       // "2 units" without the 'u' shorthand
];

// ── Celebration / Result patterns — these are NOT new picks ──
const RESULT_PATTERNS = [
  /✅/,                                    // checkmarks = already graded
  /❌/,                                    // loss markers
  /\bBANG+\b/i,                           // "BANGGGGG" celebrations
  /\b(WINNER|CASHED|HIT|BOOM|CASH|WON)\b/i,
  /\bPlay\s*#\d+.*\$[\d,]+/i,            // "Play #8: $9,769" = payout summary
  /\$[\d,]{4,}/,                          // Dollar amounts over $999 = payouts not picks
  /\b\d+-\d+\s*(record|run|streak)\b/i,   // "12-3 run" = record summary
  /\b(recap|results|final|score)\b/i,     // recap/results posts
];

function looksLikeCelebration(text) {
  if (!text) return false;
  let hits = 0;
  for (const p of RESULT_PATTERNS) { if (p.test(text)) hits++; }
  return hits >= 1;
}

function looksLikePick(text) {
  if (!text) return false;
  let signals = 0;
  for (const pattern of PICK_SIGNALS) {
    if (pattern.test(text)) signals++;
  }
  return signals >= 2;
}

// ── Merge multiple image-extracted bets into a single parlay ──
// When 7 images each produce 1 bet, combine into 1 parlay with 7 legs.
function mergeBetsIntoParlay(bets) {
  const allLegs = [];
  let sport = 'Unknown';
  let totalOdds = null;
  let totalUnits = 1;
  const descriptions = [];

  for (const bet of bets) {
    if (bet.sport && bet.sport !== 'Unknown') sport = bet.sport;
    if (bet.units && bet.units > totalUnits) totalUnits = bet.units;
    if (bet.odds) totalOdds = bet.odds; // use last non-null odds as parlay odds

    // Add individual bet as a leg
    if (bet.legs?.length > 0) {
      allLegs.push(...bet.legs);
      for (const leg of bet.legs) {
        if (leg.description) descriptions.push(`• ${leg.description}`);
      }
    } else if (bet.description) {
      allLegs.push({ description: bet.description, odds: bet.odds || null, team: null, line: null, type: 'unknown' });
      descriptions.push(`• ${bet.description}`);
    }
  }

  return {
    sport,
    league: bets[0]?.league || null,
    bet_type: allLegs.length > 1 ? 'parlay' : 'straight',
    description: descriptions.join('\n'),
    odds: totalOdds,
    units: totalUnits,
    wager: bets[0]?.wager || null,
    payout: bets[0]?.payout || null,
    event_date: bets[0]?.event_date || null,
    legs: allLegs,
    _confidence: 'low',
  };
}

function getPicksChannels() {
  const raw = process.env.PICKS_CHANNEL_IDS || '';
  return raw.split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * globalPipelineGuard — unified channel + author authorization (P0 Fix 2).
 * Single source of truth for both MessageCreate and MessageUpdate paths.
 * Returns { authorized, reason, context }.
 *
 * Order of checks:
 *   1. IGNORED_CHANNELS → false/ignored_channel
 *   2. Self (our own bot user) → true/self (handleMessage should early-return
 *      on reason='self' to prevent ingestion loops)
 *   3. Any bot/webhook author → allowlist check against ALLOWED_WEBHOOK_IDS
 *      (webhook.id first, author.id second) → whitelisted_bot OR
 *      bot_not_whitelisted
 *   4. Human → channel must be in SLIP_FEED / PICKS / SUBMIT / HUMAN_SUBMISSION
 *   5. Otherwise false/channel_not_allowed
 */
function globalPipelineGuard(message) {
  const chId = message.channel?.id;
  const ignored = (process.env.IGNORED_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ignored.includes(chId)) {
    return { authorized: false, reason: 'ignored_channel', context: _guardCtx(message) };
  }

  const selfId = message.client?.user?.id;
  if (selfId && message.author?.id === selfId) {
    return { authorized: true, reason: 'self', context: _guardCtx(message, { isSelf: true, isBot: true }) };
  }

  const isBot = !!message.author?.bot || !!message.webhookId;
  if (isBot) {
    const allow = (process.env.ALLOWED_WEBHOOK_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const hit = (message.webhookId && allow.includes(message.webhookId))
      || (message.author?.id && allow.includes(message.author.id));
    if (!hit) {
      console.log(`[Guard:DENIED reason=bot_not_whitelisted channel=#${message.channel?.name} author=${message.author?.tag} webhookId=${message.webhookId || 'none'}]`);
      return { authorized: false, reason: 'bot_not_whitelisted', context: _guardCtx(message, { isBot: true }) };
    }
    // Bot allowed — but still needs to be in an authorized channel below.
  }

  const picks = (process.env.PICKS_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const humans = (process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const slip = process.env.SLIP_FEED_CHANNEL_ID;
  const submit = process.env.SUBMIT_CHANNEL_ID;
  const isSlip = chId === slip;
  const isPicks = picks.includes(chId);
  const isSubmit = !!submit && chId === submit;
  const isHuman = humans.includes(chId);

  if (!(isSlip || isPicks || isSubmit || isHuman)) {
    console.log(`[Guard:DENIED reason=channel_not_allowed channel=${chId} author=${message.author?.tag}]`);
    return { authorized: false, reason: 'channel_not_allowed', context: _guardCtx(message, { isBot }) };
  }

  return {
    authorized: true,
    reason: isBot ? 'whitelisted_bot' : 'human_ok',
    context: _guardCtx(message, { isBot, isPicksChannel: isPicks, isSlipChannel: isSlip, isHumanChannel: isHuman }),
  };
}

function _guardCtx(m, extra = {}) {
  return {
    channelId: m.channel?.id,
    channelName: m.channel?.name || 'unknown',
    author: m.author?.tag || 'Webhook',
    ...extra,
  };
}

// Parse the TWITTER_CAPPER_MAP from env (channelID:Name,channelID:Name)
// Parse capper maps from env
function getTwitterCapperMap() {
  const raw = process.env.TWITTER_CAPPER_MAP || '';
  const map = {};
  for (const pair of raw.split(',')) {
    const [channelId, name] = pair.split(':').map(s => s.trim());
    if (channelId && name) map[channelId] = name;
  }
  return map;
}

function getCapperChannelMap() {
  const raw = process.env.CAPPER_CHANNEL_MAP || '';
  const map = {};
  for (const pair of raw.split(',')) {
    const [channelId, name] = pair.split(':').map(s => s.trim());
    if (channelId && name) map[channelId] = name;
  }
  return map;
}

// Determine who the capper is — checks all maps
function resolveCapper(message) {
  const twitterMap = getTwitterCapperMap();
  const capperMap = getCapperChannelMap();

  // If this channel is a Twitter feed, attribute to the mapped capper
  if (twitterMap[message.channel.id]) {
    const capperName = twitterMap[message.channel.id];
    const fakeId = `twitter_${capperName.toLowerCase()}`;
    return { discordId: fakeId, name: capperName, avatar: null, source: 'twitter' };
  }

  // If this channel is a capper slips channel, attribute to that capper
  if (capperMap[message.channel.id]) {
    const capperName = capperMap[message.channel.id];
    const fakeId = `capper_${capperName.toLowerCase()}`;
    return { discordId: fakeId, name: capperName, avatar: null, source: 'discord' };
  }

  // Otherwise, attribute to the Discord user who posted
  return {
    discordId: message.author.id,
    name: message.author.displayName,
    avatar: message.author.displayAvatarURL(),
    source: message.author.bot ? 'bot' : 'discord',
  };
}

// `origin` tags where each image came from so OCR-first multi-image eligibility
// can count REAL slip attachments and ignore share-embed thumbnails:
//   'attachment' — a real slip image (direct message.attachments[] upload OR a
//                  forwarded snapshot attachment).
//   'embed'      — a share-card / link-preview thumbnail (message.embeds[].image
//                  or .thumbnail, incl. snapshot embeds) — NOT a real slip.
// See services/ocrFirstWiring.js eligibleImageCount. Existing callers read only
// .url/.type, so the added field is inert for them.
function getImageAttachments(message) {
  const images = [];

  // 1. Direct uploads — standard message.attachments (REAL slip attachments)
  for (const att of message.attachments.values()) {
    if (att.contentType?.startsWith('image/')) {
      images.push({ url: att.url, type: att.contentType, origin: 'attachment' });
    }
  }

  // 2. Embed images (FixTwitter, TweetShift, link previews, HRB share-card
  //    thumbnails) — previews, NOT real slip attachments.
  for (const embed of message.embeds) {
    if (embed.image?.url) images.push({ url: embed.image.url, type: 'image/png', origin: 'embed' });
    if (embed.thumbnail?.url && !embed.image) images.push({ url: embed.thumbnail.url, type: 'image/png', origin: 'embed' });
  }

  // 3. Discord Native Forwards — images live inside messageSnapshots, not attachments
  //    Always check snapshots and merge (not just when images.length === 0)
  if (message.messageSnapshots?.size > 0) {
    message.messageSnapshots.forEach(snapshot => {
      // discord.js versions differ: snapshot.message.attachments or snapshot.attachments
      const snapAtts = snapshot?.message?.attachments || snapshot?.attachments;
      if (snapAtts?.size > 0) {
        for (const att of snapAtts.values()) {
          if (att.contentType?.startsWith('image/')) {
            images.push({ url: att.url, type: att.contentType, origin: 'attachment' });
            console.log(`[Forward] Found image in snapshot: ${att.url.slice(0, 60)}...`);
          }
        }
      }
      // Also check snapshot embeds (preview thumbnails, not real slips)
      const snapEmbeds = snapshot?.message?.embeds || snapshot?.embeds || [];
      for (const embed of snapEmbeds) {
        if (embed.image?.url) images.push({ url: embed.image.url, type: 'image/png', origin: 'embed' });
      }
    });
  }

  // Deduplicate by URL — forwarded messages can duplicate the same image
  const seen = new Set();
  const unique = images.filter(img => {
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });
  return unique;
}

// Safe react — silently fails if message was deleted
async function safeReact(message, emoji) {
  try {
    await message.react(emoji);
  } catch (err) {
    if (err.code === 10008 || (err.message && err.message.includes('Unknown Message'))) {
      console.log(`[Pipeline] Cannot react (message deleted). Skipping ${emoji}.`);
    }
  }
}

// ── Shared OCR slip processing pipeline ──────────────────────
// Used by both the /slip command and the slip feed channel listener.
// Returns { bets: [...saved], ocrText } or null on failure.
async function processSlipImage(client, imageUrl, capperId, capperName, opts = {}) {
  const { channelId, messageId, sourceUrl, contextHints } = opts;
  const ingestId = opts.ingestId || makeIngestId('discord', messageId || imageUrl || 'slip');
  const sourceRef = messageId || null;

  // ── Stage 1: OCR — extract raw text from image ──
  let ocrText = '';
  try {
    console.log(`[SlipPipeline] Stage 1: OCR extracting text from image...`);
    ocrText = await extractTextFromImage(imageUrl) || '';
    console.log(`[SlipPipeline] OCR returned ${ocrText.length} chars: "${ocrText.slice(0, 80)}..."`);
  } catch (err) {
    console.log(`[SlipPipeline] OCR failed (${err.message}), falling back to vision-only.`);
  }

  // ── Stage 2: AI Vision — send image + OCR text to Gemini/fallback ──
  console.log(`[SlipPipeline] Stage 2: Sending image + OCR text to AI Vision...`);
  let contextLine = '';
  if (contextHints?.capper || contextHints?.sport) {
    const parts = [];
    if (contextHints.capper) parts.push(`capper: '${contextHints.capper}'`);
    if (contextHints.sport) parts.push(`sport: '${contextHints.sport}'`);
    contextLine = `\n\nHINT: The user has indicated this slip belongs to ${parts.join(' and ')}. Use this to guide your extraction.`;
  }
  const prompt = ocrText.length > 10
    ? `Read the attached betting slip image AND the following OCR text to extract all bets:\n\n${ocrText}${contextLine}`
    : `Read the attached betting slip image and extract all bets, players, lines, and odds.${contextLine}`;
  let parsed = await parseBetText(prompt, imageUrl, { imageUrl });

  // ── OCR-first (gated; default OFF). docs/specs/ocr-first.md §6/§8. ──
  // off: zero calls (guard short-circuits, byte-for-byte unchanged). shadow:
  // fire-and-forget compare, never mutates `parsed`, never blocks staging.
  // cutover (dormant): on USE_OCR replace `parsed` with the OCR-derived bet;
  // FALLBACK/timeout → live path unchanged. Can never break the live path.
  if (ocrFirstWiring.MODE !== 'off' && imageUrl) {
    const ocrRes = await ocrFirstWiring.applyOcrFirst({
      parsed, imageUrl, mediaType: undefined, imageCount: 1, requestId: ingestId, sourceRef,
    });
    parsed = ocrRes.parsed;
  }

  if (!parsed.bets || parsed.bets.length === 0) {
    console.log('[SlipPipeline] Stage 2: No bets found in image.');
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'VISION_EXTRACTION_FAILED', payload: { where: 'processSlipImage', parseError: parsed.error || null } });
    return { bets: [] };
  }
  recordStage({ ingestId, sourceType: 'discord', sourceRef, stage: 'PARSED', eventType: 'STAGE_ENTER', payload: { betCount: parsed.bets.length, source: 'vision_slip' } });

  console.log(`[SlipPipeline] Stage 2: AI extracted ${parsed.bets.length} bet(s).`);

  // ── Stage 3: Normalize — each bet goes through normalizeBet inside parseBetText ──
  // normalizeBet runs automatically via normalizeParsedBets() in parseBetText.
  // Log the normalized output for audit trail.
  for (const bet of parsed.bets) {
    console.log(`[SlipPipeline] Stage 3: Normalized → ${bet.sport} | ${bet.bet_type} | "${bet.description?.slice(0, 60)}" | odds:${bet.odds} | units:${bet.units}`);
  }

  // ── Stage 4: Save to DB + send to War Room ──
  const saved = [];
  for (const bet of parsed.bets) {
    // Anti-hallucination: validate parsed bet against source content.
    // Slip pipeline inherently has an image → hasMedia:true (brand-exempt).
    const slipValidation = validateParsedBet(bet, ocrText || '', { hasMedia: true });
    if (!slipValidation.valid) {
      console.log(`[Parser] SLIP bet REJECTED: ${slipValidation.reason} | desc="${(bet.description || '').slice(0, 80)}"`);
      const mappedReason = slipValidation.reason === 'leg_sport_mismatch' ? 'VALIDATOR_SPORT_MISMATCH'
        : slipValidation.reason === 'entity_mismatch' ? 'VALIDATOR_ENTITY_MISMATCH'
        : 'BOUNCER_REJECTED';
      recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: mappedReason, payload: { validator: slipValidation.reason, issues: slipValidation.issues, description: (bet.description || '').slice(0, 120) } });
      continue;
    }

    const record = await createBetWithLegs({
      capper_id: capperId,
      sport: bet.sport, league: bet.league,
      bet_type: bet.bet_type, description: bet.description,
      odds: bet.odds, units: Math.min(bet.units || 1, 50),
      wager: bet.wager || null, payout: bet.payout || null,
      event_date: bet.event_date, source: 'vision_slip',
      source_channel_id: channelId || null,
      source_message_id: messageId || null,
      source_url: sourceUrl || null,
      raw_text: (ocrText || bet.description || '').slice(0, 500),
      review_status: 'needs_review',
    }, bet.legs || [], bet.props || []);

    if (!record?._deduped) {
      recordStage({ ingestId, betId: record?.id || null, sourceType: 'discord', sourceRef, stage: 'VALIDATED', eventType: 'STAGE_EXIT', payload: { pipeline: 'slip', reviewStatus: 'needs_review' } });
      recordStage({ ingestId, betId: record?.id || null, sourceType: 'discord', sourceRef, stage: 'STAGED', eventType: 'STAGE_EXIT', payload: { pipeline: 'slip', sport: bet.sport, betType: bet.bet_type } });
      saved.push(record);
      await sendStagingEmbed(client, record, capperName, sourceUrl);
    } else {
      recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'DUPLICATE_IMAGE', payload: { pipeline: 'slip', dedup: 'fingerprint' } });
    }
  }

  console.log(`[SlipPipeline] Stage 4: Saved ${saved.length} bet(s) to DB.`);
  return { bets: saved };
}

// ── F-07: slip-feed multi-image selection (pure, exported for unit tests) ──
// A single slip-feed message can carry multiple REAL slip screenshots; the
// legacy path processed only images[0] and silently dropped the rest. These
// helpers decide which images handleSlipFeed processes and derive a per-image
// ingestId. They MUST NOT feed embed/preview thumbnails (origin:'embed' —
// FixTwitter/HRB share cards/link previews) to vision; only origin:'attachment'
// images are real slips. getImageAttachments emits exactly two origin values:
// 'attachment' (direct uploads AND native-forward snapshot images) and 'embed'.
const SLIP_IMAGE_CAP = 4;

// Returns the ordered list of images to process:
// - Any real attachments present → those, in order, capped at `cap`. (The fix.)
// - No real attachments (e.g. an embed-only HRB share) → [images[0]], i.e. EXACTLY
//   the legacy single-image behavior. Never multiply-process embed/preview images.
function selectSlipImages(images, { cap = SLIP_IMAGE_CAP } = {}) {
  const list = Array.isArray(images) ? images : [];
  const attachments = list.filter((img) => img && img.origin === 'attachment');
  if (attachments.length > 0) return attachments.slice(0, cap);
  return list.length > 0 ? [list[0]] : [];
}

// The first selected image keeps the base ingestId (so the common single-image
// path is byte-for-byte unchanged, including its pipeline-events/holds id); each
// subsequent image gets `${base}-img${i}` (i≥1) to avoid event/hold collisions.
function slipImageIngestId(baseIngestId, index) {
  return index === 0 ? baseIngestId : `${baseIngestId}-img${index}`;
}

// ── OCR Slip Feed — dedicated channel for bet slip images ───
async function handleSlipFeed(message) {
  const slipChannelId = process.env.SLIP_FEED_CHANNEL_ID;
  if (!slipChannelId || message.channel.id !== slipChannelId) return false;

  const images = getImageAttachments(message);
  if (images.length === 0) return false;

  const ingestId = makeIngestId('discord', message.id);
  const sourceRef = message.id;

  try {
    // React immediately so user knows the bot is processing
    await message.react('🔍').catch(() => {});

    const capperInfo = resolveCapper(message);
    if (!capperInfo || !capperInfo.name) {
      recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'CAPPER_UNRESOLVED', payload: { where: 'handleSlipFeed' } });
      return true;
    }
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);

    // F-07: process every REAL slip attachment, not just images[0]. selectSlipImages
    // collapses to the legacy single call for N=1 / embed-only (base ingestId), and
    // returns all real attachments (capped) when a capper posts multiple slips.
    const selected = selectSlipImages(images);
    const attachmentCount = images.filter((img) => img && img.origin === 'attachment').length;
    if (attachmentCount > SLIP_IMAGE_CAP) {
      console.warn(`[SlipFeed] ${attachmentCount} real slip attachments exceed cap ${SLIP_IMAGE_CAP}; processing first ${SLIP_IMAGE_CAP}, dropping ${attachmentCount - SLIP_IMAGE_CAP}.`);
    }

    for (let i = 0; i < selected.length; i++) {
      await processSlipImage(message.client, selected[i].url, capper.id, capperInfo.name, {
        channelId: message.channel.id,
        messageId: message.id,
        sourceUrl: message.url,
        ingestId: slipImageIngestId(ingestId, i),
      });
    }

    return true;
  } catch (err) {
    console.error('[SlipFeed] Error:', err.message);
    recordError({ ingestId, sourceType: 'discord', sourceRef, stage: 'ERROR', error: err, payload: { where: 'handleSlipFeed' } });
    return true;
  }
}

// ── Auto-Grade Engine ─────────────────────────────────────────
// Finds a matching pending bet and grades it based on outcome.
async function autoGradeBet(client, outcome, subjects) {
  if (!subjects || subjects.length === 0) return null;

  const bet = findPendingBetBySubject(subjects);
  if (!bet) {
    console.log(`[AutoGrade] No pending bet found for subjects: ${subjects.join(', ')}`);
    return null;
  }

  // Calculate profit/loss
  const result = outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : null;
  if (!result) return null;

  const odds = bet.odds || -110;
  const units = bet.units || 1;
  let profitUnits = 0;

  if (result === 'win') {
    profitUnits = odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
  } else {
    profitUnits = -units;
  }

  // P0 gateway — log decision, short-circuit on denial, do not increment attempts
  const gate = canFinalizeBet({ db, betId: bet.id, requestedResult: result, source: 'graphic_auto' });
  if (!gate.ok) {
    if (gate.reason === 'pending_legs') {
      scheduleRecheckAfterDenial(bet.id, `graphic_auto_pending_legs_${gate.pendingLegs}`, 30);
    }
    return null;
  }

  // Grade the bet (capper graphic = trusted path, auto-confirm)
  const gradeResult = gradeBetRecord(bet.id, result, profitUnits, null, `Auto-graded from capper graphic`, true);
  if (!gradeResult.graded) return null;

  // Update bankroll
  const bankroll = getBankroll(bet.capper_id);
  if (bankroll) {
    const unitSize = bankroll.unit_size || 25;
    updateBankroll(bet.capper_id, profitUnits * unitSize);
  }

  // Notify War Room
  const warRoomId = process.env.WAR_ROOM_CHANNEL_ID;
  if (warRoomId && client) {
    const channel = await client.channels.fetch(warRoomId).catch(() => null);
    if (channel) {
      const emoji = result === 'win' ? '✅' : '❌';
      const sign = profitUnits >= 0 ? '+' : '';
      await channel.send(
        `🤖 **Auto-Graded:** ${emoji} **${bet.description}** marked as **${result.toUpperCase()}** (${sign}${profitUnits.toFixed(2)}u) — ${bet.capper_name || 'Unknown'}\n> Based on capper graphic`
      );
    }
  }

  console.log(`[AutoGrade] Graded bet ${bet.id.slice(0, 8)} as ${result} (${profitUnits.toFixed(2)}u)`);
  return bet;
}

async function handleMessage(message, { isUpdate = false } = {}) {
  const ingestId = makeIngestId('discord', message.id);
  const sourceRef = message.id;
  recordStage({
    ingestId,
    sourceType: 'discord',
    sourceRef,
    stage: 'RECEIVED',
    eventType: 'STAGE_ENTER',
    payload: {
      channelId: message.channel?.id,
      channelName: message.channel?.name,
      authorTag: message.author?.tag,
      isUpdate,
    },
  });

  // ═══ TRACE: log EVERY message the bot sees (remove after debugging) ═══
  console.log(`[MessageHandler] ENTRY | ch=${message.channel?.name || message.channel?.id} | author=${message.author?.username} | bot=${message.author?.bot} | content=${message.content?.length || 0} | att=${message.attachments?.size || 0} | embeds=${message.embeds?.length || 0} | isUpdate=${isUpdate}`);

  // TEMP DIAG: dump full embed structure for hardrock.bet messages
  if (message.content && /hardrock\.bet/i.test(message.content)) {
    console.log(`[HRB-DIAG] hardrock.bet URL detected in message ${message.id}`);
    console.log(`[HRB-DIAG] content: ${message.content.slice(0, 200)}`);
    console.log(`[HRB-DIAG] attachments.size: ${message.attachments.size}`);
    console.log(`[HRB-DIAG] embeds.length: ${message.embeds.length}`);
    for (let i = 0; i < message.embeds.length; i++) {
      const e = message.embeds[i];
      console.log(`[HRB-DIAG] embed[${i}] type=${e.type} url=${e.url || 'none'}`);
      console.log(`[HRB-DIAG] embed[${i}] title=${e.title || 'none'}`);
      console.log(`[HRB-DIAG] embed[${i}] description=${(e.description || '').slice(0, 100)}`);
      console.log(`[HRB-DIAG] embed[${i}] image.url=${e.image?.url || 'none'}`);
      console.log(`[HRB-DIAG] embed[${i}] thumbnail.url=${e.thumbnail?.url || 'none'}`);
      console.log(`[HRB-DIAG] embed[${i}] author=${e.author?.name || 'none'}`);
      console.log(`[HRB-DIAG] embed[${i}] fields=${e.fields?.length || 0}`);
    }
    if (message.attachments.size > 0) {
      for (const att of message.attachments.values()) {
        console.log(`[HRB-DIAG] attachment: url=${att.url} contentType=${att.contentType} size=${att.size}`);
      }
    }
  }

  if (!message.guild) return;

  // ═══ PARTIAL FETCH: ensure forwarded/partial messages are fully loaded ═══
  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      console.error('[PARTIAL_FETCH_ERROR]', err.message);
      return;
    }
  }

  // ═══ DEDUP GUARD ═══
  // For MessageUpdate (embed unfurl), use a separate key so it bypasses the Create dedup
  const dedupKey = isUpdate ? `update:${message.id}` : message.id;
  if (processedMessages.has(dedupKey)) return;
  processedMessages.add(dedupKey);
  setTimeout(() => processedMessages.delete(dedupKey), 10_000);

  // ═══ GUARD 0: Global Pipeline Guard — single source of truth (P0 Fix 2) ═══
  const { authorized, reason, context } = globalPipelineGuard(message);
  if (!authorized) {
    // Strict Mode: alert admin (rate-limited per channel to prevent spam)
    if (process.env.STRICT_MODE === 'true' && process.env.ADMIN_LOG_CHANNEL_ID) {
      const lastAlert = alertCooldowns.get(context.channelId) || 0;
      if (Date.now() - lastAlert > COOLDOWN_DURATION) {
        alertCooldowns.set(context.channelId, Date.now());
        const adminCh = message.client.channels.cache.get(process.env.ADMIN_LOG_CHANNEL_ID);
        if (adminCh) {
          adminCh.send(
            `⚠️ **Unauthorized Pipeline Trigger**\n**Channel:** #${context.channelName} (\`${context.channelId}\`)\n**User:** ${context.author}\n**Reason:** \`${reason}\`\n*Action: Message discarded before AI/OCR.*`
          ).catch(() => {});
        }
      }
    }
    const dropReason = reason === 'bot_not_whitelisted' ? 'BOUNCER_REJECTED' : 'CHANNEL_UNAUTHORIZED';
    recordDrop({
      ingestId,
      sourceType: 'discord',
      sourceRef,
      stage: 'DROPPED',
      dropReason,
      payload: { guardReason: reason, channelId: context.channelId, channelName: context.channelName, author: context.author },
    });
    return; // HARD STOP
  }

  // ═══ Self-loop prevention: guard authorizes the bot's own messages for
  //     sanity (e.g. edits), but we never re-ingest them. ═══
  if (reason === 'self') {
    recordDrop({
      ingestId,
      sourceType: 'discord',
      sourceRef,
      stage: 'DROPPED',
      dropReason: 'BOUNCER_REJECTED',
      payload: { guardReason: 'self' },
    });
    return;
  }

  recordStage({
    ingestId,
    sourceType: 'discord',
    sourceRef,
    stage: 'AUTHORIZED',
    eventType: 'STAGE_ENTER',
    payload: { guardReason: reason, channelId: context.channelId, channelName: context.channelName },
  });

  // ═══ Combine message content + embed text (FixTwitter puts tweet text in embeds) ═══
  const rawContent = message.content || '';
  const embedText = message.embeds.map(e => [e.description, e.title].filter(Boolean).join(' ')).join(' ');
  const fullContent = (rawContent + ' ' + embedText).trim();

  console.log(`[DEBUG] handleMessage | embeds: ${message.embeds.length} | isUpdate: ${isUpdate} | fullContent(${fullContent.length}): "${fullContent.slice(0, 80)}"`);

  // ═══ HARD FILTER: Reject fan replies (RT filter removed — cappers retweet their own slips) ═══
  if (/\breplying\s+to\b/i.test(fullContent)) {
    console.log('[DEBUG] Rejected by Hard Filter: replying to');
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'BOUNCER_REJECTED', payload: { hardFilter: 'replying_to' } });
    return;
  }
  if (/vxtwitter\.com|fixupx\.com/i.test(rawContent) && !/\b(pick|lock|play|bet)\b/i.test(fullContent)) {
    console.log('[DEBUG] Rejected by Hard Filter: vxtwitter without pick signal');
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { hardFilter: 'vxtwitter_no_pick' } });
    return;
  }

  // ═══ OCR Slip Feed — check before picks channel guard ═══
  const slipHandled = await handleSlipFeed(message);
  if (slipHandled) return;

  // ═══ GUARD 2: Resolve channel mapping (for capper attribution) ═══
  // Channel authorization already handled by globalPipelineGuard above.
  const twitterMap = getTwitterCapperMap();
  const capperMap = getCapperChannelMap();
  const isTwitterFeed = !!twitterMap[message.channel.id];
  const isMappedCapper = !!capperMap[message.channel.id];
  const isMappedChannel = isTwitterFeed || isMappedCapper;
  // Bot/webhook authorization — handled by globalPipelineGuard via
  // ALLOWED_WEBHOOK_IDS. Only unauthorized bots reach here (impossible
  // because guard would have dropped them); self-skip via reason='self'.

  // ═══ GUARD 3: Skip replies in mapped capper channels (prevents tail-loops) ═══
  if (isMappedChannel && message.reference) {
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'BOUNCER_REJECTED', payload: { guardReason: 'mapped_channel_reply' } });
    return;
  }

  // ═══ GUARD 4: Skip old messages (only process last 2 min) ═══
  const msgAge = Date.now() - message.createdTimestamp;
  if (msgAge > 2 * 60 * 1000) {
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'AGE_GATE', payload: { ageMs: msgAge } });
    return;
  }

  const hasText = fullContent.length > 0;
  const images = getImageAttachments(message);
  const hasImages = images.length > 0;

  // ═══ GUARD: Image-only messages from non-cappers are ignored ═══
  // BYPASS: #submit-picks, HUMAN_SUBMISSION_CHANNEL_IDS, sportsbook URLs
  const isSubmitChannel = process.env.SUBMIT_CHANNEL_ID && message.channel.id === process.env.SUBMIT_CHANNEL_ID;
  const humanChannels = (process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const isHumanSubmitChannel = humanChannels.includes(message.channel.id);
  const SPORTSBOOK_URLS = /share\.hardrock\.bet|draftkings\.com|sportsbook\.fanduel\.com|caesars\.com\/sportsbook|betmgm\.com|prizepicks\.com|underdogfantasy\.com/i;
  const hasSportsbookUrl = SPORTSBOOK_URLS.test(fullContent);
  if (hasImages && !hasText && !isSubmitChannel && !isHumanSubmitChannel && !hasSportsbookUrl) {
    const isBot = message.author.bot || !!message.webhookId;
    const capperIds = (process.env.CAPPER_DISCORD_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
    const isWhitelisted = isMappedChannel || isBot || capperIds.includes(message.author.id);
    if (!isWhitelisted) {
      console.log(`[Guard] Ignored image-only msg from non-capper ${message.author.tag} in #${message.channel.name}`);
      recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'BOUNCER_REJECTED', payload: { guardReason: 'image_only_non_capper', channelName: message.channel?.name } });
      return;
    }
  }
  // Also allow through if text has sportsbook URL (even without images — embed will load later)
  if (hasSportsbookUrl && !hasImages) {
    console.log(`[Pipeline] Sportsbook URL detected from ${message.author.tag} — waiting for embed unfurl`);
  }

  console.log(`[DEBUG] Msg in #${message.channel.name} | Attachments: ${message.attachments.size} | Snapshots: ${message.messageSnapshots?.size || 0} | Images Extracted: ${images.length}`);

  // fullText = message.content + embed descriptions (already built above as fullContent)
  const fullText = fullContent;

  // ═══ DUBCLUB SPLIT BYPASS ═══
  // DubClub split-channel webhooks are pre-filtered at the bridge (splitIntoPicks)
  // and are one-pick-per-message. Bypass BOTH the GUARD 5 signal filter (which
  // drops bare totals like "Cubs Cardinals O8") AND the 4s aggregation buffer
  // (which would re-merge the split posts). Must run before GUARD 5.
  const dubclubSplitChannels = (process.env.DUBCLUB_SPLIT_CHANNEL_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const isDubclubSplit =
    (message.webhookId || message.author?.bot) &&
    dubclubSplitChannels.includes(message.channel?.id);
  if (isDubclubSplit) {
    console.log(`[DubclubSplit] Bypassing buffer + GUARD 5 for webhook pick in #${message.channel?.name} (msg=${message.id})`);
    try {
      await processAggregatedMessage(message, fullText, [], { ingestIds: [ingestId], primaryIngestId: ingestId });
    } catch (err) {
      console.error(`[DubclubSplit] processAggregatedMessage failed for ${message.id}: ${err.message}`);
    }
    return;
  }

  // ═══ GUARD 5: Must have SOME signal — text signals, images, or celebration keywords ═══
  // All messages go to the buffer. The AI decides type (bet, result, untracked_win, ignore).
  const textIsPick = looksLikePick(fullText);
  const textIsCelebration = looksLikeCelebration(fullText);
  if (!textIsPick && !textIsCelebration && !hasImages) {
    recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { textLen: fullText.length } });
    return;
  }

  // ═══ BUFFER: Aggregate text + image from split TweetShift messages ═══
  bufferMessage(message);
}

// ═══════════════════════════════════════════════════════════════
// processAggregatedMessage — runs after the 4-second buffer flushes
// Receives the combined text + images from all buffered messages.
// ═══════════════════════════════════════════════════════════════
async function processAggregatedMessage(message, combinedRawText, combinedImages, opts = {}) {
  const hasImages = combinedImages.length > 0;
  const fullText = combinedRawText;
  const ingestId = opts.primaryIngestId || makeIngestId('discord', message.id);
  const ingestIds = opts.ingestIds?.length ? opts.ingestIds : [ingestId];
  const sourceRef = message.id;

  // Helper: emit a drop against every underlying source_ref in the buffer
  // so aggregated batches do not hide individual messages.
  const dropAll = (stage, dropReason, payload = {}) => {
    for (const id of ingestIds) {
      recordDrop({ ingestId: id, sourceType: 'discord', sourceRef: id.replace(/^disc_/, ''), stage, dropReason, payload });
    }
  };
  const stageAll = (stage, payload = {}) => {
    for (const id of ingestIds) {
      recordStage({ ingestId: id, sourceType: 'discord', sourceRef: id.replace(/^disc_/, ''), stage, eventType: 'STAGE_ENTER', payload });
    }
  };

  try {
    const capperInfo = resolveCapper(message);
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);
    const source = capperInfo.source;
    const allBets = [];
    const reviewBets = [];

    // Extract source tweet data from Discord embed URLs (TweetShift/FixTwitter)
    let sourceTweetId = null;
    let sourceTweetHandle = null;
    for (const embed of (message.embeds || [])) {
      const url = embed.url || '';
      const match = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/);
      if (match) {
        sourceTweetHandle = match[1].toLowerCase();
        sourceTweetId = match[2];
        break;
      }
    }

    // Hard Scrub the text
    const cleanText = hardScrub(fullText);

    // ═══ Multi-image loop: process EVERY image attachment, not just the first ═══
    const imageUrls = hasImages ? combinedImages.map(img => img.url) : [];
    const textPrompt = cleanText || 'Read the attached betting slip image and extract all bets.';

    // Merge results from all images into a single parsed object
    let parsed = { type: 'ignore', is_bet: false, bets: [], ticket_status: 'new' };

    if (cleanText.length > 5 || imageUrls.length > 0) {
      // ── Pre-filter: check BOTH combined text AND outer wrapper for settled markers ──
      // Outer wrapper = message.content (before embed text). If wrapper has ✅, this is a recap.
      const outerText = hardScrub(combinedRawText.split('\n')[0] || '');
      if (/✅|❌|✔|✓/.test(outerText)) {
        console.log(`[Filter] Outer wrapper has settled marker: "${outerText.slice(0, 60)}" — rejecting`);
        dropAll('DROPPED', 'PRE_FILTER_NO_BET_CONTENT', { filter: 'outer_settled_marker', sample: outerText.slice(0, 80) });
        return;
      }
      if (cleanText.length > 5) {
        const preCheck = evaluateTweet(cleanText);
        if (preCheck === 'reject_settled') {
          console.log(`[Filter] Pre-filter: settled recap (all ✅) — skipping AI`);
          dropAll('DROPPED', 'PRE_FILTER_NO_BET_CONTENT', { filter: 'evaluateTweet_reject_settled' });
          return;
        }
      }

      if (imageUrls.length <= 1) {
        // Single image (or text-only) — normal path
        const imageUrl = imageUrls[0] || null;
        console.log(`[DEBUG] Sending to AI. Text length: ${cleanText.length} | hasImage: ${!!imageUrl} | preview: "${cleanText.slice(0, 100)}"`);
        if (imageUrl) stageAll('EXTRACTED', { imageCount: 1, imageUrl: imageUrl.slice(0, 120) });
        parsed = await parseBetText(textPrompt, imageUrl, { imageUrl });
      } else {
        // Multiple images — process each sequentially then merge
        console.log(`[DEBUG] Processing ${imageUrls.length} images sequentially...`);
        stageAll('EXTRACTED', { imageCount: imageUrls.length });
        const mergedBets = [];
        let mergedTicketStatus = 'new';
        let mergedType = 'ignore';

        for (let i = 0; i < imageUrls.length; i++) {
          console.log(`[DEBUG] Image ${i + 1}/${imageUrls.length}: ${imageUrls[i].slice(0, 60)}...`);
          const imgParsed = await parseBetText(textPrompt, imageUrls[i], { imageUrl: imageUrls[i] });
          console.log(`[DEBUG] Image ${i + 1} result: type=${imgParsed.type} bets=${imgParsed.bets?.length || 0} ticket_status=${imgParsed.ticket_status || 'new'}`);

          if (imgParsed.bets?.length > 0) mergedBets.push(...imgParsed.bets);
          // Promote type: bet > result > untracked_win > ignore
          if (imgParsed.type === 'bet' || imgParsed.is_bet) mergedType = 'bet';
          else if (imgParsed.type === 'result' && mergedType !== 'bet') mergedType = 'result';
          // Promote ticket_status: winner/loser overrides new
          if (imgParsed.ticket_status === 'winner' || imgParsed.ticket_status === 'loser') {
            mergedTicketStatus = imgParsed.ticket_status;
          }
          // Carry forward result/untracked_win fields
          if (imgParsed.type === 'result' || imgParsed.type === 'untracked_win') {
            parsed = imgParsed; // keep the last non-bet result for handling below
          }
        }

        // If any image had bets, merge them all
        if (mergedBets.length > 0) {
          parsed = { type: mergedType, is_bet: true, bets: mergedBets, ticket_status: mergedTicketStatus };
        }
      }

      console.log(`[DEBUG] AI Response: type=${parsed.type || 'bet'} is_bet=${parsed.is_bet} bets=${parsed.bets?.length || 0} ticket_status=${parsed.ticket_status || 'new'}`);
      stageAll('PARSED', buildParsedPayload(parsed));

      // ── OCR-first (gated; default OFF). docs/specs/ocr-first.md §6/§8. ──
      // Primary production slip seam (pure-slip capper channels flow here). off:
      // zero calls (guard short-circuits, byte-for-byte unchanged). shadow:
      // fire-and-forget compare vs the live vision parse, never mutates `parsed`,
      // adds ZERO latency to staging. cutover (dormant): on USE_OCR replace
      // `parsed` with the OCR-derived bet so it flows into the existing staging
      // block below; FALLBACK/timeout → live path unchanged. Can never break it.
      if (ocrFirstWiring.MODE !== 'off' && imageUrls.length > 0) {
        const ocrRes = await ocrFirstWiring.applyOcrFirst({
          parsed,
          imageUrl: imageUrls[0],
          mediaType: combinedImages[0]?.type,
          // Count REAL slip attachments, not share-embed thumbnails: an HRB
          // slip+embed collapses to 1 (scope=single) while a true 2-attachment
          // post stays multi. eligibleImageCount fails safe to imageUrls.length.
          imageCount: ocrFirstWiring.eligibleImageCount(combinedImages),
          requestId: ingestId,
          sourceRef,
        });
        parsed = ocrRes.parsed;
      }

      // Auto-grade detection
      if (parsed.type === 'result') {
        console.log(`[AutoGrade] AI detected result: ${parsed.outcome} for ${parsed.subject?.join(', ')}`);
        await autoGradeBet(message.client, parsed.outcome, parsed.subject || []);
        return;
      }

      // Untracked winner — send yellow embed to War Room
      if (parsed.type === 'untracked_win') {
        console.log(`[UntrackedWin] Detected: ${parsed.description}`);

        // Determine source URL. Two cases:
        //   (a) Twitter-vision relay from mobile-ingest: message has an embed
        //       whose URL points to the original tweet.
        //   (b) Native Discord message in a capper channel: construct the
        //       discord.com deep-link so admins can jump to the source post.
        let sourceUrl = null;
        let sourceLabel = null;
        try {
          // Check for a tweet URL in message embeds first (relay case)
          const tweetEmbed = (message.embeds || []).find(e => {
            const u = e?.url || '';
            return u.includes('x.com/') || u.includes('twitter.com/');
          });
          if (tweetEmbed?.url) {
            sourceUrl = tweetEmbed.url;
            // Extract handle for label: https://x.com/<handle>/status/<id>
            const handleMatch = tweetEmbed.url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status/);
            sourceLabel = handleMatch ? `Tweet by @${handleMatch[1]}` : 'Tweet';
          } else if (message.guildId && message.channelId && message.id) {
            // Native Discord message
            sourceUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
            const chName = message.channel?.name || 'channel';
            sourceLabel = `Discord #${chName}`;
          }
        } catch (e) {
          console.warn('[UntrackedWin] source URL construction failed:', e.message);
        }

        const { sendUntrackedWinEmbed } = require('../services/warRoom');
        await sendUntrackedWinEmbed(message.client, {
          description: parsed.description,
          outcome: parsed.outcome || 'win',
          subject: parsed.subject || [],
          capperName: capperInfo.name,
          capperId: capper.id,
          sourceUrl,
          sourceLabel,
        });
        return;
      }

      // ═══ TICKET STATUS: Auto-grade winning/losing recap slips ═══
      // Vision AI detected a completed ticket — match to pending bets and grade instantly
      if (parsed.ticket_status === 'winner' || parsed.ticket_status === 'loser') {
        const outcome = parsed.ticket_status === 'winner' ? 'win' : 'loss';
        console.log(`[RecapSlip] Detected ${parsed.ticket_status} ticket with ${parsed.bets?.length || 0} bet(s) from ${capperInfo.name}`);

        let graded = 0;
        for (const bet of (parsed.bets || [])) {
          // Build search terms from legs or description
          const searchTerms = [];
          if (bet.legs?.length > 0) {
            for (const leg of bet.legs) {
              if (leg.team) searchTerms.push(leg.team);
              if (leg.description) searchTerms.push(leg.description.split(/[•\n]/)[0].trim());
            }
          }
          if (bet.description) {
            const firstLine = bet.description.split(/[\n•]/)[0].trim();
            if (firstLine.length > 3) searchTerms.push(firstLine);
          }

          if (searchTerms.length === 0) continue;

          // Try capper-specific match first
          const contextResult = await gradeFromCelebration(message.client, capper.id, outcome, searchTerms);
          if (contextResult) {
            graded++;
            console.log(`[RecapSlip] Graded ${outcome.toUpperCase()}: "${searchTerms[0]?.slice(0, 40)}"`);
            continue;
          }

          // Fallback: global search
          const globalResult = await autoGradeBet(message.client, outcome, searchTerms);
          if (globalResult) graded++;
        }

        if (graded > 0) {
          await safeReact(message, parsed.ticket_status === 'winner' ? '✅' : '❌');
          console.log(`[RecapSlip] Auto-graded ${graded} bet(s) as ${outcome.toUpperCase()} — skipped Serper search`);
        } else {
          console.log(`[RecapSlip] No matching pending bets found for ${parsed.ticket_status} ticket`);
        }
        return;
      }

      // AI explicitly said not-a-bet.
      // Human-submission channels: hold for manual review (MANUAL_REVIEW_HOLD stage event)
      // instead of silent drop, since a real human posted to a curated capper channel.
      // All other surfaces: existing PRE_FILTER_NO_BET_CONTENT drop is correct.
      if (parsed.is_bet === false) {
        const humanChannelIds = (process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const isHumanChannel = humanChannelIds.includes(message.channel.id);
        // PR #2: pure-slip channels skip MANUAL_REVIEW_HOLD staging. Same comma-split + trim
        // contract as HUMAN_SUBMISSION_CHANNEL_IDS above; empty/unset → [] → no bypass (unchanged).
        const pureSlipChannelIds = (process.env.PURE_SLIP_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const isPureSlip = pureSlipChannelIds.includes(message.channel.id);
        if (isHumanChannel && !isPureSlip) {
          stageAll('MANUAL_REVIEW_HOLD', {
            reason: 'ai_is_bet_false',
            channelId: message.channel.id,
            capper: capperInfo?.name || message.author?.username || 'unknown',
            messageUrl: message.url,
            sample: cleanText.slice(0, 80),
          });
          try {
            await sendHoldReviewEmbed(message.client, {
              ingestId,
              capperName: capperInfo?.name || message.author?.username || 'unknown',
              channelId: message.channel.id,
              aiVerdict: 'ignore (is_bet=false)',
              sample: cleanText,
              messageUrl: message.url,
            });
          } catch (e) { console.log(`[ManualReviewNotice] Failed: ${e.message}`); }
          console.log(`[Filter] Human-channel slip held for review (ai_is_bet_false): ${cleanText.substring(0, 60)}...`);
          return;
        }
        if (isHumanChannel && isPureSlip) {
          // Pure-slip channel: skip the hold. Record a trace-only marker (STAGE_ENTER, not a
          // DROP — stays out of /admin pipeline-drops-24h) and fall through to the existing
          // PRE_FILTER_NO_BET_CONTENT drop/return below, unchanged.
          stageAll('PURE_SLIP_SKIP_HOLD', {
            reason: 'ai_is_bet_false',
            channelId: message.channel.id,
            capper: capperInfo?.name || message.author?.username || 'unknown',
            messageUrl: message.url,
            sample: cleanText.slice(0, 80),
          });
          console.log(`[PureSlip] Skipped MANUAL_REVIEW_HOLD (ai_is_bet_false) for pure-slip channel ${message.channel.id}.`);
        }
        console.log(`[Filter] AI rejected as non-bet: ${cleanText.substring(0, 60)}...`);
        dropAll('DROPPED', 'PRE_FILTER_NO_BET_CONTENT', { filter: 'ai_is_bet_false', sample: cleanText.slice(0, 80) });
        return;
      }

      // AI didn't commit to is_bet=true AND returned no usable bets.
      // Closes the silent-exit hole at this branch: when parseBetText's Type 1 path
      // returns { type:'bet', bets:[] } with undefined is_bet (because normalizeBet
      // filtered every bet out), the strict-equality check above misses, the
      // `bets.length > 0` check below also misses, and the function previously
      // exited with PARSED as the last pipeline event.
      //
      // CRITICAL: this guard checks BOTH conditions. A populated-bets return
      // (is_bet=undefined, bets=[{...}]) must NOT be dropped here — it falls
      // through to the bets.length > 0 block below. The combined condition
      // is structurally incapable of dropping populated-bet returns.
      //
      // See ERRATA-3 in skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md
      // for why the single-condition variant (is_bet !== true alone) was reverted as v335.
      // AI indeterminate (no is_bet=true, no usable bets).
      // Same human-channel hold pattern as the is_bet=false branch above.
      if (parsed.is_bet !== true && (!parsed.bets || parsed.bets.length === 0)) {
        const humanChannelIds = (process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const isHumanChannel = humanChannelIds.includes(message.channel.id);
        // PR #2: pure-slip channels skip MANUAL_REVIEW_HOLD staging. Same comma-split + trim
        // contract as HUMAN_SUBMISSION_CHANNEL_IDS above; empty/unset → [] → no bypass (unchanged).
        const pureSlipChannelIds = (process.env.PURE_SLIP_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const isPureSlip = pureSlipChannelIds.includes(message.channel.id);
        if (isHumanChannel && !isPureSlip) {
          stageAll('MANUAL_REVIEW_HOLD', {
            reason: 'ai_indeterminate_no_bets',
            is_bet_value: parsed.is_bet === undefined ? 'undefined' : String(parsed.is_bet),
            parsedType: parsed.type || null,
            betCount: parsed.bets?.length || 0,
            channelId: message.channel.id,
            capper: capperInfo?.name || message.author?.username || 'unknown',
            messageUrl: message.url,
            sample: cleanText.slice(0, 80),
          });
          try {
            await sendHoldReviewEmbed(message.client, {
              ingestId,
              capperName: capperInfo?.name || message.author?.username || 'unknown',
              channelId: message.channel.id,
              aiVerdict: `indeterminate (is_bet=${parsed.is_bet}, bets=${parsed.bets?.length || 0})`,
              sample: cleanText,
              messageUrl: message.url,
            });
          } catch (e) { console.log(`[ManualReviewNotice] Failed: ${e.message}`); }
          console.log(`[Filter] Human-channel slip held for review (ai_indeterminate_no_bets): is_bet=${parsed.is_bet}, bets=${parsed.bets?.length || 0}`);
          return;
        }
        if (isHumanChannel && isPureSlip) {
          // Pure-slip channel: skip the hold. Record a trace-only marker (STAGE_ENTER, not a
          // DROP — stays out of /admin pipeline-drops-24h) and fall through to the existing
          // PRE_FILTER_AI_EMPTY_RESULT drop/return below, unchanged.
          stageAll('PURE_SLIP_SKIP_HOLD', {
            reason: 'ai_indeterminate_no_bets',
            is_bet_value: parsed.is_bet === undefined ? 'undefined' : String(parsed.is_bet),
            parsedType: parsed.type || null,
            betCount: parsed.bets?.length || 0,
            channelId: message.channel.id,
            capper: capperInfo?.name || message.author?.username || 'unknown',
            messageUrl: message.url,
            sample: cleanText.slice(0, 80),
          });
          console.log(`[PureSlip] Skipped MANUAL_REVIEW_HOLD (ai_indeterminate_no_bets) for pure-slip channel ${message.channel.id}.`);
        }
        console.log(`[Filter] AI returned indeterminate result (is_bet=${parsed.is_bet}, bets=${parsed.bets?.length || 0}): ${cleanText.substring(0, 60)}...`);
        dropAll('DROPPED', 'PRE_FILTER_AI_EMPTY_RESULT', {
          filter: 'ai_indeterminate_no_bets',
          is_bet_value: parsed.is_bet === undefined ? 'undefined' : String(parsed.is_bet),
          parsedType: parsed.type || null,
          betCount: parsed.bets?.length || 0,
          sample: cleanText.slice(0, 80),
        });
        return;
      }

      if (parsed.bets?.length > 0) {
        // Multi-image merge: if multiple images produced multiple bets from same capper,
        // combine all legs into one parlay entry instead of N separate bets.
        const betsToSave = (imageUrls.length > 1 && parsed.bets.length > 1)
          ? [mergeBetsIntoParlay(parsed.bets)]
          : parsed.bets;

        const hasAnyImage = imageUrls.length > 0;
        for (const bet of betsToSave) {
          // Dedup handled by createBetWithLegs fingerprint — isDuplicateBet removed (false positives)

          // Anti-hallucination: validate parsed bet against source content.
          // hasMedia mirrors hasAnyImage — slip-shares with brand names in text
          // but the real bet in an image should be brand-exempt.
          const validation = validateParsedBet(bet, cleanText, { hasMedia: hasAnyImage });
          if (!validation.valid) {
            console.warn(`[MessageHandler] HALLUCINATION BLOCKED: ${validation.reason} | ${validation.issues.join('; ')}`);
            const mappedReason = validation.reason === 'leg_sport_mismatch' ? 'VALIDATOR_SPORT_MISMATCH'
              : validation.reason === 'entity_mismatch' ? 'VALIDATOR_ENTITY_MISMATCH'
              : 'BOUNCER_REJECTED';
            dropAll('DROPPED', mappedReason, { validator: validation.reason, issues: validation.issues, description: (bet.description || '').slice(0, 120) });
            continue;
          }

          const auditOn = isAuditMode();
          const reviewStatus = (auditOn || bet._confidence === 'low') ? 'needs_review' : 'confirmed';

          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: Math.min(bet.units || 1, 50),
            wager: bet.wager || null, payout: bet.payout || null,
            event_date: bet.event_date,
            source: hasAnyImage ? 'vision_slip' : source,
            source_url: message.url || null,
            source_channel_id: message.channel.id,
            source_message_id: message.id,
            source_tweet_id: sourceTweetId,
            source_tweet_handle: sourceTweetHandle,
            raw_text: cleanText.slice(0, 500),
            review_status: reviewStatus,
          }, bet.legs || []);
          if (!saved?._deduped) {
            recordStage({ ingestId, betId: saved?.id || null, sourceType: 'discord', sourceRef, stage: 'VALIDATED', eventType: 'STAGE_EXIT', payload: { reviewStatus } });
            recordStage({ ingestId, betId: saved?.id || null, sourceType: 'discord', sourceRef, stage: 'STAGED', eventType: 'STAGE_EXIT', payload: { reviewStatus, sport: bet.sport, betType: bet.bet_type } });
            if (reviewStatus === 'needs_review') {
              reviewBets.push(saved);
            } else {
              allBets.push(saved);
            }
          } else {
            recordDrop({ ingestId, sourceType: 'discord', sourceRef, stage: 'DROPPED', dropReason: 'DUPLICATE_IMAGE', payload: { dedup: 'fingerprint' } });
          }
        }
      }
    }

    if (allBets.length > 0) {
      await safeReact(message, '✅');
      // All bets route through War Room now — blue "Pick Tracked" embed removed to prevent double-post
      for (const bet of allBets) {
        await sendStagingEmbed(message.client, bet, capperInfo.name, message.url);
      }
    }

    if (reviewBets.length > 0) {
      await safeReact(message, '🔒');
      console.log(`[Review] Stored ${reviewBets.length} bet(s) for manual review from ${capperInfo.name}`);
      for (const bet of reviewBets) {
        await sendStagingEmbed(message.client, bet, capperInfo.name, message.url);
      }
      // Inbox Zero: only delete originals in #submit-picks — leave capper channels untouched
      const submitChannel = process.env.SUBMIT_PICKS_CHANNEL_ID || '1488236820700594197';
      if (message.channel.id === submitChannel) {
        try { await message.delete(); } catch (_) { /* Missing perms or already deleted */ }
      }
    }
  } catch (err) {
    // Silently ignore duplicate image detections
    if (err.message === 'DUPLICATE_IMAGE_DETECTED') {
      console.log('[Dedup] Duplicate image detected — skipping silently.');
      dropAll('DROPPED', 'DUPLICATE_IMAGE', { where: 'processAggregatedMessage' });
      return;
    }
    console.error('[MessageHandler] Error:', err.message);
    for (const id of ingestIds) {
      recordError({ ingestId: id, sourceType: 'discord', sourceRef: id.replace(/^disc_/, ''), stage: 'ERROR', error: err, payload: { where: 'processAggregatedMessage', channel: message.channel?.name } });
    }
    // P0 incidental fix: `context` was undefined here; build it locally.
    await reportErrorToAdmin(err, {
      channelName: message.channel?.name,
      channelId: message.channel?.id,
      author: message.author?.tag || 'unknown',
      where: `processAggregatedMessage channel=#${message.channel?.name || '?'} msg=${message.id}`,
    }, message.client);
  }
}

async function reportErrorToAdmin(error, context, client) {
  if (!client || !process.env.ADMIN_LOG_CHANNEL_ID) return;
  try {
    const adminChannel = client.channels.cache.get(process.env.ADMIN_LOG_CHANNEL_ID);
    if (!adminChannel) return;

    await adminChannel.send(
      `❌ **Pipeline Error Detected**\n**Channel:** #${context?.channelName || 'unknown'} (\`${context?.channelId || '?'}\`)\n**User:** ${context?.author || 'unknown'}\n**Error Type:** \`${error.name || 'Unknown'}\`\n**Details:** \`${(error.message || '').substring(0, 500)}\`\n*Action: Processing halted for this message.*`
    );
  } catch (e) {
    console.error('[AdminLog] Failed to report error:', e.message);
  }
}

module.exports = { handleMessage, processSlipImage, buildParsedPayload, sendHoldReviewEmbed, getImageAttachments, resolveCapper, selectSlipImages, slipImageIngestId };
