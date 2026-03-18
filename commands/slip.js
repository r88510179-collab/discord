const { SlashCommandBuilder } = require('discord.js');
const { parseBetSlipImage } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs } = require('../services/database');
const { betEmbed, COLORS } = require('../utils/embeds');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slip')
    .setDescription('Scan a bet slip image to auto-log bets')
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('Photo of your bet slip')
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();

    const attachment = interaction.options.getAttachment('image');

    // Validate it's an image
    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.editReply('❌ Please upload an image file (PNG, JPG, etc.).');
    }

    // Size check (Claude max ~20MB but let's be reasonable)
    if (attachment.size > 10 * 1024 * 1024) {
      return interaction.editReply('❌ Image too large. Keep it under 10MB.');
    }

    // Download and convert to base64
    const res = await fetch(attachment.url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString('base64');

    // Determine media type
    const mediaType = attachment.contentType || 'image/png';

    // AI-parse the slip
    const parsed = await parseBetSlipImage(base64, mediaType);

    if (!parsed.bets || parsed.bets.length === 0) {
      return interaction.editReply('❌ Couldn\'t read any bets from that slip. Try a clearer photo.');
    }

    const user = interaction.user;
    const capper = await getOrCreateCapper(user.id, user.displayName, user.displayAvatarURL());

    // Header embed
    const headerEmbed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📸 Bet Slip Scanned')
      .setDescription(`Detected **${parsed.bets.length}** bet(s) from **${parsed.sportsbook || 'Unknown Sportsbook'}**`)
      .setThumbnail(attachment.url);

    const embeds = [headerEmbed];

    for (const bet of parsed.bets) {
      const saved = await createBetWithLegs({
        capper_id: capper.id,
        sport: bet.sport,
        league: bet.league,
        bet_type: bet.bet_type,
        description: bet.description,
        odds: bet.odds,
        units: bet.units || (bet.stake_amount ? Math.round(bet.stake_amount / 25 * 10) / 10 : 1),
        event_date: bet.event_date,
        source: 'slip',
        raw_text: JSON.stringify(bet),
      }, bet.legs || []);

      embeds.push(betEmbed(saved, user.displayName));
    }

    await interaction.editReply({ embeds: embeds.slice(0, 10) }); // Discord max 10 embeds
  },
};
