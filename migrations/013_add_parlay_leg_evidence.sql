-- Per-leg grading evidence for parlay grading
ALTER TABLE parlay_legs ADD COLUMN evidence TEXT;
ALTER TABLE parlay_legs ADD COLUMN graded_at TEXT;
