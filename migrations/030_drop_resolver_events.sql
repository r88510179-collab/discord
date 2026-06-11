-- ═══════════════════════════════════════════════════════════
-- Migration 030: drop the orphaned resolver_events table
--
-- zonetracker-resolver was removed in #76: the Fly app was destroyed,
-- the RESOLVER_URL/RESOLVER_VERSION env vars were stripped from fly.toml,
-- and services/resolver.js (+ resolverStatMap.js) were deleted. The table
-- created by migration 019 has had no writers since — the /admin snapshot
-- Resolver panel and resolver-health command that read it are also gone.
--
-- Nothing in services/, routes/, commands/, handlers/, bot.js, or scripts/
-- references resolver_events any longer (only 019 and docs mention it).
--
-- Idempotent via IF EXISTS; SQLite drops the table's indexes automatically.
-- ═══════════════════════════════════════════════════════════

DROP TABLE IF EXISTS resolver_events;
