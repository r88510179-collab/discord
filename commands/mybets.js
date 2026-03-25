const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserBets } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mybets')
    .setDescription('View your tailed and faded bets'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const bets = getUserBets(interaction.user.id);

    if (bets.length === 0) {
      return interaction.editReply({ content: 'You have no tailed or faded bets yet. Hit the Tail/Fade buttons on picks to get started!' });
    }

    const active = bets.filter(b => b.result === 'pending');
    const graded = bets.filter(b => b.result !== 'pending');

    const lines = [];

    if (active.length > 0) {
      lines.push('**ACTIVE**');
      for (const b of active) {
        const icon = b.action === 'tail' ? '🔥' : '🧊';
        const odds = b.odds != null ? (b.odds > 0 ? `+${b.odds}` : `${b.odds}`) : 'N/A';
        lines.push(`${icon} ${b.action.toUpperCase()} — **${(b.description || 'N/A').slice(0, 50)}** (${odds})`);
        lines.push(`  └ ${b.capper_name || 'Unknown'} | ${b.sport || '??'}`);
      }
    }

    if (graded.length > 0) {
      lines.push('');
      lines.push('**SETTLED**');
      for (const b of graded.slice(0, 10)) {
        const icon = b.action === 'tail' ? '🔥' : '🧊';
        const resultIcon = b.result === 'win' ? '✅' : b.result === 'loss' ? '❌' : '➖';
        // For tails: win is good, loss is bad. For fades: reversed.
        const youWon = (b.action === 'tail' && b.result === 'win') || (b.action === 'fade' && b.result === 'loss');
        const tag = youWon ? '💰' : '💸';
        lines.push(`${icon}${resultIcon}${tag} **${(b.description || 'N/A').slice(0, 40)}** — ${b.result.toUpperCase()}`);
      }
    }

    const winCount = graded.filter(b =>
      (b.action === 'tail' && b.result === 'win') || (b.action === 'fade' && b.result === 'loss'),
    ).length;
    const lossCount = graded.filter(b =>
      (b.action === 'tail' && b.result === 'loss') || (b.action === 'fade' && b.result === 'win'),
    ).length;

    const embed = new EmbedBuilder()
      .setTitle('Your Bets')
      .setColor(winCount >= lossCount ? COLORS.success : COLORS.danger)
      .setDescription(lines.join('\n') || 'No bets found.')
      .addFields(
        { name: 'Active', value: `${active.length}`, inline: true },
        { name: 'Record', value: `${winCount}W - ${lossCount}L`, inline: true },
      )
      .setFooter({ text: `${bets.length} total bets tracked` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
