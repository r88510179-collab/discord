const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getUserBets } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mybets')
    .setDescription('View your tailed and faded bets'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const bets = getUserBets(interaction.user.id);

    if (bets.length === 0) {
      return interaction.editReply({ content: 'You have no tailed or faded bets yet. Hit the Tail/Fade buttons on picks to get started!' });
    }

    const active = bets.filter(b => b.status === 'pending');
    const graded = bets.filter(b => b.status !== 'pending');

    const lines = [];

    if (active.length > 0) {
      lines.push('**ACTIVE**');
      for (const b of active) {
        const icon = b.action === 'tail' ? '🔥' : '🧊';
        const odds = b.odds != null ? (b.odds > 0 ? `+${b.odds}` : `${b.odds}`) : 'N/A';
        lines.push(`${icon} ${b.action.toUpperCase()} — **${(b.description || 'N/A').slice(0, 50)}** (${odds})`);
        lines.push(`  └ ${b.capper_name || 'Unknown'} | ${b.sport || '??'} | ${Number(b.risk_amount || 1).toFixed(2)}u risk`);
      }
    }

    if (graded.length > 0) {
      lines.push('');
      lines.push('**SETTLED**');
      for (const b of graded.slice(0, 10)) {
        const icon = b.action === 'tail' ? '🔥' : '🧊';
        const resultIcon = b.status === 'won' ? '✅' : b.status === 'lost' ? '❌' : '➖';
        const pl = b.profit_units == null
          ? 'P/L N/A'
          : `${Number(b.profit_units) >= 0 ? '+' : ''}${Number(b.profit_units).toFixed(2)}u`;
        lines.push(`${icon}${resultIcon} **${(b.description || 'N/A').slice(0, 40)}** — ${b.status.toUpperCase()} (${pl})`);
      }
    }

    const winCount = graded.filter(b => b.status === 'won').length;
    const lossCount = graded.filter(b => b.status === 'lost').length;
    const pushCount = graded.filter(b => b.status === 'push').length;
    const totalProfit = graded.reduce((sum, b) => sum + Number(b.profit_units || 0), 0);

    const embed = new EmbedBuilder()
      .setTitle('Your Bets')
      .setColor(winCount >= lossCount ? COLORS.success : COLORS.danger)
      .setDescription(lines.join('\n') || 'No bets found.')
      .addFields(
        { name: 'Active', value: `${active.length}`, inline: true },
        { name: 'Record', value: `${winCount}W - ${lossCount}L - ${pushCount}P`, inline: true },
        { name: 'P/L', value: `${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}u`, inline: true },
      )
      .setFooter({ text: `${bets.length} total bets tracked` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
