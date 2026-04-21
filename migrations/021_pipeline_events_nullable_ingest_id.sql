-- ═══════════════════════════════════════════════════════════
-- Migration 021: relax pipeline_events.ingest_id to nullable
-- Stage 1 BetService polish — grading-side writes have no
-- ingest_id (bets enter grading long after the ingest flow
-- completes). Ingest-side callers still MUST supply ingest_id;
-- the app-layer guard in services/pipeline-events.js enforces
-- that constraint by source_type category.
--
-- SQLite can't drop NOT NULL in place, so we rebuild the table.
-- Non-ingest_id columns are copied verbatim from migration 018
-- (same types, same defaults, same nullability). The four
-- indexes are restored verbatim from 018 lines 24-27.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE pipeline_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_id TEXT,
  bet_id TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  drop_reason TEXT,
  payload TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

INSERT INTO pipeline_events_new (id, ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at)
SELECT id, ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at
FROM pipeline_events;

DROP TABLE pipeline_events;
ALTER TABLE pipeline_events_new RENAME TO pipeline_events;

CREATE INDEX IF NOT EXISTS idx_pipeline_events_ingest ON pipeline_events(ingest_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_bet ON pipeline_events(bet_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_stage_type ON pipeline_events(stage, event_type);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_drop_reason ON pipeline_events(drop_reason, created_at) WHERE drop_reason IS NOT NULL;
