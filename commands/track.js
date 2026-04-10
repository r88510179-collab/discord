const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { addTrackedTwitter, getTrackedTwitterAccounts, removeTrackedTwitter } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a Twitter/X capper for auto-imported picks')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add Twitter account(s) to track')
        .addStringOption(opt =>
          opt.setName('handle')
            .setDescription('Handle(s) — comma-separated for bulk (e.g. @Capper1, @Capper2)')
            .setRequired(true))
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel to post detected picks (defaults to current)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Stop tracking a Twitter account')
        .addStringOption(opt =>
          opt.setName('handle')
            .setDescription('The @handle to remove')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all tracked Twitter accounts')),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    // ═══ ADD ═══
    if (subcommand === 'add') {
      const rawInput = interaction.options.getString('handle');
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      const handles = rawInput.split(',')
        .map(h => h.replace(/<[^>]*>/g, '').replace(/@/g, '').trim().toLowerCase())
        .filter(h => h.length > 0);

      if (handles.length === 0) {
        return interaction.editReply('❌ No valid handles provided.');
      }

      const existing = getTrackedTwitterAccounts();
      const existingSet = new Set(existing.map(a => a.twitter_handle.toLowerCase()));

      let added = 0;
      let skipped = 0;
      const addedHandles = [];

      for (const handle of handles) {
        if (existingSet.has(handle)) { skipped++; continue; }
        addTrackedTwitter(handle, interaction.guildId, channel.id);
        addedHandles.push(handle);
        added++;
      }

      if (handles.length === 1) {
        if (skipped === 1) {
          return interaction.editReply(`⚠️ **@${handles[0]}** is already being tracked.`);
        }
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle('🐦 Twitter Tracker Added')
          .setDescription(`✅ Now tracking **@${handles[0]}**. Picks auto-detected via Apify + AI Bouncer.`)
          .addFields(
            { name: 'Posts to', value: `<#${channel.id}>`, inline: true },
            { name: 'Status', value: '✅ Active', inline: true },
          )
          .setTimestamp()] });
      }

      const desc = added > 0
        ? `✅ Added **${added}** account${added === 1 ? '' : 's'}.${skipped > 0 ? ` (${skipped} already tracked)` : ''}`
        : `⚠️ All ${skipped} account(s) were already being tracked.`;

      const embed = new EmbedBuilder()
        .setColor(added > 0 ? COLORS.info : COLORS.warning)
        .setTitle('🐦 Bulk Twitter Tracker')
        .setDescription(desc)
        .setFooter({ text: `${added + skipped} handle(s) processed` })
        .setTimestamp();

      if (addedHandles.length > 0 && addedHandles.length <= 30) {
        embed.addFields({ name: 'Added', value: addedHandles.map(h => `@${h}`).join(', '), inline: false });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ═══ REMOVE ═══
    if (subcommand === 'remove') {
      const rawHandle = interaction.options.getString('handle');
      const handle = rawHandle.replace(/<[^>]*>/g, '').replace(/@/g, '').trim().toLowerCase();

      if (!handle) {
        return interaction.editReply('❌ No valid handle provided.');
      }

      const removed = removeTrackedTwitter(handle);
      if (removed > 0) {
        return interaction.editReply(`✅ Removed **@${handle}** from the tracking list.`);
      }
      return interaction.editReply(`❌ **@${handle}** not found in the tracking list. Check \`/track list\`.`);
    }

    // ═══ LIST ═══
    const accounts = getTrackedTwitterAccounts();

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
