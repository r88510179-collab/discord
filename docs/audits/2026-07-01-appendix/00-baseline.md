# 00 — Baseline & regression sweep — 2026-07-01 audit appendix

> Audit executed 2026-07-02 (report dated 2026-07-01 per the audit spec). Orchestrator-verified evidence; REPORT ONLY — zero production mutations.

## A. Pinned baseline

| Item | Value |
|---|---|
| HEAD | `19ff594c8dd7553cdc6f41362b1a6f2f867e6ba8` — `feat(admin): Phase A read endpoints - leaderboard, drops, grader-health (#161)`, committed 2026-07-02 08:40 -0400 |
| Branch | `audit/2026-07-01-full` (worktree `.claude/worktrees/audit-2026-07`, tracks `origin/main`) |
| Tree | clean (`git status --porcelain` → 0 lines) |
| node / npm | v25.8.1 / 11.11.0 |
| Fly releases at audit time | v758 (complete, ~09:0x ET 2026-07-02), v757 ~1min prior, v756 ~12h prior — **production was actively deployed during this audit**; runtime image vs HEAD not assumed equal |
| Fly secrets | 71 names present (names-only inventory in part C below; no values read) |

### LOC re-measure (F-05 god-files)

| File | 2026-05-22 | 2026-06-10 | 2026-07-02 (HEAD) | Δ since 06-10 |
|---|---|---|---|---|
| services/grading.js | 2,312 | 2,673 | **3,878** | +1,205 |
| services/ai.js | 1,890 | 1,984 | **2,446** | +462 |
| handlers/messageHandler.js | 1,361 | 1,408 | **1,551** | +143 |
| services/database.js | — | 1,135 | **1,241** | +106 |
| commands/admin.js | 1,222 | 1,154 | **1,198** | +44 |
| bot.js | — | — | 820 | — |
| services/holdReview.js | — | — | 781 | — |
| routes/admin.js | — | — | 554 | — |

F-05 verdict: OPEN and worsening — grading.js grew +45% in three weeks; no extraction has happened.

### Migration ledger (files at HEAD)

`migrations/` contains 001–031, with exactly ONE 006 file (`006_add_season_column.sql`) after the #160 dedup. New since last audit: `029_null_unparseable_event_dates.sql`, `030_drop_resolver_events.sql`, `031_pipeline_events_event_type_created_idx.sql`. Applied-state vs `schema_migrations` verified in the live probes (appendix 20, probe 0).

### Dependency pass — `npm audit --omit=dev` (run in the audit worktree, 2026-07-02)

**8 vulnerabilities (5 moderate, 3 high).** Summary:

| Package | Severity | Issue (advisory) | Fix |
|---|---|---|---|
| lodash ≤4.17.23 | high | Code injection via `_.template` (GHSA-r5fr-rjxr-66jc); prototype pollution `_.unset`/`_.omit` (GHSA-f23m-r3pf-42rh) | `npm audit fix` |
| undici ≤6.26.0 (via discord.js / @discordjs/rest) | high | 10 advisories incl. request smuggling (GHSA-2mjp-6q6p-2qxm), CRLF injection (GHSA-4992-7rv2-5pvq), response-queue poisoning (GHSA-35p6-xmwp-9g52), several WS DoS | `npm audit fix` |
| ws 8.0.0–8.20.1 | high | Uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx); memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p) | `npm audit fix` |
| qs 6.11.1–6.15.1 | moderate | stringify DoS (GHSA-q8mj-m7cp-5q26) | `npm audit fix` |
| uuid <11.1.1 (via node-cron 3.x) | moderate | buffer bounds check (GHSA-w5hq-g745-h8pq) | `npm audit fix --force` → node-cron@4.5.0 (breaking) |

F-19 (CVE status unverified) is hereby closed as EXECUTED; the finding graduates to "8 known vulns, fix available" — see main report.

## B. Regression table — every prior finding

# Baseline regression table (part B) — 2026-07-01 audit appendix

Verification base: main repo at worktree HEAD `19ff594` (`/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`). Satellite verification used local Mac checkouts' **last-fetched `origin/main` refs** (no `git fetch` performed — read-only rule), so satellite rows reflect the remote as of each repo's last fetch, which may lag the true remote and the deployed Surface Pro state.

