# End-of-day comprehensive audit

Date: 2026-04-07 (UTC)

## 🚨 Critical

1. **Dashboard routing policy is not currently enforceable as requested.**
   - Multiple code paths still call `.send()` to `DASHBOARD_CHANNEL_ID` (daily recap, grade summary, grade ticker, manual posts), not just scoreboard `.edit()` flows.
   - This means the policy "nothing posts to DASHBOARD except scoreboard edits" is currently violated by design.

2. **Requested slip-feed lifecycle state (`slipfeed_message_id`) does not exist in schema or code.**
   - No `slipfeed_message_id` field/table logic was found.
   - Lifecycle checks (set on post, clear on delete/tail/fade, stale repost sync) cannot be validated because the underlying primitive is missing.

3. **Bet creation dedup is inconsistent across creation paths.**
   - Fingerprint dedup in `services/database.js` requires `source_message_id` (or explicit `fingerprint`).
   - Some creation paths previously omitted `source_message_id`, causing dedup bypass.
   - **Safe fix applied:** Twitter poller and Twitter webhook now store `source_message_id` using tweet IDs and a stable source channel key.
   - Remaining risk: manual/slash paths still rely primarily on fuzzy duplicate checks rather than a canonical cross-path fingerprint strategy.

4. **Cron inventory mismatch with requested 8 jobs.**
   - Runtime schedule currently defines 5 jobs in `bot.js`:
     - auto-grade
     - twitter poller
     - daily leaderboard
     - daily recap
     - nightly purge
   - Requested jobs not found in current scheduler wiring: dedicated scoreboard refresh, stale repost, health report.

## ⚠️ Warning

1. **Cron overlap protection was missing globally.**
   - **Safe fix applied:** Added in-flight lock wrapper (`runWithCronLock`) and applied it to all scheduled jobs in `bot.js`.

2. **Button coverage differs from requested prefixes (`warroom:`, `slipfeed:`, `grade:`, `ladder:`).**
   - Current patterns use `war_*` and `grade_*`.
   - No `slipfeed:` / `ladder:` handler family exists.
   - **Safe fix applied:** Added graceful fallback response for unmatched button/modal interactions to avoid silent failures.

3. **AI bouncer false-positive rate could not be computed in this environment.**
   - No readable SQLite DB with bet rows was present at audit time, so a “last 100 bets” false-positive metric could not be measured from production-like data.
   - Proposed prompt tightening:
     - hard reject recap/result language unless an explicit forward-looking wager is present,
     - reject promotional/stream/link-only posts,
     - require at least one concrete wager primitive (market + selection + line/odds/units).

4. **Twitter pipeline audit logging (`twitter_audit_log`) is not implemented.**
   - No table or write-paths found for requested stage-by-stage audit events.

## ℹ️ Info

1. **Migration system is ordered and idempotent for existing files.**
   - Current repository has migrations `001` to `006`, applied in lexical order and tracked by `schema_migrations`.
   - Requested `001-010` does not match repository state.

2. **Service test coverage gaps identified (no direct test files):**
   - `services/grading.js`
   - `services/odds.js`
   - `services/bankroll.js`
   - **Safe fix applied:** Added stub tests for these three critical services.

3. **Memory growth quick audit:**
   - Message dedup and buffer maps have timeout cleanup paths.
   - No `setInterval` leaks found in core runtime file.
   - No obvious forever-growing in-memory cache introduced by this change.

4. **Secrets audit quick pass:**
   - No hardcoded live API tokens found in source files.
   - Credentials are sourced from environment variables.

## Safe fixes applied in this PR

1. Added cron overlap lock guard and wired all scheduled jobs in `bot.js`.
2. Added graceful fallback for unmatched interaction custom IDs in `bot.js`.
3. Wrapped dashboard post in grade button handler with local try/catch.
4. Added `source_message_id` + stable source channel key on:
   - Twitter poller bet creation
   - Webhook tweet bet creation
5. Added stub tests:
   - `tests/grading-service.stub.js`
   - `tests/odds-service.stub.js`
   - `tests/bankroll-service.stub.js`
