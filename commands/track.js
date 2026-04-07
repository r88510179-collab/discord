const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { addTrackedTwitter, getTrackedTwitterAccounts } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a Twitter/X capper for auto-imported picks')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a Twitter account to track')
        .addStringOption(opt =>
          opt.setName('handle')
            .setDescription('Twitter handle (e.g. @SharpsCapper)')
            .setRequired(true))
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to post detected picks (defaults to current)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all tracked Twitter accounts')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const handle = interaction.options.getString('handle').replace('@', '');
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      if (!process.env.TWITTER_BEARER_TOKEN) {
        return interaction.editReply('⚠️ Twitter API not configured. Add `TWITTER_BEARER_TOKEN` to your `.env` file.');
      }

      await addTrackedTwitter(handle, interaction.guildId, channel.id);

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('🐦 Twitter Tracker Added')
        .setDescription(`Now tracking **@${handle}**`)
        .addFields(
          { name: 'Posts to', value: `<#${channel.id}>`, inline: true },
          { name: 'Status', value: '✅ Active', inline: true },
        )
        .setFooter({ text: 'Picks will be auto-detected and logged using AI' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // List
    const accounts = await getTrackedTwitterAccounts();

    if (accounts.length === 0) {
      return interaction.editReply('🐦 No Twitter accounts tracked yet. Use `/track add` to start.');
    }

    const lines = accounts.map((a, i) =>
      `**${i + 1}.** @${a.twitter_handle} → <#${a.channel_id}> ${a.active ? '✅' : '⏸️'}`
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🐦 Tracked Twitter Accounts')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${accounts.length} account(s) tracked` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
