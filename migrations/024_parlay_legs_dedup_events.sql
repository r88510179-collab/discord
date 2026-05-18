-- ═══════════════════════════════════════════════════════════
-- Migration 024: parlay_legs_dedup_events
--
-- Telemetry table for every dedup decision made by
-- dedupeParlayLegs (services/database.js). Powers the
-- /admin dedup-stats-24h subcommand and surfaces near-miss
-- variants (keys differing by ≤ 2 chars after normalization)
-- before they ship as the next Cat D failure mode.
--
-- created_at is Unix epoch seconds (INTEGER), matching the
-- pipeline_events convention.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS parlay_legs_dedup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id TEXT NOT NULL,
  ingest_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('kept', 'dropped_duplicate', 'near_miss')),
  original_text TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  matched_against_text TEXT,
  matched_against_key TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_parlay_legs_dedup_events_bet_id ON parlay_legs_dedup_events(bet_id);
CREATE INDEX IF NOT EXISTS idx_parlay_legs_dedup_events_created_at ON parlay_legs_dedup_events(created_at);
CREATE INDEX IF NOT EXISTS idx_parlay_legs_dedup_events_decision ON parlay_legs_dedup_events(decision);
