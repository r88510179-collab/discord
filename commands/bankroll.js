const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOrCreateCapper, getBankroll, setBankroll } = require('../services/database');
const { COLORS, fmtMoney } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bankroll')
    .setDescription('View or set your bankroll and unit size')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View your current bankroll'))
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set your bankroll and unit size')
        .addNumberOption(opt =>
          opt.setName('amount')
            .setDescription('Starting bankroll amount ($)')
            .setRequired(true))
        .addNumberOption(opt =>
          opt.setName('unit')
            .setDescription('Unit size ($)')
            .setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.user;
    const capper = await getOrCreateCapper(user.id, user.displayName, user.displayAvatarURL());
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set') {
      const amount = interaction.options.getNumber('amount');
      const unit = interaction.options.getNumber('unit');

      await setBankroll(capper.id, amount, unit);

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('💰 Bankroll Updated')
        .addFields(
          { name: 'Starting Bankroll', value: fmtMoney(amount), inline: true },
          { name: 'Unit Size', value: fmtMoney(unit), inline: true },
          { name: 'Units Available', value: `${(amount / unit).toFixed(1)}u`, inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // View
    const bankroll = await getBankroll(capper.id);
    if (!bankroll) {
      return interaction.editReply('💰 No bankroll set yet. Use `/bankroll set` to configure.');
    }

    const pl = parseFloat(bankroll.current) - parseFloat(bankroll.starting);
    const plPct = ((pl / parseFloat(bankroll.starting)) * 100).toFixed(1);
    const color = pl >= 0 ? COLORS.success : COLORS.danger;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`💰 Bankroll — ${user.displayName}`)
      .addFields(
        { name: 'Current', value: fmtMoney(bankroll.current), inline: true },
        { name: 'Starting', value: fmtMoney(bankroll.starting), inline: true },
        { name: 'P/L', value: `${pl >= 0 ? '+' : ''}${fmtMoney(pl)} (${plPct}%)`, inline: true },
        { name: 'Unit Size', value: fmtMoney(bankroll.unit_size), inline: true },
        { name: 'Units Available', value: `${(parseFloat(bankroll.current) / parseFloat(bankroll.unit_size)).toFixed(1)}u`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
