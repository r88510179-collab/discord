# End-of-day-3 audit

Date: 2026-04-09 (UTC)

## 🚨 Critical

1. **Auto-grader rewrite items are not present in production grading path.**
   - No `reclassifySport()` function.
   - No `gradeParlay()` function.
   - No Guard 8 / Guard 9 implementation or call sites.
   - No per-leg grading persistence path into `parlay_legs` (`result/evidence/graded_at` writes are absent).
   - `runAutoGrade()` currently routes through `gradePropWithAI()` directly and finalizes whole bet; it does not dispatch by leg.  
   Impact: claimed grading-safety controls and parlay accuracy improvements are not actually active.

2. **Migration `013` is missing.**
   - Repository migrations currently stop at `006`.
   - `parlay_legs` schema in `001_initial_schema.sql` has `result` but no `evidence` or `graded_at`.
   - `insertLeg` only writes `(id, bet_id, description, odds)`.
   Impact: schema/callers cannot support claimed leg-level evidence and graded timestamps.

3. **Brave search backend chain is not implemented.**
   - No Brave backend integration in grading/search path.
   - No DDG/Bing/Serper fallback chain implementation found.
   - No circuit-breaker state machine and no backend-result-duration logging format.
   Impact: grading/search resiliency claims are currently unverified/unimplemented.

4. **`/api/mobile-ingest` endpoint is missing.**
   - Only `/webhook/tweet` exists in the Express app.
   - No `MOBILE_SCRAPER_SECRET` header gate and no dedicated mobile ingest handler.
   Impact: Surface Pro scraper deployment is blocked and cannot route through the claimed hardened pipeline.

## ⚠️ Warning

1. **Message gate consistency for Bug 3 was partially missing (safe fix applied).**
   - Three-gate consistency target:
     - `bot.js` message channel gate
     - `globalPipelineGuard` gate
     - `picksChannels` gate
   - Before fix, only picks channels were used in handler gate logic; `HUMAN_SUBMISSION_CHANNEL_IDS` was not included consistently.
   - **Safe fix applied**: all three gates now include `HUMAN_SUBMISSION_CHANNEL_IDS`.

2. **Dead model/backend references still present.**
   - `services/ai.js` still defaults to `llama-3.3-70b-versatile` and `llama-3.2-11b-vision-preview`.
   - No strong evidence in current codebase of "DDG demoted/Brave primary" shipping.
   Impact: drift between claimed runtime and repository configuration.

3. **`processed_tweets` retention was missing (safe fix applied).**
   - Table exists and is used for dedup, but cleanup was not scheduled.
   - **Safe fix applied**: nightly purge now deletes `processed_tweets` older than 30 days.

4. **Requested grading audit-log table is still absent.**
   - No `grading_audit_log` table migration or write-path observed.

## ℹ️ Info

1. **Capper attribution via `message.author.displayName` is present** in `resolveCapper()` for normal Discord submissions.
2. **Image extraction includes embed images and snapshots** in `getImageAttachments()`.
3. **`HUMAN_SUBMISSION_CHANNEL_IDS` handling now added to all three message gates** (safe patch in this audit PR).

## Regression check vs yesterday's audit

- **Still unresolved from prior risk themes:**
  - Missing audit-log style persistence for pipeline/grading decisions.
  - Missing retention controls (now partially improved with `processed_tweets` cleanup).
  - Missing robust multi-backend search/circuit-breaker implementation.

- **Improved today (safe changes in this PR):**
  - Channel-gate parity improved for human submission channels.
  - `processed_tweets` no longer grows without time-based retention.

## Risky changes deferred for human review

1. Full auto-grader rewrite (guards, sport reclassification, parlay leg grading) requires broader architecture changes and end-to-end validation against production fixtures.
2. New `/api/mobile-ingest` endpoint should be introduced with replay protection + auth rotation + ingestion-contract tests before deployment.
3. Brave/DDG/Bing/Serper backend orchestration and circuit breaker should be implemented with explicit telemetry and synthetic failover tests.
