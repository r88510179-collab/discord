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
// Stage 2 — idempotency keys (this module + pipeline-events.js):
// DROP writes carry a deterministic key derived from
// (bet_id, grading_attempts at write time, stage, event_type,
// drop_reason) behind PIPELINE_IDEM_MODE (off|shadow|enforce,
// unset → off). Remaining Stage 2 items (reaper, call-site
// conversion) are still separate deploys.
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

// ── Stage 2 idempotency: grading_attempts read at write time ──
// bets PK is `id` (not `bet_id`). Parlay legs grade under synthetic
// `<parent>-leg<N>` ids (services/grading.js gradeParlay) that have
// no bets row — the PARENT's grading_attempts is the attempt counter
// for the whole grading pass (claimBetForGrading increments it once
// per claim), so strip the suffix and read the parent. The FULL leg
// id still goes into the key, keeping sibling legs distinct. Returns
// null when no row is found either way → key skipped → the write
// behaves exactly as before (no dedup). Never throws.
let _attemptsStmt = null;
function readGradingAttemptsForKey(betId) {
  try {
    if (!_attemptsStmt) {
      _attemptsStmt = db.prepare('SELECT grading_attempts FROM bets WHERE id = ?');
    }
    let row = _attemptsStmt.get(String(betId));
    if (!row) {
      const legMatch = String(betId).match(/^(.+)-leg\d+$/);
      if (legMatch) row = _attemptsStmt.get(legMatch[1]);
    }
    if (!row) return null;
    return row.grading_attempts == null ? 0 : Number(row.grading_attempts);
  } catch (err) {
    console.error(`[BetService] grading_attempts read error (bet=${String(betId).slice(0, 8)}): ${err.message}`);
    return null;
  }
}

// Compute the idempotency key for a grading-side write, or null.
// DROP events ONLY (deliberate — see the call-site survey in PR):
// non-DROP grading-side writes are per-decision telemetry where
// same-attempt repeats are the signal, not noise — event_aware_shadow
// fires once per cron poll on the PRE-claim path (grading_attempts
// unchanged between polls), so keying it would collapse the
// poll-frequency measurement to one row per attempt. Drop analytics
// (GET /api/admin/drops) reads event_type='DROP' rows, which is
// exactly the inflated population this dedups. Never throws.
function computeGradingIdemKey({ betId, stage, eventType, dropReason }) {
  try {
    if (eventType !== 'DROP') return null;
    if (pipelineEvents.resolvePipelineIdemMode() === 'off') return null; // off: key not computed at all
    const attempts = readGradingAttemptsForKey(betId);
    if (attempts == null) return null;
    return pipelineEvents.deriveIdempotencyKey({ betId, attempts, stage, eventType, dropReason });
  } catch (err) {
    console.error(`[BetService] idem key computation error (bet=${String(betId).slice(0, 8)}): ${err.message}`);
    return null;
  }
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
      // Stage 2 idempotency: non-null only for a DROP with a readable
      // grading_attempts while PIPELINE_IDEM_MODE != off. writeRow owns
      // the mode-dependent behavior (shadow: payload marker, column
      // NULL; enforce: column populated, duplicate silently rejected).
      idempotencyKey: computeGradingIdemKey({
        betId,
        stage: effectiveStage,
        eventType: effectiveEventType,
        dropReason: dropReason || null,
      }),
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
  // Stage 2 idempotency — exported for unit tests.
  computeGradingIdemKey,
  readGradingAttemptsForKey,
  STAGES,
  EVENT_TYPES,
  DROP_REASONS,
};
