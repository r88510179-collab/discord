// services/holdReview.js
// Handles Release / Dismiss buttons on MANUAL_REVIEW_HOLD admin notifications,
// plus the Release-as-Bet modal submission. Posted from handlers/messageHandler.js
// when a human-channel slip is held because AI returned is_bet=false or indeterminate.
//
// Flow per prompts/hold-release-as-bet.md (Option α — manual bet creation, NOT AI re-run).

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db, createBetWithLegs } = require('./database');
const { postNewPick } = require('./dashboard');
const { recordStage } = require('./pipeline-events');

// customId formats
//   hold:release:<ingestId>      → button, opens modal
//   hold:dismiss:<ingestId>      → button, marks dismissed
//   hold:releasemodal:<ingestId> → modal submission, creates bet

async function handleHoldInteraction(interaction) {
  if (!interaction.customId?.startsWith('hold:')) return;

  // Owner-only — Release writes to the bets table, Dismiss writes an audit row.
  if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
    return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
  }

  const parts = interaction.customId.split(':');
  const action = parts[1];
  const ingestId = parts.slice(2).join(':');

  if (interaction.isButton()) {
    if (action === 'dismiss') return handleDismiss(interaction, ingestId);
    if (action === 'release') return handleReleaseButton(interaction, ingestId);
  }
  if (interaction.isModalSubmit() && action === 'releasemodal') {
    return handleReleaseModal(interaction, ingestId);
  }
}

function loadHoldEvent(ingestId) {
  const event = db.prepare(`
    SELECT payload FROM pipeline_events
    WHERE ingest_id = ? AND stage = 'MANUAL_REVIEW_HOLD'
    ORDER BY created_at DESC LIMIT 1
  `).get(ingestId);
  if (!event) return null;
  try { return JSON.parse(event.payload); } catch (_) { return null; }
}

function strippedComponentsKeepLinks(message) {
  const keptButtons = message.components?.[0]?.components?.filter(c => c.style === 5) || [];
  if (keptButtons.length === 0) return [];
  return [{ type: 1, components: keptButtons.map(b => b.toJSON ? b.toJSON() : b) }];
}

async function handleDismiss(interaction, ingestId) {
  try {
    recordStage({
      ingestId,
      sourceType: 'discord',
      sourceRef: ingestId.replace(/^disc_/, ''),
      stage: 'MANUAL_REVIEW_DISMISSED',
      eventType: 'STAGE_ENTER',
      payload: { dismissed_by: interaction.user.tag },
    });

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x6c757d)
      .setTitle('🗑️ Slip Dismissed (Non-Bet)')
      .setFooter({ text: `Dismissed by ${interaction.user.tag}` });

    await interaction.update({
      embeds: [updatedEmbed],
      components: strippedComponentsKeepLinks(interaction.message),
    });
    console.log(`[HoldReview] Dismissed ${ingestId.slice(0, 16)} by ${interaction.user.tag}`);
  } catch (err) {
    console.error('[HoldReview] Dismiss error:', err.message);
    try { await interaction.reply({ content: `Dismiss failed: ${err.message}`, ephemeral: true }); } catch (_) {}
  }
}

