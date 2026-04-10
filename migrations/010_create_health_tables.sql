CREATE TABLE IF NOT EXISTS bot_health_log (
  id TEXT PRIMARY KEY,
  report_type TEXT,
  section TEXT,
  metric TEXT,
  value REAL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_log_type ON bot_health_log(report_type);
CREATE INDEX IF NOT EXISTS idx_health_log_created ON bot_health_log(created_at);
