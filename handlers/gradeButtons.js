// handlers/gradeButtons.js — Interactive grading via Discord buttons
// Handles grade_win, grade_loss, grade_push, grade_void button clicks

const { EmbedBuilder } = require('discord.js');
const { gradeBet, getBankroll, updateBankroll, saveDailySnapshot } = require('../services/database');
const { calcProfit } = require('../services/grading');
const { postBetGraded } = require('../services/dashboard');
const { COLORS, fmtUnits } = require('../utils/embeds');

// Map result → display label + color
const RESULT_MAP = {
  win:  { label: 'WON',  emoji: '✅', color: COLORS.success },
  loss: { label: 'LOST', emoji: '❌', color: COLORS.danger },
  push: { label: 'PUSH', emoji: '➖', color: COLORS.pending },
  void: { label: 'VOID', emoji: '↩️', color: COLORS.pending },
};

async function handleGradeInteraction(interaction) {
  if (!interaction.isButton()) return;

  // Parse customId: grade_win:betId, grade_loss:betId, etc.
  const [prefix, betId] = interaction.customId.split(':');
  const result = prefix.replace('grade_', ''); // win, loss, push, void

  if (!RESULT_MAP[result] || !betId) {
    return interaction.reply({ content: 'Invalid grading action.', ephemeral: true });
  }

  // Extract bet info from the original embed
  const originalEmbed = interaction.message.embeds[0];
  if (!originalEmbed) {
    return interaction.reply({ content: 'Could not read bet embed.', ephemeral: true });
  }

  // Get odds and units from embed fields
  const oddsField = originalEmbed.fields?.find(f => f.name === 'Odds');
  const unitsField = originalEmbed.fields?.find(f => f.name === 'Units');
  const capperField = originalEmbed.fields?.find(f => f.name === 'Capper');
  const descField = originalEmbed.fields?.find(f => f.name === 'Description');
  const wagerField = originalEmbed.fields?.find(f => f.name === 'Financials');

  const odds = parseInt((oddsField?.value || '-110').replace('+', ''), 10) || -110;
  const units = parseFloat(unitsField?.value || '1') || 1;
  const capperName = capperField?.value || 'Unknown';

  // Calculate profit
  const profitUnits = calcProfit(odds, units, result);

  // Grade in database
  const display = RESULT_MAP[result];
  const gradeReason = `Manually graded by ${interaction.user.displayName} via button`;
  const graded = gradeBet(betId, result, profitUnits, display.label, gradeReason);

  if (!graded) {
    return interaction.reply({ content: `Could not grade bet \`${betId.slice(0, 8)}\`. It may already be graded.`, ephemeral: true });
  }

  // Update bankroll if capper has one
  if (graded.capper_id) {
    const bankroll = getBankroll(graded.capper_id);
    if (bankroll) {
      const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
      updateBankroll(graded.capper_id, dollarAmount);
    }
    saveDailySnapshot(graded.capper_id);
  }

  // Build graded embed (replace original)
  const gradedEmbed = new EmbedBuilder()
    .setTitle(`${display.emoji} Graded as ${display.label}`)
    .setColor(display.color)
    .addFields(
      { name: 'Capper', value: capperName, inline: true },
      { name: 'Sport', value: graded.sport || 'Unknown', inline: true },
      { name: 'Description', value: descField?.value || graded.description || 'N/A' },
      { name: 'Odds', value: `${odds > 0 ? '+' : ''}${odds}`, inline: true },
      { name: 'P/L', value: fmtUnits(profitUnits), inline: true },
      { name: 'Graded by', value: interaction.user.displayName, inline: true },
    )
    .setTimestamp();

  // Remove buttons + update embed
  await interaction.update({ embeds: [gradedEmbed], components: [] });

  // Post to dashboard
  try {
    await postBetGraded(interaction.client, graded, result, profitUnits, { grade: display.label, reason: gradeReason });
  } catch (err) {
    console.error('[GradeBtn] Dashboard post error:', err.message);
  }
}

module.exports = { handleGradeInteraction };
