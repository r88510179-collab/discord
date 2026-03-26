const { parseBetText, parseBetSlipImage } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs, isDuplicateBet, isAuditMode, findPendingBetBySubject, gradeBet: gradeBetRecord, getBankroll, updateBankroll } = require('../services/database');
const { betEmbed } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');
const { sendStagingEmbed } = require('../services/warRoom');
const { extractTextFromImage } = require('../services/ocr');
const { gradeFromCelebration } = require('../services/grading');

// ── Dedup guard: prevent double-processing of the same Discord message ──
const processedMessages = new Set();

// ── Message Aggregation Buffer ──────────────────────────────────
// TweetShift sends text + image as separate messages a split-second apart.
// We buffer messages by user+channel for 4 seconds, then process as one.
const BUFFER_DELAY_MS = 4000;
const messageBuffer = new Map(); // key: `${userId}:${channelId}` → { texts, images, messages, timer }

function bufferMessage(message) {
  const key = `${message.author.id}:${message.channel.id}`;
  const images = getImageAttachments(message);

  if (messageBuffer.has(key)) {
    // Append to existing buffer
    const entry = messageBuffer.get(key);
    if (message.content?.trim()) entry.texts.push(message.content.trim());
    entry.images.push(...images);
    entry.messages.push(message);
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

  const entry = { texts, images: [...images], messages: [message], timer: null };
  entry.timer = setTimeout(() => flushBuffer(key), BUFFER_DELAY_MS);
  messageBuffer.set(key, entry);
}

async function flushBuffer(key) {
  const entry = messageBuffer.get(key);
  messageBuffer.delete(key);
  if (!entry || entry.messages.length === 0) return;

  const primaryMessage = entry.messages[0];

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
    await processAggregatedMessage(primaryMessage, combinedText, combinedImages);
  } catch (err) {
    console.error('[Buffer] Error processing aggregated message:', err.message);
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

function getPicksChannels() {
  const raw = process.env.PICKS_CHANNEL_IDS || '';
  return raw.split(',').map(id => id.trim()).filter(Boolean);
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

function getImageAttachments(message) {
  const images = [];
  for (const att of message.attachments.values()) {
    if (att.contentType?.startsWith('image/')) {
      images.push({ url: att.url, type: att.contentType });
    }
  }
  for (const embed of message.embeds) {
    if (embed.image?.url) images.push({ url: embed.image.url, type: 'image/png' });
    if (embed.thumbnail?.url && !embed.image) images.push({ url: embed.thumbnail.url, type: 'image/png' });
  }
  // Discord Native Forwards: images are in messageSnapshots, not attachments
  if (message.flags?.has(256) && message.messageSnapshots?.size > 0) {
    const snapshot = message.messageSnapshots.first();
    if (snapshot?.attachments) {
      for (const att of snapshot.attachments.values()) {
        if (att.contentType?.startsWith('image/')) {
          images.push({ url: att.url, type: att.contentType });
          console.log(`[Forward] Found image in forwarded snapshot: ${att.url.slice(0, 60)}...`);
        }
      }
    }
  }
  return images;
}

// Safe reply — falls back to channel.send if original message was deleted (FixTwitter/TweetShift)
async function safeReply(message, payload) {
  try {
    await message.reply(payload);
  } catch (err) {
    if (err.code === 10008 || (err.message && err.message.includes('Unknown Message'))) {
      console.log('[Pipeline] Original message deleted (FixTwitter/TweetShift). Sending without reference.');
      await message.channel.send(payload);
    } else {
      throw err;
    }
  }
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

async function scanImage(imageUrl, mediaType) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return await parseBetSlipImage(buffer.toString('base64'), mediaType);
  } catch (err) {
    console.error('[MessageHandler] Image scan error:', err.message);
    return null;
  }
}

// ── Shared OCR slip processing pipeline ──────────────────────
// Used by both the /slip command and the slip feed channel listener.
// Returns { bets: [...saved], ocrText } or null on failure.
async function processSlipImage(client, imageUrl, capperId, capperName, opts = {}) {
  const { channelId, messageId, sourceUrl } = opts;

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
  const prompt = ocrText.length > 10
    ? `Read the attached betting slip image AND the following OCR text to extract all bets:\n\n${ocrText}`
    : 'Read the attached betting slip image and extract all bets, players, lines, and odds.';
  const parsed = await parseBetText(prompt, imageUrl);

  if (!parsed.bets || parsed.bets.length === 0) {
    console.log('[SlipPipeline] Stage 2: No bets found in image.');
    return { bets: [] };
  }

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
    if (isDuplicateBet(capperId, bet.description)) continue;

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
      saved.push(record);
      await sendStagingEmbed(client, record, capperName, sourceUrl);
    }
  }

  console.log(`[SlipPipeline] Stage 4: Saved ${saved.length} bet(s) to DB.`);
  return { bets: saved };
}

