const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getPendingBets, getAuditRecent, getAuditByHandle, getAuditRejected, getAuditStats, searchAudit } = require('../services/database');
const { shopLine, extractTeamFromDescription } = require('../services/odds');
const { americanToDecimal, impliedProbability } = require('../services/bankroll');
const { COLORS } = require('../utils/embeds');

const STAGE_BADGES = {
  fetched: '📥', filtered_rt: '🔁', filtered_reply: '↩️', filtered_age: '⏳',
  deduped: '♻️', bouncer_rejected: '🚫', bouncer_valid: '✅', saved: '💾', error: '❌',
};

function formatAuditRows(rows) {
  if (rows.length === 0) return '_No results_';
  return rows.map(r => {
    const badge = STAGE_BADGES[r.stage] || '❓';
    const text = (r.tweet_text || '').slice(0, 120);
    const reason = r.reason ? `\n└ *${r.reason.slice(0, 120)}*` : '';
    const link = r.tweet_url ? ` [🔗](${r.tweet_url})` : '';
    return `${badge} **@${r.handle}** — \`${r.stage}\`${link}\n\`\`\`${text}\`\`\`${reason}`;
  }).join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Audit tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('clv').setDescription('Check Closing Line Value on pending bets'))
    .addSubcommand(sub => sub.setName('twitter').setDescription('Twitter ingestion audit — recent 20 tweets'))
    .addSubcommand(sub =>
      sub.setName('twitter-handle')
        .setDescription('Audit tweets for a specific handle')
        .addStringOption(opt => opt.setName('handle').setDescription('@handle').setRequired(true)))
    .addSubcommand(sub => sub.setName('twitter-rejected').setDescription('Last 20 Bouncer-rejected tweets'))
    .addSubcommand(sub => sub.setName('twitter-stats').setDescription('24-hour stage breakdown'))
    .addSubcommand(sub =>
      sub.setName('twitter-find')
        .setDescription('Search audit log by keyword')
        .addStringOption(opt => opt.setName('keyword').setDescription('Search term').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('twitter-force')
        .setDescription('Force re-process a tweet by URL')
        .addStringOption(opt => opt.setName('url').setDescription('Tweet URL (https://x.com/...)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('twitter-credits')
        .setDescription('Show twitterapi.io credit usage and projections'))
    .addSubcommand(sub =>
      sub.setName('twitter-false-negatives')
        .setDescription('Find rejected tweets that had betting structure'))
    .addSubcommand(sub =>
      sub.setName('source-attribution')
        .setDescription('Check source tweet data on recent bets')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Owner check for twitter audit commands
    if (sub.startsWith('twitter') && process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
      return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
    }

    // ── Twitter recent ──
    if (sub === 'twitter') {
      await interaction.deferReply({ ephemeral: true });
      const rows = getAuditRecent(20);
      const desc = formatAuditRows(rows);
      const embed = new EmbedBuilder().setTitle('🐦 Twitter Audit — Recent').setColor(0x1DA1F2).setDescription(desc.slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter by handle ──
    if (sub === 'twitter-handle') {
      await interaction.deferReply({ ephemeral: true });
      const handle = interaction.options.getString('handle').replace(/@/g, '').trim().toLowerCase();
      const rows = getAuditByHandle(handle, 20);
      const desc = formatAuditRows(rows);
      const embed = new EmbedBuilder().setTitle(`🐦 Audit — @${handle}`).setColor(0x1DA1F2).setDescription(desc.slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter rejected ──
    if (sub === 'twitter-rejected') {
      await interaction.deferReply({ ephemeral: true });
      const rows = getAuditRejected(20);
      const desc = formatAuditRows(rows);
      const embed = new EmbedBuilder().setTitle('🚫 Bouncer Rejections — Last 20').setColor(0xE74C3C).setDescription(desc.slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter stats ──
    if (sub === 'twitter-stats') {
      await interaction.deferReply({ ephemeral: true });
      const stats = getAuditStats();
      const lines = stats.map(s => `${STAGE_BADGES[s.stage] || '❓'} **${s.stage}**: ${s.count}`);
      const total = stats.reduce((sum, s) => sum + s.count, 0);
      const embed = new EmbedBuilder()
        .setTitle('📊 Twitter Pipeline — 24h Stats')
        .setColor(0x1DA1F2)
        .setDescription(lines.join('\n') || '_No data_')
        .setFooter({ text: `Total: ${total} events` })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter find ──
    if (sub === 'twitter-find') {
      await interaction.deferReply({ ephemeral: true });
      const keyword = interaction.options.getString('keyword');
      const rows = searchAudit(keyword, 20);
      const desc = formatAuditRows(rows);
      const embed = new EmbedBuilder().setTitle(`🔍 Audit Search: "${keyword}"`).setColor(0x1DA1F2).setDescription(desc.slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter credits ──
    if (sub === 'twitter-credits') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const { getTwitterCreditStats } = require('../services/twitter');
        const s = getTwitterCreditStats();
        const dailyBurn = s.used > 0 ? Math.round(s.used / Math.max((Date.now() - (new Date(getSetting('twitterapi_credits_started') || Date.now())).getTime()) / (1000 * 60 * 60 * 24), 1)) : 0;
        const daysLeft = dailyBurn > 0 ? Math.round((s.budget - s.used) / dailyBurn) : '∞';
        const embed = new EmbedBuilder()
          .setTitle('💳 twitterapi.io Credits')
          .setColor(s.pct >= 90 ? 0xE74C3C : s.pct >= 50 ? 0xF1C40F : 0x2ECC71)
          .addFields(
            { name: 'Used', value: `**${s.used}** / ${s.budget}`, inline: true },
            { name: 'Remaining', value: `${s.budget - s.used}`, inline: true },
            { name: 'Usage', value: `${s.pct}%`, inline: true },
            { name: 'Est. Daily Burn', value: `~${dailyBurn} credits/day`, inline: true },
            { name: 'Days Remaining', value: `~${daysLeft}`, inline: true },
          ).setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply(`Error: ${e.message}`);
      }
    }

    // ── Twitter false negatives ──
    if (sub === 'twitter-false-negatives') {
      await interaction.deferReply({ ephemeral: true });
      const { db: database } = require('../services/database');
      const STRUCT = [/[+-]\d{2,4}/, /\b\d+u\b/i, /\b(over|under|o|u)\s*\d+/i, /\b(ML|moneyline)\s*[+-]?\d+/i, /\b(NRFI|YRFI|SGP|parlay)\b/i, /\d+\.5\b/];
      const rejected = database.prepare("SELECT * FROM twitter_audit_log WHERE stage = 'bouncer_rejected' ORDER BY created_at DESC LIMIT 50").all();
      const falseNegs = [];
      for (const r of rejected) {
        const matches = STRUCT.filter(p => p.test(r.tweet_text || ''));
        if (matches.length > 0) falseNegs.push({ ...r, matchCount: matches.length });
      }
      if (falseNegs.length === 0) return interaction.editReply('✅ No false negatives found in last 50 rejections.');
      const lines = falseNegs.slice(0, 10).map(f =>
        `🚫→✅ **@${f.handle}** (${f.matchCount} patterns)\n\`\`\`${(f.tweet_text || '').slice(0, 120)}\`\`\`└ Reason: ${(f.reason || '').slice(0, 80)}`
      );
      const embed = new EmbedBuilder().setTitle(`⚠️ False Negatives: ${falseNegs.length} of ${rejected.length} rejections had structure`).setColor(0xF1C40F).setDescription(lines.join('\n')).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Source attribution audit ──
    if (sub === 'source-attribution') {
      await interaction.deferReply({ ephemeral: true });
      const { db: database } = require('../services/database');
      const bets = database.prepare(`SELECT b.id, c.display_name AS capper, b.source, b.source_tweet_id, b.source_tweet_handle, b.source_url FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id ORDER BY b.created_at DESC LIMIT 20`).all();
      const lines = bets.map(b => {
        const hasSource = b.source_tweet_id && b.source_tweet_handle;
        const icon = hasSource ? '✅' : '❌';
        const url = hasSource ? `x.com/${b.source_tweet_handle}/status/${b.source_tweet_id}` : (b.source_url?.slice(0, 40) || 'none');
        return `${icon} \`${b.id.slice(0, 8)}\` **${b.capper || '?'}** | ${b.source || '?'} | ${url}`;
      });
      const embed = new EmbedBuilder().setTitle('🔗 Source Attribution — Last 20 Bets').setColor(0x3498DB).setDescription(lines.join('\n').slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Twitter force re-process ──
    if (sub === 'twitter-force') {
      await interaction.deferReply({ ephemeral: true });
      const url = interaction.options.getString('url');
      // Extract tweet ID from URL: https://x.com/user/status/1234567890
      const match = url.match(/status\/(\d+)/);
      if (!match) return interaction.editReply('❌ Could not extract tweet ID from URL.');

      const tweetId = match[1];
      const handleMatch = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status/);
      const handle = handleMatch?.[1] || 'unknown';

      // Remove from processed_tweets so it can be reprocessed
      const { db: database } = require('../services/database');
      database.prepare('DELETE FROM processed_tweets WHERE tweet_id = ?').run(tweetId);

      // Fetch the tweet via apitwitter.com
      const apiKey = process.env.TWITTERAPI_KEY || process.env.APITWITTER_KEY;
      if (!apiKey) return interaction.editReply('❌ No Twitter API key set.');

      try {
        const endpoint = process.env.TWITTERAPI_KEY
          ? `https://api.twitterapi.io/twitter/tweet/advanced_search?query=from:${handle}&queryType=Latest`
          : `https://api.apitwitter.com/twitter/search?query=from:${handle}&count=20`;
        const res = await fetch(endpoint, {
          headers: { 'X-API-Key': apiKey },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return interaction.editReply(`❌ API returned HTTP ${res.status}`);

        const data = await res.json();
        const tweets = data?.data?.tweets || data?.tweets || [];
        const targetTweet = tweets.find(t => String(t.id) === tweetId);

        if (!targetTweet) return interaction.editReply(`❌ Tweet ${tweetId} not found in @${handle}'s recent timeline.`);

        const { handleTwitterWebhookPayload } = require('../services/twitter-handler');
        const result = await handleTwitterWebhookPayload({ handle, displayName: handle, tweets: [targetTweet] }, interaction.client);

        return interaction.editReply(`🔄 Force-processed tweet \`${tweetId}\`:\n• Staged: **${result.staged}**\n• AI Calls: **${result.aiCalls}**\n• Skipped: **${result.skipped}**`);
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    // ── CLV audit (existing) ──
    if (sub === 'clv') {
      await interaction.deferReply({ ephemeral: true });

      const pending = getPendingBets().filter(b => b.review_status === 'confirmed');
      if (pending.length === 0) return interaction.editReply({ content: 'No confirmed pending bets to audit.' });

      const results = [];
      const PROP_KEYWORDS = /\b(pts|points|reb|rebounds|ast|assists|stl|steals|blk|blocks|yds|yards|tds|touchdowns|strikeouts|hits|runs|sacks|receptions)\b/i;

      for (const bet of pending.slice(0, 15)) {
        const betType = (bet.bet_type || 'straight').toLowerCase();
        const desc = bet.description || '';

        if (betType === 'parlay' || betType === 'teaser' || betType === 'ladder') {
          results.push({ bet, status: 'skip', label: '⚪ Parlay (CLV unsupported)' });
          continue;
        }
        if (betType === 'prop' || PROP_KEYWORDS.test(desc)) {
          results.push({ bet, status: 'skip', label: '⚪ Player Prop (CLV unsupported)' });
          continue;
        }

        const teamSearch = extractTeamFromDescription(desc);
        if (!teamSearch || !bet.odds) {
          results.push({ bet, status: 'skip', label: '⚪ No odds/team data' });
          continue;
        }

        let marketOffer;
        try { marketOffer = await shopLine(teamSearch, bet.sport); } catch {}

        if (!marketOffer) {
          results.push({ bet, status: 'unavailable', label: '⚪ Market unavailable' });
          continue;
        }

        const capperDecimal = americanToDecimal(bet.odds);
        const marketDecimal = americanToDecimal(marketOffer.price);
        const clvPct = ((capperDecimal - marketDecimal) / marketDecimal * 100).toFixed(1);
        const isPositive = capperDecimal > marketDecimal;

        results.push({ bet, status: isPositive ? 'positive' : 'negative', marketPrice: marketOffer.price, clvPct, book: marketOffer.book });
      }

      const positiveCount = results.filter(r => r.status === 'positive').length;
      const negativeCount = results.filter(r => r.status === 'negative').length;
      const skippedCount = results.filter(r => r.status === 'skip').length;

      const lines = results.map(r => {
        const desc = (r.bet.description || 'Unknown').slice(0, 40);
        const capper = r.bet.capper_name || 'Unknown';
        if (r.status === 'positive' || r.status === 'negative') {
          const icon = r.status === 'positive' ? '📈' : '📉';
          const tag = r.status === 'positive' ? '+EV' : '-EV';
          const capperOdds = r.bet.odds > 0 ? `+${r.bet.odds}` : `${r.bet.odds}`;
          const marketOdds = r.marketPrice > 0 ? `+${r.marketPrice}` : `${r.marketPrice}`;
          return `${icon} **${desc}**\n└ ${capper} | **${capperOdds}** -> **${marketOdds}** ${tag} (${r.clvPct}%)`;
        }
        return `⚪ **${desc}**\n└ ${capper} | ${r.label}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('CLV Audit — Pending Bets')
        .setColor(positiveCount >= negativeCount ? COLORS.success : COLORS.danger)
        .setDescription(lines.join('\n\n') || 'No results.')
        .addFields(
          { name: 'Positive CLV', value: `${positiveCount}`, inline: true },
          { name: 'Negative CLV', value: `${negativeCount}`, inline: true },
          { name: 'Skipped', value: `${skippedCount}`, inline: true },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
