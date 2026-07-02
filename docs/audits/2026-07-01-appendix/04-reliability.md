# T4 Reliability — 2026-07-01 audit appendix

Scope: scheduler/restart behavior, grader waterfall, search layer, Surface Pro degradation, backoff/retry storms. Repo pinned at `19ff594` (verified `git rev-parse HEAD`). Prior-audit anchors: M-2/M-3/M-4/M-7 from docs/audits/2026-06-10-coa-full-audit.md.

### T4-01 [P2] [confidence: high] M-7 still open: zero shutdown handlers, and the bot now has THREE abrupt self-kill paths
- Where: bot.js:802, bot.js:795, services/healthReport.js:385
- What / Why it matters: `grep -rn "process\.on(" bot.js services/ handlers/ routes/ commands/` → **zero hits** at HEAD (verified this audit). No SIGTERM/SIGINT handler, no `db.close()`, no cron teardown. Abrupt-exit paths: (1) Fly SIGTERM on every deploy — v756–758 were three deploys within hours; (2) daily 08:00 UTC restart `setTimeout(() => process.exit(0), 5000)` (bot.js:802) — note the auto-grader cron fires at `*/15` starting :00 (bot.js:566), so the 08:00 grading cycle is killed 5s in **every single day**; (3) sustained-heap auto-restart `process.exit(1)` (healthReport.js:379–385). Each kill abandons a dirty WAL and orphans any claimed bet mid-grade: `claimBetForGrading` already incremented `grading_attempts` (grading.js:952) but the killed attempt writes no audit row and no result — attempts silently inflate toward RETRY_CAP=15 (grading.js:1080, terminal VOID) and quarantine ≥20 (grading.js:967) without a corresponding grading attempt.
- Evidence: grep output above; bot.js:802 `setTimeout(() => process.exit(0), 5000); // Fly.io auto-restarts`; healthReport.js:385 `process.exit(1);`.
- Proposed fix: one `shutdown(sig)` — stop crons, wait ≤10s for the in-flight bet, release its claim (`grading_lock_until=NULL`, `grading_attempts=grading_attempts-1`), `db.close()`, exit. Route all three kill paths through it. (Effort S)
- Backlog: existing (M-7 carried in 2026-06-10 audit §resolutions; not in BACKLOG.md as its own item — add).

### T4-02 [P1] [confidence: med] 4-second in-memory ingest buffer is lost on every restart — silent slip loss with no detection or replay
- Where: handlers/messageHandler.js:69–114
- What / Why it matters: All non-bypass Discord messages route through `messageBuffer` (in-memory `Map`, `BUFFER_DELAY_MS = 4000`, flush via `setTimeout` — messageHandler.js:69–70, 101, 114). Any message received <4s before a kill (deploy, daily restart, heap restart — see T4-01) is never processed. The `BUFFERED` pipeline stage is recorded (comment at :76–77) but **nothing reconciles stuck-at-BUFFERED ingests**: `checkPipelineInstrumentation` only checks that drop stages emitted ≥1 row/24h (pipelineHealth.js:31–53), and `replayHolds`/`recoverHold` operate on holds, not buffers. Per the rubric this is silent bet loss with zero enforcement; probability is bounded (4s window × ~1–3 restarts/day, daily restart at 4 AM ET low-traffic) — hence confidence med on real-world impact, high on the mechanism.
- Evidence: messageHandler.js:69 `const BUFFER_DELAY_MS = 4000;`; :70 `const messageBuffer = new Map();`; pipelineHealth.js:31 `EXPECTED_STAGES = ['DROPPED', 'GRADING_AI', 'GRADING_DROPPED']` (no BUFFERED-orphan check).
- Proposed fix: cheapest: in the T4-01 shutdown handler, synchronously flush (or persist) live buffer entries before exit. Alternative: boot-time scan for BUFFERED events with no successor stage in the prior 10 minutes → alert #admin-log. (Effort S–M)
- Backlog: NEW.

