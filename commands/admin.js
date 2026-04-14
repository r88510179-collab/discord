const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSetting, setSetting, purgeTable, revertBetToPending } = require('../services/database');

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
        .setDescription('Full bot state snapshot for fast triage'))
    .addSubcommand(sub =>
      sub.setName('calibrate')
        .setDescription('Run unit calibration on all cappers'))
    .addSubcommand(sub =>
      sub.setName('grade-audit')
        .setDescription('Show grading audit trail for a bet')
        .addStringOption(opt => opt.setName('bet_id').setDescription('Bet ID (first 8 chars ok)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('grading-unstick')
        .setDescription('Clear stale grading locks + list quarantined bets + optionally force a bet back to ready')
        .addStringOption(opt => opt.setName('force_ready_bet_id').setDescription('Optional: bet id (prefix ok) to reset to ready').setRequired(false))),

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

      // Revert all suspect grades via centralized helper (also resets state machine)
      const txn = db.transaction(() => {
        for (const bet of suspect) revertBetToPending(bet.id, 'REVERTED: hallucinated grade — no verified search results');
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

      // P0: refactor through gradeBetRecord + gateway (force=true for admin override).
      // Note: per plan decision 1, this now only voids bets that are still 'pending'
      // — the hardened gradeBetRecord WHERE-clause blocks already-terminal rows by
      // design. For already-graded hallucinations, use /admin revert-by-id.
      const { gradeBet: gradeBetRecord } = require('../services/database');
      const { canFinalizeBet } = require('../services/grading');
      let reverted = 0;
      const skipped = [];
      db.transaction(() => {
        for (const b of offseason) {
          const gate = canFinalizeBet({ db, betId: b.id, requestedResult: 'void', source: 'admin_revert_halluc', force: true });
          if (!gate.ok) { skipped.push(b); continue; }
          const gr = gradeBetRecord(b.id, 'void', 0, null, 'REVERTED: AI hallucination — offseason or placeholder', true);
          if (gr.graded) {
            db.prepare("UPDATE bets SET review_status = 'rejected' WHERE id = ?").run(b.id);
            reverted++;
          } else {
            skipped.push(b);
          }
        }
      })();

      const lines = offseason.map(b => `• \`${b.id.slice(0, 8)}\` ${b.sport} — ${b.description?.slice(0, 50)}`);
      const skippedNote = skipped.length > 0
        ? `\n⚠️ **${skipped.length}** already-terminal bet(s) skipped — use \`/admin revert-by-id\` to handle those.`
        : '';
      return interaction.editReply(`🔄 Reverted **${reverted}** hallucinated bet(s):\n${lines.join('\n').slice(0, 1800)}${skippedNote}`);
    }

    // ── Revert single bet by ID ──
    if (sub === 'revert-by-id') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      const partialId = interaction.options.getString('bet_id');
      const { db } = require('../services/database');
      const bet = db.prepare('SELECT id, description, result FROM bets WHERE id LIKE ?').get(`${partialId}%`);
      if (!bet) return interaction.reply({ content: `❌ No bet found matching \`${partialId}\``, ephemeral: true });
      // Resets state machine fields too — bet becomes eligible for next grade cycle.
      revertBetToPending(bet.id, 'REVERTED manually via /admin revert-by-id');
      return interaction.reply({ content: `🔄 Reverted \`${bet.id.slice(0, 8)}\` (was ${bet.result}) → PENDING (state=ready, attempts=0)\n${bet.description?.slice(0, 80)}`, ephemeral: true });
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

    // ── Calibrate: run unit calibration on all cappers ──
    if (sub === 'calibrate') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const { calibrateAllCappers } = require('../services/calibration');
      const results = calibrateAllCappers();

      const calibrated = results.details.filter(r => r.status === 'calibrated');
      const volatile = results.details.filter(r => r.status === 'volatile');
      const insufficient = results.details.filter(r => r.status === 'insufficient_data');

      let response = `**Calibration Complete**\n\n`;
      response += `✅ Calibrated: ${results.calibrated}\n`;
      response += `⚠️ Volatile (high variance): ${results.volatile}\n`;
      response += `❓ Insufficient data: ${results.insufficient}\n\n`;

      if (calibrated.length > 0) {
        response += `**Calibrated cappers:**\n`;
        for (const r of calibrated) {
          response += `• ${r.name}: 1u ≈ $${r.unitSize.toFixed(2)} (${r.sample_size} samples, CV ${r.cv.toFixed(2)})\n`;
        }
      }
      if (volatile.length > 0) {
        response += `\n**Volatile cappers (won't calibrate):**\n`;
        for (const r of volatile) {
          response += `• ${r.name}: CV ${r.cv.toFixed(2)} (${r.sample_size} samples)\n`;
        }
      }

      return interaction.editReply(response.slice(0, 1900));
    }

    // ── Grade audit: show grading trail for a bet ──
    if (sub === 'grade-audit') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const partialId = interaction.options.getString('bet_id');
      const { db } = require('../services/database');
      const { EmbedBuilder } = require('discord.js');
      const rows = db.prepare('SELECT * FROM grading_audit WHERE bet_id LIKE ? ORDER BY timestamp ASC').all(`${partialId}%`);
      if (rows.length === 0) return interaction.editReply(`No audit rows for bet \`${partialId}\`.`);

      const bet = db.prepare('SELECT description, sport, result FROM bets WHERE id LIKE ?').get(`${partialId}%`);
      const embed = new EmbedBuilder()
        .setTitle(`🔍 Grade Audit: ${partialId}`)
        .setColor(0x3498DB)
        .setDescription(`**Bet:** ${bet?.description?.slice(0, 80) || '?'}\n**Sport:** ${bet?.sport || '?'} | **Result:** ${bet?.result || '?'}\n**Attempts:** ${rows.length}`)
        .setTimestamp();

      // Show last 5 attempts as fields
      const show = rows.slice(-5);
      for (const r of show) {
        const ts = new Date(r.timestamp).toISOString().slice(0, 19).replace('T', ' ');
        const sport = r.reclassified ? `${r.sport_in}→${r.sport_out}` : (r.sport_out || '?');
        const guards_p = r.guards_passed ? JSON.parse(r.guards_passed).join(',') : '';
        const guards_f = r.guards_failed ? JSON.parse(r.guards_failed).join(',') : '';
        const lines = [
          `**Time:** ${ts} | **#${r.attempt_num}**`,
          `**Sport:** ${sport}${r.is_parlay ? ` | Leg ${(r.leg_index ?? 0) + 1}/${r.leg_count}` : ''}`,
          `**Search:** ${r.search_backend || '?'} ${r.search_hits || 0} hits (${r.search_duration_ms || 0}ms)`,
          `**Provider:** ${r.provider_used || 'none'}`,
          guards_p ? `**Guards OK:** ${guards_p}` : '',
          guards_f ? `**Guards FAIL:** ${guards_f}` : '',
          `**Status:** ${r.final_status || '?'}`,
          `**Evidence:** ${(r.final_evidence || '').slice(0, 120)}`,
        ].filter(Boolean);
        embed.addFields({ name: `Attempt ${r.attempt_num}`, value: lines.join('\n').slice(0, 1000) });
      }
      if (rows.length > 5) embed.setFooter({ text: `Showing last 5 of ${rows.length} attempts` });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Grading unstick: clear stale locks, list quarantined, optional force-ready ──
    if (sub === 'grading-unstick') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const { db } = require('../services/database');
      const forceId = interaction.options.getString('force_ready_bet_id');

      // 1. Clear stale locks (>1h old) on ready/backoff bets
      const cleared = db.prepare(`
        UPDATE bets SET grading_lock_until = NULL
        WHERE grading_lock_until IS NOT NULL
          AND grading_lock_until < datetime('now','-1 hour')
          AND grading_state IN ('ready','backoff')
      `).run();

      // 2. 24h attempt count (for daily cap visibility)
      const attempts24h = db.prepare('SELECT COUNT(*) AS c FROM grading_audit WHERE timestamp > (unixepoch() - 86400) * 1000').get()?.c || 0;
      const DAILY_CAP = 10_000;
      const capStatus = attempts24h > DAILY_CAP ? `🚨 PAUSED (exceeded cap ${DAILY_CAP})` : `▶️ Active (${attempts24h}/${DAILY_CAP})`;

      // 3. List quarantined bets
      const quarantined = db.prepare(`
        SELECT id, description, grading_attempts, grading_last_failure_reason
        FROM bets WHERE grading_state = 'quarantined'
        ORDER BY grading_last_attempt_at DESC LIMIT 25
      `).all();

      // 4. Optional force-ready
      let forceMsg = '';
      if (forceId) {
        const target = db.prepare('SELECT id, result FROM bets WHERE id LIKE ?').get(`${forceId}%`);
        if (!target) forceMsg = `\n⚠️ No bet matches \`${forceId}\``;
        else if (target.result && target.result !== 'pending') forceMsg = `\n⚠️ \`${target.id.slice(0, 8)}\` is already ${target.result} — use revert-by-id first`;
        else {
          db.prepare(`UPDATE bets SET grading_state='ready', grading_attempts=0,
                        grading_lock_until=NULL, grading_next_attempt_at=NULL,
                        grading_last_failure_reason=NULL WHERE id = ?`).run(target.id);
          forceMsg = `\n🔄 Forced \`${target.id.slice(0, 8)}\` → state=ready, attempts=0`;
        }
      }

      const qList = quarantined.length === 0
        ? '_none_'
        : quarantined.map(b => `• \`${b.id.slice(0, 8)}\` att=${b.grading_attempts} ${(b.description || '').slice(0, 50)} — ${(b.grading_last_failure_reason || '').slice(0, 60)}`).join('\n');

      return interaction.editReply({
        content: `🔧 **Grading Unstick**\n**Cap status:** ${capStatus}\n**Cleared stale locks:** ${cleared.changes}\n**Quarantined (${quarantined.length}):**\n${qList}${forceMsg}`.slice(0, 1900)
      });
    }

    // ── Snapshot: full bot state for fast triage ──
    if (sub === 'snapshot') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const { EmbedBuilder } = require('discord.js');
      const { db, getLeaderboard, getTrackedTwitterAccounts } = require('../services/database');
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
      // Fetch calibration data for annotation
      const calData = {};
      try {
        const calRows = db.prepare('SELECT id, calibration_status, calibrated_unit_size FROM cappers WHERE calibration_status IS NOT NULL').all();
        for (const r of calRows) calData[r.id] = r;
      } catch (_) {}
      const calBadge = (c) => {
        const cal = calData[c.id];
        if (!cal) return '';
        if (cal.calibration_status === 'calibrated') return ` (1u≈$${cal.calibrated_unit_size?.toFixed(0) || '?'})`;
        if (cal.calibration_status === 'volatile') return ' (1u≈variable)';
        return '';
      };
      const top3 = qualified.slice(0, 3).map(c => `${c.display_name} ${c.wins}W-${c.losses}L ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}%${calBadge(c)}`).join('\n') || 'none';
      const bot3 = [...qualified].sort((a, b) => a.roi_pct - b.roi_pct).slice(0, 3).map(c => `${c.display_name} ${c.wins}W-${c.losses}L ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}%${calBadge(c)}`).join('\n') || 'none';

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
