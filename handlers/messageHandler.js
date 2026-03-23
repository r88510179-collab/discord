const { parseBetText, parseBetSlipImage } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs, isDuplicateBet, isAuditMode, findPendingBetBySubject, gradeBet: gradeBetRecord, getBankroll, updateBankroll } = require('../services/database');
const { betEmbed } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');
const { sendStagingEmbed } = require('../services/warRoom');
const { extractTextFromImage } = require('../services/ocr');

// ── Dedup guard: prevent double-processing of the same Discord message ──
const processedMessages = new Set();

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
  return images;
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
  const { channelId, messageId } = opts;

  // Step 1: OCR
  const ocrText = await extractTextFromImage(imageUrl);
  if (!ocrText) {
    console.log('[SlipPipeline] OCR returned no text.');
    return null;
  }

  console.log(`[SlipPipeline] OCR extracted ${ocrText.length} chars.`);

  // Step 2: AI parse
  const parsed = await parseBetText(ocrText);
  if (!parsed.bets || parsed.bets.length === 0) {
    console.log('[SlipPipeline] No bets found in OCR text.');
    return { bets: [], ocrText };
  }

  // Step 3: Save bets + send to War Room
  const saved = [];
  for (const bet of parsed.bets) {
    if (isDuplicateBet(capperId, bet.description)) continue;

    const record = await createBetWithLegs({
      capper_id: capperId,
      sport: bet.sport, league: bet.league,
      bet_type: bet.bet_type, description: bet.description,
      odds: bet.odds, units: Math.min(bet.units || 1, 50),
      wager: bet.wager || null, payout: bet.payout || null,
      event_date: bet.event_date, source: 'ocr_slip',
      source_channel_id: channelId || null,
      source_message_id: messageId || null,
      raw_text: ocrText.slice(0, 500),
      review_status: 'needs_review',
    }, bet.legs || [], bet.props || []);

    if (!record?._deduped) {
      saved.push(record);
      await sendStagingEmbed(client, record, capperName);
    }
  }

  console.log(`[SlipPipeline] Processed ${saved.length} bet(s) via OCR.`);
  return { bets: saved, ocrText };
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
    await autoGradeBet(message.client, parsed.outcome, parsed.subject);
  } else {
    console.log(`[AutoGrade] AI could not extract result from celebration text.`);
  }
}

