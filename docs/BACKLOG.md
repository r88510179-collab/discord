# ZoneTracker Backlog

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

### DatDude #datdude-slips Hard Rock bet slips not staging to war-room

**Symptom**: DatDudeStill posts Hard Rock Bet shares in #datdude-slips. Bot receives message, extracts image attachment, calls Vision AI. But no bet appears in war-room. Same user posting same content in #ig-dave-picks works fine.

**Verified NOT the cause**:
- MessageHandler.ENTRY fires for both channels (author=datdudestill reaches bot)
- Both channels in HUMAN_SUBMISSION_CHANNEL_IDS
- Both channels in CAPPER_CHANNEL_MAP (1473347391284576469:IgDave, 1355182920163262664:DatDude)
- Neither in IGNORED_CHANNELS
- Image extraction succeeds: "Images Extracted: 1" for both
- Vision AI fires for both (5-sec buffer delay from 20:07:33 datdude → 20:07:38 vision call)
- resolveCapper() returns valid capper info for both (DatDude, IgDave)
- No channel-specific branching in processAggregatedMessage or bufferMessage

**Next debug steps when resumed**:
1. Add log line inside processAggregatedMessage right after "[DEBUG] AI Response:" showing channel name + bets.length
2. Add log line before any return/drop in the war-room staging path
3. Have DatDude post ONLY in #datdude-slips (no concurrent #ig-dave-picks post within 10s to rule out buffer collision)
4. Immediately grep logs for full trace from ENTRY → AI Response → staged/dropped
5. HRB-DIAG logging already live (commit 43b59e3) — keep it

**Hypothesis**: Post-Vision-AI bet creation path has a silent drop for second channel in HUMAN_SUBMISSION_CHANNEL_IDS, OR buffer key collision drops one when both post near-simultaneously.

### Retry storm: ai_pending_legs denial bypasses attempt cap

**Symptom**: Parlay bets with pending legs hit `canFinalizeBet()` P0 gate, which calls `scheduleRecheckAfterDenial(ai_pending_legs_N, 30)`. That schedule flips `grading_state` back to `'ready'`, not `'backoff'`. Grader picks it up 30s later, same pending legs, same denial, same 30s requeue. Normal bets cap at ~20 attempts via state machine escalation to backoff, but this path bypasses that cap. Observed 162-163 `grading_attempts` on 2 NBA parlays over 6-7 days.

**Observed bets (voided manually Apr 21)**:
- `8260a66122cc1bd80731f02049071cbf` — 163 attempts, Portland/Phoenix play-in parlay
- `5c963d41f9ee262d27e5e6e2c8878adc` — 162 attempts, Paul George / Franz Wagner parlay

Both created ~Apr 14-15, `event_date = null`, never resolved.

**Root cause (refined Apr 21 after data check)**:
`scheduleRecheckAfterDenial(ai_pending_legs_N, 30)` flips `grading_state='ready'` unconditionally. The normal attempt-cap logic (which forces `backoff` at ~20 attempts for most bets) doesn't apply here. Effectively a backdoor around the state machine.

The original hypothesis that `event_date = NULL` caused the loop was wrong. Null `event_date` is ubiquitous — 480 of ~580 all-time bets have it, most of which grade successfully (141 win, 98 loss, 145 void). The 2 voided bets (Apr 14-15 NBA parlays) were exceptional specifically because of this retry path, not their `event_date` state.

**Next debug steps when resumed**:
1. `grep -n "scheduleRecheckAfterDenial" services/grading.js` — find the call sites and review the retry escalation path
2. Fix: cap `ai_pending_legs_N` recheck scheduling at N attempts (match the cap that applies to other failure modes), escalate to `backoff` after cap hit
3. Consider a separate `grading_denial_count` column or use existing `grading_attempts` against a new threshold
4. Note: null `event_date` itself is NOT a bug — it's the ingest default when source (Twitter, Discord text) doesn't have a clear game date. Ingest audit not needed for this issue.

**Interim mitigation**: Stage 1.2 classifier now captures `ai_pending_legs_N` drops via `GRADE_AI_PENDING_NO_DATA` or `GRADE_PENDING_UNCLASSIFIED` depending on the evidence string. If you see a bet over 50 attempts in `/admin snapshot`, query its `drop_reason` in the `bets` table.

## Stage 2 — BetService (next deploy)

Scope: follow-on to Stage 1 BetService that shipped v297. Each item is independently deployable.

### Idempotency keys
Prevent double-writes when the grader retries a bet through the pipeline. Add idempotency key column to `bets` or a separate `grading_attempts` table; every `recordDrop` call passes a key derived from `(bet_id, grading_attempt, stage)`. Duplicates are rejected at insert time.

### Reaper (cron)
Converts long-stuck bets into explicit `GRADE_BACKOFF_EXHAUSTED` drops. Runs hourly. Reads bets with `grading_state='backoff'` and `grading_attempts > N` and `event_date` older than 48h — marks them with the enum, stops retry loop. Cleans up the "stuck in backoff forever" class of parlays seen pre-v293.

