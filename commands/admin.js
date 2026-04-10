const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSetting, setSetting, purgeTable } = require('../services/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin controls')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('audit')
        .setDescription('Toggle audit mode (all bets require review)')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('on or off')
            .setRequired(true)
            .addChoices(
              { name: 'on', value: 'on' },
              { name: 'off', value: 'off' },
            )))
    .addSubcommand(sub =>
      sub.setName('purge')
        .setDescription('⚠️ Wipe a database table (OWNER ONLY)')
        .addStringOption(opt =>
          opt.setName('table')
            .setDescription('Table to wipe')
            .setRequired(true)
            .addChoices(
              { name: 'Bets', value: 'bets' },
              { name: 'Tracked Accounts', value: 'tracked_twitter' },
              { name: 'Processed Tweets (dedup)', value: 'processed_tweets' },
            )))
    .addSubcommand(sub =>
      sub.setName('revert-today')
        .setDescription('⚠️ Revert all hallucinated grades from today (OWNER ONLY)'))
    .addSubcommand(sub =>
      sub.setName('clean-dashboard')
        .setDescription('⚠️ Delete all non-scoreboard messages from dashboard channel'))
    .addSubcommand(sub =>
      sub.setName('revert-hallucinations')
        .setDescription('⚠️ Find and revert offseason/hallucinated bets'))
    .addSubcommand(sub =>
      sub.setName('revert-by-id')
        .setDescription('Revert a single bet grade by ID')
        .addStringOption(opt => opt.setName('bet_id').setDescription('Bet ID (first 8 chars ok)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('pause-twitter')
        .setDescription('Pause/resume Twitter poller'))
    .addSubcommand(sub =>
      sub.setName('pause-grader')
        .setDescription('Pause/resume AutoGrader'))
    .addSubcommand(sub =>
      sub.setName('list-channels')
        .setDescription('List tracked, ignored, and unmonitored channels')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'audit') {
      const mode = interaction.options.getString('mode');
      const current = getSetting('audit_mode') || 'on';

      if (mode === current) {
        return interaction.reply({
          content: `Audit mode is already **${mode}**.`,
          ephemeral: true,
        });
      }

      setSetting('audit_mode', mode);

      const emoji = mode === 'on' ? '🔒' : '🟢';
      const desc = mode === 'on'
        ? 'All new bets will be saved as **needs_review** and will NOT be posted to the dashboard.'
        : 'Bets will now be posted to the dashboard automatically (Auto-Pilot mode).';

      return interaction.reply({
        content: `${emoji} Audit mode set to **${mode}**.\n${desc}`,
        ephemeral: true,
      });
    }

    if (sub === 'purge') {
      // Owner-only protection
      const ownerId = process.env.OWNER_ID;
      if (ownerId && interaction.user.id !== ownerId) {
        return interaction.reply({
          content: '🚫 This command is restricted to the bot owner.',
          ephemeral: true,
        });
      }

      const table = interaction.options.getString('table');
      const deleted = purgeTable(table);

      return interaction.reply({
        content: `💥 **PURGE COMPLETE**: Deleted **${deleted}** row(s) from \`${table}\`.`,
        ephemeral: true,
      });
    }

    if (sub === 'revert-today') {
      const ownerId = process.env.OWNER_ID;
      if (ownerId && interaction.user.id !== ownerId) {
        return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const { db } = require('../services/database');

      // Find hallucinated grades: graded today on games that are today or future
      const suspect = db.prepare(`
        SELECT id, description, result, graded_at, grade_reason
        FROM bets
        WHERE result IN ('win', 'loss', 'push')
          AND graded_at >= datetime('now', '-24 hours')
          AND (date(event_date) >= date('now') OR event_date IS NULL)
      `).all();

      if (suspect.length === 0) {
        return interaction.editReply('✅ No suspect grades found in the last 24h.');
      }

      // Revert all suspect grades
      const revert = db.prepare(`
        UPDATE bets
        SET result = 'pending',
            profit_units = NULL,
            graded_at = NULL,
            grade = NULL,
            grade_reason = 'REVERTED: hallucinated grade — no verified search results'
        WHERE id = ?
      `);

      const txn = db.transaction(() => {
        for (const bet of suspect) revert.run(bet.id);
      });
      txn();

      const summary = suspect.map(b => `• \`${b.id.slice(0, 8)}\` ${b.result.toUpperCase()} → PENDING: ${b.description?.slice(0, 50)}`).join('\n');

      // DM owner
      if (ownerId && interaction.client) {
        try {
          const owner = await interaction.client.users.fetch(ownerId);
          await owner.send(`🔄 **Reverted ${suspect.length} hallucinated grade(s):**\n${summary}`);
        } catch (_) {}
      }

      return interaction.editReply(`🔄 Reverted **${suspect.length}** suspect grade(s):\n${summary.slice(0, 1900)}`);
    }

    if (sub === 'clean-dashboard') {
      const ownerId = process.env.OWNER_ID;
      if (ownerId && interaction.user.id !== ownerId) {
        return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
      }

      const dashChId = process.env.DASHBOARD_CHANNEL_ID;
      if (!dashChId) return interaction.reply({ content: '❌ DASHBOARD_CHANNEL_ID not set.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      try {
        const ch = await interaction.client.channels.fetch(dashChId);
        const { getSetting } = require('../services/database');
        const scoreboardMsgId = getSetting('scoreboard_message_id');

        // Fetch last 100 messages and delete non-scoreboard ones
        const messages = await ch.messages.fetch({ limit: 100 });
        let deleted = 0;
        for (const [id, msg] of messages) {
          if (id === scoreboardMsgId) continue; // Keep the scoreboard
          try {
            await msg.delete();
            deleted++;
          } catch (_) {}
        }

        // Force-refresh the scoreboard
        const { updateScoreboard } = require('../services/dashboard');
        await updateScoreboard(interaction.client, { force: true });

        return interaction.editReply(`🧹 Cleaned **${deleted}** message(s) from dashboard. Scoreboard refreshed.`);
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    if (sub === 'revert-hallucinations') {
      const ownerId = process.env.OWNER_ID;
      if (ownerId && interaction.user.id !== ownerId) {
        return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const { db, isInSeason } = require('../services/database');
      const { isInSeason: checkSeason } = require('../services/ai');

      // Find offseason bets + bets with placeholder descriptions
      const suspect = db.prepare(`
        SELECT id, description, sport, result, review_status, created_at
        FROM bets
        WHERE created_at > datetime('now', '-3 days')
          AND result IN ('pending', 'win', 'loss')
          AND (
            sport IN ('NFL', 'NCAAF', 'CS2', 'CSGO', 'Valorant')
            OR LOWER(description) LIKE '%missing legs%'
            OR LOWER(description) LIKE '%capper hid the picks%'
            OR LOWER(description) LIKE '%placeholder%'
          )
        ORDER BY created_at DESC
      `).all();

      // Also check seasonality for each
      const offseason = suspect.filter(b => {
        if (['CS2', 'CSGO', 'Valorant'].includes(b.sport)) return true;
        return !checkSeason(b.sport);
      });

      if (offseason.length === 0) {
        return interaction.editReply('✅ No hallucinated bets found in last 3 days.');
      }

      const revert = db.prepare("UPDATE bets SET result = 'void', review_status = 'rejected', grade_reason = 'REVERTED: AI hallucination — offseason or placeholder' WHERE id = ?");
      db.transaction(() => { for (const b of offseason) revert.run(b.id); })();

      const lines = offseason.map(b => `• \`${b.id.slice(0, 8)}\` ${b.sport} — ${b.description?.slice(0, 50)}`);
      return interaction.editReply(`🔄 Reverted **${offseason.length}** hallucinated bet(s):\n${lines.join('\n').slice(0, 1900)}`);
    }

    // ── Revert single bet by ID ──
    if (sub === 'revert-by-id') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      const partialId = interaction.options.getString('bet_id');
      const { db } = require('../services/database');
      const bet = db.prepare('SELECT id, description, result FROM bets WHERE id LIKE ?').get(`${partialId}%`);
      if (!bet) return interaction.reply({ content: `❌ No bet found matching \`${partialId}\``, ephemeral: true });
      db.prepare("UPDATE bets SET result = 'pending', profit_units = NULL, graded_at = NULL, grade = NULL, grade_reason = 'REVERTED manually via /admin revert-by-id' WHERE id = ?").run(bet.id);
      return interaction.reply({ content: `🔄 Reverted \`${bet.id.slice(0, 8)}\` (was ${bet.result}) → PENDING\n${bet.description?.slice(0, 80)}`, ephemeral: true });
    }

    // ── Toggle Twitter poller ──
    if (sub === 'pause-twitter') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      const current = process.env.TWITTER_POLLER_DISABLED === 'true';
      process.env.TWITTER_POLLER_DISABLED = current ? 'false' : 'true';
      return interaction.reply({ content: current ? '▶️ Twitter poller **resumed**.' : '⏸️ Twitter poller **paused**.\nPersist with: `fly secrets set TWITTER_POLLER_DISABLED=true`', ephemeral: true });
    }

    // ── Toggle AutoGrader ──
    if (sub === 'pause-grader') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      const current = process.env.AUTOGRADER_DISABLED === 'true';
      process.env.AUTOGRADER_DISABLED = current ? 'false' : 'true';
      return interaction.reply({ content: current ? '▶️ AutoGrader **resumed**.' : '⏸️ AutoGrader **paused**.\nPersist with: `fly secrets set AUTOGRADER_DISABLED=true`', ephemeral: true });
    }

    // ── List channels ──
    if (sub === 'list-channels') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const tracked = (process.env.TRACKED_CHANNELS || '').split(',').filter(Boolean);
      const ignored = (process.env.IGNORED_CHANNELS || '').split(',').filter(Boolean);
      const submit = process.env.SUBMIT_CHANNEL_ID || 'none';
      const human = (process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').filter(Boolean);
      const picks = (process.env.PICKS_CHANNEL_IDS || '').split(',').filter(Boolean);

      const lines = [
        `**TRACKED_CHANNELS:** ${tracked.length} channel(s)`,
        `**PICKS_CHANNEL_IDS:** ${picks.length} channel(s)`,
        `**IGNORED_CHANNELS:** ${ignored.length} channel(s)`,
        `**SUBMIT_CHANNEL_ID:** ${submit}`,
        `**HUMAN_SUBMISSION_CHANNEL_IDS:** ${human.length > 0 ? human.join(', ') : 'none'}`,
        `\n**Status:**`,
        `Twitter Poller: ${process.env.TWITTER_POLLER_DISABLED === 'true' ? '⏸️ PAUSED' : '▶️ Active'}`,
        `AutoGrader: ${process.env.AUTOGRADER_DISABLED === 'true' ? '⏸️ PAUSED' : '▶️ Active'}`,
      ];
      return interaction.editReply(lines.join('\n'));
    }
  },
};
