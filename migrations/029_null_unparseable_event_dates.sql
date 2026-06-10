-- ═══════════════════════════════════════════════════════════
-- Migration 029: NULL out unparseable bets.event_date values
--
-- bets.event_date used to store whatever string the extractor emitted.
-- Time-only values ("9:10PM ET", "3:00 PM ET" — live specimen
-- 3a503cc44717e1f0c93e0385a4a0f532) poison the grader's age gate: the
-- read-side normalizer re-anchors a time-only string to "today" on every
-- poll, so the bet reads "too soon to grade" forever and burns attempts
-- to quarantine.
--
-- Write paths are now gated by normalizeEventDateForStorage
-- (services/eventDate.js), which enforces the hard rule: event_date is
-- NULL or a parseable datetime. This migration applies the same rule to
-- existing rows. datetime() returns NULL for anything that isn't a
-- SQLite-parseable datetime (ISO-8601 with T/Z included), so time-only
-- and free-text junk gets nulled while real datetimes are untouched.
-- The grader already falls back to created_at when event_date is NULL.
-- ═══════════════════════════════════════════════════════════

UPDATE bets
SET event_date = NULL
WHERE event_date IS NOT NULL
  AND datetime(event_date) IS NULL;
