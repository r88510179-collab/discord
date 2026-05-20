-- ═══════════════════════════════════════════════════════════
-- Migration 025: hold_review_decisions
--
-- Human-in-the-loop learning capture for MANUAL_REVIEW_HOLD slips.
-- Every Release/Dismiss/Skip decision made by scripts/review-holds.js
-- writes a row here, including the parser's re-parse attempt against
-- the richest available content (Twitter embed body > message content
-- > image OCR fallback).
--
-- This is the training signal for a future smart-defaulting path in
-- services/holdReview.js: once enough decisions accumulate, the live
-- Release button can skip the manual modal when reparse_confidence is
-- 'parsed_clean' and historical acceptance rate is above threshold.
--
-- hold_payload is an audit-redundant copy of pipeline_events.payload at
-- hold time, because pipeline_events rows are purged on a 90-day window
-- and these decisions must outlive them.
--
-- created_at is Unix epoch seconds (INTEGER), matching the
-- pipeline_events convention (Math.floor(Date.now()/1000)).
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hold_review_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_id TEXT NOT NULL,
  hold_payload TEXT,
  reparse_attempted INTEGER NOT NULL DEFAULT 0,
  reparse_input_source TEXT,
  reparse_input_text TEXT,
  reparse_output TEXT,
  reparse_confidence TEXT,
  human_decision TEXT NOT NULL,
  human_edits TEXT,
  source_label TEXT,
  bet_id TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hrd_ingest_id ON hold_review_decisions(ingest_id);
CREATE INDEX IF NOT EXISTS idx_hrd_created_at ON hold_review_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_hrd_decision ON hold_review_decisions(human_decision);
CREATE INDEX IF NOT EXISTS idx_hrd_confidence ON hold_review_decisions(reparse_confidence);
