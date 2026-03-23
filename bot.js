require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { handleMessage } = require('./handlers/messageHandler');
const { handleWarRoomInteraction } = require('./services/warRoom');
const { handleGradeInteraction } = require('./handlers/gradeButtons');
const { runAutoGrade } = require('./services/grading');
const { pollTwitterPicks } = require('./services/twitter');
const { postGradeSummary, postDailyLeaderboard } = require('./services/dashboard');

// ── Create Discord client ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
client.on(Events.MessageCreate, (message) => {
  console.log(`[DEBUG] Message received in channel: ${message.channel.id} from: ${message.author.tag} content: "${message.content.slice(0, 50)}" attachments: ${message.attachments.size}`);
  handleMessage(message);
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
