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
| sport | TEXT NOT NULL | "Unknown" is a real value; ~46% of May voids. **Casing canonicalized at write** via `canonicalizeSport()` in `createBet` (`database.js`) + the war-room edit (`warRoom.js`) — see §Enums |
| league | TEXT | |
| bet_type | TEXT NOT NULL | "straight", "parlay", "prop", etc |
| description | TEXT NOT NULL | newline-separated for parlays |
| odds | INTEGER | American odds |
| units | REAL | |
| result | TEXT | "pending" / "win" / "loss" / "push" / "void" |
| profit_units | REAL | signed: positive=win, negative=loss |
| grade | TEXT | "WIN" / "LOSS" / "VOID" / "PUSH" (uppercase) or NULL while pending |
| grade_reason | TEXT | human-readable explanation, includes `[retro-fix YYYY-MM-DD]` for manual fixes |
| event_date | TEXT | mostly null; not a void driver. **Write-gated** by `normalizeEventDateForStorage` (`services/eventDate.js`, called in `createBet` at `database.js:369`) → stored as NULL or a parseable datetime only, never time-only/free-text. Mig **029** nulled legacy unparseable rows. **§9 grader write-back (self-heal):** a SECOND write path — when a deterministic adapter resolves a bet to a real game during grading, `writeBackResolvedEventDate` (`services/grading.js`) fills a still-NULL `event_date` from the matched game's authoritative date, through the SAME `normalizeEventDateForStorage` guard, idempotent via `UPDATE … WHERE id=? AND event_date IS NULL` (NULL-only, never clobbers). Read-side: `grading.js` GUARD 3 falls back to `created_at` when a stored value resolves >0.25h ahead of now (marker `grade.event_date_skew_fallback`, `:2893`) |
| graded_at | TEXT | ISO timestamp, **UTC** (`datetime('now')`) — compare against deploy time in UTC before theorizing a code path; ET confusion makes a pre-deploy casualty look like a live bug |
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
| grading_state | TEXT | mig 016 atomic guard; live values are `done`/`backoff`/`quarantined`/`ready`/`graded` — see §Enums |
| drop_reason | TEXT | first-class column |
| drop_reason_set_at | INTEGER | epoch sec |
| grader_version | TEXT | mig 026 (Gate 2) — code-constant grading-logic version that produced the final grade |
| evidence_hash | TEXT | mig 026 (Gate 2) — sha256 of canonicalized grade evidence; idempotency key with grader_version |
| sweep_exempt_until | TEXT | mig 028 (Phase 2b-2) — self-expiring sweeper-grace marker. `datetime('now','+3 days')` stamped by TWO writers: `recoverHold` (recovery moment) and `approveBet` (approval moment — review-queue dwell can exceed SWEEP_DAYS). NULL only for bets that were never recovered nor war-room-approved. While set + future, the 7-Day Sweeper leaves the bet pending instead of auto-LOSS. See §7-Day Sweeper + recovery grace |

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

Every grader attempt logged. Cols: `bet_id, attempt_num, timestamp INTEGER, sport_in/out, reclassified, is_parlay, leg_index, leg_count, search_backend, search_query, search_hits, search_duration_ms, provider_used, raw_response, guards_passed, guards_failed, final_status, final_evidence`. Created via `CREATE TABLE IF NOT EXISTS` in `services/database.js:97` (NOT a numbered migration). `timestamp` is epoch **MILLIS** (`Date.now()`) — window filters use `timestamp >= (unixepoch()-N)*1000` (see the daily cap at `grading.js:~1178`), not `datetime('now',…)`. `guards_passed`/`guards_failed` are JSON-array TEXT. **B0 (2026-06-04):** Gate-3 would-fire events ride `guards_failed` as a `GATE3_WOULD_FIRE|mode=|claimed=|prop=|reason=` token (`SELECT … WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'`); `guards_failed` is display-only (`commands/admin.js:439`) and never gates grading. **Sport casing (2026-06-15):** `sport_in`/`sport_out` are run through `canonicalizeSport()` at the single persist point `writeGradingAudit` (`grading.js`). Root fork (now neutralized): the grade path reassigns `bet.sport` from `reclassifySport()` (`ai.js`), whose `SPORT_TEAM_MAP`-key return is **UPPERCASE** ("SOCCER"), so a reclassified soccer pick was written `sport_out="SOCCER"` while un-reclassified picks kept ingestion's Title-Case "Soccer" — both daily. `reclassified` is computed upstream from raw values and is unaffected. See §Enums.

### `regrade_results`, `regrade_batches`, `bet_grade_history` (mig 022)

Reconciliation project. `bet_grade_history` archives old grades on regrade. `regrade_batches` tracks 25-bet export batches. `regrade_results` holds Claude+ChatGPT regrade outputs with `pile_flag` for review.

### Other tables

`bankrolls, bet_props, bot_health_log, cappers, daily_snapshots, processed_tweets, resolver_events (orphaned), scan_state, schema_migrations, scraper_handles (mig 027 — documented under §scraper_handles management), search_backend_calls, settings, tracked_twitter, twitter_audit_log, user_bets, users, vision_failures`. Run `PRAGMA table_info(<name>)` before assuming structure for any of these.

## Enums (live-verified 2026-05-21)

**`bets.review_status`** (distinct values, with prod counts):
- `confirmed` (673)
- `needs_review` (269)
- `auto_void_unscoped_bet` (368)
- `auto_void_no_searchable_data` (169)
- `auto_void_no_data` (9)
- `discarded_as_recap` (new 2026-05-21, Cody recap fix)
- `manual_review_unmodeled_sport` (new 2026-06-16) — terminal **non-void** state set by `gradePropWithAI` (`services/grading.js`) when the declared sport names a REAL intentionally-unmodeled league (KBO/KHL/NPB — `declaresAnyUnmodeledLeague`, ANY part of a compound). The supported-sport gate would otherwise auto-void it to a silent (often FALSE) result; instead the bet is parked for a human: `grading_state='done'` (grader won't re-pick), **`result` stays `pending`** (NO grade/profit written), and it is sweeper-safe — `getPendingBets` (the autograder + 7-day sweeper's only source) excludes it in BOTH selector paths via `GRADER_HIDDEN_REVIEW_STATUSES` (`services/database.js`). Emits `drop_reason='GRADE_MANUAL_REVIEW_UNMODELED'`. Null/Unknown/garbage sports STILL `auto_void_unscoped_bet` (the divert predicate returns false for placeholders + labels whose only part carries a modeled code like "MLB Wednesday picks"). Re-grade path: `/admin revert-by-id` → Edit sport → approve. Dashboard surface + KBO team data are follow-ups.

**`bets.result`**: `pending`, `win`, `loss`, `push`, `void`

**`bets.grade`**: `WIN`, `LOSS`, `VOID`, `PUSH` (uppercase) or NULL while pending

**`bets.grading_state`** (live-verified 2026-06-10): `done`, `backoff`, `quarantined`
(attempts ≥ 20, terminal — no auto-exit), `ready`, `graded`. The mig-016 doc values
`pending`/`locked` no longer occur.

**`bets.source`** (live-verified 2026-06-10, by volume): `twitter_vision`, `vision_slip`,
`twitter_text`, `discord`, `twitter` (legacy), `untracked_win`, `hold_review_script`,
`twitter_mobile` (legacy), `manual_hold_release`. Set wherever `createBetWithLegs` is called.

**Sport vocabulary + casing** (`bets.sport`, `grading_audit.sport_in`/`sport_out`) — canonical casing convention: **acronym leagues UPPERCASE** (`MLB`, `NBA`, `NHL`, `NFL`, `NCAAB/F/M/W`, `MLS`, `EPL`, `UCL`, `UEL`, `F1`, `NASCAR`, `UFC`, `MMA`) and **word-sports / proper-noun leagues Title-Case** (`Soccer`, `Tennis`, `Golf`, `Boxing`, `La Liga`, `Serie A`, `Bundesliga`, `Ligue 1`, `World Cup`, `Copa America`, `Champions League`, `Europa League`). The single source of truth is **`canonicalizeSport(sport)`** in **`services/sportNormalize.js`** (`CANONICAL_SPORT_BY_KEY` map; case-insensitive lookup, **unknown/compound/`Unknown` input passes through UNCHANGED**, null/empty safe) — imported by `grading.js` (`writeGradingAudit`), `database.js` (`createBet`), `warRoom.js` (edit), and `scripts/backfill-sport-casing.js`. **Hard constraint:** the dispatch acronyms `MLB`/`NBA`/`NHL`/`NFL` MUST stay uppercase (adapter dispatch + `SPORT_MAP`/`SUPPORTED_SPORTS` lookups key on the uppercase form). It is a normalize **map**, never a blanket up/down-case.

**`pipeline_events.stage`**: `RECEIVED`, `AUTHORIZED`, `BUFFERED`, `EXTRACTED`, `PARSED`, `VALIDATED`, `STAGED`, `DROPPED`, `MANUAL_REVIEW_HOLD`, `MANUAL_REVIEW_DISMISSED`, `MANUAL_REVIEW_RELEASED`, `PURE_SLIP_SKIP_HOLD`, `OCR_FIRST`, `RECOVERY_ATTEMPT_FAILED`, `GRADING_ENTER`, `GRADING_SEARCH`, `GRADING_AI`, `GRADING_GUARDS`, `GRADING_COMPLETE`, `GRADING_DROPPED`. Enum lives at `services/pipeline-events.js:18`. **`RECOVERY_ATTEMPT_FAILED`** (added 2026-06-12): one row per hold-recovery attempt that burned vision+OCR but yielded no bet (`validator_drop` / `no_bet_found`, incl. extract throw); `COUNT(*)` per `ingest_id` is `recoverHold`'s retry-cap counter (`RECOVERY_RETRY_CAP`=5, `services/holdReview.js`) — at the cap, un-forced recovery refuses with `recovery_exhausted` (HTTP 429) **before** the Discord fetch, so an exhausted hold costs nothing per poll; API body `{force:true}` is the operator override. Trace-only, NOT a drop (the hold stays open); absent from `pipelineHealth.EXPECTED_STAGES` like the other markers. Note: `STAGE_ENTER` etc. listed here previously were `event_type` values, not stages — those are `STAGE_ENTER`, `STAGE_EXIT`, `DROP`, `ERROR` (`EVENT_TYPES`, line 34). Write-boundary enum validation shipped as #49: `warnUnknownEnums` (`services/pipeline-events.js:142`, called at the single write boundary L169) warn-only logs non-canonical values and still writes (fire-and-forget contract preserved; closes audit F-17).

**`pipeline_events.drop_reason`**: closed source-of-truth list is `DROP_REASONS` at `services/pipeline-events.js:43` (not enumerated here — read it there; the warn-only tripwire above flags any unregistered value). There is no separate constants module — `services/database.js` is NOT the enum home. New values must be added to that array (and CODEMAP §Enums) before a call site emits them. **`GUARD5_INSUFFICIENT_SIGNALS`** (added 2026-06-11): GUARD 5's pre-buffer signal heuristic dropped a message (`looksLikePick` <2 signals, no celebration, no images). Deliberately distinct from `PRE_FILTER_NO_BET_CONTENT` so "a real bare total was discarded by the heuristic" is queryable apart from genuine non-bet text. Only fires OUTSIDE DubClub-split channels — those bypass GUARD 5 for both webhook and human authors (incident 2026-06-11). **`VISION_RESULT_RECAP` / `VISION_UNTRACKED_WIN` / `VISION_TICKET_RECAP`** (added 2026-06-16, audit F17; registered `services/pipeline-events.js:61` / `:62` / `:63`, F17 block-comment header `:53-60`): the relay-image vision path (`handlers/messageHandler.js` `processAggregatedMessage`) classified a parse as `type:'result'` / `type:'untracked_win'` / `ticket_status:winner|loser` and `return`ed after routing to auto-grade / War-Room embed / recap-grade matching **without recording any terminal event** — 65 relay-image ingests vanished after `EXTRACTED` with zero bets and no DROP. Each branch now records the matching terminal DROP (logged before the side-effect) via the local `dropAll` closure (`handlers/messageHandler.js:995`): `VISION_RESULT_RECAP` `:1125` (before `autoGradeBet`), `VISION_UNTRACKED_WIN` `:1136` (before the War-Room `sendUntrackedWinEmbed`), `VISION_TICKET_RECAP` `:1188` (before the recap-grade matching loop). Note: only THREE new reasons — `VISION_UNTRACKED_WIN` is NOT suffixed `_RECAP`. These are NOT extraction failures — vision succeeded; the content was just not a new trackable bet — so they are deliberately distinct from `VISION_EXTRACTION_FAILED` (mirrors `twitter-handler.js`, which already dropped the analogous vision-result/untracked_win case). The narrow `is_bet===true && bets:[]` fall-through (only way past the is_bet=false + indeterminate guards with an empty bets array) now drops as `PRE_FILTER_AI_EMPTY_RESULT` with `filter:'ai_is_bet_true_no_bets'`. Instrumentation-only — no extraction/retry/buffer behavior changed. **`GRADE_AUTOVOID_UNSCOPED`** (added 2026-06-16, audit B7 follow-up; registered `services/pipeline-events.js:81`): the terminal unsupported-sport auto-void in `gradePropWithAI` (`services/grading.js`, the sole writer of `review_status='auto_void_unscoped_bet'`) returns an `AUTO_VOIDED` sentinel that `runAutoGrade`'s if/else does not match, so the void finalized with NO `pipeline_events` and NO `grading_audit` — an empty trail that made stale pre-#110 World-Cup voids look like a phantom "separate sweep". The branch now `recordDrop`s this reason (`bets.recordDrop` call at `services/grading.js:2528`, `dropReason` literal `:2531`), gated inside `if (voided)` so it fires only when a row was actually voided (`voided = info.changes > 0`), making each unsupported-sport void queryable and DISTINCT from the no-data void (`review_status='auto_void_no_searchable_data'`, no drop emitted — sibling gap, see §Grading) and the retry-cap void (`GRADE_BACKOFF_EXHAUSTED`). The canonicalize fix itself was #110 (`canonicalizeSportForGrading` at the gate); this only closes the logging hole. **`GRADE_MANUAL_REVIEW_UNMODELED`** (added 2026-06-16): the same supported-sport gate now DIVERTS a bet to manual review (`review_status='manual_review_unmodeled_sport'`, see §Enums) instead of auto-voiding when the declared sport names a REAL intentionally-unmodeled league (KBO/KHL/NPB — `declaresAnyUnmodeledLeague`, `services/normalization.js`, ANY part of a compound). Emitted only when a row was actually parked (idempotent). DISTINCT from `GRADE_AUTOVOID_UNSCOPED` because NO grade/profit is written and `result` stays `pending` — the bet awaits a human, not a void. Null/Unknown/garbage sports still emit `GRADE_AUTOVOID_UNSCOPED`.

**Grading failure-reason strings** (the `evidence` prefix on a forced-PENDING grade, NOT `pipeline_events.drop_reason` values — both classify to `GRADE_PENDING_UNCLASSIFIED` via `gradeSingleBet`'s `earlyReturn` prefix map, like every other gate's forced-PENDING):
- **`UNVERIFIED_QUOTE`** — Gate 3 (`QUOTE_BOUND_GRADING=enforce`): the model's `evidence_quote` is not a verbatim substring of the evidence. Marker `GATE3_WOULD_FIRE` on `guards_failed`.
- **`OFF_DATE_EVIDENCE`** (added 2026-06-12, `gate4-off-date-reject`) — Gate 4 (`DATE_BOUND_GRADING=enforce`): the quote-bearing evidence record's date(s) all fall outside `[anchor−tol, anchor+tol]`. Forced-PENDING evidence: `OFF_DATE_EVIDENCE: evidence dated <dates> outside <anchor>±<tol>d — forced PENDING (model claimed <STATUS>)`. Shadow/enforce both stamp `GATE4_WOULD_FIRE\|…\|reason=OFF_DATE_EVIDENCE` on `guards_failed` (zero extra rows). Pass markers `GATE4:date_ok` / `GATE4:no_date_signal` ride `guards_passed`.

