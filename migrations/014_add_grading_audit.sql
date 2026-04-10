CREATE TABLE IF NOT EXISTS grading_audit (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL,
  attempt_num INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  sport_in TEXT,
  sport_out TEXT,
  reclassified INTEGER DEFAULT 0,
  is_parlay INTEGER DEFAULT 0,
  leg_index INTEGER,
  leg_count INTEGER,
  search_backend TEXT,
  search_query TEXT,
  search_hits INTEGER,
  search_duration_ms INTEGER,
  provider_used TEXT,
  raw_response TEXT,
  guards_passed TEXT,
  guards_failed TEXT,
  final_status TEXT,
  final_evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_grading_audit_bet ON grading_audit(bet_id);
CREATE INDEX IF NOT EXISTS idx_grading_audit_timestamp ON grading_audit(timestamp);
