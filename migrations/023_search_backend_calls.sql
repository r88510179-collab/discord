CREATE TABLE IF NOT EXISTS search_backend_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  backend TEXT NOT NULL,
  status TEXT NOT NULL,
  http_code INTEGER,
  bet_id TEXT,
  latency_ms INTEGER,
  hits INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sbc_ts ON search_backend_calls(ts);
CREATE INDEX IF NOT EXISTS idx_sbc_backend_status ON search_backend_calls(backend, status);
