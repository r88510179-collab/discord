-- ═══════════════════════════════════════════════════════════
-- Migration 032: pipeline_events.idempotency_key
--
-- BetService Stage 2 — observability-write dedup for GRADING-side
-- pipeline_events rows (source_type='grading', routed through
-- services/bets.js transitionTo/recordDrop). Grader retries can
-- write duplicate DROP rows for the same logical event (same bet,
-- same grading attempt, same stage/drop_reason), inflating drop
-- analytics. Legitimate repeats across attempts carry a different
-- grading_attempts value and therefore a different key.
--
--   idempotency_key : deterministic string derived from
--                     (bet_id, grading_attempts at write time,
--                      stage, event_type, drop_reason || '') —
--                     see deriveIdempotencyKey in
--                     services/pipeline-events.js. Populated ONLY
--                     in PIPELINE_IDEM_MODE=enforce; stays NULL in
--                     off AND shadow (shadow stores the key inside
--                     the JSON payload instead, so the unique index
--                     cannot reject the very duplicates shadow
--                     exists to measure). NULL for every ingest-side
--                     row and every pre-existing row.
--
-- The partial unique index only constrains non-NULL keys, so this is
-- purely additive on the production DB: existing rows (all NULL) and
-- all off/shadow-mode writes are untouched. pipeline_events.created_at
-- stays INTEGER unix-epoch seconds with its existing default — this
-- migration does not touch it.
--
-- NOT the same mechanism as Gate 2 grade idempotency (migration 026,
-- bets.grader_version + bets.evidence_hash) — that dedups FINAL GRADE
-- writes; this dedups observability rows only.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE pipeline_events ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_idem_key
  ON pipeline_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