async function handleMessage(message) {
  if (!message.guild) return;

  // ═══ DEDUP GUARD: Skip if we already processed this message ═══
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  setTimeout(() => processedMessages.delete(message.id), 10_000);

  // ═══ GUARD 1: Never process our own messages (prevents infinite loop) ═══
  if (message.author.id === message.client.user.id) return;

  // ═══ HARD FILTER: Reject retweets and fan replies instantly ═══
  const rawContent = message.content || '';
  if (/^RT\s/i.test(rawContent)) return;
  if (/\breplying\s+to\b/i.test(rawContent)) return;
  if (/vxtwitter\.com|fixupx\.com/i.test(rawContent) && !/\b(pick|lock|play|bet)\b/i.test(rawContent)) return;

  // ═══ OCR Slip Feed — check before picks channel guard ═══
  const slipHandled = await handleSlipFeed(message);
  if (slipHandled) return;

  const picksChannels = getPicksChannels();
  if (picksChannels.length === 0) return;
  if (!picksChannels.includes(message.channel.id)) return;

  // ═══ GUARD 2: For non-mapped channels, skip all bot messages ═══
  const twitterMap = getTwitterCapperMap();
  const capperMap = getCapperChannelMap();
  const isTwitterFeed = !!twitterMap[message.channel.id];
  const isMappedCapper = !!capperMap[message.channel.id];
  const isMappedChannel = isTwitterFeed || isMappedCapper;
  if (message.author.bot && !isMappedChannel) return;

  // ═══ GUARD 3: For mapped channels, skip our own replies ═══
  if (isMappedChannel) {
    if (message.author.id === message.client.user.id) return;
    if (message.reference) return;
  }

  // ═══ GUARD 4: Skip old messages (only process last 2 min) ═══
  const msgAge = Date.now() - message.createdTimestamp;
  if (msgAge > 2 * 60 * 1000) return;

  const hasText = message.content?.trim().length > 0;
  const images = getImageAttachments(message);
  const hasImages = images.length > 0;

  // Build full text including embed content (Twitter bots post via embeds)
  let embedText = '';
  for (const embed of message.embeds) {
    if (embed.description) embedText += ' ' + embed.description;
    if (embed.title) embedText += ' ' + embed.title;
  }
  const fullText = (message.content || '') + embedText;

  // ═══ GUARD 5: Celebration / result tweets → route to auto-grader ═══
  if (looksLikeCelebration(fullText)) {
    console.log(`[AutoGrade] Detected celebration: ${fullText.substring(0, 80)}...`);
    try {
      await handleAutoGrade(message, fullText);
    } catch (err) {
      console.error('[AutoGrade] Error:', err.message);
    }
    return;
  }

  // ═══ GUARD 6: Must look like a pick — require 2+ signals for text, or have images ═══
  const textIsPick = looksLikePick(fullText);
  // For mapped channels (Twitter/capper), require stronger signal (3+) since lots of noise
  if (isMappedChannel && !hasImages) {
    let signals = 0;
    for (const p of PICK_SIGNALS) { if (p.test(fullText)) signals++; }
    if (signals < 3) return;
  } else if (!textIsPick && !hasImages) {
    return;
  }

  try {
    // Resolve who the capper is (handles Twitter feed attribution)
    const capperInfo = resolveCapper(message);
    const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);
    const source = capperInfo.source;
    const allBets = [];

    // Parse text picks
    const reviewBets = [];
    if (fullText.trim() && looksLikePick(fullText)) {
      // Clean text before parsing — strip retweet metadata and dollar amounts
      let cleanText = fullText
        .replace(/Retweeted @\w+/gi, '')
        .replace(/Quoted @\w+/gi, '')
        .replace(/\$[\d,]+\.?\d*/g, '')  // remove dollar amounts (payouts, not units)
        .replace(/https?:\/\/\S+/g, '')   // remove URLs
        .trim();
      const parsed = await parseBetText(cleanText);
      // Tier 2a: AI detected a result/grading event — auto-grade
      if (parsed.type === 'result') {
        console.log(`[AutoGrade] AI detected result: ${parsed.outcome} for ${parsed.subject?.join(', ')}`);
        await autoGradeBet(message.client, parsed.outcome, parsed.subject || []);
        return;
      }
      // Tier 2b: AI says this isn't a bet — silently ignore
      if (parsed.is_bet === false) {
        console.log(`[Filter] AI rejected as non-bet: ${cleanText.substring(0, 60)}...`);
      } else if (parsed.bets?.length > 0) {
        for (const bet of parsed.bets) {
          // Skip duplicates (same capper, similar description, last 10 min)
          if (isDuplicateBet(capper.id, bet.description)) continue;

          // Determine review_status: audit mode overrides confidence
          const auditOn = isAuditMode();
          const reviewStatus = (auditOn || bet._confidence === 'low') ? 'needs_review' : 'confirmed';

          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: Math.min(bet.units || 1, 50),
            event_date: bet.event_date, source,
            source_channel_id: message.channel.id,
            source_message_id: message.id,
            raw_text: cleanText,
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

    // Scan images for bet slips (max 1 per message to save API quota)
    if (hasImages) {
      const img = images[0]; // only scan first image
      const parsed = await scanImage(img.url, img.type);
      if (parsed?.bets?.length > 0) {
        for (const bet of parsed.bets) {
          if (isDuplicateBet(capper.id, bet.description)) continue;

          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: Math.min(bet.units || 1, 50),
            event_date: bet.event_date, source: 'slip',
            source_channel_id: message.channel.id,
            source_message_id: message.id,
            raw_text: `Image scan: ${capperInfo.name} in #${message.channel.name}`,
          }, bet.legs || []);
          if (!saved?._deduped) allBets.push(saved);
        }
      }
    }

    if (allBets.length > 0) {
      await message.react('📝');
      const embeds = allBets.map(b => betEmbed(b, capperInfo.name));
      await message.reply({
        content: `🤖 **${capperInfo.name}** — tracked **${allBets.length}** pick(s):`,
        embeds: embeds.slice(0, 5),
      });

      // Post each pick to the dashboard channel
      for (const bet of allBets) {
        await postPickTracked(message.client, bet, capperInfo.name, message.channel.name, capperInfo.source);
      }
    }

    // Bets held for review — send staging embeds to admin war room
    if (reviewBets.length > 0) {
      const ids = reviewBets.map(b => b.id.slice(0, 8)).join(', ');
      console.log(`[Review] Stored ${reviewBets.length} bet(s) for manual review from ${capperInfo.name} [${ids}]`);
      await message.reply({
        content: `🔒 **${reviewBets.length}** bet(s) saved for review. IDs: ${reviewBets.map(b => `\`${b.id.slice(0, 8)}\``).join(', ')}`,
      });

      // Send staging embeds with Approve/Edit/Reject buttons to admin channel
      for (const bet of reviewBets) {
        await sendStagingEmbed(message.client, bet, capperInfo.name);
      }
    }
  } catch (err) {
    console.error('[MessageHandler] Error:', err.message);
  }
}

module.exports = { handleMessage, processSlipImage };
