-- ╔═══════════════════════════════════════════════════════════╗
-- ║  ZoneTracker Discord — Supabase Schema                    ║
-- ║  Run this in Supabase SQL Editor to set up your database  ║
-- ╚═══════════════════════════════════════════════════════════╝

-- ── Cappers (anyone who posts picks) ────────────────────────
CREATE TABLE IF NOT EXISTS cappers (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  discord_id    TEXT UNIQUE,
  twitter_handle TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bets ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  capper_id     UUID REFERENCES cappers(id) ON DELETE CASCADE,
  sport         TEXT NOT NULL DEFAULT 'Unknown',
  league        TEXT,
  bet_type      TEXT NOT NULL DEFAULT 'straight',  -- straight, parlay, teaser, prop
  description   TEXT NOT NULL,
  odds          INTEGER,                            -- American odds e.g. -110, +150
  units         NUMERIC(6,2) DEFAULT 1.0,
  result        TEXT DEFAULT 'pending',             -- pending, win, loss, push, void
  profit_units  NUMERIC(8,2) DEFAULT 0,
  grade         TEXT,                               -- A+, A, B, C, D, F (AI-assigned)
  grade_reason  TEXT,
  event_date    DATE,
  graded_at     TIMESTAMPTZ,
  source        TEXT DEFAULT 'manual',              -- manual, slip, twitter, discord
  source_url    TEXT,
  raw_text      TEXT,                               -- original parsed text
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Parlays (legs of a parlay bet) ──────────────────────────
CREATE TABLE IF NOT EXISTS parlay_legs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  bet_id        UUID REFERENCES bets(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  odds          INTEGER,
  result        TEXT DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bankrolls ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bankrolls (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  capper_id     UUID REFERENCES cappers(id) ON DELETE CASCADE,
  starting      NUMERIC(12,2) NOT NULL DEFAULT 1000,
  current       NUMERIC(12,2) NOT NULL DEFAULT 1000,
  unit_size     NUMERIC(8,2) NOT NULL DEFAULT 25,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Twitter Tracked Accounts ────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_twitter (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  twitter_handle  TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  last_tweet_id   TEXT,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Daily Snapshots (for charts / trends) ───────────────────
CREATE TABLE IF NOT EXISTS daily_snapshots (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  capper_id     UUID REFERENCES cappers(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  total_bets    INTEGER DEFAULT 0,
  wins          INTEGER DEFAULT 0,
  losses        INTEGER DEFAULT 0,
  pushes        INTEGER DEFAULT 0,
  profit_units  NUMERIC(8,2) DEFAULT 0,
  bankroll      NUMERIC(12,2),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(capper_id, date)
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bets_capper     ON bets(capper_id);
CREATE INDEX IF NOT EXISTS idx_bets_result     ON bets(result);
CREATE INDEX IF NOT EXISTS idx_bets_created    ON bets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_sport      ON bets(sport);
CREATE INDEX IF NOT EXISTS idx_snapshots_date  ON daily_snapshots(capper_id, date DESC);

-- ── Views ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW capper_stats AS
SELECT
  c.id,
  c.display_name,
  c.discord_id,
  COUNT(b.id)                                           AS total_bets,
  COUNT(*) FILTER (WHERE b.result = 'win')              AS wins,
  COUNT(*) FILTER (WHERE b.result = 'loss')             AS losses,
  COUNT(*) FILTER (WHERE b.result = 'push')             AS pushes,
  COUNT(*) FILTER (WHERE b.result = 'pending')          AS pending,
  ROUND(
    COUNT(*) FILTER (WHERE b.result = 'win')::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE b.result IN ('win','loss')), 0) * 100, 1
  )                                                     AS win_pct,
  COALESCE(SUM(b.profit_units), 0)                      AS total_profit_units,
  ROUND(
    COALESCE(SUM(b.profit_units), 0) /
    NULLIF(SUM(b.units) FILTER (WHERE b.result IN ('win','loss')), 0) * 100, 1
  )                                                     AS roi_pct,
  MAX(b.created_at)                                     AS last_bet_at
FROM cappers c
LEFT JOIN bets b ON b.capper_id = c.id
GROUP BY c.id, c.display_name, c.discord_id;
