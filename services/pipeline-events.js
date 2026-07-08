// ═══════════════════════════════════════════════════════════
// Pipeline Events — ingest-side observability helper
//
// Writes to the pipeline_events table (migration 018). Every
// silent-drop point in the ingest pipeline must go through
// recordDrop() so "the bet vanished" bugs become traceable.
//
// All three write helpers are fire-and-forget: they NEVER throw
// up the call stack. Observability failure must not break the
// pipeline.
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');
const { db } = require('./database');

// ── Canonical enum lists (kept close to the SQL schema) ─────
const SOURCE_TYPES = ['discord', 'twitter', 'webhook', 'manual', 'grading'];
const STAGES = [
  'RECEIVED', 'AUTHORIZED', 'BUFFERED', 'EXTRACTED', 'PARSED', 'VALIDATED', 'STAGED', 'DROPPED',
  'MANUAL_REVIEW_HOLD',  // human-channel slip held for admin review instead of silent drop
  'MANUAL_REVIEW_DISMISSED', // human reviewer dismissed a held slip (services/holdReview.js:64)
  'MANUAL_REVIEW_RELEASED',  // human reviewer released a held slip back into the pipeline (services/holdReview.js:221) — F-04/F-05 enum-drift registration
  'PURE_SLIP_SKIP_HOLD', // PR #2: pure-slip channel skipped MANUAL_REVIEW_HOLD staging (trace-only marker, NOT a drop; like MANUAL_REVIEW_HOLD it is intentionally absent from pipelineHealth.EXPECTED_STAGES)
  'PURE_SLIP_RECLASSIFIED_EXTRACT', // Onyx-vision fix: a pure-slip channel image that the win-classifier (parseBetText) mislabeled type:'result'/'untracked_win' (green ✓ on an OPEN Onyx pick receipt) was authoritatively re-extracted via parseBetSlipImage and staged as a fresh vision_slip bet instead of diverting to VISION_RESULT_RECAP/VISION_UNTRACKED_WIN. Marker payload {betCount, legCount}; one per constituent ingest_id. Trace-only (the recovered bet emits its own STAGED); NOT a drop; intentionally absent from pipelineHealth.EXPECTED_STAGES.
  // ── 🔄 operator re-ingest (handlers/messageHandler.js reingestSlipMessage) ──
  // Operator reacts 🔄 on a human-submission-channel slip → re-fetch + bets-only
  // re-extraction (parseBetSlipImage) + fresh War Room staging, bypassing the
  // green-check parseBetText path. Three trace markers on ingestId disc_<message.id>;
  // NOT drops; intentionally absent from pipelineHealth.EXPECTED_STAGES. Siblings
  // to PURE_SLIP_SKIP_HOLD (F-05 enum-drift discipline).
  'REINGEST_ATTEMPT',    // one at entry, payload {actorId, channelId}
  'REINGEST_STAGED',     // one on success, payload {mode:'create'|'replace', betCount, betIds}; the recovered bet also emits its own STAGED
  'REINGEST_REPLACED',   // REPLACE mode only: prior needs_review bet(s) deleted + re-staged, payload {old_bet_id, new_bet_id}
  'RECOVERY_ATTEMPT_FAILED', // hold-recovery attempt burned vision+OCR but yielded no bet (validator_drop / no_bet_found / extract threw) — services/holdReview.js records one per failed attempt; COUNT(*) per ingest_id is the retry-cap counter (RECOVERY_RETRY_CAP). Trace-only marker, NOT a drop (the hold stays open); intentionally absent from pipelineHealth.EXPECTED_STAGES.
  'OCR_FIRST',           // OCR-first wiring observability marker (services/ocrFirstWiring.js): shadow compare + cutover route. Trace-only, NOT a drop; intentionally absent from pipelineHealth.EXPECTED_STAGES.
  'SLATE_RESPLIT',       // slate re-split wiring marker (services/slateResplit.js): a mixed-sport recap SHEET Vision collapsed into one dominant-sport parlay. shadow = would-split measurement; cutover = re-split into per-pick straights. Trace-only, NOT a drop; intentionally absent from pipelineHealth.EXPECTED_STAGES.
  'PRE_FILTER_WOULD_DROP', // shadow (PRE_FILTER_MODE): pre-hold classifier (services/preFilter.js) matched a held non-bet (promo/recap/sweat) it WOULD drop under enforce — one STAGE_ENTER per held post on the primary ingest_id, emitted just before the MANUAL_REVIEW_HOLD stageAll in handlers/messageHandler.js. Measurement-only, never gates behavior (the hold still fires in shadow); intentionally absent from pipelineHealth.EXPECTED_STAGES.
  // Grading-side stages (added alongside BetService skeleton — migration 020)
  'GRADING_ENTER',
  'GRADING_SEARCH',
  'GRADING_AI',
  'GRADING_GUARDS',
  'GRADING_COMPLETE',
  'GRADING_DROPPED',
];
const EVENT_TYPES = [
  'STAGE_ENTER', 'STAGE_EXIT', 'DROP', 'ERROR',
  // OCR-first wiring event types (stage 'OCR_FIRST'). Additive/observational —
  // recordStage does not enforce the enum at the write boundary (see CODEMAP F-17).
  'ocr_shadow_decision', // shadow: one per slip — OCR decision compared to the live vision parse
  'ocr_sgp_would_hold',  // shadow (PR 2a): SGP/SGPMAX would-fire measurement — Groq parse + evaluateSgpGate run on the OCR text the SGP bail produced; measurement-only, NOT in EXPECTED_STAGES, never gates behavior (PR 2b acts on a PASS)
  'ocr_used',            // cutover (dormant): OCR parse accepted, staged in place of Gemini
  'ocr_fallback',        // cutover (dormant): degraded to the live Gemini path
  'event_aware_shadow',  // shadow (Codex #3): EVENT_AWARE_RECHECK would-fire measurement — one row per recheck/defer decision (kind=would_window|would_defer) on stage 'GRADING_ENTER'. Additive/observational, never gates behavior (enforce acts via grading_next_attempt_at instead); not in EXPECTED_STAGES.
  'slate_shadow',        // shadow (EVENT_DATE_SLATE): structured-grading slate-date would-change measurement — one row per bet whose event_date is present AND differs from created_at (the population 'enforce' would re-slate from created_at→event_date) on stage 'GRADING_ENTER'. Emitted by services/sportsdata/index.js tryStructured. Additive/observational, never gates behavior (enforce re-keys the slate + absenceVoidAllowed instead); not in EXPECTED_STAGES.
  'soccer_grade_shadow', // shadow (SOCCER_GRADER_MODE): match-level ESPN soccer adapter would-fire measurement — one row per soccer bet/leg the adapter settles (would_status WIN/LOSS/PUSH/VOID) or audits (match_not_final/no_match_found) on stage 'GRADING_ENTER'. Emitted by services/sportsdata/index.js routeSoccer; payload {bet_id, would_status, reason, evidence, source:'espn_soccer', match_id, slug:'fifa.world', desc_or_leg}. Additive/observational, NO grade write — shadow returns fall-through so the real grade is unchanged (enforce returns the resolved status instead); not in EXPECTED_STAGES.
  'slate_resplit_shadow',// shadow (SLATE_RESPLIT_MODE): a multi-leg vision parlay whose raw tweet text is a delimited list of independently-staked picks — one row per such parlay recording the would-split decision + per-pick sport/units sample (stage 'SLATE_RESPLIT'). Emitted by services/twitter-handler.js via services/slateResplit.js. Measurement-only, NEVER re-splits (the parlay stages as today); not in EXPECTED_STAGES.
  'slate_resplit_used',  // cutover (SLATE_RESPLIT_MODE): a detected recap SHEET was re-split into per-pick straights instead of staging the single dominant-sport parlay (stage 'SLATE_RESPLIT'). Emitted by services/twitter-handler.js via services/slateResplit.js.
];
const DROP_REASONS = [
  'DUPLICATE_IMAGE',
  'DUPLICATE_REPOST',           // F-12: twitter content-window repost dedup (same capper/normalized-text/odds within 12h, ignores tweet id) — services/twitter-handler.js
  'AGE_GATE',
  'PRE_FILTER_NO_BET_CONTENT',
  'PRE_FILTER_PROMO',
  // PRE_FILTER_MODE=enforce drops a held non-bet the pre-hold classifier
  // (services/preFilter.js) bucketed, instead of staging MANUAL_REVIEW_HOLD.
  // One reason per bucket so each measured/enforced class is queryable apart
  // from the generic PRE_FILTER_NO_BET_CONTENT. Registered so the warn-only
  // write-boundary tripwire stays quiet when an enforce drop is recorded.
  'PRE_FILTER_PROMO_SHEET',     // promo / sheet / marketing post
  'PRE_FILTER_RECAP',           // past-tense recap ("cashed", "yesterday", "last night")
  'PRE_FILTER_SWEAT_COMMENTARY',// sweat / commentary on an existing bet
  'PRE_FILTER_AI_EMPTY_RESULT', // post-Vision indeterminate branch (handlers/messageHandler.js:1302) — F-04 enum-drift registration
  'GUARD5_INSUFFICIENT_SIGNALS', // GUARD 5 pre-buffer signal heuristic dropped a message (looksLikePick <2 signals, no celebration, no images) — distinct from PRE_FILTER_NO_BET_CONTENT so "a real bare total was discarded by the heuristic" is queryable apart from genuine non-bet text (handlers/messageHandler.js GUARD 5). Incident 2026-06-11.
  'BOUNCER_REJECTED',
  'VISION_EXTRACTION_FAILED',
  // ── F17 (2026-06-16): silent post-EXTRACTED returns in the relay-image path ──
  // handlers/messageHandler.js processAggregatedMessage classified a vision parse as
  // a recap/result and returned WITHOUT recording any terminal event, so the ingest
  // vanished after EXTRACTED with zero bets and no DROP (audit F17: 65 relay-image
  // ingests). These three make each such terminal exit queryable and DISTINCT from a
  // genuine extraction failure (VISION_EXTRACTION_FAILED). Vision succeeded here — the
  // content was simply not a new trackable bet. Mirror of twitter-handler.js's existing
  // vision-result drop (which already used PRE_FILTER_NO_BET_CONTENT + a filter tag).
  'VISION_RESULT_RECAP',        // parsed.type === 'result' → routed to the scoped recap auto-grade (grading.js autoGradeFromRecap), no new bet staged
  'VISION_UNTRACKED_WIN',       // parsed.type === 'untracked_win' → War Room embed only, no new bet
  'VISION_TICKET_RECAP',        // parsed.ticket_status winner/loser → recap-grade matching, no new bet
  'TEXT_EXTRACTION_FAILED',     // parseBetText AI/parse failure (services/ai.js:1154,1173) — F-05 enum-drift registration
  'PARSER_NO_LEGS',
  'VALIDATOR_SPORT_MISMATCH',
  'VALIDATOR_ENTITY_MISMATCH',
  'VALIDATOR_LEG_SHAPE_INVALID', // leg-shape validator rejection (services/ai.js:1746,1755) — F-05 enum-drift registration
  'CAPPER_UNRESOLVED',
  'CHANNEL_UNAUTHORIZED',
  'EXCEPTION_THROWN',
  // Grading-side drops (added alongside BetService skeleton — migration 020)
  'GRADE_TOO_RECENT',
  'GRADE_NO_SEARCH_HITS',
  'GRADE_AI_PENDING_NO_DATA',
  'GRADE_AI_HALLUCINATION',
  'GRADE_SPORT_MISMATCH_POST_AI',
  'GRADE_RESOLVER_UNRESOLVED',
  'GRADE_EXCEPTION',
  'GRADE_BACKOFF_EXHAUSTED',
  'GRADE_AUTOVOID_UNSCOPED',         // gradePropWithAI auto-voided a bet whose sport is null/Unknown/outside SUPPORTED_SPORTS (after reclassify + canonicalizeSportForGrading). This terminal void returns the AUTO_VOIDED sentinel that runAutoGrade's if/else ignores, so pre-#110-followup it left an EMPTY trail (zero pipeline_events) — registered + emitted so each unsupported-sport void is queryable, DISTINCT from the no-data void (review_status='auto_void_no_searchable_data') and the retry-cap void (GRADE_BACKOFF_EXHAUSTED). Audit B7 follow-up 2026-06-16.
  'GRADE_MANUAL_REVIEW_UNMODELED',   // gradePropWithAI DIVERTED a bet to manual review (review_status='manual_review_unmodeled_sport') instead of auto-voiding, because its declared sport names a REAL intentionally-unmodeled league (KBO/KHL/NPB — declaresAnyUnmodeledLeague; ANY part of a compound). Unlike GRADE_AUTOVOID_UNSCOPED, NO grade/profit is written and result stays 'pending' for a human — the bet is sweeper-safe (getPendingBets excludes it in both paths). DISTINCT from the unsupported-sport void so "unmodeled-league bet awaiting human grading" is queryable apart from null/Unknown/garbage voids. 2026-06-16.
  'GRADE_MANUAL_REVIEW_MULTIPICK',   // gradePropWithAI DIVERTED a bet_type='straight' that is actually a multi-pick card (looksLikeMultiPickStraight: 2+ comma/list-separated segments each naming a subject + a market indicator, e.g. "Pistons/Magic UNDER 209.5, Rockets -3.5, Cavaliers -3.5" — live bet 9aa55f5b) to review_status='needs_review' instead of grading its FIRST market alone. The ingest parser mis-typed the card as one straight (legs never split), and the parlay completeness guard (parlayLegDataComplete) is scoped to parlay/sgp + counts `•` bullets, so a comma card slips past it. NO grade/profit written, result stays 'pending', sweeper-safe. Kill-switch MULTIPICK_STRAIGHT_GUARD=off. 2026-07-03.
  'GRADE_RECAP_MATCH_DEFERRED',      // T2-01: the scoped recap/graphic/celebration auto-grade matcher (services/grading.js autoGradeFromRecap) could NOT auto-grade — zero in-scope candidates, more than one in-scope candidate, a stale (>window) same-capper candidate, or an unresolvable capper — and deferred to human review instead of writing a terminal grade. Candidate bets (if any) are parked review_status='needs_review' and each parked bet gets one of these rows (betId set); a zero-candidate deferral writes a single betId-NULL row. payload: {source: 'graphic_auto'|'celebration', outcome, match_count, stale_count, subjects preview}. NOT a grade — no result/profit/bankroll write happens on this path.
  'GRADE_POST_GUARD_REJECTED',      // post-AI guard rejected verdict (hallucination, team/player mismatch, cross-sport)
  'GRADE_AI_NO_PROVIDERS',          // all AI providers failed or none configured
  'GRADE_PENDING_UNCLASSIFIED',     // wrapper catch-all — PENDING not matching known prefixes
  'GRADE_RESOLVER_PENDING',         // MLB StatsAPI resolver says game not yet Final
  'GRADE_PARLAY_LEGS_PENDING',      // parlay has unresolved legs, rescheduled for recheck
];