**`hold_review_decisions.human_decision`**: `release`, `dismiss`, `edit`

**`parlay_legs_dedup_events.decision`**: `kept`, `dropped_duplicate`, `near_miss`

**`search_backend_calls.status`** (one row per backend attempt; written by `recordBackendCall`, `services/grading.js:1651`): `ok`, `parse_empty` (#74 — 0 usable hits, all backends), `generic_news` (#74 — Bing-only, parsed-but-irrelevant), `circuit_open` (skipped, gated backend), `timeout`, `error`, plus HTTP buckets from `bucketHttpStatus(res.status)` (e.g. `402`/`4xx`/`5xx`). `parse_empty`/`generic_news` are the M-3 honesty additions — see the search-arc S2 entry in BACKLOG.

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
| `getImageAttachments` — collects slip images; tags `origin` (`'attachment'` = real `message.attachments[]`/forwarded snapshot upload; `'embed'` = share-card/link-preview thumbnail incl. `message.embeds[].image`/`.thumbnail`). Exported. | 413 |
| `SLIP_IMAGE_CAP` (= 4) | 584 |
| `selectSlipImages(images, {cap})` — **F-07 (#61)**: picks which images `handleSlipFeed` feeds to vision. Any `origin:'attachment'` present → those in order, capped at 4 (the fix); else `[images[0]]` (legacy single-image / embed-only behavior, byte-for-byte). Embed/preview thumbnails are never multiply-processed. Pure + exported. | 590 |
| `slipImageIngestId(base, i)` — first selected image keeps the base ingestId (single-image path unchanged, incl. its pipeline-events/holds id); each subsequent → `${base}-img${i}` (i≥1) to avoid event/hold id collisions. Pure + exported. | 600 |
| `handleSlipFeed` (gated to `SLIP_FEED_CHANNEL_ID`) — loops `selectSlipImages(images)`, one `processSlipImage` per image with the same other args; overflow past the cap is `console.warn`-only (no new drop enum). Only N≥2 real attachments changes behavior. | 605 (fn); per-image loop 635 |
| OCR-first slip seam (`processAggregatedMessage`): `imageCount = ocrFirstWiring.eligibleImageCount(combinedImages)` — counts REAL attachments only so an HRB slip+embed = 1 (scope=single), a true 2-attachment post = 2. Fails safe to total. | 1076 (guard), 1077 (call), 1084 (count); helper `services/ocrFirstWiring.js:176` |
| ADMIN_LOG send (path B) | 1313 (guard L1311) |
| **DubClub split bypass — author-agnostic (#84)** — gates on channel membership ALONE (`isDubclubSplitChannel`); both webhook/bot AND human authors bypass GUARD 5. `isWebhookOrBot` now only selects `bypassImages` (webhook → `[]`, human → real `images`). Routes straight to `processAggregatedMessage` | 945 (`if (isDubclubSplitChannel)`; channel-list L943, `isWebhookOrBot`/`bypassImages` L944/951, `processAggregatedMessage` call L954) |
| **GUARD 5 signal gate (#84)** — drops a message scoring `looksLikePick` <2 signals with no celebration + no images, now as `GUARD5_INSUFFICIENT_SIGNALS` (was the misleading `PRE_FILTER_NO_BET_CONTENT`) | 965 (`if (!textIsPick && !textIsCelebration && !hasImages)`); `recordDrop` emit 972; `looksLikePick` def 231 (`signals >= 2` L237) |
| `!message.guild` → `CHANNEL_UNAUTHORIZED` drop (#84 — was a silent `return`) | 770–772 (`recordDrop` `guardReason:'no_guild'` L771) |
| partial-fetch failure → `recordError` (#84 — was a silent `return`) | 776–786 (`recordError` `where:'partial_fetch'` L783) |
| dedup short-circuit — intentionally still silent (#84 comment) | 794 (`processedMessages.has(dedupKey)` return; rationale L790–792) |

> **Note (#84):** the pre-existing rows above this block carry some line drift unrelated to #84 (e.g. `processedMessages` decl, `processAggregatedMessage` start) — a full `messageHandler.js` table refresh is owed separately; the five rows just added are verified against `main`@94e3175.

**`raw_text` semantics — two ingest paths, inconsistent by history (NOT a bug):**
- Pure-slip / HRB path (`processAggregatedMessage`, L1288): `raw_text` = the scrubbed Discord message *body* (`cleanText`, defined L683). For HRB shares that body is share-card boilerplate (e.g. "Check out this bet I placed on Hard Rock Bet!"), **not** the Vision extraction.
- Vision extraction lands in `description` — intentional. The grader reads `description` only and never `raw_text` (enforced by the `buildGraderSearchQuery` doc-comment at `services/grading.js:~1459-1473` + `tests/grader-uses-description.test.js`), so the HRB `raw_text` boilerplate is purely cosmetic — do not "fix" it.
- `processSlipImage` (L562) differs: stores `ocrText || description` in `raw_text`. The two paths diverge by history, not design intent — recorded here so it is not mistaken for a bug.

**Hold rescue is messageUrl-based — the slip image is never rendered, `payload.imageUrl` is never read (do NOT "persist imageUrl"):**
- All three rescue surfaces key off the Discord **messageUrl**, not any image: the admin-log hold embed's "View Original" Link button (`sendHoldReviewEmbed` L13, `.setURL(messageUrl)` L33), the `holdReview.js` Release flow (`payload.messageUrl`, L174–213), and the `review-holds.js` CLI. None calls `setImage`/`setThumbnail`; none reads `payload.imageUrl`.
- `review-holds.js` re-fetches the live Discord message per walk (`channel.messages.fetch` from `payload.messageUrl`, L547–554) and reads attachments fresh (L80, L91) → always a current signed image url, so no stored snapshot is needed.
- `EXTRACTED.imageUrl` (single-image branch, L1009) is `imageUrl.slice(0, 120)` — a truncated, HMAC-stripped debug breadcrumb, NOT an openable link. The multi-image branch (L1014) stores no url at all. Treat neither as a usable image link; do not add imageUrl-persistence to the multi-image branch — no consumer reads it (closed; see BACKLOG.md).

### services/linkReader.js (sportsbook share-link shadow detection, Phase A)

Detects allow-listed sportsbook book/shortlink URLs in a message body before it is staged as `MANUAL_REVIEW_HOLD`, so a held slip whose legs live behind a share link is identifiable in shadow mode. Gated by `LINK_READER_MODE` (see §Env vars). No new pipeline_events rows, stages, or drop reasons — the `share_link` is an additive field on the *existing* hold event. See BACKLOG "Playwright shortlink expander" for the A/B/C plan.

| What | Line(s) |
| --- | --- |
| `MODE` — `'shadow'` iff `LINK_READER_MODE==='shadow'`, else `'off'` (Phase-C `'cutover'` reserved, treated as off) | 31 |
| `BOOK_HOSTS` (share.hardrock.bet / sportsbook.fanduel.com / sportsbook.draftkings.com / dkng.co), `SHORTLINK_HOSTS` (bit.ly / tinyurl.com) | 34, 42 |
| `detectShareLink(text)` — pure, never-throws, allow-list-only; returns `null` or `{ url(≤200), domain, kind:'book'\|'shortlink' }`. Suffix host-match (`host===h \|\| host.endsWith('.'+h)`) so promo/social/Discord links and look-alike hosts (`share.hardrock.bet.evil.com`) → null | 68 |
| `attachShareLink(payload, text)` — wiring helper. **Off-mode short-circuit:** `MODE!=='shadow'` → returns `payload` untouched, `detectShareLink` never called. Shadow → adds additive `share_link` field | 111 |
| Wiring + sample bump: both MANUAL_REVIEW_HOLD writes in `handlers/messageHandler.js` (is_bet=false branch + indeterminate branch); `sample` slice bumped 80→400 at the same two sites | messageHandler.js 1238/1239 (is_bet=false), 1308/1309 (indeterminate) |
| **Phase A.1** wiring: the `sportsbook_brand` → `BOUNCER_REJECTED` drop (a share-wrapper the parser hallucinated into a bet) annotated with `share_link` from `cleanText`, gated on `reason==='sportsbook_brand'`. Discord path only — the twitter `sportsbook_brand` drop is intentionally **not** annotated because the scraper mangles relayed URLs (BACKLOG "Twitter-side caveat"); `validateParsedBet`'s `maybeDrop` is dead (no caller passes `ingestId`) | messageHandler.js ~1370 |

> **Footgun — `services/ai.js` `validateParsedBet` `maybeDrop` is INERT; do not wake it without annotating.** The in-function `maybeDrop` closure (services/ai.js ~2019; `sportsbook_brand` calls ~2113/2123) early-returns at its first statement — `if (!opts.ingestId) return;` (~2020) — so it records **nothing** unless a caller passes `opts.ingestId`, and none do: the 3 production callers pass only `{ hasMedia }` (messageHandler.js 549 slip / 1378 text, twitter-handler.js 251). The live `sportsbook_brand → BOUNCER_REJECTED` record (and every other validator reason) is therefore written **caller-side** — each caller re-derives the reason from `validation.reason` and calls its own `recordDrop` with its own already-resolved `ingestId`; only the Discord text path annotates it with `share_link` (Phase A.1, above).
> **The footgun:** if `ingestId` is ever threaded into `validateParsedBet`'s `opts`, `maybeDrop` wakes up and emits a **second, un-annotated** copy of these drops *alongside* the caller-side write — re-introducing un-annotated `sportsbook_brand` drop rows and silently re-opening the shadow undercount A.1 closed. Fix at that time = annotate inside `maybeDrop` too, or delete the inert path. Keep the caller-side annotation as the single source until then.

### services/ai.js
| What | Line(s) |
| --- | --- |
| `parseBetText` | 909 |
| `parseBetSlipImage` | 1135 |
| `evaluateTweet` | 1335 |
| `validateParsedBet` | 1602 |
| `opts.now` on `validateParsedBet` — injectable date for the offseason check, threaded to `isInSeason(sport, now)` / `resolveInSeasonForOffseason(desc, now)` (mirrors `evaluateSweep(bet, now)`); production callers omit it (wall clock); tests pin it so season-state expectations are hermetic | `isInSeason` 1560; offseason check 2049 |
| LLM waterfall start | 241 (`callLLMResult` dispatch); `PROVIDERS` L18, `getProviders` L68, `callLLM` L333 |
| `slice(0, 250)` → bet_type-aware cap (v451) | 428 (`descCap = isParlay ? 2000 : 250`), in `normalizeBet` L421 |
| MAG7/sheet detector emit per-sport straights (v423) | 984 (prompt-level SHEET-vs-PARLAY rule in `GEMMA_SLIP_PROMPT` — model emits per-sport straights; no separate JS detector) |
| `disambiguateAmbiguousTeam(text)` (P1 sport-disambiguation, PR #36) — returns the sport for a contiguous `"<city> <nickname>"` ambiguous-team phrase; abstains (returns `null`) when the string matches 0 or >1 distinct franchises, so multi-franchise strings are never force-classified | 549 (fn); export L1984; called from `detectSport` L582, `reclassifySport` L1639, `inferLegSport` L1674 |
| `AMBIGUOUS_TEAMS` — table of the 6 shared nicknames (cardinals, giants, rangers, kings, panthers, jets) mapping each city → its sport | 530 |
| `validateLegSportConsistency(leg, parlaySport)` — Bug-A wrong-sport leg guard. **#82** (`b4f4097`): the declared parlay sport is parsed as a **SET** — `(parlaySport).toUpperCase().split(/[/&,]/).map(trim).filter(Boolean)` — so a compound declaration (`MLB/NHL`) admits a leg from ANY of its sports (intersection of `matchedSports` ∩ `declaredSet` non-empty). A single-sport string → one-element set → verdict + reject-reason bytes **identical** to the prior exact-key match; mismatch not loosened. **#86** later layered a declared-KBO early-pass (`declaredSet.has('KBO') && matchesKboTeam(desc)`) on top, before the US-league scan | 1949 (fn); call from `validateParsedBet` 1918; set-split 1959–1965; intersection loop 1983–1986; KBO early-pass (#86) 1972; reject reason 1992 |
| `KBO_TEAMS` / `matchesKboTeam` / `normalizeKboLeg` / `declaredSportIncludesKbo` — the **only** KBO team data in the repo (10 sponsor/nickname pairs); used by the parse-time validator. **Not** in `data/mappings/teams.json` (NBA/NFL/MLB/NHL only) and **not** in grading `SUPPORTED_SPORTS` → KBO bets are ungradeable downstream (see §grading.js `isSupportedSport`) | `KBO_TEAMS` 1716; `matchesKboTeam` 1751; `normalizeKboLeg` 1761; `declaredSportIncludesKbo` 1773 |

### services/normalization.js (unmodeled-league sport gate, #85)

Team/player nickname-alias expansion for stored bet descriptions. `normalizeDescription(text, declaredSport)` (the `text`-only form is the historical, still-supported shape) canonicalizes nicknames (`"Eagles"`→`"Philadelphia Eagles"`) using the alias index built from `data/mappings/teams.json` (modeled leagues today = **NBA/NFL/MLB/NHL**). **#85** (`1bfb053`) added the optional `declaredSport` arg + a gate so a slip declared in a league we **don't** model (KBO/KHL/NPB/soccer/tennis/NCAAF/WNBA…) is returned **byte-identical** — a bare `"Eagles"`/`"Lions"`/`"Giants"` in a KBO slip is a Korean club (Hanwha Eagles, Samsung Lions), not the US team (incident 2026-06-11). `services/ai.js normalizeBet` passes `bet.sport` into **both** the parent-desc and per-leg `normalizeDescription` calls.

`shouldExpandAliases(declaredSport)` is the gate. It **EXPANDS** (prior behavior) when the sport is absent/empty/null, a non-committal placeholder (`SPORT_PLACEHOLDERS`: UNKNOWN/N-A/PENDING/TBD/… — `detectSport` emits the literal `Unknown` for abbreviation/slang/player-prop text, which must keep canonicalizing), a teams.json league **code** as a whole word (`"NBA"`, `"NBA Basketball"`), or a generic/full league **name** for a modeled league (`"Baseball"`, `"Major League Baseball"` — `LEAGUE_NAME_ALIASES`). It **SUPPRESSES** otherwise. Compound declarations split on `/ & ,` and expand only when **every** part qualifies, so `"MLB/KBO"` suppresses. The modeled set / code-regex / name-set are derived from teams.json keys at load (`loadTeamMappings`), so the gate tracks the data; `"Football"` (soccer-ambiguous) and foreign-qualified names (`"Korean Baseball"`) deliberately do **not** match (and `WNBA`/`NCAAF` carry no whole-word `\bNBA\b`/modeled code → suppress).

`hasSponsorPrefix(result, offset)` is a sport-**independent** backstop applied inside `normalizeDescription`'s replace callback: a nickname immediately preceded on the **same line** by a KBO corporate sponsor (`KBO_SPONSOR_PREFIX`: Hanwha/Samsung/LG/Lotte/Doosan/KIA/SSG/KT/NC/Kiwoom) is never expanded, even when `detectSport` mislabels the bare text as a US league. Same-line only (`[^\S\n]+`) with a 16-char lookback, so `"KT\nLions ML"` still expands the next-line Lions.

> The KBO *validator* helpers `matchesKboTeam`/`normalizeKboLeg`/`declaredSportIncludesKbo` are NOT here — they live in `services/ai.js` (#86, separate). The single-arg `normalizeDescription(text)` in `services/database.js:280` is an unrelated parlay-leg dedup helper — do not conflate.

| What | Line(s) |
| --- | --- |
| `normalizeDescription(text, declaredSport)` (2nd param added #85; passthrough short-circuit L316–317; sponsor guard call L335) | 314 |
| `shouldExpandAliases(declaredSport)` (the unmodeled-league gate) | 285 |
| `SPORT_PLACEHOLDERS` (Unknown/N-A/Pending/… → keep expanding) | 248 |
| `hasSponsorPrefix` / `KBO_SPONSOR_PREFIX` / `ZERO_WIDTH` (sport-independent sponsor guard; same-line, 16-char lookback) | 217 / 210 / 211 |
| `mappedLeagues` / `modeledLeagueCodeRe` / `modeledLeagueNames` / `LEAGUE_NAME_ALIASES` (built in `loadTeamMappings` L52–57 from teams.json keys; modeled set today = {NBA,NFL,MLB,NHL}) | 22 / 26 / 45 / 39 |
| Caller wiring — `normalizeBet` passes `bet.sport` (`declaredSport`) into both the parent-desc and per-leg `normalizeDescription` calls | `services/ai.js` |

### services/grading.js

> Line numbers refreshed 2026-06-03 (PR `phase1-grading-gates`). A ~145-line
> Phase-1 gates block was inserted near the top (L18–162), shifting everything
> below by ~+155. The gates: the LLM grades legs only; **code** owns aggregation
> (Gate 1), idempotency (Gate 2), and quote enforcement (Gate 3).
> Refreshed again 2026-06-03 (PR `gate3-shadow-mode`): the Gate 3 helper block
> grew by +64 lines (tri-state mode resolver + `applyGate3`), so everything
> below `validateEvidenceQuote` shifted by +64.
> Refreshed again 2026-06-04 (PR `gate3-would-fire-audit`, B0): added
> `buildGate3WouldFireMarker` after `applyGate3` (+31 below it) and extracted
> `writeGradingAudit` before `gradeSingleBet` (+25 more below it). Net shift:
> +31 from `reduceParlayResult` down, +56 from `gradeSingleBet` down. The Gate-3
> would-fire event now persists to `grading_audit.guards_failed` as a
> `GATE3_WOULD_FIRE|…` marker on the attempt's existing row (zero extra rows).
> Refreshed again 2026-06-10 (COA audit M-10): the #62 sweeper-grace block
> (~L1124–1165) had been mapped for its own rows but everything below it was
> never re-shifted — every row from `gradeFromCelebration` down was +43 stale.
> All rows below re-verified against `main`@84650b8.
> Refreshed again 2026-06-10 **evening** (PRs #73 + #74, `main`@4c992c9): #73
> inserted `parlayLegDataComplete` (+25 below `reduceParlayResult`); #74's
> `extractSubject` ordinal-protection block + the search-backend honesty block
> (`GATED_BACKENDS` / `recordBackendResult` / `getBackendSnapshot` /
> `assessSearchResults`) added ~+115 more. Every row below `reduceParlayResult`
> re-verified against `main`@4c992c9.
> Refreshed again 2026-06-10 **evening batch 2** (PR #76 `7a55842`, `main`@3ed77e2):
> #76 added two `extractSubject` body lines (slash→space `:1453`, orphan-dash
> `:1466`), shifting the search block by **+12** (so `getBackendSnapshot` 1600→1612,
> `assessSearchResults` 1664→1676); and inserted the new pure `parseBingHtml`
> block (`BING_*` selectors + `cleanBingFragment`/`firstSelectorMatch`/`parseBingHtml`,
> ~+61) **before** `searchBing`, shifting `searchBing` and everything below it.
> Every row from `extractSubject` down re-verified against `main`@3ed77e2.
> Refreshed again 2026-06-18 (#124 `event-aware-recheck`, `3269ab4`): inserted the
> event-aware recheck block (consts + `endOfUtcDay` + `nextAttemptForEvent` +
> `eventAwareRecheckMode` + `emitEventAwareShadow`, `services/grading.js` ~933–1027)
> just **above** `scheduleRecheckAfterDenial`, shifting every row from
> `scheduleRecheckAfterDenial` down by ~+95 (rows above — through `canFinalizeBet`
> @860 — already carried a ~+8 pre-#124 drift and are left unchanged here). The new
> event-aware rows below carry current `main`@`aa58f9a` line numbers; older rows
> further down were NOT re-verified in this pass and remain stale-by-~103.

| What | Line(s) |
| --- | --- |
| **Gate 1** `reduceParlayResult` (pure parlay reducer — keystone; LOSS>PENDING>WIN) | 209 (fn); `normalizeLegStatus` 202 |
| **Gate 2** `GRADER_VERSION` / `computeEvidenceHash` / `decideFinalGradeWrite` | 20 / 25 / 45 |
| **Gate 3** quote-bound grading — tri-state `QUOTE_BOUND_GRADING` (`off`/`shadow`(staged default)/`enforce`); **live on Fly = `enforce` as of 2026-06-10** (verified in-container; staged default is still `shadow`). shadow logs `[GATE3 would-fire]` and leaves the grade, enforce forces PENDING (`UNVERIFIED_QUOTE`); unknown/legacy → shadow | `normalizeQuoteWhitespace` 76; `validateEvidenceQuote` 89; `resolveGate3Mode` 115; `applyGate3` 129 (returns `claimed` for the marker) |
| **Gate 3 (B0)** `buildGate3WouldFireMarker` — pure; returns `GATE3_WOULD_FIRE\|mode=\|claimed=\|prop=\|reason=` token or `null` (off / quote ok). Caller pushes it onto `audit.guards_failed` (display-only; never gates grading) so the event rides the attempt's existing `grading_audit` row — **zero extra rows** (a dedicated row would perturb `shouldAutoVoidNoData`'s recent-5 + the daily cap). Query: `WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'` | 177 (fn); marker const 176 |
| **Gate 4** off-date evidence reject — tri-state `DATE_BOUND_GRADING` (`off`/`shadow`(default)/`enforce`); `resolveGate4Mode` mirrors `resolveGate3Mode` (unknown/legacy → shadow). Runs **after** Gate 3 (needs a trusted quote): locate the quote-bearing evidence-record(s) via `normalizeQuoteWhitespace`, union their dates → none in `[anchor−tol, anchor+tol]` fires `OFF_DATE_EVIDENCE`; ≥1 in-window → `GATE4:date_ok`; no extractable date → `GATE4:no_date_signal` (pass-through). Anchor = `new Date(eventDate).toISOString().split('T')[0]` (the date GUARD 1/2/3 resolved). `GATE4_TOLERANCE_DAYS={default:1}` per-sport window. shadow marks the audit row + leaves the grade; enforce forces PENDING via Gate 3's `earlyReturn` path. Incident `e5d27de0` (2026-06-12: June-6 friendly graded the June-12 WC opener). `applyGate4` pure (calls in-memory `findMentionedTeams` for the telemetry-only `participants=` tag) | `resolveGate4Mode`; `GATE4_TOLERANCE_DAYS`/`gate4ToleranceFor`; `applyGate4`; call site after Gate 3 (records build after `evidenceForModel`; `applyGate4` + marker push + force-pending). All in services/grading.js Gate-4 block after `buildGate3WouldFireMarker` |
| **Gate 4 (B0)** `buildGate4WouldFireMarker(g4)` — pure; returns `GATE4_WOULD_FIRE\|mode=\|claimed=\|anchor=\|tol=\|evdates=\|participants=\|reason=OFF_DATE_EVIDENCE` token or `null` (not would-fired). Rides `audit.guards_failed` — **zero extra rows**, like Gate 3 B0. Query: `WHERE guards_failed LIKE '%GATE4_WOULD_FIRE%'`. Read-only diagnostic `scripts/gate4-firing-check.js` (opens DB `{readonly:true}` — M-13) | services/grading.js Gate-4 block |
| **`services/evidenceRecords.js`** — dated evidence-record layer (Gate 4 precondition; Gate 5 will add `scope`). Dependency-free (no DB/env/I/O). `buildEvidenceRecords(searchResults, evidenceForModel, anchorISO)` → one record per hit `{idx,backend,url,domain,snippet,char_start,char_end,dates[],scope:null}` annotating — never altering — the model-visible string (byte-identity test). `extractDates(text, anchorISO)` (ISO / `Month D, YYYY` full+abbr / `M/D/YYYY` / `M/D/YY` / year-less → anchor yr, >300d-future → yr−1; strips HTML tags first). `evaluateOffDate` (off_date/date_ok/no_date_signal), `isWithinWindow`, `assembleEvidenceText` (byte-identity source-of-truth). Re-exported via grading `_internal`: `buildEvidenceRecords`, `evaluateOffDate` | `services/evidenceRecords.js` |
| **`parlayLegDataComplete`** — NEW #73, pure early leg-completeness guard: complete ⇔ `legCount ≥ 1` **AND** `legCount === ` the description's `•` bullet count (same structural signal as the leg-explosion guard). Exported via `_internal`. | 257 |
| **`GRADER_ELIGIBLE_WHERE`** — NEW #118 (grader-vs-revert race). A hardcoded SQL-fragment LITERAL `(review_status IS NULL OR review_status NOT IN ('needs_review', 'manual_review_unmodeled_sport'))` — the write-time DUAL of `getPendingBets`' selection guard, so a terminal grader write can't void/grade a bet an operator just reverted to `needs_review` mid-flight. **Inlined, NOT imported** (gotcha, comment 16–23): it is built at MODULE LOAD time, and `warRoom.js → grading.js → database.js` form a require cycle in which a destructured `database.js` export (`GRADER_HIDDEN_REVIEW_STATUSES`) can still be `undefined` when grading.js's top level runs — so an imported constant would be `undefined`. KEEP-IN-SYNC with `database.js GRADER_HIDDEN_REVIEW_STATUSES` (`database.js:683`) — this parity is now ENFORCED by `tests/grader-gate-sync.test.js`, which imports both runtime constants and asserts set-equality of the status list (RED if either side adds/removes/renames a status); both are exported solely for that test. NULL-tolerant. Appended `AND ${GRADER_ELIGIBLE_WHERE}` on all FOUR terminal writes (each also `info.changes > 0`-gated before any DROP): retry-cap void 951, no-data void 1056, unmodeled divert 2460, unscoped void 2508. | const 24–25 |
| `looksLikePlayerProp` | 443 (fn); structured gate → `tryStructured` call 2922 |
| **`findMentionedTeams(description, sportContext=null, opts={})`** — team-alias extractor over `ALIAS_TO_TEAMS` (word-boundary `containsPhrase`). **Contextual stop-list (#147→#148 revert→synthesis):** `STOPWORD_ALIASES = {as, no, sac, wild}` are bare single-team aliases that double as ordinary bet/scoreboard vocabulary. `opts.isEvidence` selects context: **false / default = bet-text extraction → stop-list ACTIVE** (skip these bare tokens, else a phantom team is injected — "Jets No Moneyline"→Saints flips an NFL ML/spread grade via the ESPN pre-check that returns before GUARD 7; soccer "Draw No Bet"→Saints poisons the search query + trips GUARD 7 into a false-PENDING). **true = evidence/scoreboard matching → stop-list INACTIVE** (bare "NO 24" is a real Saints abbreviation; dropping it makes GUARD 7 fail to find the bet team in its OWN evidence → false-PENDING — exactly the regression that reverted the unconditional #147 fix). Each affected team still resolves via its canonical name (and, except the Wild, a distinct nickname); the bare-token drop falls through to search/AI (a missing grade, never a wrong one). **Bet-text callers (default/omit):** `matchBetToGame` 1520, fail-match log 1567, `buildGraderSearchQuery` 2064, `gradePropWithAI` betTeams 3137, `commands/grade.js` `/grade test`. **Evidence callers (`{isEvidence:true}`):** `applyGate4` participant tag 288, GUARD 7 `combinedEvidence` 3461, GUARD 9 cross-sport `parsed.evidence` 3502. `tests/stopword-alias-phantom.test.js` (both directions, RED-proven). | `findMentionedTeams` 1457; `STOPWORD_ALIASES`+comment 1398–1416; `ALIAS_TO_TEAMS` 1383; `containsPhrase` 1424 |
| **`isUnresolvableTeamGameBet(bet, betTeamList)` — GUARD 7b (NEW, this PR; pure, exported).** Closes the residual the bet-text stop-list opens: a bet named ONLY by a stop-listed bare alias ("Wild ML"/"NO ML") now extracts **no team**, so the ESPN fast-path can't match it (`matchTeamsToEvent` returns null on empty) AND GUARD 7's team-in-evidence check is skipped (gated `betTeamList.length>=1`) — a WIN/LOSS the AI returned against a WRONG same-sport game would otherwise be written with no backstop. The guard returns `true` (→ caller forces PENDING via the existing `earlyReturn` path, marker `G7:no_resolvable_team`, **drop-reason `GRADE_POST_GUARD_REJECTED`** so it buckets with G7/G8/G9 not the UNCLASSIFIED catch-all) iff: betTeamList empty **AND** `bet.sport` ∈ `ALIAS_MODELED_TEAM_LEAGUES`={MLB,NBA,NHL,NFL} (mirrors the ESPN pre-check gate — excludes NCAAF even though `normalizeSportContext` folds it to NFL) **AND NOT a player prop**. **Player-prop exemption is TWO-pronged** because `isPlayerPropDescription`'s stat list is structurally narrow (misses live NFL phrasings — singular "TD", "Sacks", "Tackles", "Interceptions", "Alt … Yards N+", composite/segment): exempt on recognized prop SHAPE (`isPlayerPropDescription`) **OR** a named multi-token player (`extractPlayerNameFromDescription` returns a 2+-token name) — a bare-alias team bet ("Wild ML"/"Sac ML"/"AS ML"/"NO ML") yields ≤1 token (or none) so the alias residual stays held while every named prop grades. Scoped OUT (keep grading, RED-proven): player props of ANY sport (both prongs), individual sports (GUARD 8), soccer (own adapter; teams absent from `ALIAS_TO_TEAMS`), NCAAF. Accepted in-scope: teamless/bare game totals are HELD (the boundary turns on whether a stat word trips `isPlayerPropDescription` — "Over 47.5" holds, "Over 6.5 goals" grades). Single new invariant — no finalization change; sits in the `if (parsed.status==='WIN'\|'LOSS')` block right after GUARD 7, before GUARD 8 (pre-empts GUARD 9's weaker cross-sport-only check for the 4-league non-prop empty-team subset). `tests/stopword-alias-phantom.test.js` DIRECTION 3 (guard + both exemption prongs RED-proven; bare-total/team-total boundary pinned). | `ALIAS_MODELED_TEAM_LEAGUES` 850; `isUnresolvableTeamGameBet` 870; guard call 3511 (marker/dropReason ~3513) |
| `canFinalizeBet` | 860 |
| `scheduleRecheckAfterDenial` — gateway-denial recheck (does **not** touch attempts/state, just requeues). RETRY_CAP=15 → at cap stamps `GRADE_BACKOFF_EXHAUSTED` + VOID (cap-void UPDATE carries `AND ${GRADER_ELIGIBLE_WHERE}` (#118) + gates the `GRADE_BACKOFF_EXHAUSTED` drop on `info.changes > 0`); the cap check runs FIRST. **#124 event-aware (EVENT_AWARE_RECHECK):** `off` → unchanged flat `+minutes` write; `enforce` → `grading_next_attempt_at = datetime(?)` at `nextAttemptForEvent(event_date).nextAttemptAt` instead of the flat +30 (then `return`); `shadow` → emit one `event_aware_shadow` `would_window` row + structured log, then fall through to the unchanged flat write (behavior identical to `off`). | 1029 (`RETRY_CAP` 1034; cap-void UPDATE 1043; event-aware block 1077; enforce write 1088; shadow emit 1098; flat write 1102) |
| **`nextAttemptForEvent(eventDateRaw, now=Date.now())`** — NEW #124 (Codex #3), **pure** event-aware recheck planner (no DB/network; `require('./ai')` is cached; `now` injected for unit tests). Returns `{phase, defer, nextAttemptAt, reason}`. Phases: **`pre_event`** (`defer:true`, schedule at game-ready time — `+EVENT_TO_FINAL_MS` if the RAW event string carries a time, else end-of-UTC-day `+DATEONLY_SETTLE_MS`; reason `event_not_final`), **`post_event`** (`defer:false`, `now+POST_EVENT_RECHECK_MS`, reason `event_final_settling`), **`unknown`** (`defer:false`, `now+DEFAULT_RECHECK_MS` — preserves today's flat +30; reasons `no_event_date` / `unparseable` / `suspect_far_future` when `msUntil > MAX_DEFER_MS`). **Non-obvious correctness point:** time-presence is detected on the **RAW** `event_date` string (`/T\d\|\d:\d/`), NOT on `normalizeEventDate`'s output — `normalizeEventDate` stamps a date-only ISO (`2026-06-18`) to `…T00:00:00.000Z`, so testing the output would make the date-only branch dead code (a maintainer-ratified deviation, documented in-code). Exported via `_internal`. | 977 (fn); `endOfUtcDay` 966; consts 959–963 |
| event-aware consts (#124) — `EVENT_TO_FINAL_MS`=**4h** (game+settle, when event_date carries a time), `DATEONLY_SETTLE_MS`=**6h** (applied after end-of-UTC-day for a date-only event_date), `POST_EVENT_RECHECK_MS`=**45m** (event already final/settling — short recheck), `DEFAULT_RECHECK_MS`=**30m** (preserves today's flat +30 for no/unparseable/far-future date), **`MAX_DEFER_MS`=168h (7d)** — caps the defer so a typo'd year falls back to the flat +30. ⚠️ **Enforce-flip caveat:** `MAX_DEFER_MS` (7d) equals the 7-Day Sweeper's `SWEEP_CUTOFF_MS` (`SWEEP_DAYS=7`, keyed off `created_at`), so under `enforce` a bet whose event is ~7d out could be swept to a FALSE LOSS before its event-aware recheck fires. Impossible in `shadow`. Resolve before flipping enforce (drop `MAX_DEFER_MS` below 7d, or sweep-exempt deferred bets — the latter touches the sweeper, outside #124's scope). See BACKLOG open item. | 959–963 |
| **`eventAwareRecheckMode()`** — NEW #124, strict string compare of `process.env.EVENT_AWARE_RECHECK` → `'enforce'` / `'shadow'` / else `'off'` (unset/anything-else → off; read at call time so ops can flip without a restart; same idiom as `GEMMA_FALLBACK_DISABLED` / `QUOTE_BOUND_GRADING`). **`emitEventAwareShadow(betId, payload)`** — shadow-only, fire-and-forget, error-swallowed `bets.transitionTo` writing event_type `event_aware_shadow` on stage `GRADING_ENTER` (sourceType `grading`, null ingest_id); never throws, never gates control flow. | `eventAwareRecheckMode` 1005; `emitEventAwareShadow` 1017 |
| `runAutoGrade` **event-aware pre-grade skip** (#124) — in the pending loop **before** the atomic `claimBetForGrading`, when `EVENT_AWARE_RECHECK !== 'off'` and `nextAttemptForEvent(bet.event_date).defer` is true: `enforce` → write `grading_next_attempt_at = datetime(?)` (guarded `AND result='pending'`) + `continue` (no attempt burned, no search/LLM); `shadow` → emit `event_aware_shadow` `would_defer` row + log, then fall through to the normal claim/grade (unchanged). `off` → no-op. `getPendingBets` selects `b.*` so `bet.event_date` is present. | pre-claim block 1685–1703 (plan 1692; enforce write+`continue` 1696/1698; shadow emit 1700) |
| `shouldAutoVoidNoData` — **the *other* void path**: recent-5 `grading_audit` rows all `PENDING` + no-data evidence, `grading_attempts ≥ 5`, age ≥ 12h → `autoVoidNoSearchableData` writes VOID (`auto_void_no_searchable_data`; its UPDATE also carries `AND ${GRADER_ELIGIBLE_WHERE}` #118). Keys on audit *content*, not raw attempt count — why a 7-attempt bet can void while a 35-attempt bet does not (see BACKLOG "non-uniform auto-void"). **Build 1d exemption — FIRST check:** `if (require('./sportsdata').hasDeterministicAdapter(bet?.sport)) return null;` — an adapter-covered sport is NEVER no-data-voided ("search data unavailable" is exactly what the adapters settle). Inline-require (mirrors the `tryStructured`/`tryGradeViaESPN` call sites; sportsdata is leaf-ward, no load-time cycle) + try/catch (an unavailable adapter layer falls through to the pre-1d void logic). The exempt bet stays pending on normal backoff; the untouched 7-day sweeper is the backstop. Was wrongly voiding live adapter-sport bets (Soccer/NBA/MLB/NHL/WC; reported tally 837 total no-data voids, exact wrongly-voided count NOT yet settled — ~557 by per-sport breakdown vs a ~345 headline, re-derive before Build 2; see BACKLOG). | `shouldAutoVoidNoData` 1142 (Build-1d guard 1143–1157; MIN_AGE_MS/MIN_ATTEMPTS 1159–1160); `autoVoidNoSearchableData` 1185 (gate 1200) |
| `isSupportedSport(sport)` / `SUPPORTED_SPORTS` — exact single-key membership (`toUpperCase().trim()` → `SUPPORTED_SPORTS.has(s)`; rejects null/`UNKNOWN`/`N/A`). **OPEN FOLLOW-UP (#82 downstream):** does **not** split or normalize the stored sport, so a compound (`MLB/NHL`) or unmodeled (`KBO`) sport string is not in the flat set → returns false → the bet is **auto-voided** at the grade gate (`review_status='auto_void_unscoped_bet'`, skips ESPN+AI). #82 fixed the *parse-time* compound-sport leg validator. **PARTIAL FIX (2026-06-16):** intentionally-unmodeled leagues (KBO/KHL/NPB) no longer auto-void at this gate — `gradePropWithAI` now DIVERTS them to `review_status='manual_review_unmodeled_sport'` (non-void, `result` stays pending, sweeper-safe) via `declaresAnyUnmodeledLeague` BEFORE the void write, so a real KBO bet is parked for a human instead of silently settled. Remaining: making them *gradeable* (KBO team data in teams.json) is a larger follow-up; compound *mixed-modeled* sports (`MLB/NHL`) still auto-void unless every part canonicalizes. Possible fix: split/normalize compound sport at this gate + add KBO team data to teams.json | `isSupportedSport` 544; `SUPPORTED_SPORTS` 404; auto-void gate `if (!isSupportedSport(bet.sport))` 2419 (unmodeled-divert write 2455–2464 `diverted=info.changes>0`; VOID write 2504, `voided=info.changes>0` 2512; `AUTO_VOIDED` return 2542) |
| **`canonicalizeSportForGrading(rawSport)`** — NEW #110 (audit B7). Maps an alias sport label → a SUPPORTED token via `SPORT_ALIAS_TO_CANONICAL` BEFORE the auto-void gate, so World Cup/UEFA/Copa/Intl-Friendly→`SOCCER`, Hockey/IIHF→`NHL`, ATP/WTA→`TENNIS`, PGA→`GOLF` grade instead of voiding. **Whole-label** lookup (`Object.prototype.hasOwnProperty.call(map, trimmed.toUpperCase())`), never substring; compound splits on `/ & ,` and rescues only if EVERY part agrees. Bare `'FRIENDLY'` and KBO/KHL/NPB deliberately excluded (KBO/KHL/NPB route to manual review, not rescue). Runs in `gradePropWithAI` AFTER `reclassifySport` (so a team-name rescue wins first), BEFORE `rescueNoLegNationalTeamSport` + the gate. Both exported. *(Stale inline comment at `:2423` cites `:527-529` for the map — the object is actually at 573-589; comment-only drift.)* | `SPORT_ALIAS_TO_CANONICAL` 573–589; `_canonicalSportPart` 593; `canonicalizeSportForGrading` 616; call site `bet.sport = canonicalizeSportForGrading(bet.sport)` 2390 |
| **`rescueNoLegNationalTeamSport(sport, description)`** — NEW #112. Grade-time rescue for no-leg Unknown bets naming a World-Cup nation (these skip #100's leg-only validator → would auto-void). Pure: returns `sport` unchanged unless `isSportPlaceholder(sport)` (from `./normalization`) AND `descNamesNationalTeam(description)` (whole-word `NATIONAL_TEAM_RE`, exported from `services/ai.js`); then defers (unchanged) if `inferLegSport` yields a strong non-`SOCCER` signal, else returns `'Soccer'`. Added `'iraq'` to `SOCCER_NATIONAL_TEAMS` (`services/ai.js`). Runs AFTER #110 canonicalize, BEFORE the supported-sport gate. | `rescueNoLegNationalTeamSport` 676; call site `bet.sport = rescueNoLegNationalTeamSport(bet.sport, bet.description)` 2405; `descNamesNationalTeam` `services/ai.js:1651` |
| `calcProfit` | 1323 |
| `gradeFromCelebration` | 1665 |
| `extractSubject` — **ordinal/period sentinel protection (#74)** + **slash/dash query fixes (#76)**. #74: stashes `1st`–`4th` / `1H`/`2H` / `1Q`–`4Q` / `F5` behind a U+0001 sentinel (`String.fromCharCode(1)`) *before* the `\d+\.?\d*` + market strips, then restores them in order, so `"1st Quarter"` survives while odds/lines still strip. #76: slash/backslash between tokens → **space** (`.replace(/[/\\]/g, ' ')`, runs *before* the symbol strip so it can't be eaten) — `"McGhee/Yannis ITD"` → `"McGhee Yannis ITD"`; and **orphan dash-runs** isolated by whitespace/boundary are dropped (`.replace(/(^\|\s)-+(?=\s\|$)/g, '$1')`) — `"Joanderson Brito ML (-165)"` → `"Joanderson Brito"`, while intra-word hyphens (`Saint-Denis`) survive (the ASCII `-` is deliberately kept out of the symbol class) | 1768 (fn); sentinel stash 1785; `SENT` const 1782; slash→space 1796; restore-in-chain 1802; orphan-dash drop 1809 |
| `buildGraderSearchQuery` (description-only; doc-comment 1814–1828). **#117 player-prop box-score branch:** the FIRST if-clause, gated on `isPlayerPropDescription(description)` (`:746`), builds `<extractSubject><optional stat> <date> box score` instead of the `final score` strings the team/total/fall-through branches use — a prop fell through to `<player> <sport> final score <date>` so the LLM only saw game recaps without the stat and looped PENDING forever (live NBA 52937045 30 cycles, MLB 0f50c2bf). Stat keyword (`PLAYER_PROP_STAT_RX`, `:714`) re-appended only when `!containsPhrase(subject, statKeyword)` (`containsPhrase` `:1254`) so Total Bases/PRA/threes that survive `extractSubject`'s strip-list never duplicate. Team (`≥2`), single-team, and fall-through branches all UNCHANGED (still `final score`). Consumed at `:2967`, exported `:3464`. | 1829 (fn); prop branch `if (isPlayerPropDescription(...))` 1844; query build 1866–1870 |
| **`GATED_BACKENDS`** — NEW #74, `Set{brave, ddg}`: the only backends `searchWeb` SKIPS when their circuit is open. `bing`/`serper` are deliberately un-gated workhorses (failures recorded but still attempted; Bing-first preserved) | 1568 |
| `recordBackendResult` — #74: now stamps `lastSuccess` **only on a real success** (parse failures no longer record a false `ok`), so the breaker + snapshot stop scoring drifted 200s as healthy | 1581 |
| **`getBackendSnapshot`** — NEW #74, structured per-backend health for `/admin` + tests; state ∈ `idle`/`healthy`/`failing`/`open`(gated, searchWeb skipping)/`degraded`(un-gated bing/serper, circuit open but still tried) + last-success age in every state. Top-level export; consumed by `commands/admin.js` `fmtBackend` | 1612 |
| **`assessSearchResults`** — NEW #74, content sanity gate every backend routes through before recording success. Returns `{ results, status }`, status ∈ `ok` / `parse_empty` (0 usable hits → circuit failure + fall-through, all backends) / `generic_news` (Bing-only `checkRelevance`: parsed but no hit mentions a query token >3 chars → fall-through, no breaker trip) | 1676 |
| **`parseBingHtml(html)`** — NEW #76, pure Bing-SERP parser, exported via `_internal`. Tries `BING_BLOCK_DELIMITERS` (`b_algo` → `b_algoheader` → `b_ans`) in order — first delimiter yielding ≥1 hit wins, 5-block cap — and within each block runs ordered `BING_TITLE_SELECTORS` (`h2`/`h3`/`tilk`/anchor) + `BING_SNIPPET_SELECTORS` (`b_caption>p`/`b_lineclamp`/`b_algoSlug`/first-`p`) via `firstSelectorMatch`+`cleanBingFragment`. Total miss → `[]` (→ `assessSearchResults` `parse_empty` → honest fall-through to Brave; gate NOT weakened). Replaces the old single hard-coded `b_algo`+`b_caption>p` selector | `BING_BLOCK_DELIMITERS` 1797; `cleanBingFragment` 1812; `firstSelectorMatch` 1817; `parseBingHtml` 1829 |
| `searchBing` (content-gated #74 + #76: a 200 with garbage classes `parse_empty` (circuit fail) or `generic_news` (fall-through, no trip) → reaches Brave instead of scoring `ok`; now parses via `parseBingHtml` (#76) instead of the single drift-prone `b_algo` selector) | 1849 (`parseBingHtml` call 1865) |
| `gradePropWithAI` (dispatch: parlay→gradeParlay, else gradeSingleBet). **Sport-gate ordering** (the auto-void gate region): `reclassifySport` → `bet.sport = canonicalizeSportForGrading(...)` (#110, 2390) → `bet.sport = rescueNoLegNationalTeamSport(...)` (#112, 2405) → `if (!isSupportedSport(bet.sport))` gate (2419) which DIVERTS unmodeled leagues to manual review (2455–2464) else VOIDs (2504) | 2372; **1-leg parlay guard** (#73 — skips to PENDING only when `recordedLegs ≤ 1 && !parlayLegDataComplete`; complete 1-leg parlays now dispatch to `gradeParlay`) 2560 |
| `isTrustedLossLeg` (Bug A Part 1, v438) | 2576 |
| `aggregateParlayLegResults` (now downgrades untrusted-LOSS→PENDING, then delegates precedence to Gate 1 reducer) | 2631 (fn); "Parlay LOSS — leg N" emit 2678 |
| `gradeParlay` (builds per-leg `legBet` with `bet_type:'straight'` — legs have no stored prop flag) | 2697 |
| `writeGradingAudit` (module-level; extracted from the `gradeSingleBet` `writeAudit` closure, B0) — one `grading_audit` row per attempt; `timestamp` is epoch MILLIS | 2738 |
| `gradeSingleBet` | 2767; structured pre-check (`tryStructured`, gated on `looksLikePlayerProp` + MLB/NBA/NHL) 2922; **Gate 3** quote check (`applyGate3` call 3138; B0 would-fire marker build 3149); grader waterfall providers.push 3004–3025 (groq-llama4-scout 3004 → cerebras-gpt-oss 3007 → groq-qwen 3010 → openrouter 3013 → groq-gpt-oss 3016 → mistral 3019 → ollama-llama3.2-3b 3022 → groq-llama8b 3025) |
| GUARD 3 (too-recent) **event_date skew fallback** — when a stored `event_date` resolves >0.25h ahead of now, re-anchor to `created_at` (kills legacy time-only strings re-anchoring to "today" every poll → "too soon" forever → burned attempts to quarantine; pairs with mig 029 + `services/eventDate.js`) | marker `grade.event_date_skew_fallback` 2893 |
| **`writeBackResolvedEventDate(bet, resolvedDate, source)`** — §9 grader event_date write-back (self-heals the NULL-event_date backlog). Called at the TWO deterministic-resolution consumption points in `gradeSingleBet` (right after `if (structured.resolved)` and `if (espnResult.ok)`, before `earlyReturn`), so the AI-fallback PENDING path never reaches it. Fills ONLY a NULL `event_date` (`UPDATE bets SET event_date=? WHERE id=? AND event_date IS NULL` — race-safe no-clobber), routes the resolved date through the same `normalizeEventDateForStorage` storage guard (implausible → NULLed, never written raw; full ISO instant), never throws, never alters the grade. The date is surfaced by each adapter as an additive `eventDate` field on its `{resolved:true}` / `{ok:true}` result (the matched game's OWN authoritative start — statsapi `gameDate`, ESPN `event.date`, NHL `startTimeUTC` — NOT the queried slate day). Marker log `[eventDateWriteback] bet=… event_date=… source=… (§9 self-heal)`. Surfacing sites: `services/sportsdata/mlb.js` (`getGameForTeam`+`findPlayerGame` carry `gameDate`), `nba.js` (`extractGameInfo`+`findPlayerGame` carry `date`), `nhl.js` (both carry `startTimeUTC`), `soccer.js` (`withEventDate` at the prop boundary + each match-level verdict, `event.date`/`found.ev.date`), `services/espn.js` (`match.event.date` on the `{ok:true}` return). NOT surfaced on the absence/DNP **void** paths (no matched-game date). Exported top-level. Tests `tests/event-date-writeback.test.js`. | helper just above `gradePropWithAI`; export top-level |
| `finalizeBetGrading` | 3303 (also exported as `gradeBet`); **Gate 2** idempotency `decideFinalGradeWrite` 3315; atomic write stamps `grader_version`+`evidence_hash` via `gradeBet`(`=gradeBetRecord`) with **`requireGraderEligible: true`** (#118) at 3351 — the autonomous grader must not settle a bet an operator just reverted to `needs_review` |
| `resolvePlayerProp` | REMOVED (v459) — replaced by `tryStructured()` from services/sportsdata, called at `:2925` (comment "STRUCTURED DATA PRE-CHECK (replaces old MLB resolver)" `:2918`) |

### services/sportsdata/ (Phase 1 structured grading, v459)
| File | Purpose |
| --- | --- |
| index.js | Router: dispatches a bet to the right sport adapter; runs BEFORE search+LLM and short-circuits the LLM when `resolved=true`. **Dispatch is case-insensitive:** `tryStructured` routes on `normalizeSport(bet.sport)` (L14), which `.toUpperCase()`s before substring-matching, so the `if (sport === 'MLB'\|'NBA'\|'NHL')` checks compare against the already-uppercased result, never raw `bet.sport` — sport casing cannot affect routing (Soccer/Tennis are not dispatched at all). **MLB matchup-prefix reroute (#135):** the MLB branch calls `mlb.rewriteMatchupPrefixedProp(bet.description)` FIRST; a non-null rewrite grades via `gradeMlbPlayerProp(rewritten, slateYMD, {absenceVoidAllowed})` (the recognized `"Team vs Team Over N PLAYER [-] STAT"` legs #130 used to refuse). Checked before the `isProp` branch (these legs fail `isProp` — their subject canonicalizes to a team), so the rewrite wins; `null` → routing byte-identical to before. **SOCCER (match-level + props, per-class mode-gated — Build 1/1b/1c):** a SOCCER branch sits at the TOP of `tryStructured`, BEFORE the `normalizeSport` gate — `if (isSoccerSport(bet.sport)) return routeSoccer(bet)`. `normalizeSport` deliberately still returns `null` for soccer (it is reused as a coverage proxy by `scripts/s1b-measure.js`, whose §4b leg-routed view indexes a fixed `{MLB,NBA,NHL}` map by its return value and would crash on a `'SOCCER'` key — and `tests/sport-casing.test.js` asserts null). **Two-flag split (Build 1c):** `routeSoccer` computes per-class effective modes via the pure `soccerEffectiveModes(SOCCER_GRADER_MODE, SOCCER_PROPS_MODE)` → `{matchMode, propMode}` (master kill-switch: master `off`→BOTH off BEFORE any fetch; else matchMode=master, propMode=explicit `SOCCER_PROPS_MODE` else `min(master,'shadow')` — **inherited enforce CAPPED at shadow**, so a match-level enforce flip never silently enforces props). Every `gradeSoccerBet` result carries an additive `marketClass:'match_level'|'prop'` (tagged at the `gradeSoccerBet` boundary: prop self-tags at its fork, all else defaults match_level); `routeSoccer` selects `classMode` by that tag, then `off`→fall-through `soccer_props_off` (discard, no grade/emit — only reachable via explicit props-off while master on), `shadow`→emit `soccer_grade_shadow` (every outcome — see fidelity) + fall-through `soccer_shadow` (NO grade), `enforce`→return the adapter's real result. `ADAPTERS` has a `SOCCER: soccer` entry for direct access but it is NOT reached via `isPropBet` (that lookup keys on `normalizeSport`→null). `grading.js`'s structured gate admits soccer via `soccerStructuredEligible(bet)` (soccer sport AND master≠off), so **off is byte-identical** (soccer never reaches the adapter); **deploy-safe:** prod `SOCCER_GRADER_MODE=shadow` + `SOCCER_PROPS_MODE` unset → match-level shadow AND props inherited-shadow → no behavior change. **`hasDeterministicAdapter(sport)` (Build 1d, exported):** SINGLE SOURCE OF TRUTH for the no-data auto-void exemption (`grading.js shouldAutoVoidNoData`). Pure, never throws, casing-insensitive, unknown→false. UNION of every deterministic path, each matched the SAME way its real call site matches: `ADAPTERS[normalizeSport(sport)]` (MLB/NBA/NHL structured) ∪ `isSoccerSport(sport)` (Soccer/World Cup/FIFA — normalizeSport deliberately won't map soccer) ∪ `ESPN_SPORTS` (a `Set` of `espn.ESPN_ENDPOINTS` keys — exact-uppercase, adds NFL; DERIVED from espn.js not re-hardcoded, so a new ESPN endpoint auto-extends coverage). Soccer is covered by SPORT, NOT by `SOCCER_GRADER_MODE` — the adapter exists, so the void is wrong regardless of mode (Build 2 re-grades the back catalog). Auto-extends to KBO/UFC the moment those register in `ADAPTERS`/`normalizeSport` or `ESPN_ENDPOINTS`. NEW top-level `require('../espn')` (espn.js is a leaf — no cycle). **Accepted imprecision** (low-volume, documented at the fn): substring matching over-exempts a few sourceless cousins (`WNBA`→NBA, `NCAA Baseball`→MLB, `Beach Soccer`/`eSoccer`→soccer) — they skip the 12h void but the untouched 7-day sweeper still backstops non-prop bets; tightening would touch `normalizeSport` (shared coverage proxy, out of scope). `tests/autovoid-adapter-exemption.test.js` (49 assertions; incl. the parlay `-leg%` LIKE branch + an orthogonal age-gate control). |
| soccer.js | ESPN soccer public API adapter (`site.api.espn.com/.../soccer/<slug>`) — unofficial, no auth — **MATCH-LEVEL + PLAYER PROPS**, slug **fifa.world** only. `gradeSoccerBet(description, dateYMD, {slug})` → `{resolved:true,status,evidence,source:'espn_soccer',match_id}` \| `{resolved:false,reason,match_id?}`. **MATCH-LEVEL:** resolves the match from `scoreboard?dates=YYYYMMDD` across `dateYMD ± 1` (TZ slack), matching team(s) by ESPN displayName/shortDisplayName/abbreviation(≥3)/location + a national-team alias map (USA→United States, Bosnia→Bosnia-Herzegovina, …). Exactly ONE candidate event required (0 / >1 / named-matchup-with-wrong-opponent → `no_match_found`). Finality gate: `status.type.completed !== true` → `match_not_final`. **GOTCHA #1:** W/L/D from `competitors[].winner`, NEVER score equality (penalty shootouts show equal scores; verified vs ARG-FRA 2022 final). Markets: ML (3-way win — bare ML, draw loses), draw, double chance (`Team or Draw` / `1X`/`X2`/`12`), FT total O/U (needs both teams named), team total (`team total`/`team goals` phrasing), spread/handicap (whole+half lines; quarter/Asian-split → `unsupported_line`), BTTS yes/no, half totals (need `linescores`, which the scoreboard endpoint omits in prod → `no_linescores` fall-through). **PLAYER PROPS (Build 1b, same `SOCCER_GRADER_MODE` flag):** `parseSoccerProp` recognises only the CONFIRMED markets and `gradeSoccerProp` settles them off the **SUMMARY** endpoint (`summary?event=ID`), NOT the scoreboard. **CONFIRMED-FIELDS** (recon vs live 2026 WC, 44 completed matches): shots→`totalShots`, shots-on-target→`shotsOnTarget`, GK saves→`saves` (present only on goalkeepers), anytime/first goalscorer + to-score-or-assist→`keyEvents[].scoringPlay` (`participants[0]`=scorer / `[1]`=assist, both invariants 44/44 & 22/22). **Own goals carry `scoringPlay==true` (type.id 97) → EXCLUDED; penalties (98) count.** keyEvents are complete vs the scoreline (44/44) — a mismatch → `keyevents_incomplete` fall-through. Most prop legs name only the player, so the match is resolved **player-first**: scan the slate's events for a roster match (a named opponent narrows the scan; bound `MAX_SLATE_SUMMARIES`). **WRONG-PLAYER RULE:** require a GLOBALLY UNIQUE roster match — accent-folded token-subset + surname anchor; a name/surname matching >1 athlete (across or within events) or 0 → `no_unique_player`/`player_not_found` fall-through, NEVER a guess (PR #135 lesson). **DNP** (rostered but did-not-appear: `appearances==0` & !starter & !subbedIn) → **VOID** (`voidPlayerDidNotPlay` semantics, PR #128/#129 "never LOSS" — a deliberate deviation from the prompt's literal LOSS, flagged for sign-off before enforce). Saves prop on an outfielder → `player_stat_missing`. Remaining player/side markets (cards / corners / booking / last-scorer / standalone assists / bare "to score" / 2-Up cashout / draw-no-bet) still → `unsupported_market_soccer`. **Build 1c:** `gradeSoccerBet` is a thin wrapper over `gradeSoccerBetImpl` that tags the result `marketClass:'match_level'|'prop'` (additive; prop self-tags at the fork via `tagClass`, applied at the boundary NOT inside `ok`/`no`/`settleOverUnder`); the **empty-slate** fall-through is the distinct reason **`slate_empty`** (was `no_match_found`) in both `gradeSoccerProp` (events empty) and `resolveMatch` (only when `events.length===0`; a populated-but-unmatched slate stays `no_match_found`) — relabel only, the set of bets that resolve vs fall through is unchanged. `tests/soccer-grader.test.js` (154 assertions). |
| mlb.js | MLB Stats API adapter (`statsapi.mlb.com/api/v1`) — official, no auth. **Mis-routed player-prop guard (`looksLikeMisroutedPlayerProp`, exported + tested):** `gradeMlbBet` refuses (`{resolved:false, reason:'player_prop_misrouted_to_total'}`, BEFORE any fetch, right after the `isTeamTotalBet` guard) when the description names a non-run PLAYER stat. A leg shaped `"Team vs Team Over 0.5 PLAYER - HITS"` fails prop routing (subject canonicalizes to a team — e.g. `"Masyn Winn"` → `'as'` → Athletics — or name unrecognized) and falls through here; the total branch read `"Over 0.5"` as a run line vs the real game total (>0.5) → FALSE WIN (6 bets manually fixed to LOSS, −74.42u). Detection = whole-word whole-description token scan (`PLAYER_STAT_TOKEN_RX`: full words + book abbrevs ks/k/so/bb/sb/er/po/hr; `tb` EXCLUDED = Tampa Bay; `runs`/`r` excluded so run totals + inning/NRFI still grade) + a parser fallback for bare single-letter `H` (parses-as-prop + subject-canonicalizes-to-team + non-run stat). Whole-text scan is deliberate: the prop parser's `resolveStat` mis-resolves a stray letter in the player name (the `r` in "Tarik") to `runs`. Guard-only — does NOT re-route to the prop grader. `tests/mlb-prop-total-guard.test.js`. **Matchup-prefix reroute (`rewriteMatchupPrefixedProp`, exported + tested — #135 follow-up to #130):** the inverse of the guard above — strips the matchup prefix from a leg shaped `"Team vs Team (Over\|Under) N PLAYER [-] STAT"` and returns the canonical `"<PLAYER> Over/Under N <stat>"` (or `null`). The router (index.js) grades a non-null result via `gradeMlbPlayerProp`, so the **recognized** ones grade instead of piling up in manual review. Fires only when the tail names a **non-run** player stat (the SAME `PLAYER_STAT_TOKEN_RX` signal #130 refuses on, inverted — so a real run total `"… Under 8.5 Total Runs"` → `null` → still grades as a total) AND the tail splits into a non-empty `<player>` + `<stat>` (a bare game-stat market `"… Over 8.5 Total Bases"` with no player → `null` → still #130-refused). Split = spaced-dash (`<player> - <stat>`, an intra-name hyphen survives) else the trailing recognized stat phrase. `gradeMlbBet` is UNCHANGED — it stays the last-line refusal for anything that still reaches it; the no-false-WIN guarantee holds because `gradeMlbPlayerProp` can only ever return a player result / DNP VOID / `{resolved:false}`, never a game total. `tests/mlb-matchup-prop-reroute.test.js`. |
| nhl.js | NHL Web API adapter (`api-web.nhle.com/v1`) — no auth. **Word-boundary `canonicalize`:** matches each alias only as a whole word (`\b` + `escapeRegex`, exact-hit fast path + longest-alias-first kept) instead of `lower.includes(alias)` — the MLB parity fix, so a surname embedding a short alias (`habs` ⊂ "Habscheid", `wild` ⊂ "Wilde", `kings` ⊂ "Kingsley") no longer resolves to a team (which had made `looksLikePlayerProp` reject clean props / could route a prop to the game-total grader). All 49 aliases (incl. multi-word `maple leafs`/`blue jackets`/`golden knights`/`red wings` + abbrevs `vgk`/`cbj`/`avs`) still resolve. `tests/nba-nhl-canonicalize-substring.test.js`. |
| nba.js | ESPN NBA public API adapter (`site.api.espn.com`) — unofficial, no auth. **Word-boundary `canonicalize`:** same MLB parity fix (`\b` + `escapeRegex`, fast path + longest-first kept) — a surname embedding a short alias (`heat` ⊂ "Heatley", `kings` ⊂ "Kingsley") no longer resolves to a team. All 37 aliases (incl. multi-word `trail blazers`, digit-prefixed `76ers`, abbrevs `okc`/`gsw`) still resolve. `tests/nba-nhl-canonicalize-substring.test.js`. |
| mlb.js | MLB Stats API adapter (`statsapi.mlb.com/api/v1`) — official, no auth. **Mis-routed player-prop guard (`looksLikeMisroutedPlayerProp`, exported + tested):** `gradeMlbBet` refuses (`{resolved:false, reason:'player_prop_misrouted_to_total'}`, BEFORE any fetch, right after the `isTeamTotalBet` guard) when the description names a non-run PLAYER stat. A leg shaped `"Team vs Team Over 0.5 PLAYER - HITS"` fails prop routing (its **subject before the O/U** — the `"Team vs Team"` prefix — canonicalizes to a team, or the name is unrecognized) and falls through here; the total branch read `"Over 0.5"` as a run line vs the real game total (>0.5) → FALSE WIN (6 bets manually fixed to LOSS, −74.42u). Detection = whole-word whole-description token scan (`PLAYER_STAT_TOKEN_RX`: full words + book abbrevs ks/k/so/bb/sb/er/po/hr; `tb` EXCLUDED = Tampa Bay; `runs`/`r` excluded so run totals + inning/NRFI still grade) + a parser fallback for bare single-letter `H` (parses-as-prop + subject-canonicalizes-to-team + non-run stat). Whole-text scan is deliberate: the prop parser's `resolveStat` mis-resolves a stray letter in the player name (the `r` in "Tarik") to `runs`. Guard-only — does NOT re-route to the prop grader. `tests/mlb-prop-total-guard.test.js`. **Matchup-prefix reroute (`rewriteMatchupPrefixedProp`, exported + tested — #135 follow-up to #130):** the inverse of the guard above — strips the matchup prefix from a leg shaped `"Team vs Team (Over\|Under) N PLAYER [-] STAT"` and returns the canonical `"<PLAYER> Over/Under N <stat>"` (or `null`). The router (index.js) grades a non-null result via `gradeMlbPlayerProp`, so the **recognized** ones grade instead of piling up in manual review. Fires only when the tail names a **non-run** player stat (the SAME `PLAYER_STAT_TOKEN_RX` signal #130 refuses on, inverted — so a real run total `"… Under 8.5 Total Runs"` → `null` → still grades as a total) AND the tail splits into a non-empty `<player>` + `<stat>` (a bare game-stat market `"… Over 8.5 Total Bases"` with no player → `null` → still #130-refused). Split = spaced-dash (`<player> - <stat>`, an intra-name hyphen survives) else the trailing recognized stat phrase. `gradeMlbBet` is UNCHANGED — it stays the last-line refusal for anything that still reaches it; the no-false-WIN guarantee holds because `gradeMlbPlayerProp` can only ever return a player result / DNP VOID / `{resolved:false}`, never a game total. `tests/mlb-matchup-prop-reroute.test.js`. **Word-boundary `canonicalize` + surname-collision guard (root-cause hardening below #130):** `canonicalize(teamText)` now matches each of the 37 `TEAM_ALIASES` only as a **whole word** (`\b`-anchored, regex-escaped via `escapeRegex`; exact-hit fast path kept) instead of `lower.includes(alias)`. The substring form resolved valid surnames to teams (`'as'` ⊂ "Ya**s**trzemski" / "Ma**s**yn" → Athletics), which BOTH made `looksLikePlayerProp` reject clean props AND was the route by which `"Masyn Winn"` mis-fed the game-total grader (the #130 false-WIN). Post-fix `"Mike Yastrzemski Over 0.5 Hits"` / `"Masyn Winn Over 0.5 Hits"` route to `gradeMlbPlayerProp`; `"Atlanta Braves ML"` / `"As"` / `"Reds vs Cubs"` and all 37 aliases (incl. multi-word `red sox`/`blue jays`/`white sox` and punctuation-adjacent `a's`/`d-backs`) still resolve. Separately, `findPlayerInBoxscore(bs, lastName, firstName=null)` (now exported; surname match logic factored into `collectSurnameMatches`) returns `null` when **no first name** is given AND **2+ same-surname** players are active that day (was: silently the first match) → never a wrong-player grade. `findPlayerGame` re-counts the matches on a miss and sets `anyAmbiguous` on the not-found record; `gradeMlbPlayerProp`'s VOID gate is `!result.anyAmbiguous && … && isProvableAbsence(result)`, so a **collision is INDETERMINATE → falls through to search, NEVER a fabricated "did not play" VOID** (distinct from a true unique-surname absence, which still VOIDs on a provable-absence final slate). First-name legs keep the existing disambiguation untouched. `tests/mlb-canonicalize-substring-surname.test.js`. Deliberately UNCHANGED (out of scope): NBA/NHL `canonicalize` twins + `gradeMlbBet`'s separate `teamHits` substring scan. |
| nhl.js | NHL Web API adapter (`api-web.nhle.com/v1`) — no auth |
| nba.js | ESPN NBA public API adapter (`site.api.espn.com`) — unofficial, no auth |

### services/holdReview.js
> Line numbers refreshed 2026-06-08 (Phase 2b-2 #59 backdate + #62 sweeper-grace):
> `_backdateRecoveredBets` (#59) and `GRACE_DAYS`/`_graceMarkRecoveredBets` (#62)
> were inserted between `_resolveRecoveredHold` and `recoverHold`, shifting
> `recoverHold` and everything below it down by ~+51. (Prior: 2026-06-07 Phase 2b-2
> Recover inserted `recoverHold` core + helpers ~+233; 2026-06-06 Phase 2b-1
> Dismiss inserted `dismissHold` ~+92.)

| What | Line(s) |
| --- | --- |
| `handleHoldInteraction` (button handler) | 21 |
| **`dismissHold(ingestId, actor)`** — exported transport-agnostic Dismiss core (Phase 2b-1). Interaction-free. One `db.transaction`: (1) `recordStage(MANUAL_REVIEW_DISMISSED, {dismissed_by:actor})` + (2) `hold_review_decisions` row `human_decision='dismissed'`, actor→`reviewed_by`. Idempotent via latest-of-3-stages: `not_found`/`already_released`(refuse)/`already_dismissed`(no-op)/`dismissed`. Never touches a bet. | 84 |
| **`recoverHold(ingestId, actor, deps)`** — exported transport-agnostic On-demand Unfurl Recovery core (Phase 2b-2). Async, interaction-free. For the grade-before-unfurl race: re-fetches the held (now-unfurled) message and runs the EXISTING vision_slip path (`_defaultExtract` → `resolveCapper`+`getOrCreateCapper` → `messageHandler.processSlipImage` per `origin:'attachment'` image → `createBetWithLegs(source:'vision_slip')`); **no raw bet SQL, creation-time is_bet gates untouched**. Idempotent on `bets.source_message_id` — checked BEFORE the terminal-stage check so a re-run is `already_recovered`, not `already_resolved`; self-heals a bet-created-but-hold-open partial run. Resolves via `MANUAL_REVIEW_RELEASED` + `hold_review_decisions` row (`human_decision='recovered'`, `source_label='unfurl_recovery'`, `reparse_input_source='image'`) in one `db.transaction` (helper `_resolveRecoveredHold` L251). On success runs `_backdateRecoveredBets` (#59) then `_graceMarkRecoveredBets` (#62) before resolving. Statuses: `not_found`/`already_recovered`/`already_resolved`/`message_unreachable`/`no_image_yet`/`no_bet_found`/`recovered`. Discord fetch + extraction injectable via `deps` for tests; prod lazy-requires the (already-cached) messageHandler. | 340 |
| `_backdateRecoveredBets(id, betIds, message)` (#59) — backdates the recovered bet's `created_at`+`event_date` to the original slip post time so every grader family anchors the real game date; holdReview-only, hot path untouched. Called from `recoverHold` L427. | 314 |
| `GRACE_DAYS=3` + `_graceMarkRecoveredBets(id, betIds)` (#62) — `UPDATE bets SET sweep_exempt_until = datetime('now','+3 days')` (recovery moment, NOT backdated) on every recovery, right after the backdate (called L428). Self-expiring 7-Day-Sweeper grace; both exported. See §7-Day Sweeper + recovery grace. | 333 / 334 |
| `dismissHold` / `recoverHold` / `GRACE_DAYS` / `_graceMarkRecoveredBets` export | 636 |
| Dismiss flow | 437 (`handleDismiss` — thin wrapper calling `dismissHold(ingestId, interaction.user.tag)`); routed L34 |
| Release modal | 467 (`ModalBuilder`, customId `hold:releasemodal:`); `handleReleaseModal` L510 |
| SELECT WHERE stage='MANUAL_REVIEW_HOLD' query (`loadHoldEvent`, reused by `recoverHold`) | 42–47 (reads `pipeline_events.payload`) |
| `createBetWithLegs(source='manual_hold_release')` call (Release modal, `handleReleaseModal` L510) | source field L566 |
| `postNewPick` call | 585 (import L13) |

> **Dismiss `human_decision` value:** the live writer is `'dismissed'` (past tense),
> set by `scripts/review-holds.js:596` and now `holdReview.dismissHold` — NOT
> `'dismiss'` as the Enums section below states. The column has no CHECK; the only
> producers agree on `'dismissed'`/`'released'`/`'released_with_edits'`/`'skipped'`.

### 7-Day Sweeper + recovery grace (#62)

The grading cron's **7-Day Smart Sweeper** auto-grades any pending **non-prop** bet older than `SWEEP_DAYS` (7) as a LOSS. `recoverHold` backdates a recovered bet's `created_at` to the slip post time (#59), which would make it instantly sweep-eligible → false LOSS before the grader runs. Migration **028** adds `bets.sweep_exempt_until` (TEXT, NULL default) as a self-expiring grace marker the sweeper honors.

| What | Line(s) |
| --- | --- |
| `PROP_KEYWORDS` (prop-exemption regex) | `services/grading.js:735` |
| `SWEEP_DAYS=7` / `SWEEP_CUTOFF_MS` (hoisted to module scope) | `services/grading.js:1128` / 1129 |
| `sweepGraceUntil(betId)` — returns `sweep_exempt_until` iff set AND `datetime('now') < sweep_exempt_until` (comparison runs in SQLite, same clock/format the marker was written with), else null; reads the column fresh by id | `services/grading.js:1141` |
| `evaluateSweep(bet, now)` — pure policy → `{eligible, reason: 'fresh'\|'prop'\|'grace'\|'eligible'}` (age cutoff → prop exemption → grace check); `now` injectable, unit-tested (`tests/sweeper-grace.test.js`) | `services/grading.js:1154` |
| `runAutoGrade(client)` — calls `evaluateSweep`; a `reason='grace'` bet is left **pending** (skip, never drop/finalize) + logged `[Sweeper] Grace skip …` (L1267). Past the window it sweeps normally. Exports `evaluateSweep`/`sweepGraceUntil` L2653 | `services/grading.js:1165` |
| `GRACE_DAYS=3` + `_graceMarkRecoveredBets` — stamp `sweep_exempt_until = datetime('now','+3 days')` on every recovery (recovery moment, NOT backdated). `approveBet` (`services/database.js`) stamps the same +3d window on every approval of a still-pending bet | `services/holdReview.js:333` / 334 (see holdReview.js above) |

`migrations/028_add_sweep_exempt_until.sql`: `ALTER TABLE bets ADD COLUMN sweep_exempt_until TEXT DEFAULT NULL;` — no index (the sweeper probes the column by PK). NULL = "no grace, sweep normally". Grace is measured from the stamping moment — recovery (`_graceMarkRecoveredBets`) or war-room approval (`approveBet`, `services/database.js`) — so a genuinely un-gradeable bet still sweeps once the 3 days lapse.

### routes/ — Admin HTTP API
| What | Line(s) |
| --- | --- |
| `routes/adminAuth.js` | `adminAuth` fail-closed Bearer middleware + `safeEqual` (extracted from admin.js so the Phase 2b write router reuses the identical check). 503 if `ADMIN_API_SECRET` unset, 401 missing header, 403 mismatch. |
| `routes/admin.js` | READ-ONLY `/api/admin/*` (Phase 2a-1, `ADMIN_API_SECRET` via router-wide `router.use(adminAuth)` L39): GET `/holds` L66, `/bets` L183, `/handles` L226 (all `scraper_handles` rows → `{count, handles:[{handle,enabled,added_at,note}]}`, ordered by handle), `/logs` L243 (tails `#admin-log`); catch-all 404. Now imports `adminAuth` from `./adminAuth`. Mounted bot.js L28. **`imageUrl` per hold (#119):** each `/holds` row now carries `imageUrl: imageUrlFor(r.ingest_id)` (L156, next to `messageUrl` L155) — joined by `ingest_id` from a SEPARATE EXTRACTED-event `pipeline_events` row. The lookup `imageUrlStmt` (L98–104) is KEY-AWARE/tightened: `payload LIKE '%"imageUrl"%'` (embedded JSON-key quotes, not naive `%imageUrl%`), `ORDER BY created_at DESC, id DESC LIMIT 10`; `imageUrlFor` (L105–119) `.all()`s newest-first and returns the first row that `JSON.parse`s to a non-empty string `imageUrl`, SKIPPING rows that merely mention the word (defeats the shadowing case where a newer keyless hold's `sample` contains "imageUrl"). `null` when ingest_id falsy or no usable row. Value returned UNFILTERED (promo art / video thumbs surface too — dashboard classifies). dedup/resolved-filter/shape otherwise byte-identical. **Caveat (code comment L60–65, NOT fixed):** `messageHandler.js:1058` clips the stored url to `slice(0,120)`, so long signed Discord CDN urls arrive truncated; twitter holds + multi-image Discord holds store only `{imageCount}` (no `imageUrl`) → always `null`. |
| `routes/adminCommands.js` | WRITE `/api/admin/*` (Phase 2b, `ADMIN_API_SECRET` via `adminAuth`): `POST /holds/:ingestId/dismiss` → `dismissHold` (200 dismissed/already_dismissed, 409 already_released, 404 not_found, 400 malformed; `handleDismissRoute` L72, route L96); `POST /holds/:ingestId/recover` (Phase 2b-2) → `recoverHold` (200 recovered/already_recovered, 409 already_resolved, 404 not_found, 422 no_image_yet/no_bet_found, 502 message_unreachable, 400 malformed; `handleRecoverRoute(req,res,deps)` L118, route L147 — `deps` is a test-only injection seam, prod route passes none); `POST /handles/:handle` → `handleSetHandleRoute` (L162, route L208): toggles a **seeded** `scraper_handles` row's `enabled` (int `0/1` or bool, required) + optional `note` (`COALESCE`; omitted leaves it); **never inserts** → unknown handle 404; 200 updated / 400 malformed / 500 error; **`POST /bets/:id/approve`** (#116) → `handleApproveRoute` (L220, route L249) releases a `needs_review` bet for the dashboard: reads ONLY `req.params.id` (no body), FULL-id exact match (not the slash command's partial-id LIKE), calls the SHARED atomic `approveBet(id)` (`services/database.js:967` — no parallel write path, so #89/#92/#93 protections + 3-day sweep grace hold). 200 `{ok:true,status:'approved',bet}` / 409 `not_approvable` (gate didn't match: missing/already-confirmed/terminal) / 400 `malformed` / 500 `error`. Live behind `adminAuth`; inert only until the dashboard frontend + proxy allowlist wire it. All `handle*Route` fns exported for unit tests. **Mounted in bot.js L22 BEFORE the read router (L28)** so its catch-all 404 can't intercept the POSTs. |

> **`scraper_handles` management (mig 027; #46 table+seed+scraper read, #54 admin write toggle).** One table, two authed surfaces:
> - **Operator / dashboard** — `ADMIN_API_SECRET`: read `GET /api/admin/handles` (`routes/admin.js:226`, all rows) + write `POST /api/admin/handles/:handle` (`routes/adminCommands.js:162`, toggle `enabled`/`note` on a seeded row). The external dashboard's **Handles tab** is built on these two.
> - **Scraper-facing** — `MOBILE_SCRAPER_SECRET` (a *separate* secret): read-only `GET /api/scraper-handles` (`routes/api.js:68`) → just the `enabled = 1` handle names; the Surface Pro poller reads it each cycle. Toggling `enabled=0` is how a handle is turned off (e.g. `guess_pray_bets` — GNP now arrives via the DubClub bridge, not the scraper). Seed (`migrations/027_scraper_handles.sql`, 9 handles, `INSERT OR IGNORE`) preserves manual `enabled`/`note` edits across restarts.

### services/pipeline-events.js
| What | Line(s) |
| --- | --- |
| Stage enum | 18 (`STAGES`); `EVENT_TYPES` L34; `DROP_REASONS` L43 |
| `event_aware_shadow` event_type (#124) — registered in `EVENT_TYPES`; shadow-only would-fire telemetry on stage `GRADING_ENTER`, one row per recheck/defer decision (`kind: would_window\|would_defer`, payload `{phase, reason, wouldNext, flatNext, betId}`). Additive/observational, never gates behavior (enforce acts via `grading_next_attempt_at` instead); NOT in `EXPECTED_STAGES`. Written by `emitEventAwareShadow` (`services/grading.js:1017`); enforce emits none. | 42 |
| `soccer_grade_shadow` event_type (Build 1) — registered in `EVENT_TYPES`; shadow-only would-fire telemetry on stage `GRADING_ENTER`, one row per soccer bet/leg in a class whose effective mode is `shadow`. Payload `{bet_id, market_class, would_status, reason, evidence, source:'espn_soccer', match_id, slug:'fifa.world', desc_or_leg}`. **Build 1c shadow fidelity:** `shouldEmitSoccerShadow` now emits for EVERY adapter outcome — resolved would-verdicts (WIN/LOSS/PUSH/VOID) AND every fall-through reason string. The prop-resolution reasons that used to be SILENTLY dropped (`player_not_found`/`no_unique_player`/`slate_too_large`/`player_stat_missing`/`keyevents_incomplete`/`fetch_error`) and the new distinct `slate_empty` are now all observable, so the prop metric is readable; the additive `market_class` (`match_level`\|`prop`) separates the two paths in the metric. (Routing-level failures generated BEFORE the grader — `no_bet_date`, `adapter_error` — short-circuit and never emit.) Additive/observational, NO grade write (shadow returns fall-through); enforce returns the resolved status and emits NONE. NOT in `EXPECTED_STAGES`. Written by `emitSoccerShadow` (`services/sportsdata/index.js`). | 44 |
| `warnUnknownEnums` (write-boundary warn-only validator) | 142 (called from the single write boundary 169) |
| `recordStage` | 192 |
| `recordDrop` | 210 |
| `recordError` | 226 |
| `makeIngestId` | 256 |
| EXPECTED_STAGES for pipelineHealth | NOT in this file — services/pipelineHealth.js:31 |

### services/warRoom.js
| What | Line(s) |
| --- | --- |
| `sendStagingEmbed` | 26 |
| Edit modal capper lookup (v463 fix, commit 5efcdd8) | 617 (strict `cappers` lookup in `war_modal` submit; field read L605, reattribution L625) |

### services/database.js
> Line numbers refreshed 2026-06-10 **evening batch 2** (PR #77 `3ed77e2`, `main`@3ed77e2): the unified ROI block (`SETTLED_BET` + `CAPPER_STATS_COLUMNS` + `flagAbnormalRoi`) replaced the two inline ROI copies in `getCapperStats`/`getLeaderboard` (net +52), shifting everything below ~L790 down. Rows re-verified against `main`.

| What | Line(s) |
| --- | --- |
| `getOrCreateCapper` | 321 |
| `createBet` (single-bet insert; **write-gates `event_date`** via `normalizeEventDateForStorage` from `services/eventDate.js`) | 350 (fn); event_date gate at the INSERT, L369 |
| `createBetWithLegs` | 602 |
| **Capper ROI — single source of truth (#77).** `SETTLED_BET` SQL fragment (`result IN ('win','loss','push') AND profit_units IS NOT NULL`) + `CAPPER_STATS_COLUMNS` (the win/loss/push/win_pct/total_profit_units/`roi_pct` column block) are defined **once** and interpolated verbatim into both `getCapperStats` and `getLeaderboard` so the two can't drift. `roi_pct` = `Σ(profit_units) ÷ Σ(CAST(units AS REAL))` over `SETTLED_BET` rows, `NULLIF(denom,0)`+`COALESCE`-guarded (always finite, 0 when nothing settled); **no `MAX(units,1)` floor, no display cap.** | `SETTLED_BET` 775; `CAPPER_STATS_COLUMNS` 776 |
| `flagAbnormalRoi(row)` — #77: *logs* (never clamps) `Math.abs(roi_pct) > 500`; called by `getCapperStats` + `rows.forEach` in `getLeaderboard` | 794 |
| `getCapperStats` (selects `CAPPER_STATS_COLUMNS` + `pending`; one capper) | 800 |
| `getLeaderboard` (selects `CAPPER_STATS_COLUMNS`; sorted, limited) | 816 |
| `findPendingBetBySubject` | 1032 |
| `getPendingBets` — the autograder + 7-day sweeper's ONLY source. NULL-safe `needs_review`/`manual_review_unmodeled_sport` exclusion via `AND (b.review_status IS NULL OR b.review_status NOT IN (...))` (#89/#113), keyed on `GRADER_HIDDEN_REVIEW_STATUSES` | 690 (`GRADER_HIDDEN_REVIEW_STATUSES` 683; guard clause 701) |
| `approveBet(betId)` — single atomic UPDATE gated `WHERE id = ? AND review_status = 'needs_review' AND result = 'pending'`; sets `confirmed`/`grading_state='ready'`/`attempts=0`, nulls lock/next-attempt/last-failure, stamps `sweep_exempt_until = datetime('now','+3 days')` (#89/#92/#93). `info.changes === 0 → null`. Shared by the `/admin` approve-by-id slash command AND the `POST /api/admin/bets/:id/approve` HTTP route (#116) — no parallel write path | 967 (`stmts.approveBet` SQL 233–241) |
| `gradeBet` (`= gradeBetRecord`). **#118 opt-in:** the `provenance` arg (default `{}`) carries `requireGraderEligible`; when truthy, the UPDATE appends the same NULL-safe review-status gate (built 643–645, bound 660) — the write-time dual of `getPendingBets`' guard. Default OFF (gate disabled), so the human/trusted callers (war-room untracked-win, `/grade`, admin revert-void, capper-celebration) are byte-unchanged; only `finalizeBetGrading` (3351) and the 7-day sweeper (1641) opt in | 620 (fn; gate-build 643–645, bind 660); exported as `gradeBet` 1181 |

### services/eventDate.js (event_date write-gate, #70 + mig 029)
The single write-path normalizer for `bets.event_date`. `normalizeEventDateForStorage(raw, createdAt=now)` returns **NULL or a parseable datetime** — rejects time-only (`"9:10PM ET"`) and free-text, ET-anchors wall-clock dates to UTC. Called from `createBet` (`database.js:369`) so every write is gated. The same rule was applied to existing rows by mig **029**; the read-side skew fallback lives in `grading.js` GUARD 3 (marker `grade.event_date_skew_fallback`).

| What | Line(s) |
| --- | --- |
| `normalizeEventDateForStorage` (the write gate; exported) | 78 |
| `etWallClockToUtc` / `etParts` (ET helpers; exported) | 52 / 34 |

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
| `/admin dedup-stats-24h` | 144 (def), 922 (handler) |
| `/admin status` grading-health backend snapshot — `fmtBackend` (#74) now reads structured `getBackendSnapshot()` (was `backendHealth`) and renders all five states with last-success age: `idle` / `healthy (Nm ago)` / `failing` / `OPEN (…m) \| last ok …` (gated, searchWeb skipping) / `DEGRADED (…fails) \| last ok …` (un-gated bing/serper, circuit open but still tried) | `getBackendSnapshot` import 598; `snapById` build 606; `fmtBackend` 608 |

> Resolver fully retired: `commands/admin.js` contains zero resolver references
> today, `services/resolver.js` is deleted, and the `fly.toml`
> `RESOLVER_URL`/`RESOLVER_VERSION` `[env]` entries were **removed in #76** (no JS
> read them). The `zonetracker-resolver` Fly app is **destroyed** (was suspended;
> destroyed 2026-06-10 evening). Only the orphaned `resolver_events` table
> (481 rows) remains in the DB.

### scripts/
| Script | Purpose |
| --- | --- |
| review-holds.js | Re-parse unresolved MANUAL_REVIEW_HOLD, prompt r/e/d/s/q, optional release |
| retro-parlay-loss.js | Bug A Part 2 retro-fix (already run, kept for reference) |
| regrade-export.js | Pull batches of 25 pending bets for parallel Claude/ChatGPT grading |
| test-dedup-normalization.js | Validates parlay leg dedup normalizer |
| backfill-hold-embeds.js | v447 hold-embed backfill (PR #29) |
| test-team-disambiguation.js | Regression harness for `normalizeDescription` bare-city injection (Bug 1) + shared-nickname sport disambiguation (Bug 2) (PR #36). Run: `node scripts/test-team-disambiguation.js` |
| backfill-sport-casing.js | One-shot **idempotent** sport-casing backfill for `bets.sport` + `grading_audit.sport_out`. Reuses the shared `canonicalizeSport()`. Default = **dry-run** (opens DB `{readonly:true}`); `--apply` executes per-value UPDATEs in one transaction. Safe to re-run (2nd `--apply` = 0 rows). Run post-deploy. |

## Twitter ingest — Surface scraper → /mobile-ingest → F-12 dedup

> Code refs accurate as of `main` post-#53 (commit `3cfc694`, 2026-06-07). This is the **direct HTTP** Twitter path through `services/twitter-handler.js`. It is NOT the **Twitter relay channels** (Dan/Cody/Harry/Gavin) under "Channels — ingestion routing" below: those arrive as Discord *messages* and run the `messageHandler` pipeline, so they never reach the F-12 gate.

**Source.** The live Twitter feed is the Surface Pro scraper (`zonetracker-scraper`, private repo — see its README "Polling & cursor behavior"), which POSTs tweet batches to the Fly Express endpoint `POST /api/mobile-ingest` (`routes/api.js:19`; router mounted at `/api` in `bot.js`). Auth: the `x-mobile-secret` header must equal `MOBILE_SCRAPER_SECRET` (`routes/api.js:21-22`), else 401. The route 200s immediately, then processes async via `handleTwitterWebhookPayload` (`routes/api.js:55`). The scraper pulls its handle list from `GET /api/scraper-handles` (`routes/api.js:68`; `scraper_handles` table, mig 027). Fly's own twitterapi.io poller (`services/twitter.js:90`) feeds the *same* handler; it is **enabled by default** and kill-switched only by the `TWITTER_POLLER_DISABLED='true'` Fly secret — not removed and not paused in committed config (see "Env vars that gate behavior"). Whether it is live in prod depends on that runtime secret; the scraper is the other source.

> **Two different tables, two different jobs — scrape set vs capper attribution (do not conflate; root cause of duplicate-capper splits).**
> - **`scraper_handles` (Fly, mig 027) = the SCRAPE SET** — *which accounts to poll*. The single source of truth, served to the box at `HANDLES_URL` = `GET /api/scraper-handles` (`x-mobile-secret` auth, `enabled=1` only). The scraper's local `active_handles.json` is a **write-through cache with a built-in fallback** — it mirrors the Fly list each fetch and falls back to its last good copy if the endpoint is unreachable; it is **not** authoritative.
> - **`tracked_twitter.display_name` = capper ATTRIBUTION** — *which capper a scraped tweet's bets file under*. A handle **without** a matching `tracked_twitter` row attributes under its **raw handle** (creating a stray duplicate capper) rather than the intended display name. This is the root cause of the `LockedIn` / `lockedin_sportz` and `guess_pray_bets` duplicate-capper splits: adding a `tracked_twitter` row (`display_name='LockedIn'`, the 2026-06-10 swap) fixes attribution **going forward**, but pre-existing raw-handle bets still need a merge (see BACKLOG "Capper dedup / merge").
> - **Takeaway:** enabling a handle in `scraper_handles` makes it *scraped*; inserting the paired `tracked_twitter` row makes it *attributed*. Both are required for a clean capper.

**Handler.** `services/twitter-handler.js` → `handleTwitterWebhookPayload(payload, client)` (L92), one iteration per tweet. Stages emitted via `recordStage`:

| Stage | Line | Notes |
|---|---|---|
| RECEIVED | 122 | tweet has id + text |
| AUTHORIZED | 137 | after `processed_tweets` id-dedup + RT/reply/settled pre-filter pass |
| EXTRACTED | 170 | **images only** — recorded before the Vision AI call |
| PARSED | 191 / 200 / 207 | vision / text-fallback / text |
| VALIDATED | 262 | after `validateParsedBet` hallucination guard |
| STAGED | 298 / 325 | `STAGE_EXIT`, after `createBetWithLegs` |

Pre-filter drops between RECEIVED and PARSED emit DROPPED (not a named stage): `processed_tweets` id-dedup → `DUPLICATE_IMAGE` (L131), retweet/reply → `BOUNCER_REJECTED` (L142 / L149), `evaluateTweet` settled/recap → `PRE_FILTER_NO_BET_CONTENT` (L159 / L166).

**F-12 content-window repost dedup** (the gate). Sits AFTER VALIDATED + capper resolution, BEFORE `createBetWithLegs`. `findRecentRepost({capperId, description, odds, betType})` (L72) returns a prior bet row iff one exists with: same `capper_id`, same `bet_type`, `source IN ('twitter_text','twitter_vision')`, `created_at >= datetime('now','-12 hours')` (SQL L76-83) — then, in JS, equal `normalizeForDedup(description)` (L61: lowercase, every non-alphanumeric run → single space, trim) AND null-aware-equal `odds` (L84-88). Effective match key = **capper + normalized description + odds + bet_type**, restricted to twitter sources, inside 12h.

- **Normal path** (L305-315): on match → `recordDrop({dropReason:'DUPLICATE_REPOST', payload:{window:'12h', prior_bet_id}})` (L312) + `updateLastTweetId` (L313) + `continue` — **no bet created**.
- **Ladder path** (L276-303): the same gate runs **per step** before each step's `createBetWithLegs` (`findRecentRepost` L281 → `recordDrop DUPLICATE_REPOST` L284 → skip that step, no bet). Note the cursor `updateLastTweetId` here is **tweet-level** — fired once after the ladder loop (L301), not per dropped step (unlike the normal path, which advances it inline on the drop).

`DUPLICATE_REPOST` is registered in `DROP_REASONS` (`services/pipeline-events.js:44`). Module exports: `handleTwitterWebhookPayload`, `normalizeForDedup`, `findRecentRepost` (L343).

**Why id-ignoring is necessary.** `createBetWithLegs` folds the per-message tweet id into its `fingerprint` dedup key, so a same-content repost under a *different* tweet id hashes differently and BOTH would save (that fingerprint hit drops as `DUPLICATE_IMAGE`, L328). F-12 deliberately ignores the tweet id to collapse these. Forensic basis (handler comment L45-63): `bobby__tracker` re-posts the same pick across separate same-day tweets (observed gaps 6s–3.25h), whereas a legit text repeat for a different match recurs ≥2 days later — so a 12h window collapses the reposts and keeps the legit repeats.

**Why the window keys on `bets.created_at` (ingestion time), not the tweet's post time.** `created_at` is the schema default `datetime('now')` stamped at insert — verified: `bets.created_at TEXT DEFAULT (datetime('now'))` (`migrations/001_initial_schema.sql:34`) and the `INSERT INTO bets` column list in `createBetWithLegs` (`services/database.js:183`) omits `created_at`. This is sound because the scraper forwards only a tight recent page per poll (NORMAL mode pulls the 10 most-recent per handle — see the scraper README), so ingestion time tracks post time closely. **Documented edge:** a manual `BACKFILL=true` scraper run against a low-frequency, cursorless NEW handle pulls a deeper page at once, which could collapse a legitimately different-day repeat into a single 12h window — auditable after the fact via `drop_reason='DUPLICATE_REPOST'` in `pipeline_events`.

**F-12 dedup leak check — daily read-only safety net (`services/dedupLeakCheck.js`, #60).** Post-hoc detector for reposts that slip PAST the ingest-time F-12 gate. `findDedupLeaks({db, lookbackHours=24, windowHours=12})` (L39) imports `normalizeForDedup` from `twitter-handler.js` and mirrors `findRecentRepost`'s match key **exactly** (same capper + bet_type + `source IN ('twitter_text','twitter_vision')` + normalized desc + null-aware odds, two `created_at` within 12h) so the detector can't drift from the gate. One SELECT over the last lookback+window hours, grouped by `(capper_id, bet_type)`; each recent bet B with an earlier matching A inside the window = one leak (the repost F-12 should have dropped), paired with the nearest A. `reportDedupLeaks(client)` (L123) is **read-only** — logs `[DedupLeak] scan clean` when empty, else posts ONE compact alert to `#admin-log` via `ADMIN_LOG_CHANNEL_ID` (no hardcoded id); self-swallowing so a bad scan can't kill the cron tick. **Never writes to `bets`.** bot.js wiring: import L48; `cron.schedule('0 13 * * *', …)` (9 AM ET, off the recap's 12:00 UTC slot) → `reportDedupLeaks(client)` at L765 (scheduler L762).

### services/dedupLeakCheck.js (F-12 leak-check #60, `7fa1bfb`)

> File/line map for the daily safety net narrated in §Twitter ingest just above. Imports `normalizeForDedup` from `services/twitter-handler.js` (it does **not** re-implement it) so the detector can never drift from `findRecentRepost`. **Read-only — never writes to `bets`.** 10 cases in `tests/dedup-leak-check.test.js`.

| What | Line(s) |
| --- | --- |
| `findDedupLeaks({ db, lookbackHours=24, windowHours=12 })` — pure read. One SELECT over `source IN ('twitter_text','twitter_vision')` across the last `lookback+window` hours, grouped by `(capper_id, bet_type)`; flags each recent bet B that has an earlier `normalizeForDedup`-equal / null-aware-equal-odds A inside the 12h window (pairs the nearest A). `db` injectable for tests. Exported. | 39 |
| `reportDedupLeaks(client)` — daily cron entrypoint. Empty → `console.log('[DedupLeak] scan clean …')`; else ONE compact alert to `#admin-log` via `ADMIN_LOG_CHANNEL_ID` (no hardcoded id), truncated under Discord's 2000-char cap. Self-swallowing, so a bad scan can't kill the cron tick. Exported. | 123 |
| `module.exports = { findDedupLeaks, reportDedupLeaks }` | 178 |
| bot.js wiring — `require` L48; `cron.schedule('0 13 * * *', …)` (9 AM ET) L762 → `reportDedupLeaks(client)` L765 (`logCronRun('dedup-leak-check', …)` L766) | `bot.js:48` / 762 / 765 |

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
| 027 | scraper_handles (DB-driven Twitter scraper handle list; seeds 9 handles, `INSERT OR IGNORE`) |
| 028 | bets.sweep_exempt_until (Phase 2b-2 sweeper-grace for recovered bets) |
| 029 | NULLs legacy unparseable `bets.event_date` (`UPDATE … SET event_date=NULL WHERE event_date IS NOT NULL AND datetime(event_date) IS NULL`); mirrors the `services/eventDate.js` write-gate onto existing rows. Live 2026-06-10: corrupt rows 19 → 0 |

## Database — quirky things

- `pipeline_events.created_at` is INTEGER Unix epoch seconds, NOT ISO text. Filter with `created_at >= strftime('%s','now') - N`, NOT `datetime('now','-N seconds')` — type mismatch silently returns 0 rows.
- `pipeline_events.drop_reason` is its own column. No json_extract needed.
- `bets.graded_at` is **UTC** ISO (`datetime('now')`). When a grade looks wrong, compare `graded_at` against the relevant *deploy* time **in UTC** before blaming code — a row graded before the fix deployed is a pre-deploy casualty, not a live bug, and reading `graded_at` as ET (4–5h off) makes it look current. (Repair discipline for verified-wrong grades lives in `RUNBOOKS/db-interventions.md`.)
- Always run `PRAGMA table_info(<table>)` before time-windowed queries.
- DB lives at `/data/bettracker.db` on Fly. Local clone reads via `fly ssh console`.
- **Scripts in `/tmp` cannot `require('better-sqlite3')`** — `/tmp` has no node_modules. Always `cd /app` before running, or copy script under `/app/scripts/`.

## Env vars that gate behavior

| Var | Read by | What happens if unset |
| --- | --- | --- |
| ADMIN_LOG_CHANNEL_ID | sendHoldReviewEmbed, multiple admin notices | Hold embeds silently never post |
| HUMAN_SUBMISSION_CHANNEL_IDS | messageHandler hold branches | Human-channel slips fall through to PRE_FILTER drop |
| GEMMA_FALLBACK_DISABLED | Gemma vision fallback gate `shouldFallbackToGemma` (`services/ai.js:982`) | Unset = fallback path eligible; `==='true'` short-circuits it to `false` (both call sites). **Currently DISABLED in prod** via this Fly secret (shipped v431, cf58b4c — Surface Pro CPU inference exceeded Fly's 90s timeout). Code (`tryVisionGemma` `:801`, circuit breaker) is **retained but dead** behind the flag, NOT removed. A second guard also fails it closed when `OLLAMA_URL`/`OLLAMA_PROXY_SECRET` are unset (`:802–805`). Neither var is in committed config. |
| AUTOGRADER_DISABLED | autograder cron | If true, no auto-grading runs |
| TWITTER_POLLER_DISABLED | Fly twitterapi.io poller (`services/twitter.js:90`) | Unset = poller **runs** (enabled by default). The cron is registered in `bot.js:611` (`'10 */2 * * *'`, every 2h) only when `TWITTERAPI_KEY`/`APITWITTER_KEY` is set; at runtime `==='true'` short-circuits it. NOT removed and NOT paused in committed `fly.toml` (no such `[env]` entry) — pause is a Fly secret (`fly secrets set TWITTER_POLLER_DISABLED=true`), also toggled in-memory by `/admin pause-poller`. The Surface scraper is the other Twitter source, not a replacement. |
| QUOTE_BOUND_GRADING | `gradeSingleBet` Gate 3 (`resolveGate3Mode`) | unset → `shadow` (log-only). **Live on Fly = `enforce`** (2026-06-10): a failed quote check forces PENDING (`UNVERIFIED_QUOTE`) |
| DATE_BOUND_GRADING | `gradeSingleBet` Gate 4 (`resolveGate4Mode`) | unset → `shadow` (would-fire marker only). shadow stamps `GATE4_WOULD_FIRE` and leaves the grade; `enforce` forces PENDING (`OFF_DATE_EVIDENCE`) when the quote-bearing evidence is dated outside anchor±tol; unknown/legacy → shadow. **Staged shadow; not yet flipped** (`gate4-off-date-reject`) |
| EVENT_AWARE_RECHECK | `scheduleRecheckAfterDenial` + `runAutoGrade` pre-claim skip (`eventAwareRecheckMode`, `services/grading.js:1005`) — read per call | unset/anything-else → `off` (flat +30m recheck, today's behavior). `shadow` → measure only: one `event_aware_shadow` pipeline_events row per recheck/defer decision (`would_window` / `would_defer`) + structured log, grading control flow unchanged. `enforce` → defer not-yet-final parlays to an event-aware `grading_next_attempt_at` (normalized via `datetime(?)`) instead of the flat +30, skipping the claim entirely pre-event. **Live on Fly = `shadow`** (#124, `3269ab4`, v691, 2026-06-18). ⚠️ enforce-flip blocked on the `MAX_DEFER_MS`(7d)=`SWEEP_CUTOFF`(7d) collision — see §grading.js consts + BACKLOG |
| ALLOWED_WEBHOOK_IDS | `globalPipelineGuard` bot/webhook author allow-list (`handlers/messageHandler.js:315`; matches `webhook.id` first, `author.id` second) | Every bot/webhook author is denied `bot_not_whitelisted` (`:318`) → **all relay ingestion stops** (DubClub + TweetShift) |
| LINK_READER_MODE | `services/linkReader.js` (load-time `MODE`); wiring at the two `MANUAL_REVIEW_HOLD` writes in `handlers/messageHandler.js` + the `sportsbook_brand`→`BOUNCER_REJECTED` drop (Phase A.1, messageHandler.js ~1370) | unset/off → no `share_link` annotation (Phase A/A.1 feature dormant; sample-400 bump still applies). `shadow` → adds additive `share_link: {url,domain,kind}` to MANUAL_REVIEW_HOLD payloads **and** to `sportsbook_brand` BOUNCER_REJECTED drops (no behavior change). `cutover` reserved for Phase C, treated as off (strict `'shadow'` compare) |
| SOCCER_GRADER_MODE | **MASTER + match-level** mode for the ESPN soccer adapter (`soccerGraderMode` / `soccerEffectiveModes`, `services/sportsdata/index.js`) — read per call; gate in `grading.js` via `soccerStructuredEligible` (master≠off) | unset/anything-else → `off` = **master kill-switch**: BOTH classes off, adapter dormant BEFORE any fetch, **byte-identical to today** (soccer falls straight through to ESPN→search→PENDING). `shadow` → match-level runs `gradeSoccerBet` (slug fifa.world), emits a `soccer_grade_shadow` row for every outcome, falls through with NO grade write. `enforce` → match-level returns the adapter's real `{resolved,status}` so the bet actually grades. **Default off; shadow-first validation precedes the enforce flip** (Build 1/1c). Build 1c: this is the match-level mode AND the master; props are gated separately by `SOCCER_PROPS_MODE`. |
| SOCCER_PROPS_MODE | **PLAYER-PROP** mode for the soccer adapter (Build 1c; `soccerEffectiveModes`, `services/sportsdata/index.js`) — applied per-class in `routeSoccer` keyed off the result's `marketClass` | `off`\|`shadow`\|`enforce` explicit, else **unset → inherit `min(SOCCER_GRADER_MODE,'shadow')`** (inherited enforce is CAPPED at shadow). Props reach `enforce` ONLY via an explicit `SOCCER_PROPS_MODE=enforce` — the safety property so a match-level enforce flip never silently enforces props. When master is `off`, props are forced off regardless (kill-switch). **Default unset; prod `SOCCER_GRADER_MODE=shadow` + this unset → props inherited-shadow → deploy-safe (no behavior change).** ⚠️ DNP→VOID sign-off still pending before props enforce. |

> **ALLOWED_WEBHOOK_IDS — 6 IDs (restored 2026-06-11).** Carries the 2 DubClub-bridge relay webhooks (LockedIn → #lockedin-slips, GNP → #gnp-slips) + the 4 TweetShift relay webhooks (gambling-twitter dan/cody/gavin/harry — the same four cappers in §Channels "Human-submission only — hold gated"). The 4 TweetShift IDs were dropped in the **May 31 secret rotation**, so those relay channels went **dark May 31 → Jun 11** (their webhook authors hit `bot_not_whitelisted` at `messageHandler.js:318`); restored 2026-06-11. The ID set itself is a Fly secret — not in code. See BACKLOG "SHIPPED — 2026-06-11" for the ~860-post loss accounting.

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

## DubClub split bypass (handlers/messageHandler.js, 2026-05-31; author-agnostic since 2026-06-11 / #84)

DubClub bridge webhooks post one independent pick per message into split channels. handleMessage has a DUBCLUB SPLIT BYPASS block placed ABOVE GUARD 5 (`if (isDubclubSplitChannel)`, ~L945):
- Detects: channel in `DUBCLUB_SPLIT_CHANNEL_IDS` env CSV — **author-agnostic** (`isDubclubSplitChannel`, L943). Both webhook/bot AND human authors bypass. **Pre-#84** the gate also required `(message.webhookId || message.author?.bot)`, so a human-typed bare total in #lockedin-slips was silently dropped by GUARD 5 (incident 2026-06-11).
- Effect: routes the message straight to processAggregatedMessage (L954) as a single-message batch — skips BOTH the 4s aggregation buffer (would re-merge split posts) AND GUARD 5 looksLikePick (would drop bare totals like "Cubs Cardinals O8" that score <2 PICK_SIGNALS).
- The image arg is author-dependent (`bypassImages`, L951): webhook/bot → `[]` (byte-identical to ffddb09); human → real `images` (forward an attached slip the buffer would have collected).
- Must stay above GUARD 5. Auth/bouncer guards (1-4) still run before it.
- Env: DUBCLUB_SPLIT_CHANNEL_IDS=1473343783876821198(LockedIn),1473343838587457626(GNP)
- Commits: 34ea903 (buffer bypass), ffddb09 (moved above GUARD 5, webhook-only), 4c2ed71 / #84 (author-agnostic + GUARD 5 drops now `GUARD5_INSUFFICIENT_SIGNALS`).

Note: looksLikePick (PICK_SIGNALS, ~line 231) has no bare over/under total signal — "O8"/"O212.5" only match the half-point pattern, scoring <2. Latent bug for any non-DubClub total-only pick. Not fixed (DubClub bypasses the gate instead); **#84** at least made the resulting drop queryable as `GUARD5_INSUFFICIENT_SIGNALS` rather than the indistinguishable `PRE_FILTER_NO_BET_CONTENT`.

## #admin-log event catalog (channel 1486825605105192960)
Read path: routes/admin.js GET /api/admin/logs tails this channel (dashboard Admin Log tab).

Runtime writers:
- MANUAL_REVIEW_HOLD alert — embed + Release/Dismiss/View Original buttons. handlers/messageHandler.js (~L12-37 send fn); re-posted by services/replayHolds.js:190; backfilled by scripts/backfill-hold-embeds.js. ACTIONABLE. Durable record: hold row + hold_review_decisions (review-holds path).
- Strict Mode alert — cooldown-throttled, only when STRICT_MODE=true. handlers/messageHandler.js:797-801. Informational, no durable record.
- Runtime error report — "[AdminLog] Failed to report error". handlers/messageHandler.js:1412-1421. Informational, no durable record.

NOT in #admin-log:
- War Room staging embeds (Approve/Edit/Reject) — go to WAR_ROOM_CHANNEL_ID=1485091165308190780 (set in prod). services/warRoom.js falls back to #admin-log only if that var is unset.

Design note: holds already have a durable home, so the dashboard's write actions call the existing review-holds path — no admin_events table. Strict-mode/error are informational only.

## Local checkouts (Mac)

- `discord` (bot): `~/Documents/discord`
- `zonetracker-dashboard`: `~/Documents/zonetracker-dashboard` — runtime canonical is the Surface Pro PM2 process; the Mac clone is for Code-tab agent work (commit+push, then pull + pm2 restart on the Pro)
