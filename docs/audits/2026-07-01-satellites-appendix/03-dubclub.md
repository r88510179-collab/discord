> Track analysis produced by a read-only audit subagent from pinned clones + probe captures;
> reviewed, spot-verified (high-severity evidence lines re-read by the orchestrator), and filed
> by the audit orchestrator. Probe references (P-n, probes/*.txt) resolve to 20-live-probes.md.

# T3 — zonetracker-dubclub @633d084 (audit 2026-07-02)

Clone: /tmp/zt-satellite-audit/zonetracker-dubclub. Box state from probes (checkouts.txt: box @633d084 == origin/main, ` M config.json`, untracked ecosystem.config.cjs + config.json.bak-20260610 + storageState.json.bak-20260615; pm2-list.txt: id 3, fork, uptime 6h, ↺12). Tests: `node tests/split-picks.test.js` → "All assertions passed" at HEAD (run 2026-07-02, node v25.8.1).

## Findings

### DC-1 — LIVE P1: GNP feed fully down since 2026-06-29 ~20:02 ET (expired DubClub session), 4 sheets in limbo, and the alert that fires tells the operator a broken recovery procedure
- **Severity/confidence:** P1 / high.
- **Evidence:** probes/tails-pm2-logs.txt line 95 first wall (`2026-06-29 20:02:34 ... UID 11484: login wall detected for capper GuessAndPrayBets`) through line 201 (`2026-07-02 08:23:47 ... UID 11514`) — 97 wall detections in the error-log tail; UIDs 11484/11485 (Jun 29-30), 11499 (first seen Jul 1 09:25), 11514 (first seen Jul 2 08:23) — GNP kept publishing while nothing delivered. Wall path: index.js:196-203 alerts + leaves unseen. Box `storageState.json.bak-20260615` (probes/checkouts.txt:12) ⇒ last re-seed Jun 15 ⇒ ~14-day session life. Contributors, both verified open at HEAD: **U-11** — `context.storageState()` is never called after seeding (grep of index.js: zero hits; storageState only *read* at index.js:322 and browser-watchdog createContext, index.js:332), so refreshed cookies are thrown away and the session dies at fixed expiry; **U-9** — the alert text at index.js:199 says `re-run \`npm run seed\` on the Surface Pro`, but the recorded working procedure is seed-mac.js on the Mac + scp (docs/SESSION-LOG.md:52; the watchdog's own comment index.js:330-331 says "seed-mac.js on the Mac -> scp"). GNP has no fallback path: the scraper handle `guess_pray_bets` is disabled bot-side (worktree docs/BACKLOG.md:28) — the DubClub bridge is GNP's only ingest. With TeamLockTalk removed from box config (DC-9), the bridge's entire live feed is currently zero.
- **Impact:** 2.5+ days of total GNP pick loss (feed-loss, alerted ~97 times yet unremediated — see DC-7 alert fatigue); ongoing until re-seed.
- **Proposed fix:** (now) re-seed via seed-mac.js + scp; then (S) correct the alert text at index.js:199; (S) persist `await ctx.context.storageState({ path: STORAGE_PATH })` after each successful scrape + JSON-validate in ensureSeedExists (June U-11 patch); (S) alert cooldown per DC-7.
- **Effort:** S (each part). **BACKLOG:** June U-9 + U-11, both still open at HEAD; incident itself NEW.

### DC-2 — U-2 still open: at-least-once re-post with no per-pick progress, no 429 handling, alertless flag-add failure — and the bot's webhook path cannot dedup re-posts
- **Severity/confidence:** P2 (borderline P1 under the rubric's "duplicate-feed"; war-room human gate is the only stop) / high.
- **Evidence:** index.js:231-255 — split loop posts pick i, on any non-2xx/throw breaks (:239-247) and leaves unseen (:251-254); next sweep re-posts **from pick 0**, duplicating picks 1..i-1 into Discord. No `retry_after`/429 handling anywhere (grep: zero hits); only a fixed 400ms spacing (:249). `\Seen` correctly set only after all posts succeed (:276), but a `messageFlagsAdd` failure is errlog-only (:277-279) — a persistently failing flag-add re-posts the whole sheet **every sweep** with no alert. Bot-side (worktree @19ff594): dedup is `buildFingerprint` keyed on `source_message_id` (services/database.js:305,310) — every bridge re-post is a new Discord message id ⇒ new fingerprint ⇒ never deduped; the twitter path's 12h content-window dedup (services/twitter-handler.js, PR #53) does not exist on the webhook path, and split-channel posts bypass the buffer straight into processAggregatedMessage (messageHandler.js:944-962). Only the war-room needs_review approval stops duplicate bets rows (messageHandler.js:942-943 comment; SESSION-LOG.md:63 live-verified reject).
- **Impact:** duplicate picks in the capper channel + war-room on any mid-sheet failure; unbounded repeat if flag-add fails.
- **Proposed fix:** June U-2 patch — persist per-email progress keyed `UIDVALIDITY:UID` (resume at k), honor 429 retry_after, alertAdmin on flag-add failure. **Effort:** M. **BACKLOG:** June U-2, unchanged at HEAD.

### DC-3 — IMAP connect failure = alertless, backoff-less crash-loop that burns a Chromium per cycle; PM2 restart policy is unknowable from the repo
- **Severity/confidence:** P2 / high (loop mechanics); med (PM2 policy — .cjs untracked).
- **Evidence:** boot order launches Chromium (index.js:321) **before** `client.connect()` (index.js:367); any connect-time error (EAI_AGAIN, AUTHENTICATIONFAILED, TLS) rejects `main()` → `process.exit(1)` with a bare console.error (index.js:410-413) — **no alertAdmin on the FATAL path**. Live: probes/tails-pm2-logs.txt lines 1-74, Jun 23 18:23:50-18:24:03 — ≥9 `FATAL: getaddrinfo EAI_AGAIN imap.gmail.com` cycles at constant ~1.5s gaps (constant gaps ⇒ no `exp_backoff_restart_delay` in the box's ecosystem.config.cjs, the exact knob June U-6's resolution called for); again at Jun 29 boot (line 86, network up later than PM2). Repo history already records a 325+ restart AUTHENTICATIONFAILED loop (docs/CODEMAP.md:33). Because ~1.5s uptime exceeds PM2's default 1s min_uptime, the loop never parks "errored" — it churns Chromium launches indefinitely, silently (dead-air alarm can't fire either, DC-4). The .cjs that governs all of this is untracked (DC-9), so none of it can be verified or reproduced from the repo.
- **Impact:** sustained DNS/Gmail-auth outage = silent total feed loss + CPU/log churn; S-04-class.
- **Proposed fix:** in-process connect retry with capped backoff + alertAdmin after N failures; move `chromium.launch` after successful IMAP connect; commit a sanitized ecosystem.config.cjs(.example) with `exp_backoff_restart_delay`. **Effort:** S/M. **BACKLOG:** NEW (June S-04 class; U-6 follow-through).

### DC-4 — Dead-air alarm is structurally unable to fire: crash-only restarts (~4/day) reset its in-memory clock, and cleanup() disables it during shutdown hangs
- **Severity/confidence:** P2 (operator-deception — the alarm is documented as the safety net) / high.
- **Evidence:** `lastSuccessAt = now()` at watchdog construction (browser-watchdog.js:98), fed only by successful scrape→post (index.js:274); state is process-local. The bridge exits on every IMAP close (index.js:398-401) — probes/pm2-list.txt:6 shows ↺12 with 6h uptime; close-exits at ~4/day in the log tail. 24h threshold (browser-watchdog.js:21, armed-line in logs matches defaults exactly) is therefore never reached. **Live proof:** GNP delivery dead since Jun 29 20:02 ET with restarts at Jun 29 21:31, Jun 30 06:10/07:51, Jul 1 06:02/06:13/13:29/13:40, Jul 2 01:16/02:15 (tails-pm2-logs.txt lines 96-194) — no `Dead-air alarm` line anywhere in the probe. Additionally cleanup() calls `watchdog.stop()` first (index.js:355 → browser-watchdog.js:226-229 sets stopped, clears the probe timer), so if cleanup hangs (DC-5) the alarm is off exactly when needed.
- **Impact:** the one alarm meant to catch "everything quiet too long" can never observe >24h of quiet; multi-day outages (like the current one) rely solely on the spammy wall alert.
- **Proposed fix:** persist lastSuccessAt to disk (tiny JSON next to storageState) and load at boot; or derive from the newest \Seen DubClub message date at startup. **Effort:** S. **BACKLOG:** NEW (undermines the U-1 fix's stated coverage).

### DC-5 — cleanup() has no timeouts: a wedged Chromium at IMAP-close time turns crash-only exit into a silent zombie
- **Severity/confidence:** P2 / medium (requires zombie Chromium coinciding with IMAP close — the exact U-1 scenario).
- **Evidence:** index.js:350-359 — `await client.logout()` then `await (watchdog.getBrowser() || browser).close()` with no timeout before `process.exit(code)`; contrast the watchdog's own recover(), which wraps browser.close in `withTimeout(...,5000)` (browser-watchdog.js:167) precisely because zombie-Chromium close can hang. If close hangs, process.exit never runs: IMAP dead, sweeps never resume, PM2 green, probe timer already cleared by watchdog.stop() (index.js:355) so neither relaunch nor dead-air can act.
- **Impact:** exit-vs-zombie gap in the crash-only design; silent total outage until manual restart.
- **Proposed fix:** wrap both awaits in withTimeout (export it from browser-watchdog.js) + `setTimeout(() => process.exit(code), 10_000).unref()` guard at cleanup() entry. **Effort:** S. **BACKLOG:** NEW.

### DC-6 — Webhook-failure blindness, both directions: bridge never alerts on non-2xx posts, and an ALLOWED_WEBHOOK_IDS miss makes the bridge mark \Seen on picks the bot silently drops (May 31 dark-channel class)
- **Severity/confidence:** P2 latent (the class already caused a P1: ~860 posts lost May 31→Jun 11) / high.
- **Evidence:** bridge: split-post failure → errlog only (index.js:241,246,252); whole-slip non-2xx → errlog only (index.js:269-270) — no alertAdmin on either, unlike login-wall/empty-scrape. So a rotated/deleted webhook URL (Discord 401/404) = every-sweep retry loop visible only in logs. Worse inversion: if the webhook URL is valid but its **ID** falls out of the Fly secret `ALLOWED_WEBHOOK_IDS`, Discord returns 2xx → bridge marks `\Seen` (index.js:276) and moves on, while the bot denies at globalPipelineGuard (worktree messageHandler.js:315-325) and records `BOUNCER_REJECTED` (messageHandler.js:817-826) — pick permanently lost (single-use CTA consumed), bridge believes success. History: exactly this killed 4 relay channels May 31→Jun 11 (~860 posts, worktree docs/BACKLOG.md:128-129); allowlist restored to 6 IDs incl. both bridge webhooks 2026-06-11. Bot-side denial is now at least queryable via the Phase A `/api/admin/drops` endpoint (#161); STRICT_MODE channel alert exists but its enablement is env-only (UNVERIFIED).
- **Impact:** webhook rotation without secret update = silent end-to-end loss again; bridge-side hard failures are log-only.
- **Proposed fix:** bridge: alertAdmin (with cooldown) on any non-2xx post; ops: rotation runbook step "update ALLOWED_WEBHOOK_IDS in the same change" (README:26 already says append-never-overwrite — add the rotation case); optional bot-side: daily BOUNCER_REJECTED count alert. **Effort:** S. **BACKLOG:** NEW bridge-side; bot-side maps to the Jun 11 restoration note.

### DC-7 — U-7 still open, now live-costly: login-wall alert has no cooldown (~97 admin pings in 2.5 days) and permanently-skipped UIDs re-download full bodies every sweep
- **Severity/confidence:** P2 (alert fatigue is plausibly why DC-1 sat unremediated 2.5 days) / high.
- **Evidence:** alert fires inside processOneEmail per walled UID per sweep (index.js:198-200), no dedup/cooldown: 97 `login wall detected` lines in the error-log tail = 97 alertAdmin posts, 3-4 per sweep by Jul 2 (tails-pm2-logs.txt:198-201). Every sweep also `fetchOne(uid, { source: true })` + simpleParser (index.js:153-158) **before** any subject/config filtering — the 6-email permanent-skip set (receipt UID 11261, trial 11262, ZoeLab 11336 + walled GNP UIDs) is re-fetched and re-parsed in full on every sweep, forever (out-log: identical skip lines at 07:15, 09:25, 10:00, 10:18, 10:21, 10:42, 11:02, 11:10, 11:24, 13:00... tails-pm2-logs.txt:205-278).
- **Impact:** admin channel drowned during incidents (operator-deception via fatigue); growing per-sweep IMAP/CPU cost as skip-set accumulates.
- **Proposed fix:** June U-7 patch — envelope-first fetch, process-lifetime skippedUids set, 1h alert cooldown keyed by capper. **Effort:** S. **BACKLOG:** June U-7, unchanged.

### DC-8 — ZoeLab capper emails arriving since ≥Jul 1 but not in config.json: picks skipped, log-only
- **Severity/confidence:** P3 (P2 if ZoeLab is a paid subscription meant to be live) / high on mechanics, low on intent.
- **Evidence:** `UID 11336: capper "ZoeLab" not in config.json. Skipping (leaving unseen).` every sweep (tails-pm2-logs.txt:207 et seq.); skip path index.js:171-175 is log-only, no alert. Repo BACKLOG.md:5-14 ("Add cappers #2 and #3") step 1 is "turn their DubClub email notifications ON" — notifications are evidently on for ZoeLab with no config/webhook/allowlist wiring behind them.
- **Impact:** if intended, ZoeLab picks are being dropped (recoverable while unseen — but only per DC-1 caveats on consumed CTA links); if staging, it's permanent skip-set noise feeding DC-7.
- **Proposed fix:** either complete BACKLOG steps 2-7 for ZoeLab or turn its notifications off; consider one-time alertAdmin on first sight of an unknown capper. **Effort:** S (config/env only per repo BACKLOG). **BACKLOG:** maps to repo BACKLOG "Add cappers #2 and #3".

### DC-9 — Canonical runtime config is unversioned; repo, box, and three docs disagree about cappers and env source (U-6 half-closed, U-8, U-10)
- **Severity/confidence:** P3 / high.
- **Evidence:** (a) Box runs **1** capper — boot logs `Loaded config with 1 capper(s): GuessAndPrayBets` (tails-pm2-logs.txt:284) — vs repo config.json:2-14 with 2 (TeamLockTalk present). The removal is deliberate and documented **only in the bot repo** (worktree docs/BACKLOG.md:101 "Box-local DubClub config ... TeamLockTalk removed"), never committed here; dubclub docs/BRIDGE.md:14 and docs/CODEMAP.md:21-22 still describe 2 cappers. (b) ecosystem.config.cjs is the canonical env source per worktree docs/SURFACE-PRO.md:115-131 (its values win over .env) but is untracked (checkouts.txt:11) and unrepresented at HEAD — no ecosystem file, no example; README.md:70 still says the app "is currently the only Surface Pro app without one" and that env loads from .env. June U-6's resolution ("commit ecosystem.config.cjs" + logrotate) was done on-box but never landed in git. (c) U-8 unchanged: .env.example:11-12 omits LOCKEDIN_WEBHOOK_URL while repo config.json:11 requires it — a fresh checkout of the *repo's own* config skips LockedIn per-email. (d) U-10 unchanged: CODEMAP.md:25-26 anchors requireEnv L23/extractPlaysUrl L54 vs actual index.js:27/:58. Also bot-side SURFACE-PRO.md:111 pins dubclub HEAD b55c449 and pm_id 2 vs actual 633d084 / pm2 id 3 (pm2-list.txt:6).
- **Impact:** box is a snowflake — repo cannot reproduce the running service (env source, restart policy, capper set); next `git pull` on the box conflicts on config.json; docs mislead the next operator (the DC-3 PM2 analysis was only possible via probes).
- **Proposed fix:** commit config.json matching the box (or a capper-set note), commit sanitized `ecosystem.config.cjs.example` + README rewrite of the env-deploy section, add LOCKEDIN line to .env.example (or drop TeamLockTalk everywhere), refresh CODEMAP anchors. **Effort:** S. **BACKLOG:** June U-6 (finish)/U-8/U-10.

### DC-10 — Log hygiene: token-bearing SendGrid click URLs written to out-log 3-4×/sweep and echoed into Discord alerts; 33MB of dubclub logs with no logrotate (H-1 open)
- **Severity/confidence:** P3 / high.
- **Evidence:** index.js:189 logs the full playsUrl — live out-log shows complete `https://u23455199.ct.sendgrid.net/ls/click?...` URLs (600+ chars, single-use capability links to paid VIP content) repeated for every walled UID on every sweep (tails-pm2-logs.txt:208-281; quoted here domain-only per redaction policy). The scrape-empty and drop-audit alerts also embed the URL into the admin Discord channel (index.js:208-209, :226, :258). Raw scrape (paid content, 2000 chars) also logged per sheet (index.js:218 — deliberate, per the 2026-06-11 forensics rationale). probes/logs-disk.txt: dubclub-error.log 20M + out.log 13M; ~/.pm2/modules empty ⇒ still no pm2-logrotate (June H-1).
- **Impact:** capability-URL sprawl across logs/Discord (low direct risk — links are single-use and mostly consumed — but it normalizes token logging); unbounded log growth dominated by DC-7's repeats (disk currently fine: 183G free).
- **Proposed fix:** log playsUrl truncated at path (strip query), keep full URL only in the alert where it has diagnostic use — or move it to a debug flag; `pm2 install pm2-logrotate`. **Effort:** S. **BACKLOG:** June H-1 + NEW (URL logging arrived with the Jun-11 forensics wiring, post-audit).

### DC-11 — Residual *silent* pick-loss shapes: chrome-regex can eat a real line with no alert, and scrapePicks still keeps only the single longest DOM element (U-5)
- **Severity/confidence:** P3 latent / high (probe-verified mechanics), low (frequency).
- **Evidence:** auditSplit alerts only on non-chrome signal-less lines; chrome-classified lines land in neither bucket (split-picks.js:66-75, comment :64-65). CHROME rule `^\d+(\.\d+)?\s+[A-Z]{2,4}$` (split-picks.js:49) silently eats any line shaped "number + 2-4 caps" — probe: `"2.5 SOG"` → CHROME-SILENT (a plausible shorthand prop fragment), while `"6.30 GP"` (intended) also silent. Upstream, scrapePicks keeps the longest innerText of the first selector class yielding ≥10 chars (index.js:113-122) — content outside that one element never reaches auditSplit, and the ≥5-char guard (index.js:205) passes, so nothing alerts (June U-5, unchanged). Everything else non-matching is now loud (probe: `"Guardians 1 unit"`, `"Both teams to score - 2 units"`, `"Athletics"` → DROP+ALERT).
- **Impact:** narrow but genuinely silent partial-loss channel surviving the PR#3/#4 loud-drop work; the email is \Seen-ed after the kept picks post.
- **Proposed fix:** include chrome-matched lines that ALSO carry a betting signal in droppedNonChrome (one-line change to the isChrome short-circuit); scrape fix bundled with capper-#2 per repo BACKLOG.md:16-17. **Effort:** S. **BACKLOG:** June U-4 residual + U-5.

### DC-12 — U-3 still open: no periodic sweep timer; "leaving unseen for retry" still waits for unrelated mail or a crash-restart
- **Severity/confidence:** P3 (downgraded from June P2: ~4/day crash-restarts + steady GNP mail flow retry everything in practice — live logs show walled UIDs retried 10+×/day) / high.
- **Evidence:** sweeps trigger only on `exists` (index.js:389-392), boot (:403-404), and watchdog relaunch (:334). No setInterval (grep: none). The existing sweeping/pendingSweep mutex (index.js:371-387) already makes the June one-liner safe to add.
- **Impact:** a transient failure on the night's last email delays picks until the next mail/restart — real but currently masked by restart churn (which DC-3/DC-4 fixes would reduce, *unmasking* this).
- **Proposed fix:** June U-3 patch (10-min safeSweep interval + clearInterval in cleanup). **Effort:** S. **BACKLOG:** June U-3.

## splitIntoPicks rule inventory (split-picks.js @633d084; all example classifications probe-verified against the actual module)

**Pipeline:** line → trim → `isChrome`? silently discard : `hasSignal`? → picks : droppedNonChrome (alerted). 0 picks ⇒ whole-slip fallback post + alert (raw, un-normalized — documented gap, BRIDGE.md:30). Kept picks get `normalizePick` (Pickem→ML, :87-89) before POST.

**Keep (signal) rules:**
| Rule | Regex (split-picks.js line) | Gate |
|---|---|---|
| ML | `\bML\b`i (:5) | none |
| American odds | `[+-]\d{3,}\b` (:6) | none |
| Spread | `[+-]\d+(\.\d+)?\b` (:7) | team-word `[A-Za-z]{3,}` |
| Compact total | `(?<!\d)[OU]\s?\d*\.?\d+\b`i (:17) — fused `CHC/PHIo8.5`, bare `o.5` | none |
| Word total | `\b(over|under)\s+\d*\.?\d+\b`i (:22) — `over .5` | none |
| F5 | `\b(F5|1st\s*5|first\s*5)\b`i (:28) | team-word |
| Pick'em | `\bpick\s?'?em\b`i (:33) | team-word |
| UNIT backstop | `\b\d+(\.\d+)?u\b`i (:41) — deliberately permissive | team-word |

**Chrome (silent discard, :43-50):** `N views`; ends-with `N hours/minutes/days ago`; `show more posts`; nav/footer words; `^\d+(\.\d+)?\s+[A-Z]{2,4}$` (sheet titles "6.11 GP").

**False-positive classes (noise KEPT → posted; deliberate "noise > silent loss" tradeoff, :34-40):**
- Commentary with a word-total: `"He's hit the over 1.5 HRs in 4 straight games"` → KEPT (TOTAL_W).
- Record/bankroll lines with units: `"Last week: 10-4 +5.2u overall"`, `"We are up 12u on the month, keep riding"` → KEPT (UNIT/SPREAD).
- Commentary quoting odds: `"Yankees looked awful last night at -200"` → KEPT (ODDS).
War-room rejection is the intended backstop for all of these.

**False-negative classes (real pick DROPPED — loud via :mag: alert, not silent):**
- Spelled-out stakes: `"Guardians 1 unit"` (UNIT needs fused `1u`).
- Yes/no & no-number props: `"Both teams to score - 2 units"`, `"Tigers/Royals both teams score yes"`.
- Bare team-name lines: `"Athletics"`.
- Multi-line picks: the signal-less continuation line drops (garbled single-line post) — alerted.

**Silent classes (no alert — see DC-11):** chrome-regex FP (`"2.5 SOG"` shape); anything scrapePicks' longest-single-element heuristic never captured. **Expected alert noise:** sport headers (`World Cup`, `Baseball`) hit droppedNonChrome every GNP sheet (documented, BRIDGE.md:29) — trains operators to skim the :mag: alert (mild fatigue risk).

**Partial silent loss still possible?** Yes, but only via the two silent classes above; the 2026-06-11 class (signal-miss) is now loud. `auditSplit` alerts on: non-chrome signal-less lines (verbatim list + URL). It does NOT alert on: chrome-eaten lines, upstream scrape misses, or FP noise it kept.

## Live-incident read (GNP login wall)

- **Delivery impact now:** zero GNP picks reaching Discord since 2026-06-29 20:02 ET (first wall, UID 11484). GNP published ≥2 more sheets during the outage (UID 11499 ~Jul 1, UID 11514 ~Jul 2 08:23) — 4 sheets pending. GNP's scraper handle is disabled bot-side (worktree BACKLOG.md:28), so there is no alternate ingest: GNP is 100% dark. With TeamLockTalk removed from box config (DC-9), the bridge currently carries **no** delivering capper — the whole service is effectively idle-spinning on wall alerts.
- **At recovery (re-seed):** next sweep retries all unseen UIDs. Two shapes: (a) pages render → bridge posts Jun 29-Jul 2 sheets as fresh one-pick messages; Jun 29/Jul 1 picks are stale (events finished) and must be rejected in war-room; if any were hand-posted during the outage (UNVERIFIED), they arrive as duplicates that **nothing dedups** — fingerprint is source_message_id-keyed (database.js:305-310) and the webhook path has no content-window dedup (DC-2). (b) The single-use SendGrid CTA links — each already re-clicked 20-40× by retry sweeps (BRIDGE.md:39 "consumed on first click; reuse may hit login/expired") — may land on expired/login pages even with a fresh session, leaving those UIDs walled forever and the alert spam running; recovery runbook should include verifying each UID posts or marking dead ones read in Gmail.
- **Alert posture:** ~97 login-wall admin alerts in 2.5 days with no cooldown (DC-7) and the wrong re-seed instruction in the alert body (index.js:199, DC-1); the dead-air alarm — the designed backstop — never fired and structurally cannot across crash-restarts (DC-4); the FATAL/boot-crash path alerts nothing (DC-3). Net: one alarm screams uselessly while the two designed safety nets are mute.

## Contract table (dubclub ⇄ Discord ⇄ bot, verified at 633d084 / 19ff594)

| Hop | Mechanism | Key config (names/IDs only) | Failure mode & visibility |
|---|---|---|---|
| Gmail → bridge | IMAP IDLE + `\Seen`-keyed sweeps of `{seen:false, from: DUBCLUB_FROM}` (index.js:291-294) | IMAP_USER, IMAP_APP_PASSWORD, IMAP_HOST/PORT, DUBCLUB_FROM | close→exit→PM2 (works, ↺12); connect-fail = alertless crash-loop (DC-3) |
| Email → capper | subject `New plays from (.+?)!` → config.json key (index.js:165-175) | config.json (box: GuessAndPrayBets only; repo: +TeamLockTalk — DC-9) | unknown capper / bad subject = log-only skip, permanently unseen (DC-7/DC-8) |
| Email → page | extractPlaysUrl CTA anchor by label text (index.js:58-75; brittle per CODEMAP.md:26-28) → Playwright w/ storageState.json | HEADLESS; session seeded seed-mac.js+scp, never re-persisted (DC-1/U-11) | no URL = log-only, **no alert** (index.js:183-187); login wall = alert/UID/sweep (DC-7); CTA links single-use (recovery risk) |
| Bridge → Discord | one POST per pick, 400ms apart, `username: capperConfig.capper` (index.js:128-134, :236-249); \Seen only after all-2xx (:276) | GNP_WEBHOOK_URL (webhook ID 1510019730906546277 per SESSION-LOG.md:68), LOCKEDIN_WEBHOOK_URL (defunct on box), ADMIN_ALERT_WEBHOOK_URL | non-2xx = errlog-only retry-from-pick-0 (DC-2/DC-6); no 429 handling |
| Discord → bot | webhook message in capper channel (GNP #gnp-slips 1473343838587457626) | Fly secrets: ALLOWED_WEBHOOK_IDS (6 IDs incl. both bridge webhooks, restored 2026-06-11), HUMAN_SUBMISSION_CHANNEL_IDS, CAPPER_CHANNEL_MAP, DUBCLUB_SPLIT_CHANNEL_IDS | ID not in allowlist → bot_not_whitelisted → BOUNCER_REJECTED drop (messageHandler.js:315-325, :817-826), queryable via /api/admin/drops (#161); **bridge sees 2xx and \Seen-s → silent loss** (DC-6, May 31 class) |
| Bot ingest | DUBCLUB SPLIT BYPASS: skips buffer + GUARD 5, straight to processAggregatedMessage (messageHandler.js:944-962; author-agnostic since #84) | — | dedup = fingerprint incl. source_message_id (database.js:303-318) ⇒ bridge re-posts never dedup (DC-2); war-room needs_review is the human stop |

## Looked good

- **U-1 fix is faithful and live:** disconnect handler with stale-instance guard (browser-watchdog.js:107-115), timed blank-page probe (:117-133), bounded backoff relaunch → fatalExit(1) (:160-211), relaunch re-reads storageState + re-sweeps (index.js:332-334); armed-line parameters in every boot log match code defaults exactly (browser-watchdog.js:16-22 vs tails-pm2-logs.txt:287). Dedicated offline test suite (tests/browser-watchdog.test.js).
- **Crash-only IMAP lifecycle works operationally:** ~4 close-exits/day, PM2 resurrection clean every time across the 3-day probe window; safeSweep mutex (index.js:371-387) prevents overlap; per-email page closed in `finally` (index.js:283-286).
- **The 2026-06-11 forensics wiring did its job in design terms:** raw scrape logged per UID (index.js:218), droppedNonChrome alert (index.js:224-228) — a signal-miss drop can no longer be silent; 52-assertion splitter suite passes at HEAD; unit-free signal-isolation tests guard against UNIT-backstop masking.
- **\Seen-after-2xx ordering** is correct at-least-once (index.js:276 after :255) — the right side of the tradeoff.
- **normalizePick applied at post time** (index.js:236), probe-verified (`Czech Republic Pickem 3u` → `Czech Republic ML 3u`).
- **Secret hygiene in git:** .gitignore covers .env/storageState.json/*.bak/*.log; config.json carries IDs and env-var *names* only; login-wall alert body contains no URL/token.
- **alertAdmin is failure-hardened** (index.js:136-148: missing env, non-ok, throw all handled) — and no `Admin alert webhook returned/threw` lines appear in the probe tails, so alert delivery itself is working.
- **Login-wall detection works** — the live incident is the guard functioning exactly as designed (index.js:85-93); the failures are around cadence, alert text, and the missing session re-persist, not detection.
