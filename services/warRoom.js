// War Room — Staging UI for audit mode
// Sends review embeds with Approve/Edit/Reject buttons to
// ADMIN_LOG_CHANNEL_ID. Handles button clicks and edit modals.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { approveBet, rejectBet, updateBetFields, getBetProps } = require('./database');
const { postPickTracked } = require('./dashboard');
const { COLORS } = require('../utils/embeds');

// Format structured props for embed display
function formatPropsForEmbed(props) {
  if (!props || props.length === 0) return null;
  return props.map(p => {
    const dir = p.direction === 'over' ? 'O' : 'U';
    const odds = p.odds ? ` (${p.odds > 0 ? '+' : ''}${p.odds})` : '';
    const cat = p.stat_category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `\u{1F464} ${p.player_name} | \u{1F4CA} ${cat} | ${dir === 'O' ? '\u{1F4C8}' : '\u{1F4C9}'} ${dir} ${p.line}${odds}`;
  }).join('\n');
}

async function sendStagingEmbed(client, bet, capperName) {
  const channelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!channelId) {
    console.log('[WarRoom] ADMIN_LOG_CHANNEL_ID not set — skipping staging embed.');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`[WarRoom] Could not fetch channel ${channelId}`);
    return;
  }

  // Fetch structured props for this bet
  const props = getBetProps(bet.id);
  const propsDisplay = formatPropsForEmbed(props);

  const embed = new EmbedBuilder()
    .setTitle('Bet Pending Review')
    .setColor(COLORS.warning)
    .addFields(
      { name: 'Capper', value: capperName || 'Unknown', inline: true },
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Type', value: bet.bet_type || 'straight', inline: true },
      { name: 'Description', value: bet.description || 'N/A' },
      { name: 'Odds', value: String(bet.odds ?? 'N/A'), inline: true },
      { name: 'Units', value: String(bet.units ?? 1), inline: true },
    );

  if (propsDisplay) {
    embed.addFields({ name: 'Props', value: propsDisplay });
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

async function handleWarRoomInteraction(interaction) {
  if (interaction.isButton()) {
    const [action, betId] = interaction.customId.split(':');

    if (action === 'war_approve') {
      const bet = approveBet(betId);
      if (!bet) {
        return interaction.reply({ content: 'Bet not found or already confirmed.', ephemeral: true });
      }

      const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setTitle('Bet Approved')
        .setColor(COLORS.success);
      await interaction.update({ embeds: [approvedEmbed], components: [] });

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
        .setTitle('Bet Rejected')
        .setColor(COLORS.danger);
      await interaction.update({ embeds: [rejectedEmbed], components: [] });
      return true;
    }
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('war_modal:')) {
    const betId = interaction.customId.split(':')[1];
    const teamName = interaction.fields.getTextInputValue('team_name').trim();
    const bettingLine = interaction.fields.getTextInputValue('betting_line').trim();
    const oddsStr = interaction.fields.getTextInputValue('odds').trim();

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
        const refreshedEmbed = new EmbedBuilder()
          .setTitle('Bet Pending Review (Edited)')
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
