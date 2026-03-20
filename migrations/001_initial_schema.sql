-- 001_initial_schema.sql
-- Core tables for BetTracker Pro

CREATE TABLE IF NOT EXISTS cappers (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  discord_id    TEXT UNIQUE,
  twitter_handle TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bets (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  capper_id     TEXT REFERENCES cappers(id) ON DELETE CASCADE,
  sport         TEXT NOT NULL DEFAULT 'Unknown',
  league        TEXT,
  bet_type      TEXT NOT NULL DEFAULT 'straight',
  description   TEXT NOT NULL,
  odds          INTEGER,
  units         REAL DEFAULT 1.0,
  result        TEXT DEFAULT 'pending',
  profit_units  REAL DEFAULT 0,
  grade         TEXT,
  grade_reason  TEXT,
  event_date    TEXT,
  graded_at     TEXT,
  source        TEXT DEFAULT 'manual',
  source_url    TEXT,
  source_channel_id TEXT,
  source_message_id TEXT,
  fingerprint   TEXT,
  raw_text      TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parlay_legs (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bet_id        TEXT REFERENCES bets(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  odds          INTEGER,
  result        TEXT DEFAULT 'pending',
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bankrolls (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  capper_id     TEXT UNIQUE REFERENCES cappers(id) ON DELETE CASCADE,
  starting      REAL NOT NULL DEFAULT 1000,
  current       REAL NOT NULL DEFAULT 1000,
  unit_size     REAL NOT NULL DEFAULT 25,
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracked_twitter (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  twitter_handle  TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  last_tweet_id   TEXT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  active          INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  capper_id     TEXT REFERENCES cappers(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  total_bets    INTEGER DEFAULT 0,
  wins          INTEGER DEFAULT 0,
  losses        INTEGER DEFAULT 0,
  pushes        INTEGER DEFAULT 0,
  profit_units  REAL DEFAULT 0,
  bankroll      REAL,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(capper_id, date)
);

CREATE INDEX IF NOT EXISTS idx_bets_capper     ON bets(capper_id);
CREATE INDEX IF NOT EXISTS idx_bets_result     ON bets(result);
CREATE INDEX IF NOT EXISTS idx_bets_created    ON bets(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_sport      ON bets(sport);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_fingerprint_unique ON bets(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_snapshots_date  ON daily_snapshots(capper_id, date);

CREATE TABLE IF NOT EXISTS scan_state (
  channel_id    TEXT PRIMARY KEY,
  last_message_id TEXT NOT NULL,
  updated_at    TEXT DEFAULT (datetime('now'))
);