// ── Stage 2 idempotency (PIPELINE_IDEM_MODE) ────────────────
// Grading-side DROP rows can be written twice for the same logical
// event when the grader retries within one attempt (same bet, same
// grading_attempts, same stage/drop_reason), inflating drop
// analytics. A deterministic key makes such duplicates detectable
// (shadow) or rejectable (enforce, via migration 032's partial
// unique index). Repeats across attempts carry a different
// grading_attempts value → different key → always written.
//
// Strict string comparison, same tri-state idiom as OCR_FIRST_MODE /
// EVENT_AWARE_RECHECK. Read PER CALL (the eventAwareRecheckMode
// variant of the pattern, not OCR wiring's read-at-load) so ops can
// flip the flag without a restart and tests can toggle it per case.
// unset / anything-else → 'off' = no key computed, byte-identical
// current behavior.
function resolvePipelineIdemMode(raw = process.env.PIPELINE_IDEM_MODE) {
  if (raw === 'shadow') return 'shadow';
  if (raw === 'enforce') return 'enforce';
  return 'off';
}

// Pure, deterministic key derivation. Components:
//   betId       — parlay legs grade under synthetic `<parent>-leg<N>`
//                 ids (services/grading.js gradeParlay), so two legs
//                 of one parlay failing with the same reason in the
//                 same attempt stay DISTINCT keys.
//   attempts    — bets.grading_attempts read at write time (caller's
//                 job — services/bets.js). claimBetForGrading
//                 increments it once per grading attempt, so a
//                 legitimate repeat on a LATER attempt (e.g.
//                 GRADE_TOO_RECENT on attempt 3 and again on attempt
//                 4) gets a fresh key and survives.
//   stage / eventType / dropReason — the same bet+attempt dropping at
//                 a different stage or for a different reason is a
//                 different logical event.
// Returns null (→ no dedup, write as today) when any identifying
// component is missing — e.g. betId-NULL rows or a bet with no
// readable grading_attempts.
function deriveIdempotencyKey({ betId, attempts, stage, eventType, dropReason } = {}) {
  if (betId == null || String(betId).length === 0) return null;
  if (attempts == null || !Number.isFinite(Number(attempts))) return null;
  if (!stage || !eventType) return null;
  return [
    'gradv1',
    String(betId),
    String(Number(attempts)),
    String(stage),
    String(eventType),
    dropReason ? String(dropReason) : '',
  ].join('|');
}