### T4-03 [P2] [confidence: high] Total search-layer outage silently auto-VOIDs real bets in every non-adapter sport after 12h
- Where: services/grading.js:3356–3362, 1168–1174, 1188–1232
- What / Why it matters: GUARD 4 returns PENDING with evidence `'No search results available — game may not have completed yet'` (grading.js:3360) — which **matches** `NO_DATA_PATTERNS` (`/no search results/i`, :1170). So 5 consecutive empty-search attempts + age ≥12h → `autoVoidNoSearchableData` terminal VOID (:1235). Build 1d exempts adapter sports only (:1202). The effective search chain is Bing scrape (drift-prone, broke before — M-3 history) → Brave (2K/mo quota; 402 → 1h circuit) → DDG (Fly IPs blocked per comment :2628) → Serper (key-gated, tier exhausted) (searchWeb :2615–2636). A Bing selector drift therefore converts, within ~a day, into silent terminal settlement of every pending golf/tennis/MMA/NCAAB/etc. bet. VOID not LOSS (prime-directive-safe, `review_status='auto_void_no_searchable_data'` visible), but it is infra-failure-driven settlement, and nothing distinguishes "backend down" from "data genuinely absent" in the void decision.
- Evidence: cited lines read this audit; `evidenceLooksLikeNoData` (:1176) applied to the recent-5 audit rows (:1226).
- Proposed fix: in `shouldAutoVoidNoData`, consult `getBackendSnapshot()` (:2249) and return null when ≥3 backends are failing/open — an unhealthy search layer must not produce terminal writes. (Effort S)
- Backlog: adjacent to "Non-uniform auto-void rule" / "24h void-volume watch" (BACKLOG.md ~:205) — extend, or NEW.

### T4-04 [P2] [confidence: high] EVENT_AWARE_RECHECK stuck in shadow since v691 (Jun 18); enforce-flip blocker (MAX_DEFER==SWEEP_CUTOFF) has a specced fix nobody shipped
- Where: services/grading.js:1009, 1691–1692; docs/BACKLOG.md:226–227
- What / Why it matters: The machinery is fully built (planner :1018+, pre-claim defer :1806–1819, denial-path window :1126–1146, sweep guard :1740–1742, tests event-aware-recheck/sweep-guard present in tests/). In shadow, every pre-event bet still burns a claim + full search/LLM per eligible cycle, feeding attempt counts toward RETRY_CAP=15 VOID (:1084) and quarantine ≥20 — the exact churn #124 was built to stop. The blocker is real and documented: `MAX_DEFER_MS` 168h (:1009) == `SWEEP_CUTOFF_MS` 7d (:1692), so enforce could defer a bet past its own sweep. BACKLOG:227 lists two concrete resolutions and two sizing reads; 14 days later neither has landed. Runtime env value **UNVERIFIED** (no fly access this track) — if ops already flipped enforce without shipping the collision fix, this upgrades to a false-LOSS risk (P1).
- Evidence: grading.js:1009 `const MAX_DEFER_MS = 168 * 3600e3;`; :1691 `const SWEEP_DAYS = 7;`; BACKLOG.md:226 "enforce flip blocked on MAX_DEFER(7d)/sweeper SWEEP_CUTOFF(7d) collision".
- Proposed fix: ship the collision fix (drop MAX_DEFER_MS to ~5d, or `event_pending`-exempt deferred bets in `evaluateSweep` for `enforce` — the guard at :1740 already half-does this), run the two BACKLOG shadow reads, flip. (Effort S–M)
- Backlog: existing — BACKLOG.md:226 "Event-aware recheck — enforce flip blocked".

