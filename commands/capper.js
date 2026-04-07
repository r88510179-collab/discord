const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { findCapperByName, getCapperAnalytics, getBankroll } = require('../services/database');
const { COLORS, fmtOdds, fmtUnits } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('capper')
    .setDescription('View capper analytics and performance')
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('View detailed stats for a capper')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Capper display name (or partial match)')
            .setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    if (sub === 'stats') {
      const name = interaction.options.getString('name');
      const capper = findCapperByName(name);

      if (!capper) {
        return interaction.editReply(`No capper found matching "**${name}**". Check the name and try again.`);
      }

      const analytics = getCapperAnalytics(capper.id);
      const bankroll = getBankroll(capper.id);

      if (analytics.total === 0) {
        return interaction.editReply(`**${capper.display_name}** has no graded bets yet.`);
      }

      const profitable = analytics.totalProfit >= 0;
      const color = profitable ? COLORS.success : COLORS.danger;
      const trendEmoji = profitable ? '📈' : '📉';

      const embed = new EmbedBuilder()
        .setTitle(`${trendEmoji} ${capper.display_name} — Capper Analytics`)
        .setColor(color)
        .addFields(
          { name: 'Record', value: `**${analytics.wins}**W - **${analytics.losses}**L - **${analytics.pushes}**P`, inline: true },
          { name: 'Win Rate', value: `**${analytics.winRate}%**`, inline: true },
          { name: 'Streak', value: analytics.streak ? `**${analytics.streak}**` : 'N/A', inline: true },
          { name: 'Total Profit', value: `**${fmtUnits(analytics.totalProfit)}**`, inline: true },
          { name: 'Avg Odds', value: `**${fmtOdds(analytics.avgOdds)}**`, inline: true },
          { name: 'Graded Bets', value: `**${analytics.total}**`, inline: true },
        );

      // Bankroll
      if (bankroll) {
        const pnl = parseFloat(bankroll.current) - parseFloat(bankroll.starting);
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        embed.addFields({
          name: 'Bankroll',
          value: `$${parseFloat(bankroll.current).toFixed(2)} (${pnlStr})`,
          inline: false,
        });
      }

      // Sport breakdown
      if (analytics.sportBreakdown.length > 0) {
        const sportLines = analytics.sportBreakdown.map(s => {
          const pct = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : '0';
          return `**${s.sport}** — ${s.wins}W/${s.losses}L (${pct}%)`;
        });
        embed.addFields({
          name: 'Sport Breakdown',
          value: sportLines.join('\n'),
          inline: false,
        });
      }

      // Best sport callout
      if (analytics.bestSport && analytics.bestSport.wins > 0) {
        embed.setFooter({
          text: `Best sport: ${analytics.bestSport.sport} (${analytics.bestSport.wins} wins) | ZoneTracker`,
        });
      } else {
        embed.setFooter({ text: 'ZoneTracker' });
      }

      embed.setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }
  },
};
