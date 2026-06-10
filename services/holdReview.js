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
const { db, createBetWithLegs, getOrCreateCapper } = require('./database');
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

// ─────────────────────────────────────────────────────────────
// Transport-agnostic On-demand Unfurl Recovery core (Phase 2b-2)
//
// recoverHold(ingestId, actor) re-fetches a held Discord message and runs the
// EXISTING vision_slip extraction+create path on it. Built for the
// grade-before-unfurl race: HRB share-link slips held as `ai_is_bet_false`
// were graded text-only BEFORE Discord unfurled the slip image. The held
// message has long since unfurled, so a re-fetch now carries the slip image,
// and the same vision path that handles won-race unfurls extracts it.
//
// It REUSES, never reimplements:
//   • handlers/messageHandler.processSlipImage — the won-race vision_slip unit
//     (OCR → vision → validateParsedBet anti-hallucination guard →
//     createBetWithLegs(source:'vision_slip', review_status:'needs_review') →
//     war-room staging embed). No raw SQL bet creation; the creation-time
//     is_bet logic and the MANUAL_REVIEW_HOLD gates (v335 landmine) are NOT
//     touched — this path has no is_bet gate.
//   • resolveCapper + getOrCreateCapper — identical capper attribution to the
//     won-race flow (handlers/messageHandler.js processAggregatedMessage).
//   • the MANUAL_REVIEW_RELEASED stage advance + a hold_review_decisions row —
//     the same terminal the Release-modal uses, so the dismiss idempotency
//     core already treats a recovered hold as resolved.
//
// Idempotency lives HERE, keyed on bets.source_message_id (createBetWithLegs's
// fingerprint also keys on it — a second, lower guard), so re-running creates
// at most one bet:
//   no hold for ingest_id                 → { ok:false, status:'not_found' }
//   same ingest already being recovered   → { ok:false, status:'in_flight' }    (creates nothing)
//   a bet already exists for this message → { ok:true,  status:'already_recovered', betId }
//   hold already released / dismissed     → { ok:false, status:'already_resolved' }
//   message unreachable / no client       → { ok:false, status:'message_unreachable' }
//   fetched but not unfurled yet (0 imgs) → { ok:false, status:'no_image_yet' }   (creates nothing)
//   vision returned no bet                → { ok:false, status:'no_bet_found' }    (leaves the hold)
//   bet created                           → { ok:true,  status:'recovered', betId }
//
// The bet-exists check runs BEFORE the terminal-stage check so a re-run after a
// successful recover reports `already_recovered` (not `already_resolved`). If a
// bet exists but the hold is somehow still open (a prior run created the bet
// then crashed before advancing the stage), the hold is self-healed to
// RELEASED. A deliberate Dismiss is respected (never self-healed).
//
// Discord fetch + vision extraction are injectable via `deps` for tests (the
// repo has no Discord/vision harness); production passes nothing and the
// defaults lazy-require messageHandler, which is already cached in the running
// bot — so this module never eagerly pulls in the heavy handler graph.

// Default Discord fetch: global._discordClient → channels.fetch → messages.fetch
// (mirrors routes/admin.js:196 + routes/api.js:54).
async function _defaultFetchMessage(client, channelId, messageId) {
  if (!client || !channelId || !messageId) return null;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') return null;
  return channel.messages.fetch(messageId);
}

// Phase 2b-2 (fetch-retry): the recover fetch is the only network hop in this
// path. A SINGLE transient channels.fetch / messages.fetch miss — a null result
// OR a thrown error — would otherwise bail the whole recovery with
// `message_unreachable`, which in a multi-hold drain silently drops slips that a
// retry a moment later would have recovered. So retry the fetch a few times with
// a short backoff before giving up. The backoff sits BETWEEN attempts, so
// FETCH_RETRY_BACKOFF_MS has one fewer entry than FETCH_MAX_ATTEMPTS (the last
// attempt is not followed by a wait). This wraps ONLY the fetch — the no-client
// short-circuit, idempotency, backdate, grace and resolution logic are untouched.
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_BACKOFF_MS = [500, 1500];
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch the held message through the (injectable) fetchMessage seam, retrying
// transient misses: BOTH a null return and a thrown error count as a miss and
// trigger a retry. Returns the message, or null once all attempts are spent (the
// caller then returns message_unreachable, exactly as the single-shot fetch did).
// `sleep` is injectable so tests can exercise the retry path with no real delay.
async function _fetchMessageWithRetry(fetchMessage, client, channelId, messageId, id, sleep) {
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    let message = null;
    let errMsg = null;
    try {
      message = await fetchMessage(client, channelId, messageId);
    } catch (err) {
      errMsg = (err && err.message) ? err.message : String(err);
    }
    if (message) return message;

    const last = attempt === FETCH_MAX_ATTEMPTS;
    const why = errMsg ? `threw: ${errMsg}` : 'returned null';
    console.log(`[HoldRecover] ${id.slice(0, 16)} fetch attempt ${attempt}/${FETCH_MAX_ATTEMPTS} ${why}${last ? ' — giving up' : ', retrying'}`);
    if (last) return null;
    const delay = FETCH_RETRY_BACKOFF_MS[attempt - 1] ?? FETCH_RETRY_BACKOFF_MS[FETCH_RETRY_BACKOFF_MS.length - 1];
    await sleep(delay);
  }
  return null;
}

