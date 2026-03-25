-- 005_create_user_bets_table.sql
-- Track user Tail/Fade actions on community bets

CREATE TABLE IF NOT EXISTS user_bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  bet_id     TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('tail', 'fade')),
  status     TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, bet_id)
);

CREATE INDEX IF NOT EXISTS idx_user_bets_user ON user_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_bets_bet  ON user_bets(bet_id);
