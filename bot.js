require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, Options, Partials } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ── Health check server (starts FIRST, before Discord login) ──
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));
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
const AUTHORIZED_CHANNELS = ['1487115295310217357'];

client.on(Events.MessageCreate, (message) => {
  // 1. IMMEDIATELY ignore bots (prevents infinite loops)
  if (message.author.bot) return;

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
  console.log('🚀 Bot is ready!\n');
});

// ── Login ───────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