async function handleReleaseButton(interaction, ingestId) {
  try {
    const payload = loadHoldEvent(ingestId);
    if (!payload) {
      return interaction.reply({
        content: `❌ Hold record not found for ingest_id \`${ingestId.slice(0, 16)}\`.`,
        ephemeral: true,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`hold:releasemodal:${ingestId}`)
      .setTitle('Release as Bet');

    const capperInput = new TextInputBuilder()
      .setCustomId('capper_name').setLabel('Capper (must match an existing capper)')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setValue((payload.capper || '').slice(0, 100));

    const sportInput = new TextInputBuilder()
      .setCustomId('sport').setLabel('Sport (NBA, NFL, MLB, NHL, ...)')
      .setStyle(TextInputStyle.Short).setRequired(true);

    const descInput = new TextInputBuilder()
      .setCustomId('description').setLabel('Description')
      .setStyle(TextInputStyle.Paragraph).setRequired(true)
      .setValue((payload.sample || '').slice(0, 1000));

    const oddsInput = new TextInputBuilder()
      .setCustomId('odds').setLabel('Odds')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder('-110, +150');

    const unitsInput = new TextInputBuilder()
      .setCustomId('units').setLabel('Units')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setValue('1');

    modal.addComponents(
      new ActionRowBuilder().addComponents(capperInput),
      new ActionRowBuilder().addComponents(sportInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(oddsInput),
      new ActionRowBuilder().addComponents(unitsInput),
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error('[HoldReview] Release-button error:', err.message);
    try { await interaction.reply({ content: `❌ Could not open release form: ${err.message}`, ephemeral: true }); } catch (_) {}
  }
}

async function handleReleaseModal(interaction, ingestId) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const capperName = interaction.fields.getTextInputValue('capper_name').trim();
    const sport = interaction.fields.getTextInputValue('sport').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const oddsStr = interaction.fields.getTextInputValue('odds').trim();
    const unitsStr = interaction.fields.getTextInputValue('units').trim();

    const odds = parseInt(oddsStr, 10);
    if (!Number.isFinite(odds)) {
      return interaction.editReply({ content: `❌ Invalid odds: \`${oddsStr}\`. Expected integer like -110 or +150.` });
    }

    const units = parseFloat(unitsStr);
    if (!Number.isFinite(units) || units < 0.1 || units > 100) {
      return interaction.editReply({ content: `❌ Invalid units: \`${unitsStr}\`. Expected number between 0.1 and 100.` });
    }

    // Strict capper lookup — no auto-create, no rename (anti-pattern per spec).
    const capper = db.prepare(
      'SELECT id, display_name FROM cappers WHERE LOWER(display_name) = LOWER(?) LIMIT 1'
    ).get(capperName);
    if (!capper) {
      const allCappers = db.prepare('SELECT display_name FROM cappers ORDER BY display_name')
        .all().map(c => c.display_name).join(', ');
      return interaction.editReply({
        content: `❌ No capper named **"${capperName}"** exists.\n\nValid cappers: ${allCappers}`,
      });
    }

    const payload = loadHoldEvent(ingestId);
    if (!payload) {
      return interaction.editReply({ content: `❌ Hold record not found for ingest_id \`${ingestId.slice(0, 16)}\`.` });
    }
    const messageUrl = payload.messageUrl;
    if (!messageUrl) {
      return interaction.editReply({ content: '❌ Hold record has no messageUrl — cannot link bet to source.' });
    }

    const urlMatch = messageUrl.match(/channels\/\d+\/(\d+)\/(\d+)/);
    if (!urlMatch) {
      return interaction.editReply({ content: `❌ Could not parse message URL: ${messageUrl}` });
    }
    const [, channelId, messageId] = urlMatch;

    const savedBet = createBetWithLegs({
      capper_id: capper.id,
      sport,
      league: null,
      bet_type: 'straight',
      description,
      odds,
      units,
      event_date: null,
      source: 'manual_hold_release',
      source_url: messageUrl,
      source_channel_id: channelId,
      source_message_id: messageId,
      raw_text: payload.sample || null,
      review_status: 'confirmed',
      wager: null,
      payout: null,
      is_ladder: false,
      ladder_step: 0,
    }, []);

    if (savedBet?._deduped) {
      return interaction.editReply({
        content: `⚠️ Bet already exists (fingerprint match): \`${savedBet.id?.slice(0, 8)}\`. No duplicate created.`,
      });
    }

    // postNewPick failures are non-fatal — DB row is the source of truth.
    try { await postNewPick(interaction.client, savedBet, capper.display_name, messageUrl); }
    catch (postErr) { console.error('[HoldReview] postNewPick failed:', postErr.message); }

    recordStage({
      ingestId,
      betId: savedBet.id,
      sourceType: 'discord',
      sourceRef: ingestId.replace(/^disc_/, ''),
      stage: 'MANUAL_REVIEW_RELEASED',
      eventType: 'STAGE_ENTER',
      payload: {
        released_by: interaction.user.tag,
        bet_id: savedBet.id,
        capper: capper.display_name,
        sport,
        odds,
        units,
        message_url: messageUrl,
      },
    });

    try {
      const original = interaction.message;
      if (original) {
        const updatedEmbed = EmbedBuilder.from(original.embeds[0])
          .setColor(0x2ecc71)
          .setTitle('✅ Slip Released as Bet')
          .addFields({
            name: 'Bet',
            value: `\`${savedBet.id?.slice(0, 8)}\` • ${capper.display_name} • ${sport} • ${odds > 0 ? `+${odds}` : odds} • ${units}u`,
          })
          .setFooter({ text: `Released by ${interaction.user.tag}` });
        await original.edit({
          embeds: [updatedEmbed],
          components: strippedComponentsKeepLinks(original),
        }).catch(() => {});
      }
    } catch (editErr) {
      console.error('[HoldReview] Embed update failed:', editErr.message);
    }

    await interaction.editReply({
      content: `✅ Bet created: \`${savedBet.id?.slice(0, 8)}\` (${capper.display_name} • ${sport} • ${odds > 0 ? `+${odds}` : odds} • ${units}u). Posted to #slip-feed.`,
    });
    console.log(`[HoldReview] Released ${ingestId.slice(0, 16)} → bet ${savedBet.id?.slice(0, 8)} by ${interaction.user.tag}`);
  } catch (err) {
    console.error('[HoldReview] Release-modal error:', err.message, err.stack);
    try { await interaction.editReply({ content: `❌ Release failed: ${err.message}` }); } catch (_) {}
  }
}

module.exports = { handleHoldInteraction };