// Shadow-mode duplicate probe: in shadow the idempotency_key COLUMN
// stays NULL (populating it would let migration 032's unique index
// reject the very duplicates shadow exists to measure), so the key
// rides the JSON payload ($.idem_key) and the probe json_extracts it.
// Bounded to recent rows of the same event_type so it rides
// idx_pipeline_events_event_type_created (mig 031) instead of a full
// table scan on the bot's event loop. 7 days matches the sweep
// horizon — a duplicate older than that is out of any retry window.
const IDEM_SHADOW_LOOKBACK_SECONDS = 7 * 24 * 3600;
let _shadowDupStmt = null;
function shadowDuplicateExists(eventType, key) {
  try {
    if (!_shadowDupStmt) {
      // json_valid guards json_extract: safeJson slices payloads at
      // 4000 chars, so a rare oversized payload is TRUNCATED (malformed
      // JSON) and json_extract would raise on it — killing the probe for
      // every row in the window, not just the broken one.
      _shadowDupStmt = db.prepare(`
        SELECT id FROM pipeline_events
         WHERE event_type = ?
           AND created_at >= ?
           AND json_valid(payload)
           AND json_extract(payload, '$.idem_key') = ?
         LIMIT 1
      `);
    }
    const cutoff = Math.floor(Date.now() / 1000) - IDEM_SHADOW_LOOKBACK_SECONDS;
    return !!_shadowDupStmt.get(String(eventType), cutoff, String(key));
  } catch (err) {
    // Probe failure must never affect the write — treat as "no duplicate".
    console.error(`[PipelineEvents] idem shadow probe error: ${err.message}`);
    return false;
  }
}

