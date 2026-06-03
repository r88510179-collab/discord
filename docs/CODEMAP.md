# ZoneTracker Codemap

Authoritative file/line map. Read this at the START of every session before doing any investigation.

When a session discovers a new location worth remembering, update this file in the same PR as the work.

## Conventions

- Line numbers are accurate as of commit `d76761d` (main, 2026-05-20). Mapped source files are byte-identical to the merged hold-review feature (#27).
- "L1132" means line 1132 in that file
- If a line number drifts more than ±20 lines from reality, refresh the section

## Schemas (PRAGMA-verified 2026-05-21)

Verified via `PRAGMA table_info(<table>)` against production `/data/bettracker.db`. Re-verify after any migration.

### `bets` — primary bet store

PK is `id` (TEXT, hex hash — **NOT** `bet_id`, common memory error).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | hex hash, never `bet_id` |
| capper_id | TEXT | FK → cappers.id |
| sport | TEXT NOT NULL | "Unknown" is a real value; ~46% of May voids |
| league | TEXT | |
| bet_type | TEXT NOT NULL | "straight", "parlay", "prop", etc |
| description | TEXT NOT NULL | newline-separated for parlays |
| odds | INTEGER | American odds |
| units | REAL | |
| result | TEXT | "pending" / "win" / "loss" / "push" / "void" |
| profit_units | REAL | signed: positive=win, negative=loss |
| grade | TEXT | "WIN" / "LOSS" / "VOID" / "PUSH" (uppercase) or NULL while pending |
| grade_reason | TEXT | human-readable explanation, includes `[retro-fix YYYY-MM-DD]` for manual fixes |
| event_date | TEXT | 98.4% null — NOT a void driver |
| graded_at | TEXT | ISO timestamp |
| source | TEXT | see §Source enum below |
| source_url | TEXT | Discord message URL — populated on most paths; audit pending |
| source_channel_id | TEXT | |
| source_message_id | TEXT | |
| fingerprint | TEXT | dedup key |
| raw_text | TEXT | original message text |
| created_at | TEXT | ISO timestamp |
| review_status | TEXT | see §Enums below |
| wager | REAL | dollar wager |
| payout | REAL | dollar payout if won |
| season | TEXT NOT NULL | |
| is_ladder | INTEGER | 0/1 |
| ladder_step | INTEGER | |
| slipfeed_message_id | TEXT | |
| source_tweet_id | TEXT | |
| source_tweet_handle | TEXT | |
| grading_source_url | TEXT | URL the grader used as evidence |
| grading_attempts | INTEGER | mig 016 atomic guard; >100 = pre-P0 storm |
| grading_last_attempt_at | TEXT | |
| grading_next_attempt_at | TEXT | reaper-driven |
| grading_last_failure_reason | TEXT | |
| grading_lock_until | TEXT | optimistic lock |
| grading_state | TEXT | "pending" / "graded" / "locked" — mig 016 atomic guard |
| drop_reason | TEXT | first-class column |
| drop_reason_set_at | INTEGER | epoch sec |
| grader_version | TEXT | mig 026 (Gate 2) — code-constant grading-logic version that produced the final grade |
| evidence_hash | TEXT | mig 026 (Gate 2) — sha256 of canonicalized grade evidence; idempotency key with grader_version |

### `pipeline_events`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| ingest_id | TEXT | groups all events for one Discord message |
| bet_id | TEXT | populated once a bet row exists |
| source_type | TEXT NOT NULL | "discord" / "tweet" / "manual" |
| source_ref | TEXT | original ref |
| stage | TEXT NOT NULL | see §Enums |
| event_type | TEXT NOT NULL | event variant within stage |
| drop_reason | TEXT | when stage="DROPPED" |
| payload | TEXT | JSON blob |
| created_at | INTEGER | **epoch sec, NOT ISO** — see DB quirks |

### `hold_review_decisions` (mig 025)

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| ingest_id | TEXT NOT NULL | links to pipeline_events |
| hold_payload | TEXT | original hold context |
| reparse_attempted | INTEGER NOT NULL | 0/1 |
| reparse_input_source | TEXT | "text" / "image" / "both" |
| reparse_input_text | TEXT | |
| reparse_output | TEXT | JSON of parser result |
| reparse_confidence | TEXT | confidence label |
| human_decision | TEXT NOT NULL | "release" / "dismiss" / "edit" |
| human_edits | TEXT | JSON of edits applied |
| source_label | TEXT | dismiss reason: "promo_sheet" / "recap_or_sweat" / etc |
| bet_id | TEXT | populated if released |
| reviewed_by | TEXT | Discord user ID |
| created_at | INTEGER NOT NULL | epoch sec |

### `parlay_legs_dedup_events` (mig 024)

`id INTEGER PK, bet_id TEXT NOT NULL, ingest_id TEXT, decision TEXT NOT NULL, original_text TEXT NOT NULL, canonical_key TEXT NOT NULL, matched_against_text TEXT, matched_against_key TEXT, reason TEXT, created_at INTEGER NOT NULL`

### `parlay_legs`

`id TEXT PK, bet_id TEXT, description TEXT NOT NULL, odds INTEGER, result TEXT, created_at TEXT, evidence TEXT, graded_at TEXT, sport TEXT`

### `grading_audit`

Every grader attempt logged. Cols: `bet_id, attempt_num, timestamp INTEGER, sport_in/out, reclassified, is_parlay, leg_index, leg_count, search_backend, search_query, search_hits, search_duration_ms, provider_used, raw_response, guards_passed, guards_failed, final_status, final_evidence`.

### `regrade_results`, `regrade_batches`, `bet_grade_history` (mig 022)

Reconciliation project. `bet_grade_history` archives old grades on regrade. `regrade_batches` tracks 25-bet export batches. `regrade_results` holds Claude+ChatGPT regrade outputs with `pile_flag` for review.

### Other tables

`bankrolls, bet_props, bot_health_log, cappers, daily_snapshots, processed_tweets, resolver_events (orphaned), scan_state, schema_migrations, search_backend_calls, settings, tracked_twitter, twitter_audit_log, user_bets, users, vision_failures`. Run `PRAGMA table_info(<name>)` before assuming structure for any of these.

## Enums (live-verified 2026-05-21)

**`bets.review_status`** (distinct values, with prod counts):
- `confirmed` (673)
- `needs_review` (269)
- `auto_void_unscoped_bet` (368)
- `auto_void_no_searchable_data` (169)
- `auto_void_no_data` (9)
- `discarded_as_recap` (new 2026-05-21, Cody recap fix)

**`bets.result`**: `pending`, `win`, `loss`, `push`, `void`

**`bets.grade`**: `WIN`, `LOSS`, `VOID`, `PUSH` (uppercase) or NULL while pending

**`bets.grading_state`** (mig 016): `pending`, `graded`, `locked`

**`bets.source`** (observed): `vision_slip`, `hold_review_script`, `manual_hold_release`, `untracked_win`. Set wherever `createBetWithLegs` is called.

**`pipeline_events.stage`**: `RECEIVED`, `AUTHORIZED`, `BUFFERED`, `EXTRACTED`, `PARSED`, `VALIDATED`, `STAGED`, `DROPPED`, `MANUAL_REVIEW_HOLD`, `MANUAL_REVIEW_DISMISSED`, `PURE_SLIP_SKIP_HOLD`, `GRADING_ENTER`, `GRADING_SEARCH`, `GRADING_AI`, `GRADING_GUARDS`, `GRADING_COMPLETE`, `GRADING_DROPPED`. Enum lives at `services/pipeline-events.js:18`. Note: `STAGE_ENTER` etc. listed here previously were `event_type` values, not stages — those are `STAGE_ENTER`, `STAGE_EXIT`, `DROP`, `ERROR` (line 32). `recordStage()` does not enforce the enum at the write boundary (see audit F-17).

**`hold_review_decisions.human_decision`**: `release`, `dismiss`, `edit`

**`parlay_legs_dedup_events.decision`**: `kept`, `dropped_duplicate`, `near_miss`

## Ingestion pipeline — entry to staging

### handlers/messageHandler.js
| What | Line(s) |
| --- | --- |
| `sendHoldReviewEmbed` function | 13 |
| Hold embed button row builders | 30–34 (customIds `hold:release:`, `hold:dismiss:`, View Original link) |
| `buildParsedPayload` | 43 |
| Message dedup guard `processedMessages` | 52 (Set decl), 767–769 (has/add/expire guard) |
| Buffer constants and `messageBuffer` | 66 (`BUFFER_DELAY_MS`), 67 (`messageBuffer` Map) |
| `bufferMessage` function start | 69 |
| `processAggregatedMessage` function start | 917 |
| War-room channel fetch | 667 (env L665, guard L666) |
| ADMIN_LOG send (path A) | 779 (STRICT_MODE gate L775) |
| RecapSlip auto-grade branch | 1081 (header L1079) |
| **is_bet=false branch** | 1128 |
| MANUAL_REVIEW_HOLD stageAll (is_bet=false) | 1132 |
| sendHoldReviewEmbed call (is_bet=false) | 1140 |
| PRE_FILTER_NO_BET_CONTENT drop (non-human) | 1153 |
| **ai_indeterminate branch** | 1173 |
| MANUAL_REVIEW_HOLD stageAll (ai_indeterminate) | 1177 |
| sendHoldReviewEmbed call (ai_indeterminate) | 1188 |
| Multi-image merge | 960 (loop), 995–1020 (merge) |
| ADMIN_LOG send (path B) | 1313 (guard L1311) |

**`raw_text` semantics — two ingest paths, inconsistent by history (NOT a bug):**
- Pure-slip / HRB path (`processAggregatedMessage`, L1288): `raw_text` = the scrubbed Discord message *body* (`cleanText`, defined L683). For HRB shares that body is share-card boilerplate (e.g. "Check out this bet I placed on Hard Rock Bet!"), **not** the Vision extraction.
- Vision extraction lands in `description` — intentional. The grader reads `description` only and never `raw_text` (enforced by the `buildGraderSearchQuery` doc-comment at `services/grading.js:~1287-1295` + `tests/grader-uses-description.test.js`), so the HRB `raw_text` boilerplate is purely cosmetic — do not "fix" it.
- `processSlipImage` (L562) differs: stores `ocrText || description` in `raw_text`. The two paths diverge by history, not design intent — recorded here so it is not mistaken for a bug.

**Hold rescue is messageUrl-based — the slip image is never rendered, `payload.imageUrl` is never read (do NOT "persist imageUrl"):**
- All three rescue surfaces key off the Discord **messageUrl**, not any image: the admin-log hold embed's "View Original" Link button (`sendHoldReviewEmbed` L13, `.setURL(messageUrl)` L33), the `holdReview.js` Release flow (`payload.messageUrl`, L174–213), and the `review-holds.js` CLI. None calls `setImage`/`setThumbnail`; none reads `payload.imageUrl`.
- `review-holds.js` re-fetches the live Discord message per walk (`channel.messages.fetch` from `payload.messageUrl`, L547–554) and reads attachments fresh (L80, L91) → always a current signed image url, so no stored snapshot is needed.
- `EXTRACTED.imageUrl` (single-image branch, L1009) is `imageUrl.slice(0, 120)` — a truncated, HMAC-stripped debug breadcrumb, NOT an openable link. The multi-image branch (L1014) stores no url at all. Treat neither as a usable image link; do not add imageUrl-persistence to the multi-image branch — no consumer reads it (closed; see BACKLOG.md).

### services/ai.js
| What | Line(s) |
| --- | --- |
| `parseBetText` | 909 |
| `parseBetSlipImage` | 1135 |
| `evaluateTweet` | 1335 |
| `validateParsedBet` | 1602 |
| LLM waterfall start | 241 (`callLLMResult` dispatch); `PROVIDERS` L18, `getProviders` L68, `callLLM` L333 |
| `slice(0, 250)` → bet_type-aware cap (v451) | 428 (`descCap = isParlay ? 2000 : 250`), in `normalizeBet` L421 |
| MAG7/sheet detector emit per-sport straights (v423) | 984 (prompt-level SHEET-vs-PARLAY rule in `GEMMA_SLIP_PROMPT` — model emits per-sport straights; no separate JS detector) |

### services/grading.js

> Line numbers refreshed 2026-06-03 (PR `phase1-grading-gates`). A ~145-line
> Phase-1 gates block was inserted near the top (L18–162), shifting everything
> below by ~+155. The gates: the LLM grades legs only; **code** owns aggregation
> (Gate 1), idempotency (Gate 2), and quote enforcement (Gate 3).
> Refreshed again 2026-06-03 (PR `gate3-shadow-mode`): the Gate 3 helper block
> grew by +64 lines (tri-state mode resolver + `applyGate3`), so everything
> below `validateEvidenceQuote` shifted by +64.

| What | Line(s) |
| --- | --- |
| **Gate 1** `reduceParlayResult` (pure parlay reducer — keystone; LOSS>PENDING>WIN) | 178 (fn); `normalizeLegStatus` 171 |
| **Gate 2** `GRADER_VERSION` / `computeEvidenceHash` / `decideFinalGradeWrite` | 20 / 25 / 45 |
| **Gate 3** quote-bound grading — tri-state `QUOTE_BOUND_GRADING` (`off`/`shadow`(default)/`enforce`); shadow logs `[GATE3 would-fire]` and leaves the grade, enforce forces PENDING (`UNVERIFIED_QUOTE`); unknown/legacy → shadow | `normalizeQuoteWhitespace` 76 (now folds curly quotes + en/em-dash); `validateEvidenceQuote` 89; `resolveGate3Mode` 115; `applyGate3` 129 |
| `looksLikePlayerProp` | 230 (fn); structured gate → `tryStructured` 2087 (call L2088) |
| `canFinalizeBet` | 501 |
| `scheduleRecheckAfterDenial` | 575 |
| `calcProfit` | 955 |
| `gradeFromCelebration` | 1232 |
| `buildGraderSearchQuery` (description-only; doc-comment above) | 1359 |
| `searchBing` (BROKEN — returns 200 OK with garbage HTML) | 1571 |
| `gradePropWithAI` (dispatch: parlay→gradeParlay, else gradeSingleBet) | 1705 |
| `isTrustedLossLeg` (Bug A Part 1, v438) | 1771 |
| `aggregateParlayLegResults` (now downgrades untrusted-LOSS→PENDING, then delegates precedence to Gate 1 reducer) | 1826 (fn); reducer call 1863; "Parlay LOSS — leg N" emit 1873 |
| `gradeParlay` | 1892 |
| `gradeSingleBet` | 1929; structured pre-check 2085; **Gate 3** quote check 2283 (`applyGate3` call 2290); grader waterfall 2166–2188 (groq-llama4-scout 2167 → cerebras-gpt-oss → groq-qwen → openrouter → groq-gpt-oss → mistral → ollama → groq-llama8b 2188) |
| `finalizeBetGrading` | 2421 (also exported as `gradeBet` ~L2543); **Gate 2** idempotency check 2433; atomic write stamps `grader_version`+`evidence_hash` via `gradeBetRecord` |
| `resolvePlayerProp` | REMOVED (v459) — replaced by `tryStructured()` from services/sportsdata, called at L2088 |

### services/sportsdata/ (Phase 1 structured grading, v459)
| File | Purpose |
| --- | --- |
| index.js | Router: dispatches a bet to the right sport adapter; runs BEFORE search+LLM and short-circuits the LLM when `resolved=true` |
| mlb.js | MLB Stats API adapter (`statsapi.mlb.com/api/v1`) — official, no auth |
| nhl.js | NHL Web API adapter (`api-web.nhle.com/v1`) — no auth |
| nba.js | ESPN NBA public API adapter (`site.api.espn.com`) — unofficial, no auth |

### services/holdReview.js
| What | Line(s) |
| --- | --- |
| `handleHoldInteraction` (button handler) | 21 |
| Release modal | 95 (`ModalBuilder`, customId `hold:releasemodal:`); `handleReleaseModal` L138 |
| Dismiss flow | 58 (`handleDismiss`); routed L34 |
| SELECT WHERE stage='MANUAL_REVIEW_HOLD' query | 44–45 (reads `pipeline_events.payload`) |
| `createBetWithLegs(source='manual_hold_release')` call | 185 (source field L194) |
| `postNewPick` call | 213 (import L13) |

### services/pipeline-events.js
| What | Line(s) |
| --- | --- |
| Stage enum | 18 (`STAGES`); `EVENT_TYPES` L29 |
| `recordStage` | 121 |
| `recordDrop` | 139 |
| `recordError` | 155 |
| `makeIngestId` | 185 |
| EXPECTED_STAGES for pipelineHealth | NOT in this file — services/pipelineHealth.js:31 |

### services/warRoom.js
| What | Line(s) |
| --- | --- |
| `sendStagingEmbed` | 26 |
| Edit modal capper lookup (v463 fix, commit 5efcdd8) | 617 (strict `cappers` lookup in `war_modal` submit; field read L605, reattribution L625) |

### services/database.js
| What | Line(s) |
| --- | --- |
| `getOrCreateCapper` | 304 |
| `createBetWithLegs` | 579 |
| `findPendingBetBySubject` | 928 |
| `gradeBet` | 597 (`gradeBetRecord`, exported as `gradeBet` L1077) |

### bot.js
| What | Line(s) |
| --- | --- |
| `handleHoldInteraction` import | 30 |
| Interaction handler routing | 135 (`InteractionCreate`); `hold:` routing L172 → `handleHoldInteraction` L174 |
| HUMAN_SUBMISSION_CHANNEL_IDS parsing | 256–258, 517 |
| RECEIPTS_CHANNEL_ID / SLIP_FEED_CHANNEL_ID fallback (recap channel) | 729 |

### commands/admin.js
| What | Line(s) |
| --- | --- |
| `/admin pipeline-trace` | 114 (def), 808 (handler) |
| `/admin pipeline-drops-24h` | 120 (def), 887 (handler) |
| `/admin snapshot` resolver panel | 100 (def), 541 (handler), 707–767 (resolver panel) |
| `/admin resolver-health` | 129 (def), 995 (handler) |
| `/admin dedup-stats-24h` | 144 (def), 922 (handler) |

### scripts/
| Script | Purpose |
| --- | --- |
| review-holds.js | Re-parse unresolved MANUAL_REVIEW_HOLD, prompt r/e/d/s/q, optional release |
| retro-parlay-loss.js | Bug A Part 2 retro-fix (already run, kept for reference) |
| regrade-export.js | Pull batches of 25 pending bets for parallel Claude/ChatGPT grading |
| test-dedup-normalization.js | Validates parlay leg dedup normalizer |
| backfill-hold-embeds.js | v447 hold-embed backfill (PR #29) |

## Migrations

| Mig | What it adds |
| --- | --- |
| 016 | Atomic grading state columns |
| 018 | pipeline_events (initial) |
| 021 | pipeline_events extensions |
| 022 | regrade_results, bet_grade_history, regrade_batches |
| 023 | search_backend_calls |
| 024 | parlay_legs_dedup_events |
| 025 | hold_review_decisions |
| 026 | bets.grader_version + bets.evidence_hash (Gate 2 idempotency) + idx_bets_grade_idem |

## Database — quirky things

- `pipeline_events.created_at` is INTEGER Unix epoch seconds, NOT ISO text. Filter with `created_at >= strftime('%s','now') - N`, NOT `datetime('now','-N seconds')` — type mismatch silently returns 0 rows.
- `pipeline_events.drop_reason` is its own column. No json_extract needed.
- Always run `PRAGMA table_info(<table>)` before time-windowed queries.
- DB lives at `/data/bettracker.db` on Fly. Local clone reads via `fly ssh console`.
- **Scripts in `/tmp` cannot `require('better-sqlite3')`** — `/tmp` has no node_modules. Always `cd /app` before running, or copy script under `/app/scripts/`.

## Env vars that gate behavior

| Var | Read by | What happens if unset |
| --- | --- | --- |
| ADMIN_LOG_CHANNEL_ID | sendHoldReviewEmbed, multiple admin notices | Hold embeds silently never post |
| HUMAN_SUBMISSION_CHANNEL_IDS | messageHandler hold branches | Human-channel slips fall through to PRE_FILTER drop |
| GEMMA_FALLBACK_DISABLED | Gemma vision fallback | (v431 sets true — Surface hardware ceiling) |
| AUTOGRADER_DISABLED | autograder cron | If true, no auto-grading runs |
| TWITTER_POLLER_DISABLED | Fly Twitter poller | Currently paused; Surface Playwright replaces |

## Channels — ingestion routing (verified 2026-05-21 via `fly ssh`)

ZoneTracker routes Discord messages through two env-var-gated channel allow-lists. The lists work together to control which channels are authorized for ingestion and which of those skip the `MANUAL_REVIEW_HOLD` staging step.

### Env vars

| Env var | What it does | Set on | Live count |
|---|---|---|---|
| `HUMAN_SUBMISSION_CHANNEL_IDS` | Authorizes a channel for human-posted bet ingestion. Messages from channels NOT in this list are dropped pre-pipeline. | Fly secret | 17 |
| `PURE_SLIP_CHANNEL_IDS` | Subset of `HUMAN_SUBMISSION_CHANNEL_IDS`. When a parser result returns `is_bet=false` or `ai_indeterminate`, channels in THIS list skip the `MANUAL_REVIEW_HOLD` staging and fall through to the existing `PRE_FILTER_NO_BET_CONTENT` / `PRE_FILTER_AI_EMPTY_RESULT` drop. | Fly secret | 13 |
| `ADMIN_LOG_CHANNEL_ID` | Channel where hold-review embeds and other admin notices post. | Fly secret | `1486825605105192960` (#admin-log) |

### Subset invariant

`PURE_SLIP_CHANNEL_IDS ⊂ HUMAN_SUBMISSION_CHANNEL_IDS`. A channel must be human-authorized first; the pure-slip flag is a refinement, not a separate authorization. Verify with:

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "const p=(process.env.PURE_SLIP_CHANNEL_IDS||\"\").split(\",\").map(s=>s.trim()).filter(Boolean); const h=(process.env.HUMAN_SUBMISSION_CHANNEL_IDS||\"\").split(\",\").map(s=>s.trim()).filter(Boolean); console.log(JSON.stringify({subsetHolds: p.every(id=>h.includes(id))}))"'
```

### Behavior matrix

| Channel in HUMAN | Channel in PURE_SLIP | Parser result | Outcome |
|---|---|---|---|
| Yes | Yes | Valid bets | Bets stage normally |
| Yes | Yes | `is_bet=false` or `ai_indeterminate` | Skip hold → emit `PURE_SLIP_SKIP_HOLD` trace → drop as existing `PRE_FILTER_*` |
| Yes | No | Valid bets | Bets stage normally |
| Yes | No | `is_bet=false` or `ai_indeterminate` | Stage `MANUAL_REVIEW_HOLD` for human review |
| No | n/a | n/a | Dropped pre-pipeline (channel not authorized) |

Gate code lives at `handlers/messageHandler.js` — search for `PURE_SLIP_CHANNEL_IDS` to find the two inline reads at the `is_bet=false` and `ai_indeterminate` branches.

### Pure-slip channels — bypass MANUAL_REVIEW_HOLD (13)

Cappers who post slip images, not text picks. Vision extraction (`parseBetSlipImage`) handles the bet; text-parser holds here are structurally unrescueable.

| Channel | ID | Capper |
|---|---|---|
| #ig-dave-picks | 1473347391284576469 | IgDave |
| #datdude-slips | 1355182920163262664 | DatDude |
| #lockedin-slips | 1473343783876821198 | LockedIn |
| #gamescript-picks | 1286934932769472646 | GameScript |
| #boogieman-slips | 1282742197460144202 | Boogieman |
| #gnp-slips | 1473343838587457626 | GNP |
| #gallery-picks | 1473345468716028044 | Gallery |
| #trent-slips | 1484572863439704246 | Trent |
| #degen-tail-slips | 1282707049276244029 | Degens |
| #mez-slips | 1473341245500690473 | Mez |
| #zooteid-slips | 1473341435351929097 | Zootied |
| #t-slips | 1473341563961606375 | T |
| #smokke-slips | 1473341333325217950 | Smokke |

Note: `-picks` suffix is misleading for ig-dave, gamescript, and gallery — IgDave has 8/8 lifetime bets with `source=vision_slip`, confirming these are functionally slip channels regardless of naming.

### Human-submission only — hold gated (4)

Twitter relay channels. Bet content arrives as text via a relay bot; text-parser holds here CAN be rescued because the bet is in the message text. Holding them lets a human review unparseable picks.

| Channel | ID | Capper |
|---|---|---|
| #_-_-_-_gambling-twitter-dan | 1284613965128925234 | Dan |
| #_-_-_gambling-twitter-cody | 1284613911055695893 | Cody |
| #_-_-_gambling-twitter-harry | 1284620792713318472 | Harry |
| #_-_-_gambling-twitter-gavin | 1284614717071032464 | Gavin |

Active known issue: parser drops real picks shaped as `<emoji> <category> / <player> <line> <market>` from these channels (e.g. `🏀 NBA Best Bet / 🟠 OG Anunoby O20.5 PRs`). See BACKLOG.md.

### Admin

| Channel | ID | Purpose |
|---|---|---|
| #admin-log | 1486825605105192960 | Hold-review embeds and admin notices (`ADMIN_LOG_CHANNEL_ID`) |

## Fly deploy invariants

- Auto-deploy from main is UNRELIABLE (verified 2026-05-18). ci.yml only runs check + tests. fly.toml has no `[deploy]`.
- Every deploy is manual: `fly deploy --local-only --yes --no-cache -a bettracker-discord-bot`
- `--no-cache` is MANDATORY every time — phantom deploys without it shipped stale COPY layers (v281, v289).
- `fly secrets set` produces "Staged" status until next deploy. **A staged secret is NOT live** — the running process still sees the old value. Verify with `fly ssh console -C "node -e 'console.log(process.env.X)'"` after deploy.

## Workflow rules — non-negotiable

1. Read this CODEMAP at the start of every session before grep'ing for known locations.
2. Verify shipped status via `git log` before proposing rework of any feature (memory drift is common).
3. DEPLOY_CHECKLIST.md applies for every non-trivial deploy. Step 2 (grep for call sites) catches half-shipped functions.
4. Run `PRAGMA table_info` on any table you query for the first time in a session.
5. Update this file in the same PR as any change that moves or adds the locations above.

## DubClub split bypass (handlers/messageHandler.js, 2026-05-31)

DubClub bridge webhooks post one independent pick per message into split channels. handleMessage has a DUBCLUB SPLIT BYPASS block placed ABOVE GUARD 5:
- Detects: `(message.webhookId || message.author?.bot)` AND channel in `DUBCLUB_SPLIT_CHANNEL_IDS` env CSV.
- Effect: routes the message straight to processAggregatedMessage as a single-message batch — skips BOTH the 4s aggregation buffer (would re-merge split posts) AND GUARD 5 looksLikePick (would drop bare totals like "Cubs Cardinals O8" that score <2 PICK_SIGNALS).
- Must stay above GUARD 5. Auth/bouncer guards (1-4) still run before it.
- Env: DUBCLUB_SPLIT_CHANNEL_IDS=1473343783876821198(LockedIn),1473343838587457626(GNP)
- Commits: 34ea903 (buffer bypass), ffddb09 (moved above GUARD 5).

Note: looksLikePick (PICK_SIGNALS, ~line 199) has no bare over/under total signal — "O8"/"O212.5" only match the half-point pattern, scoring <2. Latent bug for any non-DubClub total-only pick. Not fixed (DubClub bypasses the gate instead).
