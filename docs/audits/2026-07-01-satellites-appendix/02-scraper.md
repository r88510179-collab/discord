> Track analysis produced by a read-only audit subagent from pinned clones + probe captures;
> reviewed, spot-verified (high-severity evidence lines re-read by the orchestrator), and filed
> by the audit orchestrator. Probe references (P-n, probes/*.txt) resolve to 20-live-probes.md.

# T2 — zonetracker-scraper audit (repo @ff1a906; box @ff9fda0; bot @19ff594)

## Findings

### SC-1 — `/api/mobile-ingest` early-200 still loses in-flight batches on bot restart; loss is unrecoverable and dedup-poisoned
- **Severity:** P1 · **Confidence:** high
- **Evidence:** bot@19ff594 `routes/api.js:49-50` (`// Respond 200 immediately…` `res.status(200).json({ status: 'accepted', … })`) then `:52-56` processes async via `handleTwitterWebhookPayload`. Scraper@ff1a906 `scraper.js:250-256` advances `last_tweet_id` + inserts `seen_tweets` on that 200 (`if (result.ok)`). Processing is slow by design: `services/twitter-handler.js:172` `await delay(3000)` per tweet plus AI-call latency, so a 10-tweet batch keeps a multi-minute crash window open after the ACK. Worse than June: `services/twitter-handler.js:135` inserts `processed_tweets` per tweet **before** parse/save, so tweets that died mid-flight are dedup-blocked (`:128-133`) even if manually re-POSTed. No catch-up exists scraper-side (README.md:60-66 "missed, not backfilled").
- **Impact:** every Fly deploy/OOM/crash that lands while a batch is processing silently and permanently eats that batch (at-most-once delivery). Deploy cadence June–July was heavy (v526→v751), so the window is hit in practice, and the drops leave no `drops` record for tweets not yet at a recorded stage.
- **Proposed fix:** June M-16(a) resolution unchanged — persist-then-ack: synchronous INSERT of the raw batch into an `ingest_queue` table before the 200, drain in the existing async path, delete on completion. Move the `processed_tweets` insert to after successful staging (or key it off the queue row).
- **Effort:** M · **BACKLOG mapping:** June audit M-16(a) (`docs/audits/2026-06-10-coa-full-audit.md:258-260`) — **still open at bot HEAD 19ff594**; June rated it P3, re-rated P1 here per this audit's rubric (silent feed loss).

### SC-2 — Caption-less slip tweets are always dropped before the image check; a `tweetText` selector drift silently zeroes the whole feed
- **Severity:** P1 (latent amplifier; live loss limited to image-only tweets) · **Confidence:** high
- **Evidence:** bot@19ff594 `services/twitter-handler.js:117-120` — `if (!tweetId || !text)` → `PRE_FILTER_NO_BET_CONTENT {reason:'missing_id_or_text'}` `continue`, **before** `imageUrls` is consulted (vision branch is `:179-184`). Scraper always sends `text: t.text || ''` (`scraper.js:176`); `extractArticleData` yields `text:''` whenever `[data-testid="tweetText"]` misses (`watchdog.js:19-20`). A tweetText-only drift keeps ids matching, so `classifyExtraction` stays `VALIDATED` (`watchdog.js:52-59`), the dead-air alarm never fires (fetched>0), the scraper logs healthy `[Ingest] POSTed` lines — and the bot drops 100% of tweets.
- **Impact:** (a) today: any capper posting a bare slip screenshot with no caption is always lost (recorded in `ingest_drops` but never staged); (b) drift day: total silent feed loss with all monitors green — this is exactly the amplifier that makes the S-01 class recurrable end-to-end.
- **Proposed fix:** June M-16(b) one-liner — `if (!tweetId || (!text && imageUrls.length === 0))`; the vision path already tolerates empty text (`:181` embeds `"${text}"` into the prompt harmlessly).
- **Effort:** S · **BACKLOG mapping:** June audit M-16(b) (`2026-06-10-coa-full-audit.md:259`) — **still open at bot HEAD 19ff594**.

### SC-3 — Ingest-failure blind spot: a failing/401-ing POST (e.g. rotated `MOBILE_SCRAPER_SECRET`) alarms nowhere
- **Severity:** P2 (escalates to P1 silent feed loss the day it happens) · **Confidence:** high
- **Evidence:** `scraper.js:196-199` ingest failure → `{ok:false}` + console line only; `:250-259` — on failure neither strikes nor disables fire (README.md:74 documents "a failed ingest POST does not [strike]") and `processHandle` still returns `tweets.length`, so the dead-air watchdog (counts **fetched**, `scraper.js:363-367`) never trips. Bot-side: `services/healthReport.js:29-71` `sectionTwitter` is a passive daily 24h stage-count embed (color goes yellow at 0 saved) — the June-specced "no mobile-ingest for N hours" alert (M-16b bot-side complement, audit line 342) does not exist (no scraper/mobile-ingest silence check in healthReport.js).
- **Impact:** secret rotation, endpoint rename, or a persistent bot-side 4xx/5xx stalls the feed with cursor frozen; tweets survive only while inside the page-of-10 window (README.md:60-66), then are lost — indefinitely, with zero alarms and a healthy-looking `[Poll] … fetched` log.
- **Proposed fix:** scraper-side: count consecutive cycles with ≥1 failed ingest POST and ≥1 attempted batch → reuse `sendAlert` after N (mirror of the dead-air state machine); and/or ship the bot-side "no mobile-ingest for N hours" healthReport check.
- **Effort:** S · **BACKLOG mapping:** extends June M-16b bot-side complement (unshipped); NEW as a scraper-side gap (post-dates the S-01 fix scope).

### SC-4 — Box deploy path is broken: `git pull` aborts on the locally-modified tracked `ecosystem.config.js`, and the documented runbook doesn't know it
- **Severity:** P2 · **Confidence:** high (empirically simulated)
- **Evidence:** probes/checkouts.txt — box @`ff9fda0` (one behind origin `ff1a906`) with ` M ecosystem.config.js` + untracked `ecosystem.config.js.bak.20260610-115918`. Origin commit `2b340f9` (`git show --stat`) deletes `ecosystem.config.js` from tracking and gitignores it. Simulated in scratch clone (reset to ff9fda0, dirtied the file, `git merge ff1a906`): **`error: Your local changes to the following files would be overwritten by merge: ecosystem.config.js … Aborting`** — pull refuses, working tree untouched. Doc drift: `docs/SURFACE-PRO.md:104` still prescribes `git pull && pm2 restart` as the code-deploy step; also SURFACE-PRO.md:26/:78 record scraper as pm_id 0 while probes/pm2-list.txt shows scraper id 4 (ollama-proxy is 0). Hygiene rider: `.gitignore` covers `ecosystem.config.js` exactly and `scraper.js.bak.*`, but NOT `ecosystem.config.js.bak.*` — a `git add -A` on the box could commit that .bak (same file class the untrack commit exists to protect; contents may carry the live `ALERT_WEBHOOK_URL`).
- **Impact:** no data loss today (abort is clean; ff9fda0→ff1a906 is docs/config-only so the box runs current *code*), but the next real scraper fix cannot be deployed by the documented procedure; an operator improvising under pressure risks `checkout -- .`/`stash drop`-ing the only copy of the live webhook config.
- **Proposed fix:** one-time on box: `cp ecosystem.config.js ~/eco.live.bak && git checkout -- ecosystem.config.js && git pull && cp ~/eco.live.bak ecosystem.config.js` (file ends untracked+ignored, matching origin intent); delete or relocate the 2026-06-10 .bak; add `ecosystem.config.js.bak*`/`*.bak*` to .gitignore; update SURFACE-PRO.md deploy step + pm_id table.
- **Effort:** S · **BACKLOG mapping:** NEW (deploy-path); doc-drift on SURFACE-PRO.md.

### SC-5 — June S-02 unfixed: `initBrowser` partial-failure leaks a Chromium per 5-minute cycle
- **Severity:** P2 · **Confidence:** high
- **Evidence:** `scraper.js:102-115` — `chromium.launch()` (:102) then `newContext`/`JSON.parse(browser_cookies.json)`/`addCookies` inside the same try; catch (:112-115) logs and `return false` **without** `shutdownBrowser()`. `runCycle`'s failure path (:341-347) also skips `shutdownBrowser`. Next cycle overwrites the module-level `browser` var (:102), orphaning the previous headless Chromium (~100-200MB).
- **Impact:** a slightly-malformed Cookie-Editor export (the exact file an operator will hand-edit on cookie-death day, see SC-9) triggers a persistent leak every 5 minutes; PM2 `max_memory_restart: '500M'` watches the node process only, not Chromium children. Systemd probe already shows the pm2 tree at 1.7G/2.2G peak.
- **Proposed fix:** `await shutdownBrowser()` in the catch before `return false` (it is idempotent, :118-122) — June's exact one-liner.
- **Effort:** S · **BACKLOG mapping:** June audit S-02 (`2026-06-10-coa-full-audit.md:344-346`) — **open**.

### SC-6 — June S-03 unfixed: no cycle deadline; one wedged Playwright call zombifies the daemon forever
- **Severity:** P2 · **Confidence:** high
- **Evidence:** `scraper.js:138` `page.$$eval` (count), `:142` `page.evaluate(scrollBy)`, `:148` `page.$$eval(extractArticleData)` — none carry timeouts (only `goto` 30s :130 and `waitForSelector` 15s :133 do). A hung renderer blocks `processHandle` forever; `cycleInProgress` (:333) never resets, every future tick exits at `:335` "[Cycle] Previous still running". PM2 sees a healthy process.
- **Impact:** permanent silent zombie, manual-restart-only. Note the dead-air watchdog does NOT cover this: `recordCycle` is only called at cycle end (:363), which never arrives — so the S-01 alarm is blind to precisely this failure shape.
- **Proposed fix:** June's `runCycleWithDeadline()` wrapper — 10-min `setTimeout(() => process.exit(1))`, `unref()`d, cleared in `finally` (cursor/seen state is in SQLite; restart is lossless).
- **Effort:** S · **BACKLOG mapping:** June audit S-03 (`2026-06-10-coa-full-audit.md:348-350`) — **open**. Live posture currently healthy (pm2-list: ↺0, 3D uptime; cycles completing in ~104s per probe out.log).

### SC-7 — Timeline under-render: live fetches return 2–8 articles against a request of 10; the 2026-06-10 missed-slip probe is still owed
- **Severity:** P2 · **Confidence:** medium (mechanism plausible, loss instances unquantified)
- **Evidence:** probes/tails-repo-logs.txt out.log Jul 2: `@bookitwithtrent 8 fetched`, `@capperledger 8`, `@lockedin_sportz 6`, `@rbssportsplays 6` then later `2 fetched`, `@toptierpicks_ 6`, `@zrob4444 8` — chronically below `TWEETS_PER_CYCLE=10`. Scroll loop `scraper.js:137-144` breaks when `currentCount === previousCount && i > 1` (lazy-render can stall the count) and caps at 5 scrolls. Bot repo BACKLOG.md:140 records the live consequence: ~4 articles surfaced for some profiles and the 2026-06-10 LockedIn slip tweet `2064909737662247302` was missed; "Probe owed" — never run.
- **Impact:** tweets that never render never enter the page; combined with no catch-up (README.md:60-66) they are permanently lost while everything reports success. This is the one *proven* historical instance of scraper feed loss.
- **Proposed fix:** run the owed instrumentation (log per-profile `articleCount` distribution per cycle), then tune scroll depth/wait or raise the break threshold; consider `networkidle` wait between scrolls.
- **Effort:** S (instrument) + S (tune) · **BACKLOG mapping:** existing open item, BACKLOG.md:140.

### SC-8 — Dead-air alarm transport shares the box's failure domain, success is never logged, and re-alarms have no backoff
- **Severity:** P2 · **Confidence:** high
- **Evidence:** probes/tails-repo-logs.txt error.log, Jun 23 outage: at least 6 × `[Alarm] webhook failed: The operation was aborted due to timeout` immediately after 🚨 lines (18:35, 18:50, 19:20, 19:35 ET, etc.) — the box's network outage that killed x.com fetches also killed Discord webhook delivery. `sendAlert` (`scraper.js:264-280`) logs failures only — a delivered webhook produces no log line, so post-incident you cannot tell which of the ~24 alarms (re-fire every 3 cycles ≈ 15 min, `watchdog.js:109-110`, for a ~6h outage 18:30→00:36) actually reached a human. No escalation/backoff (by design, README.md:93) and no second transport.
- **Impact:** operator-deception both ways: during a full-network outage the alarm may never arrive (console fallback is invisible unless someone tails logs), and when it does arrive it spams. The unshipped bot-side silence check (SC-3) is the natural out-of-failure-domain complement — the Fly bot noticing "no mobile-ingest for N hours" survives exactly the outage class that mutes the webhook.
- **Proposed fix:** log webhook 2xx success with timestamp; cap or exponentially space re-alarms; ship the bot-side silence check as the redundant path.
- **Effort:** S · **BACKLOG mapping:** refines S-01 (shipped) + M-16b complement (unshipped).

### SC-9 — Cookie-death re-seed procedure is documented nowhere
- **Severity:** P2 · **Confidence:** high
- **Evidence:** `browser_cookies.json` is the sole auth (scraper.js:51, :97-99); its only format documentation is the code comment "Chrome Cookie-Editor JSON" (`scraper.js:76`). README.md mentions the file (:6-8, :110-113 env section) but has no export/re-seed steps; `docs/SURFACE-PRO.md:78-107` (scraper section) does not mention the cookie file at all. Cookie `expirationDate` is preserved into Playwright (`scraper.js:87`) and the browser context is rebuilt from the file **every cycle** (:340, :102-110), so the on-disk file ages until X invalidates the session; nothing ever refreshes it.
- **Impact:** cookie expiry is the *expected* eventual failure (June S-01 text says exactly this). On the day, the operator gets a 🚨 that says "Check browser_cookies.json" with no runbook for what to do — under time pressure, on a box where a malformed export additionally triggers SC-5's leak.
- **Proposed fix:** README + SURFACE-PRO runbook: burner login in desktop Chrome → Cookie-Editor export (x.com scope) → scp to `~/zonetracker-scraper/browser_cookies.json` (mode 600) → **no restart needed** (file re-read each cycle — document this hot-swap property) → watch next cycle log for `[Init] Browser launched, N cookies loaded` + recovery ✅.
- **Effort:** S · **BACKLOG mapping:** NEW (ops-runbook gap; adjacent to shipped S-01).

### SC-10 — June S-05 residual: `.env.example` still ships the dead `TWITTER_*` block with real burner identity values; live-var docs incomplete
- **Severity:** P3 · **Confidence:** high
- **Evidence:** repo@ff1a906 `.env.example:5-8` — `TWITTER_USERNAME`/`TWITTER_PASSWORD`/`TWITTER_EMAIL` block still present, username+email lines carry **real values, not placeholders** (values withheld; nothing at HEAD reads any `TWITTER_*` var). `SCRAPER_HANDLES_URL`, `ALERT_WEBHOOK_URL`, `DEAD_AIR_CYCLES`, `BACKFILL` are absent from `.env.example` (README's env table :101-113 now covers them — the "undocumented" half of S-05 is fixed). The box `.env` still carries the same dead keys per `docs/SURFACE-PRO.md:92-95` (`TWITTER_API_KEY`, `TWITTER_EMAIL`, `TWITTER_PASSWORD`, `TWITTER_USERNAME` listed as live env). Nit: README.md:108 says `DEAD_AIR_CYCLES` "(min 1)" while code + ecosystem example document `0` = disable (`scraper.js:37-41`, example :20).
- **Impact:** real burner identity advertised at HEAD; plaintext unused credentials sitting in the box `.env`; example file misleads fresh setups.
- **Proposed fix:** June's replacement `.env.example` (4 live vars + cookie-auth comment); delete dead `TWITTER_*` keys from the box `.env`; fix the README min-1 line.
- **Effort:** S · **BACKLOG mapping:** June audit S-05 (`2026-06-10-coa-full-audit.md:356-358`) — **half open**.

### SC-11 — June S-08 residual: boot banner still reports the dead fallback list as "Handles: 9"
- **Severity:** P3 · **Confidence:** high
- **Evidence:** `scraper.js:380` `console.log(\`  Handles: ${HANDLES.length} | Schedule: …\`)` — prints the 9-entry built-in fallback (:23-26); the live set is DB-driven per cycle and is currently 8 (probe out.log `[Handles] fetched 8 active from Fly`).
- **Impact:** misleads exactly during incident triage of boot logs.
- **Proposed fix:** June's one-liner banner text ("DB-driven via /api/scraper-handles (built-in fallback: N)").
- **Effort:** S · **BACKLOG mapping:** June audit S-08 (`2026-06-10-coa-full-audit.md:360-362`) — **open**.

### SC-12 — Built-in fallback handle list has drifted from the DB truth: engages → duplicate GNP feed + lost lockedin_sportz
- **Severity:** P3 (needs endpoint AND cache both dead) · **Confidence:** medium
- **Evidence:** `scraper.js:23-26` fallback includes `guess_pray_bets` and `nrfianalytics`, lacks `lockedin_sportz`. Live truth (probe out.log Poll lines + `[Handles] fetched 8`): bobby__tracker, bookitwithtrent, capperledger, deeplaysbets, lockedin_sportz, rbssportsplays, toptierpicks_, zrob4444. `guess_pray_bets` is toggled **disabled** in `scraper_handles` because GNP now arrives via the DubClub bridge (bot BACKLOG.md:28) — fallback activation would double-feed GNP (scraper + DubClub) and drop lockedin_sportz. Reachable only when `GET /api/scraper-handles` fails AND `active_handles.json` is unreadable (`scraper.js:322-330`).
- **Impact:** duplicate-feed + silent capper loss in the double-failure corner; the write-through cache makes it unlikely but the list is pure drift liability.
- **Proposed fix:** either sync the fallback to the current enabled set with a dated comment, or log a loud `[Handles] FALLBACK LIST IN USE — may be stale` warning (it currently logs one quiet line, :329).
- **Effort:** S · **BACKLOG mapping:** NEW (drift since scraper-handles endpoint shipped).

### SC-13 — Retweet detection is scraper-side only; the flag is not forwarded, so `socialContext` drift = misattributed picks
- **Severity:** P3 (latent) · **Confidence:** medium
- **Evidence:** retweets are filtered client-side via `[data-testid="socialContext"]` (`watchdog.js:35`, filter :58) and the payload map (`scraper.js:174-182`) sends no `isRetweet` field. Bot RT filter (`twitter-handler.js:140`) checks `tweet.retweeted_tweet || tweet.isRetweet || text.startsWith('RT @')` — none of which a scraped RT will carry (page innerText has no "RT @" prefix). UNVERIFIED side-note: X marks *pinned* tweets with `socialContext` ("Pinned") in some markups — if current, a capper's pinned fresh pick is silently skipped as a retweet (cannot verify X's live DOM from here).
- **Impact:** if `socialContext` drifts (renamed/removed), retweeted third-party picks flow through and get staged under the retweeting capper — wrong-capper attribution feeding record stats; the bot has no backstop.
- **Proposed fix:** forward `isRetweet` in the payload (one field) so the bot-side filter regains coverage; optionally distinguish "Pinned" from repost social contexts scraper-side.
- **Effort:** S · **BACKLOG mapping:** NEW.

### SC-14 — June S-04 residual: no restart backoff at HEAD example; no pm2-logrotate on the host
- **Severity:** P3 · **Confidence:** high
- **Evidence:** `ecosystem.config.example.js` at ff1a906 has `merge_logs`/`log_date_format`/`max_restarts: 10`/`min_uptime: '60s'` (:25-28) but **no** `exp_backoff_restart_delay`; probes/logs-disk.txt: `~/.pm2/modules` EMPTY (no pm2-logrotate host-wide), repo `logs/out.log` grows unbounded (gitignored, live since Jun 10; old `~/.pm2/logs/zonetracker-scraper-out.log` 15M frozen at the config cutover). Disk pressure currently nil (18% used, 183G free).
- **Impact:** a boot-loop fault (corrupt `scraper.db` at module load :59-70, missing secret exit :57) still burns 10 instant restarts and parks the app `errored` with no alert; logs unbounded.
- **Proposed fix:** add `exp_backoff_restart_delay: 1000` to the example + the box file (in the same touch as SC-4's untangle); one-time `pm2 install pm2-logrotate` + size/retain settings (shared with dashboard/dubclub log findings).
- **Effort:** S · **BACKLOG mapping:** June audit S-04 (`2026-06-10-coa-full-audit.md:352-354`) — **open** (partial).

### SC-15 — `@toptierpicks_` cursor frozen since 2026-03-17; the June keep/drop decision is still unmade
- **Severity:** P3 · **Confidence:** high (staleness) / low (cause)
- **Evidence:** probe out.log every cycle: `[Poll] @toptierpicks_ fetching 10 (last_seen=2033951175226130481)` — snowflake decodes to 2026-03-17T16:58Z; all other handles carry Jul 1–2 cursors, and rbssportsplays' cursor visibly advanced between the two probed cycles. `fetched 6, 0 new` each poll = page renders but nothing newer than mid-March survives the cursor+seen filters. Bot BACKLOG.md:685-686 already flags this handle for an operator keep/drop call (0 saved bets in 7 days, cross-ref the waitForSelector timeouts which name it).
- **Impact:** ~3.5 months of a polled slot producing nothing — either a dormant capper (fine, disable it) or a silent per-handle scrape failure (bad, investigate); every cycle spends ~15s + one page-load of burner-account exposure on it.
- **Proposed fix:** make the BACKLOG.md:685 call: check the handle's live timeline once by hand; disable via `POST /api/admin/handles/toptierpicks_` or file the scrape-path investigation.
- **Effort:** S · **BACKLOG mapping:** existing open item, BACKLOG.md:685-686.

## Selector fragility table

Every DOM-touching call in the scrape path (scraper.js + page-side `extractArticleData` in watchdog.js):

| # | Selector / page call | Site | What breaks when it drifts | Detected or silent |
|---|---|---|---|---|
| 1 | `article[data-testid="tweet"]` | scraper.js:133 (`waitForSelector`), :138 + :148 (`$$eval`) | No articles found → 15s timeout throw | **DETECTED, loud**: strike (:216-220) → 5-strike 6h disable → all-handle zero-fetch → dead-air alarm (~15 min) |
| 2 | `a[href*="/status/"]` | watchdog.js:13-16 | Every article maps `id:null` | **DETECTED** (S-01 fix): `classifyExtraction` → `SELECTOR_DRIFT` throw (watchdog.js:55-57, scraper.js:155-160) → strike → alarm; fixture-tested |
| 3 | `[data-testid="tweetText"]` | watchdog.js:19-20 | `text:''` on all tweets; ids still match → `VALIDATED`, forwarded | **SILENT end-to-end**: scraper healthy (fetched>0, no alarm), bot drops 100% at twitter-handler.js:117 (`!text`) — see SC-2. Only trace = bot `ingest_drops` `missing_id_or_text` pile-up |
| 4 | `time` / `datetime` attr | watchdog.js:23-24 | `createdAt:null` → scraper substitutes now() (scraper.js:177) | **SILENT, low impact**: wrong `posted_at` in bot audit log only (`bets.created_at` is insert-time regardless) |
| 5 | `img[src*="pbs.twimg.com/media"]` | watchdog.js:27-32 | `images:[]` on all tweets | **SILENT, high impact**: bot `hasImages=false` → vision path skipped; slip-image bets degrade to text-parse; caption-less slips vanish entirely (SC-2). No scraper-side signal — fetched counts stay normal |
| 6 | `[data-testid="socialContext"]` | watchdog.js:35 | (a) removed/renamed → RTs forwarded as own picks → **misattribution** (bot filter can't catch, SC-13). (b) if X tags pinned tweets with it (UNVERIFIED), pinned fresh picks skipped | **SILENT both directions** |
| 7 | `page.evaluate(scrollBy)` + count-stall break | scraper.js:137-144 | Lazy-render stalls the article count → loop exits early → short page (live: 2–8 of 10) | **SILENT**: under-render loses tweets that never entered the page (SC-7 / BACKLOG.md:140) |
| 8 | Image URL param-strip (`src.split('?')[0]`) | watchdog.js:29-31 | If X moves to param-mandatory CDN URLs, stripped URL 404s at vision fetch time | Currently working (live twitter_vision bets flowing); would surface bot-side as vision failures, not scraper-side |

Net: the two *loud* failure modes are exactly the ones S-01 fixed. Rows 3 and 5 — the payload-content selectors — remain the silent-loss surface, and row 3 is amplified by the bot's `!text` gate (SC-2).

## Contract table (scraper ⇄ bot, scraper@ff1a906 ⇄ bot@19ff594)

| Contract point | Scraper side | Bot side | Verdict |
|---|---|---|---|
| Ingest URL | `INGEST_URL` default `…fly.dev/api/mobile-ingest` (scraper.js:28) | `bot.js:15-16` mounts routes/api at `/api`; `POST /mobile-ingest` (api.js:19) | ✅ match |
| Auth header | `x-mobile-secret: MOBILE_SCRAPER_SECRET` on both POST (:187) and handles GET (:299); boot-exits if unset (:57) | Same name checked both endpoints (api.js:21-22, :70-71); fail-closed 401 if env unset | ✅ match, fail-closed |
| Batch shape | `{handle, tweets:[{id:String, text, created_at, extendedEntities:{media:[{type:'photo',media_url_https}]}, media:[{type:'photo',url}]}]}` (scraper.js:172-183) | api.js:29-33 batch branch → twitter-handler :108 (`tweet.id`), :109 (`tweet.text`), :113 (`tweet.created_at`→posted_at), extractImageUrls :16-29 reads both media shapes (extendedEntities wins) | ✅ match; `displayName` never sent → capper named from raw handle (known capper-split cause, BACKLOG.md:104) |
| Response | reads `(await res.json()).count` (:195) | returns `{status:'accepted', count}` (api.js:50) | ✅ |
| Ack semantics | cursor + `seen_tweets` advance **only** on HTTP 2xx (:250-256); non-2xx throws (:191-193) | **200 sent before any persistence; processing async** (api.js:49-56) | ❌ **M-16a open** — at-most-once on bot restart (SC-1) |
| Retry on POST failure | no cursor advance → same batch re-POSTs next cycle (:196-199, :250) | `processed_tweets` PK dedup (:128-135) absorbs replays | ✅ retry-safe, no dup bets — **but** the same pre-parse insert poisons replay of crash-lost tweets (SC-1) |
| Bot down / slow | 30s AbortSignal (:189); failure = no strike, no alarm (:250-259) | — | ⚠️ short outage lossless (cursor holds); >page-of-10 accumulation lost; **no alert path at all** (SC-3) |
| Empty text / image-only | forwarded with `text:''` (:176) | dropped at :117 before image check | ❌ **M-16b open** (SC-2) |
| Multi-image tweets | all photo URLs sent (:178-181) | vision consumes `imageUrls[0]` only (twitter-handler.js:184) | ⚠️ 2nd+ slip image ignored on the twitter path (F-07 fixed the Discord /slip path only) |
| Retweet flag | filtered client-side; flag not forwarded (:174-182) | filter expects `retweeted_tweet`/`isRetweet`/`"RT @"` (:140) — none present | ⚠️ single point of RT defense (SC-13) |
| `GET /api/scraper-handles` | expects `{handles:[…]}` array (:306); 10s abort (:295-296); write-through cache; empty array honored as "scrape nothing" (:307-311) | `SELECT handle FROM scraper_handles WHERE enabled=1 ORDER BY handle` → `{handles}` (api.js:76-81); 500 on DB error | ✅ match; endpoint failure → cache → built-in fallback (drifted — SC-12) |
| Dedup division of labor | id-level: `seen_tweets` + BigInt cursor (:236-241) | id-level `processed_tweets` + content-level F-12 12h window (twitter-handler.js:61-90, :305-315) | ✅ layered as designed (README.md:129-134) |

## S-01 verdict

**FIXED at HEAD, DEPLOYED on box, and LIVE-FIRE PROVEN — with two residual blind spots (SC-3, SC-6) and a transport caveat (SC-8).**

- **Code at ff1a906:** both June resolution parts present and offline-tested. (1) Zero-id drift throws: `watchdog.js:52-60` `classifyExtraction` → `scraper.js:155-160` `SELECTOR_DRIFT` throw → strike path :216-220 (never the strike-reset at :224-231, which now requires positively-validated ids). (2) Cycle-level dead-air alarm: `createDeadAirWatchdog` (`watchdog.js:75-125`) — counts consecutive all-zero-**fetched** cycles, fires at `threshold`, re-fires every `threshold` while persisting, one ✅ recovery notice; `eligible:false` (intentionally empty active set) leaves the counter untouched; browser-init failure counts as dead air (`scraper.js:344`). `DEAD_AIR_CYCLES` semantics: unset/invalid → 3; `0` → fully disabled watchdog (`scraper.js:40-41`, `watchdog.js:82`, no-op `recordCycle` :91-93). `ALERT_WEBHOOK_URL` unset → console-only alarms, never a crash (`scraper.js:264-267`). Tests: 26/26 pure assertions pass when run from a scratch copy (DOM fixtures skip without playwright).
- **Live evidence (probes/tails-repo-logs.txt, error.log):** the Jun 23 network outage exercised the whole state machine in production — timestamped `[Strike] … 5/5` and `[Disable] … (cooldown 6h)` lines 22:30–22:33Z; `[DeadAir] zero-fetch cycle 5/3 …` through `77/3`; 🚨 `[Alarm] Dead air: … 6 consecutive cycles (~30 min)` re-firing every 3 cycles; ✅ `Recovered: 62 tweets fetched` at 04:36Z Jun 24. **Note: the shared probe summary's claim of "no [Alarm]/[DeadAir] lines in the window" is wrong — they are present in the error.log tail** (the *out.log* tail, all Jul 2 cycles, has none because the outage isn't in its window).
- **Arm-line visibility:** `formatWatchdogArmLine` prints once, in the boot banner only (`scraper.js:385-390`) — a 200-line tail of a 3-day-old process cannot show it (process up since the Jun 29 00:24 boot). Arm state is nonetheless corroborated: the Jun 23 webhook attempts prove `ALERT_WEBHOOK_URL` is set in the live env (a console-only config would log no `webhook failed` lines), consistent with SURFACE-PRO.md:95-98.
- **Cookie-death coverage (track question):** full cookie death → logged-out x.com profile renders no `article[data-testid="tweet"]` → 15s `waitForSelector` timeout **throw** per handle (not an empty return) → strikes/disables + `fetchedTotal=0` → **dead-air alarm after ~15 min, guaranteed by the strike path** — provided the network is up to deliver the webhook (SC-8) and the process isn't wedged (SC-6). There is no explicit login-wall detector, so the log evidence on the day will read as generic timeouts (the alarm text's "Check browser_cookies.json" hint carries the diagnosis). Residual low-confidence risk: if X serves a logged-out public timeline for some profiles (UNVERIFIED), fetches keep "succeeding" on a degraded view and no alarm fires. Re-seed is undocumented (SC-9); the file is re-read every cycle so a fixed export self-heals without restart.

## Looked good

- **S-01 implementation quality:** pure, dependency-free watchdog module with real fixture tests through Chromium (`tests/strike-logic.test.js`, 26/26 pass); secret-hygiene is deliberate (arm line reports `webhook=yes/no` only, tested at :135-137 to never leak the URL).
- **Cursor/seen store:** clean advance-on-success-only semantics (`scraper.js:250-256`), BigInt high-water mark + `seen_tweets` PK belt-and-braces, transactional insert, 30-day prune at 04:00 ET (:372-376, :397). The Jun 23 timeout storm left cursors untouched (all fetches threw) — recovery forwarded 62 tweets with no dup-feed, and probe logs show cursors advancing normally on Jul 2 (rbssportsplays moved between the two probed cycles).
- **Handles endpoint design:** authoritative DB set with write-through cache, empty-set-means-stop honored, 10s abort on the fetch, cache never clobbered on failure (`scraper.js:293-331`).
- **Live posture:** pm2 scraper fork mode, ↺0, 3 days uptime; cycles completing ~104s for 8 handles; `[Init] Browser launched, 13 cookies loaded` every cycle; auth cookies currently healthy.
- **Repo secret history:** June audit's all-history scan (no cookie/session/db file ever committed) still holds — nothing new tracked since; the untrack commit `2b340f9` did forward-protection correctly (history held only NODE_ENV).
- **Ingest replay safety:** the two-sided id dedup means a POST that times out after bot receipt cannot double-stage bets — the retry is absorbed by `processed_tweets`.
