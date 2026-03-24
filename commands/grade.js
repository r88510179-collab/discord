const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { runAutoGrade } = require('../services/grading');
const { getOrCreateCapper, getRecentBets, gradeBet, updateBankroll, getBankroll, saveDailySnapshot } = require('../services/database');
const { gradeBetAI } = require('../services/ai');
const { gradedEmbed, COLORS, fmtUnits } = require('../utils/embeds');
const { postBetGraded } = require('../services/dashboard');
const { calcProfit } = require('../services/grading');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('grade')
    .setDescription('Grade bets — auto or manual')
    .addSubcommand(sub =>
      sub.setName('auto')
        .setDescription('Run auto-grader on all pending bets'))
    .addSubcommand(sub =>
      sub.setName('manual')
        .setDescription('Manually grade your most recent pending bet')
        .addStringOption(opt =>
          opt.setName('result')
            .setDescription('Bet result')
            .setRequired(true)
            .addChoices(
              { name: '✅ Win', value: 'win' },
              { name: '❌ Loss', value: 'loss' },
              { name: '➖ Push', value: 'push' },
              { name: '🚫 Void', value: 'void' },
            ))),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'auto') {
      const results = await runAutoGrade(interaction.client);

      if (results.graded === 0) {
        return interaction.editReply('⏳ No bets could be auto-graded right now. Games may still be in progress.');
      }

      const embeds = [];
      const summaryEmbed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('⚡ Auto-Grade Complete')
        .setDescription(`Graded **${results.graded}** bet(s)`)
        .setTimestamp();
      embeds.push(summaryEmbed);

      for (const r of (results.bets || []).slice(0, 8)) {
        embeds.push(gradedEmbed(r.bet, r.result, r.profitUnits, r.grade));
      }

      return interaction.editReply({ embeds });
    }

    // Manual grading
    const result = interaction.options.getString('result');
    const capper = await getOrCreateCapper(
      interaction.user.id,
      interaction.user.displayName,
      interaction.user.displayAvatarURL(),
    );

    const recentBets = await getRecentBets(capper.id, 1);
    const pendingBet = recentBets.find(b => b.result === 'pending');

    if (!pendingBet) {
      return interaction.editReply('⏳ No pending bets to grade.');
    }

    const profitUnits = calcProfit(pendingBet.odds || -110, pendingBet.units || 1, result);
    const aiGrade = await gradeBetAI(pendingBet, result);

    await gradeBet(pendingBet.id, result, profitUnits, aiGrade.grade, aiGrade.reason);

    // Update bankroll
    const bankroll = await getBankroll(capper.id);
    if (bankroll) {
      const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
      await updateBankroll(capper.id, dollarAmount);
    }
    await saveDailySnapshot(capper.id);

    const embed = gradedEmbed(pendingBet, result, profitUnits, aiGrade);
    await postBetGraded(interaction.client, pendingBet, result, profitUnits, aiGrade);
    await interaction.editReply({ embeds: [embed] });
  },
};