| Local checkout | Working HEAD | Branch | Tree | origin/main (last-fetched) |
|---|---|---|---|---|
| zonetracker-dashboard | `f41ec60` | `phase-2b2-dashboard-handles-toggle` (origin branch **gone**) | untracked `.worktrees/`, `prompts/` only | `e3deb38` |
| zonetracker-dubclub | `2afa4b2` | `fix/u1-browser-watchdog` (**behind origin/main by 7**) | untracked `prompts/` only | `607699b` |
| zonetracker-scraper | `2b340f9` | `chore/eco-untrack` (in sync w/ its origin branch) | untracked `.claude/` only | `ff9fda0` |
| zonetracker-ocr | `e21ee2c` | (not in either prior audit's finding set) | — | — |

Satellite rows below cite `origin/main` file:line via `git grep/show` (verified this run). **Host (H-*) rows: no ssh performed; doc-claimed evidence only** (docs/SURFACE-PRO.md at main-repo HEAD).

## Table 1 — 2026-05-22 audit (F-01…F-21)

| ID | Title (one line) | Status | Evidence (verified at HEAD 19ff594 unless noted) |
|---|---|---|---|
| F-01 | Pipeline event writes fail silently, flow continues | **OPEN** | services/pipeline-events.js:195-196 — `catch (err) { console.error('[PipelineEvents] write error: …') }`, no metric/alert/queue |
| F-02 | Buffer key author-only cross-channel collision | **STALE** | Pre-annotated stale in the audit itself; composite key confirmed at handlers/messageHandler.js:73 `` `${message.author.id}:${message.channel.id}` `` |
| F-03 | Webhook route lacks body-size limit / rate limiting | **OPEN** | bot.js:10 `app.use(express.json());` — no `{limit}`, no rate limiter anywhere in bot.js/routes/api.js (grep `rateLimit|limit:` → 0 hits) |
| F-04 | (exec-summary **alias** of F-10 + F-11) | ALIAS | No separate work item per the audit itself; F-10 OPEN, F-11 FIXED — see those rows |
| F-05 | Multi-domain god-files | **OPEN** (worse) | `wc -l`: grading.js **3878** (was 2312→2673), ai.js **2446**, messageHandler.js **1551**, admin.js 1198, database.js 1241 |
| F-06 | Entry points distributed; add doc table mapping | **FIXED** | docs/CODEMAP.md has per-file map incl. `### bot.js` (L454), `### routes/ — Admin HTTP API` (L398), `### commands/admin.js` (L462) |
| F-07 | Pure-slip bypass env-driven, not statically verifiable | **STALE** | Pre-annotated stale in-file (var is `PURE_SLIP_CHANNEL_IDS`, messageHandler.js:1239/1336; IDs encoded in CODEMAP §Channels). Note: recommended startup-assertion guardrail still absent |
| F-08 | is_bet tri-state boolean ambiguity | **OPEN** | messageHandler.js:1234 `if (parsed.is_bet === false)` branches vs undefined-passthrough; no enum. (#137 pre-filter is shadow-only measurement) |
| F-09 | inferLegSport null fallback divergent per call site | **OPEN** | grading.js:2959 `\|\| parentSport \|\| ''` vs grading.js:3058 `\|\| parlayBet.sport \|\| 'Unknown'` — exactly the original evidence, not centralized |
| F-10 | Search chain Bing-first, no health-weighted selection | **OPEN** (mitigated) | grading.js:2614 "Master search: Bing (free scrape, primary) → Brave → DDG → Serper", :2620-2636 ordered chain. Mitigation: #74 honesty gates (see M-3) stop garbage scoring healthy |
| F-11 | Brave/backends snapshot can look healthy between probes | **FIXED** | Backend state carries `lastFailure/lastError` (grading.js:2194-2197); `/admin` `fmtBackend` renders `OPEN (lastError, Nm) \| last ok <age>` / `DEGRADED (…fails)` (commands/admin.js:640-657; CODEMAP row L468) |
| F-12 | Constrained grader token budget | **FIXED** | grading.js:3453 `max_tokens: 1000` (5× the v441-era 200) at the single grader call |
| F-13 | Loss short-circuit guards exist (informational "keep") | **STALE** (kept, still good) | `isTrustedLossLeg` grading.js:2931, applied :2999; tests/parlay-loss-shortcircuit.test.js present |
| F-14 | Dual "006" migration files | **FIXED** | Only `migrations/006_add_season_column.sql` remains; `006_add_season_to_bets.sql` removed by #160 (commit `71d05a5`) |
| F-15 | Epoch-seconds readers not uniformly normalized | **OPEN** | No shared epoch→ISO helper; ad-hoc conversions at commands/admin.js:475, :511 (`(unixepoch()-86400)*1000`), :947 (`strftime('%s','now')-86400`) |
| F-16 | Admin surface mixes read-only and mutating actions | **OPEN** (partial) | commands/admin.js still one 1198-line file. Partial: the HTTP admin surface IS split — routes/admin.js (read, CODEMAP L402) vs routes/adminCommands.js (write, L403) |
| F-17 | drop_reason freeform; define closed enum + validation | **FIXED** | pipeline-events.js:35 `EVENT_TYPES`, :47 `DROP_REASONS`, :150-154 `warnUnknownEnums` at the single write boundary (:181), warn-only by design (#49, commit `b35d724`) |
| F-18 | Tests green while logging pipeline write errors | **OPEN** | No test asserts on `[PipelineEvents] write error` (grep over tests/ → 0 hits); writer still swallows at pipeline-events.js:195 |
| F-19 | CVE scan never executed | **OPEN** | .github/workflows/ci.yml: check + test:reliability + two doc-existence steps only; no `npm audit` step |
| F-20 | Docs line-to-code validation incomplete / not automated | **OPEN** (mitigated) | CI has doc-existence checks only (ci.yml:35-44); no automated line verifier. Mitigation: manual full doc sweep shipped as #123 |
| F-21 | Resolver near-orphaned but still referenced | **FIXED** | `services/resolver.js` deleted (`85cb31a`); fly.toml has zero resolver refs (removed #76 `7a55842`); `resolver_events` dropped by migrations/030 (#80 `267f602`); commands/admin.js zero resolver refs. See resolver-sweep note + R-04 |

**2026-05-22 fix rate:** of 17 actionable findings (21 − F-04 alias − 3 pre-verified/informational STALE): **6 FIXED, 11 OPEN, 0 REGRESSED**. Both surviving P1s (F-01, F-03) are still open six weeks later.

## Table 2 — 2026-06-10 audit, main repo (M-1…M-16; **there is no M-6 in the source** — noted, not a row)

| ID | Title (one line) | Status | Evidence |
|---|---|---|---|
| M-1 | Escape-hatch + media exemption stage image-tweets as sport=Unknown bets | **OPEN** | services/twitter-handler.js:164 `if (!hasImages && preCheck === 'reject_recap')`, :169 `structureDetected = hasImages \|\| (preCheck === 'valid')`, :233-237 `if (structureDetected)` → force-stage — byte-identical failure chain (file moved handlers/→services/) |
| M-2 | Grader waterfall aborts on first truncated/garbage JSON | **OPEN** | grading.js:~3470-3477 loop breaks on first non-empty `raw`; `JSON.parse` post-loop :3489-3491 → `earlyReturn PENDING` for the whole attempt — exact 06-10 shape |
| M-3 | Bing 200-with-garbage recorded `ok`; breaker parse-blind | **FIXED** | grading.js:2502-2519 — `assessSearchResults(results, query, {checkRelevance:true})`; `parse_empty` → `recordBackendResult('bing', false, 'PARSE_EMPTY')`; `generic_news` → falls through without tripping breaker (#74); helper defined :2313 |
| M-4 | `quarantined` terminal, no reaper/admin surface | **FIXED** (partial) | `/admin` grading-unstick subcommand lists quarantined + optional force-back-to-ready (commands/admin.js:115, :495-578). No automatic 7-day reaper (grep `quarantin` in bot.js → 0) — manual exit only |
| M-5 | No retention for 4 append-only tables; WAL > DB | **OPEN** | bot.js purge cron :779-783 still prunes only bets-archived/user_bets/processed_tweets/twitter_audit_log/bot_health_log; no DELETE for pipeline_events/grading_audit/search_backend_calls/parlay_legs_dedup_events; no `wal_checkpoint` (grep → 0) |
| M-7 | No SIGTERM/SIGINT graceful shutdown | **OPEN** | `grep -rn "process\.on(" bot.js services/ handlers/ routes/ commands/` → **zero hits** |
| M-8 | `pipeline_events.created_at` unindexed | **OPEN** (partial fix) | migrations/031 adds `(event_type, created_at)` (#161) — serves routes/admin.js `/drops`; but bare `created_at >= ?` scans remain (services/pipelineRender.js:123, :125, :129, :135) which that leading-column index cannot seek |
| M-9 | Unused dep + dead function + stray file | **OPEN** | package.json:14 `@google/generative-ai` still declared (0 require sites); `purgeOldAuditLogs` still defined database.js:906 + exported :1205. `/data/bets.db` = prod, UNVERIFIED this run |
| M-10 | CODEMAP drift (+43 rows, resolver panels, wrong enums) | **FIXED** | CODEMAP L59+L135 grading_state live values (`done/backoff/quarantined/ready/graded`); L139 `bets.source` live list; resolver rows replaced by retirement note L470-475; `scraper_handles` in §Other tables L118 (#123). Residual: see R-04 |
| M-11 | BACKLOG vs shipped reality — 9 stale entries | **FIXED** | BACKLOG L319-321 retry-storm `~~…~~ RESOLVED` with the audit's exact replacement text; L1070 Odds API `~~…~~ RESOLVED`; recordStage-enum shipped as #49 (#123 sweep) |
| M-12 | README describes the legacy economy product | **OPEN** | README.md L1-25 unchanged: "virtual sportsbook… Gemini 2.0 searches the web every 15 minutes… !bankroll/!mystats/!leaderboard" |
| M-13 | gate3-firing-check.js opens prod DB read-write | **OPEN** | scripts/gate3-firing-check.js:16 `new Database(process.env.DB_PATH \|\| '/data/bettracker.db')` — no `{readonly:true}` |
| M-14 | Gate 3 enforce-flip blocked on 7 unsampled would-fires | **OPEN** (runtime UNVERIFIED) | Code default still `shadow` (grading.js:135-141 `resolveGate3Mode`, "DEFAULT = shadow"); prod `QUOTE_BOUND_GRADING` value not checkable this run (no fly access); no docs record an enforce flip |
| M-15 | Gates 4/5 absent (off-date, season-vs-game) | **FIXED half / OPEN half** | Gate 4 SHIPPED: `DATE_BOUND_GRADING` off-date handling, grading.js:218-242 (`GATE4_MODES`, default shadow; #97). Gate 5 (season-vs-game scope) — no structural guard found; still prompt-only |
| M-16 | mobile-ingest early-200 loses batches; caption-less slips dropped | **OPEN** (both halves) | (a) routes/api.js:~50 "Respond 200 immediately… Process asynchronously" unchanged; (b) twitter-handler.js:117-119 `if (!tweetId \|\| !text)` → drop before `imageUrls` considered |

**2026-06-10 main-repo fix rate:** 15 rows → **4 FIXED (M-3, M-4, M-10, M-11), 11 OPEN** (M-8 and M-15 half-fixed), **0 REGRESSED**.

## Table 3 — 2026-06-10 audit, satellites + host

| ID | Title (one line) | Status | Evidence (repo `origin/main` last-fetched) |
|---|---|---|---|
| S-01 | Silent zero-tweet outage; drift rewarded as success | **FIXED** | scraper `5f6d65c` "zero-tweet strike fix + dead-air alarm" + `d0264ff` (merged `e28d768`/`ff9fda0` = origin/main tip); scraper.js:34 `ALERT_WEBHOOK_URL`, :282 `createDeadAirWatchdog`, watchdog.js:41 classifies the zero-ids drift class |
| S-02 | initBrowser leaks a Chromium per cycle on partial init failure | **OPEN** | scraper.js:96-116 — `chromium.launch()` then cookie `JSON.parse/addCookies`; `catch → return false` still **never closes**; runCycle `if (!ok)` path (:341-347) records dead-air but skips `shutdownBrowser()`. See R-01 |
| S-03 | No cycle watchdog; wedged Playwright call zombifies daemon | **OPEN** | `page.$eval`/`evaluate` (scraper.js:138, :142, :148) still timeout-less; `cycleInProgress` (:333-336) never reset on hang; no deadline wrapper; a wedged cycle also never calls `deadAirWatchdog.recordCycle` (no independent timer in watchdog.js — grep `setInterval/setTimeout` → 0) so the S-01 alarm is silent too |
| S-04 | PM2: unbounded logs, no backoff, silent errored end-state | **OPEN** (partial) | origin/main ecosystem.config.js gained `log_date_format`+`merge_logs` but still `max_restarts: 10` with **no `exp_backoff_restart_delay`** (also absent from local `2b340f9` ecosystem.config.example.js); logrotate is host-side (H-1, unverified) |
| S-05 | .env.example carries dead TWITTER_* vars with real burner identity values | **OPEN** | origin/main:.env.example:5-8 still `TWITTER_USERNAME=1500Red4034` + real email (same at local `2b340f9`); `SCRAPER_HANDLES_URL` (read at scraper.js:30) still undocumented there. See R-02 |
| S-08 | Boot banner prints dead fallback list as "Handles" | **OPEN** | scraper.js:380 `` console.log(`  Handles: ${HANDLES.length} \| Schedule: …`) `` — HANDLES is still the built-in fallback array (:23); live set is `getActiveHandles()` per cycle |
| U-1 | Chromium death zombies the bridge | **FIXED** | dubclub `2afa4b2` merged to origin/main (`b55c449`); `browser-watchdog.js` in tree; index.js:355/:364 arm disconnect handler + health probe + relaunch; README:98 documents it; SURFACE-PRO.md:123 lists `BROWSER_RELAUNCH_MAX_ATTEMPTS`/`DEAD_AIR_MAX_MS` on the box (deploy doc-claimed) |
| U-2 | At-least-once webhook retry double-posts | **OPEN** | Only idempotency is `\Seen` post-success (index.js:276); no `retry_after`/429 handling, no per-email progress state (grep `retry_after\|UIDVALIDITY` → 0); flag-add failure only `errlog` (:278), no alert |
| U-3 | "Leave unseen for retry" has no retry trigger | **OPEN** | Only `setInterval` on origin/main is the watchdog health probe (browser-watchdog.js:217); no periodic sweep timer in index.js |
| U-4 | splitIntoPicks silently loses picks / keeps junk | **FIXED** | index.js:219-226 `auditSplit` + `droppedNonChrome` admin alert ("dropped N non-chrome line(s)"); splitter fixes merged: `1526344` (F5/fused totals), `6f03876` (pick'em/bare-decimal + drop audit), `eac67d2` (Pickem→ML) |
| U-5 | scrapePicks longest-innerText over-capture (incl. `main`) | **OPEN** | index.js:110 selector list still contains `'main'`; per-candidate `innerText` capture unchanged (:118) |
| U-6 | No ecosystem file (325-restart crash-loop history) | **FIXED** (doc-claimed, box-local) | Not in repo tree (matches the ollama-proxy gitignored-config convention); SURFACE-PRO.md:137 procedure: "edit `ecosystem.config.cjs` → `pm2 delete zonetracker-dubclub && pm2 start ecosystem.config.cjs && pm2 save`" — file exists on the box per doc; runtime unverifiable this run |
| U-7 | Skipped emails re-download full bodies each sweep | **OPEN** | index.js:153 `client.fetchOne(uid, { source: true }, …)` before filtering; no `skippedUids` set (grep → 0) |
| U-8 | .env.example/README omit LOCKEDIN_WEBHOOK_URL | **OPEN** (in-repo) | origin/main:.env.example has no LOCKEDIN line (grep rc=1). Mitigation: SURFACE-PRO.md:127 documents `LOCKEDIN_WEBHOOK_URL` among the box env keys |
| U-9 | Expiry alert/README say `npm run seed` on the box (doesn't work headless) | **OPEN** (partial) | index.js:199 alert still `re-run npm run seed on the Surface Pro`; README:48/:94 same. Partial: README:98 (U-1 section) documents the working `seed-mac.js` on the Mac → scp path |
| U-10 | CODEMAP anchors drifted | **OPEN** | dubclub docs/CODEMAP.md:25 "requireEnv (L23)" vs index.js:27 actual — still drifted (now +4) |
| U-11 | storageState never re-persisted | **OPEN** | `context.storageState()` never called (grep `storageState()` → 0); watchdog relaunch re-READS the file from disk (README:98) — read, not persist |
| U-12 | `npm test` unwired | **OPEN** | origin/main:package.json has no `"test"` script (grep rc empty) |
| D-1 | Upstream mid-body failure crashes the dashboard | **FIXED** | origin/main `b37e51a` "contain upstream mid-body failure in relayUpstream (D-1) (#5)"; server.js:120-124 body read inside try/catch → 502 JSON `Upstream response truncated.`; regression test `test/upstream-midbody.test.js` in tree |
| D-2 | "auth-gate-before-express" claim false; record real invariant | **FIXED** | README:13-15 records the accurate topology: browser → tailscale serve (tailnet-only) → 127.0.0.1:8787, proxy "adds Authorization: Bearer <ADMIN_API_SECRET>" (bearer bot-side) |
| D-3 | Stale "read-only / two writes" comments | **OPEN** | public/app.js:203 "exactly two kinds of hold write", :1129 "The dashboard's two writes" — vs server.js:163's own list of FOUR permitted writes (dismiss/recover/handle toggle/bet approve) |
| D-4 | Per-request log line × polling, no rotation | **OPEN** | server.js:126 unconditional `console.log(\`[proxy] …\`)` (not gated on status ≥ 400); pm2-logrotate host-side unverified (H-1) |
| D-5 | Pico CSS from jsdelivr floating tag, no SRI | **OPEN** | public/index.html:9 `https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css` — not vendored |
| D-6 | discordUrl renders upstream strings as href verbatim | **OPEN** | `safeHttpUrl` absent (grep → 0); `discordUrl` public/app.js:92 → used :105/:118 |
| D-7 | README lacks troubleshooting table | **OPEN** | grep -i `troubleshoot` origin/main README.md → 0 hits |
| D-8 | Path-escape guard untested | **OPEN** | No `%2e`/raw-socket test in test/ (grep → 0; the new midbody test is D-1's) |
| H-1 | No pm2-logrotate; 16M dubclub error log | **UNVERIFIED-LOCAL** (likely OPEN) | No ssh this run; docs/SURFACE-PRO.md contains no logrotate mention (grep → 0), so no doc-claimed fix exists |
| H-2 | Ecosystem↔runtime env drift (triple-location class) | **UNVERIFIED-LOCAL** (partially addressed on paper) | SURFACE-PRO.md:58-69 codifies canonical-env + `pm2 delete/start/save` per app; dubclub now has box-local ecosystem.config.cjs (:137); scraper eco untracked to box-canonical (#5, local `2b340f9`). Runtime convergence not checkable |
| H-3 | Ops hygiene: pm2 conf value-dump, 2 undocumented dirs, config.json.bak | **UNVERIFIED-LOCAL** (partial) | (b) `zonetracker-stats` now documented — SURFACE-PRO.md:32 "cron-only — not a PM2 app". (a) no "never-run" list naming `pm2 conf` found in SURFACE-PRO.md (grep → 0); (c) box files unverifiable |

**2026-06-10 satellite/host fix rate:** 29 rows → **6 FIXED (S-01, U-1, U-4, U-6 doc-claimed, D-1, D-2), 20 OPEN, 3 UNVERIFIED-LOCAL (H-1/2/3), 0 REGRESSED**.

## Resolver remnant sweep (mandated)

`grep -rin resolver` across the worktree (excluding docs/audits, migrations, package-lock): **zero references to the dead zonetracker-resolver service in code or fly.toml**. fly.toml: 0 hits (env refs removed in #76 `7a55842`). Surviving matches are unrelated identifiers: `holdReview.js:301 _resolveRecoveredHold`, MLB-StatsAPI "resolver" terminology in comments (grading.js:419, :3273 "replaces old MLB resolver") and the `GRADE_RESOLVER_UNRESOLVED`/`GRADE_RESOLVER_PENDING` drop-reason enums (pipeline-events.js:90, :98), plus doc retirement notes. `resolver_events` table dropped by migrations/030 (#80 `267f602`). One drift found → R-04.

## Findings

### R-01 [P2] [confidence: high] S-02 Chromium leak survived the S-01 rework — the recommended one-line fix was never applied
- Where: zonetracker-scraper `origin/main@ff9fda0` scraper.js:96-116 and :341-347
- What / Why it matters: The S-01 dead-air work rebuilt `runCycle` around `initBrowser`, yet the leak path audited on 2026-06-10 is intact: launch succeeds, cookie `JSON.parse`/`addCookies` throws, `catch → return false` without closing, and the `!ok` branch in `runCycle` records a dead-air cycle but never calls `shutdownBrowser()`. A malformed `browser_cookies.json` still orphans ~100-200MB of Chromium every 5 minutes; the new alarm makes it *audible* but not *fixed*, and PM2's `max_memory_restart` watches only the node process.
- Evidence: `git show origin/main:scraper.js` — catch at :113-115 (`console.error('[Init] Failed:…'); return false;`), no `shutdownBrowser()` before it; runCycle :341-347 `if (!ok) { await deadAirWatchdog.recordCycle(…); cycleInProgress = false; return; }`.
- Proposed fix: `await shutdownBrowser();` in the `initBrowser` catch (it is already idempotent, :118-120) — the exact fix the 06-10 audit wrote out. (Effort S)
- Backlog: NEW (satellite COA follow-ups exist in docs/BACKLOG.md, but this specific one-liner is not tracked as an item I could locate)

### R-02 [P3] [confidence: high] Scraper .env.example still ships real burner identity values three weeks after S-05 reported it
- Where: zonetracker-scraper `origin/main@ff9fda0` .env.example:5-8 (same at local branch HEAD `2b340f9`)
- What / Why it matters: The dead `TWITTER_USERNAME=1500Red4034` + real email lines are still advertised at HEAD (values are dead v1.x credential-login leftovers, but they are real identity strings in a committed file); `SCRAPER_HANDLES_URL` — actually read at scraper.js:30 — is still absent from .env.example. The eco-untrack pass (#5) touched the neighboring ecosystem file but not this.
- Evidence: `git show origin/main:.env.example` lines 5-8 (real username/email visible; password line is a placeholder).
- Proposed fix: Replace .env.example with the 4 live vars (`INGEST_URL`, `MOBILE_SCRAPER_SECRET`, `SCRAPER_HANDLES_URL`, `BACKFILL`) + a comment that v2.0 auth is `browser_cookies.json`. (Effort S)
- Backlog: NEW (was S-05's own resolution text; never executed)

### R-03 [P3] [confidence: high] Mac satellite checkouts are stale/parked, weakening the only local verification path for satellite state
- Where: /Users/smokke/Documents/zonetracker-dashboard (branch `phase-2b2-dashboard-handles-toggle`, origin branch gone, 4 commits behind origin/main incl. the D-1 fix), /Users/smokke/Documents/zonetracker-dubclub (branch `fix/u1-browser-watchdog`, behind origin/main by 7)
- What / Why it matters: Both working trees are parked on merged/dead feature branches, so anyone (human or agent) reading the checkout instead of `origin/main` sees pre-fix code — e.g. the dashboard tree on disk still contains the D-1 crash. With no fly/ssh access, last-fetched `origin/main` refs were this audit's only satellite evidence, and their fetch age is unknown.
- Evidence: `git -C … status -sb` → `## phase-2b2-dashboard-handles-toggle...origin/phase-2b2-dashboard-handles-toggle [gone]`; `## fix/u1-browser-watchdog...origin/main [behind 7]`.
- Proposed fix: Check out `main` and fast-forward each satellite clone (an operator task — this audit is read-only); consider adding satellite checkout hygiene to the session-start checklist. (Effort S)
- Backlog: NEW

### R-04 [P3] [confidence: high] CODEMAP still says the resolver_events table "remains in the DB" though migration 030 drops it
- Where: docs/CODEMAP.md:118 and :473-474 vs migrations/030_drop_resolver_events.sql
- What / Why it matters: CODEMAP's resolver-retirement note ("Only the orphaned `resolver_events` table (481 rows) remains in the DB") and the §Other tables list (`resolver_events (orphaned)`) predate #80; migration 030 at this same HEAD drops the table. CODEMAP is the authoritative map — an operator would look for a table that no longer exists.
- Evidence: CODEMAP L473-474 quoted text; migrations/030 header "drop the orphaned resolver_events table".
- Proposed fix: Update both CODEMAP spots to "dropped by mig 030 (#80)". (Effort S)
- Backlog: NEW (pure doc edit)

## Looked good
- No REGRESSED finding anywhere: nothing verified fixed in either prior audit has come back. The two pre-annotated STALE items (F-02, F-07) remain correctly stale at HEAD.
- The doc-layer fixes held: CODEMAP grading_state/source enums, resolver retirement note, BACKLOG RESOLVED strikethroughs (#123) all still accurate at HEAD (modulo R-04).
- M-3's fix (#74) is thorough — `assessSearchResults` is wired into Bing with `checkRelevance:true` and DDG, with distinct `parse_empty`/`generic_news` telemetry statuses.
- Dashboard D-1 fix shipped **with** its recommended regression test (`test/upstream-midbody.test.js`), and dubclub U-1 shipped as a dedicated `browser-watchdog.js` module with box-side env knobs documented in SURFACE-PRO.md.
- fly.toml is fully clean of resolver references; migration 030 landed as specified.

## UNVERIFIED / open questions
- **Runtime vs HEAD:** prod is at v756-758; whether every FIXED row above is *deployed* was not checked (no fly access this track). "Merged ≠ deployed" applies to all main-repo rows.
- **M-9c** (`/data/bets.db` stray file), **M-14** (prod `QUOTE_BOUND_GRADING` value), and live WAL/table-size numbers (M-5) require prod access — not granted.
- **H-1/H-2/H-3**: no ssh to the Surface Pro; statuses are doc-claimed from docs/SURFACE-PRO.md only. pm2-logrotate presence, dubclub `config.json.bak`, and the `~/zonetracker` dead checkout are unknown.
- **Satellite fetch age:** each repo's `origin/main` ref is as of its last fetch (dates unknown); commits pushed since would not appear. Notably, scraper PR #5 (eco-untrack) exists locally at `2b340f9` but is NOT on last-fetched `origin/main` — whether it merged upstream is unverified (auto-memory says it shipped; not relied upon per evidence rule).
- **U-6/H-2 box files** (`ecosystem.config.cjs` on the Surface Pro) are gitignored by design — existence is doc-claimed via SURFACE-PRO.md:137, not observed.

## C. Env var inventory

# Env var inventory (00-baseline part C) — 2026-07-01 audit appendix

Worktree `/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07` @ HEAD `19ff594` (verified `git rev-parse HEAD`). Method: `grep -rnoE "process\.env\.[A-Za-z_0-9]+"` over all `*.js`/`*.ts` excluding `docs/` + `node_modules`, PLUS a second pass for bracket-notation/destructured reads (`process.env[...]` — hits: `commands/admin.js:727` knownSecrets, `services/ai.js:71,82` provider `keyEnv`, `services/localOcr.js:52` + `services/ocrFirstWiring.js:70` `intEnv(name)` — dynamic names resolved by reading callers). Fly secret NAMES from the 2026-07-02 capture in the track brief (values never seen). Doc'd: C = CODEMAP.md, S = SURFACE-PRO.md, n = neither (per grep of both docs at this HEAD).

## Inventory table

### A. Behavior/mode gates (grading + ingest)

| Var | Read site(s) | Doc'd | Fly | Gate semantics (actual comparison) |
|---|---|---|---|---|
| QUOTE_BOUND_GRADING | grading.js:3505 (resolver :137) | C | y | trim+lowercase enum off\|shadow\|enforce; **unknown/unset → shadow** (grading.js:137-140). BACKLOG:54 says prod=enforce (in-container verified 2026-06-10) |
| DATE_BOUND_GRADING | grading.js:3535 (resolver :228) | C | y | same trim+lowercase enum, unknown → shadow (grading.js:228-232). BACKLOG:542 says prod=enforce (verified 2026-06-15) — **CODEMAP:571 still says "Staged shadow; not yet flipped" = doc drift, see E-04** |
| EVENT_AWARE_RECHECK | grading.js:1052 (+4 test) | C | y | strict `=== 'enforce'` / `=== 'shadow'` else off, no trim/lower (grading.js:1051-1057) |
| EVENT_DATE_SLATE | sportsdata/index.js:345 (+3 test) | **n** | y | strict `=== 'shadow'`/`'enforce'` else off (index.js:344-349). Live value UNVERIFIED |
| SOCCER_GRADER_MODE | sportsdata/index.js:69, :195 (+3 test) | C | y | strict compare, no trim/lower (index.js:68-73); master kill-switch — unknown → off = BOTH classes off |
| SOCCER_PROPS_MODE | sportsdata/index.js:77, :195 (+3 test) | C | y | strict `'off'\|'shadow'\|'enforce'` else null=inherit `min(master,'shadow')` (index.js:76-80, :90-93) |
| GRADING_STATE_MACHINE_ENABLED | database.js:695 (sole runtime; +13 test) | **n** | y | `(env \|\| 'true') === 'false'` → legacy path; anything except literal `'false'` = enabled |
| CAN_FINALIZE_ENFORCE | grading.js:930 | **n** | y | `(env \|\| 'true') !== 'false'`; only literal `'false'` disables (fails toward enforce = safe direction) |
| AUTOGRADER_DISABLED | grading.js:1764; commands/admin.js:395-396 (toggle), :418, :609 | C | y | strict `=== 'true'` (grading.js:1764) — see E-02 |
| TWITTER_POLLER_DISABLED | twitter.js:90; admin.js:387-388 (toggle), :417, :610, :707 | C | y | strict `=== 'true'` (twitter.js:90) — see E-02 |
| GEMMA_FALLBACK_DISABLED | ai.js:983; scripts/test-team-disambiguation.js:58 | C | y | strict `=== 'true'` → fallback off — see E-02 |
| STRICT_MODE | messageHandler.js:805 | C | y | strict `=== 'true'` gates admin alert only |
| PRE_FILTER_MODE | messageHandler.js:1255, :1354 | **n** | y | `\|\| 'off'`; preFilter.js:52-53 accepts only `'shadow'`/`'enforce'`, else pass |
| PRE_FILTER_ENFORCE_BUCKETS | messageHandler.js:1256, :1355 | **n** | **n** | CSV → bucket opt-in; enforce drops ONLY opted-in buckets (preFilter.js:61-67) — see E-05 |
| OCR_FIRST_MODE | ocrFirstWiring.js:42 (+1 test) | **n** | y | trim+lowercase enum `off\|shadow\|cutover` else off (wiring.js:37-42); **module-load read** (restart to flip) |
| LINK_READER_MODE | linkReader.js:45 (+5 test) | C | y | strict `=== 'shadow' ? 'shadow' : 'off'`, module-load read; `cutover` treated as off |
| EVENT-gates footnote | applyGate3/4 consume the two `*_BOUND_GRADING` vars above | | | |

### B. Channel / routing IDs & maps (all CSV-or-single-ID, value-consumed)

| Var | Read site(s) | Doc'd | Fly | Notes |
|---|---|---|---|---|
| PICKS_CHANNEL_IDS | messageHandler.js:284, :327; system.js:13; admin.js:408, :716 (+10 test) | **n** | y | CSV split/trim/filter |
| HUMAN_SUBMISSION_CHANNEL_IDS | messageHandler.js:328, :906, :1235, :1332; bot.js:270-271, :531 (+11) | C | y | CSV; unset → human slips fall to PRE_FILTER drop (CODEMAP:566) |
| PURE_SLIP_CHANNEL_IDS | messageHandler.js:1239, :1336 (+9 test) | C | y | CSV; subset invariant vs HUMAN unenforced in code (CODEMAP:594 verify is a manual fly command) |
| DUBCLUB_SPLIT_CHANNEL_IDS | messageHandler.js:944 (+4 test) | C | y | CSV; GUARD-5 bypass |
| IGNORED_CHANNELS | bot.js:260-261; messageHandler.js:305; admin.js:405, :717 | **n** | y | CSV deny-list |
| TRACKED_CHANNELS | admin.js:404, :715 — **display-only, no gate** | **n** | y | see E-08 |
| SLIP_FEED_CHANNEL_ID | messageHandler.js:329, :619; bot.js:743; dashboard.js:83, :144; grading.js:3782 (+9) | C | y | single ID |
| SUBMIT_CHANNEL_ID | messageHandler.js:330, :905; admin.js:406, :719 | **n** | y | presence-guarded compare (`env && chId === env`) |
| SUBMIT_PICKS_CHANNEL_ID | messageHandler.js:1511 — `\|\| '1488236820700594197'` hardcoded | **n** | **n** | delete-originals branch — see E-10 |
| ADMIN_LOG_CHANNEL_ID | messageHandler.js:17, :805-809, :1538-1540; warRoom.js:28, :752, :813; replayHolds.js:132; dedupLeakCheck.js:139; routes/admin.js:352 (+4 script) | C | y | unset → hold embeds silently never post (CODEMAP:565) |
| WAR_ROOM_CHANNEL_ID | warRoom.js:28 (`\|\| ADMIN_LOG_CHANNEL_ID` fallback), :752, :813; messageHandler.js:711; grading.js:1999 (+3) | C | y | |
| DASHBOARD_CHANNEL_ID | dashboard.js:246; admin.js:256, :720 | **n** | y | |
| RECEIPTS_CHANNEL_ID | bot.js:743; dashboard.js:105; grading.js:3782 | C | y | |
| AUDIT_REPORT_CHANNEL_ID | healthReport.js:333 | **n** | y | unset → report silently not posted (`if (chId)`) |
| CAPPER_CHANNEL_MAP | messageHandler.js:370 | **n** | y | CSV `id:name` pairs |
| TWITTER_CAPPER_MAP | messageHandler.js:360 | **n** | y | CSV `id:name` pairs |
| CAPPER_DISCORD_IDS | messageHandler.js:912 | **n** | **n** | CSV whitelist for image-only human posts; unset → only bots/mapped channels pass that guard |
| ALLOWED_WEBHOOK_IDS | messageHandler.js:317 (+1 test) | C | y | CSV; unset → ALL relay ingestion denied `bot_not_whitelisted` (fail-closed, documented) |

### C. Keys / secrets / auth (presence-checked or value-consumed)

| Var | Read site(s) | Doc'd | Fly | Notes |
|---|---|---|---|---|
| DISCORD_TOKEN | bot.js:820; deploy-commands*.js; scripts/review-holds.js:680, :701 (+2) | **n** | y | |
| DISCORD_CLIENT_ID | deploy-commands.js:24, :31; deploy-commands-new.js:76-81; scripts/deploy-commands.js:7 | **n** | y | deploy scripts only |
| DISCORD_GUILD_ID | bot.js:518; warRoom.js:191; deploy scripts (+6) | **n** | y | |
| OWNER_ID | 68 refs — bot.js:68, :797-798; commands/admin.js ~20 gates; grade.js, audit.js, health.js, adminButtons.js, holdReview.js, twitter.js, healthReport.js | **n** | y | gate pattern `if (process.env.OWNER_ID && user.id !== OWNER_ID) deny` — **fails OPEN if unset**, see E-03 |
| ADMIN_API_SECRET | adminAuth.js:31 (timing-safe :22-27); bot.js:29; routes/admin.js:15 (+7 test) | C,S | y | **fail-closed 503 when unset** (adminAuth.js:30-34) — correct |
| MOBILE_SCRAPER_SECRET | routes/api.js:22, :71; bot.js:807 | C,S | y | header equality; unset → 401 all scraper posts |
| GROQ_API_KEY | ai.js:1346; grading.js:3369-3391; ocrFirst.js:101; system.js:24 (+dyn ai.js:71) | **n** | y | presence-gated provider |
| GEMINI_API_KEY | system.js:25 + **dynamic** ai.js:71/82 via `keyEnv:'GEMINI_API_KEY'` (ai.js:22) | **n** | y | |
| CEREBRAS_API_KEY | grading.js:3372-3373; grader-bench.js:20-22 (+dyn ai.js:71) | **n** | y | |
| MISTRAL_API_KEY / OPENROUTER_API_KEY | grading.js:3375-3376, :3384-3385; system.js:26 (+dyn ai.js:71) | **n** | y | |
| BRAVE_API_KEY | grading.js:2532, :2544 (+4 test) | **n** | y | search chain |
| SERPER_API_KEY | grading.js:2580, :2585 (+4 test) | **n** | y | |
| ODDS_API_KEY | odds.js:40; grading.js:1263; system.js:38 | **n** | y | |
| ODDS_API_KEY_BACKUP | odds.js:41 (key rotation :44-49) | **n** | y | |
| TWITTERAPI_KEY / APITWITTER_KEY | bot.js:611 (cron registered only if either set); twitter.js:96; audit.js:190, :194 | C | y | `TWITTERAPI_KEY \|\| APITWITTER_KEY` |
| TWITTERAPI_CREDIT_BUDGET | twitter.js:35 `parseInt(\|\| '10000')` | **n** | y | |
| OLLAMA_URL / OLLAMA_PROXY_SECRET / OLLAMA_MODEL | ai.js:59-60, :802-805 area; admin.js:1008 (11/12/2 refs) | C,S | y | Gemma path dead behind GEMMA_FALLBACK_DISABLED (CODEMAP:567) |
| OCR_SERVICE_URL / OCR_SERVICE_TOKEN | localOcr.js:43, :46 (call-time getters) | S | y | unset URL → localOcr unavailable |
| OCR_SPACE_API_KEY | ocr.js:14; system.js:37 (caller messageHandler.js:492) | **n** | y | legacy OCR.Space path still wired |
| SUPABASE_URL / SUPABASE_KEY | migrate-to-supabase.js:24, :31 only | **n** | **n** | dead one-off script |
| **TWITTER_EMAIL / TWITTER_PASSWORD / TWITTER_USERNAME** | **zero read sites anywhere** | **n** | y | DEAD — see E-01 |
| **APIFY_WEBHOOK_SECRET** | **zero reads** (bot.js:31 legacy Apify stub returns 410 without auth) | **n** | y | DEAD — E-01 |
| **RAPIDAPI_KEY / TWITTER_RAPIDAPI_KEY / BALLDONTLIE_API_KEY** | **zero read sites** | **n** | y | DEAD — E-01 |

### D. Models & tuning knobs (value-consumed, code defaults)

| Var | Read site(s) | Doc'd | Fly | Default when unset |
|---|---|---|---|---|
| GEMINI_MODEL | ai.js:21 | n | y | `gemini-2.0-flash` |
| GROQ_MODEL | ai.js:1404; ocrFirst.js:103 | n | y | `llama-3.1-8b-instant` |
| GROQ_TEXT_MODEL / GROQ_VISION_MODEL | ai.js:28 / :29 | n | n | code defaults |
| OPENROUTER_MODEL (vision) / OPENROUTER_TEXT_MODEL | ai.js:37 / :36 | n | y / n | code defaults |
| MISTRAL_MODEL (vision) / MISTRAL_TEXT_MODEL | ai.js:52 / :51 | n | n | `pixtral-12b-2409` / `mistral-small-latest` |
| CEREBRAS_MODEL | ai.js:44 | n | y | `gpt-oss-120b` |
| OLLAMA_VISION_MODEL | ai.js:815; admin.js:1020 | n | n | `gemma3:4b` (comment admin.js:1018: "not set in prod") |
| OCR_PARSE_MODEL / OCR_PARSE_TEMPERATURE | ocrFirst.js:103 / :104 | n | n | `GROQ_MODEL \|\| llama-3.3-70b-versatile` / 0 |
| OCR_TIMEOUT_MS | dyn: localOcr.js:47; ocrFirstWiring.js:73 (+4 test) | n | n | 8000 (matches memory "OCR_TIMEOUT_MS~8000" — that is the DEFAULT, not a set secret) |
| OCR_SHADOW_TIMEOUT_MS | dyn: ocrFirstWiring.js:77 — **invisible to `process.env.X` grep** | n | n | falls back to OCR_TIMEOUT_MS |
| OCR_IMAGE_MAX_BYTES | dyn: ocrFirstWiring.js:79 (+8 test) | n | n | 10MB |
| OCR_CIRCUIT_BREAKER_FAILS / _COOLDOWN_MS | dyn: localOcr.js:48 / :49 (+ tests) | n | n | 3 / 60000 |
| AUTO_GRADE_INTERVAL_MINUTES | bot.js:565 `\|\| 15` → cron template | n | y | see E-09 |
| DEFAULT_BANKROLL / DEFAULT_UNIT_SIZE | database.js:328-330; warRoom.js:129, :136; commands/dashboard.js:14 | n | y | numeric |
| ACTIVE_SEASON | database.js:175 `\|\| 'Beta'` | C (+SEASON-RESET.md) | y | value-consumed |
| AUDIT_MODE_DEFAULT | commands/system.js:39 (display only) | n | n | 'DB-controlled' |

### E. Infra / scripts / tests-only

| Var | Read site(s) | Fly | Notes |
|---|---|---|---|
| DB_PATH | database.js:8; healthReport.js:133; 15 scripts; 54 tests | **Dockerfile:15 ENV** `/data/bettracker.db` | see E-06 |
| PORT | bot.js:36 `\|\| 8080` | fly.toml:9 `[env]` | |
| NODE_ENV | **zero first-party reads** (library-only) | fly.toml:8 `[env]` + Dockerfile:14 | not dead — Express/deps consume |
| CLIENT_ID | scripts/deploy-commands.js:7 (`\|\| DISCORD_CLIENT_ID` fallback) | n | legacy alias, harmless |
| APP_ROOT / BETTRACKER_DB / WIN_H | scripts/s1b-measure.js:45-46; gate3/4-firing-check.js:17/:27 | n | ops scripts |
| VISION_FIXTURE_LIMIT / AI_ADAPTER_TEST_VERBOSE | tests only | n | |

**fly.toml `[env]` block (plain env, not secrets):** exactly `NODE_ENV='production'` + `PORT='8080'` (fly.toml:7-9). Dockerfile adds `ENV NODE_ENV=production` + `ENV DB_PATH=/data/bettracker.db` (Dockerfile:14-15). The dead `RESOLVER_URL`/`RESOLVER_VERSION` entries were already removed (BACKLOG:94).

## Findings

### E-01 [P2] [confidence: high] 7 dead Fly secrets, including a full Twitter credential set, with zero read sites
- Where: fly secrets (prod) vs whole-repo grep at HEAD 19ff594
- What / Why it matters: `TWITTER_EMAIL`, `TWITTER_PASSWORD`, `TWITTER_USERNAME`, `APIFY_WEBHOOK_SECRET`, `RAPIDAPI_KEY`, `TWITTER_RAPIDAPI_KEY`, `BALLDONTLIE_API_KEY` are set in prod but referenced NOWHERE in code (verified against dot-access, bracket-access, and destructuring patterns; the only bracket-dynamic readers resolve to other names). A live username+password credential sitting in the secret store with no consumer is pure attack/rotation surface, and the May-31 secret-rotation incident (BACKLOG:129 — rotation dropped ALLOWED_WEBHOOK_IDS entries, 860 posts lost) shows rotations here are error-prone; dead entries make the next rotation harder to reason about. Operators also read the secret list as a map of what's load-bearing.
- Evidence: `grep -rn "TWITTER_EMAIL\|APIFY_WEBHOOK_SECRET\|RAPIDAPI_KEY\|BALLDONTLIE_API_KEY" --include="*.js" --include="*.toml" .` → only hit is `fly.toml:8 NODE_ENV` (from the NODE_ENV probe); zero hits for all seven. Apify endpoint is a hardcoded 410 stub (bot.js:31 comment "Legacy Apify webhook stub (returns 410 Gone)") that never checks the secret.
- Proposed fix: `fly secrets unset` all seven at the next deploy window; rotate the Twitter password wherever that account still exists. (Effort S)
- Backlog: NEW

### E-02 [P2] [confidence: high] Both production kill-switches are strict `=== 'true'` — `1`/`yes`/`TRUE` silently no-op
- Where: services/grading.js:1764 (`AUTOGRADER_DISABLED`); services/twitter.js:90 (`TWITTER_POLLER_DISABLED`); services/ai.js:983 (`GEMMA_FALLBACK_DISABLED`); handlers/messageHandler.js:805 (`STRICT_MODE`)
- What / Why it matters: `if (process.env.AUTOGRADER_DISABLED === 'true')` means an operator running `fly secrets set AUTOGRADER_DISABLED=1` during an incident (the exact moment this switch exists for — stopping a mis-grading autograder) gets NO error and the grader keeps emitting grades. The confirmation UI (`/admin status` line, commands/admin.js:609) uses the same strict compare, so it would even display "▶️ Active", partially mitigating — IF the operator checks. The prime-directive failure mode is: wrong grades continue while the operator believes the system is paused.
- Evidence: grading.js:1764 `if (process.env.AUTOGRADER_DISABLED === 'true')`; twitter.js:90 identical shape; ai.js:983 `if (process.env.GEMMA_FALLBACK_DISABLED === 'true') return false`. The `/admin pause-grader` in-memory toggle writes the literal strings `'true'/'false'` (admin.js:395-396) so only the fly-secrets path is exposed.
- Proposed fix: normalize once (`['true','1','yes'].includes(String(v).trim().toLowerCase())`) in a shared `boolEnv()` helper; or at minimum log a loud warning when the var is set to an unrecognized value. (Effort S)
- Backlog: NEW

### E-03 [P2] [confidence: high] Owner gate fails OPEN when OWNER_ID is unset — `process.env.OWNER_ID && user.id !== OWNER_ID`
- Where: commands/admin.js:353, :371, :386, :394, :402, :425 … (~20 sites, same pattern); commands/grade.js:81, :134, :182, :217; commands/audit.js:58; handlers/adminButtons.js:23-24
- What / Why it matters: every OWNER gate short-circuits to ALLOW if `OWNER_ID` is falsy. If the secret is ever dropped (the May-31 rotation dropped secrets before), any guild member can run `/admin pause-grader`, `/grade override` (which corrects FINALIZED bets), revert-by-id, etc. Zero-enforcement invariant: nothing at boot asserts OWNER_ID is present.
- Evidence: commands/admin.js:386 `if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: '🚫' ... })` — the deny only fires when the var IS set.
- Proposed fix: fail closed (`if (!OWNER_ID || user.id !== OWNER_ID) deny`) or a boot-time assert that OWNER_ID is set. (Effort S)
- Backlog: NEW

### E-04 [P2] [confidence: high] CODEMAP "Env vars that gate behavior" is missing 5 live-set gates and is stale on DATE_BOUND_GRADING
- Where: docs/CODEMAP.md:561-576 vs fly secret list
- What / Why it matters: `EVENT_DATE_SLATE`, `PRE_FILTER_MODE`, `OCR_FIRST_MODE`, `GRADING_STATE_MACHINE_ENABLED`, `CAN_FINALIZE_ENFORCE` are all set in prod and all gate grading/ingest control flow, but none appear in the table that CODEMAP workflow rule 1 (:662) designates as the session-start map. Worse, the table's DATE_BOUND_GRADING row (:571) still says "**Staged shadow; not yet flipped**" while BACKLOG:542 records the enforce flip as SHIPPED 2026-06-15 and in-container verified — an operator trusting the authoritative doc would mis-model Gate 4 as inert. The last two vars also have the inverted default-on semantics (`(env||'true')==='false'`) that is exactly what the table exists to capture.
- Evidence: `grep -c EVENT_DATE_SLATE docs/CODEMAP.md` → 0 (same for the other four); CODEMAP.md:571 text vs BACKLOG.md:542.
- Proposed fix: add the 5 rows + correct the Gate-4 row in one docs PR. (Effort S)
- Backlog: NEW (docs); DATE_BOUND drift relates to existing "Gate 4 enforce flip" shipped item

### E-05 [P2] [confidence: high] `PRE_FILTER_MODE=enforce` silently degrades to shadow — `PRE_FILTER_ENFORCE_BUCKETS` is not set in fly
- Where: handlers/messageHandler.js:1255-1257, :1354-1356; services/preFilter.js:61-67
- What / Why it matters: enforce drops require the bucket to be listed in `PRE_FILTER_ENFORCE_BUCKETS` (`if (mode === 'enforce' && enforced) return {action:'drop'}` else `action:'shadow'`). That var is absent from the prod secret list, so the CSV parses to `[]` and NOTHING is ever enforced regardless of `PRE_FILTER_MODE`. Per-bucket opt-in is a deliberate design (#137 shipped as shadow), but the dependency is documented nowhere (E-04), so a future "flip PRE_FILTER_MODE=enforce" op would no-op with zero warning while the operator believes promo/recap non-bets are being dropped.
- Evidence: preFilter.js:64-67: `if (mode === 'enforce' && enforced) { return { bucket, reason, action: 'drop' }; } return { bucket, reason, action: 'shadow' };` — empty `enforceBuckets` → `enforced=false` always.
- Proposed fix: log a one-time warning when mode=enforce with an empty bucket list; document both vars together. (Effort S)
- Backlog: relates to "pre-hold filter" #137 follow-up (enforce flip)

### E-06 [P2] [confidence: high] Prod DB location hangs on a single Dockerfile ENV line; unset ⇒ silent fresh empty DB, no boot guard
- Where: Dockerfile:15; services/database.js:8-11
- What / Why it matters: `DB_PATH` is neither a fly secret nor in `fly.toml [env]` — the ONLY thing pointing prod at the mounted volume is `ENV DB_PATH=/data/bettracker.db` in the Dockerfile. If a Dockerfile refactor/base-image swap drops it, `database.js:8` falls back to `/app/bettracker.db`, `new Database(DB_PATH)` (:11) **creates** an empty DB, migrations run clean, and the bot boots green — all history invisible and all new bets written to ephemeral container FS, wiped next deploy. That is silent bet/data loss with zero enforcement (rubric P1-shaped; rated P2 because triggering requires a build-config regression, not normal ops).
- Evidence: Dockerfile:15 `ENV DB_PATH=/data/bettracker.db`; database.js:8 `const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db')`; no `existsSync`/mount assertion in database.js or bot.js (grep shown above — only migrator checks its own migrations dir).
- Proposed fix: boot guard — if `NODE_ENV==='production'` and (`!process.env.DB_PATH` or DB file did not pre-exist and bets table is empty while `/data` is mounted), log fatal + exit. (Effort S)
- Backlog: NEW

### E-07 [P3] [confidence: high] Enum mode flags split between two comparison idioms — strict-compare ones turn OFF on case/whitespace typos
- Where: sportsdata/index.js:68-80 (SOCCER_*), grading.js:1051-1057 (EVENT_AWARE_RECHECK), sportsdata/index.js:344-349 (EVENT_DATE_SLATE), linkReader.js:45 vs the trim+lowercase resolvers grading.js:137-140/:228-232 and ocrFirstWiring.js:37-42
- What / Why it matters: `SOCCER_GRADER_MODE` is the MASTER kill-switch; `if (m === 'shadow')... if (m === 'enforce')... return 'off'` with no trim/lowercase means a future `fly secrets set SOCCER_GRADER_MODE="enforce "` (trailing space, or `Enforce`) silently turns the deterministic soccer adapter OFF — and with `SOCCER_PROPS_MODE=enforce` live (per memory, UNVERIFIED in-container), soccer bets fall back to the search-grader path that produced the wrong grades the adapter was built to stop. Gates 3/4 already solved this ("a stale/typo'd env value cannot start forcing PENDINGs unannounced", grading.js:134-135) — the idiom just wasn't propagated.
- Evidence: index.js:69-73 vs grading.js:137-140 (quoted above in table).
- Proposed fix: one shared `resolveMode(raw, validSet, fallback)` with trim+lowercase across all six flags. (Effort S)
- Backlog: NEW

### E-08 [P3] [confidence: high] TRACKED_CHANNELS is a set secret that gates nothing — display-only
- Where: commands/admin.js:404 (`list-channels` count), :715 (status count); no other runtime read
- What / Why it matters: `/admin list-channels` prints "**TRACKED_CHANNELS:** N channel(s)" alongside vars that DO gate routing, implying it authorizes ingestion. Actual channel authorization is PICKS/HUMAN/SLIP/SUBMIT (messageHandler.js:327-330). An operator adding a channel to TRACKED_CHANNELS to "track" it changes nothing — operator-deception by UI.
- Evidence: full read-site list above; messageHandler routing gates never reference it.
- Proposed fix: unset the secret and drop the two display lines, or label it "(informational, no gate)". (Effort S)
- Backlog: NEW

### E-09 [P3] [confidence: med] AUTO_GRADE_INTERVAL_MINUTES interpolated into a cron pattern with zero validation
- Where: bot.js:565-566
- What / Why it matters: `` cron.schedule(`*/${gradeInterval} * * * *`, ...) `` — a secret value of `0`, `abc`, or `15 *` produces an invalid/mangled pattern; node-cron throws at `schedule()` which runs at boot → whole-bot crash loop (ingestion AND grading down) from one bad knob. Med confidence: cannot execute node-cron in this worktree to confirm throw-vs-tolerate for every malformed value.
- Evidence: bot.js:565 `const gradeInterval = process.env.AUTO_GRADE_INTERVAL_MINUTES || 15;` then direct template interpolation :566.
- Proposed fix: `parseInt` + range-clamp (1-59) with fallback 15. (Effort S)
- Backlog: NEW

### E-10 [P3] [confidence: high] SUBMIT_PICKS_CHANNEL_ID is a phantom twin of SUBMIT_CHANNEL_ID with a hardcoded channel fallback
- Where: handlers/messageHandler.js:1511-1513
- What / Why it matters: the delete-originals ("Inbox Zero") branch keys on `process.env.SUBMIT_PICKS_CHANNEL_ID || '1488236820700594197'` — a var set nowhere in prod — while every other submit-channel check uses the fly secret `SUBMIT_CHANNEL_ID` (:905). If the real submit channel is ever moved (secret updated), message deletion silently keeps targeting the hardcoded ID; conversely nobody knows this knob exists to set.
- Evidence: messageHandler.js:1511 `const submitChannel = process.env.SUBMIT_PICKS_CHANNEL_ID || '1488236820700594197';`
- Proposed fix: collapse onto `SUBMIT_CHANNEL_ID` (keep hardcoded value only as last-resort fallback) and remove the twin name. (Effort S)
- Backlog: NEW

## Looked good
- `ADMIN_API_SECRET` auth is fail-closed (503 when unset) with timing-safe compare and no token echo (routes/adminAuth.js:22-34).
- Gate 3/4 mode resolvers fail safe to shadow on unknown values, explicitly to prevent unannounced enforce (grading.js:133-140, :224-232).
- `ALLOWED_WEBHOOK_IDS` unset fails closed (all relay bots denied), and is documented with its incident history (CODEMAP:573, :578).
- `SOCCER_PROPS_MODE` inherit ladder caps inherited enforce at shadow — a match-level enforce flip cannot silently enforce props (sportsdata/index.js:90-93).
- AI provider models are hot-swappable env getters with sane defaults (ai.js:15-64) — matches the Cerebras-swap runbook need.
- fly.toml `[env]` is minimal (NODE_ENV, PORT) with the dead resolver entries already removed (BACKLOG:94).
- OCR knobs read at call time via `intEnv` with validated positive-int fallbacks (localOcr.js:47-55).

## UNVERIFIED / open questions
- Actual prod VALUES of every secret (never seen; per track rules). Specifically unverified: `EVENT_DATE_SLATE` mode, `PRE_FILTER_MODE` mode, `OCR_FIRST_MODE` mode, `SOCCER_PROPS_MODE=enforce` (memory says LIVE 2026-06-26; in-container check not permitted this track), `STRICT_MODE` value, `GEMMA_FALLBACK_DISABLED` value.
- Whether the running image (v756-v758) matches HEAD 19ff594 for any line cited — all citations are HEAD-only.
- Whether node-cron tolerates or throws on malformed patterns for E-09 (no node_modules in this worktree; not executed).
- `PURE_SLIP ⊂ HUMAN` subset invariant currently holding in prod (verification command exists at CODEMAP:596-598 but requires fly ssh — out of scope).
- Whether any DEPLOY_CHECKLIST/RUNBOOKS doc (not grepped exhaustively beyond CODEMAP/SURFACE-PRO/BACKLOG) documents the vars marked Doc'd=n.
