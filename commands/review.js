const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getPendingReviews, approveBet, rejectBet } = require('../services/database');
const { betEmbed, COLORS } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Manage the manual review queue for low-confidence bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show bets awaiting manual review'))
    .addSubcommand(sub =>
      sub.setName('approve')
        .setDescription('Approve a flagged bet and announce it')
        .addStringOption(opt =>
          opt.setName('bet_id')
            .setDescription('The bet ID to approve')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('reject')
        .setDescription('Reject and remove a flagged bet')
        .addStringOption(opt =>
          opt.setName('bet_id')
            .setDescription('The bet ID to reject')
            .setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    // ── /review list ───────────────────────────────────────
    if (subcommand === 'list') {
      const pending = getPendingReviews();

      if (pending.length === 0) {
        return interaction.editReply('✅ Review queue is empty — no bets need attention.');
      }

      const lines = pending.slice(0, 20).map((bet, i) => {
        const capper = bet.capper_name || 'Unknown';
        const desc = (bet.description || '').slice(0, 80);
        const odds = bet.odds > 0 ? `+${bet.odds}` : `${bet.odds}`;
        const date = bet.created_at ? bet.created_at.slice(0, 16) : '';
        return `**${i + 1}.** \`${bet.id.slice(0, 8)}\` — **${capper}**: ${desc} (${odds}) — ${date}`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle(`🔍 Review Queue — ${pending.length} bet(s)`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use /review approve <bet_id> or /review reject <bet_id>' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /review approve <bet_id> ───────────────────────────
    if (subcommand === 'approve') {
      const betId = interaction.options.getString('bet_id');
      const bet = approveBet(betId);

      if (!bet) {
        return interaction.editReply(`❌ No bet found with ID \`${betId}\` in the review queue.`);
      }

      // Post the now-approved bet to the dashboard
      const capperName = bet.capper_name || 'Unknown';
      const channelName = bet.source_channel_id || 'unknown';
      await postPickTracked(interaction.client, bet, capperName, channelName, bet.source || 'manual');

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ Bet Approved')
        .setDescription(`**${bet.description}**`)
        .addFields(
          { name: 'Capper', value: capperName, inline: true },
          { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
          { name: 'Odds', value: `${bet.odds > 0 ? '+' : ''}${bet.odds || -110}`, inline: true },
          { name: 'Approved by', value: interaction.user.displayName, inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /review reject <bet_id> ────────────────────────────
    if (subcommand === 'reject') {
      const betId = interaction.options.getString('bet_id');
      const deleted = rejectBet(betId);

      if (!deleted) {
        return interaction.editReply(`❌ No bet found with ID \`${betId}\` in the review queue.`);
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.danger)
        .setTitle('🗑️ Bet Rejected')
        .setDescription(`Bet \`${betId.slice(0, 8)}\` has been removed from the database.`)
        .addFields(
          { name: 'Rejected by', value: interaction.user.displayName, inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
