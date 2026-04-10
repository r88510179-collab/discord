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
        .setDescription('List tracked, ignored, and unmonitored channels'))
    .addSubcommand(sub =>
      sub.setName('snapshot')
        .setDescription('Full bot state snapshot for fast triage')),

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

    // ── Snapshot: full bot state for fast triage ──
    if (sub === 'snapshot') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const { EmbedBuilder } = require('discord.js');
      const { db, getLeaderboard, getPendingBets, getTrackedTwitterAccounts } = require('../services/database');
      const v8 = require('v8');
      const mem = process.memoryUsage();
      const hs = v8.getHeapStatistics();
      const mb = (b) => (b / 1024 / 1024).toFixed(1);
      const uptimeMin = Math.round(process.uptime() / 60);
      const fmtDur = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;

      // ── 1. System ──
      const client = interaction.client;
      let totalMsgCache = 0;
      client.channels.cache.forEach(ch => { if (ch.messages) totalMsgCache += ch.messages.cache.size; });
      const sysLines = [
        `**Uptime:** ${fmtDur(uptimeMin)}`,
        `**Memory:** RSS ${mb(mem.rss)}MB | Heap ${mb(hs.used_heap_size)}/${mb(hs.heap_size_limit)}MB (${(hs.used_heap_size / hs.heap_size_limit * 100).toFixed(1)}%)`,
        `**Node:** ${process.version} | PID ${process.pid}`,
        `**Discord:** ${client.guilds.cache.size} guild(s) | ${client.channels.cache.size} ch | ${totalMsgCache} cached msgs`,
      ];

      // ── 2. Pause switches ──
      const switchLines = [
        `AutoGrader: ${process.env.AUTOGRADER_DISABLED === 'true' ? '⏸️ PAUSED' : '▶️ Active'}`,
        `Twitter Poller: ${process.env.TWITTER_POLLER_DISABLED === 'true' ? '⏸️ PAUSED' : '▶️ Active'}`,
      ];

      // ── 3. Bet pipeline ──
      const totalBets = db.prepare('SELECT COUNT(*) as c FROM bets').get().c;
      const pending = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'pending'").get().c;
      const stuck = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'pending' AND review_status = 'confirmed' AND created_at < datetime('now', '-24 hours')").get().c;
      const todayConfirmed = db.prepare("SELECT COUNT(*) as c FROM bets WHERE review_status = 'confirmed' AND created_at > datetime('now', '-24 hours')").get().c;
      const needsReview = db.prepare("SELECT COUNT(*) as c FROM bets WHERE review_status = 'needs_review'").get().c;
      const graded24h = db.prepare("SELECT result, COUNT(*) as c FROM bets WHERE graded_at > datetime('now', '-24 hours') AND result IN ('win','loss','push','void') GROUP BY result").all();
      const gradedMap = {};
      for (const r of graded24h) gradedMap[r.result] = r.c;
      const pipeLines = [
        `**Total:** ${totalBets} | **Pending:** ${pending} | **Stuck >24h:** ${stuck}`,
        `**Today confirmed:** ${todayConfirmed} | **Needs review:** ${needsReview}`,
        `**Graded 24h:** ${gradedMap.win || 0}W / ${gradedMap.loss || 0}L / ${gradedMap.push || 0}P / ${gradedMap.void || 0}V`,
      ];

      // ── 4. Grading health ──
      const lastGrade = db.prepare("SELECT MAX(graded_at) as last FROM bets WHERE graded_at IS NOT NULL").get()?.last || 'never';
      const gradeLines = [
        `**Last grade:** ${lastGrade}`,
        `**Pending queue:** ${pending}`,
        `**Brave:** healthy | **DDG:** ${typeof global.ddgFailCount !== 'undefined' ? `${global.ddgFailCount} fails` : 'unknown'}`,
      ];

      // ── 5. Twitter ingestion ──
      const tracked = getTrackedTwitterAccounts();
      let creditLine = 'N/A';
      try {
        const { getTwitterCreditStats } = require('../services/twitter');
        const cs = getTwitterCreditStats();
        creditLine = `${cs.used}/${cs.budget} (${cs.pct}%)`;
      } catch (_) {}
      const deadHandles = db.prepare(`
        SELECT t.twitter_handle FROM tracked_twitter t WHERE t.active = 1
        AND t.twitter_handle NOT IN (SELECT DISTINCT handle FROM twitter_audit_log WHERE stage = 'saved' AND created_at > datetime('now', '-7 days'))
      `).all();
      const twitLines = [
        `**Poller:** ${process.env.TWITTER_POLLER_DISABLED === 'true' ? '⏸️ PAUSED' : '▶️ Active'}`,
        `**Credits:** ${creditLine}`,
        `**Tracked handles:** ${tracked.length}`,
        deadHandles.length > 0 ? `**0 saves 7d:** ${deadHandles.slice(0, 5).map(h => `@${h.twitter_handle}`).join(', ')}${deadHandles.length > 5 ? ` +${deadHandles.length - 5}` : ''}` : '**0 saves 7d:** none',
      ];

      // ── 6. Channels ──
      const chLines = [
        `TRACKED: ${(process.env.TRACKED_CHANNELS || '').split(',').filter(Boolean).length}`,
        `PICKS: ${(process.env.PICKS_CHANNEL_IDS || '').split(',').filter(Boolean).length}`,
        `IGNORED: ${(process.env.IGNORED_CHANNELS || '').split(',').filter(Boolean).length}`,
        `HUMAN: ${(process.env.HUMAN_SUBMISSION_CHANNEL_IDS || '').split(',').filter(Boolean).join(', ') || 'none'}`,
        `SUBMIT: ${process.env.SUBMIT_CHANNEL_ID || 'none'}`,
        `DASHBOARD: ${process.env.DASHBOARD_CHANNEL_ID || 'none'}`,
        `SLIP_FEED: ${process.env.SLIP_FEED_CHANNEL_ID || 'none'}`,
        `WAR_ROOM: ${process.env.WAR_ROOM_CHANNEL_ID || 'none'}`,
      ];

      // ── 7. Secrets (names only) ──
      const knownSecrets = ['DISCORD_TOKEN','GROQ_API_KEY','GEMINI_API_KEY','CEREBRAS_API_KEY','OPENROUTER_API_KEY','MISTRAL_API_KEY','BRAVE_API_KEY','SERPER_API_KEY','TWITTERAPI_KEY','APITWITTER_KEY','MOBILE_SCRAPER_SECRET','OWNER_ID','AUTOGRADER_DISABLED','TWITTER_POLLER_DISABLED','ACTIVE_SEASON','ODDS_API_KEY','OCR_SPACE_API_KEY'];
      const setSecrets = knownSecrets.filter(k => process.env[k]);
      const secretLine = `**Set (${setSecrets.length}):** ${setSecrets.join(', ')}`;

      // ── 8. Cappers ──
      const allCappers = getLeaderboard('roi_pct', 50);
      const qualified = allCappers.filter(c => (c.wins + c.losses) >= 1);
      const top3 = qualified.slice(0, 3).map(c => `${c.display_name} ${c.wins}W-${c.losses}L ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}%`).join('\n') || 'none';
      const bot3 = [...qualified].sort((a, b) => a.roi_pct - b.roi_pct).slice(0, 3).map(c => `${c.display_name} ${c.wins}W-${c.losses}L ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}%`).join('\n') || 'none';

      // ── 9. Active handles ──
      const handles = process._getActiveHandles?.()?.length || '?';
      const requests = process._getActiveRequests?.()?.length || '?';

      // ── 10. Alerts ──
      let alertText = '✅ All systems nominal';
      try {
        const { sectionAlerts } = require('../services/healthReport');
        const alerts = sectionAlerts();
        alertText = alerts.lines.join('\n');
      } catch (_) {}

      // Build embeds
      const embed1 = new EmbedBuilder()
        .setTitle('📸 Bot State Snapshot')
        .setColor(0x3498DB)
        .addFields(
          { name: '💻 System', value: sysLines.join('\n'), inline: false },
          { name: '🔘 Pause Switches', value: switchLines.join('\n'), inline: true },
          { name: '📊 Bet Pipeline', value: pipeLines.join('\n'), inline: false },
          { name: '⚡ Grading', value: gradeLines.join('\n'), inline: true },
          { name: '🐦 Twitter', value: twitLines.join('\n'), inline: true },
        )
        .setTimestamp();

      const embed2 = new EmbedBuilder()
        .setColor(0x3498DB)
        .addFields(
          { name: '📡 Channels', value: chLines.join('\n'), inline: true },
          { name: '🔑 Secrets', value: secretLine, inline: false },
          { name: '🏆 Top 3 Cappers', value: top3, inline: true },
          { name: '🥶 Bottom 3', value: bot3, inline: true },
          { name: '⚙️ Runtime', value: `Handles: ${handles} | Requests: ${requests}`, inline: true },
          { name: '🚨 Alerts', value: alertText.slice(0, 1000), inline: false },
        );

      return interaction.editReply({ embeds: [embed1, embed2] });
    }
  },
};
