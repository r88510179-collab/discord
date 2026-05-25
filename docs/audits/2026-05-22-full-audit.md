# ZoneTracker Full Audit — 2026-05-22

> **Editor's note (2026-05-22):** Exec-summary counts ("17 findings; 0/5/10/2") do not match the body, which contains 21 unique findings (F-01…F-21) with a 0/4/13/4 P1/P2/P3 split. Body is authoritative. F-04 in the top-5 is an exec-summary alias for F-10 + F-11 (search-backend ordering + Brave health-snapshot freshness); see F-04 detail below under section 4 (Grading pipeline). F-02 and F-07 have been verified stale against live production — see inline annotations.

## Executive summary

**Top 5 findings by severity:**

- **F-01 [P1]:** Pipeline event writer can fail silently in test/runtime scenarios and processing continues, reducing trace reliability for drop diagnostics.
- **F-02 [P1]:** Message buffer key is author-only, creating cross-channel collision risk during the 4s window.
- **F-03 [P1]:** Ingest webhook lacks explicit body-size limits/rate limiting at route-level, raising abuse and memory risk.
- **F-04 [P2]:** searchBing remains primary and Brave health snapshot can report healthy despite quota edge behavior unless probe path has run recently.
- **F-05 [P2]:** Multiple 1000+ LOC god-files combine unrelated responsibilities (services/grading.js, services/ai.js, handlers/messageHandler.js, commands/admin.js).

**Top 3 recommended next actions:**

1. Add guaranteed pipeline event durability/queueing around `recordStage()` failures and alerting on write failures.
2. Change buffer key to author+channel (or message-thread key) and add regression tests for same-author multi-channel posts.
3. Harden Express ingest with strict payload limits, rate limiting, and malformed-body handling tests.

## Findings by area

### 1. Architecture & module boundaries

#### F-05: Multi-domain god-files with mixed ownership [P2]
- **Where:** services/grading.js:1-2312, services/ai.js:1-1890, handlers/messageHandler.js:1-1361, commands/admin.js:1-1222
- **What:** Core grading, search adapters, parlay logic, and health helpers are co-located in single large modules.
- **Why it matters:** Raises regression risk and slows incident response because unrelated edits collide.
- **Evidence:** File line counts exceed 1000 and include varied concerns (search, grading, health, admin surfaces).
- **Recommendation:** Incremental extraction by domain slice (search backend, parlay rollup, admin stats) without architecture rewrite.
- **Effort:** M

#### F-06: Entry points are distributed but explicit [P3]
- **Where:** bot.js:12-31, bot.js:517-593, routes/api.js:11-24
- **What:** Discord bot startup/events, AutoGrade/Brave cron, and Express health/webhook endpoints are split between bot.js and routes/api.js.
- **Why it matters:** Operational ownership is manageable but can confuse runbook mapping.
- **Evidence:** `app.get('/health')`, `app.post('/api/webhooks/apify')`, scheduled `runAutoGrade`/`probeBrave` calls.
- **Recommendation:** Keep current shape; add one doc table mapping runtime entrypoints to owners.
- **Effort:** S

### 2. Ingestion pipeline

#### F-01: Pipeline events can fail and flow continues [P1]
- **Where:** services/pipeline-events.js:119-151, test output from `npm run test:reliability`
- **What:** `recordStage()` catches and logs write errors instead of failing closed; tests show repeated `Cannot read properties of undefined (reading 'prepare')` while pipeline proceeds.
- **Why it matters:** Silent observability loss masks drop points and root-cause timelines.
- **Evidence:** Console lines `[PipelineEvents] write error: Cannot read properties of undefined (reading 'prepare')` during integration pass.
- **Recommendation:** Add hard metric/alert + fallback queue flush; optionally fail specific critical stages in non-prod test harness.
- **Effort:** M

#### F-02: Buffer key collision risk across channels [P1]
- **Where:** handlers/messageHandler.js:69-107
- **What:** Buffer map key is `message.author.id` only; same author posting in two channels inside 4s can merge unrelated content.
- **Why it matters:** Can produce wrong parses/holds and apparent "dropped" context.
- **Evidence:** `const key = message.author.id;` and shared aggregation for key.
- **Recommendation:** Use composite key (authorId:channelId) and add test for same author multi-channel race.
- **Effort:** S


