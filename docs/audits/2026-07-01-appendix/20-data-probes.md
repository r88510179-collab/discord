# Live data probes (DP) — 2026-07-01 audit appendix

Probes executed 2026-07-02 ~12:40–13:30 UTC against the live Fly volume (`bettracker-discord-bot`, read-only better-sqlite3 runner via `skills/zonetracker-regrade/scripts/run-fly-sql.sh`). Code citations verified at worktree HEAD `19ff594` (`/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`). Runtime was mid-churn (v756–758); pending-count snapshots drifted 250 → 246 → 243 across the probe window (live grading), so cross-probe totals differ by a few rows.

Live flag state (granted echo command, verbatim): `QUOTE_BOUND_GRADING=enforce, DATE_BOUND_GRADING=enforce, EVENT_AWARE_RECHECK=shadow, EVENT_DATE_SLATE=shadow, PRE_FILTER_MODE=shadow, SOCCER_GRADER_MODE=enforce, SOCCER_PROPS_MODE=enforce, OCR_FIRST_MODE=shadow, LINK_READER_MODE=shadow, AUTOGRADER_DISABLED=false, GEMMA_FALLBACK_DISABLED=true, TWITTER_POLLER_DISABLED=true, CAN_FINALIZE_ENFORCE=true, GRADING_STATE_MACHINE_ENABLED=true, STRICT_MODE=true`.

## Findings

### DP-01 [P0] [confidence: high] 7-day sweeper coined 60 evidence-free LOSS grades in 30d — 100% on NULL-event_date bets, 22 in adapter-covered sports
- Where: services/grading.js:1691 (`SWEEP_DAYS = 7`), :1908 (`gradeBet(bet.id, 'loss', …, 'Auto-swept: pending >7 days…')`)
- What / Why it matters: The sweeper writes a terminal **LOSS** (grade `F`, bankroll debited) for any non-prop bet pending >7d — a grade with, by definition, zero evidence. `SELECT count(*) … WHERE grade_reason LIKE 'Auto-swept%' AND graded_at >= datetime('now','-30 days')` → **60** (first 2026-06-02, last 2026-07-01). Sport split: Tennis 37, **Soccer 16, MLB 3, NBA 2, UCL 1**, UFC 1 — 21+ in sports with deterministic adapters that were in enforce (`SOCCER_GRADER_MODE=enforce`) at sweep time. **All 60 had `event_date IS NULL`** (`sum(event_date IS NULL)=60 of 60`), i.e. the same NULL that blocks the event-date-first adapters (memory: force-grade 0/23 on NULL event_date) also blocked grading, then the sweeper converted "ungradeable" into "lost". Samples swept 2026-07-01: `Japan ML (-165)`, `Spain -2.5 (-110)` (×2 near-duplicates), `Cristiano Ronaldo Goal`, `Havertz SOT` — mid-World-Cup soccer picks whose true results are knowable; singular "Goal"/"SOT" evade the plural-only `PROP_KEYWORDS` exemption (grading.js:1266), so props the DNP policy would VOID get swept to LOSS. BACKLOG:201/205-206 explicitly leans on "the untouched 7-day sweeper is the backstop" for adapter-exempt no-data bets — the data shows that backstop is a wrong-grade generator, the exact class the prime directive forbids ("worse than pending or void").
- Evidence: probe 2 outputs above; grading.js:1720–1726 (`evaluateSweep` age + prop checks); event-pending sweep guard at :1740 requires `eventAwareRecheckMode() === 'enforce'` — inactive (live flag = `shadow`) and moot anyway for NULL event_date.
- Proposed fix: sweep to **VOID** (or a `manual_review_swept` park) instead of LOSS, at least for adapter-covered sports and NULL-event_date bets; keep LOSS only where a graded-final event exists. (Effort S — one literal + policy sign-off)
- Backlog: extends BACKLOG:201-206 (Build-1d "sweeper backstop" scope fence) + BACKLOG:226 (enforce-flip collision). Sweep-result policy itself: NEW.

