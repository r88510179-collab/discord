-- 003_add_settings_table.sql
-- Add settings table for admin toggles (audit mode, etc.)

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_mode', 'on');
