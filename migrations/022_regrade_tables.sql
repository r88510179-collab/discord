-- ═══════════════════════════════════════════════════════════
-- Migration 022: regrade infrastructure
-- Tables backing the Grading Reconciliation Project — an
-- all-time regrade of graded bets (result IN win/loss/push/void)
-- by Claude + ChatGPT via manual web sessions. See the
-- "Grading Reconciliation Project" section of docs/BACKLOG.md
-- for the full spec.
--
-- Three tables:
--   regrade_results      — one row per (bet_id, model); holds
--                          each LLM's verdict, evidence trail,
--                          and pile-flag reasoning. v1 stays in
--                          `bets`; v2/v3 land here.
--   bet_grade_history    — archives a bet's v1 state before any
--                          future promote script overwrites it.
--                          Write-only log; never read by grader.
--   regrade_batches      — batch progress ledger: populated by
--                          the export script, updated by the
--                          (future) import script.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS regrade_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id TEXT NOT NULL,
  model TEXT NOT NULL CHECK (model IN ('claude', 'chatgpt')),
  batch_id TEXT NOT NULL,
  result_v2 TEXT CHECK (result_v2 IN ('win', 'loss', 'push', 'void', 'unknown') OR result_v2 IS NULL),
  profit_units_v2 REAL,
  grade_reason_v2 TEXT,
  evidence_url TEXT,
  evidence_source TEXT,
  evidence_quote TEXT,
  pile_flag INTEGER NOT NULL DEFAULT 0,
  pile_reasons TEXT,
  regraded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bet_id, model)
);

CREATE INDEX IF NOT EXISTS idx_regrade_results_bet ON regrade_results(bet_id);
CREATE INDEX IF NOT EXISTS idx_regrade_results_batch ON regrade_results(batch_id);
CREATE INDEX IF NOT EXISTS idx_regrade_results_pile ON regrade_results(pile_flag) WHERE pile_flag = 1;

CREATE TABLE IF NOT EXISTS bet_grade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id TEXT NOT NULL,
  old_result TEXT,
  old_profit_units REAL,
  old_grade TEXT,
  old_grade_reason TEXT,
  old_graded_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_by TEXT NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_bet_grade_history_bet ON bet_grade_history(bet_id);
CREATE INDEX IF NOT EXISTS idx_bet_grade_history_time ON bet_grade_history(archived_at);

CREATE TABLE IF NOT EXISTS regrade_batches (
  batch_id TEXT PRIMARY KEY,
  bet_count INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  exported_at TEXT NOT NULL DEFAULT (datetime('now')),
  claude_imported_at TEXT,
  chatgpt_imported_at TEXT,
  notes TEXT
);