### Parent-bet resolution for parlay leg ids
Current `<parent>-leg<N>` ids don't stamp `drop_reason` on the parent bet row — only on `pipeline_events`. Reaper (or a separate resolver) should aggregate leg-level drops into a parent-level drop reason so admin snapshot doesn't report parents as "pending, no reason given."

## Grading Enhancements

### Oracle: CapperLedger as grading source
Parse @capperledger recap tweets to grade pending bets without AI calls. Add `grading_source` column. Fuzzy-match bet descriptions. Threshold >85% confidence. Fallback to AI after 24h.

### City-name ambiguity in reclassifier
The SPORT_TEAM_KEYWORDS list only contains team nicknames (Thunder, Lakers, Capitals), not city names (Oklahoma City, Los Angeles, Washington). When a bet uses the city name alone ("Oklahoma City to win"), the reclassifier fails to match it against the correct sport. This is especially problematic for cities with multiple teams across sports (LA has 8+ pro teams). Fix: add city aliases to each sport's keyword list, OR implement a disambiguation step that checks all sports and flags truly ambiguous cities as "requires-context" rather than forcing a reclassification.

### Capper ROI display bug
`/admin snapshot` shows Top 3 cappers all at "+500%" ROI (rbssportsplays, dangambleai, Dan). Suspiciously uniform cap or calculation error. Investigate ROI formula in snapshot handler and `/health quick` — likely capping at 500% or dividing by wrong denominator. Should show actual ROI per capper.

### Snapshot polish: bet type breakdown
The Resolver block in `/admin` snapshot shows "Top bet types: straight 2" but only surfaces resolved bet types, not the full call breakdown. Fix: include all outcomes (resolved, unresolved, errored) in the bet-type GROUP BY. 5-line fix in `commands/admin.js` snapshot handler.

### MLB backfill script using resolver
Batch script that reads bets with `grading_state='backoff'` and MLB player prop descriptions, resets `grading_state='ready'` on those that the resolver would now handle, lets the normal grader pick them up. Dry-run mode mandatory. Use `resolver_events` and the new `GRADE_*` drop counts as success metric.

### Brave Search returning HTTP 402 — free tier exhausted or API key issue
Grader logs show 100% HTTP 402 responses from Brave backend. DDG circuit breaker is open. Only Bing fallback is returning results. Need to: (1) verify BRAVE_API_KEY is still valid, (2) check Brave dashboard for usage/billing status, (3) circuit-breaker Brave on 402 like we do for DDG timeouts, (4) add 402 detection to Brave health check so /admin snapshot reflects real state.

### Snapshot Brave health check is wrong
/admin snapshot reports "Brave: healthy" while actual calls return HTTP 402. The circuit tracker only detects timeouts, not HTTP error codes. Fix: track 4xx/5xx responses as circuit failures. Show real last-success timestamp per backend.

### Action-keyword validation (P2 follow-up to sport consistency)
Current validateLegSportConsistency() only checks team keywords. Player-only props with cross-sport action words (e.g. "Matt Turner Goalie Saves" in a LoL parlay, "Emmet Sheehan Pitching" in a Soccer parlay) can evade detection if no team names appear. Add a second validator that checks action/prop keywords per sport: soccer=goalie saves/corners/yellow card, mlb=pitching/strikeouts/RBIs, nba=rebounds/assists/PRAs, nhl=saves/shots on goal, etc. Action-keyword mismatch against declared parlay sport = reject.

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

### DubClub email → Discord bridge
Enable per-capper emails in DubClub. Gmail filters → Discord webhook per capper → ingestion pipeline. Bouncer update for email format. Capper attribution via webhook source.

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

### Edit modal: parlay ↔ singles conversion
Let user split a parlay into singles or merge singles into a parlay from the war room embed

### Fly.toml RESOLVER_VERSION — consider moving to secret
Currently hardcoded `RESOLVER_VERSION = 'v10'` in `fly.toml [env]`. Not sensitive, but moving to a fly secret makes version bumps easier (no PR cycle). Tradeoff: secret rotation requires a restart.

## Foundation

### Grading audit table
Full decision trail per grading attempt. Admin command to dump trail for any bet ID.

### State snapshot admin command
`/admin snapshot` → dumps full bot state in one message

### CI reliability gate
GitHub Actions workflow that blocks PRs on failing `npm run check` + `npm run test:reliability`

### Deploy verification protocol
`docs/DEPLOY_CHECKLIST.md` required for every non-trivial deploy

### README comprehensive documentation
Architecture, env vars, admin commands, scraper setup, troubleshooting, guard chain reference

### Resolver telemetry — shipped v292 (commit 940f3d2)
Migration 019 added `resolver_events` table. `/admin snapshot` renders a Resolver block with 24h outcome counts, latency, error breakdown, and last successful resolve timestamp. End-to-end verified via forced `resolvePlayerProp` call on Apr 20.

