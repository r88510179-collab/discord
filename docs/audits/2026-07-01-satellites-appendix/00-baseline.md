# 00 — Baseline + regression sweep

## 1. Pinned revisions (audit inputs)

All satellite analysis ran against **fresh clones** (`gh repo clone`, Mac-side scratch, never
the existing checkouts); bot-side contract reads ran in this audit's own worktree of the
discord repo at `origin/main`.

| Repo | Pinned HEAD | Committed | Last commit |
|---|---|---|---|
| bettracker-discord-bot | `19ff594` | 2026-07-01 | feat(admin): Phase A read endpoints (#161) |
| zonetracker-scraper | `ff1a906` | 2026-06-10 | Merge #5 chore/eco-untrack |
| zonetracker-dubclub | `633d084` | 2026-06-12 | Merge #6 docs/sync-2026-06-11 |
| zonetracker-dashboard | `d392754` | 2026-06-17 | slip thumbnail on Holds rows (#9) |
| zonetracker-ocr | `e21ee2c` | 2026-06-02 | docs(readme): deploy steps (#—) |
| zonetracker-ollama-proxy | `62b8c6b` | 2026-06-10 | Initial commit: auth gate |

`zonetracker-ollama-proxy` was added to the clone set beyond the prompt's four because the
T6 contract edge (bot → ollama-proxy) and the host exposure table require its code at a
pinned HEAD; treated read-only like the rest.

## 2. Pro checkout vs origin/main (drift check)

Method: Pro-side `git rev-parse HEAD` / `status --porcelain` / `log -1` (whitelist) compared
against origin/main SHAs taken from the Mac-side clones — **no fetch ran on the Pro**.

| Checkout | Pro HEAD | origin/main | Verdict |
|---|---|---|---|
| zonetracker-scraper | `ff9fda0` | `ff1a906` | **DRIFT — 1 behind**, and dirty: ` M ecosystem.config.js`, stray `.bak.20260610-115918`. The missing merge (#5) is precisely the commit that *untracks* `ecosystem.config.js`; deploying it via the documented `git pull` will conflict with the live env-bearing local file. Finding SC-6/HO-3. |
| zonetracker-dubclub | `633d084` | `633d084` | ✓ current; expected local state (`M config.json`, untracked canonical `ecosystem.config.cjs`, `config.json.bak-20260610`, `storageState.json.bak-20260615`) — none of it reproducible from git; finding DC-6. |
| zonetracker-dashboard | `d392754` | `d392754` | ✓ current, clean. |
| zonetracker-ocr | `e21ee2c` | `e21ee2c` | ✓ current, clean. |
| ollama-proxy | `62b8c6b` | `62b8c6b` | ✓ current, clean. |

Runtime identity cross-checks: OCR `/version` reports v0.1.0 rapidocr-onnx 1.4.4 PP-OCRv4
started 2026-06-29 (matches `e21ee2c` constants); scraper boot banner + `[Handles] fetched
8 active from Fly` matches `ff9fda0` behavior; dashboard boot line advertises the #7/#8/#9
feature set. Box rebooted 2026-06-29 00:24 ET; all five apps resurrected by `pm2-tracker`.

## 3. Regression table — every 2026-06-10 satellite/host finding

Statuses: **FIXED** (commit + live runtime evidence where behavioral) / **FIXED-CODE,
UNVERIFIED-LIVE** (fix at HEAD; runtime proof out of whitelist reach) / **OPEN** /
**REGRESSED** / **STALE**. Evidence columns cite pinned-clone file:line or probe (P-n =
20-live-probes.md).

| ID | June sev | Status | Evidence (repo@HEAD file:line and/or probe) | Note |
|---|---|---|---|---|
| S-01 | P1 | **FIXED (live-fire proven)** | scraper@ff1a906 `watchdog.js:53-64` classifyExtraction→SELECTOR_DRIFT, `scraper.js:155-160` throws so drift strikes (never resets); dead-air watchdog `watchdog.js:75-125`. Live: P-4a — the Jun 23 outage fired the full machine (`[Strike] 5/5`, `[Disable] cooldown 6h`, `[DeadAir] … 5/3→77/3`, `[Alarm] 🚨` re-firing, ✅ recovery). Box @ff9fda0 = PR #4 merge. | BACKLOG:64-65 accurate. Residual blind spots: SC-6 (wedged cycle mutes the alarm), SC-8/CT-5 (alarm webhook shares the failure domain — died Jun 23), bot-side "no-ingest-for-N-h" complement never built. |
| S-02 | P2 | **OPEN** | scraper@ff1a906 `scraper.js:112-115` — initBrowser catch returns false with no `shutdownBrowser()`; module `browser` overwritten next cycle (`:102`). Live P-4a: `[Init] Browser launched` every 5 min. | SC-5. Chromium orphan per cycle on a post-launch cookie-parse failure. |
| S-03 | P2 | **OPEN** | scraper@ff1a906 no deadline wrapper (`cron.schedule … runCycle` :395); un-timeouted `page.$$eval`/`page.evaluate` :138/:142/:148; `cycleInProgress` :333-336 permanent-zombie. | SC-6. NEW-1: the hang is also invisible to the S-01 alarm (recordCycle never runs). |
| S-04 | P2 | **OPEN (partial)** | example@ff1a906 gained `log_date_format`/`merge_logs` but still no `exp_backoff_restart_delay` (`:27-28`); P-3 `~/.pm2/modules` empty (no logrotate). | SC-14. Boot-loop→silent-`errored` class unchanged. |
| S-05 | P3 | **OPEN (partial)** | scraper@ff1a906 `.env.example:5-8` still ships dead `TWITTER_*` block with **real burner values**; README env table now covers the live vars. | SC-10. README half fixed by #4; .env.example untouched. |
| S-08 | P3 | **OPEN** | scraper@ff1a906 `scraper.js:380` prints built-in fallback length (9); live set DB-driven, currently 8 (P-4a `[Handles] fetched 8`). | SC-11. |
| M-16a | P3→**P1** | **OPEN** | bot@19ff594 `routes/api.js:49-55` ACK 200 before async processing; no `ingest_queue`; scraper advances cursor on the 200. | SC-1/CT-1. Re-rated P1 (silent feed loss) under this rubric. |
| M-16b | P3→**P1** | **OPEN** | bot@19ff594 `twitter-handler.js:117-119` `if(!tweetId||!text)`→drop **before** imageUrls checked. | SC-2/CT-1. Caption-less slips always lost; amplifies a `tweetText` selector drift into total silent loss. |
| U-1 | P1 | **FIXED (live)** | dubclub@633d084 `browser-watchdog.js` (PR #2); wired `index.js:326-339`, armed `:365`. Live P-4d: "Browser watchdog armed …" on every boot. | BACKLOG:66 accurate. But DC-4: crash-restarts (~4/day) reset its 24h dead-air clock so it structurally can't fire. |
| U-2 | P2 | **OPEN** | dubclub@633d084 `index.js:230-244` split loop breaks on first non-2xx, re-posts from pick 0; no 429 handling; flag-add failure log-only. | DC-2/CT-3. Bot webhook path has no content dedup (fingerprint keys `source_message_id`). |
| U-3 | P2 | **OPEN** | dubclub@633d084 no sweep `setInterval`; triggers = boot/`exists`/relaunch only. | DC-12/CT-8. Masked in practice by ~4/day crash-restarts. |
| U-4 | P2 | **FIXED** | dubclub@633d084 `split-picks.js:66-75` auditSplit + `index.js:214-227` raw-scrape log + alertAdmin on dropped lines; splitter hardened (#1/#3/#4/#5). | Goes beyond June (immediate alert). Residual silent class = DC-11. |
| U-5 | P3 | **OPEN** | dubclub@633d084 `index.js:95-126` scrapePicks still longest-innerText incl. `main`; dubclub BACKLOG:17 still "cosmetic only". | DC-11. |
| U-6 | P3 | **FIXED (alternate); content UNVERIFIED-LIVE** | Box runs untracked `ecosystem.config.cjs` (P-2), documented canonical in SURFACE-PRO.md:117-123 / BACKLOG:69-70. | DC-9/HO-5. Restart policy in that file unverifiable under whitelist; dubclub README:70 still says "no ecosystem file" (drift). |
| U-7 | P3 | **OPEN (live)** | dubclub@633d084 `index.js:153` full-body `fetchOne` before filtering; no skippedUids/cooldown. Live P-4d: `login wall … Alerting admin, leaving unseen` re-fires every sweep, 97 times Jun 29→Jul 2. | DC-1/DC-7. |
| U-8 | P2 | **OPEN** | dubclub@633d084 `.env.example` + README omit `LOCKEDIN_WEBHOOK_URL` (config.json needs it). | DC-9. |
| U-9 | P3 | **OPEN** | dubclub@633d084 alert text `index.js:199` still says `npm run seed`; working path is seed-mac.js→scp (README:98, watchdog comment :330). | DC-1. The wrong fix is being emitted in the live wall alerts right now. |
| U-10 | P3 | **OPEN** | dubclub CODEMAP:25-26 anchors requireEnv L23/extractPlaysUrl L54 vs actual `index.js:27/:58`. | DC-9. Drift grew to +4 through PR #6 ("docs sync"). |
| U-11 | P3 | **OPEN** | dubclub@633d084 `context.storageState()` never re-persisted (read-only at `:322/:332`); no JSON validation. | DC-1. Root cause of the fixed ~14-day session death → live wall. |
| U-12 | P3 | **OPEN** | dubclub@633d084 `package.json` scripts = seed/start; tests/ (split + watchdog) unwired. | Test surface grew, wiring gap unchanged. |
| D-1 | P2 | **FIXED** | dashboard@d392754 `server.js:118-125` body read in try/catch→502 JSON; `test/upstream-midbody.test.js` reproduces the crash. Live P-4e: recover TimeoutErrors absorbed, pm2 ↺0/3D. | BACKLOG:67 accurate. |
| D-2 | P3 | **FIXED** | dashboard@d392754 `server.js:30` HOST hardcoded `127.0.0.1`; accurate header comment `:8-16`; no false "auth-gate" claim anywhere. Live P-6: `:8444` tailnet-only serve. | Compensating-control claim now accurate. Mount-order pin test not added (DB-7). |
| D-3 | P3 | **FIXED (1 residual)** | dashboard@d392754 `server.js:63` + `app.js` comments + `test/proxy.test.js` all say FOUR writes; but `public/index.html:18` still renders "Read-only dashboard". | DB-6. |
| D-4 | P3 | **OPEN** | dashboard@d392754 `server.js:126` unconditional per-request log; no `log_date_format`; P-3 no logrotate. | DB-5. Volume benign (poll opt-in); NEW-2: error lines are undatable (bit incident forensics). |
| D-5 | P3 | **OPEN** | dashboard@d392754 `index.html:9` Pico from jsdelivr floating `@2`, no SRI. | DB-8. |
| D-6 | P3 | **OPEN** | dashboard@d392754 `app.js:92-100` discordUrl rendered as href unvalidated (`:110/:119/:1158-1161` — #9 slip-link is a new 3rd site); no safeHttpUrl. | DB-4. Surface grew with #9. |
| D-7 | P3 | **OPEN** | dashboard@d392754 README (235 ln) `grep -i troubleshoot`=0. | Unchanged. |
| D-8 | P3 | **OPEN** | dashboard@d392754 path-escape guard `server.js:137-149` present, no `%2e%2e` test. | DB-7. |
| H-1 | P3 | **OPEN (growing, 3rd filing)** | P-3: `~/.pm2/modules` empty (no logrotate; even June's "ollama-proxy module" gone — dir mtime Apr 9 ⇒ never installed); logs 41M→46M, dubclub-error 16M→20M. | HO-4. |
| H-2 | P3 | **OPEN (shape changed)** | dubclub half via U-6 (untracked cjs); scraper half inverted — box @ff9fda0 runs the tracked+modified `ecosystem.config.js` (P-2) that origin #5 deleted. pm2 env convergence UNVERIFIED (whitelist). | HO-3/HO-5. |
| H-3 | P3 | **OPEN (partial); (c) REGRESSED** | (a) no committed never-run list for `pm2 conf`/`jlist`; (b) `zonetracker-stats` now doc'd (FIXED), `~/zonetracker` dead checkout UNVERIFIED; (c) bak files multiplied — dubclub gained `storageState.json.bak-20260615`, scraper carries `ecosystem.config.js.bak…` (P-2). | HO-8. |

**Scorecard: 7 of 25 closed** — FIXED: S-01, U-1, U-4, D-1, D-2; FIXED-with-caveat: U-6 (alternate, live content unverified), D-3 (UI label residual). Both June P1s (S-01, U-1) are closed and live-verified. Everything else OPEN, mostly P3 hygiene — but U-7/U-9/U-11 are compounding into a live multi-day GNP feed outage (DC-1), and M-16a/M-16b (re-rated P1) plus the webhook-edge loss (CT-2) are unaddressed silent-feed-loss holes. Nothing REGRESSED in behavior; regressions are hygiene (H-3c bak accumulation) and doc-drift accumulation.

## 4. Sources

- June baseline: `docs/audits/2026-06-10-coa-full-audit.md` §§C–D (+§F.9 host snapshot).
- Live probes: `20-live-probes.md` (P-1 … P-8).
- Ship-status claims cross-checked against `docs/BACKLOG.md` (2026-06-10 close-out section)
  and `docs/SURFACE-PRO.md`; where code contradicted docs it is filed as a drift finding,
  not silently reconciled.
