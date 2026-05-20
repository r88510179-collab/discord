#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════
// scripts/review-holds.js
//
// Interactive human-in-the-loop review of MANUAL_REVIEW_HOLD slips.
// Run via:  fly ssh console -a bettracker-discord-bot
//           node scripts/review-holds.js [--hours=N] [--dry-run] [--ingest-id=X]
//
// For each unresolved hold in the window it:
//   1. fetches the original Discord message (the payload `sample` is
//      only 80 chars — the real bet text lives in the Twitter embed body)
//   2. derives a source_label from the message structure
//   3. re-parses the richest available content with parseBetText
//   4. prompts release / release+edit / dismiss / skip / quit
//   5. on release, creates the bet (no Discord modal) and writes the
//      MANUAL_REVIEW_RELEASED pipeline_events row
//   6. writes a hold_review_decisions row (migration 025) capturing the
//      full input/output/decision — the training signal for a future
//      smart-default path in services/holdReview.js.
//
// Deviations from prompts/hold-review-decisions-prompt.md (documented):
//  - Intents are [Guilds, GuildMessages, MessageContent] (prompt listed
//    only the last two). `Guilds` is required for channel/message REST
//    fetches and matches bot.js. clientReady (not ready) per the prompt.
//  - Input is line-based (type a letter, press Enter) rather than raw
//    single-keypress, so piped smoke input works over `fly ssh console`.
//  - The parser does NOT reliably set is_bet=true on success (the regex
//    fast-path sets neither is_bet nor type; the LLM bet path sets
//    type='bet'). bets.length >= 1 is the robust "is a bet" signal, so
//    reparse_confidence is computed off bets[] presence + field shape.
//  - twitter detection accepts x.com as well as twitter.com.
//  - human_edits uses a clean { from, to } per changed field.
// ═══════════════════════════════════════════════════════════

const readline = require('readline');
const os = require('os');

// ── Layout ──────────────────────────────────────────────────
const WIDTH = 81;
const HR = '═'.repeat(WIDTH);
function sectionRule(title) {
  const left = '───────────── ';
  const t = `${title} `;
  const fill = Math.max(0, WIDTH - left.length - t.length);
  return `${left}${t}${'─'.repeat(fill)}`;
}
const BOTTOM_RULE = '─'.repeat(WIDTH);

// ════════════════════════════════════════════════════════════
// Pure helpers (no side effects — exported for offline unit tests)
// ════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = { hours: 48, dryRun: false, ingestId: null };
  for (const a of (argv || []).slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--hours=')) {
      const n = parseInt(a.slice('--hours='.length), 10);
      if (Number.isFinite(n) && n > 0) args.hours = n;
    } else if (a.startsWith('--ingest-id=')) {
      args.ingestId = a.slice('--ingest-id='.length).trim() || null;
    }
  }
  return args;
}

function isTwitterUrl(s) {
  if (!s) return false;
  return /(https?:\/\/)?(www\.)?(twitter|x)\.com\//i.test(String(s));
}

// discord.js v14 received-embed accessors (getters + raw .data fallback)
function embType(e) { return (e && (e.data?.type || e.type)) || null; }
function embUrl(e) { return (e && (e.url || e.data?.url)) || null; }
function embDesc(e) { return (e && (e.description ?? e.data?.description)) || ''; }
function embAuthorName(e) { return (e && (e.author?.name || e.data?.author?.name)) || null; }

function imageAttachments(msg) {
  const list = msg && msg.attachments ? [...msg.attachments.values()] : [];
  return list.filter(a =>
    (a.contentType && String(a.contentType).includes('image')) ||
    /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url || '')
  );
}

