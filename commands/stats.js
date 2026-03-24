const { SlashCommandBuilder } = require('discord.js');
const { getOrCreateCapper, getCapperStats, getBankroll, getRecentBets } = require('../services/database');
const { statsEmbed, RESULT_EMOJI, fmtOdds, fmtUnits, COLORS } = require('../utils/embeds');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View your betting stats and analytics')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Check another user\'s stats (optional)')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const capper = await getOrCreateCapper(targetUser.id, targetUser.displayName, targetUser.displayAvatarURL());
    const stats = await getCapperStats(capper.id);
    const bankroll = await getBankroll(capper.id);
    const recent = await getRecentBets(capper.id, 5);

    if (!stats || stats.total_bets === 0) {
      return interaction.editReply(`📊 **${targetUser.displayName}** hasn't logged any bets yet. Use \`/bet\` or \`/slip\` to get started!`);
    }

    // Main stats embed
    const mainEmbed = statsEmbed(stats, bankroll);
    mainEmbed.setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));

    // Recent bets embed
    const recentLines = recent.map(b => {
      const emoji = RESULT_EMOJI[b.result] || '⏳';
      const pl = b.result !== 'pending' ? ` (${fmtUnits(b.profit_units)})` : '';
      return `${emoji} ${b.description} ${fmtOdds(b.odds)} ${b.units}u${pl}`;
    });

    const recentEmbed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📋 Recent Bets')
      .setDescription(recentLines.join('\n') || 'No recent bets.')
      .setFooter({ text: 'Use /history for full bet history' });

    await interaction.editReply({ embeds: [mainEmbed, recentEmbed] });
  },
};
