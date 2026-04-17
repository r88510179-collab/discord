-- Vision fallback debug trail.
-- When Gemini (or another vision provider) returns placeholder text or
-- empty extraction on a slip image, services/ai.js falls back to Gemma
-- 3:4b on the Surface Pro Ollama. Every stage of that chain — initial
-- Gemini response, Gemma raw output, Cerebras parse attempt — gets
-- logged here so we can diagnose misses without rerunning the tweet.
--
-- failure_stage values (strings, enforced in app code, no CHECK):
--   'gemma'           — Gemma call itself failed (timeout, HTTP error, empty)
--   'cerebras_parse'  — Gemma produced text but Cerebras could not parse legs
--   'final'           — whole chain ran but no usable bet was produced
CREATE TABLE IF NOT EXISTS vision_failures (
  id TEXT PRIMARY KEY,
  tweet_id TEXT,
  image_url TEXT,
  gemini_response TEXT,
  gemma_response TEXT,
  cerebras_response TEXT,
  failure_stage TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vision_failures_tweet ON vision_failures(tweet_id);
CREATE INDEX IF NOT EXISTS idx_vision_failures_created ON vision_failures(created_at);
