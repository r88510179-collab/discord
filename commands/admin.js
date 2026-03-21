const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getSetting, setSetting } = require('../services/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin controls')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('audit')
        .setDescription('Toggle audit mode on/off')
        .addStringOption(opt =>
          opt.setName('state')
            .setDescription('on or off')
            .setRequired(true)
            .addChoices(
              { name: 'on', value: 'on' },
              { name: 'off', value: 'off' },
            ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'audit') {
      const state = interaction.options.getString('state');
      setSetting('audit_mode', state);
      const current = getSetting('audit_mode');
      await interaction.reply({
        content: `Audit mode is now **${current}**. ${current === 'on' ? 'All new bets will be held for review.' : 'Bets will be auto-confirmed.'}`,
        ephemeral: true,
      });
    }
  },
};