// ── OCR Slip Feed — dedicated channel for bet slip images ───
async function handleSlipFeed(message) {
  const slipChannelId = process.env.SLIP_FEED_CHANNEL_ID;
  if (!slipChannelId || message.channel.id !== slipChannelId) return false;

  const images = getImageAttachments(message);
  if (images.length === 0) return false;

  try {
    // React immediately so user knows the bot is processing
    await message.react('🔍').catch(() => {});

    const capperInfo = resolveCapper(message);
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);

    const result = await processSlipImage(message.client, images[0].url, capper.id, capperInfo.name, {
      channelId: message.channel.id,
      messageId: message.id,
      sourceUrl: message.url,
    });

    if (!result) return true;

    return true;
  } catch (err) {
    console.error('[SlipFeed] Error:', err.message);
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

  // Grade the bet
  const graded = gradeBetRecord(bet.id, result, profitUnits, null, `Auto-graded from capper graphic`);

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
  return graded;
}

// Handle celebration messages by parsing them for grading signals
async function handleAutoGrade(message, fullText) {
  let cleanText = fullText
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\$[\d,]+\.?\d*/g, '')
    .trim();

  if (cleanText.length < 3) return;

  const parsed = await parseBetText(cleanText);
  if (parsed.type === 'result' && parsed.outcome && parsed.subject?.length > 0) {
    // Try capper-specific matching first (more accurate)
    const capperInfo = resolveCapper(message);
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);
    const contextResult = await gradeFromCelebration(message.client, capper.id, parsed.outcome, parsed.subject);

    if (contextResult) {
      console.log(`[ContextGrade] Successfully graded bet from capper ${capperInfo.name}`);
      return;
    }

    // Fallback: global search across all cappers
    await autoGradeBet(message.client, parsed.outcome, parsed.subject);
  } else {
    console.log(`[AutoGrade] AI could not extract result from celebration text.`);
  }
}

async function handleMessage(message, { isUpdate = false } = {}) {
  if (!message.guild) return;

  // ═══ DEDUP GUARD ═══
  // For MessageUpdate (embed unfurl), use a separate key so it bypasses the Create dedup
  const dedupKey = isUpdate ? `update:${message.id}` : message.id;
  if (processedMessages.has(dedupKey)) return;
  processedMessages.add(dedupKey);
  setTimeout(() => processedMessages.delete(dedupKey), 10_000);

  // ═══ GUARD 0: Strict Channel Lock — bot is deaf outside allowed channels ═══
  const slipFeedId = process.env.SLIP_FEED_CHANNEL_ID;
  const allowedChannels = getPicksChannels();
  if (slipFeedId) allowedChannels.push(slipFeedId);
  if (!allowedChannels.includes(message.channel.id)) return;

  // ═══ GUARD 1: Never process our own messages (prevents infinite loop) ═══
  if (message.author.id === message.client.user.id) return;

  // ═══ Combine message content + embed text (FixTwitter puts tweet text in embeds) ═══
  const rawContent = message.content || '';
  const embedText = message.embeds.map(e => [e.description, e.title].filter(Boolean).join(' ')).join(' ');
  const fullContent = (rawContent + ' ' + embedText).trim();

  console.log(`[DEBUG] handleMessage | embeds: ${message.embeds.length} | isUpdate: ${isUpdate} | fullContent(${fullContent.length}): "${fullContent.slice(0, 80)}"`);

  // ═══ HARD FILTER: Reject fan replies (RT filter removed — cappers retweet their own slips) ═══
  if (/\breplying\s+to\b/i.test(fullContent)) { console.log('[DEBUG] Rejected by Hard Filter: replying to'); return; }
  if (/vxtwitter\.com|fixupx\.com/i.test(rawContent) && !/\b(pick|lock|play|bet)\b/i.test(fullContent)) { console.log('[DEBUG] Rejected by Hard Filter: vxtwitter without pick signal'); return; }

  // ═══ OCR Slip Feed — check before picks channel guard ═══
  const slipHandled = await handleSlipFeed(message);
  if (slipHandled) return;

  const picksChannels = getPicksChannels();
  if (picksChannels.length === 0) return;
  if (!picksChannels.includes(message.channel.id)) return;

  // ═══ GUARD 2: Resolve channel mapping (for capper attribution) ═══
  const twitterMap = getTwitterCapperMap();
  const capperMap = getCapperChannelMap();
  const isTwitterFeed = !!twitterMap[message.channel.id];
  const isMappedCapper = !!capperMap[message.channel.id];
  const isMappedChannel = isTwitterFeed || isMappedCapper;
  // NOTE: We allow ALL bots/webhooks (TweetShift, custom webhooks) in picks channels.
  // The only bot we skip is ourselves to prevent infinite loops.

  // ═══ GUARD 3: Skip our own replies (prevent loops) ═══
  if (message.author.id === message.client.user.id) return;
  if (isMappedChannel && message.reference) return;

  // ═══ GUARD 4: Skip old messages (only process last 2 min) ═══
  const msgAge = Date.now() - message.createdTimestamp;
  if (msgAge > 2 * 60 * 1000) return;

  const hasText = fullContent.length > 0;
  const images = getImageAttachments(message);
  const hasImages = images.length > 0;

  // fullText = message.content + embed descriptions (already built above as fullContent)
  const fullText = fullContent;

  // ═══ GUARD 5: Must have SOME signal — text signals, images, or celebration keywords ═══
  // All messages go to the buffer. The AI decides type (bet, result, untracked_win, ignore).
  const textIsPick = looksLikePick(fullText);
  const textIsCelebration = looksLikeCelebration(fullText);
  if (!textIsPick && !textIsCelebration && !hasImages) {
    return;
  }

  // ═══ BUFFER: Aggregate text + image from split TweetShift messages ═══
  bufferMessage(message);
}

