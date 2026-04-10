-- Ladder Challenge tracking (e.g., Cody's $25 → $1000 challenge)
ALTER TABLE bets ADD COLUMN is_ladder INTEGER DEFAULT 0;
ALTER TABLE bets ADD COLUMN ladder_step INTEGER DEFAULT 0;
