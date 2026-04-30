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
  // Grading-side stages (added alongside BetService skeleton — migration 020)
  'GRADING_ENTER',
  'GRADING_SEARCH',
  'GRADING_AI',
  'GRADING_GUARDS',
  'GRADING_COMPLETE',
  'GRADING_DROPPED',
];
const EVENT_TYPES = ['STAGE_ENTER', 'STAGE_EXIT', 'DROP', 'ERROR'];
const DROP_REASONS = [
  'DUPLICATE_IMAGE',
  'AGE_GATE',
  'PRE_FILTER_NO_BET_CONTENT',
  'PRE_FILTER_PROMO',
  'BOUNCER_REJECTED',
  'VISION_EXTRACTION_FAILED',
  'PARSER_NO_LEGS',
  'VALIDATOR_SPORT_MISMATCH',
  'VALIDATOR_ENTITY_MISMATCH',
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
  'GRADE_POST_GUARD_REJECTED',      // post-AI guard rejected verdict (hallucination, team/player mismatch, cross-sport)
  'GRADE_AI_NO_PROVIDERS',          // all AI providers failed or none configured
  'GRADE_PENDING_UNCLASSIFIED',     // wrapper catch-all — PENDING not matching known prefixes
  'GRADE_RESOLVER_PENDING',         // MLB StatsAPI resolver says game not yet Final
  'GRADE_PARLAY_LEGS_PENDING',      // parlay has unresolved legs, rescheduled for recheck
];

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
let _insertStmt = null;
function getInsertStmt() {
  if (_insertStmt) return _insertStmt;
  _insertStmt = db.prepare(`
    INSERT INTO pipeline_events
      (ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function writeRow({ ingestId, betId, sourceType, sourceRef, stage, eventType, dropReason, payload }) {
  try {
    // Grading-side writes don't have an ingest_id (bets enter grading
    // long after the original ingest flow completed). Ingest-side
    // callers still MUST supply ingestId — enforced by category check.
    if (!ingestId && sourceType !== 'grading') return;
    const stmt = getInsertStmt();
    stmt.run(
      ingestId != null ? String(ingestId) : null,
      betId ? String(betId) : null,
      String(sourceType || 'manual'),
      sourceRef != null ? String(sourceRef) : null,
      String(stage),
      String(eventType),
      dropReason ? String(dropReason) : null,
      safeJson(payload),
      Math.floor(Date.now() / 1000),
    );
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
  SOURCE_TYPES,
  STAGES,
  EVENT_TYPES,
  DROP_REASONS,
};
