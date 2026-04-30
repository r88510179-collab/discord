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

### Oracle: CapperLedger as grading source
Parse @capperledger recap tweets to grade pending bets without AI calls. Add `grading_source` column. Fuzzy-match bet descriptions. Threshold >85% confidence. Fallback to AI after 24h.

### City-name ambiguity in reclassifier
The SPORT_TEAM_KEYWORDS list only contains team nicknames (Thunder, Lakers, Capitals), not city names (Oklahoma City, Los Angeles, Washington). When a bet uses the city name alone ("Oklahoma City to win"), the reclassifier fails to match it against the correct sport. This is especially problematic for cities with multiple teams across sports (LA has 8+ pro teams). Fix: add city aliases to each sport's keyword list, OR implement a disambiguation step that checks all sports and flags truly ambiguous cities as "requires-context" rather than forcing a reclassification.

### Capper ROI display bug
`/admin snapshot` shows Top 3 cappers all at "+500%" ROI (rbssportsplays, dangambleai, Dan). Suspiciously uniform cap or calculation error. Investigate ROI formula in snapshot handler and `/health quick` — likely capping at 500% or dividing by wrong denominator. Should show actual ROI per capper.

### MLB backfill script using resolver
Batch script that reads bets with `grading_state='backoff'` and MLB player prop descriptions, resets `grading_state='ready'` on those that the resolver would now handle, lets the normal grader pick them up. Dry-run mode mandatory. Use `resolver_events` and the new `GRADE_*` drop counts as success metric.

### Brave Search returning HTTP 402 — free tier exhausted or API key issue
Grader logs show 100% HTTP 402 responses from Brave backend. DDG circuit breaker is open. Only Bing fallback is returning results. Need to: (1) verify BRAVE_API_KEY is still valid, (2) check Brave dashboard for usage/billing status, (3) circuit-breaker Brave on 402 like we do for DDG timeouts, (4) add 402 detection to Brave health check so /admin snapshot reflects real state.

### Snapshot Brave health check — RESOLVED v344 (b9ca1f6)
Fixed in `fmtBackend`: per-backend state, last success, last failure with reason now shown. `lastError` preserved across successes on `recordBackendResult`. Original diagnosis (tracker doesn't count HTTP errors) was wrong — tracker did count them, formatter ignored them.

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

### Grading audit table
Full decision trail per grading attempt. Admin command to dump trail for any bet ID.

### State snapshot admin command
`/admin snapshot` → dumps full bot state in one message

### CI reliability gate
GitHub Actions workflow that blocks PRs on failing `npm run check` + `npm run test:reliability`

### Test suite: migration-validation.js fails — pre-existing
Codex audit Apr 22 ran `npm run test:reliability` and found it fails on `tests/migration-validation.js` with an assertion expecting `006_add_season_to_bets.sql` ordering/name mismatch. Not caused by recent work — predates Stage 1. Investigate before next major deploy that needs CI gating.

### Deploy verification protocol
`docs/DEPLOY_CHECKLIST.md` required for every non-trivial deploy

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

## Pipeline Observability

### Parser PARSED event: `isBet` / `betCount` field mismatch
In a v340 pipeline trace (msg=1499408189240774686, #datdude-slips, 2026-04-30), the PARSED payload showed `isBet:false` alongside `betCount:1` and `type:"bet"` — three fields telling different stories about the same parse. The bet went on to STAGED successfully so it is not blocking, but the inconsistency suggests stale flag wiring at the emit site. Audit wherever `pipeline_events.PARSED` is emitted and either drop the redundant flag or derive `isBet` from `betCount > 0` so the two cannot disagree. Risk if left: future filters that key off `isBet` could drop legitimate bets that the rest of the pipeline considers real.

### Validator team-name false positive on multi-sport teams
The leg sport validator drops legitimate bets when team names exist in multiple sports. Reproduced 2026-04-30 14:34 UTC, msg=1499418573469388810 in #datdude-slips: capper posted "Giants ML" in an MLB parlay; validator flagged "Leg contains NFL team \"giants\" but parlay is MLB" and dropped the bet. Multi-sport team names affected include Giants (NFL/MLB), Cardinals (NFL/MLB), Rangers (MLB/NHL), Panthers (NFL/NHL), Jets (NFL/NHL), Kings (NBA/NHL). Likely fix: invert the check — instead of "is this team in any non-declared-sport keyword list?", ask "is this team in the declared-sport keyword list?" and only fire mismatch on no. Caught by pipeline_events as DROPPED_VALIDATOR_SPORT_MISMATCH (1 in last 24h before the Giants case, so real but rare). Pairs with the existing "City-name ambiguity in reclassifier" entry — same class of bug, team-name version.

### Pre-existing test failures on main
Three test files fail on `main` independent of recent changes (surfaced 2026-04-30 during validator and parser fixes): `tests/migration-validation.js` (assertion mismatch on `006_add_season_*.sql` filenames), `tests/twitter-pipeline-validation.js` (multi-pick mapping), and `tests/message-handler.integration.js` (mock omits `evaluateTweet` from `services/ai.js` export). Not blocking anything currently, but blocks the CI reliability gate from being meaningful. Triage all three — likely either fix the assertions/mocks or delete the dead tests.

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

### Capper ROI showing 2498.5% after manual Scoot override

After flipping Scoot Henderson bet `ada01c0f9dbefb16a5b8a2444f3c819f` from WIN to LOSS via direct UPDATE, capper Dan (dangambleai) shows ROI=2498.5% (1W-1L) at next bot startup. Manual override likely didn't touch the running unit math the way `finalizeBetGrading` would. Pairs with existing "Capper ROI display bug" entry — same root cause likely (ROI calc divides by something nonsensical). Investigate ROI formula and figure out the canonical way to do manual grade overrides without breaking unit math. P2.

### G7 — Player-prop threshold verification (future grader hardening)

The new G6 (player_not_in_evidence, v357) catches wrong-player-entirely hallucinations. It does NOT verify the player's actual stat line meets the bet's threshold. Example: bet "Elly De La Cruz 2+ Hits+Runs+RBI", evidence "Elly De La Cruz homered and drove in four runs" — G6 passes correctly (player is named, threshold actually met). But same evidence on bet "Elly De La Cruz 6+ Hits+Runs+RBI" would also pass G6 even though 5 < 6 fails. To truly catch threshold hallucinations, need a guard that extracts numbers from evidence and compares to bet threshold. Bigger fix, requires NLP for stat-line extraction. P2 — add to grader hardening track behind G6.

### Inconsistent grader dispatch — MLB props sometimes use StatsAPI, sometimes AI

Same parlay (bet `8ff7d273`, 2026-04-30 21:30): legs for Paul Skenes, Christopher Sanchez, Yordan Alvarez, Freddy Peralta, Bobby Witt Jr. all `[grade] resolved via StatsAPI`. Leg for Elly De La Cruz fell through to AI search ("Elly De La Cruz MLB final score..."). Same sport (MLB), same ingest path, similar prop shapes — should all hit StatsAPI. Possible causes: player-name matching against StatsAPI roster (apostrophes, accents), StatsAPI rate limit fallback, or game-not-final timing. Investigation P2; current behavior isn't broken (AI fallback works), just inefficient and less confident.