// Default image collector — the exported, origin-tagging getImageAttachments.
function _defaultGetImages(message) {
  return require('../handlers/messageHandler').getImageAttachments(message);
}

// Default extraction — the exact won-race vision_slip path, per eligible image.
// Returns { bets: [...createBetWithLegs records] }. Created bets are
// source:'vision_slip', review_status:'needs_review', and posted to the war
// room by processSlipImage, identical to a normal slip ingest.
async function _defaultExtract({ client, message, ingestId, channelId, messageId, messageUrl, images }) {
  const handler = require('../handlers/messageHandler');
  const capperInfo = handler.resolveCapper(message);
  const capper = await getOrCreateCapper(capperInfo.discordId, capperInfo.name, capperInfo.avatar);
  const bets = [];
  for (const img of images) {
    const res = await handler.processSlipImage(client, img.url, capper.id, capperInfo.name, {
      channelId, messageId, sourceUrl: messageUrl, ingestId,
    });
    for (const b of (res && res.bets ? res.bets : [])) bets.push(b);
  }
  return { bets };
}

// channelId from the hold payload (or the messageUrl's middle segment);
// messageId from the messageUrl's last segment (or the `disc_<id>` tail).
function _deriveSourceIds(ingestId, payload) {
  let channelId = payload && payload.channelId != null ? String(payload.channelId) : null;
  let messageId = null;
  const url = payload && payload.messageUrl ? String(payload.messageUrl) : '';
  const m = url.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (m) { if (!channelId) channelId = m[2]; messageId = m[3]; }
  if (!messageId) messageId = String(ingestId).replace(/^disc_/, '') || null;
  return { channelId, messageId };
}

// Most recent of the three terminal hold stages (same query shape dismissHold
// uses; created_at is epoch seconds and can tie, so id breaks ties).
function _latestHoldStage(id) {
  const row = db.prepare(`
    SELECT stage FROM pipeline_events
    WHERE ingest_id = ?
      AND stage IN ('MANUAL_REVIEW_HOLD', 'MANUAL_REVIEW_RELEASED', 'MANUAL_REVIEW_DISMISSED')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(id);
  return row ? row.stage : null;
}

// Atomic hold resolution: MANUAL_REVIEW_RELEASED stage advance (same terminal
// as a manual Release) + a durable hold_review_decisions row recording the
// actor and the recovered bet(s). One db.transaction, mirroring dismissHold.
function _resolveRecoveredHold(id, payload, betIds, actorStr) {
  const betId = betIds[0];
  db.transaction(() => {
    recordStage({
      ingestId: id,
      betId,
      sourceType: 'discord',
      sourceRef: id.replace(/^disc_/, ''),
      stage: 'MANUAL_REVIEW_RELEASED',
      eventType: 'STAGE_ENTER',
      payload: {
        recovered_by: actorStr,
        bet_id: betId,
        bet_ids: betIds,
        via: 'unfurl_recovery',
        message_url: payload && payload.messageUrl ? payload.messageUrl : null,
      },
    });
    db.prepare(`
      INSERT INTO hold_review_decisions
        (ingest_id, hold_payload, reparse_attempted, reparse_input_source, reparse_input_text,
         reparse_output, reparse_confidence, human_decision, human_edits, source_label,
         bet_id, reviewed_by, created_at)
      VALUES
        (@ingest_id, @hold_payload, 1, 'image', NULL,
         @reparse_output, NULL, 'recovered', NULL, 'unfurl_recovery',
         @bet_id, @reviewed_by, @created_at)
    `).run({
      ingest_id: id,
      hold_payload: payload ? JSON.stringify(payload) : null,
      reparse_output: JSON.stringify({ betIds }),
      bet_id: betId,
      reviewed_by: actorStr,
      created_at: Math.floor(Date.now() / 1000),
    });
  })();
}

// Backdating seam (Phase 2b-2 fix). A recovered bet is created days after its
// slip was posted, so createBet's default created_at=now / event_date=NULL would
// anchor grading on the RECOVERY date — the AI grader (event_date || created_at)
// and sportsdata getBetDate (created_at || event_date) then read a date in the
// future relative to the game and stall on "too soon to grade". Stamp BOTH from
// the original Discord post time so every grader family anchors correctly.
//
// Format mirrors SQLite datetime('now') — UTC 'YYYY-MM-DD HH:MM:SS' — so it
// matches stored created_at exactly (getBetDate slices [0,10]; the won-race path
// stores created_at UTC). Returns null for a missing/invalid timestamp so
// recovery still proceeds (the bet just keeps created_at=now, logged as a warn).
function _recoveredDatesFromTimestamp(createdTimestamp) {
  const ms = Number(createdTimestamp);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const iso = new Date(ms).toISOString(); // e.g. 2026-06-01T18:45:45.123Z
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)) return null;
  return {
    createdAt: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`, // 2026-06-01 18:45:45 (UTC)
    eventDate: iso.slice(0, 10),                            // 2026-06-01
  };
}

