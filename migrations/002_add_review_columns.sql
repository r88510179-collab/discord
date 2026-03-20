-- 002_add_review_columns.sql
-- Add review_status column to bets table for confidence-gated manual review.
-- Uses a safe check so this is a no-op if the column already exists.

-- SQLite does not support IF NOT EXISTS for ALTER TABLE, so we rely on the
-- migrator executing this file only once. For safety on legacy databases that
-- already have the column from the old ad-hoc migration, we wrap in a
-- transaction and catch the "duplicate column" error at the runner level.

ALTER TABLE bets ADD COLUMN review_status TEXT DEFAULT 'confirmed';
