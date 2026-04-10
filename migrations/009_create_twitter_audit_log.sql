CREATE TABLE IF NOT EXISTS twitter_audit_log (
  id TEXT PRIMARY KEY,
  tweet_id TEXT,
  handle TEXT,
  tweet_text TEXT,
  tweet_url TEXT,
  has_media INTEGER DEFAULT 0,
  posted_at TEXT,
  stage TEXT,
  reason TEXT,
  bet_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_twitter_audit_handle ON twitter_audit_log(handle);
CREATE INDEX IF NOT EXISTS idx_twitter_audit_stage ON twitter_audit_log(stage);
CREATE INDEX IF NOT EXISTS idx_twitter_audit_created ON twitter_audit_log(created_at);