// Backdate the recovered bet(s) to the original slip post time. Recover-path
// ONLY — the hot won-race create path never calls this and still defaults
// created_at=now / event_date=NULL.
function _backdateRecoveredBets(id, betIds, message) {
  const dates = _recoveredDatesFromTimestamp(message && message.createdTimestamp);
  if (!dates) {
    console.log(`[HoldRecover] ${id.slice(0, 16)} WARN no valid message.createdTimestamp (${message && message.createdTimestamp}) — bet keeps created_at=now`);
    return null;
  }
  const upd = db.prepare('UPDATE bets SET created_at = ?, event_date = ? WHERE id = ?');
  db.transaction(() => { for (const bid of betIds) upd.run(dates.createdAt, dates.eventDate, bid); })();
  console.log(`[HoldRecover] ${id.slice(0, 16)} backdated ${betIds.length} bet(s) created_at=${dates.createdAt} event_date=${dates.eventDate} (msg ts=${message.createdTimestamp})`);
  return dates;
}

// Phase 2b-2: recovered bets are backdated to the original slip time (#59),
// which would trip the 7-Day Smart Sweeper (services/grading.js runAutoGrade)
// immediately and auto-grade them a FALSE loss before the grader runs. Stamp a
// self-expiring grace marker measured from the RECOVERY moment (NOT backdated)
// so the sweeper leaves the bet pending for a few real grading cycles. Set on
// EVERY recovery, independent of whether the backdate succeeded — the column
// defaults NULL everywhere else, so only recovered bets get the window.
const GRACE_DAYS = 3;
function _graceMarkRecoveredBets(id, betIds) {
  const upd = db.prepare("UPDATE bets SET sweep_exempt_until = datetime('now', ?) WHERE id = ?");
  db.transaction(() => { for (const bid of betIds) upd.run(`+${GRACE_DAYS} days`, bid); })();
  console.log(`[HoldRecover] ${id.slice(0, 16)} grace-marked ${betIds.length} bet(s) sweep_exempt_until=now+${GRACE_DAYS}d`);
}

// TOCTOU guard: the source_message_id pre-check below runs at ENTRY, but the
// bet insert lands seconds later (fetch retries + vision). Two rapid dashboard
// clicks both pass the pre-check before either inserts → duplicate bets
// (observed 2026-06-10, ingest disc_1513906474227732602). The bot is
// single-process, so an in-memory in-flight set keyed on ingest id closes the
// window; the pre-check stays for sequential re-clicks.
const inFlightRecoveries = new Set();

async function recoverHold(ingestId, actor, deps = {}) {
  const id = String(ingestId == null ? '' : ingestId).trim();
  if (!id) return { ok: false, status: 'not_found', ingestId: id };
  const actorStr = (actor == null || String(actor).trim() === '') ? 'unknown' : String(actor);

  if (inFlightRecoveries.has(id)) {
    console.log(`[recoverHold] duplicate in-flight, skipping key=${id}`);
    return { ok: false, status: 'in_flight', ingestId: id };
  }
  inFlightRecoveries.add(id);
  try {
    return await _recoverHoldInner(id, actorStr, deps);
  } finally {
    inFlightRecoveries.delete(id);
  }
}

