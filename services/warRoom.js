// ═══════════════════════════════════════════════════════════
// War Room — Staging UI for audit mode
// Sends review embeds with Approve/Edit/Reject buttons to
// ADMIN_LOG_CHANNEL_ID. Handles button clicks and edit modals.
// ═══════════════════════════════════════════════════════════

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { approveBet, rejectBet, updateBetFields, getBetLegs } = require('./database');
const { postPickTracked } = require('./dashboard');
const { COLORS } = require('../utils/embeds');

/**
 * Send a staging embed with Approve/Edit/Reject buttons to the admin log channel.
 *
 * @param {import('discord.js').Client} client
 * @param {object} bet — saved bet row from DB
 * @param {string} capperName
 */
async function sendStagingEmbed(client, bet, capperName) {
  const channelId = process.env.WAR_ROOM_CHANNEL_ID || process.env.ADMIN_LOG_CHANNEL_ID;
  if (!channelId) {
    console.log('[WarRoom] WAR_ROOM_CHANNEL_ID not set — skipping staging embed.');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`[WarRoom] Could not fetch channel ${channelId}`);
    return;
  }

  // Fetch parlay legs from DB
  const legs = getBetLegs(bet.id);

  const embed = new EmbedBuilder()
    .setTitle('Bet Pending Review')
    .setColor(COLORS.warning)
    .addFields(
      { name: 'Capper', value: capperName || 'Unknown', inline: true },
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Type', value: (bet.bet_type || 'straight').toUpperCase(), inline: true },
      { name: 'Description', value: bet.description || 'N/A' },
      { name: 'Odds', value: String(bet.odds ?? 'N/A'), inline: true },
      { name: 'Units', value: String(bet.units ?? 1), inline: true },
    );

  // Display individual parlay legs
  if (legs && legs.length > 0) {
    const legLines = legs.map((leg, i) => {
      const odds = leg.odds ? ` (${leg.odds > 0 ? '+' : ''}${leg.odds})` : '';
      return `**Leg ${i + 1}:** ${leg.description}${odds}`;
    });
    embed.addFields({ name: `Legs (${legs.length})`, value: legLines.join('\n') });
  }

  // Display financials if available
  if (bet.wager || bet.payout) {
    const parts = [];
    if (bet.wager) parts.push(`**Wager:** $${Number(bet.wager).toFixed(2)}`);
    if (bet.payout) parts.push(`**To Pay:** $${Number(bet.payout).toFixed(2)}`);
    embed.addFields({ name: 'Financials', value: parts.join('  |  '), inline: false });
  }

  embed.addFields({ name: 'Bet ID', value: `\`${bet.id}\``, inline: false })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`war_approve:${bet.id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`war_edit:${bet.id}`)
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`war_reject:${bet.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Handle button interactions from staging embeds.
 * Call this from your interactionCreate event handler.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean} true if this interaction was handled
 */
async function handleWarRoomInteraction(interaction) {
  // Handle buttons
  if (interaction.isButton()) {
    const [action, betId] = interaction.customId.split(':');

    if (action === 'war_approve') {
      const bet = approveBet(betId);
      if (!bet) {
        return interaction.reply({ content: 'Bet not found or already confirmed.', ephemeral: true });
      }

      // Update the staging embed to show approved
      const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setTitle('✅ Bet Approved')
        .setColor(COLORS.success);
      await interaction.update({ embeds: [approvedEmbed], components: [] });

      // Forward to public dashboard
      await postPickTracked(
        interaction.client, bet, bet.capper_name || 'Unknown',
        'war-room', 'discord',
      );
      return true;
    }

    if (action === 'war_edit') {
      const modal = new ModalBuilder()
        .setCustomId(`war_modal:${betId}`)
        .setTitle('Edit Bet');

      const teamInput = new TextInputBuilder()
        .setCustomId('team_name')
        .setLabel('Team Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('e.g., Los Angeles Lakers');

      const lineInput = new TextInputBuilder()
        .setCustomId('betting_line')
        .setLabel('Betting Line')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('e.g., -3.5 or Over 220.5');

      const oddsInput = new TextInputBuilder()
        .setCustomId('odds')
        .setLabel('Odds')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('e.g., -110');

      modal.addComponents(
        new ActionRowBuilder().addComponents(teamInput),
        new ActionRowBuilder().addComponents(lineInput),
        new ActionRowBuilder().addComponents(oddsInput),
      );

      await interaction.showModal(modal);
      return true;
    }

    if (action === 'war_reject') {
      const deleted = rejectBet(betId);
      if (!deleted) {
        return interaction.reply({ content: 'Bet not found or already processed.', ephemeral: true });
      }

      const rejectedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setTitle('❌ Bet Rejected')
        .setColor(COLORS.danger);
      await interaction.update({ embeds: [rejectedEmbed], components: [] });
      return true;
    }
  }

  // Handle modal submissions
  if (interaction.isModalSubmit() && interaction.customId.startsWith('war_modal:')) {
    const betId = interaction.customId.split(':')[1];
    const teamName = interaction.fields.getTextInputValue('team_name').trim();
    const bettingLine = interaction.fields.getTextInputValue('betting_line').trim();
    const oddsStr = interaction.fields.getTextInputValue('odds').trim();

    // Build updated description from inputs
    const parts = [teamName, bettingLine].filter(Boolean);
    const newDesc = parts.length > 0 ? parts.join(' ') : null;
    const newOdds = oddsStr ? parseInt(oddsStr, 10) : null;

    if (newDesc || newOdds) {
      const current = updateBetFields(
        betId,
        newDesc || interaction.message?.embeds?.[0]?.fields?.find(f => f.name === 'Description')?.value || '',
        newOdds || null,
      );

      if (current) {
        // Refresh the staging embed with updated data
        const refreshedEmbed = new EmbedBuilder()
          .setTitle('🔒 Bet Pending Review (Edited)')
          .setColor(COLORS.info)
          .addFields(
            { name: 'Description', value: current.description || 'N/A' },
            { name: 'Odds', value: String(current.odds ?? 'N/A'), inline: true },
            { name: 'Units', value: String(current.units ?? 1), inline: true },
            { name: 'Bet ID', value: `\`${current.id}\``, inline: false },
          )
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`war_approve:${betId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`war_edit:${betId}`)
            .setLabel('Edit')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`war_reject:${betId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger),
        );

        await interaction.update({ embeds: [refreshedEmbed], components: [row] });
        return true;
      }
    }

    await interaction.reply({ content: 'No changes made.', ephemeral: true });
    return true;
  }

  return false;
}

module.exports = { sendStagingEmbed, handleWarRoomInteraction };
