const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { runAutoGrade } = require('../services/grading');
const { getOrCreateCapper, getRecentBets, gradeBet, updateBankroll, getBankroll, saveDailySnapshot } = require('../services/database');
const { gradeBetAI } = require('../services/ai');
const { gradedEmbed, COLORS, fmtUnits } = require('../utils/embeds');
const { postBetGraded } = require('../services/dashboard');
const { calcProfit } = require('../services/grading');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('grade')
    .setDescription('Grade bets — auto or manual')
    .addSubcommand(sub =>
      sub.setName('auto')
        .setDescription('Run auto-grader on all pending bets'))
    .addSubcommand(sub =>
      sub.setName('retry-all')
        .setDescription('Force retry grading on ALL stuck pending bets (admin)'))
    .addSubcommand(sub =>
      sub.setName('test')
        .setDescription('Test search + grading on a query (admin)')
        .addStringOption(opt =>
          opt.setName('query')
            .setDescription('Search query (e.g. "Lakers Nuggets April 6 2026")')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('event_date')
            .setDescription('Event date YYYY-MM-DD (defaults to 2 days ago)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('sport')
            .setDescription('Sport (NBA, MLB, etc)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('try-stuck')
        .setDescription('Test grader on 5 oldest stuck bets (admin)'))
    .addSubcommand(sub =>
      sub.setName('manual')
        .setDescription('Manually grade your most recent pending bet')
        .addStringOption(opt =>
          opt.setName('result')
            .setDescription('Bet result')
            .setRequired(true)
            .addChoices(
              { name: '✅ Win', value: 'win' },
              { name: '❌ Loss', value: 'loss' },
              { name: '➖ Push', value: 'push' },
              { name: '🚫 Void', value: 'void' },
            ))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'test') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
        return interaction.editReply('🚫 Owner only.');
      }
      const query = interaction.options.getString('query');
      const sport = interaction.options.getString('sport') || 'Unknown';
      // Default event_date to 2 days ago so time-guard passes
      const eventDateStr = interaction.options.getString('event_date')
        || new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      try {
        const grading = require('../services/grading');
        const fakeBet = {
          id: 'test-' + Date.now(),
          description: query,
          sport,
          event_date: `${eventDateStr}T20:00:00Z`,
          created_at: `${eventDateStr}T18:00:00Z`,
        };

        // Extract teams for display
        const { findMentionedTeams, normalizeSportContext } = grading;
        let betTeamsDisplay = '(none)';
        try {
          const ctx = normalizeSportContext ? normalizeSportContext(sport) : null;
          const { matchedTeams } = findMentionedTeams(query, ctx);
          betTeamsDisplay = [...matchedTeams].map(t => t.split(' ').pop()).join(', ') || '(none)';
        } catch (_) {}

        const result = await grading.gradePropWithAI(fakeBet);
        if (result) {
          const lines = [
            `🔍 **Test Result:**`,
            `**Query:** ${query}`,
            `**Event:** ${eventDateStr} | **Sport:** ${sport}`,
            `**Bet teams extracted:** [${betTeamsDisplay}]`,
            ``,
            `**Status:** ${result.status}`,
            `**Evidence:** ${result.evidence}`,
            result.source_url ? `**Source:** ${result.source_url}` : '**Source:** _(not provided)_',
          ];
          return interaction.editReply(lines.join('\n'));
        }
        return interaction.editReply('❌ All providers failed. Check `flyctl logs` for [AI Grader] entries.');
      } catch (err) {
        return interaction.editReply(`❌ Test error: ${err.message}`);
      }
    }

    if (subcommand === 'try-stuck') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
        return interaction.editReply('🚫 Owner only.');
      }
      try {
        const { db } = require('../services/database');
        const grading = require('../services/grading');
        // Find 5 oldest pending bets with event_date > 6 hours ago
        const stuck = db.prepare(`
          SELECT b.*, c.display_name AS capper_name
          FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
          WHERE b.result = 'pending' AND b.review_status = 'confirmed'
            AND b.event_date IS NOT NULL
            AND b.event_date < datetime('now', '-6 hours')
          ORDER BY b.created_at ASC LIMIT 5
        `).all();

        if (stuck.length === 0) {
          return interaction.editReply('✅ No stuck bets older than 6 hours found.');
        }

        const lines = [];
        for (const bet of stuck) {
          const result = await grading.gradePropWithAI(bet);
          const status = result?.status || 'FAIL';
          const evidence = (result?.evidence || 'No response').slice(0, 150);
          lines.push(`\`${bet.id.slice(0, 8)}\` **${status}** — ${bet.description?.slice(0, 50)}\n└ ${evidence}`);
        }

        return interaction.editReply(`🔍 **Try-Stuck Results (${stuck.length} bets):**\n\n${lines.join('\n\n').slice(0, 1900)}`);
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    if (subcommand === 'retry-all') {
      if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
        return interaction.editReply('🚫 Owner only.');
      }
      console.log('[Grade] /grade retry-all triggered by', interaction.user.tag);
      try {
        const results = await runAutoGrade(interaction.client);
        return interaction.editReply(`🔄 Retry complete. Graded **${results.graded}** bet(s).`);
      } catch (err) {
        console.error('[Grade] retry-all error:', err);
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    if (subcommand === 'auto') {
      console.log('[Grade] /grade auto triggered by', interaction.user.tag);
      try {
        const results = await runAutoGrade(interaction.client);

        if (results.graded === 0) {
          return interaction.editReply('⏳ No bets could be auto-graded right now. Games may still be in progress.');
        }

        const embeds = [];
        const summaryEmbed = new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('⚡ Auto-Grade Complete')
          .setDescription(`Graded **${results.graded}** bet(s)`)
          .setTimestamp();
        embeds.push(summaryEmbed);

        for (const r of (results.bets || []).slice(0, 8)) {
          embeds.push(gradedEmbed(r.bet, r.result, r.profitUnits, r.grade));
        }

        return interaction.editReply({ embeds });
      } catch (err) {
        console.error('[Grade] Auto-grade error:', err);
        return interaction.editReply({ content: `❌ Auto-grade failed: ${err.message}` });
      }
    }

    // Manual grading
    const result = interaction.options.getString('result');
    const capper = await getOrCreateCapper(
      interaction.user.id,
      interaction.user.displayName,
      interaction.user.displayAvatarURL(),
    );

    const recentBets = await getRecentBets(capper.id, 1);
    const pendingBet = recentBets.find(b => b.result === 'pending');

    if (!pendingBet) {
      return interaction.editReply('⏳ No pending bets to grade.');
    }

    const profitUnits = calcProfit(pendingBet.odds || -110, pendingBet.units || 1, result);
    const aiGrade = await gradeBetAI(pendingBet, result);

    await gradeBet(pendingBet.id, result, profitUnits, aiGrade.grade, aiGrade.reason);

    // Update bankroll
    const bankroll = await getBankroll(capper.id);
    if (bankroll) {
      const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
      await updateBankroll(capper.id, dollarAmount);
    }
    await saveDailySnapshot(capper.id);

    const embed = gradedEmbed(pendingBet, result, profitUnits, aiGrade);
    await postBetGraded(interaction.client, pendingBet, result, profitUnits, aiGrade);
    await interaction.editReply({ embeds: [embed] });
  },
};
