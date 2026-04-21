-- ═══════════════════════════════════════════════════════════
-- Migration 020: bets.drop_reason
-- Explicit drop-reason columns on the bets table. Grading-side
-- silent backoffs (AI PENDING no-data, resolver fall-through,
-- guard rejections) now stamp a canonical reason here instead
-- of leaving the bet in an unexplained pending state.
--
-- Complements migration 018 (pipeline_events) — the pipeline
-- row is the event log, bets.drop_reason is the current-state
-- snapshot for fast admin lookups.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE bets ADD COLUMN drop_reason TEXT;
ALTER TABLE bets ADD COLUMN drop_reason_set_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_bets_drop_reason ON bets(drop_reason);
