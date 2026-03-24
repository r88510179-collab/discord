const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getPendingBets } = require('../services/database');
const { shopLine, extractTeamFromDescription } = require('../services/odds');
const { americanToDecimal, impliedProbability } = require('../services/bankroll');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Audit tools for pending bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('clv')
        .setDescription('Check Closing Line Value on all pending bets')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'clv') {
      await interaction.deferReply();

      const pending = getPendingBets().filter(b => b.review_status === 'confirmed');
      if (pending.length === 0) {
        return interaction.editReply({ content: 'No confirmed pending bets to audit.' });
      }

      const results = [];

      for (const bet of pending.slice(0, 15)) {
        const teamSearch = extractTeamFromDescription(bet.description);
        if (!teamSearch || !bet.odds) {
          results.push({
            bet,
            status: 'skip',
            label: '⚪ No odds data',
          });
          continue;
        }

        let marketOffer;
        try {
          marketOffer = await shopLine(teamSearch, bet.sport);
        } catch {
          // API failure — skip
        }

        if (!marketOffer) {
          results.push({
            bet,
            status: 'unavailable',
            label: '⚪ Market unavailable',
          });
          continue;
        }

        const capperDecimal = americanToDecimal(bet.odds);
        const marketDecimal = americanToDecimal(marketOffer.price);
        const capperImplied = impliedProbability(bet.odds);
        const marketImplied = impliedProbability(marketOffer.price);

        // CLV = capper got better odds than current market
        // If capper's decimal odds > market decimal odds → positive CLV (they got a better price)
        const clvPct = ((capperDecimal - marketDecimal) / marketDecimal * 100).toFixed(1);
        const isPositive = capperDecimal > marketDecimal;

        const capperStr = bet.odds > 0 ? `+${bet.odds}` : `${bet.odds}`;
        const marketStr = marketOffer.price > 0 ? `+${marketOffer.price}` : `${marketOffer.price}`;

        if (isPositive) {
          results.push({
            bet,
            status: 'positive',
            label: `+EV | Capper: ${capperStr} → Market: ${marketStr} (${clvPct}%)`,
            book: marketOffer.book,
          });
        } else {
          results.push({
            bet,
            status: 'negative',
            label: `-EV | Capper: ${capperStr} → Market: ${marketStr} (${clvPct}%)`,
            book: marketOffer.book,
          });
        }
      }

      // Build the embed
      const positiveCount = results.filter(r => r.status === 'positive').length;
      const negativeCount = results.filter(r => r.status === 'negative').length;
      const color = positiveCount >= negativeCount ? COLORS.success : COLORS.danger;

      const lines = results.map(r => {
        const desc = (r.bet.description || 'Unknown').slice(0, 40);
        const capper = r.bet.capper_name || 'Unknown';
        const icon = r.status === 'positive' ? '📈' : r.status === 'negative' ? '📉' : '⚪';
        const bookTag = r.book ? ` @ ${r.book}` : '';
        return `${icon} **${desc}**\n└ ${capper} | ${r.label}${bookTag}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('CLV Audit — Pending Bets')
        .setColor(color)
        .setDescription(lines.join('\n\n') || 'No results.')
        .addFields(
          { name: 'Positive CLV', value: `${positiveCount}`, inline: true },
          { name: 'Negative CLV', value: `${negativeCount}`, inline: true },
          { name: 'Audited', value: `${results.length} / ${pending.length}`, inline: true },
        )
        .setFooter({ text: 'CLV = Closing Line Value. Positive means capper beat the market.' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
