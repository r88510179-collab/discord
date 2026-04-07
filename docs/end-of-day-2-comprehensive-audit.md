# End-of-day-2 comprehensive audit

Date: 2026-04-07 (UTC)

## 🚨 Critical

1. **Requested ingestion/bouncer topology does not exist in this repo shape.**
   - `services/twitter-handler.js` and `routes/api.js` are not present.
   - No `evaluateTweet()` symbol exists; current entrypoints use `extractPickFromTweet()` and `parseBetText()`.
   - Result: we cannot confirm the exact "3 ingestion paths call evaluateTweet" contract because that contract is not implemented in current code.

2. **Migration 011 contract is not implemented.**
   - Migrations on disk stop at `006_add_season_to_bets.sql`.
   - `bets` schema has no `source_tweet_id` / `source_tweet_handle` columns.
   - All bet inserts therefore cannot populate those fields because they do not exist.

3. **Dashboard routing policy still violated by design.**
   - Dashboard/public channel `.send()` still occurs in multiple paths (`services/dashboard.js`, `services/grading.js`, `bot.js` daily recap, `services/warRoom.js` approval publish path).
   - This violates the target "NO sends to DASHBOARD except scoreboard `.edit()`" requirement.

4. **7-layer grader guard chain is not present.**
   - Current grading flow in `services/grading.js` directly invokes Gemini+Google Search inside `gradePropWithAI()`.
   - There is no explicit ordered guard framework for kill-switch → time guards → search-result guard → hallucination detector → team verification.

## ⚠️ Warning

1. **Dead/removed model defaults still present in AI provider config.**
   - `services/ai.js` still defaults Groq to:
     - `llama-3.3-70b-versatile`
     - `llama-3.2-11b-vision-preview`

2. **Cron inventory mismatch vs required list.**
   - Current scheduler defines: `auto-grade`, `twitter-poller`, `daily-leaderboard`, `daily-recap`, `nightly-purge`.
   - Required jobs not found in runtime wiring: `scoreboardRefresh`, `staleBetRepost`, `hourlyHealthPulse`, `dailyHealthReport`, `weeklyHealthReport`, `scheduledRestart`.

3. **Provider chain drift: grading bypasses centralized provider fallback.**
   - `services/ai.js` has multi-provider routing.
   - `services/grading.js` uses direct Gemini client calls and does not share fallback/provider naming semantics.

4. **Bouncer false-negative analysis (Fix 1) remains partially blocked by environment data.**
   - No production tweet/bet corpus is checked into repo for replay-based FN measurement.
   - Synthetic validation via existing `tests/twitter-pipeline-validation.js` still passes, but this is not a production FN metric.

## ℹ️ Info

1. **No residual references found** for:
   - `apitwitter.com`, `APITWITTER_KEY`, `qwen-qwq-32b`, `llama3.1-70b`, `llama-3.2-90b-vision-preview`, `Serper`.

2. **Twitter media compatibility check:**
   - `services/twitter.js` currently accepts `tweet.media[].url`, `media_url_https`, and `media_url` fallback chain.

3. **Service test presence (direct stub/validation references):**
   - No service file appears completely unreferenced by `tests/*.js` in this repository snapshot.

## Safe automated fixes applied in this PR

1. **Discord ephemeral deprecation migration:** replaced `ephemeral: true` interaction responses with `flags: MessageFlags.Ephemeral` across commands, handlers, and services.
2. **Error swallowing reduced:** converted silent catches to explicit error logging in `bot.js`, `services/warRoom.js`, `services/database.js`, and `handlers/messageHandler.js` cleanup path.
3. **Message handler reliability fix:** added missing error-context object in `processAggregatedMessage()` catch path before admin error reporting.
4. **Coverage stubs added for today-churn surfaces:**
   - `tests/twitter-service.stub.js`
   - `tests/bouncer-service.stub.js`

## What changed since yesterday

Compared to `docs/end-of-day-comprehensive-audit.md`:

- **Improved:** deprecated Discord ephemeral usage has now been migrated to message flags.
- **Improved:** several silent catch blocks now log explicit errors for debuggability.
- **Still open:** dashboard routing policy, migration target mismatch (expected 011 vs actual 006), and cron inventory mismatch remain unresolved.
- **Still open:** requested centralized 7-layer grading guard chain is not present in current grader architecture.