async function _recoverHoldInner(id, actorStr, deps) {
  const client = ('client' in deps) ? deps.client : global._discordClient;
  const fetchMessage = deps.fetchMessage || _defaultFetchMessage;
  const getImages = deps.getImageAttachments || _defaultGetImages;
  const extract = deps.extract || _defaultExtract;
  const sleep = deps.sleep || _sleep;

  // 1. the hold must exist (reuses loadHoldEvent → latest MANUAL_REVIEW_HOLD payload)
  const payload = loadHoldEvent(id);
  if (!payload) return { ok: false, status: 'not_found', ingestId: id };

  // 2. derive the source channel + message ids
  const { channelId, messageId } = _deriveSourceIds(id, payload);
  const messageUrl = payload.messageUrl || null;
  const lookupBet = () => (messageId
    ? db.prepare('SELECT id FROM bets WHERE source_message_id = ? LIMIT 1').get(messageId)
    : null);

  // 3. idempotency — a bet already exists for this source message
  const existing = lookupBet();
  if (existing) {
    // self-heal a partial run: bet created but the hold was never advanced
    if (_latestHoldStage(id) === 'MANUAL_REVIEW_HOLD') _resolveRecoveredHold(id, payload, [existing.id], actorStr);
    return { ok: true, status: 'already_recovered', ingestId: id, betId: existing.id };
  }

  // 4. hold already terminal (released or dismissed) → refuse
  const latest = _latestHoldStage(id);
  if (latest === 'MANUAL_REVIEW_RELEASED' || latest === 'MANUAL_REVIEW_DISMISSED') {
    return { ok: false, status: 'already_resolved', ingestId: id };
  }

  // 5. fetch the (now-unfurled) Discord message, retrying transient misses. No
  //    client = nothing to retry against, so that still bails immediately.
  if (!client) return { ok: false, status: 'message_unreachable', ingestId: id, reason: 'no_client' };
  const message = await _fetchMessageWithRetry(fetchMessage, client, channelId, messageId, id, sleep);
  if (!message) return { ok: false, status: 'message_unreachable', ingestId: id };

  // 6. images present yet? Prefer REAL slip attachments (origin:'attachment'),
  //    fail safe to all images if none are tagged — mirrors
  //    ocrFirstWiring.eligibleImageCount so a slip+share-embed counts as one slip.
  const all = (getImages(message) || []).filter(im => im && im.url);
  const realSlips = all.filter(im => im.origin === 'attachment');
  const images = realSlips.length ? realSlips : all;
  console.log(`[HoldRecover] ${id.slice(0, 16)} images total=${all.length} real=${realSlips.length} using=${images.length}${images.length ? ' urls=' + images.map(i => i.url.slice(0, 48)).join(' | ') : ''}`);
  if (images.length === 0) return { ok: false, status: 'no_image_yet', ingestId: id };

  // 7. run the existing vision_slip extraction + create path
  let bets = [];
  try {
    const out = await extract({ client, message, ingestId: id, channelId, messageId, messageUrl, images });
    bets = (out && out.bets) ? out.bets : [];
  } catch (err) {
    // A bet may have been created before a late throw (e.g. the staging embed
    // post failed after createBetWithLegs). Recover idempotently.
    console.error(`[HoldRecover] ${id.slice(0, 16)} extraction threw: ${err.message}`);
    const after = lookupBet();
    if (after) {
      if (_latestHoldStage(id) === 'MANUAL_REVIEW_HOLD') _resolveRecoveredHold(id, payload, [after.id], actorStr);
      return { ok: true, status: 'already_recovered', ingestId: id, betId: after.id };
    }
    return { ok: false, status: 'no_bet_found', ingestId: id, reason: 'extract_error' };
  }
  const created = bets.filter(b => b && !b._deduped && b.id);
  console.log(`[HoldRecover] ${id.slice(0, 16)} vision yielded=${bets.length} created=${created.length}`);

  if (created.length === 0) {
    // fingerprint dedup may have matched a bet created by a racing recover
    const after = lookupBet();
    if (after) {
      if (_latestHoldStage(id) === 'MANUAL_REVIEW_HOLD') _resolveRecoveredHold(id, payload, [after.id], actorStr);
      return { ok: true, status: 'already_recovered', ingestId: id, betId: after.id };
    }
    return { ok: false, status: 'no_bet_found', ingestId: id }; // leave the hold open
  }

  // 8. backdate the recovered bet(s) to the original slip post time, THEN
  //    resolve the hold (atomic stage advance + decision row).
  const betIds = created.map(b => b.id);
  _backdateRecoveredBets(id, betIds, message);
  _graceMarkRecoveredBets(id, betIds); // Phase 2b-2: self-expiring sweeper-grace window
  _resolveRecoveredHold(id, payload, betIds, actorStr);
  return { ok: true, status: 'recovered', ingestId: id, betId: betIds[0], betIds };
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

module.exports = { handleHoldInteraction, dismissHold, recoverHold, _recoveredDatesFromTimestamp, _graceMarkRecoveredBets, GRACE_DAYS, FETCH_MAX_ATTEMPTS, FETCH_RETRY_BACKOFF_MS };