### DP-02 [P1] [confidence: high] event_date is still NULL on 83% of bets created in the last 3 days (95% over 30d) — the single upstream blocker feeding DP-01
- Where: bets.event_date (write path services/eventDate.js via database.js `createBet`; ingest #154, write-back #156)
- What / Why it matters: Created last 3d: 114 NULL / 23 ISO (83% NULL). 3–7d: 161/8 (95%). 7–30d: 868/49 (95%). Current pending: 230 NULL / 21 ISO (92%). So #154 (ingest EVENT_DATE) + #156 (grader write-back) have moved the needle only from ~5% → ~17% populated on the newest cohort. Every date-keyed defense (event-date-first adapters, Gate 4 anchor quality, EVENT_DATE_SLATE, EVENT_AWARE deferral + its sweep guard) is inert for the NULL majority; DP-01's 60/60 NULL correlation is the measurable cost.
- Evidence: probe 8/8b outputs above (GLOB `[0-9][0-9][0-9][0-9]-…` split). One pending bet carries `event_date=2024-07-07T23:30:00.000Z` on a 2026-06-18 WNBA bet (bad year, parked in `manual_review_unmodeled_sport`).
- Proposed fix: measure #154's extraction hit-rate per channel (Gemma vs parseBetText) and close the gap at ingest; a guarded backfill for pending rows (BACKLOG's Phase-3 diagnosis: bulk `date(created_at)` is INERT — needs the grader-resolved date instead). (Effort M)
- Backlog: existing event_date arc (BACKLOG:56-57, memory event_date diagnosis / #154 / #156)

### DP-03 [P2] [confidence: high] Search redundancy has collapsed to Bing alone: serper 100% failing, ddg 100% parse_empty, brave quota-degraded
- Where: search_backend_calls (recordBackendCall, services/grading.js); waterfall Bing→Brave→DDG→Serper
- What / Why it matters: last 14d histogram: **bing** 3712 ok / 495 generic_news / 1 timeout; **brave** 450 ok / 79 circuit_open / 62 http_402; **ddg** 91 parse_empty / 24 circuit_open / **0 ok**; **serper** 115 http_4xx / **0 ok** (every single call fails — dead key or plan). The LLM grading path has exactly one healthy evidence source. If Bing's markup drifts again (BACKLOG:699 history), the whole search tier goes dark → mass GRADE_AI_PENDING_NO_DATA → 7-day sweep LOSSes (DP-01) for every non-adapter sport. The S2 honesty layer is working (statuses are truthful) but nobody is acting on them.
- Evidence: probe 9b output above.
- Proposed fix: fix/remove the serper key (it burns a call per waterfall exhaust), investigate ddg parse_empty (parser rot), decide brave paid tier; add an operator alert when any backend hits 100% failure over 7d. (Effort S–M)
- Backlog: BACKLOG:640 (search source-path arc, "weakest link"), BACKLOG:892 (single points of failure)

### DP-04 [P2] [confidence: high] Human queues are now the slowest pipeline stage: 187/246 pending bets parked needs_review, 226 open holds, median hold decision 4.3 days
- Where: bets.review_status; pipeline_events MANUAL_REVIEW_HOLD vs RELEASED/DISMISSED (keying per routes/admin.js:182-196); hold_review_decisions
- What / Why it matters: Pending split: needs_review **187** (15 <1d, 59 1-3d, **108 3-7d**, 2 >7d) vs confirmed 55. Open holds (no RELEASED/DISMISSED after the hold, per ingest_id): **226** — 111 <7d, **113 aged 7-30d**, 2 >30d. Decision latency on the 327 decided holds: median **102.6h**, mean 207.8h; decisions split 249 dismissed / 68 recovered / 3 released_with_edits / 7 skipped. Grader-hidden bets and unreviewed holds re-enter grading ~4–9 days after game time, exactly when search evidence goes stale — feeding the DP-01 sweep and the no-data pile. The 76% dismissal rate also quantifies the pre-filter case (probe 7e: only 43 shadow would-drops since 06-24, so PRE_FILTER enforce would trim little of this queue).
- Evidence: probes 1c/1d/6/6b–6f outputs above.
- Proposed fix: operator dashboard alarm on `needs_review age > 48h` and `open holds > N`; consider auto-dismiss for holds >30d. (Effort S)
- Backlog: NEW (stale needs_review was an open item in the 2026-06-16 weekend audit — recurs)

### DP-05 [P2] [confidence: med] EVENT_AWARE_RECHECK still shadow; the two "size the flip" reads BACKLOG asked for now exist and show a small defer volume
- Where: BACKLOG.md:226-227 (blocked enforce flip); services/grading.js:1740 (sweep guard requires enforce)
- What / Why it matters: Live flag = `shadow` (echo above), consistent with CODEMAP:572/BACKLOG (no doc drift). Shadow telemetry began 2026-06-18 (v691): **364** `event_aware_shadow` rows, all within 14d — **52 would_defer / 312 would_window** — against a grading-attempt baseline of 96–955/day (avg ~380, probe 7d). So enforce would skip only ~4 claims/day: the RPM-burn upside is modest, but the *sweep guard* (`event_pending` skip) only activates under enforce, and it is the one mechanism that would have protected future-dated bets from DP-01-style sweeps. The flip stays blocked on the documented `MAX_DEFER_MS(7d)=SWEEP_CUTOFF(7d)` collision; with DP-02 unfixed, the guard would protect few bets anyway (NULL event_date → no defer).
- Evidence: probes 7/7c/7d outputs above.
- Proposed fix: resolve the 7d/7d collision (drop MAX_DEFER_MS to ~5d) and flip enforce *after* DP-02 raises event_date coverage; treat the 52/312 split as the pre-flip measurement BACKLOG:227 required. (Effort S code + ops)
- Backlog: BACKLOG:226-227 (existing)

### DP-06 [P3] [confidence: high] Provider-ladder comment contradicts code order; a 39%-hallucination model remains configured as last resort (unused in 30d)
- Where: services/grading.js:3366-3367 (comment "cerebras 3.5% → groq-qwen → …"), :3370-3393 (code pushes `groq-llama4-scout` FIRST; `groq-llama8b` "39%" still last)
- What / Why it matters: The comment says the chain is "ordered by hallucination rate (lowest first)" starting at cerebras, but the code's first provider is groq-llama4-scout (not in the comment's list at all). 30d audit data: groq-llama4-scout 7147 attempts/270 finalized, cerebras-gpt-oss 1172/58, groq-qwen 81/3, groq-gpt-oss 7/0; mistral/openrouter/ollama/llama8b **zero rows** — so today the tail is dormant, but the 39%-hallucination llama8b remains one outage away from grading real bets. Also: memory's "grader caps max_tokens=200" is stale — code says `max_tokens: 1000` (grading.js:3453), and cerebras `gpt-oss-120b` (:3373) is finalizing grades fine at that cap.
- Evidence: probe 9 output above; file reads at HEAD.
- Proposed fix: fix the comment; consider removing llama8b from the ladder or gating it behind manual-review-only. (Effort S)
- Backlog: NEW

### DP-07 [P3] [confidence: med] /data hygiene: 58MB WAL equals main-DB size; stray zero-byte bets.db
- Where: Fly volume `/data/` (granted `ls -lh` command)
- What / Why it matters: `bettracker.db` 58M, `bettracker.db-wal` **58M** (Jul 2 13:01) — a WAL as large as the database suggests checkpointing is being starved (long-lived readers or missing `wal_checkpoint`), doubling disk footprint and slowing reads; plus a 0-byte `/data/bets.db` (May 12) from some earlier misconfiguration. No data-loss risk (WAL is durable), but on a 115M volume growth is unbounded.
- Evidence: command output above (`total 115M; -rw-r--r-- … 58M … bettracker.db; … 58M … bettracker.db-wal; … 0 … bets.db`).
- Proposed fix: periodic `PRAGMA wal_checkpoint(TRUNCATE)` in a maintenance cron; delete the stray file. (Effort S)
- Backlog: NEW

## Probe log (condensed: intent → key SQL → result → read)

- **P0 schema**: table list (26 tables — `resolver_events` gone, confirming mig 030); one-call column map via `pragma_table_info` join (verbatim above); index list — **mig 031 `idx_pipeline_events_event_type_created` present**; `schema_migrations`: 001→031 all applied, 031 at 2026-07-02 12:41 (today's deploy), **dup row `006_add_season_to_bets.sql` present in DB but file absent at HEAD — inert-present exactly as #160 designed**.
- **P1 pending**: age buckets `<1d:33, 1-3d:76, 3-7d:121, 7-30d:14, >30d:6` (n=250 at snapshot). Oldest: 2026-04-15 MLB multi-HR parlay (needs_review). >7d unswept = 14 confirmed backoff (12 parlay/3 straight — PROP_KEYWORDS-exempt player-prop text) + 1 quarantined + 3 unmodeled-parked + 2 needs_review; `active_exempt=0` (Tier-C grace expired 06-30).
- **P2 sweeps**: 60 LOSS in 30d (marker `grade_reason LIKE 'Auto-swept%'`), 100% NULL event_date → DP-01.
- **P3 grade sources 30d (non-PENDING)**: Soccer `espn_soccer` 1108 vs LLM 213; MLB `espn` 341 + `mlb_statsapi` 334 vs LLM 39; NBA espn/espn_nba 80 vs LLM 30; NHL espn 61 vs LLM 8; Tennis/UFC/MMA/NFL/NCAAW LLM-only. Deterministic adapters ≈85% of finalizations.
- **P4 flips 60d**: `bet_grade_history` = **1 row** (2026-06-25, #150 override by OWNER, reason "leg2 graded vs wrong-date 6/23 game; real 6/24 … Under 9.5 hit" — a live-caught date-binding wrong grade, the class Gate 4 targets). `OVERRIDE:` bets = 1; `[retro-fix]` bets = 4 (May, pre-#150).
- **P5 drops 14d**: GRADE_AI_PENDING_NO_DATA 3632, BOUNCER_REJECTED 2738, GRADE_TOO_RECENT 1050, GUARD5_INSUFFICIENT_SIGNALS 434, PRE_FILTER_NO_BET_CONTENT 355, GRADE_PENDING_UNCLASSIFIED 312, GRADE_NO_SEARCH_HITS 116, VISION_RESULT_RECAP 103, GRADE_BACKOFF_EXHAUSTED 39, GRADE_POST_GUARD_REJECTED 31, VISION_UNTRACKED_WIN 23, DUPLICATE_REPOST 17, VALIDATOR_ENTITY_MISMATCH 16, GRADE_MANUAL_REVIEW_UNMODELED 8, GRADE_AUTOVOID_UNSCOPED 8, VALIDATOR_SPORT_MISMATCH 7, VISION_EXTRACTION_FAILED 3, GRADE_AI_NO_PROVIDERS 1. All registered reasons; no null-reason DROP rows.
- **P6 holds**: 226 open (keyed hold-without-later-RELEASED/DISMISSED per ingest_id, mirroring routes/admin.js:189-196); decisions 249/68/3/7; median 102.6h, mean 207.8h (`hold_review_decisions.created_at` is epoch SECONDS — verified range 1.779–1.782e9) → DP-04.
- **P7 enforce-flip reads**: event_aware_shadow 364 (52 defer/312 window, all since 06-18); attempts/day 96–955; PRE_FILTER shadow 43 would-drops since 06-24 (recap 28 / promo 14 / sweat 1).
- **P8 event_date**: pending 230 NULL / 21 ISO / 0 other; created-window splits → DP-02. (mig 029 held: zero non-ISO garbage anywhere.)
- **P9 waterfall**: attempts vs finalized per provider (DP-06); `provider_used IS NULL` on 136 attempts, 0 finalized (pre-provider exits, e.g. no-search-hits); backend histogram → DP-03.
- **P10 quarantine**: 2 rows only — `7b04366b` (void, 22 attempts, 1-leg-data parlay) and `047d0458` (pending World-Cup Pulisic parlay, 20 attempts, legs 1-2 WIN / leg 3 unresolved — candidate for /grade override rather than rot).
- Global result distribution: void 1678 / win 655 / loss 610 / pending 243 / push 2 — voids are 53% of all terminal grades (historical no-data-void + cleanup legacy; context for the leaderboard's denominator).

## Looked good
- Migrations coherent: 030 applied (table really dropped), 031 applied + index physically present; dup-006 row inert exactly as #160 documented.
- Timestamp conventions in CODEMAP verified true live: pipeline_events SECONDS, grading_audit/search_backend_calls MILLIS, bets ISO TEXT.
- Grade-override machinery (#150): single well-formed `bet_grade_history` row; `OVERRIDE:` marker matches gradeOverride.js:50; no orphan history rows.
- No unregistered drop_reasons in 14d; F17 vision terminal-drop instrumentation visibly emitting (103/23/3).
- Adapter dominance where it matters: espn_soccer/espn/espn_nba rows finalize at 100% of their attempts; SOCCER match+props both enforce, matching memory.
- Flag state matches docs (BACKLOG:227, CODEMAP:572 say shadow; prod is shadow) — no doc-vs-prod drift on EVENT_AWARE_RECHECK.
- Quarantine tiny (2), no retry storms: max attempts seen 22; daily cap (10k) never approached (peak 955/day).

## UNVERIFIED / open questions
- Actual game outcomes of the 60 swept LOSSes (e.g. `Japan ML`, `Spain -2.5`): not verifiable from the DB and web verification is out of this track's scope — DP-01's P0 is mechanism-based (evidence-free terminal grades), per-bet wrongness UNVERIFIED. Recommend a zonetracker-regrade batch over the 60.
- Whether the running image (v756-758) contains #154/#156 for the full 3-day window used in DP-02's "17% populated" read — deploy timing vs bet creation times not reconstructable from the DB alone.
- `TWITTER_POLLER_DISABLED=true`: intended steady-state (scraper-repo replacement?) — no repo doc read in this track asserts the expected value.
- WAL checkpoint starvation cause (DP-07): inferred from size alone; no `PRAGMA wal_checkpoint` probe was run (write-adjacent, declined).
- The two near-duplicate `Spain -2.5 (-110)` bets (created 60s apart, both swept): possibly distinct cappers/messages — dedup behavior not investigated (adjacent track).