// First match wins, per the derivation rules in the prompt.
function deriveSourceLabel(msg) {
  if (!msg) return 'other';
  const content = msg.content || '';
  const attachments = msg.attachments ? [...msg.attachments.values()] : [];
  const embeds = msg.embeds || [];
  const e0 = embeds[0];
  const hasImageAttachment = imageAttachments(msg).length > 0;

  // 1. hrb_image — image attachment + a Hard Rock share link in the text
  if (attachments.length > 0 && hasImageAttachment && /hardrock\.bet|share\.hardrock/i.test(content)) {
    return 'hrb_image';
  }

  // 2. twitter_quote — [Quoted](twitter/x...) text OR a populated twitter embed with an author
  const quotedTwitter = /^\[Quoted\]\(https?:\/\/(www\.)?(twitter|x)\.com/i.test(content);
  const embedIsTwitter = !!e0 && isTwitterUrl(embUrl(e0)) && !!embAuthorName(e0);
  if (quotedTwitter || embedIsTwitter) return 'twitter_quote';

  // 3. youtube_video
  if (e0 && embType(e0) === 'video' && /youtube\.com|youtu\.be/i.test(embUrl(e0) || '')) {
    return 'youtube_video';
  }

  // 4. bare_image
  if ((e0 && embType(e0) === 'image') ||
      (!content.trim() && attachments.length === 1 && hasImageAttachment && embeds.length === 0)) {
    return 'bare_image';
  }

  // 5. twitter_text_only — a bare tweet share URL that never produced an embed
  if (isTwitterUrl(content) && embeds.length === 0) return 'twitter_text_only';

  // 6. discord_text_only
  if (content.trim() && embeds.length === 0 && attachments.length === 0) return 'discord_text_only';

  // 7. other
  return 'other';
}

// What to feed parseBetText, per source_label. source ∈
//   twitter_embed_description | message_content | image_ocr | none
function selectReparseInput(sourceLabel, msg) {
  const e0 = msg && msg.embeds ? msg.embeds[0] : null;
  switch (sourceLabel) {
    case 'twitter_quote':
      return { source: 'twitter_embed_description', text: embDesc(e0) };
    case 'discord_text_only':
    case 'twitter_text_only':
      return { source: 'message_content', text: (msg && msg.content) || '' };
    case 'hrb_image':   // OCR path (parseBetSlipImage) — not attempted here
    case 'youtube_video':
    case 'bare_image':
      return { source: 'none', text: '' };
    case 'other':
    default: {
      const c = (msg && msg.content) || '';
      return c.trim() ? { source: 'message_content', text: c } : { source: 'none', text: '' };
    }
  }
}

function isBetResult(out) {
  return !!out && Array.isArray(out.bets) && out.bets.length >= 1;
}

// reparse_confidence enum. is_bet is unreliable on the success path, so
// bets[] presence is the bet signal (see header deviation note).
function computeConfidence(out) {
  if (out && out.is_bet === false) return 'parsed_empty';
  if (!isBetResult(out)) return 'parsed_empty';
  const allClean = out.bets.every(b =>
    b && typeof b.description === 'string' && b.description.trim().length > 0 && b.odds != null);
  return allClean ? 'parsed_clean' : 'parsed_partial';
}

function normalizeOdds(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const n = parseInt(String(v).replace(/[+\s]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function fmtOdds(o) {
  if (o == null) return 'null';
  return o > 0 ? `+${o}` : `${o}`;
}

function fmtHeldTime(epochSec, nowSec = Math.floor(Date.now() / 1000)) {
  const d = new Date(epochSec * 1000);
  const iso = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const diff = Math.max(0, nowSec - epochSec);
  let ago;
  if (diff < 3600) ago = `${Math.round(diff / 60)}m ago`;
  else if (diff < 86400) ago = `${Math.round(diff / 3600)}h ago`;
  else ago = `${Math.round(diff / 86400)}d ago`;
  return { iso, ago };
}

function primaryBet(out) {
  return (out && Array.isArray(out.bets) && out.bets[0]) || null;
}

// ════════════════════════════════════════════════════════════
// Lazy deps — required only when actually running (keeps the pure
// helpers above importable for tests without Discord login / DB init).
// ════════════════════════════════════════════════════════════
let _deps = null;
function getDeps() {
  if (_deps) return _deps;
  _deps = {
    database: require('../services/database'),
    ai: require('../services/ai'),
    dashboard: require('../services/dashboard'),
    pipelineEvents: require('../services/pipeline-events'),
  };
  return _deps;
}

// ════════════════════════════════════════════════════════════
// Hold loading
// ════════════════════════════════════════════════════════════
function loadUnresolvedHolds(db, { hours, ingestId }) {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

  const holdRows = ingestId
    ? db.prepare(`
        SELECT ingest_id, payload, created_at, source_ref
        FROM pipeline_events
        WHERE stage = 'MANUAL_REVIEW_HOLD' AND ingest_id = ?
        ORDER BY created_at ASC
      `).all(ingestId)
    : db.prepare(`
        SELECT ingest_id, payload, created_at, source_ref
        FROM pipeline_events
        WHERE stage = 'MANUAL_REVIEW_HOLD' AND created_at >= ?
        ORDER BY created_at ASC
      `).all(cutoff);

  const candidateIds = [...new Set(holdRows.map(r => r.ingest_id))];
  let resolved = new Set();
  if (candidateIds.length) {
    const placeholders = candidateIds.map(() => '?').join(',');
    resolved = new Set(
      db.prepare(`
        SELECT DISTINCT ingest_id FROM pipeline_events
        WHERE stage IN ('MANUAL_REVIEW_RELEASED','MANUAL_REVIEW_DISMISSED')
          AND ingest_id IN (${placeholders})
      `).all(...candidateIds).map(r => r.ingest_id),
    );
  }

  // Dedup by ingest_id (keep most recent hold row), drop resolved, sort chronological.
  const byId = new Map();
  for (const row of holdRows) {
    const prev = byId.get(row.ingest_id);
    if (!prev || row.created_at > prev.created_at) byId.set(row.ingest_id, row);
  }
  return [...byId.values()]
    .filter(h => !resolved.has(h.ingest_id))
    .sort((a, b) => a.created_at - b.created_at);
}

function parsePayload(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function urlParts(messageUrl, ingestId, payload) {
  const m = (messageUrl || '').match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (m) return { channelId: m[1], messageId: m[2] };
  return {
    channelId: payload.channelId || null,
    messageId: (ingestId || '').replace(/^disc_/, '') || null,
  };
}

// ════════════════════════════════════════════════════════════
// Rendering
// ════════════════════════════════════════════════════════════
function originalDisplay(sourceLabel, msg, reparseInput) {
  if (!msg) return { label: 'Original (message unavailable)', text: '(could not fetch the Discord message — deleted or no access)' };
  if (sourceLabel === 'twitter_quote') {
    return { label: 'Original (Twitter card description)', text: reparseInput.text || msg.content || '(empty embed description)' };
  }
  if (sourceLabel === 'hrb_image' || sourceLabel === 'bare_image') {
    const urls = imageAttachments(msg).map(a => a.url);
    const e0 = msg.embeds && msg.embeds[0];
    if (e0 && (e0.image?.url || e0.data?.image?.url)) urls.push(e0.image?.url || e0.data?.image?.url);
    const lines = [];
    if (msg.content) lines.push(msg.content);
    lines.push(...urls.map(u => `[image] ${u}`));
    return { label: 'Original (image slip)', text: lines.join('\n') || '(no content)' };
  }
  if (sourceLabel === 'youtube_video') {
    const e0 = msg.embeds && msg.embeds[0];
    return { label: 'Original (YouTube embed)', text: `${msg.content || ''}\n[video] ${embUrl(e0) || ''}`.trim() };
  }
  return { label: 'Original (message content)', text: msg.content || '(no content)' };
}

function printReviewBlock({ index, total, hold, payload, sourceLabel, channelName, reparse }) {
  const { iso, ago } = fmtHeldTime(hold.created_at);
  const capper = payload.capper || 'unknown';
  const reason = payload.reason || '—';
  const messageUrl = payload.messageUrl || '(no url)';

  console.log(`\n${HR}`);
  console.log(`[${index}/${total}]  ${hold.ingest_id}        ${capper}  •  ${reason}`);
  console.log(`        held ${iso} (${ago})        channel: ${channelName ? '#' + channelName : payload.channelId || 'unknown'}`);
  console.log(`        url:  ${messageUrl}`);
  console.log(`        source_label: ${sourceLabel}`);

  const orig = reparse.original;
  console.log(`\n${sectionRule(orig.label)}`);
  console.log(orig.text);
  console.log(BOTTOM_RULE);

  if (reparse.confidence === 'not_attempted') {
    console.log(`\n${sectionRule('Re-parse (not attempted)')}`);
    if (sourceLabel === 'hrb_image') {
      console.log('Hard Rock slip — needs image OCR (parseBetSlipImage), not text re-parse.');
      console.log('Suggested: [e]release+edit for manual entry, or [d]ismiss.');
    } else if (sourceLabel === 'youtube_video' || sourceLabel === 'bare_image') {
      console.log(`${sourceLabel} — no parseable text. Suggested: [d]ismiss.`);
    } else {
      console.log('No usable text to re-parse. Suggested: [e]release+edit or [d]ismiss.');
    }
    console.log(BOTTOM_RULE);
  } else if (reparse.confidence === 'parse_error') {
    console.log(`\n${sectionRule('Re-parse output (parse_error)')}`);
    console.log(`Parser threw: ${reparse.output && reparse.output.error}`);
    console.log(BOTTOM_RULE);
  } else if (reparse.confidence === 'parsed_empty') {
    console.log(`\n${sectionRule('Re-parse output (parsed_empty)')}`);
    console.log(`No bet extracted (is_bet=${isBetResult(reparse.output)}, bets=${(reparse.output && reparse.output.bets ? reparse.output.bets.length : 0)}).`);
    console.log('Suggested: [d]ismiss or [e]release+edit.');
    console.log(BOTTOM_RULE);
  } else {
    const out = reparse.output;
    const primary = primaryBet(out);
    console.log(`\n${sectionRule(`Re-parse output (${reparse.confidence})`)}`);
    console.log(`Sport:        ${primary ? primary.sport : 'Unknown'}`);
    console.log(`Bet type:     ${primary ? primary.bet_type : 'straight'}`);
    console.log(`is_bet:       ${isBetResult(out)}`);
    console.log('Bets:');
    out.bets.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.description}    [odds: ${fmtOdds(normalizeOdds(b.odds))}]   [units: ${b.units != null ? b.units : 1}]`);
    });
    console.log(BOTTOM_RULE);
  }
}

// ════════════════════════════════════════════════════════════
// Main (only when invoked directly)
// ════════════════════════════════════════════════════════════
async function main() {
  const ARGS = parseArgs(process.argv);
  const { Client, GatewayIntentBits } = require('discord.js');
  const { db, createBetWithLegs } = getDeps().database;
  const { parseBetText } = getDeps().ai;
  const { postNewPick } = getDeps().dashboard;
  const { recordStage } = getDeps().pipelineEvents;

  const REVIEWED_BY = `review-holds-script:${(() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })()}`;
  const RELEASED_BY = 'review-holds-script';
  const BET_SOURCE = 'hold_review_script';

  const insertHrd = db.prepare(`
    INSERT INTO hold_review_decisions
      (ingest_id, hold_payload, reparse_attempted, reparse_input_source, reparse_input_text,
       reparse_output, reparse_confidence, human_decision, human_edits, source_label,
       bet_id, reviewed_by, created_at)
    VALUES
      (@ingest_id, @hold_payload, @reparse_attempted, @reparse_input_source, @reparse_input_text,
       @reparse_output, @reparse_confidence, @human_decision, @human_edits, @source_label,
       @bet_id, @reviewed_by, @created_at)
  `);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stdinClosed = false;
  rl.on('close', () => { stdinClosed = true; });
  function ask(q) {
    return new Promise((resolve) => {
      if (stdinClosed) return resolve('');
      let done = false;
      const onClose = () => { if (!done) { done = true; resolve(''); } };
      rl.once('close', onClose);
      rl.question(q, (ans) => { done = true; rl.removeListener('close', onClose); resolve(ans); });
    });
  }

  // ── re-parse one hold's content ──
  async function runReparse(sourceLabel, msg) {
    const sel = selectReparseInput(sourceLabel, msg);
    const base = {
      input_source: sel.source,
      input_text: (sel.text || '').slice(0, 4000),
      original: originalDisplay(sourceLabel, msg, sel),
    };
    if (sel.source === 'none') {
      return { ...base, attempted: 0, output: null, confidence: 'not_attempted' };
    }
    if (!sel.text || sel.text.trim().length < 5) {
      // Obvious junk — skip the API call (prompt rule).
      return { ...base, attempted: 0, output: null, confidence: 'parsed_empty' };
    }
    try {
      const output = await parseBetText(sel.text);
      return { ...base, attempted: 1, output, confidence: computeConfidence(output) };
    } catch (err) {
      return { ...base, attempted: 1, output: { error: err.message }, confidence: 'parse_error' };
    }
  }

  // ── persist a decision atomically ──
  // Per the hard rule, createBetWithLegs runs INSIDE the same transaction as the
  // pipeline_events + hold_review_decisions inserts, so a partial failure rolls
  // back cleanly (no orphan bet, no half-written audit). Returns the created bet
  // (or null); postNewPick (async, non-fatal) runs afterward, outside the txn.
  function commitDecision({ hold, payload, sourceLabel, reparse, human_decision, human_edits, release }) {
    const messageId = urlParts(payload.messageUrl, hold.ingest_id, payload).messageId;
    return db.transaction(() => {
      let bet = null;
      if (release) {
        bet = createReleaseBet({ payload, hold, capper: release.capper, fields: release.fields, reparse });
      }
      if (human_decision === 'dismissed') {
        recordStage({
          ingestId: hold.ingest_id,
          sourceType: 'discord',
          sourceRef: messageId,
          stage: 'MANUAL_REVIEW_DISMISSED',
          eventType: 'STAGE_ENTER',
          payload: { dismissed_by: RELEASED_BY, reason: 'manual-cli-review', source_label: sourceLabel },
        });
      }
      if ((human_decision === 'released' || human_decision === 'released_with_edits') && bet) {
        recordStage({
          ingestId: hold.ingest_id,
          betId: bet.id,
          sourceType: 'discord',
          sourceRef: messageId,
          stage: 'MANUAL_REVIEW_RELEASED',
          eventType: 'STAGE_ENTER',
          payload: { released_by: RELEASED_BY, bet_id: bet.id, reparse_confidence: reparse.confidence, source_label: sourceLabel },
        });
      }
      insertHrd.run({
        ingest_id: hold.ingest_id,
        hold_payload: hold.payload || null,
        reparse_attempted: reparse.attempted,
        reparse_input_source: reparse.input_source,
        reparse_input_text: reparse.input_text || null,
        reparse_output: reparse.output ? JSON.stringify(reparse.output) : null,
        reparse_confidence: reparse.confidence,
        human_decision,
        human_edits: human_edits ? JSON.stringify(human_edits) : null,
        source_label: sourceLabel,
        bet_id: bet ? bet.id : null,
        reviewed_by: REVIEWED_BY,
        created_at: Math.floor(Date.now() / 1000),
      });
      return bet;
    })();
  }

  // ── build betData + create the bet ──
  function createReleaseBet({ payload, hold, capper, fields, reparse }) {
    const { channelId, messageId } = urlParts(payload.messageUrl, hold.ingest_id, payload);
    const legs = (fields.bet_type === 'parlay' && reparse.output && Array.isArray(primaryBet(reparse.output)?.legs))
      ? primaryBet(reparse.output).legs
      : [];
    return createBetWithLegs({
      capper_id: capper.id,
      sport: fields.sport || 'Unknown',
      league: null,
      bet_type: fields.bet_type || 'straight',
      description: fields.description,
      odds: fields.odds,
      units: fields.units,
      event_date: null,
      source: BET_SOURCE,
      source_url: payload.messageUrl || null,
      source_channel_id: channelId,
      source_message_id: messageId,
      raw_text: reparse.input_text || payload.sample || null,
      review_status: 'confirmed',
      wager: null,
      payout: null,
      is_ladder: false,
      ladder_step: 0,
    }, legs);
  }

  function lookupCapper(name) {
    if (!name) return null;
    return db.prepare('SELECT id, display_name FROM cappers WHERE LOWER(display_name) = LOWER(?) LIMIT 1').get(name);
  }
  function listCappers() {
    return db.prepare('SELECT display_name FROM cappers ORDER BY display_name').all().map(c => c.display_name).join(', ');
  }

  // ── the edit sub-flow: returns { fields, edits } or null if aborted ──
  async function runEditFlow(reparse) {
    const primary = primaryBet(reparse.output);
    const base = {
      sport: primary ? primary.sport : '',
      bet_type: primary ? primary.bet_type : 'straight',
      description: primary ? primary.description : '',
      odds: primary ? normalizeOdds(primary.odds) : null,
      units: primary ? (primary.units != null ? primary.units : 1) : 1,
    };
    console.log(`\nCurrent values:  sport=${base.sport || '(none)'}  bet_type=${base.bet_type}  description="${base.description}"  odds=${fmtOdds(base.odds)}  units=${base.units}`);
    const sport = (await ask(`  sport [${base.sport}]: `)).trim() || base.sport;
    const bet_type = (await ask(`  bet_type [${base.bet_type}]: `)).trim() || base.bet_type;
    const description = (await ask(`  description [${base.description}]: `)).trim() || base.description;
    const oddsRaw = (await ask(`  odds [${fmtOdds(base.odds)}]: `)).trim();
    const odds = oddsRaw === '' ? base.odds : normalizeOdds(oddsRaw);
    const unitsRaw = (await ask(`  units [${base.units}]: `)).trim();
    const units = unitsRaw === '' ? base.units : (Number.isFinite(parseFloat(unitsRaw)) ? parseFloat(unitsRaw) : base.units);

    const fields = { sport, bet_type, description, odds, units };
    const edits = {};
    for (const f of ['sport', 'bet_type', 'description', 'odds', 'units']) {
      if (String(base[f] ?? '') !== String(fields[f] ?? '')) {
        edits[f] = { from: base[f] ?? null, to: fields[f] ?? null };
      }
    }
    if (!description || !description.trim()) {
      console.log('  ✗ Description is required — aborting edit.');
      return null;
    }
    const confirm = (await ask('Submit? [y/n]: ')).trim().toLowerCase();
    if (confirm[0] !== 'y') return null;
    return { fields, edits };
  }

  // ════════════════════════════════════════════════════════════
  async function runReview() {
    const holds = loadUnresolvedHolds(db, { hours: ARGS.hours, ingestId: ARGS.ingestId });
    const total = holds.length;
    const mode = ARGS.dryRun ? ' [DRY-RUN — no writes]' : '';
    console.log(`\nUnresolved MANUAL_REVIEW_HOLD slips${ARGS.ingestId ? ` for ${ARGS.ingestId}` : ` in last ${ARGS.hours}h`}: ${total}${mode}`);
    if (total === 0) {
      console.log('Nothing to review.');
      return;
    }

    let reviewed = 0, released = 0, dismissed = 0, skipped = 0, quitAt = total;

    for (let i = 0; i < holds.length; i++) {
      const hold = holds[i];
      const payload = parsePayload(hold.payload);
      const { channelId, messageId } = urlParts(payload.messageUrl, hold.ingest_id, payload);

      // Fetch the live message (the payload sample is only 80 chars).
      let msg = null, channelName = null;
      try {
        const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
        channelName = channel && channel.name;
        if (channel && messageId) msg = await channel.messages.fetch(messageId).catch(() => null);
      } catch (_) { /* deleted / no access — handled below */ }

      const sourceLabel = deriveSourceLabel(msg);
      const reparse = await runReparse(sourceLabel, msg);

      printReviewBlock({ index: i + 1, total, hold, payload, sourceLabel, channelName, reparse });

      // ── action loop (re-prompts on invalid / failed release) ──
      let handled = false;
      while (!handled) {
        console.log('\nAction? [r]elease  [e]release+edit  [d]ismiss  [s]kip  [q]uit');
        const ans = (await ask('> ')).trim().toLowerCase();
        if (stdinClosed && ans === '') { // stdin exhausted → quit cleanly
          quitAt = i + 1;
          console.log('\n(stdin closed — quitting)');
          printSummary();
          return;
        }
        const action = ans[0] || '';

        if (action === 'q') {
          quitAt = i + 1;
          printSummary();
          return;
        }

        if (action === 's') {
          if (ARGS.dryRun) {
            console.log('[DRY-RUN] would record skip (still unresolved)');
          } else {
            commitDecision({ hold, payload, sourceLabel, reparse, human_decision: 'skipped', human_edits: null, release: null });
          }
          console.log('↷ Skipped (still unresolved)');
          skipped++; reviewed++; handled = true;
          break;
        }

        if (action === 'd') {
          if (ARGS.dryRun) {
            console.log('[DRY-RUN] would dismiss (write MANUAL_REVIEW_DISMISSED + decision row)');
          } else {
            commitDecision({ hold, payload, sourceLabel, reparse, human_decision: 'dismissed', human_edits: null, release: null });
          }
          console.log('✓ Dismissed');
          dismissed++; reviewed++; handled = true;
          break;
        }

        if (action === 'r' || action === 'e') {
          // Resolve fields + capper.
          let fields, edits = null, decision;
          if (action === 'e') {
            const res = await runEditFlow(reparse);
            if (!res) { console.log('(edit cancelled — choose again)'); continue; }
            fields = res.fields;
            decision = Object.keys(res.edits).length ? 'released_with_edits' : 'released';
            edits = Object.keys(res.edits).length ? res.edits : null;
          } else {
            const primary = primaryBet(reparse.output);
            if (!primary) {
              console.log('✗ No re-parse output to release — use [e] to enter values manually, or [d]ismiss.');
              continue;
            }
            fields = {
              sport: primary.sport,
              bet_type: primary.bet_type,
              description: primary.description,
              odds: normalizeOdds(primary.odds),
              units: primary.units != null ? primary.units : 1,
            };
            decision = 'released';
          }
          if (!fields.description || !fields.description.trim()) {
            console.log('✗ Description is empty — cannot release. Choose again.');
            continue;
          }
          if (!Number.isFinite(fields.units) || fields.units <= 0) fields.units = 1;

          // Strict capper lookup — no auto-create.
          const capper = lookupCapper(payload.capper);
          if (!capper) {
            console.log(`✗ No capper named "${payload.capper}" exists.\n  Valid cappers: ${listCappers()}`);
            console.log('  (fix the capper in the source or dismiss — choose again)');
            continue;
          }

          if (ARGS.dryRun) {
            console.log(`[DRY-RUN] would release as bet (would-be ID: NEW) — ${capper.display_name} • ${fields.sport} • ${fmtOdds(fields.odds)} • ${fields.units}u • "${fields.description.slice(0, 60)}"${decision === 'released_with_edits' ? ' (edited)' : ''}`);
            released++; reviewed++; handled = true;
            break;
          }

          let bet;
          try {
            bet = commitDecision({ hold, payload, sourceLabel, reparse, human_decision: decision, human_edits: edits, release: { capper, fields } });
          } catch (e) {
            console.log(`✗ Release failed (rolled back, no bet/event/decision written): ${e.message}. Choose again.`);
            continue;
          }
          const deduped = !!(bet && bet._deduped);

          if (!deduped) {
            try { await postNewPick(client, bet, capper.display_name, payload.messageUrl); }
            catch (e) { console.log(`  (postNewPick failed — non-fatal: ${e.message})`); }
            console.log(`✓ Released as bet ${String(bet.id).slice(0, 8)} (${fields.description.slice(0, 40)}, ${fields.sport}, ${fmtOdds(fields.odds)}, ${fields.units}u)`);
          } else {
            console.log(`⚠️ Bet already existed (fingerprint match): ${String(bet.id).slice(0, 8)}. Decision recorded, no duplicate created, hold resolved.`);
          }
          released++; reviewed++; handled = true;
          break;
        }

        console.log(`(unrecognized: "${ans}" — enter r / e / d / s / q)`);
      }
    }

    printSummary();

    function printSummary() {
      console.log(`\n${HR}`);
      console.log(`Reviewed: ${reviewed}. Released: ${released}. Dismissed: ${dismissed}. Skipped: ${skipped}. Quit at: ${quitAt} of ${total}.`);
      console.log(HR);
    }
  }

  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN not set — cannot log in. Run inside the Fly machine (fly ssh console).');
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once('clientReady', async () => {
    try {
      await runReview();
    } catch (err) {
      console.error('[review-holds] fatal:', err.message, err.stack);
    } finally {
      try { rl.close(); } catch (_) {}
      try { await client.destroy(); } catch (_) {}
      process.exit(0);
    }
  });

  client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  parseArgs,
  isTwitterUrl,
  deriveSourceLabel,
  selectReparseInput,
  isBetResult,
  computeConfidence,
  normalizeOdds,
  fmtOdds,
  fmtHeldTime,
  primaryBet,
  loadUnresolvedHolds,
  urlParts,
  parsePayload,
};
