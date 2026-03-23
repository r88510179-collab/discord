-- Settings table for bot-wide configuration (e.g., audit mode)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default: audit mode ON (all bets need review before posting)
INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_mode', 'on');
