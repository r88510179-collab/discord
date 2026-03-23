-- 004_create_props_table.sql
-- Structured prop bets + wager/payout fields on bets

CREATE TABLE IF NOT EXISTS bet_props (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bet_id        TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  player_name   TEXT NOT NULL,
  stat_category TEXT NOT NULL,
  line          REAL NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('over', 'under')),
  odds          INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bet_props_bet_id ON bet_props(bet_id);

-- Add wager/payout columns to bets table
ALTER TABLE bets ADD COLUMN wager REAL;
ALTER TABLE bets ADD COLUMN payout REAL;
