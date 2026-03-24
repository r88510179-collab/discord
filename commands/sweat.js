const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLiveScores } = require('../services/odds');
const { COLORS } = require('../utils/embeds');

const SPORT_CHOICES = [
  { name: 'NBA', value: 'nba' },
  { name: 'NCAAB', value: 'ncaab' },
  { name: 'NFL', value: 'nfl' },
  { name: 'MLB', value: 'mlb' },
  { name: 'NHL', value: 'nhl' },
  { name: 'EPL', value: 'epl' },
  { name: 'UCL', value: 'ucl' },
  { name: 'La Liga', value: 'liga' },
  { name: 'MLS', value: 'mls' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sweat')
    .setDescription('Live scores for a sport')
    .addStringOption(opt =>
      opt.setName('sport')
        .setDescription('Sport to check')
        .setRequired(true)
        .addChoices(...SPORT_CHOICES)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const sport = interaction.options.getString('sport');
    const games = await getLiveScores(sport);

    if (!games || games.length === 0) {
      return interaction.editReply({ content: `No live or recent games found for **${sport.toUpperCase()}**.` });
    }

    const live = games.filter(g => !g.completed && g.homeScore !== null);
    const final = games.filter(g => g.completed);
    const upcoming = games.filter(g => !g.completed && g.homeScore === null);

    const lines = [];

    if (live.length > 0) {
      lines.push('**LIVE**');
      for (const g of live) {
        lines.push(`  ${g.away} **${g.awayScore}** @ ${g.home} **${g.homeScore}**`);
      }
    }

    if (final.length > 0) {
      lines.push('');
      lines.push('**FINAL**');
      for (const g of final.slice(0, 10)) {
        lines.push(`  ${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}`);
      }
    }

    if (upcoming.length > 0) {
      lines.push('');
      lines.push('**UPCOMING**');
      for (const g of upcoming.slice(0, 10)) {
        const time = g.commenceTime
          ? new Date(g.commenceTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
          : 'TBD';
        lines.push(`  ${g.away} @ ${g.home} — ${time} ET`);
      }
    }

    const color = live.length > 0 ? COLORS.danger : COLORS.info;
    const embed = new EmbedBuilder()
      .setTitle(`${sport.toUpperCase()} Scoreboard`)
      .setColor(color)
      .setDescription(lines.join('\n') || 'No games.')
      .setFooter({ text: `${live.length} live | ${final.length} final | ${upcoming.length} upcoming` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
