const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { deleteAllPending } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Admin: permanently delete pending bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('pending')
        .setDescription('Permanently delete all pending bets from the database')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'pending') {
      const count = deleteAllPending();

      const embed = new EmbedBuilder()
        .setTitle('Purged Pending Bets')
        .setColor(count > 0 ? COLORS.danger : COLORS.info)
        .setDescription(
          count > 0
            ? `Permanently deleted **${count}** pending bet${count === 1 ? '' : 's'} from the database.`
            : 'No pending bets to purge.',
        )
        .setTimestamp()
        .setFooter({ text: 'ZoneTracker' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
