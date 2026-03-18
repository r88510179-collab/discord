const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOrCreateCapper, getCapperStats, getRecentBets, getBankroll } = require('../services/database');
const { generateRecap } = require('../services/ai');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Get an AI-generated recap of your betting performance'),

  async execute(interaction) {
    await interaction.deferReply();

    const capper = await getOrCreateCapper(
      interaction.user.id,
      interaction.user.displayName,
      interaction.user.displayAvatarURL(),
    );

    const stats = await getCapperStats(capper.id);
    const recent = await getRecentBets(capper.id, 20);
    const bankroll = await getBankroll(capper.id);

    if (!stats || stats.total_bets === 0) {
      return interaction.editReply('📊 No bets logged yet — start with `/bet` or `/slip` to get your first recap!');
    }

    const fullStats = { ...stats, bankroll };
    const recap = await generateRecap(fullStats, recent);

    const color = (stats.total_profit_units || 0) >= 0 ? COLORS.success : COLORS.danger;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📰 Daily Recap — ${interaction.user.displayName}`)
      .setDescription(recap)
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
      .setFooter({ text: 'Powered by Claude AI' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
