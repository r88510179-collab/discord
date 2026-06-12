# ZoneTracker Backlog

## ✅ Shipped

### DubClub email → Discord bridge (2026-05-30)
Built as standalone service `zonetracker-dubclub` on Surface Pro (PM2), NOT in this repo.
Repo: github.com/r88510179-collab/zonetracker-dubclub (commit 21f81c1). Watches Gmail via IMAP
for DubClub "New plays from <Capper>!" emails, follows CTA link, Playwright-scrapes plays page,
posts to per-capper Discord webhook → ingested via existing messageHandler path.
Live cappers: GuessAndPrayBets (GNP), TeamLockTalk (LockedIn → #lockedin-slips).
See that repo's docs/CODEMAP.md for env vars, config.json shape, and gotchas.

## ✅ SHIPPED — 2026-06-07/08 (F-12 dedup, F-07 multi-image, F-13 cleanup, scraper-handle mgmt, Phase 2b-2 recover+grace)

### F-12 — Twitter repost content-window dedup (#53, `3cfc694`)
`services/twitter-handler.js` now drops same-capper / same-content / same-odds Twitter reposts inside a 12h window as `DUPLICATE_REPOST` (new drop reason), after `VALIDATED` and before bet creation. `findRecentRepost` deliberately **ignores the tweet id** (which `buildFingerprint` folds into its key, so id-different reposts otherwise both save). Collapses `bobby__tracker`'s same-day reposts (observed gaps ≤3.25h) while preserving legit different-day repeats (≥2 days) — the headline regression test. Applied to the normal path and per-step to the ladder path. Mapped in docs/CODEMAP.md §Twitter ingest.
- **F-12 follow-up — dedup leak check (#60, `7fa1bfb`):** `services/dedupLeakCheck.js` — a daily read-only safety net (`reportDedupLeaks`, bot.js cron `0 13 * * *`) that re-derives the exact F-12 match key (imports `normalizeForDedup`, mirrors `findRecentRepost`) and posts one `#admin-log` alert **only if** a repost ever slips past the gate. Never writes. Read-only; 10 tests (`tests/dedup-leak-check.test.js`); deployed with the Jun 8 v589–v591 deploys (the earlier "v576" claim was premature — v576 predates the #60 merge; live image v591 includes `7fa1bfb`, verified 2026-06-10).

### F-07 — slip-feed multi-image processing (#61, `d0753f1`)
`handleSlipFeed` processed only `images[0]`; multi-slip messages silently lost bets `[1..n]`. Now loops `selectSlipImages(images)` (pure, exported): all `origin:'attachment'` real slips in order, capped at 4, each with a per-image ingestId (`slipImageIngestId`); embed/preview thumbnails are never multiply-processed. N=1 / embed-only / snapshot-only paths are byte-for-byte unchanged — only N≥2 real attachments changes behavior. Distinct from #40 (which fixed the OCR-first *measurement* count, not the live processing path). Mapped in docs/CODEMAP.md §messageHandler.

### F-13 — dead-function removal (#58, `6ec168e`) — Codex-cleanup F-10 + F-13
Removed three confirmed def-only, unexported functions from `handlers/messageHandler.js`: `safeReply`, `scanImage`, `handleAutoGrade` (no call sites repo-wide; grep-verified before delete). Deleting `scanImage` orphaned the `parseBetSlipImage` import, so it was also dropped from messageHandler's `require('../services/ai')` — `parseBetSlipImage` itself still lives in and is exported from `services/ai.js`, it just no longer has a caller there.
- **F-10 — already correct, no change:** the `grading_audit` parlay lookup in `shouldAutoVoidNoData` (`services/grading.js`) was already anchored as `<betId>-leg%` (not the over-matching `<betId>%`); `database.js:160` likewise. Read-and-confirmed; nothing changed.
- **F-14 — deliberately deferred:** the bootstrap DDL (`CREATE TABLE IF NOT EXISTS …` in `services/database.js`) is **load-bearing and idempotent**, so it was left untouched (out of scope per the cleanup prompt).

### Scraper-handle management + `guess_pray_bets` disabled (#46 `63595cd`, #54 `76e980a`)
`scraper_handles` (migration 027, seeds 9 handles, `INSERT OR IGNORE` preserves manual edits) is the DB-driven source for the Surface Pro Twitter scraper, read scraper-side via `GET /api/scraper-handles` (`MOBILE_SCRAPER_SECRET`, `enabled=1` only). Operator/dashboard management over the same table: read `GET /api/admin/handles` + write `POST /api/admin/handles/:handle` (`handleSetHandleRoute` — toggles `enabled`/`note` on a seeded row, never inserts; `ADMIN_API_SECRET`). The external dashboard's **Handles tab** is built on these. **Operational note:** `guess_pray_bets` is toggled **disabled** — GNP (GuessAndPrayBets) now arrives via the DubClub bridge (see ✅ Shipped → DubClub split pipeline), not the Twitter scraper. Mapped in docs/CODEMAP.md §routes + §`scraper_handles` management.

### Phase 2b-2 — on-demand hold Recover + backdate + sweeper-grace (#56 `5da6a49`, #59 `705db91`, #62 `94a973b`, #65 `ad08321`)
On-demand **Recover** for slip holds that were posted before their share-card unfurled (the HRB grade-before-unfurl race): `POST /api/admin/holds/:ingestId/recover` → `holdReview.recoverHold` re-fetches the now-unfurled message and re-runs the existing `vision_slip` extract+create path. Idempotent on `bets.source_message_id`; **creation-time `is_bet` gates and the hot won-race create path are untouched** (this rescues holds after they unfurl, it does not change any upstream drop). Two follow-ons make the rescued bet gradeable instead of instantly false-LOSSed:
- **Backdate (#59):** `recoverHold` backdates the recovered bet's `created_at`+`event_date` to the original slip post time so every grader family anchors the real game date (holdReview-only; the hot create path still defaults `created_at=now`/`event_date=NULL`).
- **Sweeper-grace (#62, migration 028):** because that backdate would make the bet instantly older than `SWEEP_DAYS` (7), `recoverHold` also stamps `bets.sweep_exempt_until = datetime('now','+3 days')` (the **recovery** moment, NOT backdated). The 7-Day Smart Sweeper (`grading.js runAutoGrade` → `evaluateSweep`) leaves any pending bet still inside its window pending (logged `[Sweeper] Grace skip …`) instead of auto-LOSS; past the window it sweeps normally. `sweep_exempt_until` defaults NULL for every normal bet (`evaluateSweep` reason `fresh`/`prop`/`grace`/`eligible`).
- **Fetch-retry (#65, `ad08321`):** `recoverHold`'s Discord re-fetch now retries transient misses (`_fetchMessageWithRetry`, 3 attempts with [500, 1500]ms backoff; null and throw both retryable, `deps.sleep` test seam). Fetch-only — extraction/create path untouched.

Mapped in docs/CODEMAP.md §services/holdReview.js + §7-Day Sweeper + recovery grace + §routes. The P1 HRB item above cross-refs why this rescues already-held slips without changing the upstream `ai_is_bet_false` drop.

## ✅ SHIPPED — 2026-06-10 (ops close-out: Gate 3 enforce, event_date validation, quarantine reset, Surface Pro S-01/U-1/D-1; **evening: #73 1-leg parlay + #74 search honesty, v606**)

All facts below verified live 2026-06-10 (Fly `/data/bettracker.db` read-only pull + Surface Pro `ssh`).

### Evening ship — #73 (1-leg parlay) + #74 (search honesty), deployed v606
Both merged and shipped in **v606** (clean main, `--no-cache`, ~18:40Z). Full narrative + watch items: `docs/retrospectives/2026-06-10.md`.
- **#73 (`31fd814`) — grade COMPLETE 1-leg parlays.** New pure helper `parlayLegDataComplete(description, legCount)` (`services/grading.js:257`, exported via `_internal`): complete ⇔ `legCount ≥ 1` AND `legCount ===` the description's `•` bullet count. The ≤1-leg grader guard (`:1996`) now skips to PENDING *only when not complete*, so a single pick stored as a 1-leg parlay dispatches to `gradeParlay` while the missing-legs / 0-leg rejection (and its exact reason string) is byte-identical. Multi-leg (≥2) untouched. Tests: `tests/oneleg-parlay-complete.test.js` (14). **Live-verified post-deploy:** three Group-B published-VOID resets graded on first cycles — `ee2f755d` Yankees ML (loss), `a1f9255b` Avalanche ML (win), `f71cbbc5…` Marlins ML (loss); counter-specimen `7b04366b` (0 bullets) stays rejected.
- **#74 (`4c992c9`) — search backend honesty (M-3) + query ordinal fix.** See the **search source-path arc → S2** entry below (marked SHIPPED + DEPLOYED) for the full description; `extractSubject` ordinal/period sentinel protection (`1st`–`4th` / `1H`/`2H` / `1Q`–`4Q` / `F5`) is Part 2. Tests: `tests/search-backend-honesty.test.js` (48) + patched `search-chain-order` (8). **Live-verified:** Bing `GENERIC_NEWS` → Brave `SUCCESS` fall-through on a real autograde query.
- **DB ops (read-only-guarded, base64-node-on-Fly):** pool-wide reset of **298** `backoff` bets' `grading_attempts` → 0 (counters accrued during the broken-search era; 264 were ≥5 attempts and would auto-void after 1–2 honest tries). `grading_next_attempt_at` untouched. Two nudge-script aborts (wrong column name; truncated bet id) are written up as worked examples in `docs/RUNBOOKS/db-interventions.md`.

### Gate 3 → `enforce` (quote-bound grading is live)
`QUOTE_BOUND_GRADING=enforce` is now live on Fly — verified **in-container** (`printenv QUOTE_BOUND_GRADING` → `enforce`), not just the staged default (which is still `shadow`). The shadow→enforce flip was decided after reviewing the persisted would-fire set: **7 distinct bets** carried a `GATE3_WOULD_FIRE` marker (`grading_audit.guards_failed`, 11 attempt-rows). All 7 reviewed cases were evidence-free **VOID**s — the grade was already heading to VOID/PENDING with no quotable evidence — so enforce blocks nothing that was grading correctly (**zero false positives**). Closes the "Gate 3 enforce flip (pending)" item below.

### event_date validation (#70, migration 029)
The write path is now gated by `normalizeEventDateForStorage` (`services/eventDate.js`), wired into `createBet` at `services/database.js:350`: `event_date` is stored as **NULL or a parseable datetime**, never a time-only / free-text string. Migration **029** (`029_null_unparseable_event_dates.sql`) applied the same rule to existing rows (`UPDATE bets SET event_date=NULL WHERE event_date IS NOT NULL AND datetime(event_date) IS NULL`). Read-side defense in `grading.js` GUARD 3: when a stored `event_date` resolves >0.25h ahead of now, the grader falls back to `created_at` (marker `grade.event_date_skew_fallback`, `:2154`) so legacy time-only strings ("9:10PM ET") can't re-anchor to "today" every poll and burn attempts to quarantine forever. **Corrupt unparseable rows: 19 → 0** (verified live: `COUNT(*) WHERE event_date IS NOT NULL AND datetime(event_date) IS NULL` = 0). The poison specimen `3a503cc4…` named in the migration is the same Soccer bet now sitting (correctly) in quarantine below.

### Quarantine reset (18 → 3 at close-out; **4 live**)
The quarantine backlog was manually reset today (18 quarantined → 3). **Verified live 2026-06-10: 4 bets remain** in `grading_state='quarantined'` — one more NBA missing-legs parlay re-accrued past the attempt-20 cap since the reset — in two classes:
- **Missing-legs parlays (2, both NBA)** — stored with only **1 recorded leg**; the grader returns *"Parlay has 1 recorded legs — cannot grade without leg data. Manual review required."* Needs manual leg reconstruction. (`7b04366b…` Jokic/Brunson/Mitchell combine, 22 att; `b0140947…` Spurs/OKC Over 218.5, 20 att.) See **"Quarantined missing-legs parlays"** entry below.
- **Soccer awaiting a result source (2)** — all legs recorded but every leg PENDING because there is no Soccer adapter / usable search path (`3a503cc4…` 5 legs; `d8e42b70…` 9 legs). Clears once the search arc gives Soccer a source (S4 below).

### Surface Pro S-01 / U-1 / D-1 — shipped + deployed
- **S-01** (scraper dead-air watchdog + arm-time observability) — PRs #3 + #4 merged and **deployed** to the box (`zonetracker-scraper` HEAD `ff9fda0` = "Merge PR #4"; was `e28d768`/PR #3 at the time `docs/SURFACE-PRO.md` was captured — that doc's HEAD line is patched in this PR). Zero-tweet strike fix + dead-air alarm (#3); arm-time log line + ISO-timestamped `[Strike]`/`[Disable]`/`[Alarm]`/`[DeadAir]` logs (#4).
- **U-1** (dubclub browser watchdog) — PR #2 merged + deployed (`zonetracker-dubclub` HEAD `b55c449`).
- **D-1** (dashboard upstream mid-body-failure containment) — #5 merged + deployed (`zonetracker-dashboard` HEAD `b37e51a`).

### U-6 — dubclub canonical env = `ecosystem.config.cjs` (closed)
The S-01/U-1 wiring made `ecosystem.config.cjs` the canonical env source for `zonetracker-dubclub`: PM2 injects the `.cjs` env at spawn and dotenv does **not** override already-set vars, so the `.cjs` values win over the overlapping `.env`. Documented in `docs/SURFACE-PRO.md` (`zonetracker-dubclub` section).

### Scraper exec_mode fork fix
`zonetracker-scraper`'s `ecosystem.config.js` now sets `exec_mode: 'fork'` **explicitly** alongside `instances: 1`. PM2 silently defaults to **cluster** mode whenever `instances` is set, which a single-process scraper must not run as. Verified live: `pm2 jlist` → `zonetracker-scraper fork_mode instances=1`. `zonetracker-dubclub` carries the same explicit `exec_mode: 'fork'`.

---


## ✅ SHIPPED — 2026-06-10 evening batch 2 (#76 grading + #77 ROI, v610; LockedIn swap, dubclub#3)

PRs #76 (`7a55842`) + #77 (`3ed77e2`) merged and deployed together as **v610 ~21:30Z**. Verified live via `/admin` snapshot (Fly `/data/bettracker.db` read-only).

### #77 (`3ed77e2`) — unify + correct the capper ROI formula
ROI% = Σ(profit_units) ÷ Σ(units risked) over settled bets, now defined **once** in `CAPPER_STATS_COLUMNS` (`services/database.js:713`) and shared verbatim by `getCapperStats` (`:737`) and `getLeaderboard` (`:753`) — previously two byte-identical-but-drift-prone copies. The fix:
- **Removed the arbitrary per-bet `MAX(units,1)` floor** that inflated risked capital and understated losses. `capperledger` (0-4, stakes 0.09/1/1/1u) read **-77.3%** when the true ROI is **-100%** (lost all risked capital) — corrected live post-deploy.
- Numerator and denominator now read the **same settled set** — `SETTLED_BET` = `result IN ('win','loss','push') AND profit_units IS NOT NULL` (`:712`); push stake counts as risked capital; graded-but-unpriced (`profit_units` NULL) rows drop from both.
- `CAST(units AS REAL)` coerces legacy text-garbage stakes (`"N/A"`, `"mortal mega max"` — real rows) to 0 deterministically instead of leaking through SQLite's scalar `MAX()`.
- Division guarded once at the aggregate (`NULLIF(denom,0)` + `COALESCE`) → `roi_pct` is always finite (0 when nothing settled), never NULL/NaN/÷0.
- **No silent display cap.** `flagAbnormalRoi(row)` (`:731`) *logs* `>500%` for monitoring but never clamps. Validated read-only vs Fly prod: across all 24 cappers exactly **one** value changes (`capperledger -77.3% → -100%`); `total_profit_units` unchanged for everyone. Tests: `tests/capper-roi.test.js` (10).
- **No-cap correction (closes the old "Capper ROI display bug" + the "2498.5% after Scoot override" items):** top-3 are now differentiated and `dangambleai +2498.5%` is **arithmetically real** (49.97u profit on 2u risked via a `+5097` longshot hit), **not** a cap artifact. There is **no live 500% cap** — the historical `+500%` cluster was the pre-`faa88208` export's clamp behavior, removed 2026-04-13.

### #76 (`7a55842`) — query-builder artifacts + defensive Bing parse (+ resolver env drop)
- **`extractSubject` slash→space + orphan-dash cleanup** (`services/grading.js:1425`): slash/backslash between tokens now becomes a **space** (`:1453`) instead of being deleted — `"McGhee/Yannis ITD"` → `"McGhee Yannis ITD"` (was the unsearchable `"McGheeYannis ITD"`), DubClub `"CHC/PHI"` → `"CHC PHI"`; orphan dash-runs isolated by whitespace/boundary are dropped (`:1466`) — `"Joanderson Brito ML (-165)"` → `"Joanderson Brito"` (was `"Joanderson Brito -"`), while intra-word hyphens (`Saint-Denis`) survive. The #74 ordinal/period sentinels (`1st`–`4th`, `1H`/`2H`, `1Q`–`4Q`, `F5`) are unaffected.
- **New pure `parseBingHtml(html)`** (`:1829`, exported via `_internal`): ordered block-delimiter fallback (`b_algo` → `b_algoheader` → `b_ans`) × ordered title/snippet selectors (`h2`/`h3`/`tilk`/anchor; `b_caption>p`/`b_lineclamp`/`b_algoSlug`/first-`p`); first delimiter yielding ≥1 hit wins, 5-block cap preserved. A total miss returns `[]` → `assessSearchResults` flags `parse_empty` → S2 honesty gate falls through to Brave (the gate is **not** weakened). Tests: `tests/query-builder-bing-parse.test.js` (37).
- **Dead resolver env removed:** `fly.toml` `RESOLVER_URL`/`RESOLVER_VERSION` `[env]` entries deleted (grep confirmed no JS reads them); the `zonetracker-resolver` Fly app is **destroyed**.

### dubclub#3 (`23c63ed`) — GNP leg-drop fix (deployed box-side)
`zonetracker-dubclub` PR #3 merged + deployed on the Surface Pro (pm2 restarted, watchdog armed): TOTAL regex `/(?<!\d)[OU]\s?\d+/i` fixes the **fused-marker** drop (e.g. `O8.5` runs read as a leg) + adds a new **F5** (first-5-innings) signal. Root cause and the Jun 5 deploy-timeline correlation (`0da16bc`) are in the PR body.

### LockedIn handle swap — TeamLockTalk → lockedin_sportz (complete end-to-end)
The dead `TeamLockTalk` handle was retired and `lockedin_sportz` wired in across all three sources of truth:
- **Box-local DubClub config** (`~/zonetracker-dubclub/config.json`, backup `config.json.bak-20260610`): `TeamLockTalk` removed; boot now logs `"1 capper(s): GuessAndPrayBets"`.
- **Fly `scraper_handles`**: `lockedin_sportz` inserted (`enabled=1`, dated note); scraper confirmed `"[Handles] fetched 8 active from Fly"`.
- **Fly `tracked_twitter`**: `lockedin_sportz` row inserted with `display_name='LockedIn'`, channel `1485091165308190780` — so its picks attribute under the **LockedIn** capper, not the raw handle.
- **Architecture finding (root cause of capper splits):** the handle source of truth is `scraper_handles` on Fly, served at `HANDLES_URL` (`GET /api/scraper-handles`, `x-mobile-secret` auth); the scraper's `active_handles.json` is a **write-through cache with built-in fallback**. Capper attribution derives from `tracked_twitter.display_name`, and a handle **without** a `tracked_twitter` row attributes under the **raw handle** — this is the root cause of the `LockedIn`/`lockedin_sportz` and `guess_pray_bets` duplicate-capper splits. See the **"Capper dedup / merge"** item in the search-arc follow-ups below.

### Ops
- **298-bet `grading_attempts` reset** — already documented in the 2026-06-10 ops close-out above (do not duplicate).
- Stale worktrees pruned; `zonetracker-resolver` Fly app destroyed.

---


## ✅ SHIPPED — 2026-06-11 (KBO normalization + validator, GUARD 5 human bypass, relay restoration)

PRs #82 (`b4f4097`), #84 (`4c2ed71`), #85 (`1bfb053`) merged to `main`. **Deploy note:** #84 and #85 were each **initially deployed as phantoms** (the `--local-only` build shipped a stale working tree — `git pull` read "Already up to date" after the merge); caught and re-deployed correctly. This is the motivating incident for the new **DEPLOY_CHECKLIST.md step 4b** (post-merge top-commit gate).

### #82 (`b4f4097`) — compound multi-sport declared sport treated as a set
`validateLegSportConsistency` (`services/ai.js:1949`) now parses the declared parlay sport as a **set** (`split(/[/&,]/)`, trim, drop empties; intersection with `matchedSports`), so a compound declaration like `MLB/NHL` no longer self-contradictorily drops a valid MLB *or* NHL leg. Single-sport verdicts + reject-reason bytes are **identical** (one-element set), and the mismatch check is not loosened. Tests folded into `tests/leg-sport-consistency-validation.js` (31/31). Mapped in docs/CODEMAP.md §services/ai.js. **Downstream gap (open):** the *grade-time* `isSupportedSport` (`services/grading.js:387`) still does an exact single-key `SUPPORTED_SPORTS.has()` check, so a parlay whose stored `sport` survives as `MLB/NHL` is auto-voided (`auto_void_unscoped_bet`) at `:2022` — see "Open follow-ups — 2026-06-11" below.

### #84 (`4c2ed71`) — GUARD 5 human bare-total bypass + silent-drop instrumentation
Incident 2026-06-11: human-typed bare totals in #lockedin-slips (a DubClub-split channel) were dropped by GUARD 5 (`looksLikePick` <2 signals, no celebration, no images). Two-part fix in `handlers/messageHandler.js`:
- **Author-agnostic DubClub bypass** (`:945`): the split-channel bypass now gates on channel membership ALONE (`isDubclubSplitChannel`), so human authors bypass GUARD 5 just like the webhook relays. Humans forward their real attached images; the webhook image arg stays `[]` (byte-identical to ffddb09). Pre-#84 the gate also required `webhookId || author.bot`.
- **New drop reason `GUARD5_INSUFFICIENT_SIGNALS`** (registered `services/pipeline-events.js:49`, added to CODEMAP §Enums, asserted by `tests/pipeline-events-enums.test.js`) replaces the misleading `PRE_FILTER_NO_BET_CONTENT` at GUARD 5 (`:972`), so "a real bare total was discarded by the heuristic" is queryable apart from genuine non-bet text. Also closed two previously-**silent** returns: `!message.guild` → `CHANNEL_UNAUTHORIZED` drop (`:771`), and a partial-fetch failure → `recordError` (`:783`). The dedup short-circuit (`:794`) stays silent on purpose. **The `is_bet === false` hard rule is UNTOUCHED.** 3 new integration tests. Mapped in docs/CODEMAP.md §messageHandler.js + §"DubClub split bypass".

### #85 (`1bfb053`) — KBO nickname-injection gate + sponsor-prefix guard
`normalizeDescription(text, declaredSport)` (`services/normalization.js:314`) gained a `shouldExpandAliases` gate (`:285`) that **suppresses** nickname-alias expansion for any league not modeled in `data/mappings/teams.json` (KBO/KHL/NPB/… — NBA/NFL/MLB/NHL are the modeled set), so a bare "Eagles"/"Lions" in a KBO slip is no longer corrupted into "Philadelphia Eagles" (a Korean club, Hanwha Eagles). `Unknown`/placeholder/generic modeled-league NAMEs still expand (preserves the LAL/Dubs class). A sport-**independent** `hasSponsorPrefix` backstop (`:217`) blocks expansion when a KBO sponsor (Hanwha/Samsung/LG/Lotte/Doosan/KIA/SSG/KT/NC/Kiwoom) immediately precedes the nickname **on the same line**, even when `detectSport` mislabels the bare text as a US league. `services/ai.js normalizeBet` passes `bet.sport` into both the parent-desc and per-leg calls. New `tests/normalization-validation.js` TEST 6b; the disambiguation harness now exits nonzero on regression. Mapped in docs/CODEMAP.md §services/normalization.js.

### ALLOWED_WEBHOOK_IDS relay restoration (env-only, no code change)
The Fly secret `ALLOWED_WEBHOOK_IDS` was restored to **6 IDs** on 2026-06-11: the 2 DubClub-bridge relay webhooks (LockedIn, GNP) + the 4 TweetShift relay webhooks (gambling-twitter dan/cody/gavin/harry). The 4 TweetShift IDs had been dropped in the **May 31 secret rotation**, so the bot's `globalPipelineGuard` denied those webhook authors as `bot_not_whitelisted` (`handlers/messageHandler.js:318`) and the four relay channels were **dark May 31 → Jun 11**. **Historical: ~860 relay posts were lost in that window and are unrecoverable** (relay re-posts are not re-fetchable after the fact). Secret-only change; mapped in docs/CODEMAP.md §"Env vars that gate behavior".

### Cross-repo — zonetracker-dubclub splitter hardening (box-side)
`zonetracker-dubclub` (Surface Pro PM2 service, NOT this repo) shipped splitter improvements: **pick'em** + **bare-decimal** leg parsing + a **UNIT backstop**, **`auditSplit` drop alerts**, and `normalizePick` **Pickem→ML** normalization. Recorded here for cross-repo traceability; see that repo's own docs for detail.

## Open follow-ups — 2026-06-11

### Scraper `fetchTweets` renders only ~4 articles for some profiles (opened 2026-06-11)
The Surface Pro scraper's `fetchTweets` surfaced only **~4 articles** for some profiles in a poll cycle and **missed the 2026-06-10 LockedIn slip tweet `2064909737662247302`**. Suspected: the timeline DOM renders fewer `article` nodes than expected before the scrape reads them (lazy-render / insufficient scroll depth), so recent tweets past the first few are never seen. **Probe owed:** instrument the per-profile article count per cycle and confirm whether a scroll/wait or a larger render window recovers the missed tweets. Cross-ref the LockedIn handle swap (above) and the `page.waitForSelector` timeout item under the search-arc "Handle review".

### Grade-time compound / unsupported sport — `isSupportedSport` auto-void risk (opened 2026-06-11, #82 downstream)
`isSupportedSport` (`services/grading.js:387`) does an exact single-key `SUPPORTED_SPORTS.has(uppercased)` membership test (`SUPPORTED_SPORTS` `:267`). It does **not** split or normalize the stored sport, so:
- **Stored multi-sport parlays** whose `sport` survives as a compound string (`MLB/NHL`) fail the check → **auto-voided** (`auto_void_unscoped_bet`) at `:2022`, skipping ESPN+AI. #82 fixed only the *parse-time* leg validator; the grade gate is the unfixed downstream half.
- **KBO bets are ungradeable** — `KBO` is not in `SUPPORTED_SPORTS`, there is no `services/sportsdata/` KBO adapter, and KBO team data lives only as `KBO_TEAMS` in `services/ai.js:1716` (the parse-time validator), **not** in `data/mappings/teams.json`. Adding KBO team data to teams.json + a result source is a possible follow-up.
**Action:** split/normalize the stored sport at the grade gate (mirror #82's set logic), and decide whether to add KBO to `SUPPORTED_SPORTS` + a source path. Pairs with the search-arc per-sport rollout (S4).

### War-room "Bet not found or already confirmed" on message `1514639924660539442` (opened 2026-06-11, parked)
A war-room action on message `1514639924660539442` returned **"Bet not found or already confirmed"** — **unreproduced** this session. Parked: on the next recurrence, capture the full interaction timeline (which button, the staged bet's `review_status`, whether a prior confirm/edit had already resolved it) before investigating. Low signal until it repeats.


## ✅ SHIPPED - Weekend 1 (Apr 20)

### MLB StatsAPI Resolver — live in production

**Deployed:** v291 (bot) + v10 (resolver app `zonetracker-resolver`)

**What it does:** Deterministic grading for MLB player props via `statsapi.mlb.com`. Bot calls resolver before ESPN pre-check; falls through cleanly on non-decisive results. Zero AI calls, zero web searches, sub-second grades.

**Architecture:**
- Resolver app (`zonetracker-resolver.fly.dev`, internal `http://zonetracker-resolver.internal:8080`)
- Schedule puller: every 15 min, D-1 through D+1 in ET
- Boxscore puller: every 2 min, drains `status='F' AND boxscore_fetched_at IS NULL`
- Teams seeded on first boot (30 teams)
- Schema: `mlb_games`, `mlb_teams`, `mlb_players`, `mlb_player_game_stats`, `fetch_log`, `schema_migrations`
- DB at `/data/resolver.db` on Fly volume (path resolves via `FLY_APP_NAME` detection — not `NODE_ENV`)

**Endpoints:**
- `GET /mlb/stats` → 15 supported stat keys
- `GET /mlb/schedule?date=YYYY-MM-DD`
- `GET /mlb/game?teams=XXX,YYY&date=YYYY-MM-DD`
- `GET /mlb/player-prop?player=...&stat=...&threshold=N&direction=over|under&date=YYYY-MM-DD` → `{ result: win|loss|push|pending|unknown, actual, player, game, source }`
- `POST /admin/*` (seed-teams, pull-schedule, pull-boxscore, pull-pending-boxscores) — requires `X-Admin-Key` secret

**Bot integration (`services/resolver.js`):**
- 2.5s timeout, 1h stats cache, 3-strike circuit breaker (2 min open)
- Inserted in `gradeSingleBet` before ESPN pre-check, gated to `sport === 'MLB'`
- `/admin resolver-health` shows live status + counters
- Pitcher-context rewrite: bare "strikeouts" → `pitching strikeouts` when description contains pitching cues

**Stats supported:** hits, runs, rbis, home_runs, total_bases, walks, strikeouts_batter, stolen_bases, strikeouts_pitcher, hits_allowed, runs_allowed, earned_runs, innings_pitched, outs_recorded, hits+runs+rbis

**Verified live (Apr 20):** `Jose Altuve Over 0.5 Hits` on 2026-04-19 → WIN actual=3 via `mlb.statsapi`, sub-second response.

---


## 🚨 KNOWN BUG - Priority 1

### HRB slip shares dropped at `ai_is_bet_false` — Gemma gate blind to `type: 'ignore'`

**Symptom**: DatDudeStill posts Hard Rock Bet shares in #ig-dave-picks (he stopped using #datdude-slips after 2026-04-17). Vision AI returns `type: 'ignore'` / `is_bet: false` on the slip image. `parseBetText` returns that verdict, and `messageHandler.js:1098` drops at `PRE_FILTER_NO_BET_CONTENT / filter: ai_is_bet_false`. No bet reaches war-room.

**This is no longer silent — pipeline_events stamps it correctly.** The user perceives it as a drop because no bet appears; the instrumentation captures the rejection. Confirmed live trace 2026-05-13 03:15 UTC, ingest `disc_1503958745313575097` (full payload preserved): RECEIVED → AUTHORIZED → BUFFERED → EXTRACTED (`imageCount: 2`) → PARSED (`type: "ignore", betCount: 0`) → DROPPED (`PRE_FILTER_NO_BET_CONTENT`, `filter: ai_is_bet_false`, sample: "Check out this bet I placed on Hard Rock Bet!").

> **Note on that `imageCount: 2`** (PR-open 2026-06-05): the "2nd image" is the Discord **share-embed thumbnail**, not a second slip — the rescue replay confirmed real attachment count = 1 on all 25 HRB failures. The OCR-first seam now derives `imageCount` from `ocrFirstWiring.eligibleImageCount(combinedImages)`, counting only `origin:'attachment'` images. This unblocks OCR-first **shadow measurement** of HRB rescue (the slip+embed slip now shadow-labels `scope=single` with a real `agreement` value instead of `image[0]_of_multi`/`agreement=false`). Measurement-only while `OCR_FIRST_MODE=shadow`; does not by itself change the `ai_is_bet_false` drop. See `docs/specs/ocr-first.md` §8.2.

**Root cause**: `shouldFallbackToGemma()` in `services/ai.js` only fires the no-legs trigger when `quick.type === 'bet'` or `quick.is_bet === true`. When the primary AI returns `{type: 'ignore'}` on an image-bearing slip, the gate is bypassed — Gemma never gets to retry. Confirmed: zero `vision_failures` rows for `cdn.discordapp.com` images since instrumentation.

**Anchor data point**: 1 of 6 historical HRB shares with identical boilerplate text DID produce a bet (2026-04-06). Same wrapper, same author, same channel — Vision AI is non-deterministic on this exact-shape input. Gemma fallback would give a second swing.

**SUPERSEDED 2026-05-14**: Fix A's Gemma fallback target permanently disabled via GEMMA_FALLBACK_DISABLED=true (v431, cf58b4c) — Surface Pro 5 hardware ceiling makes inference within Fly's 90s timeout infeasible (7-17min real inference times). Visibility for these drops now provided by v434 admin-log notice (`⚠️ Slip dropped` posted to ADMIN_LOG_CHANNEL_ID with View Original link). Full review-queue routing pending — see "Human-channel slip review routing" below. Original Fix A note preserved for audit:

**Fix A (shipped v405, commit `b1c2b19`, 2026-05-13)**: Extended `shouldFallbackToGemma()` with 4th param `verdictType`; fires on `quick.type === 'ignore'` when an image was supplied. Gate firing per `vision_failures` rows. Gemma fallback target was broken Apr 30 → May 14 due to proxy secret drift (rotated v413, 2026-05-14). End-to-end verification on a real DatDude HRB ingest staging a bet via Gemma is still pending — waiting on next HRB post in `#ig-dave-picks`. Open code concern: `ignoreVerdictWithImage` var lacks image-presence check in its own definition; safe only because `parseBetText` is the sole caller passing `verdictType`.

**Hard rule for any subsequent fix**: do NOT loosen `parsed.is_bet === false` check in `messageHandler.js:1098`. v335 (commit 289ce3b) tried `is_bet !== true` and dropped every Type 1 bet because `parseBetText` leaves `is_bet` undefined on successful returns. Rolled back as v337. See `skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md` ERRATA-3.

**Already shipped (this bug class, partial coverage)**:
- Fix B (slip-share exemption in `validateParsedBet`, commit `3aadc63`, 2026-05-07): `services/ai.js:1515` defines `slipExempt = slipShape || hasMedia`, gates the entity-mismatch check at `:1573` and the brand checks at `:1598` / `:1608`. Closed the 98-hits/7d `VALIDATOR_ENTITY_MISMATCH` bucket. Fixes the case where Vision DID extract a bet from the image but text-only validator rejected the entities.
- pipeline_events instrumentation (migrations 018 + 021): verified healthy 2026-05-13 — 1102 rows/24h, GRADE_* drop reasons stamping, zero synthetic `bet_%` ingest_ids, zero orphan-class drops.

**Cross-ref — after-the-fact rescue shipped (Phase 2b-2), does NOT change this drop:** for HRB shares already sitting in the hold queue, on-demand **Recover** (#56, `5da6a49`; `POST /api/admin/holds/:ingestId/recover` → `holdReview.recoverHold`) re-fetches the now-unfurled message and re-runs the existing `vision_slip` extract+create path. Recovered bets are backdated to the slip post time (#59, `705db91`) and given a 3-day `sweep_exempt_until` grace window (#62, `94a973b`) so the 7-Day Sweeper can't false-LOSS them first; the recover fetch retries transient Discord misses (#65, `ad08321`). **Creation-time `is_bet` gates and `MANUAL_REVIEW_HOLD` staging are untouched** — this rescues holds after they unfurl; it does not alter the `ai_is_bet_false` drop analyzed above. Mechanism mapped in docs/CODEMAP.md (§services/holdReview.js + §7-Day Sweeper + recovery grace).


### OCR-first SGP gate — would-hold measurement (PR 2a shadow) → drop→hold (PR 2b)

**PR 2a — measurement only, shadow-path, NO behavior change.** SGP/SGPMAX slips bail to `FALLBACK_GEMINI` *before* Groq runs (`services/ocrFirst.js` "SGP gate — BEFORE Groq"), so the deterministic gate from #41 (`services/sgpGate.js evaluateSgpGate`) had never run on live traffic. In `OCR_FIRST_MODE=shadow`, `ocrFirstWiring.runSgpWouldHold` now re-uses the OCR text that bail already produced to run the skipped chain — Groq parse → `extractHeaderLegCount` (declared "N-Bet" count) → `evaluateSgpGate` — and emits one fire-and-forget `pipeline_events` event **`ocr_sgp_would_hold`** (stage `OCR_FIRST`, additive; NOT in `pipelineHealth.EXPECTED_STAGES`) with `{ pass, reason, declaredLegCount, parsedLegCount, scope, ocrMs }`. à la the Gate-3 B0 would-fire pattern (#37). The returned decision stays `FALLBACK_GEMINI` — nothing about what any slip does today changes; the extra Groq call is shadow-only and self-swallowing. Read the split after deploy:
  `SELECT json_extract(payload,'$.pass') pass, count(*) c FROM pipeline_events WHERE event_type='ocr_sgp_would_hold' AND created_at > strftime('%s','now','-7 day') GROUP BY 1` (also `GROUP BY json_extract(payload,'$.reason')`, filtered to `scope='single'`).

**PR 2b (next — the only behavior change), gated on the shadow split looking right** (PASS on rescuable SGP, FAIL on phantom/junk): flip drop→hold on a gate PASS (signed-off design D2) and extend the `MANUAL_REVIEW_HOLD` payload + modal to carry the OCR legs (#41 discovery finding #2).


### ~~Retry storm: ai_pending_legs denial bypasses attempt cap~~ — RESOLVED

**RESOLVED (shipped, verified live 2026-06-10):** `scheduleRecheckAfterDenial` caps denial requeues at `RETRY_CAP=15`, then voids with `GRADE_BACKOFF_EXHAUSTED` inside a transaction (`services/grading.js:606-641`). The 162-attempt class cannot recur; `GRADE_BACKOFF_EXHAUSTED` firing ~3/day live (21 drops/7d per COA audit 2026-06-10 §F.5).

Historical context for the record: 2 NBA parlays (`8260a661…` 163 attempts, `5c963d41…` 162 attempts, Apr 14-15 2026, voided manually Apr 21) were the observed storms — `scheduleRecheckAfterDenial(ai_pending_legs_N, 30)` flipped `grading_state='ready'` unconditionally, bypassing the normal ~20-attempt backoff escalation. Null `event_date` was ruled out as the cause. Full diagnostic preserved in this entry's git history.

## Grading Reconciliation Project — all-time regrade with Claude + ChatGPT

**Status**: Spec drafted Apr 22. Diagnostic findings: of 6 sampled outlier bets (+500% ROI cappers), 6/6 stored profit_units values matched the American odds formula exactly. Profit math is correct. The regrade is motivated by: (a) outcome assignments may have drifted across grader versions, (b) some old bets may have wrong win/loss calls, (c) a dual-LLM cross-check establishes a ground-truth baseline going forward, (d) builds documented truth-source provenance for future grading improvements.

**Approach — manual LLM regrading, import back to DB**:
- No API integrations. Claude + ChatGPT web sessions do the regrading in parallel.
- Export pending-regrade bets as structured batch files (JSON).
- Paste each batch into Claude and ChatGPT separately, collect verdicts.
- Import verdicts back to DB as v2 (Claude) / v3 (ChatGPT) side records.
- Compare v1 vs v2 vs v3 — any disagreement or missing evidence flags for human review pile.

### Phase 1 — Infrastructure (1 session)
- **Migration 022** — two new tables:
  - `regrade_results`: `bet_id`, `model` (claude|chatgpt), `batch_id`, `result_v2`, `profit_units_v2`, `grade_reason_v2`, `evidence_url`, `evidence_source`, `evidence_quote`, `pile_flag` (boolean), `pile_reasons` (JSON array), `regraded_at`
  - `bet_grade_history`: preserves v1 before any overwrite. Columns: `bet_id`, `old_result`, `old_profit_units`, `old_grade_reason`, `archived_at`, `archived_by`, `reason`
  - `regrade_batches`: tracks batch progress. Columns: `batch_id`, `bet_count`, `exported_at`, `claude_imported_at`, `chatgpt_imported_at`
- **Export script** `scripts/regrade-export.js`:
  - Queries all bets with `result IN ('win','loss','push','void')` all-time (~580 bets).
  - Splits into ~12 batches of 50 bets each.
  - Writes `regrade_batch_{01..12}.json`. Each row: `{bet_id, capper, description, odds, units, bet_type, sport, original_result, original_profit_units, created_at, source_url}`.
  - Records batch metadata in `regrade_batches`.

### Phase 2 — Prompt template + truth sources (same session as Phase 1)
- **Prompt template** `docs/REGRADE_PROMPT.md`. Identical for both LLMs.
- Prompt structure: role (sports betting grader), strict output format (JSON only, no prose), explicit hallucination rules, source whitelist, edge-case handling.
- **Output format per bet** (strict JSON):
```json
  {
    "bet_id": "...",
    "result": "win|loss|push|void|unknown",
    "profit_units": 0.91,
    "grade_reason": "concise factual statement",
    "evidence_url": "https://...",
    "evidence_source": "espn_mlb",
    "evidence_quote": "verbatim text from source, 20+ chars"
  }
```
- **Required evidence fields for any non-unknown verdict**: `evidence_url`, `evidence_source` (from whitelist below), `evidence_quote` (verbatim, 20+ chars).

### Phase 3 — Hallucination prevention (NON-NEGOTIABLE)
The greatest risk in LLM-driven regrading is confident-but-wrong verdicts. Every rule below is mandatory and enforced at ingest, not trust-based.

**Rule 1 — "Unknown" is correct behavior, not failure.**
If the LLM cannot find a specific citable source for a bet's outcome, the correct output is `result: "unknown"`. The LLM must never infer, estimate, or extrapolate. Historical averages, capper patterns, typical outcomes — all forbidden.

**Rule 2 — Every non-unknown verdict REQUIRES evidence_url + evidence_source + evidence_quote.**
Missing any → auto-downgrade to `unknown` at import. `evidence_quote` must be verbatim (not a paraphrase), 20+ chars, and support the verdict.

**Rule 3 — Source whitelist per sport.** Enforced by import validator:
MLB:     mlb_statsapi | espn_mlb
NBA:     espn_nba | nba_com
NHL:     espn_nhl | nhl_com
NFL:     espn_nfl | nfl_com
NCAAB:   espn_ncaab
NCAAF:   espn_ncaaf
Soccer:  espn_soccer | official_league_site
Tennis:  atp_official | wta_official | espn_tennis
Golf:    espn_golf | pga_tour | european_tour
UFC/MMA: ufcstats | sherdog | espn_mma

Non-whitelisted sources (Reddit, blogs, aggregators, Twitter, unofficial sites) → auto-pile.

**Rule 4 — Prompt explicitly forbids hedge language.**
Prompt's "Forbidden" section lists: "based on typical outcomes", "most likely", "probably", "seems to have", "historical data suggests", "likely won", "could have". Must cite specific sources only.

**Rule 5 — Strict pile-flagging.** A bet enters the `human_review_pile` if ANY of these conditions hit:
- LLM returned `unknown`
- Missing/invalid `evidence_url`, `evidence_source`, or `evidence_quote`
- `evidence_source` not in whitelist for the bet's sport
- Claude and ChatGPT disagree on `result` (win vs loss vs push vs void)
- Profit_units disagreement >5% of original value
- Bad JSON (failed to parse)
- `grade_reason` contains hedging keywords: "likely", "probably", "seems", "based on", "typical", "probably won", "most likely"
- `evidence_quote` < 20 chars or appears to be paraphrased (doesn't match domain of evidence_url)

Bets in the pile are NEVER auto-promoted. User reviews each manually, grades by hand, or marks "cannot verify — keep v1."

**Rule 6 — Enforcement at ingest, not trust-based.**
`scripts/regrade-import.js` validates every verdict against all rules above before writing. Failed validation → write as `pile_flag=true` with `pile_reasons` array populated. Never reject silently — every attempt is recorded for audit.

### Phase 4 — Provenance + auditability
**`regrade_evidence` table** (provenance store, separate from `regrade_results` for query performance):
- Columns: `bet_id`, `model`, `batch_id`, `evidence_url`, `evidence_source`, `evidence_quote`, `captured_at`
- Never overwritten — survives promotion. Enables retroactive audit of any grade months later.

**Audit report** `scripts/regrade-audit-report.js`:
- Runs after each full regrade pass.
- Outputs `docs/REGRADE_AUDIT_{YYYY-MM-DD}.md` with:
  - Per-sport breakdown (total bets, verdicts, pile count, pile rate)
  - Per-source usage (which sources each model trusted most)
  - Disagreement matrix (Claude vs ChatGPT divergence by sport, capper, odds range)
  - Coverage gaps (sports with >30% pile rate — flag for upstream truth-source improvements)
- This document is a reusable artifact — future grader work references it.

### Phase 5 — Execution (user-paced, multiple sittings)
- Run export script → generates 12 batch files.
- For each batch (1 through 12):
  1. Open Claude web chat → paste `docs/REGRADE_PROMPT.md` + `regrade_batch_{N}.json` → save output as `batch_{N}_claude.json`.
  2. Open ChatGPT web chat → paste same prompt + batch → save as `batch_{N}_chatgpt.json`.
  3. Run `scripts/regrade-import.js batch_{N}_claude.json batch_{N}_chatgpt.json` → validates every rule, writes to `regrade_results` + `regrade_evidence`.
  4. Script confirms: count of bets imported, count flagged to pile, count clean.
- Both LLMs may not grade a bet fully (LLMs sometimes skip items). Import script rejects batches where bet_id count mismatch ≠ exported count.

### Phase 6 — Review + promote (1-2 sessions after execution)
- **Admin command** `/admin regrade-status` shows: total regraded, agreement rate (v1=v2=v3), disagreement count, pile count, breakdown by pile reason.
- **Review query** `scripts/regrade-review.sql`: outputs disagreement + pile rows with all three verdicts side-by-side plus evidence URLs.
- **Promotion script** `scripts/regrade-promote.js`:
  - Dry-run mandatory first (`--dry-run` flag).
  - Accepts per-bet-id decisions from a curated TSV input file the user prepares.
  - For each promoted bet: archives v1 to `bet_grade_history`, updates `result` and `profit_units` in `bets`, logs to `pipeline_events` with `stage='REGRADE_PROMOTE'`.
- **No retroactive ROI update needed** — capper ROI computed on read.

### Success criteria
- All ~580 bets have v2 (Claude) + v3 (ChatGPT) values written to `regrade_results`, each with structured evidence or pile_flag reason.
- Disagreement rate established as empirical baseline for grader quality.
- Every non-pile grade has citable, whitelisted-source evidence in `regrade_evidence`.
- `docs/REGRADE_AUDIT_{date}.md` generated and documents sport/source/coverage patterns.
- Zero destructive writes: v1 preserved in `bet_grade_history` before any overwrite, every bet recoverable.

### Estimated cost
- Zero API cost (manual LLM web sessions).
- Human time: ~12 batches × (paste Claude + paste ChatGPT + import) ≈ 5-10 min per batch × 12 = 1-2 hours of execution, spread over multiple sittings.
- Phase 1-2 build: ~1 code session (migration + export script + prompt template).
- Phase 6 build: ~1 code session (review query + promote script + /admin regrade-status).

### Known risks / open questions
- **LLM output format drift** — both models occasionally add commentary around JSON or return invalid structure. Import script strips markdown fences and validates strictly. Pile flag on parse failure.
- **Truth source gaps** — bets from 4+ months ago may not have ESPN box scores easily searchable. Large pile rate for old bets is expected and acceptable.
- **Capper identity** — regrade uses bet_id as key, not capper. Capper renames/merges don't affect regrade.
- **Parlay legs** — regrade treats parlays as atomic units (one verdict per parent bet_id). Leg-level disagreement is not captured. If leg-level accuracy becomes important later, this spec doesn't cover it — separate project.
- **Prompt versioning** — if the prompt is changed mid-run, later batches aren't comparable to earlier ones. Prompt is frozen per run; version-stamped in `regrade_batches` table.

### Phase 3 import script — enforcement hooks (captured Apr 22 EOD)

The prompt template v1 tells LLMs what evidence_quote content to include, but the import script (`scripts/regrade-import.js`, not yet built) is the only place that can enforce it. LLMs will sometimes ignore the rule. The import script MUST validate:

1. **evidence_quote substring check**: quote contains at least one of (case-insensitive):
   - A team name token from the bet description (nouns, skip stopwords)
   - A player name token from the bet description
   - The numeric threshold being graded (extract from description: "over 8.5", "1+", "25+", etc.)
   - The opponent name (for straight bets, parse vs/vs./@ from description)

2. **Generic-quote rejection**: auto-pile any quote matching the exact strings "Final Score", "Box Score", "Game Result", "Final", "Result", or a short list of similar generic phrases (configurable list, start small, expand as we see abuse patterns).

3. **Sport alias normalization**: the `sport` field has inconsistent values in production (NCAA vs NCAAB for basketball, Soccer vs various league names). Import script normalizes before checking the source whitelist. Initial aliases to handle:
   - "NCAA" + bet_type contains "basketball" keywords -> NCAAB
   - "NCAA" + bet_type contains "football" keywords -> NCAAF
   - Any league-specific soccer name (Premier League, La Liga, etc.) -> Soccer


**Round 4 review items deferred to observe from real batch 1 data (Apr 23):**

5. **Date fallback for null/malformed event_date**: Rule 6 handles "unresolvable date → unknown" but doesn't explicitly say "fall back to `created_at` + `source_url` context first." Consider adding explicit fallback order: event_date → created_at (±1 day) → source_url inference → unknown. Hold until batch 1 shows how many bets unknown-out solely due to missing event_date.

6. **Sport label normalization at LLM layer** (NCAA/NCAAB/NCAAM/College Basketball/March Madness as same family): already in import-side hook 3. Decide after batch 1 whether LLM-side normalization also helps or duplicates effort.

7. **Non-whitelisted-source exception provenance labeling**: concurring-sources rule says use the whitelisted source as `evidence_source`. Reviewer flagged this creates misleading provenance (quote from Yahoo but `evidence_source: espn_ncaab`). Options: (a) allow real source label in exception cases, (b) add dedicated `concurring_nonwhitelisted` label, (c) add explicit `concurring_sources` field to output schema. Pick after seeing real usage patterns in batch 1.

8. **Unescaped quote characters in evidence_quote**: Apr 23 Claude+ChatGPT test both saw measurement notation like `5' 8"` break JSON parse when LLMs verbatim-copy source text. Import script Phase 3 must: (a) attempt strict JSON parse first, (b) on parse failure, run regex pass to escape inline inch/foot marks (`(\d)\s*"`) before retrying, (c) log which bets triggered fallback so prompt can be tightened if common. Observed on Rafael Estevam MMA fighter profile.

These hooks add enforcement teeth to Phase 3 rules 2 and 5 from the main spec.

## Stage 2 — BetService (next deploy)

Scope: follow-on to Stage 1 BetService that shipped v297. Each item is independently deployable.

### Idempotency keys
Prevent double-writes when the grader retries a bet through the pipeline. Add idempotency key column to `bets` or a separate `grading_attempts` table; every `recordDrop` call passes a key derived from `(bet_id, grading_attempt, stage)`. Duplicates are rejected at insert time.

### Reaper (cron)
Converts long-stuck bets into explicit `GRADE_BACKOFF_EXHAUSTED` drops. Runs hourly. Reads bets with `grading_state='backoff'` and `grading_attempts > N` and `event_date` older than 48h — marks them with the enum, stops retry loop. Cleans up the "stuck in backoff forever" class of parlays seen pre-v293.

### Parent-bet resolution for parlay leg ids
Current `<parent>-leg<N>` ids don't stamp `drop_reason` on the parent bet row — only on `pipeline_events`. Reaper (or a separate resolver) should aggregate leg-level drops into a parent-level drop reason so admin snapshot doesn't report parents as "pending, no reason given."

## Grading Enhancements

### ✅ SHIPPED 2026-06-03 — Phase 1 deterministic grading gates 1–3 (code owns aggregation)

**v524 (PRs #34 + #35; landed on main as `6a95749`).** Code — not the LLM — now owns final parlay aggregation and grade idempotency.
- **Gate 1 — deterministic parlay reducer.** `reduceParlayResult` (`services/grading.js:209`, applied at `:1894`, exported `:2606`) folds leg statuses with precedence **LOSS > PENDING > WIN** (`:188`), killing the phantom-WIN class where the LLM called a parlay WIN with a still-PENDING leg (INVARIANT-VIOLATION guard forces PENDING at `:233`).
- **Gate 2 — idempotent final grades.** Migration `026_grade_idempotency.sql` adds `bets.grader_version` + `bets.evidence_hash` (+ `idx_bets_grade_idem`); `decideFinalGradeWrite` (`:45`) no-ops a re-grade when `(evidence_hash, grader_version)` is unchanged.
- **Gate 3 — quote-bound grading (Part A).** Tri-state `QUOTE_BOUND_GRADING=off|shadow|enforce` (`resolveGate3Mode`/`applyGate3`, `:2328`), **currently `shadow`** (the default). Quote normalization via `normalizeQuoteWhitespace` (`:76`) + `validateEvidenceQuote` (`:94`). PR #35 was Part A (shadow + quote-match normalization only); the **enforce flip** and **Part B cleanup** remain pending (see below).

### ✅ SHIPPED 2026-06-04 — Gate 3 would-fire audit (B0, measurement-only)

**v526 (PR #37, `44f9b5e`).** Gate 3's shadow-mode "would-fire" events are now persisted so the false-PENDING rate is SQL-queryable *before* any enforce flip. Each would-fire rides the existing `grading_audit.guards_failed` column as a `GATE3_WOULD_FIRE|mode=…|claimed=…|prop=…|reason=…` marker (`GATE3_WOULD_FIRE_MARKER`, `services/grading.js:176`/`:183`) — **zero new rows or columns**. Read it with `WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'` (+ `'%mode=enforce%'` etc.). The deduped rate query lives in PR #37's body; the read-and-decide follow-up is the **Gate 3 enforce flip** item next.

### ✅ SHIPPED 2026-06-10 — Gate 3 enforce flip (shadow → enforce)

Done. `QUOTE_BOUND_GRADING=enforce` is live on Fly (verified in-container, not just the staged default). The would-fire set was reviewed first: 7 distinct bets carried the `GATE3_WOULD_FIRE` marker (11 attempt-rows), all evidence-free VOIDs — zero false positives — so enforce blocks no correctly-grading bet. See the **2026-06-10 ops close-out → Gate 3 → enforce** block above for the full review and verification. (Historical plan, kept for the record: sample `guards_failed LIKE '%GATE3_WOULD_FIRE%'` to split true hallucinations from correct-but-unquotable evidence, then set the Fly secret and confirm live — staged ≠ live.)

### Grading gates Part B (remainder)

Cleanup/hardening left over from the gates 1–3 landing (Part A shipped as PR #35):
- **Remove dead Gate 2 overwrite branches** — `decideFinalGradeWrite`'s `evidence_changed` (`services/grading.js:58`) and `adminOverride` (`:45`) paths are no-ops behind the atomic pending-write guard; delete them.
- **Harden migration 026** — make the `ADD COLUMN` steps per-column idempotent / partial-apply self-healing; drop the unused `idx_bets_grade_idem`; remove the dead `stmts.gradeBet`.
- **Gate-wiring integration test** — a parlay through `gradePropWithAI` where one PENDING leg pends the parent via the real reducer chain (`reduceParlayResult`), proving the gates are wired end-to-end, not just unit-tested in isolation.

### Grading gates 4–5 (off-date reject + season-vs-game scope reject)

Closes the remaining 2 of the original 5 grading bugs (wrong-date confirmation; season-vs-game stat confusion):

- 🔧 **IN PROGRESS → PR #97 (`gate4-off-date-reject`)** — **evidence-record layer + Gate 4 (shadow).**
  - **Proof case — incident `e5d27de0` (2026-06-12):** bet "USA Moneyline" (Soccer, capper Harry) finalized **LOSS** against the **June-6 USA–Germany friendly** ("FT USMNT 1-2 Germany") when the bet was the **June-12 USA–Paraguay World Cup opener**. Gate 3 (enforce) passed *legitimately*: attempt 2 lifted the quote verbatim from the source (`evidence_quote = "FT USMNT <strong>1-2 Germany</strong>"`, HTML tags and all), so quote-binding could not stop it. Right quote, wrong fixture — nothing validated the evidence **date**.
  - **Evidence-record layer** (`services/evidenceRecords.js`): a parallel, structured array — one record per search hit `{ idx, backend, url/domain, snippet, char_start, char_end, dates[], scope:null }` — built *around* the existing evidence text. The model-visible `evidenceForModel` string is **byte-untouched** (Gate 3's quote contract; proven by a byte-identity test). Dependency-free date extractor (ISO, `Month D, YYYY` full+abbr, `M/D/YYYY`, `M/D/YY`, year-less → anchor year with >300d-future wrap; HTML-noise tolerant).
  - **Gate 4 — off-date reject** (`applyGate4`, `DATE_BOUND_GRADING=off|shadow|enforce`, default **shadow**; `resolveGate4Mode` mirrors `resolveGate3Mode`). Anchor = the event date GUARD 1/2/3 resolves (`normalizeEventDate(event_date) || created_at`). Per-sport tolerance window (`GATE4_TOLERANCE_DAYS`, default ±1 for UTC/ET day skew). Runs **after** Gate 3 (needs a trusted quote): locate the quote-bearing record(s) via `normalizeQuoteWhitespace`, union their dates → none in `[anchor−tol, anchor+tol]` **fires**; ≥1 in-window → `GATE4:date_ok`; zero extractable dates → `GATE4:no_date_signal` (pass-through, we don't block on absence). **shadow** appends `GATE4_WOULD_FIRE|mode=|claimed=|anchor=|tol=|evdates=|participants=|reason=OFF_DATE_EVIDENCE` to the existing `grading_audit.guards_failed` row (**zero new rows/columns**, like Gate 3 B0) and leaves the grade; **enforce** forces PENDING (`OFF_DATE_EVIDENCE`) through Gate 3's `earlyReturn` path. Participant alias (`findMentionedTeams`) is a telemetry-only secondary signal this PR (`participants=hit|miss|na`) — the date check is the sole firing condition (see PR note on the spec's "+ participant alias match" co-firing reading, deferred to the enforce review).
  - Measurement: `scripts/gate4-firing-check.js` (opens DB `{ readonly: true }` — the M-13 lesson gate3's script missed).
- **Gate 5 — season-vs-game scope reject.** Reject season-total evidence used to grade a single-game prop (and the reverse). **Evidence-record layer now exists** (shipped with Gate 4 above) — the `scope: null` field on each record is its stub. Remaining work: **scope-tag** each record (season vs game) at build time, then the reject rule (shadow-first, like Gate 4). Forward motion only — do not collapse this into Gate 4.

Ship each **shadow-first**, like Gate 3.

**Follow-up — Gate 4 enforce flip** (mirrors the Gate 3 shadow→enforce flip): collect ≥ ~20–30 Gate-4-evaluated grades via `scripts/gate4-firing-check.js`, **manually classify** each `GATE4_WOULD_FIRE` row (genuinely off-date wrong-fixture vs a tolerance/anchor miss), then `fly secrets set DATE_BOUND_GRADING=enforce` and **verify live ≠ staged** (`printenv DATE_BOUND_GRADING` in-container, per PREFLIGHT Rule 2 / DEPLOY Step 5.5). Revisit per-sport tolerances (`GATE4_TOLERANCE_DAYS`) and the participant co-firing condition at the same review.

> **Read-side vs write-side (cross-ref "🚨 P1 — 98%-empty event_date" below):** Gate 4 is the **read-side** guard — it rejects evidence dated outside the bet's window at grade time even when `event_date` is NULL (it anchors on `created_at`). The P1 item remains the **write-side** fix — extraction reliably populating `event_date` — which tightens Gate 4's anchor from "placement day" to "true game day". Together they close the wrong-date class.

### ✅ SHIPPED 2026-05-18 — Leg-explosion truncation root cause

**v451 (a2de399).** services/ai.js:423 description cap was 250 for all bet types; parlays legitimately run longer because they embed N leg bullets. Truncation clipped descriptions mid-bullet, causing services/grading.js:1647 legCountSane guard to trip (parlay had N legs but description showed N-1 bullets). Affected ~6 historical parlays at exactly 250-255 chars. Fix: bet_type-aware cap (parlay=2000, others=250) + warn log on truncation. Note: the memory note "11 parlays with leg > bullet" was undercount; full audit found 102 explosion-class rows, of which only ~6 were truncation. Other classes (C/D/E below) are deferred investigations.

### Leg-explosion Category C — compound-prop over-split (LLM artifact, single case)

**Status:** Deferred. 1 case in 435 historical parlays. Not worth a parser change for false-positive risk.

**Evidence:** Bet `a133eed16d44` (Dan, NBA, 2026-04-25). Description bullet: "Jayson Tatum Over 29.5 - Alt Pts + Reb" (one prop, one bullet). Parser split on `-` into two legs: "Jayson Tatum Over 29.5" + "Jayson Tatum - Alt Pts + Reb". System prompt at services/ai.js:947 does NOT instruct the LLM to split on `-`; this was a free-form LLM artifact.

**Why deferred:** Adding a "do not split alt-line props on `-`" rule to the system prompt could regress legitimate compound stats (NBA props like "Doncic - Triple Double Yes/No" sometimes use `-` legitimately). Single case across 435 parlays does not justify the regression risk. Park until pattern recurs.

### ✅ SHIPPED 2026-05-18 — Leg-explosion Category D (verbose+shorthand dedup)

**v454 (a42ced7).** Replaced `dedupeParlayLegs` key with the Phase 1.5 validated normalization: verbose-prefix strip (`to score`/`to record`), stat-abbreviation canonicalization (`PTS`→`points`, `AST`→`assists`, `PRA(s)`→`points+rebounds+assists`, `3PM`/`3PTM`, `SOG`, `H+R+RBI`), leading betting-token reorder (`5+ Naz Reid Rebounds` → `naz reid 5+ rebounds`), whitespace-around-`+` collapse, then the legacy case/punct/whitespace flatten. Source-of-truth + smoke test in `scripts/test-dedup-normalization.js` — KNOWN_BAD 15/16, SHOULD_STAY_SEPARATE 10/10 (zero false positives). Real-world Phase 1.5 reduction on 5 sample bets: 31 → 17 legs.

Also added migration 024 (`parlay_legs_dedup_events`) for per-decision telemetry — fire-and-forget `setImmediate` INSERT logs `kept` / `dropped_duplicate` rows plus `near_miss` pairs (Levenshtein ≤ 2 on the post-normalization keys, capped at 5/bet) so the next generation of variant patterns surface in monitoring before they ship as Cat D'. New `/admin dedup-stats-24h` subcommand renders the 24h summary + top-10 near-miss list, mirroring the `pipeline-drops-24h` visual style. First production telemetry row landed within 60s of deploy (`kept` for "Thunder -6.5").

**Residual / explicitly out of scope:** Case 11 in KNOWN_BAD — `"10+ Victor Wembanyama Rebounds"` vs `"V. WEMBANYAMA 10+ REBOUNDS"`. Requires player-initial expansion (`v.` → `victor`); deferred as a separate normalization category since the safe expansion needs roster context and risks false positives on legitimate first-initial cappers. Re-open when the dedup-events near-miss view shows a recurring `v wembanyama` ↔ `victor wembanyama` pair pattern.

### Leg-explosion Category E — buffer collision (rare, but cross-bet contamination)

**Status:** Deferred. ~4 cases, all Harry.

**Evidence:**
- `7e5fbcaac2d8` (Bane, NBA): description has 2 NBA legs, parlay_legs has 4 including unrelated tennis (Potapova) and NHL (Tom Wilson) legs from a different slip
- `0a02cfbd48c8` (Harry, NBA): first leg in DB is "Philadelphia 76ers @ New York Knicks" (a matchup, not a prop) — likely the SGP header line absorbed as a leg
- `2accc82adac6` (Harry, NBA): 4 bullets, 6 legs — last 2 are "Boston Celtics @ Philadelphia 76ers SGP" and "Research on all four props attached" (caption/header text, not bets)
- `4f731b9ba298` (Harry, NBA): 3 bullets, 9 legs — bullets are bets, legs 7-9 are "T'Minnesota Timberwolves" / "San Antonio Spurs" / "SGP" (matchup header tokens)

**Hypothesis:** Harry's slip image format includes header text ("Matchup: Team @ Team", "SGP", "Research:") that the parser is treating as legs. Different cause from buffer collision in the Bane case where two unrelated bets actually merged.

**Fix paths (none chosen):**
1. Add header-pattern rejection to validateLegShape: legs matching "X @ Y", standalone "SGP", "Research", "Props attached", single-word team names should be filtered
2. System-prompt rule: distinguish header/context lines from actual betting legs

Related to the DatDude HRB silent-drop investigation already in P1 backlog. Likely shares root cause (parser failing to distinguish slip metadata from slip bets).

---


### Cerebras grader: upgrade `llama3.1-8b` → `gpt-oss-120b` — ATTEMPTED v441, REVERTED v442 (2026-05-15)

**Outcome**: single-token model swap at `services/grading.js:1995` shipped as v441 (commit `1b70f4d`), failed on first real cron grader tick at 16:15Z, reverted as v442 (commit `fca6b9a`). Net duration in production: ~14 min.

**Failure mode**: `gpt-oss-120b` is a reasoning model. The shared `max_tokens: 200` at `services/grading.js:2056` is fine for `llama3.1-8b` (non-reasoning) but starves the reasoning model — internal reasoning consumes the budget, leaving either empty `content` (silent fall-through to next provider) or a 46-char truncated JSON prefix that fails to parse. Observed across 5 consecutive grader calls; Cerebras was the winner on 0. Post-change, Cerebras handled 0% of successful dispatches — exact inversion of the audit's "85-95%" premise.

**Evidence (v441, 2026-05-15 16:15Z cron)**:
- bet `4d5dce8e` (soccer): `Winner: cerebras | Raw (46 chars): {"status":"PENDING","evidence":"Search results` → JSON parse error → degraded PENDING
- bet `47d1e607` legs 1-5 (NBA parlay): each leg `Trying cerebras` → instant fall-through (empty content) → mistral or groq-qwen won the chain

**Why `services/ai.js` already works on the same model**: `services/ai.js:127` uses `max_tokens: 1024`. Only the inline grader waterfall uses the cramped 200.

**Required for next attempt** (2-line change, not 1):
1. Swap model: `'llama3.1-8b'` → `'gpt-oss-120b'` at `services/grading.js:1995`
2. Bump `max_tokens` at `services/grading.js:2056` (or split per-provider). Cerebras needs ≥ ~600 to leave room for reasoning + the ~200-token JSON output. `1024` matches `services/ai.js` and is the safe value.

Confirm via one organic cron tick (or `/grade test`) before declaring shipped. Step 6 of DEPLOY_CHECKLIST must see `Winner: cerebras | Raw (>100 chars)` followed by clean JSON parse, not the 46-char truncation pattern.

**Deadline driver**: Cerebras retires `llama3.1-8b` 2026-05-27. ~12 days of runway before the next attempt becomes mandatory rather than optional.

### Oracle: CapperLedger as grading source
Parse @capperledger recap tweets to grade pending bets without AI calls. Add `grading_source` column. Fuzzy-match bet descriptions. Threshold >85% confidence. Fallback to AI after 24h.

### City-name ambiguity in reclassifier
The SPORT_TEAM_KEYWORDS list only contains team nicknames (Thunder, Lakers, Capitals), not city names (Oklahoma City, Los Angeles, Washington). When a bet uses the city name alone ("Oklahoma City to win"), the reclassifier fails to match it against the correct sport. This is especially problematic for cities with multiple teams across sports (LA has 8+ pro teams). Fix: add city aliases to each sport's keyword list, OR implement a disambiguation step that checks all sports and flags truly ambiguous cities as "requires-context" rather than forcing a reclassification.

PARTIAL (2026-06-04, PR #36): disambiguateAmbiguousTeam (services/ai.js) implements the proposed "flag truly ambiguous cities / do not force a reclassification" step for shared nicknames — phrase-matches contiguous `<city> <nickname>` against AMBIGUOUS_TEAMS and abstains when the string spans multiple franchises. Wired into detectSport / inferLegSport / reclassifySport. REMAINING: bare city-name-only inputs ("Oklahoma City to win", no nickname) are still unmatched; SPORT_TEAM_KEYWORDS still lacks city aliases.

### Unknown-sport straight voids (~46% of monthly voids)

May 2026 audit found 150 straight bets with sport=Unknown voided — single largest void bucket (46% of monthly voids vs 22 NBA parlay, 18 MLB parlay).

These bets reach the grader with no sport classification, so search backends have nothing to anchor on. Reclassifier never matched them. Likely root causes:

- City-name ambiguity (see existing BACKLOG item)
- Cross-sport keywords that the reclassifier punts to Unknown rather than infer
- Bet text genuinely too sparse to classify (e.g., "Smith ML")

Diagnostic: pull description for May Unknown/straight voids, classify manually, see what % are recoverable. If >50% are recoverable, build a v2 reclassifier with the city-name table + cross-sport disambiguation rules. If <20% recoverable, accept the void floor and route Unknown-sport straights to manual review queue instead of grading them.

Investigation query: `SELECT id, capper_id, description, raw_text, created_at FROM bets WHERE result = 'void' AND sport = 'Unknown' AND bet_type = 'straight' AND strftime('%Y-%m', created_at) = '2026-05' ORDER BY created_at DESC LIMIT 30;`

### ~~Capper ROI display bug~~ — RESOLVED 2026-04-13 (faa88208), formula unified 2026-06-10 (#77)
Cap removed by commit faa88208 ("remove ROI cap, harden bouncer"). The "+500%" pattern observed in the 2026-04-13 09:34 slip-receipts export was the **old export's clamp behavior**; export was taken ~4h before the fix landed at 13:36 EDT. **There is no live 500% cap** — confirmed again 2026-06-10. `getCapperStats` and `getLeaderboard` return real values; a `>500%` warning is logged (now via `flagAbnormalRoi`) for monitoring but never clamps the displayed value.
- **Formula unification — PR #77 (`3ed77e2`), v610 2026-06-10:** the ROI math was a byte-identical-but-drift-prone copy in both functions; it is now defined **once** in `CAPPER_STATS_COLUMNS` (`services/database.js:713`) and the arbitrary per-bet `MAX(units,1)` floor (which inflated risked capital and understated losses) was **removed**. Live correction: `capperledger` (0-4) `-77.3% → -100%` — the only value that moved across all 24 cappers. Numerator/denominator now read the same `SETTLED_BET` set; `CAST(units AS REAL)` neutralizes text-garbage stakes; `NULLIF`+`COALESCE` guard division. See the **"#77"** ship entry at the top of the backlog. This also explains the **"2498.5% after Scoot override"** item below: `+2498.5%` is arithmetically real (49.97u on 2u risked via `+5097`), not a formula bug.

### MLB backfill script using resolver
Batch script that reads bets with `grading_state='backoff'` and MLB player prop descriptions, resets `grading_state='ready'` on those that the resolver would now handle, lets the normal grader pick them up. Dry-run mode mandatory. Use `resolver_events` and the new `GRADE_*` drop counts as success metric.

## Search grading — source-path arc (2026-06-10 plan; supersedes the ad-hoc generic-search items below)

The grader's web-search backends (Bing/Brave/DDG/Serper) are the weakest link: when they return garbage or nothing, the grader correctly emits repeated PENDING and bets age `backoff` → `quarantined`, or void via `shouldAutoVoidNoData`. Rather than keep patching individual backends, give each sport a **deterministic source path** and demote generic web search to last-resort. This sequence **supersedes** the scattered Brave/Bing search-tuning items below (Brave-402 is already resolved; the Brave quota probe + the Bing generic-news fix fold into S2).

Live sizing (2026-06-10, `grading_state='backoff'`, n=**312**): Tennis **68**, MLB 70 (already has the StatsAPI resolver — *not* searchless), NBA 56, NHL 32, UFC 31, Soccer 29 (+ Serie A 4 / EPL 2 / UCL 1), Golf 7, MMA 6, Boxing 3.

- **S1 — MEASURE.** Classify all backoff bets by gradeable source — structured adapter (`services/sportsdata/`), Odds API, or search-only — sized per sport. Read-only DB pull + code analysis. **Time the *final* cut after ~1 week of honest post-#74 attempts + the 2026-06-10 pool reset** (298 `backoff` bets had `grading_attempts` reset to 0 — see the evening close-out above), so source-availability reflects real grading, not broken-search-era burned counters.
  - **S1a — first classification done (read-only probe, 2026-06-10, pool = 302 backoff+quarantined):**
    - **Tennis 68** (50 parlay / 18 straight) — **no structured source** today (largest searchless bucket, drives S3).
    - **MLB 65** (61 parlay) — has the MLB StatsAPI adapter, but the parlays are prop-heavy.
    - **NBA 57** (43 parlay + 2 quarantined missing-legs).
    - **NHL 29** (22 parlay).
    - **Headline:** ~**151** bets (≈half the pool) are **prop-heavy parlays inside adapter-covered sports** — so the real adapter gap is **props-within-covered-sports**, not just uncovered sports.
    - **Soccer family fragmented across 5 sport labels:** Soccer 31 / Serie A 4 / EPL 2 / SOCCER 1 / UCL 1 = **39** (see the "Sport-label taxonomy normalization" follow-up below).
    - **Combat 35:** UFC 27 / MMA 5 / Boxing 3.
    - **~80% of the pool is >14 days old** → favors a **BDL (balldontlie) historical backfill** over live polling.
  - **Preliminary S3 arbitration (from S1a):** **BDL NBA props first**, **MLB Stats API second**, **tennis adapter third** — re-confirm against the S1b re-measure before committing build order.
> **S1b preliminary run — 2026-06-11 (NOT the honest cut).** Ran `scripts/s1b-measure.js` (PR #81) against prod read-only. **Caveat: pool not yet honestly attempted** — §5 showed 243/308 bets at 0 `grading_attempts` (avg 1.04), so source sizing is directional only; re-run for the authoritative cut after ~06-17 (≈1 wk of honest post-#74 attempts).
> Pool 308 (306 backoff / 2 quarantined). Source split: adapter_gamelevel 137 (44.5%) · adapter_prop 15 (4.9%) · search_only 156 (50.6%).
> **Finding (structural — valid independent of attempt-honesty): the grader prop-gate is MLB-biased.** The structured pre-check at `services/grading.js:2415` routes on `looksLikePlayerProp` (`services/grading.js:286`), whose stat hints are baseball-only. In-pool result: adapter_prop = 15, **all MLB**; NBA/NHL props detected = **0** (§3: NBA 58→0 prop, NHL 29→0 prop). §D sizes the miss: **33 covered-sport props** are `isPlayerPropDescription=true` but `looksLikePlayerProp=false` — NBA/NHL pts/reb/ast/goals props that never reach `tryStructured`, so they fall through to (broken) search.
> **S3 implication.** `nba.js`/`nhl.js` adapters already exist; the gap is the *gate predicate*, not a missing adapter. Candidate S3 move — align the gate (broaden `looksLikePlayerProp` to NBA/NHL stat hints, or route the gate on `isPlayerPropDescription`) — may recover a chunk of stuck NBA/NHL props with no new backfill build, and could re-order the preliminary "BDL NBA props first" arbitration. Re-confirm against the honest 06-17 cut before committing. Grader-logic change → gate it.
  - **S1b — re-measure after ~1 week of honest attempts.** Scope addition: add a **`parlay_legs` prop-keyword cut** so the props-within-covered-sports slice is sized directly (S1a inferred it from parlay share).
- **S2 — BREAKER HONESTY (COA audit M-3).** ✅ **SHIPPED + DEPLOYED — PR [#74](https://github.com/r88510179-collab/discord/pull/74) (`4c992c9`), v606 2026-06-10 ~18:40Z (clean main, `--no-cache`).** Live-verified post-deploy: a real autograde query took the **Bing `GENERIC_NEWS` → Brave `SUCCESS`** fall-through (junk-Bing no longer scored healthy). Each search backend now routes parsed results through `assessSearchResults` before recording success: zero usable hits = `parse_empty` (registered as a circuit failure, same as a 4xx/5xx/timeout, for **every** backend); Bing-only `generic_news` (parsed but no result mentions a query token >3 chars — MLB.com/ESPN homepage HTML) falls through **without** tripping the breaker. Both classes return `[]` so the chain falls through (e.g. junk-Bing now reaches Brave). `recordBackendResult` only stamps `lastSuccess` on a real success, so `getBackendSnapshot`/`/admin snapshot` now show honest per-backend state + last-success age in every state (`OPEN` gated-skipped vs `DEGRADED` un-gated-still-tried). Bing/Serper stay un-gated (Bing-first preserved — leading with Brave burns its 2K/mo quota). *Was: any HTTP 200 records `ok` (parse-blind), broken-parse class never opens the breaker.* Closes "Snapshot Brave health check" + the Bing generic-news detector below.
- **S3 — TENNIS ADAPTER (largest searchless bucket, 68).** Deterministic results via the whitelisted sources the regrade skill already trusts (ESPN / ATP), following the `services/sportsdata/` adapter pattern. Tennis is the biggest bucket with **no** structured path today.
- **S4 — PER-SPORT ROLLOUT by bucket size.** After Tennis: Soccer (~36 across Soccer / Serie A / EPL / UCL — also unblocks the 2 quarantined Soccer parlays from the close-out), UFC/MMA (~37), Golf (7). Then decide whether generic web search is retired to last-resort or removed entirely.
- **S5 — EXHAUSTION POLICY (by design — do not "fix").** Bets with **no** source path age out via `GRADE_BACKOFF_EXHAUSTED` (capped at `RETRY_CAP=15`, then VOID in a transaction). This is intended terminal behavior, not a bug — stated explicitly so it is not "rediscovered" and reverted later. **Input to refine:** the void rule is *non-uniform across bet classes* — see **"Non-uniform auto-void rule"** below. With S2's honest search now live, S1 measurement should run after ~1 week of honest grading attempts (post-pool-reset) so exhaustion is measured against real source availability, not the broken-search era's burned counters.

**In-flight, non-search workstreams to keep open** (do not bury under the arc):
- **zonetracker-ocr COA pass** — the fifth ZoneTracker repo, still un-audited (see "COA audit pass for `zonetracker-ocr`" below).
- **zonetracker-stats inventory pass** — the sixth on-box dir is cron-only (not a PM2 app) and not yet inventoried (flagged in `docs/SURFACE-PRO.md` crontab note).
- *(S-01 arm-time observability PR — now shipped + deployed, see the 2026-06-10 close-out above; no longer in-flight.)*

### ~~Search query builder — slash/dash artifacts~~ ✅ SHIPPED — PR #76 (`7a55842`), v610 2026-06-10
`extractSubject` (`services/grading.js:1425`) corrupted two query shapes, observed live during the v606 verification window — **both now fixed:**
- **Slash fusion (no space separator):** `"McGhee/Yannis ITD"` → query `"McGheeYannis ITD"`. The `/` was *deleted* in the symbol pass with no replacement, fusing two fighter surnames into one non-existent token. **Fixed:** a dedicated `.replace(/[/\\]/g, ' ')` (`:1453`) runs *before* the symbol strip → `"McGhee Yannis ITD"`; DubClub `"CHC/PHI"` → `"CHC PHI"`.
- **Stray dash artifact:** `"Joanderson Brito ML (-165)"` survived odds/market stripping with a dangling ` - `. **Fixed:** `.replace(/(^|\s)-+(?=\s|$)/g, '$1')` (`:1466`) drops only a dash-run isolated by whitespace/boundary; the ASCII hyphen is deliberately kept out of the symbol class so intra-word hyphens (`Saint-Denis`) survive. The #74 ordinal sentinels are unaffected. Tests: `tests/query-builder-bing-parse.test.js` (both live specimens + #74 regressions).

### Non-uniform auto-void rule (S5 exhaustion-by-design input, discovered 2026-06-10 evening)
Two **independent** void paths key on **different signals**, so the *same* attempt count yields different outcomes across bet classes:
- `shouldAutoVoidNoData` (`services/grading.js:708`) — fires when the **recent 5** `grading_audit` rows are all `PENDING` + no-data evidence **AND** `grading_attempts ≥ 5` **AND** age ≥ 12h. Keys on audit *content*, not raw count.
- `canFinalizeBet` `RETRY_CAP=15` (`:636`) — voids at `grading_attempts ≥ 15` with `GRADE_BACKOFF_EXHAUSTED`, but **only when the bet traverses the denial branch**; a bet parked in `backoff` with a future `grading_next_attempt_at` isn't attempted, so neither path fires and attempts simply sit.
Evidence (live 2026-06-10): bet `9d839e18` (McGhee/Yannis ITD, UFC) auto-voided at **exactly 7 attempts / 90h** (recent-5 all no-data PENDING) — yet pool bets sat at **15–35 attempts unvoided** at the same moment. This is *not* a bug to "fix" blindly (it's S5-adjacent terminal behavior), but the non-uniformity is an explicit **input** to any exhaustion-policy refinement: voiding should be driven by source-availability + audit content, not raw attempt count. Document now, measure under S1.

### 24h void-volume watch (S5 / auto-void monitoring, opened 2026-06-10 evening)
Tie-in to the **"Non-uniform auto-void rule"** above and **S5**. Live 2026-06-10 the 24h void volume was **22 unscoped + 32 no-data = 54 voids**. With S2 honest search live + the 298-bet reset, a *wave* of legitimate voids is expected as searchless bets exhaust honestly (the close-out's "VOID-slip flow" watch item) — so this is **not** auto-alarming. But because the two void paths key on different signals (non-uniform rule), raw count alone is misleading. **Action:** watch the daily `auto_void_no_searchable_data` (content-based) vs `GRADE_BACKOFF_EXHAUSTED` (RETRY_CAP=15) split in `pipeline_events`; if either climbs *after* the backlog should have drained (~1 week), the per-sport adapter gap (S3/S4) — not the breaker — is the driver. Fold the numbers into the S1b re-measure.

### Handle review — pending keep/drop decisions (opened 2026-06-10 evening)
Two `scraper_handles` rows need an operator keep/drop call (toggle `enabled` via `POST /api/admin/handles/:handle`, never delete the row):
- **`@toptierpicks_` — 0 saved bets in the last 7 days.** Either the handle has gone quiet, the scraper is silently failing on it (cross-ref the `page.waitForSelector` timeout item below — `@toptierpicks_` is named there), or its picks aren't ingest-shaped. Decide: disable, or investigate the scrape path.
- **`@nrfianalytics` — pending keep/drop.** Confirm it is still a wanted source before the next scrape-cost review.

### Sport-label taxonomy normalization (opened 2026-06-10 evening, from S1a)
S1a found the **Soccer family fragmented across 5 distinct sport labels**: `Soccer 31` / `Serie A 4` / `EPL 2` / `SOCCER 1` / `UCL 1` (= 39 bets). League names (`Serie A`, `EPL`, `UCL`) and a casing variant (`SOCCER`) are stored as if they were top-level sports, which (a) splits the bucket so per-sport sizing under-counts Soccer, and (b) will fragment any future Soccer adapter's dispatch key (`services/sportsdata/index.js` routes on `sport`). **Action:** normalize at the classification/storage boundary so a league maps to its parent sport (`Serie A`/`EPL`/`UCL`/`SOCCER` → `Soccer`) with the league preserved as a sub-field, not the dispatch key. Audit other sports for the same leakage before building S4's Soccer adapter.

### Capper dedup / merge — handle-vs-display-name attribution splits (opened 2026-06-10 evening)
**Root cause (from the LockedIn swap):** capper attribution derives from `tracked_twitter.display_name`. A scraped handle with **no** `tracked_twitter` row attributes under its **raw handle** instead of the intended capper, creating a duplicate capper. Known splits to merge:
- **`LockedIn` vs `lockedin_sportz`** — the swap inserted a `tracked_twitter` row (`display_name='LockedIn'`) so *new* `lockedin_sportz` picks attribute correctly, but any bets ingested **before** that row exists were filed under the raw `lockedin_sportz` (or the retired `TeamLockTalk`) and need merging into the `LockedIn` capper.
- **`guess_pray_bets` raw-handle attribution** — same pattern; verify whether any bets sit under the raw handle vs the intended `GuessAndPrayBets` capper.
**Action:** audit `cappers` for near-duplicate names / raw-handle rows (`SELECT id, display_name, COUNT(bets)` …), then merge bets onto the canonical capper id and backfill the missing `tracked_twitter` rows. Guard the merge with the same read-only-first DB-intervention rules (`docs/RUNBOOKS/db-interventions.md`). Pairs with the existing **"Cappers table data integrity audit (post-5efcdd8)"** item.

### ~~Bing `b_algo` defensive multi-selector parse~~ ✅ SHIPPED — PR #76 (`7a55842`), v610 2026-06-10
Deferred from PR #74; now done. The single hard-coded `class="b_algo"` + `b_caption>p` selector (which Microsoft drifts every few months) is replaced by pure `parseBingHtml(html)` (`services/grading.js:1829`, exported via `_internal`): an **ordered block-delimiter list** (`b_algo` → `b_algoheader` → `b_ans`) — first that yields ≥1 hit wins — × **ordered title/snippet selectors** (`h2`/`h3`/`tilk`/anchor; `b_caption>p`/`b_lineclamp`/`b_algoSlug`/first-`p`), 5-block cap preserved (`BING_BLOCK_DELIMITERS` `:1797`). `searchBing` (`:1849`) now calls it. A total miss still returns `[]` → `assessSearchResults` flags `parse_empty` → S2 honesty gate falls through to Brave (gate **not** weakened). A live `curl` of bing.com returns only the search-box shell, so selectors are built from known markup variants (documented inline). Tests: `tests/query-builder-bing-parse.test.js` (fixture-driven over classic/lineclamp/anchor-only/rotted markup + a rotted→`parse_empty` honest-fall-through assertion).

### Quarantined missing-legs parlays (manual leg reconstruction)
2 of the 4 live-quarantined bets (2026-06-10) are parlays stored with only **1 recorded leg** in `parlay_legs`, so the grader can't evaluate them: *"Parlay has 1 recorded legs — cannot grade without leg data. Manual review required."* Both NBA: `7b04366b…` ("Jokic, Brunson & Donovan Mitchell to Combine for 100+ Pts, 25+ Reb & 25+ Ast", 22 att) and `b0140947…` ("Spurs/OKC Over 218.5 Points", 20 att). These are a *storage* gap (legs lost at ingest), not a search gap — the search arc above won't clear them. **Note (#73, v606):** the 1-leg-parlay grader fix grades only **COMPLETE** 1-leg parlays (`•` bullet count === recorded leg count); both quarantined specimens are **INCOMPLETE** — `7b04366b` is the confirmed counter-specimen (0 bullets / 1 leg → still rejected, byte-identical reason). `b0140947`'s bullet count was not re-verified this session; if its description carries exactly one `•`, #73 would now grade it (worth a read-only re-check). Action: reconstruct the legs from the original slip and re-stage, or VOID with a recorded reason. (The other 2 quarantined bets are Soccer awaiting a result source — handled by S4 above.)

### ~~Brave Search returning HTTP 402~~ — RESOLVED 2026-05-11 (2faaabd)
Brave free tier was burned in 6 days. Resolved through three landed changes: (1) circuit breaker on 402 (services/grading.js:1213, quotaCooldownMs=1h); (2) waterfall reorder to Bing → Brave → DDG → Serper (commit aa7b030, comment fix 2faaabd); (3) /admin search-backends counter (search_backend_calls table, shipped 5/8). Last 24h: Bing 173/173 calls, 100% OK. Brave/DDG/Serper at 0 calls because Bing never returned empty. Remaining open thread: explicit 402-aware messaging in fmtBackend (cosmetic, deferred). See "Brave quota probe" below for optional follow-up.

### Brave quota probe (optional, deferred)
**→ folds into S2 (Breaker honesty) of the search arc above.** Brave only gets called when Bing returns zero results, which over 173 calls happened zero times. Result: we never observe Brave quota resets. Add daily cron firing one fixed query at searchBrave() directly, logs to search_backend_calls. ~15 LOC. Low priority — Brave is a fallback, not load-bearing.

### Snapshot Brave health check — RESOLVED v344 (b9ca1f6), fully closed by S2 (M-3)
Fixed in `fmtBackend`: per-backend state, last success, last failure with reason now shown. `lastError` preserved across successes on `recordBackendResult`. Original diagnosis (tracker doesn't count HTTP errors) was wrong — tracker did count them, formatter ignored them. **Audit 2026-06-10 caveat now closed:** v344 fixed the *formatter*, but the *data* feeding it was parse-blind — Bing recorded `ok` on every HTTP 200 (incl. drifted/garbage markup), so the snapshot still read "Bing: healthy" while it fed junk. S2 (M-3, PR #74 `4c992c9`, deployed v606 2026-06-10) makes the recording honest, so the snapshot is now genuinely accurate; `fmtBackend` reads the structured `getBackendSnapshot` and shows last-success age in every state.

### Twitter validator drops on escape-hatch stubs (P3)
services/twitter-handler.js line 204 fires VALIDATOR_ENTITY_MISMATCH on escape-hatch tweets where `description` is set to `text.slice(0, 200)` at line 189. Despite description being derived from text, the validator's lowercased `desc` and `src` comparison fails. Likely `text` is transformed between escape-hatch assignment and validator call. Low impact: 2-3 drops/24h, only affects tweets bound for review queue anyway. Investigate when convenient — possibly skip entity check entirely when description was set by escape hatch (add a flag).

### Stuck MLB parlays in backoff — two failure modes (Apr 20 v292 verification)
**Symptom**: 5 MLB parlays in `grading_state='backoff'` with 8 grading_attempts each, surfaced during v292 resolver-telemetry verification. Two distinct root causes; both predate v291.

**Mode A: Slip extraction captured only 1 leg** (3 bets)
Failure reason: `Parlay has 1 recorded legs — cannot grade without leg data. Manual review required.`
- `f71cbbc5` — "• Marlins ML +130"
- `ee2f755d` — "• New York Yankees ML (-145)"
- `fe9256d0` — "Homerun parlay"

Hypothesis: dense Hard Rock Bet slips defeating current Vision preprocessing — only 1 leg extracted from multi-leg slips. Same class of problem the parked Gemma 4 investigation targets (1120-token OCR budget).

**Mode B: Legs unresolved via ESPN/AI** (2 bets)
Failure reason: `Parlay PENDING — N leg(s) unresolved.` with individual legs returning "No final score found for this game on YYYY-MM-DD".
- `34f1b488` — mixed MLB/UCL parlay, 2 legs WIN, 1+ PENDING
- `e196b33b` — 8-leg HR-vs-pitcher parlay, all legs PENDING since 2026-04-15

Hypothesis: exactly the bet types the v291 resolver pre-check was built for. They predate v291 so they took the old ESPN/AI path, failed, and are now stuck in backoff. Worth retrying after the next live MLB slate confirms resolver is grading cleanly on fresh traffic.

**Next debug steps**:
1. After first organic resolver hit on v292, manually reset `grading_state='ready'` and `grading_attempts=0` on the 2 Mode B bets and confirm they grade via resolver
2. For Mode A, wait until Gemma 4 investigation resumes (parked until P0/P1 complete)
3. Consider a backfill script that force-resolves stuck Mode B bets in batch — no new Vision calls, just resolver retries

## Ingestion Expansion

## Infrastructure

### Jarvis feature suite (LLM features)
- Daily props picks
- Parlay builder
- Pick of the day
- Alt lines analyzer
- Safe locks
- EOD P&L recap
- Slip analyzer (paste a screenshot, get EV analysis)
- Bankroll sizing recommendations

### Sports stats API integration
- Ball Don't Lie (free NBA)
- L5/L10/L20 hit rates per player
- Defense rank by position
- Home/away splits
- Usage/minutes trends
- Back-to-back flags
- Injury context from news

### Profit tracker visual dashboard
ROI charts, capper leaderboards with date ranges, unit tracking

### slip-feed Edit/Delete buttons: `interaction.isButton is not a function`

Production logs show `[SlipFeed] Interaction error: interaction.isButton is not a function` every time a user clicks Edit or Delete on a war-room embed posted to slip-feed. Discord shows "This interaction failed". Likely a discord.js v13→v14 API break (isButton became a getter, or check needs `interaction.isButton()` vs `interaction.isButton`) or wrong handler receiving a non-Button interaction type. Locate handler in services/slip-feed.js or similar and confirm the type guard matches the installed discord.js major version.

### Edit modal: parlay ↔ singles conversion
Let user split a parlay into singles or merge singles into a parlay from the war room embed

### Fly.toml RESOLVER_VERSION — consider moving to secret
Currently hardcoded `RESOLVER_VERSION = 'v10'` in `fly.toml [env]`. Not sensitive, but moving to a fly secret makes version bumps easier (no PR cycle). Tradeoff: secret rotation requires a restart.


### View Original button — mobile Discord opens x.com homepage instead of tweet

Desktop Discord: "View Original" button correctly opens the tweet URL in browser.

Mobile Discord: tapping the button opens x.com homepage or redirects to the X app's home feed instead of the specific tweet. Source URL in DB is correct (verified Apr 21 — bobby__tracker bets had full `https://x.com/<handle>/status/<tweet_id>` format in source_url column).

Root cause is Discord mobile's URL deep-link handler or X app's URL scheme — not our bug. Workarounds tested and rejected: fxtwitter.com wrapper (works for embed previews, not direct navigation), query string suffixes (`?s=19` etc., no effect).

No fix available from our side. Desktop works correctly. Mobile users can long-press → Copy Link → open manually in Safari.


### /admin pipeline-trace should accept bet_id

Currently only accepts ingest_id (e.g. `disc_<message_id>`, `twit_<tweet_id>`). Operators have bet_ids handy from war-room embeds and /grade output but no ingest_id, forcing a SQL lookup before tracing. Fix: detect hex bet_id input and resolve to ingest_id via `SELECT ingest_id FROM pipeline_events WHERE bet_id = ? LIMIT 1`, then trace.

## Foundation

### Gemini Vision quota structurally inadequate on Free tier (P0 — decision required)
aistudio.google.com Free tier limits gemini-2.5-flash-lite to 20 RPD per project. Bot's Vision call volume regularly exceeds this within hours of midnight Pacific reset. Currently failing over to Groq Llama 4 Scout vision (waterfall handles 429 correctly). Two options: (1) link billing to project containing GEMINI_API_KEY → 1,000 RPD limit, ~$5-15/mo at current volume; (2) accept Groq as primary, Gemini as fallback. Spot-check Vision extraction quality over next 7 days to inform decision. No action blocking the bot today.

### ~~pipeline_events instrumentation gap post-BUFFERED~~ — RESOLVED (predates 2026-04-30)
STAGED emission already shipped: `recordStage` calls in `handlers/messageHandler.js:539` (Twitter path) and `:1147` (Discord path) both emit `stage: 'STAGED', eventType: 'STAGE_EXIT'` immediately after `createBetWithLegs` returns. Production verification 2026-05-08: 690 STAGED events recorded in `pipeline_events`. The wonderful-dirac branch entry that prompted this BACKLOG item was already obsolete when written.

### ✅ Shipped foundation items (verified live 2026-06-10, COA audit M-11.4)
These four sat as TODO long after shipping:
- **Grading audit table** — live: `grading_audit` with 30,896 rows + `/admin` decision-trail surface.
- **State snapshot admin command** — `/admin snapshot` shipped and in daily use.
- **CI reliability gate** — `.github/workflows/ci.yml` runs `npm run check` + `npm run test:reliability` on PRs; with the suite now green (see "Pre-existing test failures" above) the gate is meaningful.
- **Deploy verification protocol** — `docs/DEPLOY_CHECKLIST.md` exists and is required for every non-trivial deploy.

Also resolved: the "Test suite: migration-validation.js fails — pre-existing" entry that lived here — `tests/migration-validation.js` passes as of `84650b8` (full `test:reliability` EXIT=0, 2026-06-10).

### README comprehensive documentation
Architecture, env vars, admin commands, scraper setup, troubleshooting, guard chain reference

### Resolver telemetry — shipped v292 (commit 940f3d2)
Migration 019 added `resolver_events` table. `/admin snapshot` renders a Resolver block with 24h outcome counts, latency, error breakdown, and last successful resolve timestamp. End-to-end verified via forced `resolvePlayerProp` call on Apr 20.

### BetService + drop telemetry (Stage 1 + 1.2) — shipped v297 (commit b3413c5)
Migrations 020/021. New `services/bets.js` with grading-side write contract (`sourceType='grading'`, nullable `ingest_id`). `earlyReturn` wrapper in `services/grading.js` auto-records PENDING drops, classifier matches evidence prefixes to 11 `GRADE_*` drop reasons. Explicit enums at high-volume sites (`GRADE_TOO_RECENT`, `GRADE_NO_SEARCH_HITS`). Telemetry queryable via `pipeline_events` with `source_type='grading'`.

Verified in production Apr 21: 20 grading rows in ~45 min. Distribution: `GRADE_NO_SEARCH_HITS` 50%, `GRADE_TOO_RECENT` 40%, `GRADE_AI_PENDING_NO_DATA` 10%. Zero `GRADE_PENDING_UNCLASSIFIED` — classifier regexes have coverage for all PENDING evidence strings seen in production. Stage 2 (reaper + parent-bet resolution for parlay legs) still pending.

Apr 22 extended classifier with `GRADE_RESOLVER_PENDING` and `GRADE_PARLAY_LEGS_PENDING` after Codex audit found the fallback was reachable via resolver/parlay evidence strings. Now 13 `GRADE_*` drop reasons total.

### Snapshot polish: bet type breakdown (all outcomes) — shipped v298 (commit 56228e1)
`/admin snapshot` Resolver block previously showed only resolved bet types. Now shows full breakdown of all call types (resolved + unresolved + errored). Label updated to "Bet types (all calls):". 2-line fix in `commands/admin.js`.

## Surface Pro

### ~~Scraper (building now)~~ — SHIPPED (v2.0 in production)
The Surface Pro Twitter scraper is live: `zonetracker-scraper` repo (in production at `6743106`, pm2 `zonetracker-scraper` online). Handle list is DB-driven via `scraper_handles` / `GET /api/scraper-handles` (see ✅ SHIPPED 2026-06-07/08 → Scraper-handle management). See that repo's README for polling/cursor behavior.

### Local Ollama for free AI grading
Offload grading AI calls from Groq to local Ollama instance. Zero marginal cost. Slower but unlimited.



### Sports data caching
Nightly precompute of hit rates, trends, splits. Cached locally, served to Fly bot on demand via Tailscale.

### Code Tab prompt template library
Reusable prompt templates in ~/Documents/discord/.code-prompts/:
- audit-only.md — "read DB / read code / report findings, no changes"
- single-file-fix.md — "modify one rule, ship via DEPLOY_CHECKLIST"
- multi-file-refactor.md — "signature change + N call sites + verification"
- migration-backfill.md — "schema change + data migration + safety budget"

Each is a fill-in-the-blank template. We've been writing these from scratch — saves 10-15min per Code session. Build next time we have low-pressure time.

### Vision extraction failure on dense slip-share images — wire Gemma 3:4b as fallback — CLOSED (investigated, not pursued) 2026-05-30

**CLOSED (investigated, not pursued):** Gemini Vision extracts HRB slips correctly into `description`; no vision-accuracy problem exists. `raw_text` boilerplate is cosmetic — the grader reads `description` only, never `raw_text` (`services/grading.js:1142-1149` + `tests/grader-uses-description.test.js`; see the CODEMAP `raw_text` note). gemma-4-31b / Gemma 3:4b swap unnecessary, and independently hardware-infeasible since **v431** (`GEMMA_FALLBACK_DISABLED=true`, Surface Pro inference 7-17 min vs Fly's 90 s timeout). Scope: this closes the Gemma-as-vision-fallback approach only — it does NOT resolve the separate `ai_is_bet_false` HRB routing drop (P1 above), and any residual dense-slip leak for other cappers (zrob4444/Trent/rbs) needs a different lever (Playwright shortlink expander / paid Gemini quota), not Gemma. Original plan preserved for audit:

**Tested Apr 15 — proven working.** Gemma 3:4b on Surface Pro Ollama successfully extracted player picks from a zrob4444 PrizePicks slip image (732x1199 JPEG, 70KB) via local HTTP API. Output: structured player names. Note: tested model is `gemma3:4b` (3.3GB), not the previously-noted `gemma4:e4b` which doesn't exist as a current Ollama tag.

Current Gemini Vision returns "missing legs / capper hid the picks in image" placeholder for dense slips, bouncer correctly rejects. Confirmed leak: ~10 real bets/week from missing-image bucket alone (audit verified Apr 15).

Plan:
1. Add Ollama Gemma 3:4b as vision-capable provider in `services/ai.js` after Gemini Vision in the waterfall
2. Auth via existing Tailscale Funnel + `OLLAMA_PROXY_SECRET` (llama3.2:3b uses this path for grading already)
3. Trigger condition: when Gemini Vision returns placeholder text matching `/missing legs|capper hid|cannot read/i`, fall through to Gemma instead of giving up
4. Validate output quality — Gemma may hallucinate fields (jersey numbers, etc). Need test fixtures of known-good slips before promoting.
5. If quality holds: promote to primary Vision for known-difficult cappers (zrob4444, bookitwithtrent, rbssportsplays), keep Gemini for everyone else.

Resources: Surface Pro has 5.5GB RAM available, 201GB disk. Gemma 3:4b is 3.3GB on disk, ~5GB RAM at runtime. Inference time on CPU: 30-90s per image (untested but expected).

### Pre-filter audit findings (Apr 15)
7-day rejection breakdown verified via `twitter_audit_log`:
- 57 "No betting structure found (pre-filter)" — confirmed correct rejections (frustration tweets, marketing, PrizePicks shareEntry URLs without context)
- 29 "Hallucination: placeholder — missing legs / capper hid in image" — ~10 are real bets (Vision failures, see Gemma plan above)
- 6 "Hallucination: sportsbook_brand" — fixed in v277 for slip-shape patterns
- 8 "Hallucination: entity_mismatch [multiple, picks]" — parser stripped detail to placeholders. Investigate why parser writes `[multiple, X]` instead of legs.
- 5 "Hallucination: leg_sport_mismatch" — cross-sport parlay parser bugs (already in BACKLOG)

Total real-bet leak: ~12-15 bets/week pre-fixes, ~10 bets/week post-v277 (Vision still leaks).

### bookitwithtrent inline-text bets being missed
"Yankees ML live (-145) 10u" was rejected as missing-legs even though it's a complete inline bet. Bouncer probably focused on attached image and missed inline pick. Investigate `parseBetText()` flow when both text bet AND image are present.

### ESPN API for basic grading
Replace AI calls with direct ESPN API for ML/spread/total grading on completed games. Free, no rate limits at our volume, deterministic. Architecture: new ESPN provider in `services/grading.js`, falls back to AI when ESPN doesn't have the data (player props, futures). Estimated 70-90% reduction in AI grading calls.

### Junk bet auto-reject
"KBO Lotto", "10u nuke", "History will repeat itself", "Eury to shove" should never become bets. Bouncer needs tighter no-bet-content rejection.

### Scraper Playwright timeout investigation (Apr 15)
Intermittent `page.waitForSelector: Timeout 15000ms exceeded` on @toptierpicks_, @zrob4444, @guess_pray_bets. Could be Twitter rate-limiting residential IP, cookie expiration, or page structure changes. Add retry logic with shorter timeout + structured failure logging.

### Dashboard migration to grading_state aware queries
`healthReport.js`, `!status`, `/admin snapshot` still use raw `result='pending'` for "stuck >24h" alerts. Fires false positives on quarantined bets. Add `getActiveQueue()` helper that filters by grading_state, swap callers.

## April 16 session learnings

### Gemini + Brave quota dependencies are single points of failure
Both APIs on free tier, both exhausted. When either dies the pipeline degrades sharply. Options:
- Pay for Gemini (Paid tier ~$19/mo for useful scale) and/or Brave ($5/mo Pro)
- Build local AI fallbacks on Surface Pro (Gemma for Vision, llama3.2 or larger for grading — see Option 3 below)
- Accept degraded capacity on free tier and tune state machine to handle it

### Option 3: Full local AI fallback chain (weekend project)
Replace external AI dependencies with Surface Pro Ollama:

1. **Gemma 3:4b for Vision intake** (already proven Apr 15)
   - Trigger: Gemini returns 429/quota error OR placeholder text
   - Route: Tailscale Funnel + OLLAMA_PROXY_SECRET
   - Output: two-stage (Gemma extract → Cerebras parse)
   - Fixtures: 8 saved slip images in test-fixtures/vision/

2. **Larger local model for grading** (e.g. llama3.1:8b or qwen2.5:7b)
   - Current grading waterfall: groq-llama8b → groq-kimi → ollama-llama3.2-3b
   - Issue: 3b is too small for grading quality
   - Upgrade: 7-8b on Surface Pro for grader fallback tier
   - Requires: verify Surface Pro RAM can handle concurrent Gemma 4b + llama 8b (5+8=13GB, Surface has ~16GB)

3. **State machine tuning**
   - Currently treats all PENDING as retryable failures
   - Need: if AI verdict is PENDING due to "no data found", don't retry endlessly
   - Better: ship auto-void-after-N-PENDINGs guard (previously drafted)

### ESPN integration observations (v282 today)
- Works perfectly for ML/spread/total on MLB/NBA/NHL for completed games
- Date fallback (UTC date + previous ET day) handles late-night bets correctly
- Covers ~30-40% of bet volume
- Doesn't help with: player props, parlays with props, tennis, golf, SGPs
- Remaining 60-70% still depends on AI + search

### Today's emergency actions
- Auto-voided 9 bets with >5 attempts + >48h age (some later identified as having real slips that Vision failed to extract — see Gemma fixtures)
- Force-readied 100+ bets across 2 cycles to recover from backoff lock
- Deployed v280 → v281 (stale worktree, broken) → v282 (fixed)
- Bot stabilized at ~7 grades/hour via ESPN only

### Known drifts
- Grader can still hallucinate WINs on promo/commentary text (e.g. "🏀 Mathurin is the man!")
- Workaround: ship unscoped-bet auto-void (Task 2 in Apr 16 session)

## Pipeline Observability

### Parser PARSED event: `isBet` / `betCount` field mismatch
In a v340 pipeline trace (msg=1499408189240774686, #datdude-slips, 2026-04-30), the PARSED payload showed `isBet:false` alongside `betCount:1` and `type:"bet"` — three fields telling different stories about the same parse. The bet went on to STAGED successfully so it is not blocking, but the inconsistency suggests stale flag wiring at the emit site. Audit wherever `pipeline_events.PARSED` is emitted and either drop the redundant flag or derive `isBet` from `betCount > 0` so the two cannot disagree. Risk if left: future filters that key off `isBet` could drop legitimate bets that the rest of the pipeline considers real.

### ~~Pre-existing test failures on main~~ — RESOLVED
✅ RESOLVED — reliability suite green as of `84650b8` (full `npm run test:reliability` EXIT=0, verified 2026-06-10): `tests/migration-validation.js` and `tests/message-handler.integration.js` now pass; `tests/twitter-pipeline-validation.js` was removed. The CI reliability gate is now meaningful.

### Twitter ingestion: recap leakage, slip-image bypass, missing audit trail

Three distinct problems in the tweet ingestion path. Surfaced 2026-04-30 via msg_id 1499382543919611934 (bobby__tracker tweet "WAY TOO EASY. Arthur Fils S1 ML (-165) 12u ✅🔨" — staged as Pending Review parlay 16h after the match settled).

**Issue 1 — Recap tweets staged as live bets.** Tweets with settled markers (✅ ❌, "WAY TOO EASY", "STOP PLAYING", past-tense framing) reach staging. The bobby__tracker case parsed cleanly text-wise but the match was already over. The `evaluateTweet` settled-detection logic discussed in earlier sessions either never shipped or doesn't run on the current scraper → `/api/mobile-ingest` path. Most-affected: bobby__tracker and any capper who recaps wins.

**Issue 2 — Slip-image tweets ignore the attached image.** When a capper tweets a screenshot of a settled slip with a generic caption ("LOCK 🔒"), the bot extracts the caption as the bet rather than running `parseBetSlipImage` on the image. Most-affected: zrob4444 (Zach), bookitwithtrent (Trent). Smokke rejects manually when caught.

**Issue 3 — No audit trail for tweet ingestion.** Tweets route straight to war-room or drop silently — no paper trail showing tweet URL, image preview, raw text, and extracted bet for later review.

**Resolution chosen for Issue 3 — Option B: scraper posts to sport channels.** Scraper posts tweets to the appropriate Discord sport channel (already in `HUMAN_SUBMISSION_CHANNEL_IDS`); the existing message handler picks up from there and runs bouncer/parse → war-room. Removes the direct ingest endpoint for tweets and gives a real audit trail in channels that are currently empty.

Required for B:
- Scraper posts via Discord webhook to sport channel (not `/api/mobile-ingest`)
- Webhook username = capper's Twitter handle for attribution
- Sport detection runs on the scraper before posting (or post to triage channel that fans out)
- `CAPPER_CHANNEL_MAP` extended OR shift to webhook-author lookup
- Bouncer flagged "from-Twitter" so recap markers + age gate apply

**Order of work:**
1. **P1a — Recap detection in bouncer** (Issue 1). Catches the bobby__tracker class immediately. Independent of B routing. Active now.
2. **P1b — Tweet age gate** (event already started → drop). Catches the rest of the recap class.
3. **P2 — Option B routing** (Issue 3). Pure value-add once 1+2 are in.
4. **P2 — Slip-image vision pipeline for tweets** (Issue 2). Independent track.

### 2026-04-30 deploy log + grader incident postmortem

**v355 (P1a recap detection — services/ai.js evaluateTweet)** — shipped commit `67a6221`. Adds `STRONG_RECAP_HEADERS` + expanded `WIN_HEADERS` + `SETTLED_MARKERS` (incl. 🔨, word-form `won/lost/push/cashed`). Verified producing `reject_settled` on the bobby__tracker case with and without emoji. 30 unit tests in `tests/bouncer-rejection.test.js`. Production firing not yet observed in `pipeline_events` because the diagnostic was wrong, not because the bouncer is silent — see "diagnostic correction" below. Open: STRONG_RECAP_HEADERS list is too narrow — missed `GOOD MORNING`, `WAKE & CASH`, `ATP KING`, `KING DELIVERS`, `LET'S F*CKING DANCE` (rbssportsplays case), and several others. Tracked as P1a-ext.

**v357 (P0 grader fix — services/grading.js)** — shipped commit `b0a6247`. Three fixes in one deploy:
- **Bug A — G6 player-prop guard.** Old G6 was a soft-hallucination phrase check that passed any non-empty evidence string. New G6 (`evaluatePlayerPropEvidence`) detects player-prop bets via stat keywords + capitalized-name patterns, extracts the player name, and rejects WIN/LOSS verdicts where the evidence doesn't reference the player by surname. Verified live: the Scoot Henderson bet `ada01c0f9dbefb16a5b8a2444f3c819f` was reset to PENDING after deploy, regraded under v357, and the new guard fired with log line `GUARD6 FAIL: G6:player_not_in_evidence`. Cerebras returned WIN with team-only evidence ("Spurs 114, Trail Blazers 93") and the guard correctly rejected it.
- **Bug B — Description vs raw_text for grader queries.** Defensive only. Code already used `bet.description` in production paths; the fix extracts query construction into `buildGraderSearchQuery` and codifies the contract via `tests/grader-uses-description.test.js`. The Scoot incident's attempts 4-7 used `raw_text` because of an older code path that has since been replaced — keeping the test as a regression guard.
- **Bug C — pipeline_events explicit timestamp.** Belt-and-suspenders. Production schema has `created_at INTEGER DEFAULT (strftime('%s','now'))` and writes were always healthy. The "writes broken" diagnosis was a query mistake (see below). The fix sets `created_at` explicitly at every write site so it surfaces in slow-query logs.

**Scoot Henderson incident (ada01c0f9dbefb16a5b8a2444f3c819f)** — capper Dan, "OVER 14.5 POINTS SCOOT HENDERSON", originated from a TweetShift relay of @DanGambleAI walking-meme posts plus an attached pick graphic. Bet sat PENDING for 4 days (attempts 1-7 used the meme caption as search query and got nothing). Attempt 8 finally narrowed to `"SCOOT HENDERSON NBA final score April 26, 2026"`, Cerebras returned `{"status":"WIN","evidence":"Spurs 114, Trail Blazers 93 per search results"}`, old G6 passed it, bet finalized as WIN with +0.91u to Dan's record. Smokke caught it manually 4 days later. Reset to PENDING, attempt 9 ran AGAIN under old code (revert happened before v357 was deployed) and made the same WIN call. After v357 deployed, attempt 10 ran with the new G6 and correctly rejected. Bet flipped to LOSS manually post-v357 with `grading_last_failure_reason="Manual override — grader hallucinated team-level evidence on player prop"`. Process gap: when reverting bets to PENDING for re-grading, verify the deploy is live first or the old code re-runs.

**Diagnostic correction — pipeline_events.created_at is unix epoch INTEGER, not text.** Querying with `datetime(created_at)` returns NULL silently because SQLite reads a 10-digit epoch integer as a Julian-day number out of range. Always use `datetime(created_at,'unixepoch')`. Other tables (`bets`, `grading_audit.timestamp` as ms) use different conventions — check the column type before assuming. This bit us hard during the v357 prompt scoping; the wasted Bug C work is captured in the deploy report.

**Q-C event_date NULL finding** — 8 bets in 3h had `event_date=NULL` in the SELECT but were still graded. Scoot's grader log showed `hours_since=94.26` despite the SELECT showing `event_date=null`, so the grader is finding a time anchor from somewhere (probably `created_at` fallback). Could be a SELECT artifact (NULL in the column for storage but populated in code), or the grader is using created_at as a proxy when event_date is missing. Investigation deferred — not currently visible as a wrong-grade pattern.

### NRFI vision-prompt hardening (P1c) — SHIPPED

Vision parser misread @NRFIAnalytics tweet as a 2-leg parlay. Source: tweet 2026-04-30 12:12 UTC, MLB SF/PHI Game 1 NRFI free play with attached graphic. Bet `7d96e21d1b1870f0ddb854613a417a77` staged with description `"• C. Sanchez 5-1 (83.3%)\n• L. Webb 6-0 (100.0%)"` — those are pitcher win-loss records, not betting legs. The actual bet was a single NRFI play. `source: twitter_vision` confirms vision DID run; the prompt or post-vision validator allowed `"NAME N-N (NN%)"` shaped lines through as legs.

**Fix landed at three levels** (`services/ai.js`):
- New `validateLegShape` exported helper + `PITCHER_RECORD_PATTERN` (`/\b\d+-\d+\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/`) — rejects any leg description matching the pitcher-record / hit-rate shape. Wired into `validateParsedBet` ahead of the entity_mismatch check so its more-specific telemetry (`leg_shape_invalid`, dropReason `VALIDATOR_LEG_SHAPE_INVALID`) wins. Also runs against the top-level `pick.description` so flattened single-leg cases drop too.
- Vision prompt in `parseBetText` got an explicit `STAT LINES ≠ LEGS` rule under STRICT RULES — calls out NRFI/YRFI free-play graphics by name and the `"NAME N-N (NN.N%)"` shape.
- `GEMMA_SLIP_PROMPT` (Gemma fallback) got a parallel `DO NOT extract player statistics` instruction; the Cerebras post-Gemma normalizer rules now drop PICK lines matching the shape before assembling JSON.

Tests: `tests/validator-leg-shape.test.js` (16 cases — live-repro legs reject; spread/total/prop/ML/record-without-% all pass; end-to-end `validateParsedBet` returns `leg_shape_invalid`). Pre-existing `migration-validation.js` / `twitter-pipeline-validation.js` / `message-handler.integration.js` failures are unchanged. Module export updated to surface `validateLegShape` for testing.

### Twitter ingestion P1a-ext: widen STRONG_RECAP_HEADERS — SHIPPED

P1a recap detection (v355) catches the bobby__tracker "WAY TOO EASY" case but missed the rbssportsplays "GOOD MORNING!!!! WAKE & CASH IT!!!!" case staged as live bet `cdb6f5170e82f6af0a2657c22075f463` (msg 12:11 PM, ATP, Alexander Blockx +3.5 / +1.5 Sets — recapped with ✅ on each leg, all four signals stripped to "Alexander Blockx +3.5 -120" by the scraper).

**Fix landed in `services/ai.js` `evaluateTweet`** — six new `STRONG_RECAP_HEADERS` patterns appended (anchored to `firstLine`, fire as `reject_settled` when betting structure follows):
- `\bWAKE\s*[&+]?\s*CASH\b` — "WAKE & CASH" / "WAKE CASH" / "WAKE+CASH"
- `\bDELIVER(?:S|ED|ING)?\s+GREATNESS\b` — "DELIVERS/DELIVERED GREATNESS"
- `\bKING\s+DELIVERS\b`
- `^ATP\s+KING\b`
- `^GOOD\s+MORNING\b.*!{2,}` — "GOOD MORNING!!" (2+ exclamations to dodge plain "Good morning! Lakers ML 3u" false positives)
- `^LET'?S\s+(?:F\W*\w*\s+)?DANCE\b.*!{2,}` — "LET'S DANCE!!" / "LET'S F*CKING DANCE!!"

Tests: `tests/bouncer-rejection.test.js` extended — 11 new settled cases (incl. the rbssportsplays full-header repro, every new pattern, and "DELIVERED GREATNESS" past-tense), 5 new false-positive guards (single-! "Good morning!", no-! "Let's dance tonight", "King of NBA", bare "Greatness incoming"). All 26 settled / 15 valid / 3 recap / 1 mixed / 1 word-form-guard cases pass.

Skipped the broader "any all-caps `!!` line" category rule — too high a false-positive risk against legitimate hype like `"TONIGHT'S LOCK!!! Lakers ML -150"`. The named-phrase patterns above cover the observed misses without that risk.


### v360 deploy verification — 2026-04-30 21:21 UTC

Commit `e9f3c40` deployed clean. End-to-end verified by calling `validateLegShape` and `evaluateTweet` against the production binary inside the container. P1a-ext catches "GOOD MORNING!!!! WAKE & CASH IT!!!!" rbssportsplays case → `reject_settled`. P1c catches "C. Sanchez 5-1 (83.3%)" NRFI case → `VALIDATOR_LEG_SHAPE_INVALID`. Real-pick texts ("Lakers ML -150", "Tonight: Lakers ML -150 1u") still classified valid. v355 + v357 + v360 all confirmed loaded and firing.

Pending live-traffic confirmations (not concerning, just awaiting samples):
- `VALIDATOR_LEG_SHAPE_INVALID` count = 0 in pipeline_events. Will fire next time a stat-line tweet comes through.
- P1a-ext header drops haven't been observed yet either; v360 was deployed only 30 min before the histogram was checked.

### ~~Capper ROI showing 2498.5% after manual Scoot override~~ — RESOLVED 2026-06-10 (#77): the value is real, not a bug
After flipping Scoot Henderson bet `ada01c0f9dbefb16a5b8a2444f3c819f` from WIN to LOSS via direct UPDATE, capper Dan (dangambleai) showed ROI=2498.5% (1W-1L). **#77 (`3ed77e2`) confirmed this is arithmetically correct, not a formula divide-by-nonsense:** `+2498.5%` = 49.97u profit on 2u risked via a `+5097` longshot hit. The unified `CAPPER_STATS_COLUMNS` formula (settled-set numerator ÷ `CAST(units AS REAL)` denominator, no floor) reproduces it exactly, and it is surfaced for monitoring via `flagAbnormalRoi` (`>500%` log) without being clamped. The original concern (manual UPDATE not running `finalizeBetGrading`'s unit math) was the wrong hypothesis — ROI is computed on read from settled rows, so the override is reflected correctly. (Canonical manual-override path remains worth documenting, but no ROI math is broken.)

### G7 — Player-prop threshold verification (future grader hardening)

The new G6 (player_not_in_evidence, v357) catches wrong-player-entirely hallucinations. It does NOT verify the player's actual stat line meets the bet's threshold. Example: bet "Elly De La Cruz 2+ Hits+Runs+RBI", evidence "Elly De La Cruz homered and drove in four runs" — G6 passes correctly (player is named, threshold actually met). But same evidence on bet "Elly De La Cruz 6+ Hits+Runs+RBI" would also pass G6 even though 5 < 6 fails. To truly catch threshold hallucinations, need a guard that extracts numbers from evidence and compares to bet threshold. Bigger fix, requires NLP for stat-line extraction. P2 — add to grader hardening track behind G6.

### Inconsistent grader dispatch — MLB props sometimes use StatsAPI, sometimes AI

Same parlay (bet `8ff7d273`, 2026-04-30 21:30): legs for Paul Skenes, Christopher Sanchez, Yordan Alvarez, Freddy Peralta, Bobby Witt Jr. all `[grade] resolved via StatsAPI`. Leg for Elly De La Cruz fell through to AI search ("Elly De La Cruz MLB final score..."). Same sport (MLB), same ingest path, similar prop shapes — should all hit StatsAPI. Possible causes: player-name matching against StatsAPI roster (apostrophes, accents), StatsAPI rate limit fallback, or game-not-final timing. Investigation P2; current behavior isn't broken (AI fallback works), just inefficient and less confident.


## 🚨 P1 — Investigate 98%-empty event_date (blocks bet idempotency migration)

Day 2 attempt 2 surfaced: 898 of 918 bets have empty event_date, 13 free-text (`Today`, `Game 6`, `9:10PM ET`, `4/6/26`, `May 03, 2026`), 7 ISO datetime. Slip extraction or `createBet` path isn't populating event_date reliably.

Fingerprint-composition idempotency migration cannot ship until this is fixed — current state would cause the supersede step to dedupe legitimately distinct bets across days, hiding hundreds of real bets behind a `superseded_by_id` chain.

> This is the **write-side** half of the wrong-date class; **Gate 4** (`gate4-off-date-reject`, under "Grading gates 4–5") is the read-side guard that already rejects off-date evidence at grade time — populating `event_date` here upgrades Gate 4's anchor from the bet's placement day to its true game day.

**Investigation steps:**
1. Trace event_date population path: slip extractor (Gemini Vision parse) → buffer → bouncer → `createBet` at `services/database.js:333`.
2. Identify why 98% of rows end up empty. Likely candidates: extraction prompt not asking for event_date, default fallback overwriting parsed value, or bet insert dropping the field.
3. Backfill the 13 free-text rows by parsing them into ISO datetime (manual or LLM-driven). Backfill the 898 empties from Discord message timestamp + sport/league schedule lookup if feasible.
4. Standardize on ISO datetime format going forward.
5. Re-run Day 2 idempotency migration with reliable event_date.

**Sample queries for investigation:**
- Distribution: `SELECT event_date, COUNT(*) FROM bets GROUP BY event_date ORDER BY 2 DESC LIMIT 30;`
- Recent empties: `SELECT id, capper_id, sport, description, event_date, created_at FROM bets WHERE COALESCE(event_date, '') = '' ORDER BY created_at DESC LIMIT 20;`

**Priority:** P1 (gates Day 2 idempotency migration).


## Worktree-deploy bug (2026-05-06)
- Symptom: fly deploy --local-only from .claude/worktrees/hardcore-wilson-3d6dc0 produced ~7.86kB Docker build context vs expected ~1.65MB+ from main. Image was missing committed changes despite COPY . . in Dockerfile.
- Workaround: cherry-pick worktree commit onto main, deploy from main directory with --no-cache. Confirmed working at v374 (79c8bef).
- Impact: silent. fly status reports correct deployment ID; only file-level container inspection (sed/wc -c against local) detects mismatch.
- Root cause unknown. Possibilities: Docker daemon path resolution, BuildKit context cache, fly CLI directory walk treating .claude/worktrees specially, or .gitignore/.dockerignore interaction with worktree HEAD.
- Investigation TODO: minimal repro from clean worktree; test if explicit --dockerfile or --image-label changes behavior.
- Cost so far: ~2 deploys + ~30 min debugging this session.

## Resolution Log

- **2026-05-07 — DatDude #datdude-slips Hard Rock bet slips not staging to war-room: RESOLVED.** Original symptom was Hard Rock Bet shares from #datdude-slips never reaching war-room. Long debug entry hypothesized buffer collision or channel-specific drop. Root cause turned out to be the validator entity-mismatch bug, surfaced by the slip-share exemption fix (commit `3aadc63`). After deploy, Smokke staged a test slip in #datdude-slips end-to-end at 20:24 UTC — pipeline trace showed `RECEIVED → AUTHORIZED → BUFFERED → EXTRACTED → AI_RESPONSE_RAW → STAGED`. The "silent drops" symptom was validator kills on legitimate slip-share bets, not channel-routing.
- **2026-05-07 — groq-llama8b dominance: STALE CLAIM.** 7-day grading_audit histogram: cerebras 80.8% (1484 calls), ESPN 10.4%, mlb.statsapi 4.5%, mistral 4.0%, groq-llama8b 1 call. Waterfall functions as designed. The original "Known open issues" entry described prior config. Real concern shifted: per-bet PENDING analysis (Layer 2 of missed-slips investigation).
- **2026-05-13 — DatDude/HRB P1 reframed.** The "DatDude #datdude-slips" entry was stale on three counts: (1) DatDude moved to #ig-dave-picks after 2026-04-17 and posts there now; (2) the original "post-Vision silent drop" hypothesis was disproven across two retrospective ERRATAs; (3) Fix B (commit `3aadc63`, 2026-05-07) closed the validator entity-mismatch failure mode that was the actual cause of "no bet in war-room" for slips that reached PARSED. A new failure mode remains: Vision AI returns `type: 'ignore'` on HRB image-attached slips, gate at `shouldFallbackToGemma()` doesn't fire on `ignore`, drop at `PRE_FILTER_NO_BET_CONTENT / ai_is_bet_false`. Reframed as Fix A pending. Live trace confirming new failure mode: ingest `disc_1503958745313575097`, 2026-05-13 03:15 UTC. Verification: pipeline_events foundation verified healthy (1102 rows/24h, GRADE_* drops stamping, no orphans).

### /admin retest-slip command
Admin command to delete dedupe + pipeline state for a given Discord message ID so the same slip can be reposted for testing without manually clearing tables. Should clear: dedupe table row (TBD name), pipeline_events rows, vision_failures rows, bets rows. Useful for debugging gate changes without needing fresh slip content.

### ~~Odds API: 401 Unauthorized on both primary and backup keys~~ — RESOLVED
✅ RESOLVED 2026-06-10 — free-tier quota reset June 1 restored auth (HTTP 200 on `/v4/sports` with the primary key, verified from the Fly container; COA audit §F.7). The 401s were quota exhaustion, not bad keys. The caching design (`odds_snapshots`, see "Odds API caching" below) remains the pre-July to-do if usage repeats the burn rate.

### v423 VERIFIED — DubClub MAG7 sheets ingest as per-sport straights
Smokke-posted test slip in #lockedin-slips at 15:20:49 UTC produced 7 separate war-room embeds, each tagged with correct per-leg sport (NHL, MLB, etc). SHEET vs PARLAY rule fires correctly. No HALLUCINATION BLOCKED. Vision AI also resolved OCR ambiguity (Bills+Sabres → Sabres NHL; Dolphins+Marlins → Marlins MLB). Closes the "LockedIn multi-section sheets skip NBA" issue class for sheet-shape inputs.

## 🚨 KNOWN ISSUES — Surfaced 2026-05-14, Deferred

### ~~Cerebras llama3.1-8b retires 2026-05-27~~ — RESOLVED (deadline passed without incident)
✅ RESOLVED — option (a) shipped pre-deadline: `fly secrets set CEREBRAS_MODEL=gpt-oss-120b` (v426) + code default aligned at `services/ai.js:44` (v428, see ✅ SHIPPED 2026-05-14). Current state (verified in code 2026-06-10): the grader waterfall leads with `groq-llama4-scout` and pins Cerebras to `gpt-oss-120b` hardcoded at `services/grading.js:2254` — Cerebras is no longer the primary tier. Stale line refs (`:1995`, qwen literal) corrected in the "Wire Cerebras grader model to env var" entry below.

### Gemma fallback returns empty responses (NOT a config bug)
Verified 2026-05-14: OLLAMA_URL IS set on Fly (https://tracker-surface-pro.tail65f8f0.ts.net), OLLAMA_PROXY_SECRET set (len=64), proxy returns 200 + gemma3:4b loaded via direct curl test. So function does NOT bail at services/ai.js:707. The empty `gemma_response` rows (23 in 7 days, all gemma_len=0) come from somewhere later in the call path. Hypotheses to investigate next session:
- /api/generate returning empty data.response on real images
- Circuit breaker tripping after first failure and silently skipping
- Image base64 too large for the request
- gemma3:4b actually returning NOT_A_SLIP boilerplate that gets normalized to empty
Add temporary debug logging around services/ai.js:741 (the data.response read) to see what Ollama actually returns on a real production slip.

### Odds API exhausted (the-odds-api.com)
> ✅ Resolved by the June-1 quota reset — HTTP 200 round-trip verified from the container 2026-06-10 (COA audit §F.7). Kept for context; caching remains the pre-July lever.

Free tier: 498/500 credits used, resets June 1 at 12AM UTC. Both keys (primary + backup) on same usage pattern. Bot logs 401 because the-odds-api returns 401 when over quota (not 429). War-room embeds still post; just no live odds enrichment. Fix options: (a) upgrade to $30/mo for 20K credits, (b) cache aggressively + only enrich on stage-to-war-room, (c) wait until June 1. Business decision, not code.

### GNP-slips silent drop on 2026-05-14
Smokke posted a slip in #gnp-slips around the time of LockedIn debugging. fly logs grep returned nothing for "gnp" — message didn't produce ANY log output. Channel IS in HUMAN_SUBMISSION_CHANNEL_IDS (added in today's secret rotation), IS in CAPPER_CHANNEL_MAP (1473343838587457626:GNP). Possible causes: bot didn't see the message (Discord permission?), or grep window missed it (post happened before log retention). Recheck next session by posting a fresh slip in #gnp-slips and immediately grep.

### Cerebras waterfall consolidation candidate
Both Cerebras and Groq now offer openai/gpt-oss-120b. Current waterfall has 4 tiers; could simplify to 2-3 if we drop Cerebras for Groq (since Groq also has llama-3.1-8b-instant for backup). Worth evaluating after Cerebras migration ships.

### Odds API caching (free tier, deferred from May 2026 session)

**Context**: Free Odds API tier renews June 1, 2026. Usage is data-purposes only (analytics / CLV / line history), not live decision-making. Staleness is tolerable. No upgrade needed if caching is in place before reset.

**Design sketch**:
- New table `odds_snapshots`:
  - `event_id TEXT` (Odds API event id)
  - `sport TEXT`
  - `sportsbook TEXT` (DraftKings, FanDuel, etc.)
  - `market TEXT` (h2h, spreads, totals, player_props)
  - `outcome TEXT` (team/player name or line description)
  - `point REAL NULLABLE` (spread/total number, null for ML)
  - `price INTEGER` (American odds)
  - `captured_at TIMESTAMP`
  - `commence_time TIMESTAMP` (game start)
  - Composite index on (event_id, sportsbook, market, captured_at)

- Polling cron on Surface Pro (free residential IP, no Fly egress concern):
  - Pull pre-game odds at fixed interval — start with hourly for next-24h games, every 15 min for next-2h games
  - Tune frequency against free-tier monthly call budget once we know the actual cap
  - Write snapshots to Surface Pro local DB, push deltas to Fly nightly OR expose read endpoint via Tailscale Funnel

- Optional later: snapshot capture at bet-creation time so each bet record points at the closest pre-game snapshot for CLV calculation.

**What this does NOT do**:
- Live in-game odds (caching is wrong for that — different problem if/when needed)
- Replace any current grading path (grading is independent)

**Open questions before build**:
1. What's the actual free-tier call cap and how does it map to polling interval × sport count?
2. Surface Pro local DB or push to Fly? Local keeps Fly storage clean; Fly push simplifies queries from the bot.
3. Do we backfill historical odds before June 1 reset, or accept the cold-start gap?

**Priority**: P3 (after P1 silent-drop cleanup, P2 DatDude/grader work). Build before June 1 reset to avoid any service interruption when the new month's quota lands.

---

## ✅ SHIPPED — 2026-05-14

Seven deploys this session, one revert, all clean exits. Bot ended healthier than it started.

- **v418 (9aea703)** — `fix(ai): use bets[] not flattened legs[] as parseBetSlipImage fallback gate`. Stopped Gemma fallback misfiring on already-valid slips.

- **v420–v422** — `HUMAN_SUBMISSION_CHANNEL_IDS` expanded from 2 to 17 channels. Restored LockedIn ingestion after 5 days silent drops at the image-only bouncer. Channels added: LockedIn, GameScript, Boogieman, GNP, Gallery, Trent, Degens, Mez, Zootied, T, Harry, Cody, Gavin, Dan, Smokke.

- **v423 (c6ca820)** — `fix(ai): SHEET vs PARLAY detection`. AI now emits per-sport straights for MAG7/board-style multi-sport sheets BEFORE PARLAY/DFS detection. Triggers on header words (MAG7, MAGNIFICENT 7, BOARD, TOP PLAYS, DAILY PICKS, SHEET, TODAY'S LOCKS, PICKS OF THE DAY) OR legs spanning 2+ sports. Verified end-to-end on a 7-leg DubClub MAG7 ingestion — 7 separate war-room embeds with correct per-sport tags, no `HALLUCINATION BLOCKED: leg_sport_mismatch`.

- **v425 (2cbd855)** — `fix(grading): swap deprecated groq-kimi → openai/gpt-oss-120b`. Kimi tier (`moonshotai/kimi-k2-instruct`) deprecated 2025-09-10 and had been silently 404'ing for months. `services/grading.js:1905`. Provider renamed `groq-kimi` → `groq-gpt-oss`.

- **v426** — `fly secrets set CEREBRAS_MODEL=gpt-oss-120b`. Pre-emptive migration before Cerebras llama3.1-8b May 27 retirement.

- **v428 (9daf38a)** — `fix(ai): default CEREBRAS_MODEL to gpt-oss-120b`. Code default at `services/ai.js:44` aligned with env var.

- **v431 (cf58b4c)** — `fix(ai): disable Gemma fallback via GEMMA_FALLBACK_DISABLED env var`. Gate added to `shouldFallbackToGemma()` at `services/ai.js:883`. Hardware ceiling — see CLAUDE_WORKFLOW for rationale.

- **v432 → REVERTED as v433** — Admin-log notice first attempt failed with `ReferenceError: isHumanSubmitChannel is not defined`. Variable defined in `handleMessage` scope, referenced from `processAggregatedMessage` scope. Different functions. Lesson documented as Rule 8 in `docs/CLAUDE_WORKFLOW.md`.

- **v434 (8d1668a)** — `fix(handler): post admin-log notice when human-channel slip drops at AI verdict (fix B)`. Reshipped with inline `humanChannelIds` computation at each call site, optional chaining on `capperInfo?.name`. Verified end-to-end: AI returned `type=ignore` on test image, `[Filter] AI rejected as non-bet` fired, ⚠️ notice appeared in #admin-log with [View Original] link. No production errors.

---

## P1 — Roadmap (next session)

### Human-channel slip review routing (option 3)

**Background**: v434 closes the visibility gap (admin-log notice on every human-channel ignore-verdict drop) but slips themselves still drop — user has to manually re-enter the bet from the View Original link. Goal of option 3 is to route human-channel ignored slips to the review queue as skeleton bets that the user can Edit to populate, eliminating manual re-entry.

**Design (no schema change required — verified via `PRAGMA table_info(bets)` on 2026-05-14 production DB)**:

- Reuse existing `review_status` column. New value: keep `'needs_review'` (same as audit-mode bets), differentiate via `drop_reason`.
- Reuse existing `drop_reason` column. New values: `'AI_VERDICT_IGNORE'` (PRE_FILTER_NO_BET_CONTENT path), `'AI_INDETERMINATE'` (PRE_FILTER_AI_EMPTY_RESULT path).
- Reuse existing `grading_state` column. New value: `'manual_pending'` — grader skips this state (must update `getPendingBets()` query at `services/database.js:447`).

**Implementation outline (~4 commits)**:

1. **messageHandler.js routing**: at line 1097 (`is_bet === false`) and line 1126 (`is_bet !== true && bets===0`), branch on `isHumanSubmitChannel` (computed inline per Rule 8). If human, call `createManualReviewBet()` helper. Else, `dropAll()` as today.

2. **`createManualReviewBet()` helper** (new file `services/manualReview.js` or extend `services/database.js`): calls existing `createBetWithLegs()` with `capper_id` resolved from `capperInfo`, `source='manual_entry_required'`, `source_channel_id`/`source_message_id`/`raw_text` preserved, `review_status='needs_review'`, all bet-specific fields null. **Then** runs an UPDATE to set `drop_reason='AI_VERDICT_IGNORE'` and `grading_state='manual_pending'` — `drop_reason` is not in the `insertBet` prepared statement (only 21 placeholders, see `services/database.js:183`). Finally, calls `sendStagingEmbed(client, saved, capperInfo.name, message.url)` to post to war-room.

3. **warRoom.js embed differentiation**: at line 35-90 embed builder, branch on `bet.drop_reason IN ('AI_VERDICT_IGNORE', 'AI_INDETERMINATE')`:
   - Title: `⚠️ Manual Entry Required — Slip Could Not Be Parsed`
   - Color: red instead of warning yellow
   - Body fields: raw_text snippet (200 chars), AI verdict, View Original link
   - Buttons: hide Approve (nothing to approve), keep Edit + Reject
   - Edit modal already handles null fields gracefully — pre-fills empty, user fills in

4. **Grader suppression + auto-confirm guard**:
   - `getPendingBets()` query at `services/database.js:447`: add `AND b.grading_state != 'manual_pending'` clause
   - `gradeBetRecord()` auto-confirm at line 437: already gated on `allowAutoConfirm` param. Verify no caller passes `allowAutoConfirm=true` for manual-entry bets. If risk exists, add `AND drop_reason IS NULL` to the auto-confirm UPDATE.

**Open concerns (mapped 2026-05-14, not yet addressed)**:
- Fingerprint uniqueness: `buildFingerprint()` at `services/database.js:286` keys off `source_message_id` — different Discord messages produce different fingerprints. Two manual-review bets won't collide. ✅
- Edit modal at `services/warRoom.js:290-345` pre-fills from bet data. Null fields render as empty inputs. ✅ (untested — verify on first manual-entry bet)
- Auto-confirm at `gradeBetRecord:437` could wrongly confirm a manual-entry bet if grader somehow ran. Belt-and-suspenders: grading_state='manual_pending' suppresses grader; auto-confirm gated on `allowAutoConfirm` flag from caller.

**Tests to add**:
- `tests/bouncer-rejection.test.js` — extend: human-channel + `is_bet=false` produces a bet row with `review_status='needs_review'`, `drop_reason='AI_VERDICT_IGNORE'`, `grading_state='manual_pending'`. Non-human-channel + `is_bet=false` still drops via `dropAll()`.
- New `tests/manual-review-grader-skip.test.js` — verify `getPendingBets()` excludes `grading_state='manual_pending'` rows.

**Estimate**: 4 commits, 2-3 hours when fresh. Each commit ships per DEPLOY_CHECKLIST.

### GNP-slips silent drop recheck

User reported a slip post in `#gnp-slips` earlier 2026-05-14 produced no logs. Channel IS in `HUMAN_SUBMISSION_CHANNEL_IDS` (added in v420-v422 expansion). After v434, any future drop at PRE_FILTER_NO_BET_CONTENT / PRE_FILTER_AI_EMPTY_RESULT will produce a ⚠️ admin-log notice. Recheck by posting a fresh slip in `#gnp-slips` and watching admin-log + `fly logs --no-tail | grep gnp`.

### Cerebras waterfall consolidation

Both Cerebras and Groq now serve `gpt-oss-120b`. Current waterfall (cerebras → groq-llama8b → groq-gpt-oss → ollama text) has three of four tiers running the same model class on different providers. Worth simplifying to a 2-tier waterfall (provider primary → provider failover) once usage telemetry confirms which provider has better latency/reliability. Deferred pending architecture session.

### Odds API quota — June 1 reset decision

The-odds-api.com free tier exhausted 2026-05-14 (498/500 credits used, returning 401 since). Quota resets June 1 00:00 UTC. Decision before then: (a) wait and stay on free, (b) upgrade to $30/mo for 20K credits, (c) aggressive caching to extend free tier coverage. Business decision — pending Smokke's read on signal-to-cost ratio.

> Update 2026-06-10: option (a) is what effectively happened — the June-1 reset restored auth (HTTP 200 verified from the container, COA audit §F.7). Caching (`odds_snapshots` design above) is the standing pre-July to-do if the burn rate repeats.

### Wire Cerebras grader model to env var
(Refreshed 2026-06-10, COA audit M-11.7 — prior line refs were stale.) The grader waterfall pins the Cerebras provider to `gpt-oss-120b` hardcoded at `services/grading.js:2254` (provider `cerebras-gpt-oss`; the waterfall now leads with `groq-llama4-scout` at `:2251`). The `CEREBRAS_MODEL` Fly secret exists but is unused at this call site, so model swaps require a code deploy. Either change the literal to `process.env.CEREBRAS_MODEL || 'gpt-oss-120b'` so swaps are `fly secrets set` + restart, or drop the unused secret to avoid confusion. Note `services/ai.js:44` already does this correctly (`process.env.CEREBRAS_MODEL || 'gpt-oss-120b'`). Low priority — current model works. Caveat: smoke-test any swap against the grader's `max_tokens` budget (now 1000 at `services/grading.js:2323`; the v441 starvation happened at the old 200 — see the v441/v442 postmortem above).

## Discovered 2026-05-19 (Phase 1 session)

### Bing scraper returns generic news (not just 402) — ✅ ADDRESSED by S2 (M-3)
**✅ The parse-blind breaker + generic-news detector shipped in S2 (PR #74 `4c992c9`, deployed v606 2026-06-10):** `searchBing` now records `parse_empty` on 0-hit drifted markup (circuit failure + fall-through) and `generic_news` when no parsed hit mentions a query token (fall-through, no breaker trip) — junk-Bing now reaches Brave instead of being scored healthy (live-verified post-deploy on a real autograde query). The defensive multi-selector parsing (`b_algo` drift) is NOT in this PR — left as a follow-up (see **"Bing `b_algo` defensive multi-selector parse"** below); today's mitigation is fall-through-to-Brave, not a better Bing parse. **→ originally folded into S2 (Breaker honesty) of the search arc above** — the parse-blind breaker + generic-news detector are exactly S2's scope. Memory #30. `searchBing` (`services/grading.js:1645-1681`; `b_algo` split at `:1662` — prior `:1369-1404` ref was stale) parses `class="b_algo"` which Microsoft changed. Returns HTTP 200 with MLB.com/ESPN homepage HTML, not game recaps. Phase 1 (commit 9a19ba6) mitigates for MLB/NBA/NHL. Soccer/golf/tennis/MMA still affected. Fix: defensive multi-selector parsing + generic-news detector that returns "no reliable evidence" → PENDING instead of forcing a bad parse.

> Audit 2026-06-10: still live — 84 Brave fallbacks/7d (vs 1262 Bing "ok"), and the circuit breaker is parse-blind (any HTTP 200 records `ok`, including 0-hit drifted markup and junk hits), so the broken-parse class never opens the breaker; see COA audit M-3 for the written-out resolution (PARSE_EMPTY + generic-news detector in `searchBing`).

**Symptom ↔ cause — "bets stuck pending / everything voids":** this is a **search-layer** symptom, not a grader bug. When the backends here return garbage or no usable evidence, the grader correctly emits repeated PENDING, and `shouldAutoVoidNoData` (5+ no-data PENDINGs over 12h, `services/grading.js`) then converts those to VOID — so a broad search degradation reads downstream as mass stuck-pending followed by mass voids. The live driver is the Bing generic-news return above (non-MLB/NBA/NHL sports); Brave-402 is already resolved (see that item above). Lever is the search layer, not the grader. Distinct from the "Unknown-sport straight voids" bucket above, which is missing sport classification rather than backend health.

### Resolver sidecar orphaned from grading hot path
After commit 9a19ba6 (Phase 1), `services/resolver.js` no longer called from `gradeSingleBet`. Still required by `/admin snapshot` (commands/admin.js:763) and `/admin resolver-health` (commands/admin.js:999). zonetracker-resolver Fly sidecar app last deployed Apr 20 2026, paying compute for monitoring data that's now meaningless. Cleanup: repoint admin commands at sportsdata adapter health, then delete resolver.js + shut down sidecar.

### Cappers table data integrity audit (post-5efcdd8)
The capper-rename corruption bug at warRoom.js:619 (fixed in commit 5efcdd8 on 2026-05-19) means historical Edits that changed a capper name silently renamed that capper across ALL their bets. Audit query: `SELECT id, display_name, created_at FROM cappers ORDER BY display_name`. Look for: two cappers with very similar names (sign of split), one capper with disproportionate bet count vs others (sign of accidental merge), recently-created cappers with no bets attributed pre-creation-date (orphans). No corruption-recovery plan; document findings and decide case-by-case.

### MANUAL_REVIEW_HOLD release-as-bet flow
PR #25 (feature/hold-release-as-bet). Replaces plain-text admin notifications with embed + Release/Dismiss/View Original buttons. Release opens manual-creation modal (NOT AI re-run). Strict capper lookup. Awaiting review + merge + deploy. If merged: 71 backlog held events stay as audit history, forward-going only.
## Recap / promo / sweat detection — drop instead of hold

**Problem:** v447 MANUAL_REVIEW_HOLD traps everything the parser couldn't confidently classify as a bet. That includes legitimate non-bets — recaps ("cashed a +384 parlay last night"), capper promos ("Dinger Sheet — users get this every day"), sweat commentary ("7 points needed to cash"), and event hype ("Conference Finals are underway"). These should drop, not hold. Observed 2026-05-20: of 25 holds in 24h, ~15 were clearly non-bets that should never have hit admin-log.

**Fix path:** Add a pre-hold heuristic in `handlers/messageHandler.js` at the `is_bet=false` and `ai_indeterminate` branches (~line 1095, 1141). Before staging MANUAL_REVIEW_HOLD, run a content classifier against the message text:

- **Recap** — past-tense + result words ("cashed", "hit", "lost", "yesterday", "last night", "fell short"). Drop with `PRE_FILTER_RECAP`.
- **Promo/sheet** — sheet/algorithm markers ("Dinger Sheet", "Bank Builder", "profit boost", "users get this", "load here", FanDuel/DraftKings promo terms). Drop with `PRE_FILTER_PROMO_SHEET`.
- **Sweat/commentary** — in-progress watching ("needed for this to cash", "is there time", "if these guys", "let's go"). Drop with `PRE_FILTER_SWEAT_COMMENTARY`.

Empty-text image-only posts (DatDude HRB pattern) keep hitting MANUAL_REVIEW_HOLD — those are the legitimate cases the hold flow exists for.

**Heuristic starter** already exists in `services/replayHolds.js#guessDisposition` (shipped with `/admin replay-holds`). Promote that function to a production parser pre-filter once it's validated against more real data.

**Validation:** Don't ship this until at least a week of v463 + replay data shows the false-positive rate on each pattern is < 5%. Otherwise we'll start dropping real bets that happen to contain a trigger word.

**Tracking:** First spotted 2026-05-20 when 25-hold backlog audit showed recap/promo/sweat were 60%+ of the queue.
## Playwright shortlink expander (high value)

**2026-06-12 — probe + phased plan (refines the DOM-scrape "Fix path" below; that plan preserved for audit).**

45-day MANUAL_REVIEW_HOLD probe — **259 unique holds**:
- **Link-gated: 48.** `hrb_share` **38** (DatDude 25, IgDave 9, Smokke 4) + `fanduel` **10** + `gamescript` **4** (capper portal — sign-up wall, manual-only, no public DOM).
- **Unmatched: 189** — text-parser class: the legs are *in the message text* and the parser is fumbling them. Separate P1, **not** a link problem.

(Probe figures as reported. The per-domain counts 38+10+4 sum to 52, above the 48 unique link-gated headline — overlapping/approximate probe bucketing, not a strict partition; likewise link-gated 48 + text-parser 189 don't cover all 259, the remainder being mixed/dup/other.)

**Decision: screenshot → vision, not per-book DOM scrape.** Render the share page on the Surface Pro and feed the screenshot to the existing `parseBetSlipImage` vision path (the same machinery that already reads HRB image slips). One renderer covers every book whose share page paints legs on screen — no per-book selector maintenance (supersedes the FanDuel/DK/HRB selector hints below).

**Phased plan:**
- **A — shadow (this PR, `feat/link-reader-shadow`, no deploy).** `services/linkReader.js` detects allow-listed book/shortlink URLs in messages headed for MANUAL_REVIEW_HOLD and, under `LINK_READER_MODE=shadow`, annotates the *existing* hold event with an additive `share_link: {url, domain, kind}` field. `LINK_READER_MODE` unset/off → no annotation (feature dormant, no behavior change). Also bumps the hold `sample` slice 80→400 chars so reviewers see more body text. Allow-list: `share.hardrock.bet`, `sportsbook.fanduel.com`, `sportsbook.draftkings.com`, `dkng.co`, `bit.ly`, `tinyurl.com`.
- **B — Surface Pro `zonetracker-link-reader` service.** New microservice (sibling to `zonetracker-ocr` / scraper): takes a share URL, follows redirects, renders headless, returns a screenshot. Tailscale-fronted; ~10s timeout; any failure falls back to the existing MANUAL_REVIEW_HOLD path (never blocks ingest).
- **C — cutover.** On a (shadow-confirmed) share link: Surface Pro service → screenshot → `parseBetSlipImage` → save legs as if the bot read the slip directly. Gated by `LINK_READER_MODE=cutover` (strict; treated as off until C ships).

**Twitter-side caveat:** the Surface scraper's *display text* mangles URLs — injected spaces + ellipsis truncation (`bit.ly/Din… ger`) — so Twitter-relayed links are unusable for detection until the scraper captures the anchor **href** instead of the rendered text. Promo domains (dubclub/whop/linktr) never expand to a slip; **allow-list only**.

---

**Problem:** Cappers post a substantial fraction of their picks as "Load here: bit.ly/X" tweets where the actual legs are behind a sportsbook share link or capper portal. Bot text-parses "$10 → $413 if these two guys go yard" and gets nothing extractable. Currently these slips hit MANUAL_REVIEW_HOLD and get dismissed because the human reviewer would also have to click through, and that's not scalable.

Confirmed examples from 2026-05-19 audit:
- Cody "+4039 Dinger Tuesday Parlay" — bit.ly/Dinger0519 → FanDuel betslip
- Dan "+3024 Dinger Double" — bit.ly/Dinger-May19 → FanDuel betslip
- Dan "+417 Spurs @ Thunder G1 SGP" — bit.ly/SASOKC-417 → FanDuel betslip
- Harry "$10 into $422" — bit.ly/LOTTOEPL519 → FanDuel betslip
- Dan "+280 Cavs @ Knicks Special" — bit.ly/CLE-NYKSpecial → FanDuel betslip

Every one of these is a real pick the bot is missing.

**Fix path:** Add a Playwright job to the existing Surface Pro scraper service. Given a shortlink URL, follow redirects, render the destination, scrape the bet slip DOM.

Per-book selector hints:
- FanDuel (`sportsbook.fanduel.com/addToBetslip` and `bit.ly/*` redirects): bet slip side panel renders client-side; legs are in DOM nodes with structured market/selection text + American odds. Pull legs + total odds.
- DraftKings (`sportsbook.draftkings.com`): same pattern, different selectors.
- Hard Rock (`share.hardrock.bet`): renders share page with selection list; structure matches existing HRB image slip schema.
- Capper portals (`gamescript.ai/code=*`, `joinopuspicks.com`, etc.): sign-up wall, no public content — return null, fall back to manual review.

**Integration point:** Add to `services/ai.js` parseBetText. When the text contains a known shortlink (bit.ly, t.co, sportsbook short domain) AND parser returns is_bet=false or empty bets, call out to the Playwright fetcher BEFORE staging MANUAL_REVIEW_HOLD. If fetcher returns legs, re-parse with the expanded leg list as if the bot had read the slip directly.

**Tier-down behavior:** Playwright job has a 10s timeout. If it can't reach Surface Pro (Tailscale down) or the page hangs, fall through to existing MANUAL_REVIEW_HOLD path. Never block ingestion on the fetcher.

**Why high value:** Single feature unlocks 5+ real picks per day from Cody/Dan/Harry alone, currently 100% lost. Same machinery extends to any future capper who shares via shortlink, which is most of them.

**Tracking:** First spotted 2026-05-20 during 33-hold audit. 4 of 33 (12%) were link-only.

---

## On-ingest duplicate hold rows

**Problem:** 11 of 33 unresolved holds in the 2026-05-20 audit (33%) were exact duplicates — same `messageUrl`, consecutive `ingest_id`s posted within milliseconds. The bot is processing the same Discord message twice and writing two MANUAL_REVIEW_HOLD events.

Examples (each pair has identical messageUrl):
- disc_1506048018334482494 + disc_1506048022465740860 (Cody Chourio)
- disc_1506303475099635882 + disc_1506303479184887962 (Harry promo)
- disc_1506312269137580142 + disc_1506312273902309668 (Cody Dinger Tuesday)
- disc_1506357564319731792 + disc_1506357568212303953 (Cody Konnor Griffin)
- disc_1506371420282687529 + disc_1506371424565198891 (Cody Mobley)
- disc_1506372664271568916 + disc_1506372668465611044 (Dan Dinger Double)
- disc_1506390284819234898 + disc_1506390289382903908 (Dan sheet)
- disc_1506402866871664750 + disc_1506402871116173483 (Dan Bank Builder)
- disc_1506426771044696184 + disc_1506426775364702268 (Dan algorithm sheet)
- disc_1506484661247938773 + disc_1506484665232392242 (Dan sweat)

Not the multi-image merge case (memory #20 — that was different ingest_ids with shared content). This is the same `messageUrl` getting two separate `ingest_id`s and both going through the pipeline.

**Hypothesis:** Buffer collision or double-dispatch in `handlers/messageHandler.js`. Likely Discord event firing twice (MESSAGE_CREATE + something) or buffer-flush running twice. The `makeIngestId` function appears to generate unique IDs per call rather than per message — needs investigation.

**Impact:** Doubles hold-table noise, doubles potential bet count if released, doubles all downstream grading work. Not yet known if this duplication extends past the hold path into successful-bet inserts (memory #15 LockedIn ingestion restore noted volume increase that may have been masked by this).

**Fix path:**
1. Query `pipeline_events` for any `messageUrl` with 2+ MANUAL_REVIEW_HOLD events in last 30 days — quantify
2. Same query for RECEIVED stage events grouped by source_ref — does duplication start at message receipt or later
3. If duplication is at receipt: probably a `messageCreate` handler registered twice or a shard event collision. Check `bot.js` event registration.
4. If duplication is at staging: race between buffer flush timer and direct dispatch path. Inspect `handlers/messageHandler.js` buffer logic.
5. After root cause: add dedup key based on `(channelId, messageId)` at ingest_id assignment — both dupes get same ingest_id, second one short-circuits.

**Severity:** Quality-of-data issue, not data-corruption (dismissals/releases are per-ingest_id so duplicates are tracked correctly). But it's masking the real volume signal in every dashboard.

**Tracking:** First confirmed 2026-05-20 audit. Investigate before promoting recap detection (it would 2x the dismiss rate metrics incorrectly).

---

## Durable slip-image storage (image bytes, not url) — FLAGGED, NOT PRIORITIZED

Not an active item. The only case live re-fetch can't cover: a capper **deletes** a slip post before its `MANUAL_REVIEW_HOLD` is walked. `review-holds.js` re-fetches the live Discord message per walk (`channel.messages.fetch` from `payload.messageUrl`) and reads attachments fresh, so every other case is already handled — including stale CDN signed-url TTL: the ~26h HRB-walk median outruns the ~24h signed-url TTL, which is exactly why a stored *url* would not help and only stored image **bytes** would survive a pre-walk deletion.

Rare, and `review-holds.js` already degrades gracefully when the message is gone. Revisit ONLY if message-deletion-before-walk shows up as real lost capper data. Do NOT re-open the imageUrl-persistence approach — closed as not-worth-it (no consumer reads `payload.imageUrl`; see the hold-rescue note in docs/CODEMAP.md).

---

## GameScript / capper portal data sheet ingestion

**Problem:** Multiple cappers (Dan, Harry, Cody) post daily prop projection sheets behind `gamescript.ai/code=X` links. These sheets contain real player-prop data: line projections, hit-check stats, NRFI data. Currently dismissed as "promo" because the slip body is just sales copy ("Don't miss another sheet"), but the underlying content has actual value if we can get to it.

**Examples from 2026-05-20:**
- Dan: "MLB Dinger Sheet — users get this every day plus Hit Check, Matchup and NRFI data" → gamescript.ai/code=danx
- Harry: "Premier League Soccer SGPs + 20+ plays on NBA, MLB & WNBA + AI Backed Picks with research + Data Sheets to help build winners" → gamescript.ai/?code=HLX
- Dan: "I used my algorithm to project players' prop lines for Cavaliers @ Knicks" → gamescript.ai/code=danx (Knicks sheet)

**Why it's hard:** Capper portals are auth-gated. Public URL hits a sign-up wall. To access the sheet you need either (a) a free-tier account on the capper's portal, (b) reverse-engineer the API endpoint behind the rendered sheet, or (c) browser-extension-style scraping of an authenticated session.

**Possible paths:**
- **(a) Per-capper portal account.** Sign up for free tier on GameScript with one capper code. Use Playwright on Surface Pro to log in once, persist cookies, scrape sheets daily. Risk: ToS violation if portal disallows scraping; legal review needed before deploying.
- **(b) API discovery.** Inspect network traffic on a real sheet view. If the data comes from a public JSON endpoint, no auth needed. Probably auth-gated but worth checking.
- **(c) GameScript-as-data-source partnership.** Reach out to GameScript directly about API access. Outside engineering scope but lower-risk path.

**Lower priority than Playwright shortlink expander.** Shortlink fixes 5+ real-bet picks per day immediately. Sheets are aspirational data that could power future features (Jarvis suggestions, prop hit-rate validation) but doesn't directly unlock existing capper bets.

**Tracking:** First flagged 2026-05-20. Park until shortlink expander ships, then revisit with concrete data-use case.

## 🚨 P1 — Twitter-relay parser drops real picks (visible-text variant)

**Surfaced 2026-05-21** during PR #31 (pure-slip hold-skip gate) channel sampling. The 4 gambling-twitter-* channels were intentionally left un-bypassed because Cody and Harry post real picks that get held. Sampling confirmed those holds contain real bets the parser is fumbling — not promo, not shortlink-gated, the bet text is *right there in the tweet*.

**Distinct from existing entries:**
- L284 (Harry SGP header absorbed as legs) — slip-image parser, not text-parse
- L901 (Cody Dinger Tuesday shortlink) — bet behind bit.ly the bot can't follow

This is a third bug: bet legs visible in tweet text, parser still returns `is_bet=false` or `ai_indeterminate`.

**Pattern:** `<sport emoji> <category line> / <player> <line> <market>` with optional commentary after.

**Confirmed live samples (from MANUAL_REVIEW_HOLD events 2026-05-21):**
- Cody (channel `1284613911055695893`, 28 holds/14d):
  - `🏀 NBA Best Bet / 🟠 OG Anumoby O20.5 PRs` — player + line + market in plain text
  - `🏀 Here's my favorite NBA straight tonight… / 🗡️ Evan Mobley Over 27.5 PRAs`
  - `🏆 MLB Best Bet / Chourio had two hits to cash for us yesterday. Let's go on anot[her]…` (recap-framed, bet in continuation)
  - `💥 +4039 Dinger Tuesday Parlay / 👉🏼 if these two guys go yard…` (parlay header + legs)
- Harry (channel `1284620792713318472`, 16 holds/14d):
  - `🏀 NBA Pick of the Day… / 👉🏼 Karl-Anthony Towns o10.5 Rebounds`
  - `🏀 NBA Pick of the Day… / Dylan Harper o19.5 PRA's`
  - `🏀 NBA Pick of the Day… / 👉🏼 iHart Over 8.5 Rebounds`

**Hypotheses to test:**
1. Emoji-prefixed lines confuse the parser's bet-detection heuristic (returns `is_bet=false`).
2. Header phrasing like "Best Bet" / "Pick of the Day" / "favorite straight" is being read as marketing copy rather than bet framing.
3. The 80-char sample preview in `pipeline_events` is a red herring — LLM gets the full text but may still bail on the line break between header and bet content.

**Why not bypass:** Bypassing these 4 channels = silently dropping these real picks (bypass is a one-way drop, not silent accept). Confirmed Cody has ~3 real picks per 15-hold sample, Harry ~3/15. Bypassing would delete those.

**Why P1:** Active data loss. Memory tracks ~44 holds over 14 days across Cody+Harry alone, of which sampling suggests ~20% are real picks (≈9 lost picks/14d, ≈18/month).

**Fix surface area:**
- `services/ai.js` `parseBetText` system prompt — likely needs an explicit case for emoji-prefixed Twitter-style picks.
- Or pre-processor that strips emoji/decorative chars before the LLM sees the text.
- Verify by re-running the failing samples through a smoke test after any prompt change.

**Cross-references:**
- PR #31 (commit a1b184b, 2026-05-21) — pure-slip hold-skip gate; explicitly chose NOT to bypass these 4 channels for this reason

**Verification 2026-05-25 (v489 prod, 24h window):** PR #31 bypass clean — zero of 13 bypassed channels holding. All 14 holds in 4 Twitter-relay (Harry 9, Dan 3, Cody 2). HUMAN=17 / PURE_SLIP=13 subset invariant holds live. Distribution shifted from 14-day sample (Cody 28, Harry 16): Dan now appearing in holds; Cody volume down. Tomorrow’s work: parser fix per hypotheses above.
- pipeline_events query that found the pattern:
```sql
  SELECT json_extract(payload, '$.sample') AS sample, json_extract(payload, '$.reason') AS reason
  FROM pipeline_events
  WHERE stage = 'MANUAL_REVIEW_HOLD'
    AND json_extract(payload, '$.channelId') IN ('1284613911055695893', '1284620792713318472')
  ORDER BY created_at DESC LIMIT 30;
```

## ✅ SHIPPED (#49) — `recordStage()` write-boundary enum validation

**SHIPPED as #49 (verified in code 2026-06-10):** soft warn-only validation `warnUnknownEnums` runs at the single write boundary (`services/pipeline-events.js:127` definition, called from `writeRow` at `:154`) — non-canonical `sourceType`/`stage`/`eventType`/`dropReason` values log one attributable warn line and still write (fire-and-forget contract preserved). The drifted values observed in prod were registered in the canonical arrays. Original finding preserved below for context.

**Source:** Audit finding F-17 (`docs/audits/2026-05-22-full-audit.md`).

**Symptom:** `services/pipeline-events.js` exports canonical `STAGES`, `EVENT_TYPES`, and `DROP_REASONS` arrays (lines 18, 32, 33). `recordStage()` and the other write helpers do not validate the arguments they pass to SQLite against these enums. Any string value succeeds.

**How this surfaced 2026-05-25:** Prod 24h `pipeline_events.stage` distribution showed `MANUAL_REVIEW_DISMISSED` (3 events) which was not in the `STAGES` array. Call site at `services/holdReview.js:64` had been passing it for weeks; writes succeeded silently. Doc fix shipped (e165fa4 added it to the enum, d1b9432 mirrored in CODEMAP), but the root cause — no write-boundary validation — is still open.

**Risk:** Drift between source-of-truth enums and what call sites actually emit. Aggregate analytics on top drop causes get misleading because new freeform values dilute the closed-set assumption. Audit's recommendation for a closed `drop_reason` enum (F-17) only matters if it's enforced.

**Fix surface area:**
- Add validation in `recordStage()` / `recordEvent()` / `recordDrop()` at the top: if argument not in canonical array, log a warning + still write (don't fail closed — keep observability fire-and-forget per the file's stated contract at line 8-10).
- Or stricter: maintain a `pipeline_events_unknown` companion table for non-canonical writes, separate from the main stream.
- Add a unit test that imports all `recordStage` call sites and asserts each literal is in the enum.

**Why P2, not P1:** Doesn't cause data loss. Already-known event types continue to work; the gap is purely observability/integrity. The `MANUAL_REVIEW_DISMISSED` case has been silently working in prod; the audit catching it is the win, the enforcement is the hardening.

**Cross-references:**
- Commits: e165fa4 (source enum fix), d1b9432 (CODEMAP fix)
- Audit: `docs/audits/2026-05-22-full-audit.md` F-17

## SHIPPED — 2026-05-31

### DubClub split pipeline (LockedIn + GNP) — COMPLETE
- Webhook gate: `ALLOWED_WEBHOOK_IDS` set with LockedIn (`1510485995751997603`) + GNP (`1510019730906546277`). Was blocking all DubClub posts (`bot_not_whitelisted`).
- Bridge split (`zonetracker-dubclub` 27db0ed): `splitIntoPicks` filter splits independent-pick sheets into one webhook post per pick. Per-capper `splitIndependent` flag in config.json (LockedIn/GNP=true).
- Buffer bypass (main 34ea903): webhook posts in `DUBCLUB_SPLIT_CHANNEL_IDS` skip the 4s aggregation buffer (was re-merging the split posts back into one slip).
- GUARD 5 bypass (main ffddb09): bypass moved above GUARD 5 so bare totals ("Cubs Cardinals O8", "Spurs OKC O212.5") aren't dropped by looksLikePick's >=2 signal requirement.
- Verified: 9-leg MAG7 → 9 separate clean straights in #lockedin-slips, all totals included.

## KNOWN BUG — Priority 1 (new 2026-05-31)

### normalizeDescription injects wrong team for ambiguous cities
**Symptom**: "Baltimore Orioles +105" stored as "Baltimore Ravens Orioles +105". The bare city alias in data/mappings/teams.json maps to ONE team even when another team name already follows.
**Root cause**: teams.json has bare-city aliases that fire via `\bcity\b` word-boundary match. When the city's full "City Team" string isn't also an alias key, the bare city expands wrongly. Affects raw→normalized description only; raw_text (and channel display) stays clean.
**Ambiguous-city aliases to remove** (multi-team cities):
- line 38 SF 49ers: "san francisco"
- line 39 Dallas Cowboys: "dallas"
- line 40 Baltimore Ravens: "baltimore"
- line 42 Miami Dolphins: "miami"
- line 43 Detroit Lions: "detroit"
- line 45 NY Jets: "new york"
- line 49 LA Dodgers: "la"
- line 50 Houston Astros: "houston"
- line 51 Atlanta Braves: "atlanta"
- line 53 Boston Red Sox: "boston"
- line 54 Chicago Cubs: "chicago"
- (also check Philadelphia "philly", Kansas City "kansas city")
**Fix**: Remove bare ambiguous-city aliases. Each entry keeps non-ambiguous aliases (e.g. Ravens keeps "ravens"/"bal"/"baltimore ravens"). BUILD A TEST HARNESS FIRST: run normalizeDescription against ~30 real bet descriptions from the bets table, diff before/after, confirm only ambiguous cases change. This is shared normalization affecting every capper — do not hand-edit without the harness. Codex audit before deploy.

### ~~Odds API key 401 Unauthorized~~ — RESOLVED
✅ RESOLVED 2026-06-10 — free-tier quota reset June 1 restored auth (HTTP 200 verified from the container; COA audit §F.7). Same root cause as the 2026-05-14 entry above: quota exhaustion returned as 401, no key rotation was needed. The caching design (`odds_snapshots`) remains the pre-July to-do if usage repeats the burn rate.

## P1 follow-ups

### COA audit pass for `zonetracker-ocr` (was out of the 2026-06-10 audit scope)
The 2026-06-10 COA full audit (`docs/audits/2026-06-10-coa-full-audit.md`) pinned and
code-tracked **four** repos (discord/main, dashboard, dubclub, scraper) — it omitted
`zonetracker-ocr`, the fifth ZoneTracker repo, because the inventory it worked from didn't
list it. The service is live and public (RapidOCR FastAPI on the Surface Pro, `:11436`,
exposed via Tailscale Funnel `:8443`; called by the Fly bot's `services/localOcr.js`). See
the full inventory in `docs/SURFACE-PRO.md`.
**Action:** run a COA-style track pass on `r88510179-collab/zonetracker-ocr` — code,
docs (`README.md` + `CONTRACT.md`), prompts (if any), and resiliency (auth/`OCR_SERVICE_TOKEN`
handling, `413`/`503` paths, model-load health gate, timeouts, image-size cap, logging/PII).
Sibling note (resolved 2026-06-10): `ollama-proxy` on the same box is **now under version
control** — private repo `r88510179-collab/zonetracker-ollama-proxy`, box dir is a tracking
clone (secrets excluded: `ecosystem.config.js`/logs gitignored, `ecosystem.config.example.js`
+ README committed). See `docs/SURFACE-PRO.md` → ollama-proxy.

### detectSport: SF Giants data gap
`MLB_TEAMS` omits the Giants, so bare "Giants"/"SF Giants" resolves NFL. detectSport is nickname-only — needs a city-aware signal. Low frequency, but wrong sport poisons grading routing.

### normalizeDescription: player-index nickname over-match
Same class as the team-nickname guard (3d12196) but in the player index — e.g. "Judge" → Aaron Judge fires in prose. Fix: reuse `hasBetContext` on the player replacement path. Firing rate unmeasured.

### Install Codex CLI on the Mac
Codex CLI was absent all session; the audit step fell back to an independent sub-agent substitute. Install it so hot-path diffs get a real second-opinion pass.

### Read-only audit: historical description corruption
The bare-city (93cbe5e), abbrev (564a88a), and verb/nickname guard (3d12196) fixes only correct NEW inserts. Existing stored `description` rows still carry injected wrong teams ("the game Washington Wizards close", "Baltimore Ravens Orioles"). Read-only audit to quantify before deciding on a backfill.

### Link/VIP-gated pick recovery — INVESTIGATED + SHELVED (2026-05-29)
Discovery ran (prompts/relay-hold-link-recovery-discovery.md). Findings:
- **Full held-message text is NOT persisted.** messageHandler.js:1141 computes cleanText but stores only an 80-char slice in pipeline_events.payload.sample. 0 URLs survive the clip — the link-gated fraction is unmeasurable from the DB alone. Sizing it would require re-fetching every held message from Discord via messageUrl, OR adding a hold-side raw_text store first.
- **~45% of holds are TweetShift re-emit duplicates.** 214 raw holds/30d collapse to ~117 distinct (capper, sample) pairs. TweetShift re-fires on edit/media-attach. Real distinct universe ≈ 4 tweets/day across all four relay cappers (Dan/Cody/Harry/Gavin).
- **Ceiling is tiny and skewed toward paywalled.** Best case ≤4 picks/day, and Harry's share is visibly VIP-pitched — genuinely gated, not technically recoverable.

**Decision: SHELVED.** Poor ROI vs. post-P0 roadmap — requires persistence rework just to *measure*, with a ~4/day ceiling mostly paywalled. NO parser, NO expander, NO persistence change at this time.

**Cheap kill-check (manual, ~10 min):** open 5 of Dan's "Load here:" messages in Discord, see where the t.co link redirects (DubClub / Whop / free page) and whether it's gated. All paywalled → item is permanently dead. Some free → revisit, and the DubClub bridge is the likely lever, not a per-message expander.

## Hold-queue hygiene (2026-06-12)
- Dedupe holds per source message: relay edit/update path creates a second hold with a new ingest_id for the same messageUrl (observed: 2 Dan messages → 4 holds). Hold staging should upsert on source message id.
- GET /holds: expose recoverAttempts + lastRecoverStatus so the dashboard dismiss modal shows real history (flagged in zonetracker-dashboard#6).