### BetService + drop telemetry (Stage 1 + 1.2) — shipped v297 (commit b3413c5)
Migrations 020/021. New `services/bets.js` with grading-side write contract (`sourceType='grading'`, nullable `ingest_id`). `earlyReturn` wrapper in `services/grading.js` auto-records PENDING drops, classifier matches evidence prefixes to 11 `GRADE_*` drop reasons. Explicit enums at high-volume sites (`GRADE_TOO_RECENT`, `GRADE_NO_SEARCH_HITS`). Telemetry queryable via `pipeline_events` with `source_type='grading'`.

Verified in production Apr 21: 20 grading rows in ~45 min. Distribution: `GRADE_NO_SEARCH_HITS` 50%, `GRADE_TOO_RECENT` 40%, `GRADE_AI_PENDING_NO_DATA` 10%. Zero `GRADE_PENDING_UNCLASSIFIED` — classifier regexes have coverage for all PENDING evidence strings seen in production. Stage 2 (reaper + parent-bet resolution for parlay legs) still pending.

### Snapshot polish: bet type breakdown (all outcomes) — shipped v298 (commit 56228e1)
`/admin snapshot` Resolver block previously showed only resolved bet types. Now shows full breakdown of all call types (resolved + unresolved + errored). Label updated to "Bet types (all calls):". 2-line fix in `commands/admin.js`.

## Surface Pro

### Scraper (building now)
Target 8 handles without TweetShift coverage

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

### Code Tab prompt template library
Reusable prompt templates in ~/Documents/discord/.code-prompts/:
- audit-only.md — "read DB / read code / report findings, no changes"
- single-file-fix.md — "modify one rule, ship via DEPLOY_CHECKLIST"
- multi-file-refactor.md — "signature change + N call sites + verification"
- migration-backfill.md — "schema change + data migration + safety budget"

Each is a fill-in-the-blank template. We've been writing these from scratch — saves 10-15min per Code session. Build next time we have low-pressure time.

### Vision extraction failure on dense slip-share images — wire Gemma 3:4b as fallback
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

## April 16 session learnings

### Gemini + Brave quota dependencies are single points of failure
Both APIs on free tier, both exhausted. When either dies the pipeline degrades sharply. Options:
- Pay for Gemini (Paid tier ~$19/mo for useful scale) and/or Brave ($5/mo Pro)
- Build local AI fallbacks on Surface Pro (Gemma for Vision, llama3.2 or larger for grading - see Option 3 below)
- Accept degraded capacity on free tier and tune state machine to handle it

### Option 3: Full local AI fallback chain (weekend project)
Replace external AI dependencies with Surface Pro Ollama:

1. Gemma 3:4b for Vision intake (already proven Apr 15) - trigger on Gemini 429/quota or placeholder text, route via Tailscale Funnel + OLLAMA_PROXY_SECRET, output two-stage (Gemma extract then Cerebras parse). Fixtures: 8 saved slip images in test-fixtures/vision/.

2. Larger local model for grading (e.g. llama3.1:8b or qwen2.5:7b) - current grading waterfall is groq-llama8b to groq-kimi to ollama-llama3.2-3b. Issue: 3b too small for grading quality. Upgrade: 7-8b on Surface Pro. Requires verifying Surface Pro RAM can handle concurrent Gemma 4b + llama 8b (5+8=13GB, Surface has ~16GB).

3. State machine tuning - currently treats all PENDING as retryable failures. Need: if AI verdict is PENDING due to "no data found", don't retry endlessly. Better: ship auto-void-after-N-PENDINGs guard.

### ESPN integration observations (v282 today)
- Works for ML/spread/total on MLB/NBA/NHL completed games
- Date fallback (UTC date + previous ET day) handles late-night bets correctly
- Covers ~30-40% of bet volume
- Doesn't help with: player props, parlays with props, tennis, golf, SGPs
- Remaining 60-70% still depends on AI + search

### Unscoped-bet auto-void guard (v283)
- Added SUPPORTED_SPORTS whitelist + isSupportedSport() helper
- Fires before AI and ESPN, voids bets with sport=Unknown/N/A/null/unsupported
- 35 pending bets flagged on first run (promo captions, whatnot spam, injury tweets)
- Prevents AI hallucinations like "MLB Wednesday picks -> WIN"

### Today's emergency actions
- Auto-voided 9 bets with >5 attempts + >48h age (some had real slips Vision failed to extract - see Gemma fixtures)
- Force-readied 100+ bets across 2 cycles to recover from backoff lock
- Deployed v280 (ESPN), v281 (broken from stale worktree), v282 (date fallback), v283 (unscoped-bet guard)
- Bot stabilized at ~7 grades/hour via ESPN only

### Known drifts
- Bouncer still lets promo/junk through (whatnot.com, BOOKIT BREAKS, etc.) - v283 catches at grader, but real fix is bouncer
- Some bets have malformed sport values like "NCAAB/College Baseball" - parser issue upstream