### T4-05 [P2] [confidence: high] No bot-side dead-air alarm for the Surface scraper (S-01 complement missing); the only handle-silence alert keys on the wrong table with a 7-day window
- Where: services/healthReport.js:257–263, 359–400; routes/api.js:68–84
- What / Why it matters: Scraper-ingest health signals at HEAD: (1) `deadHandles` alert — handles with 0 `saved` rows in **7 days**, drawn from legacy `tracked_twitter WHERE active=1` (healthReport.js:258), while the scraper's actual handle source is `scraper_handles` (mig 027; routes/api.js:79). Whether current scraper handles even exist in `tracked_twitter` is UNVERIFIED (needs prod DB) — if not, the alert covers none of the scraper path. (2) `checkCriticalAlerts` (5-min owner-DM loop) checks **only heap and DB liveness** (healthReport.js:364–392). So a Tailscale Funnel outage, dead PM2 app, or expired MOBILE_SCRAPER_SECRET means hours-to-days of silent slip loss before anything fires. Scraper-side S-01 watchdog exists (other repo) but the bot cannot tell "scraper quiet" from "scraper dead".
- Evidence: healthReport.js:260 `... FROM twitter_audit_log WHERE stage = 'saved' AND created_at > datetime('now', '-7 days')`; checkCriticalAlerts body :359–400 contains no ingest query.
- Proposed fix: add to `sectionAlerts`/`checkCriticalAlerts`: max(created_at) over mobile-ingest audit rows; alert when quiet > N hours during active hours (mirror the scraper's own DEAD_AIR heuristic). Key any per-handle logic on `scraper_handles`. (Effort S)
- Backlog: NEW (complements shipped scraper S-01).

### T4-06 [P2] [confidence: high] M-2 still open: grader waterfall accepts the first non-empty response; garbage/truncated JSON wastes the whole attempt
- Where: services/grading.js:3470–3476, 3488–3491
- What / Why it matters: The provider loop `break`s on any non-empty `content` (:3471–3476); `JSON.parse` runs **after** the loop (:3489). Truncated/non-JSON output from provider 1 → PENDING `JSON parse error` (:3491) — the remaining 7 providers are never consulted, the attempt is burned (counts toward RETRY_CAP void / quarantine), and next cycle re-runs search + waterfall from scratch. Direction is fail-safe (PENDING, never a wrong grade), and parse-error evidence deliberately does NOT match `NO_DATA_PATTERNS` (:1165–1167) so it can't feed the auto-void — but it's pure attempt/cost waste, flagged 3 audits ago.
- Evidence: :3476 `break;` on non-empty raw; :3489 `try { parsed = JSON.parse(raw) } catch ...` outside loop.
- Proposed fix: move parse+schema check inside the loop; on failure `continue` to next provider (the June-10 audit sketched exactly this). (Effort S)
- Backlog: existing (M-2, 2026-06-10 audit) — not yet a BACKLOG.md line item; add.

### T4-07 [P3] [confidence: high] M-4 residual: quarantined bets are invisible to grader AND sweeper; only exit is a manual per-bet force-ready
- Where: services/database.js:706, services/grading.js:967, commands/admin.js:516–561
- What / Why it matters: `getPendingBets` selects `grading_state IN ('ready','backoff')` (database.js:706) — the sole feed for both the grader loop and the 7-day sweeper (`pending.filter` at grading.js:1882). `applyBackoff` sets `'quarantined'` at attempts ≥20 (:967). Result: permanent pending zombies (in practice prop bets, since non-props sweep at 7d before reaching 20 attempts). Since June 10, an exit exists — `/admin grading-unstick` lists quarantined and force-readies ONE bet (admin.js:559–561) — so M-4's "exit: nobody" is now "exit: manual, per-bet". But no alarm is quarantine-specific (the 24h-stuck alert at healthReport.js:253 counts them only in aggregate; BACKLOG.md:888 already notes this shape), and CODEMAP's repeated "the 7-day sweeper is the backstop" claim is FALSE for quarantined bets — the sweeper cannot see them. That is doc-vs-code drift worth recording.
- Evidence: cited lines read this audit; CODEMAP §grading.js `shouldAutoVoidNoData` row: "the untouched 7-day sweeper is the backstop".
- Proposed fix: add quarantine count + oldest-age to `sectionAlerts`; consider auto-park to `needs_review` at quarantine so a human queue owns them. Correct the CODEMAP backstop claim. (Effort S)
- Backlog: existing (M-4; BACKLOG.md:888 "stuck >24h false positives") — extend.

### T4-08 [P3] [confidence: med] Auto-grader cron has no overlap guard; cycles longer than 15 min run concurrently
- Where: bot.js:566–586, services/grading.js:1872–1874
- What / Why it matters: `cron.schedule('*/15 ...', async ...)` (interval env-tunable, bot.js:565) fires regardless of whether the previous `runAutoGrade` returned; no in-repo mutex exists (node-cron ^3.0.3 — its no-serialization default UNVERIFIED here, no node_modules in worktree). Cycle duration = per-bet drip 10–30s (grading.js:1872) + grading time, so ≥~40 due bets exceeds 15 min. Mitigations verified: atomic claim (:948–961, 10-min lock), first-write-wins terminal UPDATE (database.js:650–664 `WHERE result='pending'`), sweep write gated the same way — so no wrong-grade path. Residual: a multi-leg parlay's full per-leg search+8-provider waterfall can exceed the 10-minute lock, letting an overlapping cycle re-claim the same bet mid-grade → duplicate search/LLM spend, duplicate audit rows, attempts double-incremented.
- Evidence: cited lines; no `running`/mutex flag anywhere in bot.js.
- Proposed fix: module-level `if (cycleInProgress) return` flag in the cron callback (plus T4-01's shutdown clearing it); or scale claim lock with leg count. (Effort S)
- Backlog: NEW.

### T4-09 [P3] [confidence: high] Cron health telemetry is in-memory, success-only, and absent-silent — a dead cron is invisible, and the daily restart wipes history every 24h
- Where: services/healthReport.js:19–27, 146–159; bot.js:581
- What / Why it matters: `cronRuns` is a process-local object (healthReport.js:19) reset by every restart (daily by design, T4-01). `sectionCrons` only renders crons that have ≥1 recorded run (:148–149) — a cron that crashes every cycle or never fires simply has **no line**, not a 🚨. The auto-grader records `logCronRun` only on success (bot.js:581, inside the try after the summary post). The stronger signal — "AutoGrader hasn't graded in >3h" (healthReport.js:266–269) — lives only in report embeds, never in the 5-min owner-DM `checkCriticalAlerts` loop. A crash-looping grader is thus detectable only by reading channel embeds attentively.
- Evidence: cited lines read this audit.
- Proposed fix: register expected cron names at schedule time so `sectionCrons` renders "never ran since boot: N" as 🚨; add the grader-stale check to `checkCriticalAlerts`. (Effort S)
- Backlog: NEW.

### T4-10 [P3] [confidence: high] BACKLOG drift: claims "no test enforces" GRADER_ELIGIBLE_WHERE parity, but the sync test shipped (#125)
- Where: docs/BACKLOG.md:174; tests/grader-gate-sync.test.js:2,49
- What / Why it matters: BACKLOG.md:174 ends "**Sync risk (documented, not asserted): … no test enforces the equality.**" — stale: `tests/grader-gate-sync.test.js` exists at HEAD and imports both runtime constants (`GRADER_HIDDEN_REVIEW_STATUSES` at :49) asserting parity. An operator reading BACKLOG would wrongly treat the invariant as unenforced.
- Evidence: test header :2 "Grader-gate sync — GRADER_ELIGIBLE_WHERE ⇔ GRADER_HIDDEN_REVIEW_STATUSES parity."
- Proposed fix: one-line BACKLOG correction citing the test. (Effort S)
- Backlog: existing item text is the defect.

## Looked good
- **Restart-safety of scheduling state:** all recheck/defer/backoff state is DB-persisted (`grading_next_attempt_at`, `grading_state`, `grading_lock_until` — grading.js:948–977, 1134–1152); claim locks self-expire in 10 min; crons re-register on boot. No `setTimeout`-held grading state anywhere in bot.js/grading.js (only cosmetic boot-delay timers, bot.js:603/624/644).
- **Cerebras/any-provider silent-200-empty:** guarded at both call sites — ai.js:158–159 (`NO_CONTENT` → next provider) and grading.js:3470 (`|| null` → loop continues). All-providers-fail → PENDING `'All AI providers failed'` (:3483–3486); zero-keys → PENDING (:3394). max_tokens now 1000 (:3453), the v441 starvation class gone.
- **M-3 closed:** breaker no longer parse-blind — every backend routes through `assessSearchResults`; `parse_empty` records a circuit failure (ddg :2401, bing :2506, brave :2559, serper :2600); `recordBackendResult` stamps `lastSuccess` only on real success (:2218–2226); Bing parses via multi-selector `parseBingHtml`; 402/401/403 → 1h quota cooldown (:2231–2233); bing/serper deliberately un-gated workhorses (:2200–2205); daily Brave probe (bot.js:591).
- **Surface Pro degradation:** localOcr never throws, typed errors, breaker with `/healthz` close, 8s default `OCR_TIMEOUT_MS`, `ok:false` ≠ breaker trip (localOcr.js:103–177); ocrFirstWiring falls back to Gemini on OCR timeout (`FALLBACK_GEMINI`, ocrFirstWiring.js:538); Gemma/ollama-proxy has its own breaker + 90s timeout + typed fail (ai.js:801–855); grader-waterfall ollama capped 25s and falls through (grading.js:3439).
- **Retry storms bounded:** backoff ladder capped +24h, quarantine ≥20 (:964–977); denial path RETRY_CAP=15 with GRADER_ELIGIBLE_WHERE-gated, changes>0-gated void + drop (:1084–1120); daily 10k attempt cap with visible pause log (:1774–1781); `recoverHold` RECOVERY_RETRY_CAP=5 checked BEFORE any fetch/vision spend, force-bypassable (holdReview.js:391–410); AI-grader per-provider 429 backoff capped 30s (:3457–3461).
- **Sweeper guards:** grace windows, live `grading_state='done'` re-read, event-pending guard, `requireGraderEligible` on the sweep write (:1740–1760, 1908).

## UNVERIFIED / open questions
- Runtime env values on Fly (no prod access this track): `EVENT_AWARE_RECHECK` (shadow per docs), `OCR_FIRST_MODE`, `OLLAMA_URL` set/unset, `AUTO_GRADE_INTERVAL_MINUTES`, `AUTOGRADER_DISABLED`. Running image v756–758 may differ from HEAD.
- Whether current scraper handles exist in `tracked_twitter` (T4-05) — needs one prod query: `SELECT twitter_handle FROM tracked_twitter WHERE active=1`.
- node-cron ^3.0.3 overlap semantics (T4-08) — no node_modules in this worktree; asserted only that no in-repo guard exists.
- `AUTO_GRADE_INTERVAL_MINUTES` is interpolated unvalidated into the cron expression (bot.js:565–566); whether a bad value (e.g. `0`) throws at `cron.schedule` and boot-loops the bot was not executable here.
- Live Bing parse health / current backend traffic split (last verified 2026-06-10: bing ok=1262/7d) — requires `search_backend_calls` prod query or `/grader-health`.
