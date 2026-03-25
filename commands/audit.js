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
      await interaction.deferReply({ ephemeral: true });

      const pending = getPendingBets().filter(b => b.review_status === 'confirmed');
      if (pending.length === 0) {
        return interaction.editReply({ content: 'No confirmed pending bets to audit.' });
      }

      const results = [];

      // Player prop / parlay keywords that indicate CLV is unsupported
      const PROP_KEYWORDS = /\b(pts|points|reb|rebounds|ast|assists|stl|steals|blk|blocks|yds|yards|tds|touchdowns|strikeouts|hits|runs|sacks|receptions)\b/i;

      for (const bet of pending.slice(0, 15)) {
        const betType = (bet.bet_type || 'straight').toLowerCase();
        const desc = bet.description || '';

        // Skip parlays — CLV requires individual team moneyline comparison
        if (betType === 'parlay' || betType === 'teaser' || betType === 'ladder') {
          results.push({
            bet,
            status: 'skip',
            label: '⚪ Parlay (CLV unsupported)',
          });
          continue;
        }

        // Skip player props — Odds API basic endpoint only has team-level markets
        if (betType === 'prop' || PROP_KEYWORDS.test(desc)) {
          results.push({
            bet,
            status: 'skip',
            label: '⚪ Player Prop (CLV unsupported)',
          });
          continue;
        }

        const teamSearch = extractTeamFromDescription(desc);
        if (!teamSearch || !bet.odds) {
          results.push({
            bet,
            status: 'skip',
            label: '⚪ No odds/team data',
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

        results.push({
          bet,
          status: isPositive ? 'positive' : 'negative',
          marketPrice: marketOffer.price,
          clvPct,
          book: marketOffer.book,
        });
      }

      // Build the embed
      const positiveCount = results.filter(r => r.status === 'positive').length;
      const negativeCount = results.filter(r => r.status === 'negative').length;
      const skippedCount = results.filter(r => r.status === 'skip').length;
      const color = positiveCount >= negativeCount ? COLORS.success : COLORS.danger;

      const lines = results.map(r => {
        const desc = (r.bet.description || 'Unknown').slice(0, 40);
        const capper = r.bet.capper_name || 'Unknown';

        if (r.status === 'positive' || r.status === 'negative') {
          const icon = r.status === 'positive' ? '📈' : '📉';
          const tag = r.status === 'positive' ? '+EV' : '-EV';
          const capperOdds = r.bet.odds != null ? (r.bet.odds > 0 ? `+${r.bet.odds}` : `${r.bet.odds}`) : '??';
          const marketOdds = r.marketPrice != null ? (r.marketPrice > 0 ? `+${r.marketPrice}` : `${r.marketPrice}`) : '??';
          const bookTag = r.book ? ` @ ${r.book}` : '';
          return `${icon} **${desc}**\n└ ${capper} | **${capperOdds}** -> **${marketOdds}** ${tag} (${r.clvPct}%)${bookTag}`;
        }

        return `⚪ **${desc}**\n└ ${capper} | ${r.label}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('CLV Audit — Pending Bets')
        .setColor(color)
        .setDescription(lines.join('\n\n') || 'No results.')
        .addFields(
          { name: 'Positive CLV', value: `${positiveCount}`, inline: true },
          { name: 'Negative CLV', value: `${negativeCount}`, inline: true },
          { name: 'Skipped', value: `${skippedCount} (props/parlays)`, inline: true },
        )
        .setFooter({ text: 'CLV = Closing Line Value. Positive means capper beat the market.' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
