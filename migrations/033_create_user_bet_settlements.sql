-- 033_create_user_bet_settlements.sql
-- Idempotent settlement ledger for community Tail/Fade positions.

CREATE TABLE IF NOT EXISTS user_bet_settlements (
  user_bet_id  INTEGER PRIMARY KEY,
  parent_result TEXT NOT NULL CHECK (parent_result IN ('win', 'loss', 'push', 'void')),
  profit_units REAL NOT NULL,
  settled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_bet_id) REFERENCES user_bets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_bet_settlements_result
  ON user_bet_settlements(parent_result);
