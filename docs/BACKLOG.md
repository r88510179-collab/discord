# ZoneTracker Backlog

## ✅ Shipped

### DubClub email → Discord bridge (2026-05-30)
Built as standalone service `zonetracker-dubclub` on Surface Pro (PM2), NOT in this repo.
Repo: github.com/r88510179-collab/zonetracker-dubclub (commit 21f81c1). Watches Gmail via IMAP
for DubClub "New plays from <Capper>!" emails, follows CTA link, Playwright-scrapes plays page,
posts to per-capper Discord webhook → ingested via existing messageHandler path.
Live cappers: GuessAndPrayBets (GNP), TeamLockTalk (LockedIn → #lockedin-slips).
See that repo's docs/CODEMAP.md for env vars, config.json shape, and gotchas.

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

**Root cause**: `shouldFallbackToGemma()` in `services/ai.js` only fires the no-legs trigger when `quick.type === 'bet'` or `quick.is_bet === true`. When the primary AI returns `{type: 'ignore'}` on an image-bearing slip, the gate is bypassed — Gemma never gets to retry. Confirmed: zero `vision_failures` rows for `cdn.discordapp.com` images since instrumentation.

**Anchor data point**: 1 of 6 historical HRB shares with identical boilerplate text DID produce a bet (2026-04-06). Same wrapper, same author, same channel — Vision AI is non-deterministic on this exact-shape input. Gemma fallback would give a second swing.

**SUPERSEDED 2026-05-14**: Fix A's Gemma fallback target permanently disabled via GEMMA_FALLBACK_DISABLED=true (v431, cf58b4c) — Surface Pro 5 hardware ceiling makes inference within Fly's 90s timeout infeasible (7-17min real inference times). Visibility for these drops now provided by v434 admin-log notice (`⚠️ Slip dropped` posted to ADMIN_LOG_CHANNEL_ID with View Original link). Full review-queue routing pending — see "Human-channel slip review routing" below. Original Fix A note preserved for audit:

**Fix A (shipped v405, commit `b1c2b19`, 2026-05-13)**: Extended `shouldFallbackToGemma()` with 4th param `verdictType`; fires on `quick.type === 'ignore'` when an image was supplied. Gate firing per `vision_failures` rows. Gemma fallback target was broken Apr 30 → May 14 due to proxy secret drift (rotated v413, 2026-05-14). End-to-end verification on a real DatDude HRB ingest staging a bet via Gemma is still pending — waiting on next HRB post in `#ig-dave-picks`. Open code concern: `ignoreVerdictWithImage` var lacks image-presence check in its own definition; safe only because `parseBetText` is the sole caller passing `verdictType`.

**Hard rule for any subsequent fix**: do NOT loosen `parsed.is_bet === false` check in `messageHandler.js:1098`. v335 (commit 289ce3b) tried `is_bet !== true` and dropped every Type 1 bet because `parseBetText` leaves `is_bet` undefined on successful returns. Rolled back as v337. See `skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md` ERRATA-3.

**Already shipped (this bug class, partial coverage)**:
- Fix B (slip-share exemption in `validateParsedBet`, commit `3aadc63`, 2026-05-07): `services/ai.js:1515` defines `slipExempt = slipShape || hasMedia`, gates the entity-mismatch check at `:1573` and the brand checks at `:1598` / `:1608`. Closed the 98-hits/7d `VALIDATOR_ENTITY_MISMATCH` bucket. Fixes the case where Vision DID extract a bet from the image but text-only validator rejected the entities.
- pipeline_events instrumentation (migrations 018 + 021): verified healthy 2026-05-13 — 1102 rows/24h, GRADE_* drop reasons stamping, zero synthetic `bet_%` ingest_ids, zero orphan-class drops.


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

### Unknown-sport straight voids (~46% of monthly voids)

May 2026 audit found 150 straight bets with sport=Unknown voided — single largest void bucket (46% of monthly voids vs 22 NBA parlay, 18 MLB parlay).

These bets reach the grader with no sport classification, so search backends have nothing to anchor on. Reclassifier never matched them. Likely root causes:

- City-name ambiguity (see existing BACKLOG item)
- Cross-sport keywords that the reclassifier punts to Unknown rather than infer
- Bet text genuinely too sparse to classify (e.g., "Smith ML")

Diagnostic: pull description for May Unknown/straight voids, classify manually, see what % are recoverable. If >50% are recoverable, build a v2 reclassifier with the city-name table + cross-sport disambiguation rules. If <20% recoverable, accept the void floor and route Unknown-sport straights to manual review queue instead of grading them.

Investigation query: `SELECT id, capper_id, description, raw_text, created_at FROM bets WHERE result = 'void' AND sport = 'Unknown' AND bet_type = 'straight' AND strftime('%Y-%m', created_at) = '2026-05' ORDER BY created_at DESC LIMIT 30;`

### ~~Capper ROI display bug~~ — RESOLVED 2026-04-13 (faa88208)
Cap removed by commit faa88208 ("remove ROI cap, harden bouncer"). The "+500%" pattern observed in the 2026-04-13 09:34 slip-receipts export was the cap behavior; export was taken ~4h before the fix landed at 13:36 EDT. `getCapperStats` and `getLeaderboard` now return real values; `services/database.js:515` retains a >500% log warning for monitoring but does not clamp the displayed value. Confirmed via git blame 2026-05-08.

### MLB backfill script using resolver
Batch script that reads bets with `grading_state='backoff'` and MLB player prop descriptions, resets `grading_state='ready'` on those that the resolver would now handle, lets the normal grader pick them up. Dry-run mode mandatory. Use `resolver_events` and the new `GRADE_*` drop counts as success metric.

### ~~Brave Search returning HTTP 402~~ — RESOLVED 2026-05-11 (2faaabd)
Brave free tier was burned in 6 days. Resolved through three landed changes: (1) circuit breaker on 402 (services/grading.js:1213, quotaCooldownMs=1h); (2) waterfall reorder to Bing → Brave → DDG → Serper (commit aa7b030, comment fix 2faaabd); (3) /admin search-backends counter (search_backend_calls table, shipped 5/8). Last 24h: Bing 173/173 calls, 100% OK. Brave/DDG/Serper at 0 calls because Bing never returned empty. Remaining open thread: explicit 402-aware messaging in fmtBackend (cosmetic, deferred). See "Brave quota probe" below for optional follow-up.

### Brave quota probe (optional, deferred)
Brave only gets called when Bing returns zero results, which over 173 calls happened zero times. Result: we never observe Brave quota resets. Add daily cron firing one fixed query at searchBrave() directly, logs to search_backend_calls. ~15 LOC. Low priority — Brave is a fallback, not load-bearing.

### Snapshot Brave health check — RESOLVED v344 (b9ca1f6)
Fixed in `fmtBackend`: per-backend state, last success, last failure with reason now shown. `lastError` preserved across successes on `recordBackendResult`. Original diagnosis (tracker doesn't count HTTP errors) was wrong — tracker did count them, formatter ignored them.

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


## 🚨 P1 — Investigate 98%-empty event_date (blocks bet idempotency migration)

Day 2 attempt 2 surfaced: 898 of 918 bets have empty event_date, 13 free-text (`Today`, `Game 6`, `9:10PM ET`, `4/6/26`, `May 03, 2026`), 7 ISO datetime. Slip extraction or `createBet` path isn't populating event_date reliably.

Fingerprint-composition idempotency migration cannot ship until this is fixed — current state would cause the supersede step to dedupe legitimately distinct bets across days, hiding hundreds of real bets behind a `superseded_by_id` chain.

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

### Odds API: 401 Unauthorized on both primary and backup keys
Live as of 2026-05-14 15:21 UTC. Every per-bet odds lookup fails 401 for baseball_mlb, icehockey_nhl (and likely all sports). War-room embeds still post but without live odds enrichment. Surfaced during v423 MAG7 verification. Fix: rotate Odds API keys, check billing/quota status on theoddsapi.com or whichever provider.

### v423 VERIFIED — DubClub MAG7 sheets ingest as per-sport straights
Smokke-posted test slip in #lockedin-slips at 15:20:49 UTC produced 7 separate war-room embeds, each tagged with correct per-leg sport (NHL, MLB, etc). SHEET vs PARLAY rule fires correctly. No HALLUCINATION BLOCKED. Vision AI also resolved OCR ambiguity (Bills+Sabres → Sabres NHL; Dolphins+Marlins → Marlins MLB). Closes the "LockedIn multi-section sheets skip NBA" issue class for sheet-shape inputs.

## 🚨 KNOWN ISSUES — Surfaced 2026-05-14, Deferred

### Cerebras llama3.1-8b retires 2026-05-27 (13 days)
Cerebras docs banner: "llama3.1-8b and qwen-3-235b-a22b-instruct-2507 will be deprecated on May 27, 2026." services/ai.js:44 defaults CEREBRAS_MODEL to llama3.1-8b. This is the PRIMARY tier in grader waterfall (940 successful calls / week per Cerebras CSV). MUST migrate before May 27 or grader primary dies.

Fix options: (a) set CEREBRAS_MODEL=gpt-oss-120b in Fly secrets (one-liner, easiest), or (b) consolidate waterfall — drop cerebras tier since it now offers same model as Groq, simplify to gpt-oss-120b on Groq → llama-3.1-8b-instant on Groq → ollama. Option (a) ships in 1 command. Option (b) is cleaner architecturally but requires a session to decide tier order and verify under load.

Recommended: ship (a) immediately as a fresh Fly secret set + restart, plan (b) for next architecture session.

### Gemma fallback returns empty responses (NOT a config bug)
Verified 2026-05-14: OLLAMA_URL IS set on Fly (https://tracker-surface-pro.tail65f8f0.ts.net), OLLAMA_PROXY_SECRET set (len=64), proxy returns 200 + gemma3:4b loaded via direct curl test. So function does NOT bail at services/ai.js:707. The empty `gemma_response` rows (23 in 7 days, all gemma_len=0) come from somewhere later in the call path. Hypotheses to investigate next session:
- /api/generate returning empty data.response on real images
- Circuit breaker tripping after first failure and silently skipping
- Image base64 too large for the request
- gemma3:4b actually returning NOT_A_SLIP boilerplate that gets normalized to empty
Add temporary debug logging around services/ai.js:741 (the data.response read) to see what Ollama actually returns on a real production slip.

### Odds API exhausted (the-odds-api.com)
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

### Wire Cerebras grader model to env var
`services/grading.js:1995` hardcodes the Cerebras model literal (`qwen-3-235b-a22b-instruct-2507` as of v445). The `CEREBRAS_MODEL` Fly secret exists but is unused at this call site, so model swaps require a code deploy. Either change the literal to `process.env.CEREBRAS_MODEL || 'qwen-3-235b-a22b-instruct-2507'` so swaps are `fly secrets set` + restart, or drop the unused secret to avoid confusion. Same pattern likely applies at `services/ai.js:44` — verify before touching. Low priority — current model works.

## Discovered 2026-05-19 (Phase 1 session)

### Bing scraper returns generic news (not just 402)
Memory #30. `services/grading.js:1369-1404` parses `class="b_algo"` which Microsoft changed. Returns HTTP 200 with MLB.com/ESPN homepage HTML, not game recaps. Phase 1 (commit 9a19ba6) mitigates for MLB/NBA/NHL. Soccer/golf/tennis/MMA still affected. Fix: defensive multi-selector parsing + generic-news detector that returns "no reliable evidence" → PENDING instead of forcing a bad parse.

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

## P2 — `recordStage()` does not enforce enum at write boundary

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