// Lazy-prepare the insert — avoids a stmt reference before the
// migrator has finished running on cold start.
//
// `created_at` is INTEGER unix-epoch seconds (migration 018). Schema
// has DEFAULT (strftime('%s','now')) so omitting the column also
// works, but we set it explicitly so:
//   1. value is visible in slow-query logs
//   2. behaviour does not silently change if the DEFAULT is altered
//   3. audit-rebuild scripts can replay rows with custom timestamps
//
// Diagnostic queries that read created_at MUST format it with
//   datetime(created_at, 'unixepoch')
// — bare `datetime(created_at)` returns NULL because SQLite reads
// the integer as a Julian-day number out of range.
//
// idempotency_key (migration 032) is bound NULL everywhere except a
// PIPELINE_IDEM_MODE=enforce grading-side DROP write.
let _insertStmt = null;
function getInsertStmt() {
  if (_insertStmt) return _insertStmt;
  _insertStmt = db.prepare(`
    INSERT INTO pipeline_events
      (ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return _insertStmt;
}

function safeJson(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload.slice(0, 4000);
  try {
    return JSON.stringify(payload).slice(0, 4000);
  } catch (_) {
    return null;
  }
}

// ── SOFT enum validation (F-05) ─────────────────────────────
// A warn-only tripwire at the single write boundary. If a caller
// emits a stage / event / drop / source value that isn't a
// registered enum member, log exactly one line per offending field
// and then write the row ANYWAY. This NEVER throws, NEVER skips the
// insert, and NEVER changes a caller's return value or the
// pipeline's control flow — registration (the lists above) is the
// real fix; this just surfaces the NEXT drift instead of letting it
// vanish into an unqueryable value. Mirrors the grading-side warn in
// services/bets.js transitionTo().
const ENUM_FIELDS = [
  ['sourceType', SOURCE_TYPES],
  ['stage', STAGES],
  ['eventType', EVENT_TYPES],
  ['dropReason', DROP_REASONS],
];

function warnUnknownEnums({ sourceType, stage, eventType, dropReason }, payload) {
  // Caller marker: most call sites tag payload.where (e.g. 'parseBetText',
  // 'flushBuffer') — surface it so a drift warn is attributable.
  const marker = payload && typeof payload === 'object' && typeof payload.where === 'string'
    ? payload.where
    : null;
  const values = { sourceType, stage, eventType, dropReason };
  for (const [field, list] of ENUM_FIELDS) {
    const value = values[field];
    if (value == null) continue;          // null/undefined is allowed (e.g. dropReason on a non-drop)
    if (list.includes(value)) continue;   // registered — stay quiet
    console.warn(
      `[PipelineEvents] enum drift: ${field}="${value}" not registered${marker ? ` (caller: ${marker})` : ''} — row written anyway; add it to services/pipeline-events.js`,
    );
  }
}

function writeRow({ ingestId, betId, sourceType, sourceRef, stage, eventType, dropReason, payload, idempotencyKey }) {
  try {
    // Grading-side writes don't have an ingest_id (bets enter grading
    // long after the original ingest flow completed). Ingest-side
    // callers still MUST supply ingestId — enforced by category check.
    if (!ingestId && sourceType !== 'grading') return;
    // SOFT validation (F-05): warn on enum drift, then fall through to
    // the insert. Isolated in its own try so a validation error can
    // never skip the write below.
    try {
      warnUnknownEnums({ sourceType, stage, eventType, dropReason }, payload);
    } catch (_) { /* validation must never affect the write */ }

    // ── Stage 2 idempotency (PIPELINE_IDEM_MODE) ────────────────
    // Callers that computed a key (services/bets.js — grading-side
    // DROPs only) pass it here; everyone else leaves it undefined and
    // this block is inert. Mode is re-read per write so a flag flip
    // between key computation and write degrades safely (worst case:
    // one un-deduped row, exactly today's behavior).
    let keyColumn = null;
    let effectivePayload = payload;
    const idemMode = idempotencyKey ? resolvePipelineIdemMode() : 'off';
    if (idemMode === 'shadow' || idemMode === 'enforce') {
      // idem fields go FIRST: safeJson slices the serialized payload at
      // 4000 chars, so trailing keys are the ones a huge payload would
      // truncate away — and the shadow probe needs $.idem_key intact.
      // (No grading call site passes a string payload, but degrade to
      // {text: …} rather than dropping it if one ever does.)
      const base = payload == null
        ? {}
        : (typeof payload === 'object' ? payload : { text: String(payload).slice(0, 3500) });
      if (idemMode === 'shadow') {
        // Column stays NULL in shadow — the key rides the payload so the
        // unique index cannot reject the duplicates we are measuring.
        const wouldReject = shadowDuplicateExists(eventType, idempotencyKey);
        effectivePayload = wouldReject
          ? { idem_key: idempotencyKey, idem_would_reject: true, ...base }
          : { idem_key: idempotencyKey, ...base };
        if (wouldReject) {
          console.log(`[PipelineEvents] idem shadow would-reject: key=${idempotencyKey} (row written anyway)`);
        }
      } else {
        keyColumn = String(idempotencyKey);
        // Mirror the key into the payload so shadow-era and enforce-era
        // rows answer the same json_extract query.
        effectivePayload = { idem_key: idempotencyKey, ...base };
      }
    }

    const stmt = getInsertStmt();
    try {
      stmt.run(
        ingestId != null ? String(ingestId) : null,
        betId ? String(betId) : null,
        String(sourceType || 'manual'),
        sourceRef != null ? String(sourceRef) : null,
        String(stage),
        String(eventType),
        dropReason ? String(dropReason) : null,
        safeJson(effectivePayload),
        Math.floor(Date.now() / 1000),
        keyColumn,
      );
    } catch (err) {
      // enforce: a duplicate insert trips migration 032's partial
      // unique index — that is the designed rejection, logged and
      // swallowed, NEVER thrown (fire-and-forget contract).
      if (keyColumn && /UNIQUE constraint failed: pipeline_events\.idempotency_key/.test(err.message || '')) {
        console.log(`[PipelineEvents] idem enforce rejected duplicate: key=${keyColumn}`);
        return;
      }
      throw err; // any other error → the existing outer catch/log below
    }
  } catch (err) {
    console.error(`[PipelineEvents] write error: ${err.message}`);
  }
}

/**
 * Record a stage transition (enter or exit).
 * Fire-and-forget — errors are logged but never thrown.
 */
function recordStage({ ingestId, betId, sourceType, sourceRef, stage, eventType, payload } = {}) {
  writeRow({
    ingestId,
    betId,
    sourceType,
    sourceRef,
    stage,
    eventType: eventType || 'STAGE_ENTER',
    dropReason: null,
    payload,
  });
}

/**
 * Record a drop. The ONLY acceptable way to silently exit the
 * pipeline — every silent `return null` / bare `return` in the
 * ingest paths must be replaced with a call to this.
 */
function recordDrop({ ingestId, betId, sourceType, sourceRef, stage, dropReason, payload } = {}) {
  writeRow({
    ingestId,
    betId,
    sourceType,
    sourceRef,
    stage: stage || 'DROPPED',
    eventType: 'DROP',
    dropReason: dropReason || 'BOUNCER_REJECTED',
    payload,
  });
}

/**
 * Record an unexpected exception caught inside the pipeline.
 */
function recordError({ ingestId, betId, sourceType, sourceRef, stage, error, payload } = {}) {
  let combined = payload;
  if (error) {
    const errInfo = {
      name: error.name || 'Error',
      message: (error.message || String(error)).slice(0, 500),
    };
    combined = payload && typeof payload === 'object'
      ? { ...payload, error: errInfo }
      : { error: errInfo };
  }
  writeRow({
    ingestId,
    betId,
    sourceType,
    sourceRef,
    stage: stage || 'ERROR',
    eventType: 'ERROR',
    dropReason: 'EXCEPTION_THROWN',
    payload: combined,
  });
}

/**
 * Generate a canonical ingest id for a source_ref pair.
 *   makeIngestId('discord', '12345')  → 'disc_12345'
 *   makeIngestId('twitter', '67890')  → 'twit_67890'
 *   makeIngestId('webhook', payload)  → 'webhook_<sha256-prefix>'
 *   makeIngestId('manual')            → 'manual_<random>'
 */
function makeIngestId(sourceType, sourceRef) {
  const type = String(sourceType || 'manual').toLowerCase();
  if (type === 'discord') return `disc_${sourceRef || crypto.randomUUID()}`;
  if (type === 'twitter') return `twit_${sourceRef || crypto.randomUUID()}`;
  if (type === 'webhook') {
    const seed = sourceRef == null ? crypto.randomUUID() : String(sourceRef);
    const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
    return `webhook_${hash}`;
  }
  return `manual_${sourceRef || crypto.randomUUID()}`;
}

module.exports = {
  recordStage,
  recordDrop,
  recordError,
  makeIngestId,
  writeRow,
  resolvePipelineIdemMode,
  deriveIdempotencyKey,
  SOURCE_TYPES,
  STAGES,
  EVENT_TYPES,
  DROP_REASONS,
};
