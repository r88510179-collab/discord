const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { voidAllPending } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Admin: purge pending bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('pending')
        .setDescription('Void all pending bets (kept for historical records)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'pending') {
      const count = voidAllPending();

      const embed = new EmbedBuilder()
        .setTitle('Purged Pending Bets')
        .setColor(count > 0 ? COLORS.success : COLORS.info)
        .setDescription(
          count > 0
            ? `Voided **${count}** pending bet${count === 1 ? '' : 's'}. They remain in the database for historical records but are removed from the active queue and dashboard.`
            : 'No pending bets to purge.',
        )
        .setTimestamp()
        .setFooter({ text: 'ZoneTracker' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
