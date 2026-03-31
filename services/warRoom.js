// ═══════════════════════════════════════════════════════════
// War Room — Staging UI for audit mode
// Sends review embeds with Approve/Edit/Reject buttons to
// ADMIN_LOG_CHANNEL_ID. Handles button clicks and edit modals.
// ═══════════════════════════════════════════════════════════

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { approveBet, rejectBet, updateBetFields, getBetLegs, getBetProps, getCapperStats, getBankroll, db, createBet, updateBankroll, upsertUserBet, getSentimentCounts } = require('./database');
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
      await interaction.deferReply({ ephemeral: true });

      try {
        const bet = approveBet(betId);
        if (!bet) {
          return interaction.editReply({ content: 'Bet not found or already confirmed.' });
        }

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
            // Build capper stats line
            let statsText = 'First graded bet!';
            try {
              const cs = getCapperStats(bet.capper_id);
              if (cs && ((cs.wins || 0) + (cs.losses || 0)) > 0) {
                const w = cs.wins || 0, l = cs.losses || 0, p = cs.pushes || 0;
                const pct = (w + l) > 0 ? Math.round((w / (w + l)) * 100) : 0;
                const prof = (cs.total_profit_units || 0).toFixed(2);
                const hot = pct >= 65 && prof > 0 && (w + l) >= 5;
                statsText = `${hot ? ' ' : ''}**Record:** ${w}-${l}-${p} (${pct}%) | **Profit:** ${prof > 0 ? '+' : ''}${prof}u`;
              }
            } catch (_) { /* silent */ }

            // Generate AI hype insight
            let aiTake = '';
            try {
              const { GoogleGenerativeAI } = require('@google/generative-ai');
              if (process.env.GEMINI_API_KEY) {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
                const prompt = `You are a sharp sports betting analyst. Write exactly ONE sentence (max 20 words) hyping up or analyzing this bet for a Discord community.\nCapper: ${bet.capper_name || 'Unknown'} (Win Rate: ${statsText})\nBet: ${bet.description} (${bet.sport})\nMake it punchy, sharp, and fun. No hashtags.`;
                const aiResult = await model.generateContent(prompt);
                aiTake = `**AI Take:** *"${aiResult.response.text().trim()}"*`;
              }
            } catch (_) {
              aiTake = `**AI Take:** *"Riding with ${bet.capper_name || 'Unknown'} on this one!"*`;
            }

            const pubEmbed = new EmbedBuilder()
              .setTitle(`New Play from ${bet.capper_name || 'Unknown'}`)
              .setColor(COLORS.success)
              .addFields(
                { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
                { name: 'Type', value: (bet.bet_type || 'straight').toUpperCase(), inline: true },
                { name: 'Odds', value: String(bet.odds ?? 'N/A'), inline: true },
                { name: 'Description', value: bet.description || 'N/A' },
                { name: 'Capper History', value: statsText, inline: false },
              );

            if (aiTake) {
              pubEmbed.addFields({ name: '\u200B', value: aiTake, inline: false });
            }
            pubEmbed.setTimestamp();

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

      // Delete the War Room staging embed and confirm
      await interaction.message.delete().catch(() => {});
      await interaction.editReply({ content: 'Bet approved and moved to the dashboard. War Room cleared!' });
      return true;

      } catch (error) {
        console.error('[Approve Error]', error.message);
        await interaction.editReply({ content: 'Something went wrong while approving the bet.' }).catch(() => {});
        return true;
      }
    }

    if (action === 'war_edit') {
      // Fetch current bet data to pre-fill the modal
      const currentBet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);

      const modal = new ModalBuilder()
        .setCustomId(`war_modal:${betId}`)
        .setTitle('Edit Bet Details');

      const sportInput = new TextInputBuilder()
        .setCustomId('sport')
        .setLabel('Sport')
        .setStyle(TextInputStyle.Short)
        .setValue(currentBet?.sport || '')
        .setRequired(true);

      const typeInput = new TextInputBuilder()
        .setCustomId('bet_type')
        .setLabel('Bet Type (straight, parlay, prop)')
        .setStyle(TextInputStyle.Short)
        .setValue(currentBet?.bet_type || 'straight')
        .setRequired(true);

      const descInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Pick / Description')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(currentBet?.description || '')
        .setRequired(true);

      const oddsInput = new TextInputBuilder()
        .setCustomId('odds')
        .setLabel('Odds (e.g., -110, +150)')
        .setStyle(TextInputStyle.Short)
        .setValue(currentBet?.odds != null ? String(currentBet.odds) : '')
        .setRequired(true);

      const unitsInput = new TextInputBuilder()
        .setCustomId('units')
        .setLabel('Units Risked (e.g., 1, 2.5)')
        .setStyle(TextInputStyle.Short)
        .setValue(currentBet?.units != null ? String(currentBet.units) : '1')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(sportInput),
        new ActionRowBuilder().addComponents(typeInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(oddsInput),
        new ActionRowBuilder().addComponents(unitsInput),
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

    // Tail / Fade — save vote, update embed with live sentiment counts
    if (action === 'war_tail' || action === 'war_fade') {
      const sentiment = action === 'war_tail' ? 'tail' : 'fade';
      try {
        upsertUserBet(interaction.user.id, betId, sentiment);
        const { tails, fades } = getSentimentCounts(betId);
        const sentimentString = `**${tails} Tailing** | **${fades} Fading**`;

        // Rebuild embed with updated sentiment field
        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fieldIndex = originalEmbed.data.fields?.findIndex(f => f.name === 'Community Sentiment');
        if (fieldIndex !== undefined && fieldIndex !== -1) {
          originalEmbed.data.fields[fieldIndex].value = sentimentString;
        } else {
          originalEmbed.addFields({ name: 'Community Sentiment', value: sentimentString, inline: false });
        }

        await interaction.update({ embeds: [originalEmbed] });
        await interaction.followUp({
          content: `${sentiment === 'tail' ? '🔥' : '🧊'} You chose to **${sentiment.toUpperCase()}** this bet!`,
          ephemeral: true,
        });
      } catch (error) {
        console.error('[Sentiment Error]', error.message);
        await interaction.reply({ content: 'Something went wrong saving your choice.', ephemeral: true }).catch(() => {});
      }
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
    const newSport = interaction.fields.getTextInputValue('sport').trim();
    const newType = interaction.fields.getTextInputValue('bet_type').trim();
    const newDesc = interaction.fields.getTextInputValue('description').trim();
    const oddsStr = interaction.fields.getTextInputValue('odds').trim();
    const unitsStr = interaction.fields.getTextInputValue('units').trim();
    const newOdds = oddsStr ? parseInt(oddsStr, 10) : null;
    const newUnits = unitsStr ? parseFloat(unitsStr) : null;

    // Update all editable fields
    if (newDesc || newOdds) {
      db.prepare('UPDATE bets SET sport = ?, bet_type = ?, description = ?, odds = COALESCE(?, odds), units = COALESCE(?, units) WHERE id = ?')
        .run(newSport || 'Unknown', newType || 'straight', newDesc, newOdds, newUnits, betId);

      const current = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);

      if (current) {
        const refreshedEmbed = new EmbedBuilder()
          .setTitle('Bet Pending Review (Edited)')
          .setColor(COLORS.info)
          .addFields(
            { name: 'Sport', value: current.sport || 'Unknown', inline: true },
            { name: 'Type', value: (current.bet_type || 'straight').toUpperCase(), inline: true },
            { name: 'Odds', value: String(current.odds ?? 'N/A'), inline: true },
            { name: 'Description', value: current.description || 'N/A' },
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
