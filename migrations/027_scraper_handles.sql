-- ═══════════════════════════════════════════════════════════
-- Migration 027: scraper_handles
--
-- DB-driven account list for the Twitter scraper (Surface Pro
-- Playwright poller). Replaces a hardcoded const in the scraper
-- repo: the scraper polls GET /api/scraper-handles each cycle and
-- reads the enabled handles from this table.
--
-- This is the FLY side only (table + seed + read endpoint in
-- routes/api.js). The scraper repo is updated separately to
-- consume the endpoint.
--
-- added_at is Unix epoch seconds (INTEGER), matching the
-- pipeline_events convention (unixepoch() == seconds).
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scraper_handles (
  handle   TEXT PRIMARY KEY,
  enabled  INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  note     TEXT
);

-- Seed the current 9 handles. INSERT OR IGNORE keeps this idempotent
-- on every startup and preserves any later manual enabled/note edits
-- (the PRIMARY KEY on handle is the conflict target).
INSERT OR IGNORE INTO scraper_handles (handle, enabled) VALUES
  ('bobby__tracker',  1),
  ('bookitwithtrent', 1),
  ('capperledger',    1),
  ('deeplaysbets',    1),
  ('guess_pray_bets', 1),
  ('nrfianalytics',   1),
  ('rbssportsplays',  1),
  ('toptierpicks_',   1),
  ('zrob4444',        1);