> **2026-05-22 verification:** **Stale.** Buffer key is already composite `${userId}:${channelId}` at handlers/messageHandler.js:67. Confirmed live during PR #31 pure-slip bypass verification. No code change needed; resolve and close.
#### F-07: Pure-slip hold-skip is env-driven and not statically verifiable here [SCHEMA-UNVERIFIED] [P2]
- **Where:** handlers/messageHandler.js:1125-1237
- **What:** Hold bypass uses `PURE_SLIP_NO_HOLD_CHANNEL_IDS`; repo does not encode the expected 13 bypass/4 non-bypass IDs.
- **Why it matters:** Drift in env values can silently alter review behavior.
- **Evidence:** Dynamic list read from env; no pinned config artifact in repo.
- **Recommendation:** Add startup assertion logging exact expected IDs hash and admin command diff output.
- **Effort:** S


> **2026-05-22 verification:** **Stale.** Env var is `PURE_SLIP_CHANNEL_IDS`, not `PURE_SLIP_NO_HOLD_CHANNEL_IDS` (handlers/messageHandler.js:1133). The 13 bypassed / 4 non-bypassed channel IDs are now encoded in docs/CODEMAP.md §Channels (merged in #32) and confirmed live: HUMAN_SUBMISSION=17, PURE_SLIP=13, subset invariant holds, 4 non-bypassed = Harry/Cody/Gavin/Dan (Twitter-relay). Startup assertion recommendation still has value as a guardrail against future drift.
### 3. Parser / extraction

#### F-08: Indeterminate parse state intentionally allowed and must be tracked tightly [P1]
- **Where:** handlers/messageHandler.js:1182-1237, services/ai.js:127-220
- **What:** Pipeline treats (is_bet=undefined, bets>0) as valid path; (is_bet=undefined, bets=0) routes to hold/drop branch.
- **Why it matters:** Misclassification risk if parser confidence conventions drift.
- **Evidence:** Explicit comments/branches for is_bet=undefined behavior.
- **Recommendation:** Add explicit enum (yes/no/indeterminate) instead of tri-state boolean ambiguity.
- **Effort:** M

#### F-09: inferLegSport null propagation relies on per-call fallback [P2]
- **Where:** services/ai.js:1581-1668, services/grading.js:1596-1598, services/grading.js:1685-1692
- **What:** `inferLegSport()` can return null; call sites patch with parentSport or 'Unknown'.
- **Why it matters:** Inconsistent fallback can skew cross-sport guarding and evidence routing.
- **Evidence:** Call site A uses `|| parentSport || ''`; call site B uses `|| parlayBet.sport || 'Unknown'`.
- **Recommendation:** Centralize fallback policy in one helper used by all call sites.
- **Effort:** S

### 4. Grading pipeline

#### F-04: searchBing primary + Brave health-snapshot freshness [P2]
- **Where:** services/grading.js:1369-1493, commands/admin.js:620-639, bot.js:574-593  
- **What:** Exec-summary alias bundling two related grading-pipeline weaknesses: (a) search backend chain leads with `searchBing` despite known Bing HTML drift; (b) `/admin snapshot` can render Brave as healthy when no recent failed call has been logged, even during a 402 quota window.  
- **Why it matters:** Operators may trust a stale "healthy" signal during an incident, and Bing-first ordering increases first-call latency/failure rates when its parser breaks.  
- **Evidence:** See F-10 (search chain ordering with Bing primary) and F-11 (Brave breaker is 402-aware but snapshot rendering lags between probes) for line-level evidence.  
- **Recommendation:** Resolved by addressing F-10 (health-weighted backend selection + synthetic checks) and F-11 (include "last failure code/time" + stale-data marker in snapshot). No separate work item.  
- **Effort:** N/A — covered by F-10 (M) and F-11 (S).

#### F-10: Search fallback chain still depends on Bing first [P2]
- **Where:** services/grading.js:1478-1493, services/grading.js:1369-1404
- **What:** `searchWeb()` uses Bing primary, then Brave, then DDG/Serper.
- **Why it matters:** Bing parser/API breakages can increase latency/failures before fallback.
- **Evidence:** Ordered chain in comments/code and dedicated `searchBing()` implementation.
- **Recommendation:** Add health-weighted backend selection and periodic synthetic checks per backend.
- **Effort:** M

#### F-11: Brave breaker uses 402 as failure, but snapshot may look healthy between probes [P2]
- **Where:** services/grading.js:1418-1446, commands/admin.js:620-639, bot.js:574-593
- **What:** 402 errors trip backend failure accounting, but status UI can appear healthy if no recent failed call is logged.
- **Why it matters:** Operators may trust stale health in incident windows.
- **Evidence:** `fmtBackend` in admin snapshot renders from recent counters; probe is scheduled daily and boot-time best effort.
- **Recommendation:** Include "last failure code/time" + explicit stale-data marker in snapshot.
- **Effort:** S

#### F-12: Token budget check mostly compliant; one constrained grader remains [P2]
- **Where:** services/grading.js:1995-2033
- **What:** Main grading call around qwen branch uses bounded response settings; parlay evidence may be verbose.
- **Why it matters:** Too-low token budgets can truncate rationale/evidence strings.
- **Evidence:** Nearby model call configs show explicit max_tokens settings.
- **Recommendation:** Add output-length guardrail + retry with higher tokens when evidence is clipped.
- **Effort:** S

### 5. Parlay handling

#### F-13: Loss short-circuit guards exist and include cross-sport/placeholder checks [P3]
- **Where:** services/grading.js:1569-1660, tests/parlay-loss-shortcircuit.test.js:1-140
- **What:** `isTrustedLossLeg()` applies player-prop and sport contamination filters before forcing LOSS.
- **Why it matters:** Reduces false LOSS finals in partial-evidence parlays.
- **Evidence:** Guard logic + dedicated regression tests for trusted/untrusted conditions.
- **Recommendation:** Keep; add monthly sample QA against production settlements.
- **Effort:** S

### 6. Database & migrations

#### F-14: Dual "006" migration files are intentionally tolerated but operationally noisy [P2]
- **Where:** migrations/006_add_season_column.sql:1-20, migrations/006_add_season_to_bets.sql:1-20, migrator output in reliability run
- **What:** Migrator logs "column already exists" for second 006 variant.
- **Why it matters:** Noise obscures real migration failures.
- **Evidence:** Runtime migration log shows duplicate-season migration skip behavior.
- **Recommendation:** Keep historical file but add explicit comment in migrator/docs about expected duplicate.
- **Effort:** S

#### F-15: pipeline_events.created_at epoch seconds confirmed; readers not uniformly normalized [P2]
- **Where:** PRAGMA output (`pipeline_events.created_at INTEGER default strftime('%s','now')`), commands/admin.js:922-983
- **What:** Storage is integer epoch; some views convert directly, others pass through JSON payloads without timezone normalization.
- **Why it matters:** Debug timelines can be misread by operators.
- **Evidence:** Table schema + text export path.
- **Recommendation:** Standardize helper for epoch->ISO UTC across admin/report code.
- **Effort:** S

### 7. Admin commands & operational tools

#### F-16: Admin surface is broad with mixed operational and data-mutation actions [P2]
- **Where:** commands/admin.js:1-1222
- **What:** Many subcommands (snapshot, dedup stats, review/regrade helpers, release paths) coexist in one file.
- **Why it matters:** Harder to enforce guardrails consistently.
- **Evidence:** Command builder includes multiple unrelated subcommands and file export paths.
- **Recommendation:** Split read-only diagnostics vs mutating admin actions into separate modules.
- **Effort:** M

### 8. Security & secrets

#### F-03: Webhook endpoint hardening gaps [P1]
- **Where:** bot.js:19-29, routes/api.js:1-24
- **What:** Endpoint checks bearer token but route layer does not show explicit request size limiter/rate limiter.
- **Why it matters:** Large/malformed payloads can consume memory/CPU.
- **Evidence:** Minimal auth wrapper + no visible limiter middleware in route file.
- **Recommendation:** Add `express.json({limit})`, per-IP throttle, and malformed-body tests.
- **Effort:** M

### 9. Observability

#### F-17: Drop reasons are partially structured, partially freeform payload-driven [P2]
- **Where:** services/pipeline-events.js:1-33, handlers/messageHandler.js:924-1005
- **What:** Stage/event enums exist, but detailed drop semantics often live in arbitrary payload keys.
- **Why it matters:** Harder aggregate analytics on top drop causes.
- **Evidence:** `EVENT_TYPES` constrained; `drop_reason` optional and payload varies by caller.
- **Recommendation:** Define closed `drop_reason` enum with validation at write boundary.
- **Effort:** M

### 10. Tests & CI

#### F-18: Reliability suite passes but logs persistent pipeline write warnings [P2]
- **Where:** package.json:scripts, tests/message-handler.integration.js, reliability run output
- **What:** `npm run test:reliability` is green while emitting repeated pipeline write errors.
- **Why it matters:** Green CI can hide observability regressions.
- **Evidence:** Passing run plus repeated `[PipelineEvents] write error` lines.
- **Recommendation:** Promote pipeline write errors to test failures in integration tests.
- **Effort:** S

### 11. Dependencies & runtime

#### F-19: Dependency/runtime CVE status not verified in this pass [SCHEMA-UNVERIFIED] [P3]
- **Where:** package.json:1-80, package-lock.json
- **What:** Versions were reviewed but CVE scan tooling (npm audit/SCA) was not executed in this audit run.
- **Why it matters:** Potential known vulnerabilities may be missed.
- **Evidence:** No audit output captured.
- **Recommendation:** Run `npm audit --omit=dev` and record exceptions with expiry.
- **Effort:** S

### 12. Documentation drift

#### F-20: Documentation drift checks incomplete for requested random line validation [P3]
- **Where:** docs/CODEMAP.md, docs/PREFLIGHT.md, docs/DEPLOY_CHECKLIST.md, docs/BACKLOG.md
- **What:** Full 5-point random line-to-code validation was not fully completed in this run.
- **Why it matters:** Operators may follow stale procedures.
- **Evidence:** No completed cross-reference table generated in this report.
- **Recommendation:** Add automated docs link/line verifier in CI for key runbooks.
- **Effort:** M

### 13. Dead code & orphans

#### F-21: Resolver appears near-orphaned but still referenced in admin flows [P2]
- **Where:** services/resolver.js:1-220, commands/admin.js:763-999
- **What:** Reclassifier/resolver logic has limited remaining call sites concentrated in admin actions.
- **Why it matters:** Low-use paths decay and break during incident response.
- **Evidence:** Targeted references in admin commands; sparse broader usage.
- **Recommendation:** Either retire with explicit deprecation path or add focused tests for remaining call sites.
- **Effort:** S

## Open questions for Smokke

1. Please confirm current production values for `HUMAN_SUBMISSION_CHANNEL_IDS`, `PURE_SLIP_NO_HOLD_CHANNEL_IDS`, `CAPPER_CHANNEL_MAP`, and `IGNORED_CHANNELS` to verify the "13 bypassed / 4 non-bypassed" expectation.
   > **2026-05-22 answer:** Resolved. Correct var name is `PURE_SLIP_CHANNEL_IDS`. Live values match the "13 bypassed / 4 non-bypassed" expectation. See CODEMAP §Channels and F-07 annotation above.
2. Please provide 10 recent hold payload examples and 5 recent parlay settlements from production for parser/settlement alignment sampling.
3. Please share Fly secrets inventory to reconcile env vars referenced in code vs deployed secrets.
4. Please confirm whether `/admin snapshot` "uniform +500% ROI" issue is currently reproducible in production data.

## Things that looked good

- Migration chain 001→025 applied cleanly on fresh DB in reliability flow (including expected duplicate-006 skip behavior).
- Parlay loss short-circuit has explicit regression tests for cross-sport and placeholder guardrails.
- Pure-slip bypass behavior is explicitly commented and branch-logged in message handler.
- Brave probe cron + boot probe exist, so backend visibility is at least periodically refreshed.
- `npm run check` and `npm run test:reliability` both complete successfully in this environment.
