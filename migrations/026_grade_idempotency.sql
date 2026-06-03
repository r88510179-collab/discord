-- ═══════════════════════════════════════════════════════════
-- Migration 026: Gate 2 — idempotent final-grade provenance.
--
-- Records WHICH evidence + grading-logic version produced a bet's final
-- grade. With these, a re-grade attempt carrying the same
-- (bet_id, evidence_hash, grader_version) is a no-op (return the stored
-- final) instead of a second write — closing the "contradictory regrade"
-- (WIN then LOSS minutes apart) bug.
--
--   grader_version : code constant (services/grading.js GRADER_VERSION),
--                    bumped manually when grading LOGIC changes. NOT tied
--                    to the Fly release.
--   evidence_hash  : sha256 of the canonicalized evidence text the grader
--                    used for that bet. Same inputs → same hash.
--
-- Idempotent ALTER TABLE — the migrator tolerates "duplicate column name"
-- (services/migrator.js), so re-running on a DB that already has the
-- columns is safe.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE bets ADD COLUMN grader_version TEXT;
ALTER TABLE bets ADD COLUMN evidence_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_bets_grade_idem
  ON bets (id, evidence_hash, grader_version);
