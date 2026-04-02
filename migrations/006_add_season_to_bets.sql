-- 006_add_season_to_bets.sql
-- Adds season scoping so leaderboard/stats can be filtered by ACTIVE_SEASON.

ALTER TABLE bets ADD COLUMN season TEXT NOT NULL DEFAULT 'Beta';

CREATE INDEX IF NOT EXISTS idx_bets_season ON bets(season);
