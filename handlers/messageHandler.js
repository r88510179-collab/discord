const { parseBetText, parseBetSlipImage } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs } = require('../services/database');
const { betEmbed } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');

const PICK_SIGNALS = [
  /\b(pick|lock|potd|play|bet|wager|hammer|tail|fade)\b/i,
  /[+-]\d{3}/,
  /\d+\.?\d*\s*u\b/i,
  /\b(ml|moneyline|spread|over|under|o\/u|rl|pk)\b/i,
  /\b(parlay|teaser|prop)\b/i,
  /🔒|🔥|💰|🎯|⚡/,
];

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

async function handleMessage(message) {
  if (!message.guild) return;

  // ═══ GUARD 1: Never process our own messages (prevents infinite loop) ═══
  if (message.author.id === message.client.user.id) return;

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

  // ═══ GUARD 5: Must look like a pick — require 2+ signals for text, or have images ═══
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
    if (fullText.trim() && looksLikePick(fullText)) {
      const parsed = await parseBetText(fullText);
      if (parsed.bets?.length > 0) {
        for (const bet of parsed.bets) {
          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: bet.units || 1,
            event_date: bet.event_date, source,
            source_channel_id: message.channel.id,
            source_message_id: message.id,
            raw_text: fullText,
          }, bet.legs || []);
          if (!saved?._deduped) allBets.push(saved);
        }
      }
    }

    // Scan images for bet slips (max 1 per message to save API quota)
    if (hasImages) {
      const img = images[0]; // only scan first image
      const parsed = await scanImage(img.url, img.type);
      if (parsed?.bets?.length > 0) {
        for (const bet of parsed.bets) {
          const saved = await createBetWithLegs({
            capper_id: capper.id,
            sport: bet.sport, league: bet.league,
            bet_type: bet.bet_type, description: bet.description,
            odds: bet.odds, units: bet.units || 1,
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
  } catch (err) {
    console.error('[MessageHandler] Error:', err.message);
  }
}

module.exports = { handleMessage };
