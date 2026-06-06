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

// ─────────────────────────────────────────────────────────────
// Transport-agnostic Dismiss core (Phase 2b-1)
//
// dismissHold(ingestId, actor) is interaction-free — no Discord objects, no
// res / editReply / fields. Both the Discord button wrapper (handleDismiss)
// and the admin API route (routes/adminCommands.js) call it.
//
// Mutations (the live Discord dismiss advanced the stage; the CLI path
// scripts/review-holds.js also writes the durable decision row — this core
// does BOTH, inside ONE better-sqlite3 transaction, mirroring review-holds.js
// commitDecision where recordStage runs inside the txn):
//   1. pipeline_events stage advance → MANUAL_REVIEW_DISMISSED
//   2. hold_review_decisions row, human_decision='dismissed'
//
// Idempotency is enforced HERE, never in the UI. Current state = the most
// recent of the three terminal stages for this ingest_id:
//   already dismissed → safe no-op  { ok:true,  status:'already_dismissed' }
//   already released  → refuse      { ok:false, status:'already_released' }
//   no hold           → not found   { ok:false, status:'not_found' }
//   active hold       → dismiss once { ok:true, status:'dismissed' }
// Never creates or modifies a bet.
//
// actor is recorded in hold_review_decisions.reviewed_by (the existing
// "who decided" column — review-holds.js writes 'review-holds-script:<user>'
// there) and in the pipeline payload's dismissed_by (matching the live
// Discord mutation). No schema change was needed.
function dismissHold(ingestId, actor) {
  const id = String(ingestId == null ? '' : ingestId).trim();
  if (!id) return { ok: false, status: 'not_found', ingestId: id };

  const actorStr = (actor == null || String(actor).trim() === '') ? 'unknown' : String(actor);

  return db.transaction(() => {
    // Current state = the most recent of the three terminal stages. created_at
    // is epoch seconds and can tie, so the autoincrement id breaks ties.
    const latest = db.prepare(`
      SELECT stage FROM pipeline_events
      WHERE ingest_id = ?
        AND stage IN ('MANUAL_REVIEW_HOLD', 'MANUAL_REVIEW_RELEASED', 'MANUAL_REVIEW_DISMISSED')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(id);

    if (!latest) return { ok: false, status: 'not_found', ingestId: id };
    if (latest.stage === 'MANUAL_REVIEW_RELEASED') return { ok: false, status: 'already_released', ingestId: id };
    if (latest.stage === 'MANUAL_REVIEW_DISMISSED') return { ok: true, status: 'already_dismissed', ingestId: id };

    // active hold → dismiss once. hold_payload is an audit-redundant copy of
    // the hold's payload at hold time (pipeline_events purge on 90d; mig 025).
    const holdRow = db.prepare(`
      SELECT payload FROM pipeline_events
      WHERE ingest_id = ? AND stage = 'MANUAL_REVIEW_HOLD'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(id);

    // (1) stage advance — identical row shape to the live handleDismiss mutation.
    recordStage({
      ingestId: id,
      sourceType: 'discord',
      sourceRef: id.replace(/^disc_/, ''),
      stage: 'MANUAL_REVIEW_DISMISSED',
      eventType: 'STAGE_ENTER',
      payload: { dismissed_by: actorStr },
    });

    // (2) durable decision row — human_decision='dismissed' matches the only
    // live writer (scripts/review-holds.js); actor → reviewed_by.
    db.prepare(`
      INSERT INTO hold_review_decisions
        (ingest_id, hold_payload, reparse_attempted, reparse_input_source, reparse_input_text,
         reparse_output, reparse_confidence, human_decision, human_edits, source_label,
         bet_id, reviewed_by, created_at)
      VALUES
        (@ingest_id, @hold_payload, 0, NULL, NULL,
         NULL, NULL, 'dismissed', NULL, NULL,
         NULL, @reviewed_by, @created_at)
    `).run({
      ingest_id: id,
      hold_payload: holdRow ? holdRow.payload : null,
      reviewed_by: actorStr,
      created_at: Math.floor(Date.now() / 1000),
    });

    return { ok: true, status: 'dismissed', ingestId: id };
  })();
}

// Thin Discord wrapper — derives ingestId exactly as before (from the
// customId, upstream in handleHoldInteraction), delegates the mutation +
// idempotency to dismissHold, and preserves the existing reply/edit +
// button-stripping cleanup. Discord UX is unchanged.
async function handleDismiss(interaction, ingestId) {
  try {
    const result = dismissHold(ingestId, interaction.user.tag);

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x6c757d)
      .setTitle('🗑️ Slip Dismissed (Non-Bet)')
      .setFooter({ text: `Dismissed by ${interaction.user.tag}` });

    await interaction.update({
      embeds: [updatedEmbed],
      components: strippedComponentsKeepLinks(interaction.message),
    });
    console.log(`[HoldReview] Dismissed ${ingestId.slice(0, 16)} by ${interaction.user.tag} (status=${result.status})`);
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

module.exports = { handleHoldInteraction, dismissHold };
