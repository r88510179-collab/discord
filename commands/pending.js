const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getAllPendingBets } = require('../services/database');
const { COLORS, fmtOdds } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show oldest pending bets with grading buttons')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const pending = getAllPendingBets();
    if (pending.length === 0) {
      return interaction.editReply('No pending bets to grade.');
    }

    const bets = pending.slice(0, 5);
    await interaction.editReply(`Showing **${bets.length}** of **${pending.length}** pending bet(s):`);

    for (const bet of bets) {
      const capper = bet.capper_name || 'Unknown';
      const desc = bet.description || 'N/A';
      const odds = fmtOdds(bet.odds);
      const units = bet.units ?? 1;
      const wager = bet.wager ? `$${Number(bet.wager).toFixed(2)}` : null;
      const payout = bet.payout ? `$${Number(bet.payout).toFixed(2)}` : null;

      const embed = new EmbedBuilder()
        .setTitle('Pending Bet')
        .setColor(COLORS.pending)
        .addFields(
          { name: 'Capper', value: capper, inline: true },
          { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
          { name: 'Type', value: (bet.bet_type || 'straight').toUpperCase(), inline: true },
          { name: 'Description', value: desc },
          { name: 'Odds', value: odds, inline: true },
          { name: 'Units', value: String(units), inline: true },
        );

      if (wager || payout) {
        const parts = [];
        if (wager) parts.push(`**Wager:** ${wager}`);
        if (payout) parts.push(`**To Pay:** ${payout}`);
        embed.addFields({ name: 'Financials', value: parts.join('  |  '), inline: false });
      }

      embed.addFields({ name: 'Bet ID', value: `\`${bet.id.slice(0, 8)}\``, inline: true })
        .setFooter({ text: `Created: ${bet.created_at || 'N/A'}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`grade_win:${bet.id}`)
          .setLabel('Win')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`grade_loss:${bet.id}`)
          .setLabel('Loss')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`grade_push:${bet.id}`)
          .setLabel('Push')
          .setEmoji('➖')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`grade_void:${bet.id}`)
          .setLabel('Void')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
    }
  },
};
