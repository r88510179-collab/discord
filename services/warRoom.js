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
const { postNewPick } = require('./dashboard');
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

  // Add "Split to Singles" button for parlays
  if (bet.bet_type === 'parlay') {
    adminButtons.push(
      new ButtonBuilder()
        .setCustomId(`war_split:${bet.id}`)
        .setLabel('Split to Singles')
        .setStyle(ButtonStyle.Secondary),
    );
  }

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
    const [action, ...rest] = interaction.customId.split(':');
    const betId = rest.join(':'); // handles comma-separated IDs for ladders

    // ── Ladder batch approve ──
    if (action === 'war_ladder_approve') {
      await interaction.deferReply({ ephemeral: true });
      const betIds = betId.split(',').filter(Boolean);
      let approved = 0;
      for (const id of betIds) {
        const result = approveBet(id);
        if (result) approved++;
      }
      await interaction.message.delete().catch(() => {});
      await interaction.editReply({ content: `✅ Approved **${approved}/${betIds.length}** ladder steps.` });
      // Post each to #slip-feed
      for (const id of betIds) {
        const bet = db.prepare('SELECT b.*, c.display_name AS capper_name FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id WHERE b.id = ?').get(id);
        if (bet) await postNewPick(interaction.client, bet, bet.capper_name);
      }
      return true;
    }

    // ── Ladder batch reject ──
    if (action === 'war_ladder_reject') {
      const betIds = betId.split(',').filter(Boolean);
      for (const id of betIds) {
        try { rejectBet(id); } catch (_) {}
      }
      await interaction.reply({ content: `❌ Rejected ${betIds.length} ladder steps.`, ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return true;
    }

    if (action === 'war_approve') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const bet = approveBet(betId);
        if (!bet) {
          return interaction.editReply({ content: 'Bet not found or already confirmed.' });
        }

        // Forward to #slip-feed
        await postNewPick(interaction.client, bet, bet.capper_name || 'Unknown');

      // Bet routing: postNewPick already sends to #slip-feed with buttons.
      // No second post needed — dashboard is scoreboard-only.

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

      // Fetch capper name for pre-fill
      const capperRow = currentBet?.capper_id
        ? db.prepare('SELECT display_name FROM cappers WHERE id = ?').get(currentBet.capper_id)
        : null;

      const capperInput = new TextInputBuilder()
        .setCustomId('capper_name')
        .setLabel('Capper Name')
        .setStyle(TextInputStyle.Short)
        .setValue(capperRow?.display_name || '')
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
        new ActionRowBuilder().addComponents(capperInput),
        new ActionRowBuilder().addComponents(sportInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(oddsInput),
        new ActionRowBuilder().addComponents(unitsInput),
      );

      await interaction.showModal(modal);
      return true;
    }

    // ── Split parlay into individual single bets ──
    if (action === 'war_split') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const originalBet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
        if (!originalBet) {
          return interaction.editReply({ content: 'Bet not found.' });
        }

        const legs = getBetLegs(betId);
        if (!legs || legs.length === 0) {
          // No legs table entries — try splitting description by newlines/bullets
          const descLegs = (originalBet.description || '')
            .split(/[\n•]+/)
            .map(l => l.trim())
            .filter(l => l.length > 2);

          if (descLegs.length <= 1) {
            return interaction.editReply({ content: 'This bet has no legs to split.' });
          }

          // Create individual bets from description lines
          const newBets = [];
          for (const legDesc of descLegs) {
            const saved = createBet({
              capper_id: originalBet.capper_id,
              sport: originalBet.sport,
              league: originalBet.league,
              bet_type: 'straight',
              description: legDesc,
              odds: originalBet.odds || null,
              units: originalBet.units || 1,
              source: originalBet.source,
              source_url: originalBet.source_url,
              source_channel_id: originalBet.source_channel_id,
              source_message_id: originalBet.source_message_id,
              raw_text: legDesc,
              review_status: 'needs_review',
              season: originalBet.season,
              is_ladder: originalBet.is_ladder,
              ladder_step: originalBet.ladder_step,
            });
            if (saved && !saved._deduped) newBets.push(saved);
          }

          // Delete the original parlay
          db.prepare('DELETE FROM parlay_legs WHERE bet_id = ?').run(betId);
          db.prepare('DELETE FROM bets WHERE id = ?').run(betId);

          // Send each new single bet to War Room
          const capperName = db.prepare('SELECT display_name FROM cappers WHERE id = ?').get(originalBet.capper_id)?.display_name || 'Unknown';
          for (const bet of newBets) {
            await sendStagingEmbed(interaction.client, bet, capperName, originalBet.source_url);
          }

          await interaction.message.delete().catch(() => {});
          await interaction.editReply({ content: `✅ Split into **${newBets.length}** individual bet(s). Each sent to War Room.` });
          return true;
        }

        // Has structured legs — use those
        const newBets = [];
        for (const leg of legs) {
          const saved = createBet({
            capper_id: originalBet.capper_id,
            sport: originalBet.sport,
            league: originalBet.league,
            bet_type: 'straight',
            description: leg.description,
            odds: leg.odds || originalBet.odds || null,
            units: originalBet.units || 1,
            source: originalBet.source,
            source_url: originalBet.source_url,
            source_channel_id: originalBet.source_channel_id,
            source_message_id: originalBet.source_message_id,
            raw_text: leg.description,
            review_status: 'needs_review',
            season: originalBet.season,
            is_ladder: originalBet.is_ladder,
            ladder_step: originalBet.ladder_step,
          });
          if (saved && !saved._deduped) newBets.push(saved);
        }

        // Delete the original parlay + its legs
        db.prepare('DELETE FROM parlay_legs WHERE bet_id = ?').run(betId);
        db.prepare('DELETE FROM bets WHERE id = ?').run(betId);

        // Send each new single bet to War Room
        const capperName = db.prepare('SELECT display_name FROM cappers WHERE id = ?').get(originalBet.capper_id)?.display_name || 'Unknown';
        for (const bet of newBets) {
          await sendStagingEmbed(interaction.client, bet, capperName, originalBet.source_url);
        }

        await interaction.message.delete().catch(() => {});
        await interaction.editReply({ content: `✅ Split **${legs.length}-leg parlay** into **${newBets.length}** individual bet(s). Each sent to War Room.` });
        console.log(`[WarRoom] Split parlay ${betId.slice(0, 8)} into ${newBets.length} singles`);
      } catch (err) {
        console.error('[WarRoom] Split error:', err.message);
        await interaction.editReply({ content: `❌ Split failed: ${err.message}` }).catch(() => {});
      }
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

    // Tail — show modal for custom risk amount
    if (action === 'war_tail') {
      const tailModal = new ModalBuilder()
        .setCustomId(`war_tailmodal:${betId}`)
        .setTitle('Tail this Bet');

      const riskInput = new TextInputBuilder()
        .setCustomId('risk_units')
        .setLabel('How many units to risk? (e.g. 1, 2.5)')
        .setStyle(TextInputStyle.Short)
        .setValue('1')
        .setRequired(true);

      tailModal.addComponents(new ActionRowBuilder().addComponents(riskInput));
      await interaction.showModal(tailModal);
      return true;
    }

    // Fade — instant 1u fade
    if (action === 'war_fade') {
      try {
        upsertUserBet(interaction.user.id, betId, 'fade', 1.0);
        const { tails, fades } = getSentimentCounts(betId);
        const sentimentString = `**${tails} Tailing** | **${fades} Fading**`;

        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fieldIndex = originalEmbed.data.fields?.findIndex(f => f.name === 'Community Sentiment');
        if (fieldIndex !== undefined && fieldIndex !== -1) {
          originalEmbed.data.fields[fieldIndex].value = sentimentString;
        } else {
          originalEmbed.addFields({ name: 'Community Sentiment', value: sentimentString, inline: false });
        }
        await interaction.update({ embeds: [originalEmbed] });
        await interaction.followUp({ content: `🧊 You chose to **FADE** this bet!`, ephemeral: true });
      } catch (error) {
        console.error('[Sentiment Error]', error.message);
        await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
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
  // Handle tail modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('war_tailmodal:')) {
    const betId = interaction.customId.split(':')[1];
    const rawUnits = interaction.fields.getTextInputValue('risk_units');
    const riskUnits = Math.round(parseFloat(rawUnits) * 100) / 100;

    if (!Number.isFinite(riskUnits) || riskUnits < 0.1 || riskUnits > 50) {
      return interaction.reply({ content: 'Invalid unit amount. Please enter a number between 0.1 and 50.', ephemeral: true });
    }

    try {
      upsertUserBet(interaction.user.id, betId, 'tail', riskUnits);
      const { tails, fades } = getSentimentCounts(betId);
      const sentimentString = `**${tails} Tailing** | **${fades} Fading**`;

      // Update the embed on the original message
      const originalMsg = interaction.message;
      if (originalMsg) {
        const originalEmbed = EmbedBuilder.from(originalMsg.embeds[0]);
        const fieldIndex = originalEmbed.data.fields?.findIndex(f => f.name === 'Community Sentiment');
        if (fieldIndex !== undefined && fieldIndex !== -1) {
          originalEmbed.data.fields[fieldIndex].value = sentimentString;
        } else {
          originalEmbed.addFields({ name: 'Community Sentiment', value: sentimentString, inline: false });
        }
        await originalMsg.edit({ embeds: [originalEmbed] }).catch(() => {});
      }

      await interaction.reply({ content: `🔥 You are tailing this bet for **${riskUnits}u**!`, ephemeral: true });
    } catch (error) {
      console.error('[Tail Modal Error]', error.message);
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
    return true;
  }

  // Handle edit modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('war_modal:')) {
    const betId = interaction.customId.split(':')[1];
    const newCapper = interaction.fields.getTextInputValue('capper_name').trim();
    const newSport = interaction.fields.getTextInputValue('sport').trim();
    const newDesc = interaction.fields.getTextInputValue('description').trim();
    const oddsStr = interaction.fields.getTextInputValue('odds').trim();
    const unitsStr = interaction.fields.getTextInputValue('units').trim();
    const newOdds = oddsStr ? parseInt(oddsStr, 10) : null;
    const newUnits = unitsStr ? parseFloat(unitsStr) : null;

    // Update all editable fields
    if (newDesc || newOdds) {
      db.prepare('UPDATE bets SET sport = ?, description = ?, odds = COALESCE(?, odds), units = COALESCE(?, units) WHERE id = ?')
        .run(newSport || 'Unknown', newDesc, newOdds, newUnits, betId);

      // Update capper display name if changed
      if (newCapper) {
        const bet = db.prepare('SELECT capper_id FROM bets WHERE id = ?').get(betId);
        if (bet?.capper_id) {
          db.prepare('UPDATE cappers SET display_name = ? WHERE id = ?').run(newCapper, bet.capper_id);
        }
      }

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

/**
 * Send a grouped ladder embed to War Room.
 * Shows all steps in one embed with a single "Approve All" button.
 */
async function sendLadderEmbed(client, ladderBets, capperName, sourceUrl, sport) {
  const channelId = process.env.WAR_ROOM_CHANNEL_ID || process.env.ADMIN_LOG_CHANNEL_ID;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const fmtOdds = (o) => o == null ? 'N/A' : (o > 0 ? `+${o}` : `${o}`);
  const totalUnits = ladderBets.reduce((sum, b) => sum + (b.units || 1), 0);

  const stepLines = ladderBets.map((bet, i) => {
    const step = bet.ladder_step || (i + 1);
    return `\`Step ${step}\` **${bet.description}** ${fmtOdds(bet.odds)} — ${bet.units || 1}u`;
  });

  const betIds = ladderBets.map(b => b.id);

  const embed = new EmbedBuilder()
    .setTitle(`🪜 Ladder Challenge (${ladderBets.length} Steps)`)
    .setColor(0xFFA500)
    .addFields(
      { name: 'Capper', value: capperName || 'Unknown', inline: true },
      { name: 'Sport', value: sport || 'Unknown', inline: true },
      { name: 'Total Risk', value: `${totalUnits.toFixed(1)}u across ${ladderBets.length} steps`, inline: true },
      { name: 'Steps', value: stepLines.join('\n') || 'No steps' },
    )
    .setFooter({ text: `Bet IDs: ${betIds.map(id => id.slice(0, 6)).join(', ')}` })
    .setTimestamp();

  if (sourceUrl) embed.setURL(sourceUrl);

  // Encode all bet IDs as comma-separated in the button custom ID
  const idsPayload = betIds.join(',');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`war_ladder_approve:${idsPayload}`)
      .setLabel(`Approve All ${ladderBets.length} Steps`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`war_ladder_reject:${idsPayload}`)
      .setLabel('Reject All')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
  console.log(`[WarRoom] Ladder embed sent: ${ladderBets.length} steps from ${capperName}`);
}

module.exports = { sendStagingEmbed, handleWarRoomInteraction, sendUntrackedWinEmbed, sendLadderEmbed };
