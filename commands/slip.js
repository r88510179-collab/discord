const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOrCreateCapper } = require('../services/database');
const { COLORS } = require('../utils/embeds');
const { processSlipImage } = require('../handlers/messageHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slip')
    .setDescription('Scan a bet slip image to auto-log bets')
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('Photo of your bet slip')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('capper')
        .setDescription('Override capper name (e.g. "SharpsCapper")')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('sport')
        .setDescription('Sport hint (e.g. NBA, MLB, NHL)')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const attachment = interaction.options.getAttachment('image');
    const capperOverride = interaction.options.getString('capper');
    const sportHint = interaction.options.getString('sport');

    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.editReply('Please upload an image file (PNG, JPG, etc.).');
    }

    if (attachment.size > 10 * 1024 * 1024) {
      return interaction.editReply('Image too large. Keep it under 10MB.');
    }

    try {
      const user = interaction.user;
      const capperName = capperOverride || user.displayName;
      const capperId = capperOverride
        ? `manual_${capperOverride.toLowerCase().replace(/\s+/g, '_')}`
        : user.id;
      const capper = await getOrCreateCapper(capperId, capperName, user.displayAvatarURL());

      const result = await processSlipImage(interaction.client, attachment.url, capper.id, capperName, {
        channelId: interaction.channel?.id,
        contextHints: { capper: capperName, sport: sportHint },
      });

      if (!result || !result.ocrText) {
        return interaction.editReply('OCR could not read any text from that image. Try a clearer photo.');
      }

      if (result.bets.length === 0) {
        return interaction.editReply(`No bets detected. Raw OCR text:\n\`\`\`\n${result.ocrText.slice(0, 1500)}\n\`\`\``);
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('Bet Slip Scanned')
        .setDescription(`Detected **${result.bets.length}** bet(s) — sent to War Room for review.${capperOverride ? `\nCapper: **${capperOverride}**` : ''}${sportHint ? ` | Sport: **${sportHint}**` : ''}`)
        .setThumbnail(attachment.url)
        .addFields(
          result.bets.slice(0, 5).map(b => ({
            name: b.sport || 'Unknown',
            value: `${b.description} (${b.odds > 0 ? '+' : ''}${b.odds || 'N/A'})`,
            inline: true,
          })),
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[Slip Command]', err.message);
      await interaction.editReply('Something went wrong scanning that slip. Check the bot logs.').catch(() => {});
    }
  },
};
