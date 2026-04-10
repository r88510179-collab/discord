-- Add season column to bets table for soft-reset leaderboards
-- Existing bets are tagged "Beta" by default.
ALTER TABLE bets ADD COLUMN season TEXT NOT NULL DEFAULT 'Beta';

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_bets_season ON bets (season);
CREATE INDEX IF NOT EXISTS idx_bets_capper_result ON bets (capper_id, result);
CREATE INDEX IF NOT EXISTS idx_bets_capper_season ON bets (capper_id, season);
