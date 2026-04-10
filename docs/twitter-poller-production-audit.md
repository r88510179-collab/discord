# Twitter Polling Engine Production Audit (agent-twitter-client)

Date: 2026-04-03
Scope: `services/twitter.js` polling worker and related scheduler/database integration in `bot.js` + `services/database.js`.

## Executive Summary

The current implementation is **functionally simple but not production-safe yet** for Fly.io always-on deployment. The most critical gaps are:

1. **No overlap lock** on scheduled polls (`cron.schedule`) — concurrent poll runs can overlap if one run is slow.
2. **No explicit AI throttle delay** between tweet analyses — sequential today, but bursts can still trip model/provider limits.
3. **No retention cleanup** for `processed_tweets` — table will grow indefinitely.
4. **No fatal auth escalation path** — cookie/login/auth lockouts are logged but not escalated or paused.

## Findings by Requested Edge Case

### 1) Overlap Prevention (Concurrency)

**Question:** If polling takes longer than the interval, do we block a second run?

- Scheduler runs every 10 minutes via `cron.schedule('*/10 * * * *', ...)`.
- There is **no `pollInFlight` flag** (or mutex/lock/queue) in `bot.js` or `services/twitter.js`.
- If one run hangs/extends past the next tick, another run can start and duplicate work/AI calls.

**Risk:** Duplicate ingestion pressure, increased memory/CPU, elevated API/db contention.

**Status:** ❌ **Not protected**.

### 2) AI Rate Limit Protection (Throttling)

**Question:** Promise-all blast vs sequential with delay?

- Poller loops with `for (const { handle, name } of cappers)` and `for await (const tweet of tweets)`.
- Each tweet calls `await extractPickFromTweet(...)` inline.
- This is **sequential processing**, not `Promise.all` fan-out.
- However, there is **no explicit sleep/backoff gap** between successful calls.

**Risk:** A burst of many new tweets is still sent immediately one-after-another and can trigger provider-side 429s despite sequential awaits.

**Status:** ⚠️ **Partially safe** (sequential yes, explicit throttling no).

### 3) Database Bloat (`processed_tweets` retention)

**Question:** Is there cleanup for seen tweet IDs?

- `processed_tweets` table is created in `services/database.js` with `processed_at` timestamp.
- Poller inserts every processed tweet id.
- Daily purge job only removes old archived bets and orphan `user_bets`; it does **not** clean `processed_tweets`.

**Risk:** Unbounded growth over time, larger DB/VACUUM windows, backup/storage cost creep.

**Status:** ❌ **No cleanup implemented**.

### 4) Fatal Error Alerting (auth/cookie expiry)

**Question:** On auth failure, does worker pause and DM owner?

- `loginTwitter()` catches errors and logs `[Twitter] Login failed: ...`, then returns `false`.
- `pollCappers()` returns early when login fails.
- Per-handle scraping errors are caught and logged, then loop continues.
- No explicit detection of auth/cookie-locked states.
- No pause/suspend circuit breaker flag.
- No Discord DM/alert to `process.env.OWNER_ID`.

**Risk:** Silent degraded operation in production (no ingestion, no operator awareness).

**Status:** ❌ **Missing fatal alert + pause behavior**.

## Additional Operational Notes

- SQLite is configured with WAL and `busy_timeout`, which helps contention behavior but does not solve overlapping poll jobs by itself.
- Tweet IDs are marked as processed **before** AI extraction. This avoids duplicate retries, but it also means transient AI failures can permanently skip valid tweets unless recovery logic exists.

## Recommended Remediations (Narrow, Production-Safe)

1. Add `twitterPollInFlight` guard around scheduled invocation to skip overlapping ticks.
2. Add deterministic per-tweet delay (e.g., 2s) and configurable env (`TWITTER_AI_THROTTLE_MS`, default `2000`).
3. Add retention job for `processed_tweets` (e.g., keep 30 days) and run daily inside existing purge block.
4. Add auth error classifier + circuit breaker:
   - pause twitter polling after fatal auth errors,
   - send DM to owner (`OWNER_ID`) once per incident,
   - require manual `/admin` command or timed retry to re-enable.

## What Was Audited vs Not Audited

**Audited:**
- poll scheduling,
- in-worker tweet processing flow,
- processed tweet dedup storage,
- fatal error handling surfaces.

**Not audited in this pass:**
- external Fly.io machine scaling/runtime limits,
- Discord permission model for owner DM delivery,
- observability stack (metrics/alerts) outside repo code.
