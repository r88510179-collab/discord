// ═══════════════════════════════════════════════════════════
// BetService — lifecycle transitions for a bet that already
// exists in the bets table.
//
// Stage 1 scope (this module): provide a single place to stamp
// an explicit drop_reason on a bet AND emit a matching
// pipeline_events row. Every silent-return path on the grading
// side is being migrated through recordDrop() so "the bet
// vanished into PENDING backoff" bugs become traceable.
//
// All writes are fire-and-forget: failures are logged but
// NEVER thrown up the call stack. Observability must not
// break the grading pipeline.
//
// Enum lists (STAGES/EVENT_TYPES/DROP_REASONS) are re-exported
// from pipeline-events so callers have one import surface.
//
// Stage 2 (separate deploy): idempotency keys + reaper +
// conversion of the remaining grading call sites.
// ═══════════════════════════════════════════════════════════

const { db } = require('./database');
const pipelineEvents = require('./pipeline-events');
const { STAGES, EVENT_TYPES, DROP_REASONS } = pipelineEvents;

// Lazy-prepare the drop-reason update — avoids a stmt reference
// before migration 020 has finished running on cold start.
let _dropStmt = null;
function getDropStmt() {
  if (_dropStmt) return _dropStmt;
  _dropStmt = db.prepare(`
    UPDATE bets
       SET drop_reason = ?, drop_reason_set_at = ?
     WHERE id = ?
  `);
  return _dropStmt;
}

function isKnownStage(stage) {
  return typeof stage === 'string' && STAGES.includes(stage);
}

function isKnownDropReason(reason) {
  return typeof reason === 'string' && DROP_REASONS.includes(reason);
}

/**
 * Generic lifecycle transition. Always writes one pipeline_events
 * row. If eventType is 'DROP' we also stamp bets.drop_reason.
 * Fire-and-forget — errors are logged, never thrown. Returns true
 * on success, false on failure.
 */
function transitionTo({ betId, toStage, eventType, dropReason, payload, ingestId } = {}) {
  if (!betId) {
    console.warn('[BetService] transitionTo called with no betId — skipping');
    return false;
  }

  if (toStage && !isKnownStage(toStage)) {
    console.warn(`[BetService] transitionTo: unknown stage "${toStage}" — writing anyway`);
  }

  const effectiveEventType = eventType || 'STAGE_ENTER';
  const effectiveStage = toStage || (effectiveEventType === 'DROP' ? 'GRADING_DROPPED' : 'GRADING_ENTER');
  // Grading-side writes have no ingest_id. Pipeline-events.js
  // relaxes its null guard for sourceType='grading'. Ingest-side
  // callers still pass ingestId through transitionTo if needed.
  const effectiveIngestId = ingestId || null;

  // ── Write 1: stamp bets.drop_reason when this is a DROP ─────
  if (effectiveEventType === 'DROP' && dropReason) {
    if (!isKnownDropReason(dropReason)) {
      console.warn(`[BetService] transitionTo: unknown dropReason "${dropReason}" — writing anyway`);
    }
    try {
      getDropStmt().run(String(dropReason), Math.floor(Date.now() / 1000), String(betId));
    } catch (err) {
      console.error(`[BetService] drop_reason update error (bet=${String(betId).slice(0, 8)}): ${err.message}`);
      // Fall through — still try to write the pipeline row.
    }
  }

  // ── Write 2: pipeline_events row ────────────────────────────
  try {
    pipelineEvents.writeRow({
      ingestId: effectiveIngestId,
      betId,
      sourceType: 'grading',
      sourceRef: null,
      stage: effectiveStage,
      eventType: effectiveEventType,
      dropReason: dropReason || null,
      payload,
    });
  } catch (err) {
    console.error(`[BetService] pipeline write error (bet=${String(betId).slice(0, 8)}): ${err.message}`);
    return false;
  }

  return true;
}

/**
 * Convenience wrapper for the most common case: recording a
 * silent drop. Stamps bets.drop_reason + writes a DROP row in
 * pipeline_events in one call. Never throws.
 * Returns true on success, false on failure.
 */
function recordDrop({ betId, stage, dropReason, payload, ingestId } = {}) {
  return transitionTo({
    betId,
    toStage: stage || 'GRADING_DROPPED',
    eventType: 'DROP',
    dropReason: dropReason || 'GRADE_EXCEPTION',
    payload,
    ingestId,
  });
}

/**
 * Read the current drop_reason for a bet. Returns null if the
 * bet doesn't exist or has no drop_reason set. Used by admin
 * tooling ( /admin snapshot, autopsy commands).
 */
function getDropReason(betId) {
  if (!betId) return null;
  try {
    const row = db.prepare(
      'SELECT drop_reason, drop_reason_set_at FROM bets WHERE id = ?'
    ).get(String(betId));
    if (!row || !row.drop_reason) return null;
    return { drop_reason: row.drop_reason, drop_reason_set_at: row.drop_reason_set_at };
  } catch (err) {
    console.error(`[BetService] getDropReason error: ${err.message}`);
    return null;
  }
}

module.exports = {
  transitionTo,
  recordDrop,
  getDropReason,
  STAGES,
  EVENT_TYPES,
  DROP_REASONS,
};
