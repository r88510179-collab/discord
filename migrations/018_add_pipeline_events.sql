-- ═══════════════════════════════════════════════════════════
-- Migration 018: pipeline_events
-- Ingest-side observability. Every bet that enters the pipeline
-- (Discord/Twitter/webhook/manual) emits stage transitions and
-- explicit drop reasons so silent failures are no longer silent.
--
-- Complements grading_audit (migration 014), which handles the
-- post-bet-creation side.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_id TEXT NOT NULL,
  bet_id TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  drop_reason TEXT,
  payload TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_ingest ON pipeline_events(ingest_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_bet ON pipeline_events(bet_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_stage_type ON pipeline_events(stage, event_type);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_drop_reason ON pipeline_events(drop_reason, created_at) WHERE drop_reason IS NOT NULL;
