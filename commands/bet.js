const { SlashCommandBuilder } = require('discord.js');
const { parseBetText } = require('../services/ai');
const { getOrCreateCapper, createBetWithLegs } = require('../services/database');
const { betEmbed } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Log a bet using natural language')
    .addStringOption(opt =>
      opt.setName('pick')
        .setDescription('Your bet — e.g. "Lakers -3.5 (-110) 2u" or "Parlay: Chiefs ML + Over 45.5"')
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();

    const pickText = interaction.options.getString('pick');
    const user = interaction.user;

    // Get or create capper profile
    const capper = await getOrCreateCapper(user.id, user.displayName, user.displayAvatarURL());

    // AI-parse the bet text
    const parsed = await parseBetText(pickText);

    if (!parsed.bets || parsed.bets.length === 0) {
      return interaction.editReply('❌ Couldn\'t parse that bet. Try something like:\n`/bet pick: Lakers -3.5 (-110) 2u`');
    }

    const embeds = [];
    for (const bet of parsed.bets) {
      const saved = await createBetWithLegs({
        capper_id: capper.id,
        sport: bet.sport,
        league: bet.league,
        bet_type: bet.bet_type,
        description: bet.description,
        odds: bet.odds,
        units: bet.units || 1,
        event_date: bet.event_date,
        source: 'manual',
        raw_text: pickText,
      }, bet.legs || []);

      embeds.push(betEmbed(saved, user.displayName));

      // Post to dashboard
      await postPickTracked(interaction.client, saved, user.displayName, interaction.channel?.name || 'slash-command', 'manual');
    }

    await interaction.editReply({ embeds });
  },
};
