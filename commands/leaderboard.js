const { SlashCommandBuilder } = require('discord.js');
const { getLeaderboard } = require('../services/database');
const { leaderboardEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the capper leaderboard')
    .addStringOption(opt =>
      opt.setName('sort')
        .setDescription('Sort by')
        .setRequired(false)
        .addChoices(
          { name: '💰 Profit (units)', value: 'total_profit_units' },
          { name: '📈 ROI %', value: 'roi_pct' },
          { name: '🎯 Win %', value: 'win_pct' },
          { name: '📊 Total Bets', value: 'total_bets' },
        )),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const sortBy = interaction.options.getString('sort') || 'total_profit_units';
    const labels = {
      total_profit_units: 'Profit (units)',
      roi_pct: 'ROI %',
      win_pct: 'Win %',
      total_bets: 'Total Bets',
    };

    const cappers = await getLeaderboard(sortBy, 15);
    if (!cappers.length) {
      return interaction.editReply('No bets found for this season.');
    }
    const embed = leaderboardEmbed(cappers, labels[sortBy]);

    await interaction.editReply({ embeds: [embed] });
  },
};
