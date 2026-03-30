// ═══════════════════════════════════════════════════════════
// War Room — Staging UI for audit mode
// Sends review embeds with Approve/Edit/Reject buttons to
// ADMIN_LOG_CHANNEL_ID. Handles button clicks and edit modals.
// ═══════════════════════════════════════════════════════════

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { approveBet, rejectBet, updateBetFields, getBetLegs, getBetProps, getCapperStats, getBankroll, db, createBet, updateBankroll, upsertUserBet } = require('./database');
const { postPickTracked } = require('./dashboard');
const { shopLine, formatLineShop, extractTeamFromDescription } = require('./odds');
const { calculateOptimalBet } = require('./bankroll');
const { COLORS } = require('../utils/embeds');

/**
 * Send a staging embed with Approve/Edit/Reject buttons to the admin log channel.
 *
 * @param {import('discord.js').Client} client
 * @param {object} bet — saved bet row from DB
 * @param {string} capperName
 * @param {string} [sourceUrl] — direct Discord message URL for source tracking
 */
async function sendStagingEmbed(client, bet, capperName, sourceUrl) {
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
  const betType = (bet.bet_type || 'straight').toUpperCase();
  const isParlay = betType === 'PARLAY' || betType === 'TEASER' || (legs && legs.length > 1);
  const title = isParlay ? `${legs?.length || '?'}-Leg ${betType} Pending Review` : 'Bet Pending Review';
  const fmtOdds = (o) => o == null ? 'N/A' : (o > 0 ? `+${o}` : `${o}`);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.warning)
    .addFields(
      { name: 'Capper', value: capperName || 'Unknown', inline: true },
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Type', value: betType, inline: true },
    );

  // Legs-first rendering: legend-style with bold selections for mobile readability
  if (legs && legs.length > 0) {
    const legLines = legs.map((leg, i) => {
      const odds = leg.odds != null ? `  ${fmtOdds(leg.odds)}` : '';
      // Bold the selection (description) and dim the odds
      return `\`${String(i + 1).padStart(2, ' ')}.\` **${leg.description}**${odds}`;
    });
    embed.addFields({ name: isParlay ? `Picks (${legs.length} Legs)` : 'Pick', value: legLines.join('\n') });
    // Show total parlay odds
    if (isParlay && bet.odds) {
      embed.addFields({ name: 'Total Odds', value: fmtOdds(bet.odds), inline: true });
    }
  } else {
    // Fallback: no legs in DB, show description
    embed.addFields({ name: 'Description', value: bet.description || 'N/A' });
    embed.addFields({ name: 'Odds', value: fmtOdds(bet.odds), inline: true });
  }

  embed.addFields({ name: 'Units', value: String(bet.units ?? 1), inline: true });

  // Capper Stats Injector
  if (bet.capper_id) {
    try {
      const stats = getCapperStats(bet.capper_id);
      if (stats && ((stats.wins || 0) + (stats.losses || 0)) > 0) {
        const wins = stats.wins || 0;
        const losses = stats.losses || 0;
        const pushes = stats.pushes || 0;
        const totalGames = wins + losses;
        const winPct = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;
        const profit = (stats.total_profit_units || 0).toFixed(2);
        const isHot = winPct >= 65 && profit > 0 && totalGames >= 5;
        const fire = isHot ? ' ' : '';
        embed.addFields({
          name: 'Capper Stats',
          value: `${fire}**Record:** ${wins}-${losses}-${pushes} (${winPct}%) | **Profit:** ${profit > 0 ? '+' : ''}${profit}u`,
          inline: false,
        });
      } else {
        embed.addFields({ name: 'Capper Stats', value: 'First graded bet!', inline: false });
      }
    } catch (e) {
      // Silent — don't break embed for stats failure
    }
  }

  // Display financials if available
  if (bet.wager || bet.payout) {
    const parts = [];
    if (bet.wager) parts.push(`**Wager:** $${Number(bet.wager).toFixed(2)}`);
    if (bet.payout) parts.push(`**To Pay:** $${Number(bet.payout).toFixed(2)}`);
    embed.addFields({ name: 'Financials', value: parts.join('  |  '), inline: false });
  }

  // Line Shop — compare capper's odds to live market
  try {
    const teamSearch = extractTeamFromDescription(bet.description);
    if (teamSearch) {
      const bestOffer = await shopLine(teamSearch, bet.sport);
      const formatted = formatLineShop(bestOffer);
      if (formatted) {
        embed.addFields({ name: 'Line Shop', value: formatted, inline: false });
      }
    }
  } catch (err) {
    console.log(`[WarRoom] Line shop error: ${err.message}`);
  }

  // Bankroll Guardian — Quarter Kelly recommendation
  try {
    if (bet.capper_id && bet.odds) {
      const stats = getCapperStats(bet.capper_id);
      const bankroll = getBankroll(bet.capper_id);
      const starting = bankroll?.starting || parseFloat(process.env.DEFAULT_BANKROLL || 1000);
      const current = bankroll?.current || starting;

      // Available cash = current bankroll - capital risked on pending bets
      const risked = db.prepare(
        "SELECT COALESCE(SUM(units), 0) AS total FROM bets WHERE capper_id = ? AND result = 'pending' AND review_status = 'confirmed'",
      ).get(bet.capper_id);
      const unitSize = bankroll?.unit_size || parseFloat(process.env.DEFAULT_UNIT_SIZE || 25);
      const riskedCash = (risked?.total || 0) * unitSize;
      const availableCash = Math.max(current - riskedCash, 0);

      const gradedBets = (stats?.wins || 0) + (stats?.losses || 0);
      const winRate = gradedBets > 0 ? (stats.wins / gradedBets) : null;

      const kelly = calculateOptimalBet(bet.odds, availableCash, winRate, gradedBets);

      if (kelly.isNegativeEV) {
        embed.addFields({ name: 'Guardian', value: '$0 (Negative EV / Fade)', inline: false });
      } else {
        embed.addFields({
          name: 'Guardian',
          value: `$${kelly.amount.toFixed(2)} (Quarter Kelly)`,
          inline: false,
        });
      }
    }
  } catch (err) {
    console.log(`[WarRoom] Guardian error: ${err.message}`);
  }

  embed.addFields({ name: 'Bet ID', value: `\`${bet.id}\``, inline: false })
    .setTimestamp();

  // Row 1: Admin actions
  const adminButtons = [
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
  ];

  // Construct source URL fallback from bet metadata if not provided
  const resolvedUrl = sourceUrl
    || (bet.source_channel_id && bet.source_message_id
      ? `https://discord.com/channels/${process.env.DISCORD_GUILD_ID || '_'}/${bet.source_channel_id}/${bet.source_message_id}`
      : null);

  if (resolvedUrl && resolvedUrl.startsWith('https://')) {
    adminButtons.push(
      new ButtonBuilder()
        .setLabel('View Original')
        .setStyle(ButtonStyle.Link)
        .setURL(resolvedUrl),
    );
  }

  const adminRow = new ActionRowBuilder().addComponents(adminButtons);

  // Row 2: Tail / Fade sentiment buttons
  const sentimentRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`war_tail:${bet.id}`)
      .setLabel('Tail')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`war_fade:${bet.id}`)
      .setLabel('Fade')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [adminRow, sentimentRow] });
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
        .setTitle('Bet Approved')
        .setColor(COLORS.success);
      await interaction.update({ embeds: [approvedEmbed], components: [] });

      // Forward to private dashboard
      await postPickTracked(
        interaction.client, bet, bet.capper_name || 'Unknown',
        'war-room', 'discord',
      );

      // Post to Public Community Feed with Tail/Fade buttons only
      const publicChannelId = process.env.PUBLIC_CHANNEL_ID || process.env.DASHBOARD_CHANNEL_ID;
      if (publicChannelId) {
        try {
          const pubChannel = await interaction.client.channels.fetch(publicChannelId).catch(() => null);
          if (pubChannel) {
            const pubEmbed = new EmbedBuilder()
              .setTitle('New Pick')
              .setColor(COLORS.primary)
              .addFields(
                { name: 'Capper', value: bet.capper_name || 'Unknown', inline: true },
                { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
                { name: 'Type', value: (bet.bet_type || 'straight').toUpperCase(), inline: true },
                { name: 'Description', value: bet.description || 'N/A' },
                { name: 'Odds', value: String(bet.odds ?? 'N/A'), inline: true },
              )
              .setTimestamp();

            const pubRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`war_tail:${bet.id}`)
                .setLabel('Tail')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`war_fade:${bet.id}`)
                .setLabel('Fade')
                .setStyle(ButtonStyle.Danger),
            );

            await pubChannel.send({ embeds: [pubEmbed], components: [pubRow] });
          }
        } catch (err) {
          console.log(`[WarRoom] Public feed error: ${err.message}`);
        }
      }

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
      // Force Cleanup — always clear the embed even if bet is already gone
      try {
        rejectBet(betId);
      } catch (e) {
        console.warn(`[WarRoom] Bet ${betId} not found in DB, but proceeding with cleanup.`);
      }

      await interaction.reply({ content: '❌ Slip rejected and cleared.', ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return true;
    }

    // Tail / Fade — save to user_bets table
    if (action === 'war_tail') {
      upsertUserBet(interaction.user.id, betId, 'tail');
      await interaction.reply({ content: `🔥 Tailing! Use \`/mybets\` to view your active slips.`, ephemeral: true });
      return true;
    }

    if (action === 'war_fade') {
      upsertUserBet(interaction.user.id, betId, 'fade');
      await interaction.reply({ content: `🧊 Fading! Use \`/mybets\` to view your active slips.`, ephemeral: true });
      return true;
    }

    // Untracked winner — Log as Win
    if (action === 'war_logwin') {
      try {
        // Extract capper ID and description from the embed (not the button customId)
        const embed = interaction.message.embeds[0];
        const footerText = embed?.footer?.text || '';
        const cidMatch = footerText.match(/^cid:(.+)$/);
        const capperId = cidMatch ? cidMatch[1] : null;
        const description = embed?.fields?.find(f => f.name === 'Description')?.value || 'Unknown bet';

        if (!capperId) {
          await interaction.reply({ content: 'Could not determine capper. Please grade manually.', ephemeral: true });
          return true;
        }

        const saved = createBet({
          capper_id: capperId,
          sport: 'Unknown', description,
          odds: -110, units: 1,
          source: 'untracked_win',
          review_status: 'confirmed',
        });
        if (saved && !saved._deduped) {
          const profitUnits = 0.91; // -110 odds → ~0.91u profit
          db.prepare("UPDATE bets SET result = 'win', profit_units = ? WHERE id = ?").run(profitUnits, saved.id);
          const bankroll = getBankroll(capperId);
          if (bankroll) {
            const unitSize = bankroll.unit_size || 25;
            updateBankroll(capperId, profitUnits * unitSize);
          }
        }
        const loggedEmbed = EmbedBuilder.from(embed)
          .setTitle('Logged as Win')
          .setColor(COLORS.success);
        await interaction.update({ embeds: [loggedEmbed], components: [] });
      } catch (err) {
        console.error('[WarRoom] Log win error:', err.message);
        await interaction.reply({ content: 'Failed to log win.', ephemeral: true });
      }
      return true;
    }

    // Untracked winner — Reject
    if (action === 'war_rejectwin') {
      await interaction.reply({ content: '❌ Untracked winner dismissed.', ephemeral: true });
      await interaction.message.delete().catch(() => {});
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

/**
 * Send a yellow "Untracked Winner" embed to the War Room.
 * Provides [Log as Win] and [Reject] buttons.
 */
async function sendUntrackedWinEmbed(client, data) {
  const channelId = process.env.WAR_ROOM_CHANNEL_ID || process.env.ADMIN_LOG_CHANNEL_ID;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle('Untracked Winner Detected')
    .setColor(COLORS.warning)
    .addFields(
      { name: 'Capper', value: data.capperName || 'Unknown', inline: true },
      { name: 'Outcome', value: (data.outcome || 'win').toUpperCase(), inline: true },
      { name: 'Description', value: data.description || 'Unknown bet' },
    )
    .setTimestamp();

  if (data.subject?.length > 0) {
    embed.addFields({ name: 'Subjects', value: data.subject.join(', '), inline: false });
  }

  // Store capper ID in footer for retrieval on button click (avoids customId length limit)
  embed.setFooter({ text: `cid:${data.capperId}` });

  // Use short unique suffix to avoid customId collisions
  const shortId = (data.capperId || '').slice(0, 16);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`war_logwin:${shortId}`)
      .setLabel('Log as Win')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`war_rejectwin:${shortId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

module.exports = { sendStagingEmbed, handleWarRoomInteraction, sendUntrackedWinEmbed };
