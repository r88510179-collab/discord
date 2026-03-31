require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, Options, Partials } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ── Health check server (starts FIRST, before Discord login) ──
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ── Tweet Webhook Endpoint (Apify / Scraper integration) ─────
app.post('/webhook/tweet', async (req, res) => {
  try {
    const { text, capper, author, tweetId } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text field' });

    const capperName = capper || author || 'Unknown';
    console.log(`[Webhook] Tweet from ${capperName}: "${text.slice(0, 80)}..."`);

    // AI Bouncer: extract pick or reject noise
    const { extractPickFromTweet } = require('./services/ai');
    const pick = await extractPickFromTweet(text, capperName);

    if (!pick) {
      console.log(`[Webhook] Rejected — not a bet.`);
      return res.json({ status: 'ignored', reason: 'not_a_bet' });
    }

    // Save to DB with needs_review + send to War Room
    const { getOrCreateCapper, createBetWithLegs } = require('./services/database');
    const { sendStagingEmbed } = require('./services/warRoom');

    const capperId = capper || `twitter_${(author || 'unknown').toLowerCase()}`;
    const capperRecord = getOrCreateCapper(capperId, capperName, null);

    const saved = createBetWithLegs({
      capper_id: capperRecord.id,
      sport: pick.sport || 'Unknown',
      bet_type: pick.type || 'straight',
      description: pick.description,
      odds: pick.odds ? parseInt(pick.odds, 10) : null,
      units: pick.units || 1,
      source: 'twitter_webhook',
      raw_text: text.slice(0, 500),
      review_status: 'needs_review',
    }, pick.legs || []);

    if (saved && !saved._deduped) {
      // Send to War Room
      const warRoomClient = global._discordClient;
      if (warRoomClient) {
        await sendStagingEmbed(warRoomClient, saved, capperName);
      }
      console.log(`[Webhook] Staged bet: "${pick.description?.slice(0, 50)}" from ${capperName}`);
      return res.json({ status: 'staged', betId: saved.id });
    }

    return res.json({ status: 'duplicate' });
  } catch (error) {
    console.error('[Webhook] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`[SYSTEM] Health check server listening on 0.0.0.0:${port}`));

const { handleMessage } = require('./handlers/messageHandler');
const { handleWarRoomInteraction } = require('./services/warRoom');
const { handleGradeInteraction } = require('./handlers/gradeButtons');
const { runAutoGrade } = require('./services/grading');
const { pollTwitterPicks } = require('./services/twitter');
const { postGradeSummary, postDailyLeaderboard } = require('./services/dashboard');

/**
 * Utility to extract bet data from a War Room embed.
 * Parses the Bet ID from footer or fields, plus odds.
 */
function getBetProps(embed) {
  if (!embed) return null;

  // Try footer first (e.g., "ID: 7156c446")
  let betId = null;
  if (embed.footer?.text) {
    const idMatch = embed.footer.text.match(/ID:\s*([a-f0-9]+)/i);
    if (idMatch) betId = idMatch[1];
  }

  // Fallback: check fields for "Bet ID"
  if (!betId && embed.fields) {
    const idField = embed.fields.find(f => f.name === 'Bet ID');
    if (idField) betId = idField.value.replace(/`/g, '').trim();
  }

  const oddsField = embed.fields?.find(f => f.name.includes('Odds'));
  const odds = oddsField ? oddsField.value : 'N/A';

  return { id: betId, odds, fullEmbed: embed };
}

// ── Create Discord client ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
  // Cache sweeper — prevent OOM on busy servers
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: { maxSize: 50 },
    ThreadManager: { maxSize: 0 },
    PresenceManager: 0,
    VoiceStateManager: 0,
    ReactionManager: 0,
  }),
});

// ── Load slash commands ─────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    console.log(`  📌 Loaded command: /${command.data.name}`);
  }
}

// ── Handle all interactions (slash commands + war room buttons/modals) ──
client.on(Events.InteractionCreate, async (interaction) => {
  // War room buttons and modals
  if (interaction.isButton() || interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('war_')) {
      try {
        await handleWarRoomInteraction(interaction);
      } catch (err) {
        console.error('[WarRoom] Interaction error:', err.message);
      }
      return;
    }
    if (interaction.customId.startsWith('grade_')) {
      try {
        await handleGradeInteraction(interaction);
      } catch (err) {
        console.error('[GradeBtn] Interaction error:', err.message);
      }
      return;
    }
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[Command Error] /${interaction.commandName}:`, err);
    try {
      const reply = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (replyErr) {
      console.error(`[Command Error] Failed to send error reply:`, replyErr.message);
    }
  }
});

// ── Handle messages (auto-parse picks channel) ──────────────
// Add your authorized channel IDs here
const AUTHORIZED_CHANNELS = [
  '1488236820700594197', // #submit-picks
  '1486825605105192960', // #admin-log
];

client.on(Events.MessageCreate, async (message) => {
  // 1. IMMEDIATELY ignore bots (prevents infinite loops)
  if (message.author.bot) return;

  // 📊 X-RAY COMMAND: Type "!status" in any channel to see pending bets
  if (message.content.toLowerCase() === '!status') {
    try {
      const { db } = require('./services/database');
      const pendingCount = db.prepare("SELECT COUNT(*) as count FROM bets WHERE result = 'pending'").get().count;
      const propCount = db.prepare("SELECT COUNT(*) as count FROM bets WHERE result = 'pending' AND bet_type = 'prop'").get().count;
      const sportsBreakdown = db.prepare("SELECT sport, COUNT(*) as count FROM bets WHERE result = 'pending' GROUP BY sport").all();

      let breakdownText = sportsBreakdown.map(row => `• **${row.sport || 'Unknown'}**: ${row.count}`).join('\n');
      if (!breakdownText) breakdownText = 'No pending bets.';

      return message.reply({ embeds: [{
        color: 0x0099ff,
        title: 'Bot X-Ray Status',
        fields: [
          { name: 'Total Pending', value: `${pendingCount}`, inline: true },
          { name: 'Props (AI)', value: `${propCount}`, inline: true },
          { name: 'By Sport', value: breakdownText, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }] });
    } catch (error) {
      console.error('[X-RAY ERROR]', error);
      return message.reply('Error fetching database status.');
    }
  }

  // 🏆 LEADERBOARD COMMAND
  if (message.content.toLowerCase() === '!leaderboard') {
    try {
      const { db } = require('./services/database');
      const topCappers = db.prepare(`
        SELECT c.display_name,
          SUM(CASE WHEN b.result = 'win' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN b.result = 'loss' THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN b.result = 'push' THEN 1 ELSE 0 END) as pushes,
          COALESCE(SUM(b.profit_units), 0) as total_profit
        FROM bets b
        JOIN cappers c ON b.capper_id = c.id
        WHERE b.result IN ('win', 'loss', 'push')
        GROUP BY c.id
        HAVING (wins + losses) > 0
        ORDER BY total_profit DESC
        LIMIT 10
      `).all();

      if (topCappers.length === 0) {
        return message.reply('Not enough graded bets to generate a leaderboard yet!');
      }

      const medals = ['🥇', '🥈', '🥉'];
      let boardText = '';
      topCappers.forEach((cap, i) => {
        const rank = i < 3 ? medals[i] : `**${i + 1}.**`;
        const profit = cap.total_profit >= 0 ? `+${cap.total_profit.toFixed(2)}` : cap.total_profit.toFixed(2);
        const winPct = Math.round((cap.wins / (cap.wins + cap.losses)) * 100);
        boardText += `${rank} **${cap.display_name}**\n└ ${profit}u | ${cap.wins}-${cap.losses}-${cap.pushes} (${winPct}%)\n\n`;
      });

      return message.reply({ embeds: [{
        color: 0xFFD700,
        title: 'Server Leaderboard (All-Time)',
        description: boardText,
        footer: { text: 'Ranked by total profit units' },
        timestamp: new Date().toISOString(),
      }] });
    } catch (error) {
      console.error('[LEADERBOARD ERROR]', error);
      return message.reply('Error fetching the leaderboard.');
    }
  }

  // 🗄️ FULL PENDING LIST
  if (message.content.toLowerCase() === '!pending') {
    try {
      const { db: database } = require('./services/database');
      const { AttachmentBuilder } = require('discord.js');
      const allPending = database.prepare(`
        SELECT b.*, c.display_name AS capper_name
        FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
        WHERE b.result = 'pending' ORDER BY b.created_at DESC
      `).all();

      if (allPending.length === 0) {
        return message.reply('There are no pending bets right now.');
      }

      let fileContent = `--- FULL PENDING BETS LIST (${allPending.length} Total) ---\n`;
      fileContent += `Generated: ${new Date().toISOString()}\n\n`;

      allPending.forEach((bet, index) => {
        const cleanDesc = bet.description ? bet.description.replace(/\n/g, ' | ') : 'No description';
        fileContent += `${index + 1}. [${(bet.sport || 'Unknown').toUpperCase()}] Capper: ${bet.capper_name || 'Unknown'}\n`;
        fileContent += `   Pick: ${cleanDesc}\n`;
        fileContent += `   Type: ${bet.bet_type || 'straight'} | Odds: ${bet.odds || 'N/A'}\n`;
        fileContent += `   Date Placed: ${bet.created_at}\n`;
        fileContent += `   Bet ID: ${bet.id}\n`;
        fileContent += `--------------------------------------------------\n\n`;
      });

      const attachment = new AttachmentBuilder(Buffer.from(fileContent, 'utf-8'), { name: 'pending-bets-backlog.txt' });
      return message.reply({
        content: `**Here is the complete backlog.**\nThere are currently **${allPending.length}** bets waiting to be graded.`,
        files: [attachment],
      });
    } catch (error) {
      console.error('[PENDING CMD ERROR]', error);
      return message.reply('Error generating the pending bets file.');
    }
  }

  // 👤 MYSTATS COMMAND
  if (message.content.toLowerCase() === '!mystats') {
    try {
      const { db: database } = require('./services/database');
      const userId = message.author.id;
      const stats = database.prepare(`
        SELECT
          SUM(CASE WHEN b.result = 'win' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN b.result = 'loss' THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN b.result = 'push' THEN 1 ELSE 0 END) as pushes
        FROM user_bets ub
        JOIN bets b ON ub.bet_id = b.id
        WHERE ub.user_id = ? AND ub.action = 'tail' AND b.result IN ('win', 'loss', 'push')
      `).get(userId);

      const bestCapper = database.prepare(`
        SELECT c.display_name, COUNT(*) as hits
        FROM user_bets ub
        JOIN bets b ON ub.bet_id = b.id
        LEFT JOIN cappers c ON b.capper_id = c.id
        WHERE ub.user_id = ? AND ub.action = 'tail' AND b.result = 'win'
        GROUP BY c.id ORDER BY hits DESC LIMIT 1
      `).get(userId);

      const wins = stats?.wins || 0, losses = stats?.losses || 0, pushes = stats?.pushes || 0;
      const total = wins + losses;
      const winPct = total > 0 ? Math.round((wins / total) * 100) : 0;
      const favText = bestCapper ? `${bestCapper.display_name} (${bestCapper.hits} winning tails)` : 'No winning tails yet!';

      return message.reply({ embeds: [{
        color: 0x0099ff,
        title: `${message.author.username}'s Tailing Profile`,
        fields: [
          { name: 'Tailing Record', value: `${wins}-${losses}-${pushes} (${winPct}%)`, inline: true },
          { name: 'Most Profitable Capper', value: favText, inline: false },
        ],
        thumbnail: { url: message.author.displayAvatarURL() },
      }] });
    } catch (error) {
      console.error('[MYSTATS ERROR]', error);
      return message.reply('Error fetching your stats.');
    }
  }

  // 💵 BANKROLL COMMAND
  if (message.content.toLowerCase() === '!bankroll') {
    try {
      const { ensureUserExists, getUserBankroll } = require('./services/database');
      ensureUserExists(message.author.id, message.author.username);
      const balance = getUserBankroll(message.author.id);
      const color = balance >= 100 ? 0x00FF00 : balance >= 50 ? 0xF39C12 : 0xFF0000;
      return message.reply({ embeds: [{
        color,
        title: `${message.author.username}'s Bankroll`,
        description: `**${balance.toFixed(2)}u**`,
        footer: { text: 'Starting balance: 100.00u | Updated on Tail payouts' },
        timestamp: new Date().toISOString(),
      }] });
    } catch (error) {
      console.error('[BANKROLL ERROR]', error);
      return message.reply('Error fetching your bankroll.');
    }
  }

  // 🏆 RESET SEASON (Admin only)
  if (message.content.toLowerCase() === '!reset_season') {
    if (!message.member.permissions.has('Administrator')) return;
    try {
      const { db: database } = require('./services/database');
      const topCappers = database.prepare(`
        SELECT c.display_name, COALESCE(SUM(b.profit_units), 0) as total_profit
        FROM bets b JOIN cappers c ON b.capper_id = c.id
        WHERE b.result IN ('win', 'loss', 'push')
        GROUP BY c.id HAVING total_profit > 0
        ORDER BY total_profit DESC LIMIT 3
      `).all();

      const medals = ['🥇', '🥈', '🥉'];
      let announcement = '**SEASON CONCLUDED!**\n\n**Final Podium:**\n';
      topCappers.forEach((c, i) => {
        announcement += `${medals[i]} **${c.display_name}**: +${c.total_profit.toFixed(2)}u\n`;
      });

      database.transaction(() => {
        database.prepare('UPDATE users SET bankroll = 100.00').run();
        database.prepare("UPDATE bets SET result = 'archived' WHERE result IN ('win', 'loss', 'push')").run();
      })();

      announcement += '\n*All user bankrolls have been reset to 100.00u. A new season begins now!*';
      return message.reply({ content: announcement });
    } catch (error) {
      console.error('[RESET_SEASON ERROR]', error);
      return message.reply('Error resetting the season.');
    }
  }

  // 2. IMMEDIATELY ignore unauthorized channels
  if (!AUTHORIZED_CHANNELS.includes(message.channel.id)) return;

  // 3. ONLY THEN do we log and process
  console.log(`[DEAF-TEST] Seen message in #${message.channel.name}`);
  console.log(`[DEAF-TEST] Snapshots: ${message.messageSnapshots?.size || 0}`);

  handleMessage(message);
});

// ── Handle message updates (FxTwitter embed unfurling) ──────
client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
  // Only care if embeds were added (0 → N) — this is Discord unfurling a link
  if (oldMsg.embeds.length === 0 && newMsg.embeds.length > 0) {
    console.log(`[DEBUG] MessageUpdate in #${newMsg.channel.name} (${newMsg.channel.id}) | new embeds: ${newMsg.embeds.length} | content: "${(newMsg.content || '').slice(0, 60)}"`);
    handleMessage(newMsg, { isUpdate: true });
  }
});

// ── Bot ready ───────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  global._discordClient = client; // Expose for webhook endpoint
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   🎰  ZoneTracker — Discord Bot  🎰       ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║   Logged in as: ${c.user.tag.padEnd(28)}║`);
  console.log(`║   Commands:     ${client.commands.size.toString().padEnd(28)}║`);
  console.log(`║   Guilds:       ${c.guilds.cache.size.toString().padEnd(28)}║`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');

  // ── Schedule auto-grading ─────────────────────────────────
  const gradeInterval = process.env.AUTO_GRADE_INTERVAL_MINUTES || 15;
  cron.schedule(`*/${gradeInterval} * * * *`, async () => {
    try {
      console.log('[Cron] Running auto-grade...');
      const results = await runAutoGrade(client);
      if (results.graded > 0) {
        console.log(`[Cron] Auto-graded ${results.graded} bets`);
        await postGradeSummary(client, results);
      }
    } catch (err) {
      console.error('[Cron] Auto-grade error:', err.message);
    }
  });

  // ── Schedule Twitter polling (every 5 minutes) ────────────
  if (process.env.TWITTER_BEARER_TOKEN) {
    cron.schedule('*/5 * * * *', async () => {
      try {
        await pollTwitterPicks(client);
      } catch (err) {
        console.error('[Cron] Twitter poll error:', err.message);
      }
    });
    console.log('🐦 Twitter polling enabled (every 5 min)');
  } else {
    console.log('⚠️  Twitter polling disabled (no TWITTER_BEARER_TOKEN)');
  }

  console.log(`⚡ Auto-grading every ${gradeInterval} min`);

  // ── Daily leaderboard post (11 PM ET / 3 AM UTC) ──────────
  cron.schedule('0 3 * * *', async () => {
    try {
      await postDailyLeaderboard(client);
      console.log('[Cron] Daily leaderboard posted');
    } catch (err) {
      console.error('[Cron] Leaderboard error:', err.message);
    }
  });

  console.log('📊 Daily leaderboard at 11 PM ET');

  // ── Daily Recap (8 AM ET / 12 PM UTC) ──────────────────────
  cron.schedule('0 12 * * *', async () => {
    try {
      const { db: database } = require('./services/database');
      const { EmbedBuilder } = require('discord.js');
      const stats = database.prepare(`
        SELECT
          SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN result = 'push' THEN 1 ELSE 0 END) as pushes,
          COALESCE(SUM(profit_units), 0) as total_profit,
          COUNT(*) as total_bets
        FROM bets
        WHERE graded_at >= datetime('now', '-1 day')
        AND result IN ('win', 'loss', 'push')
      `).get();

      if (!stats || stats.total_bets === 0) return;

      const profit = stats.total_profit || 0;
      const isGreen = profit >= 0;
      const recapEmbed = new EmbedBuilder()
        .setColor(isGreen ? 0x00FF00 : 0xFF0000)
        .setTitle("Yesterday's Betting Recap")
        .setDescription('Good morning! Here is how the server performed yesterday.')
        .addFields(
          { name: 'Total Profit', value: `${isGreen ? '+' : ''}${profit.toFixed(2)}u`, inline: true },
          { name: 'Record', value: `${stats.wins}-${stats.losses}-${stats.pushes}`, inline: true },
          { name: 'Total Graded', value: `${stats.total_bets}`, inline: true },
        )
        .setTimestamp();

      const dashId = process.env.PUBLIC_CHANNEL_ID || process.env.DASHBOARD_CHANNEL_ID;
      if (dashId) {
        const ch = await client.channels.fetch(dashId).catch(() => null);
        if (ch) await ch.send({ embeds: [recapEmbed] });
      }
      console.log('[Cron] Daily recap posted');
    } catch (err) {
      console.error('[Cron] Recap error:', err.message);
    }
  });
  console.log('🌅 Daily recap at 8 AM ET');

  // ── 90-Day DB Purge (3:30 AM UTC daily) ────────────────────
  cron.schedule('30 3 * * *', () => {
    try {
      const { db: database } = require('./services/database');
      console.log('[Cron] Running 90-Day DB Purge...');
      database.transaction(() => {
        database.prepare("DELETE FROM bets WHERE result = 'archived' AND created_at < datetime('now', '-90 days')").run();
        database.prepare('DELETE FROM user_bets WHERE bet_id NOT IN (SELECT id FROM bets)').run();
      })();
      database.exec('VACUUM');
      console.log('[Cron] DB Purge & VACUUM complete.');
    } catch (err) {
      console.error('[Cron] Purge error:', err.message);
    }
  });
  console.log('🧹 90-day DB purge at 3:30 AM UTC');

  console.log('🚀 Bot is ready!\n');
});

// ── Login ───────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
