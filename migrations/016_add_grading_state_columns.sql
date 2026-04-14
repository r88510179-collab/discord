-- P0 Fix 1: grading state machine columns + queue index.
-- Schema changes only. Backfill runs outside the migration transaction
-- via a one-shot block in services/database.js, budgeted at 30s and
-- gated by settings.migration_016_backfill_done.
--
-- Policy for the new grading_state column:
--   'done'         → terminal (won/lost/pushed/voided/archived) OR not yet eligible
--   'ready'        → eligible for next grading cycle
--   'backoff'      → waiting until grading_next_attempt_at
--   'quarantined'  → attempts >= 20; requires admin intervention (/admin grading-unstick)
--
-- Enum enforced in application code (no CHECK constraint per deploy policy).

ALTER TABLE bets ADD COLUMN grading_attempts INTEGER DEFAULT 0;
ALTER TABLE bets ADD COLUMN grading_last_attempt_at TEXT DEFAULT NULL;
ALTER TABLE bets ADD COLUMN grading_next_attempt_at TEXT DEFAULT NULL;
ALTER TABLE bets ADD COLUMN grading_last_failure_reason TEXT DEFAULT NULL;
ALTER TABLE bets ADD COLUMN grading_lock_until TEXT DEFAULT NULL;
ALTER TABLE bets ADD COLUMN grading_state TEXT DEFAULT 'done';

CREATE INDEX IF NOT EXISTS idx_bets_grading_queue
  ON bets (result, review_status, grading_state, grading_next_attempt_at, grading_lock_until);
