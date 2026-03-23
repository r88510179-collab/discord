const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSetting, setSetting } = require('../services/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin controls')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('audit')
        .setDescription('Toggle audit mode (all bets require review)')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('on or off')
            .setRequired(true)
            .addChoices(
              { name: 'on', value: 'on' },
              { name: 'off', value: 'off' },
            ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'audit') {
      const mode = interaction.options.getString('mode');
      const current = getSetting('audit_mode') || 'on';

      if (mode === current) {
        return interaction.reply({
          content: `Audit mode is already **${mode}**.`,
          ephemeral: true,
        });
      }

      setSetting('audit_mode', mode);

      const emoji = mode === 'on' ? '🔒' : '🟢';
      const desc = mode === 'on'
        ? 'All new bets will be saved as **needs_review** and will NOT be posted to the dashboard.'
        : 'Bets will now be posted to the dashboard automatically (Auto-Pilot mode).';

      return interaction.reply({
        content: `${emoji} Audit mode set to **${mode}**.\n${desc}`,
        ephemeral: true,
      });
    }
  },
};
