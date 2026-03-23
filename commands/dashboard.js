const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getDashboardSummary, getRecentPendingBets, getTotalBankroll, getRiskedCapital } = require('../services/database');
const { COLORS, fmtOdds, fmtUnits, fmtMoney } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('View overall performance and active bets'),

  async execute(interaction) {
    const summary = getDashboardSummary();
    const bankroll = getTotalBankroll();
    const risked = getRiskedCapital();
    const available = bankroll - (risked * parseFloat(process.env.DEFAULT_UNIT_SIZE || 25));
    const recentPending = getRecentPendingBets(3);

    const winRate = (summary.wins + summary.losses) > 0
      ? ((summary.wins / (summary.wins + summary.losses)) * 100).toFixed(1)
      : '0.0';

    const profitColor = summary.total_profit >= 0 ? COLORS.success : COLORS.danger;

    const embed = new EmbedBuilder()
      .setTitle('ZoneTracker Dashboard')
      .setColor(profitColor)
      .addFields(
        { name: 'Starting Bankroll', value: fmtMoney(bankroll), inline: true },
        { name: 'Risked Capital', value: `${risked}u`, inline: true },
        { name: 'Available Cash', value: fmtMoney(Math.max(available, 0)), inline: true },
        { name: 'Profit/Loss', value: fmtUnits(summary.total_profit), inline: true },
        { name: 'Win Rate', value: `${winRate}%`, inline: true },
        { name: 'Pending', value: `${summary.pending}`, inline: true },
        { name: 'Wins', value: `${summary.wins}`, inline: true },
        { name: 'Losses', value: `${summary.losses}`, inline: true },
        { name: 'Total Bets', value: `${summary.total_bets}`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'ZoneTracker' });

    // Recent pending bets
    if (recentPending.length > 0) {
      const lines = recentPending.map((bet, i) => {
        const odds = fmtOdds(bet.odds);
        const wager = bet.wager ? ` | $${Number(bet.wager).toFixed(0)}` : '';
        const capper = bet.capper_name ? ` (${bet.capper_name})` : '';
        return `**${i + 1}.** ${bet.description} [${odds}${wager}]${capper}`;
      });
      embed.addFields({
        name: `Active Bets (${recentPending.length} most recent)`,
        value: lines.join('\n'),
      });
    } else {
      embed.addFields({
        name: 'Active Bets',
        value: 'No pending bets right now.',
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