// ═══════════════════════════════════════════════════════════════
// processAggregatedMessage — runs after the 4-second buffer flushes
// Receives the combined text + images from all buffered messages.
// ═══════════════════════════════════════════════════════════════
async function processAggregatedMessage(message, combinedRawText, combinedImages) {
  const hasImages = combinedImages.length > 0;
  const fullText = combinedRawText;

  try {
    const capperInfo = resolveCapper(message);
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);
    const source = capperInfo.source;
    const allBets = [];
    const reviewBets = [];

    // Hard Scrub the text
    const cleanText = hardScrub(fullText);

    // Get image URL for Gemini Vision (bypasses OCR entirely)
    const imageUrl = hasImages ? combinedImages[0].url : null;

    if (cleanText.length > 5 || imageUrl) {
      console.log(`[DEBUG] Sending to AI. Text length: ${cleanText.length} | hasImage: ${!!imageUrl} | preview: "${cleanText.slice(0, 100)}"`);
      const parsed = await parseBetText(cleanText || 'Read the attached betting slip image and extract all bets.', imageUrl);
      console.log(`[DEBUG] AI Response: type=${parsed.type || 'bet'} is_bet=${parsed.is_bet} bets=${parsed.bets?.length || 0}`);

      // Auto-grade detection
      if (parsed.type === 'result') {
        console.log(`[AutoGrade] AI detected result: ${parsed.outcome} for ${parsed.subject?.join(', ')}`);
        await autoGradeBet(message.client, parsed.outcome, parsed.subject || []);
        return;
      }

      // Untracked winner — send yellow embed to War Room
      if (parsed.type === 'untracked_win') {
        console.log(`[UntrackedWin] Detected: ${parsed.description}`);
        const { sendUntrackedWinEmbed } = require('../services/warRoom');
        await sendUntrackedWinEmbed(message.client, {
          description: parsed.description,
          outcome: parsed.outcome || 'win',
          subject: parsed.subject || [],
          capperName: capperInfo.name,
          capperId: capper.id,
        });
        return;
      }

      // Not a bet — silently ignore
      if (parsed.is_bet === false) {
        console.log(`[Filter] AI rejected as non-bet: ${cleanText.substring(0, 60)}...`);
        return;
      }

      if (parsed.bets?.length > 0) {
        for (const bet of parsed.bets) {
          if (isDuplicateBet(capper.id, bet.description)) continue;

          const auditOn = isAuditMode();
          const reviewStatus = (auditOn || bet._confidence === 'low') ? 'needs_review' : 'confirmed';

          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: Math.min(bet.units || 1, 50),
            wager: bet.wager || null, payout: bet.payout || null,
            event_date: bet.event_date,
            source: imageUrl ? 'vision_slip' : source,
            source_url: message.url || null,
            source_channel_id: message.channel.id,
            source_message_id: message.id,
            raw_text: cleanText.slice(0, 500),
            review_status: reviewStatus,
          }, bet.legs || []);
          if (!saved?._deduped) {
            if (reviewStatus === 'needs_review') {
              reviewBets.push(saved);
            } else {
              allBets.push(saved);
            }
          }
        }
      }
    }

    if (allBets.length > 0) {
      await safeReact(message, '📝');
      const embeds = allBets.map(b => betEmbed(b, capperInfo.name));
      await safeReply(message, {
        content: `🤖 **${capperInfo.name}** — tracked **${allBets.length}** pick(s):`,
        embeds: embeds.slice(0, 5),
      });
      for (const bet of allBets) {
        await postPickTracked(message.client, bet, capperInfo.name, message.channel.name, capperInfo.source);
      }
    }

    if (reviewBets.length > 0) {
      const ids = reviewBets.map(b => b.id.slice(0, 8)).join(', ');
      console.log(`[Review] Stored ${reviewBets.length} bet(s) for manual review from ${capperInfo.name} [${ids}]`);
      await safeReply(message, {
        content: `🔒 **${reviewBets.length}** bet(s) saved for review. IDs: ${reviewBets.map(b => `\`${b.id.slice(0, 8)}\``).join(', ')}`,
      });
      for (const bet of reviewBets) {
        await sendStagingEmbed(message.client, bet, capperInfo.name, message.url);
      }
    }
  } catch (err) {
    console.error('[MessageHandler] Error:', err.message);
  }
}

module.exports = { handleMessage, processSlipImage };
