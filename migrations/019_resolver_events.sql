-- ═══════════════════════════════════════════════════════════
-- Migration 019: resolver_events
-- One row per invocation of the MLB StatsAPI resolver
-- (services/resolver.js → zonetracker-resolver). Captures
-- latency + outcome so /admin snapshot can surface real
-- resolver health instead of hope.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS resolver_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id TEXT NOT NULL,
  called_at INTEGER NOT NULL,         -- unix ms
  latency_ms INTEGER,                 -- null if call never completed
  outcome TEXT NOT NULL,              -- 'resolved' | 'unresolved' | 'error' | 'timeout'
  error_type TEXT,                    -- null unless outcome='error'; e.g. 'http_5xx', 'malformed_response', 'network'
  bet_type TEXT,                      -- 'moneyline' | 'spread' | 'total' | 'parlay_leg' | 'prop' | 'unknown'
  resolver_version TEXT               -- e.g. 'v10'
);

CREATE INDEX IF NOT EXISTS idx_resolver_events_called_at ON resolver_events(called_at);
CREATE INDEX IF NOT EXISTS idx_resolver_events_outcome ON resolver_events(outcome);
CREATE INDEX IF NOT EXISTS idx_resolver_events_bet_id ON resolver_events(bet_id);
