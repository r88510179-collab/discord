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
| event_date | TEXT | mostly null; not a void driver. **Write-gated** by `normalizeEventDateForStorage` (`services/eventDate.js`, called in `createBet` at `database.js:350`) → stored as NULL or a parseable datetime only, never time-only/free-text. Mig **029** nulled legacy unparseable rows. Read-side: `grading.js` GUARD 3 falls back to `created_at` when a stored value resolves >0.25h ahead of now (marker `grade.event_date_skew_fallback`, `:2386`) |
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

Every grader attempt logged. Cols: `bet_id, attempt_num, timestamp INTEGER, sport_in/out, reclassified, is_parlay, leg_index, leg_count, search_backend, search_query, search_hits, search_duration_ms, provider_used, raw_response, guards_passed, guards_failed, final_status, final_evidence`. Created via `CREATE TABLE IF NOT EXISTS` in `services/database.js:97` (NOT a numbered migration). `timestamp` is epoch **MILLIS** (`Date.now()`) — window filters use `timestamp >= (unixepoch()-N)*1000` (see the daily cap at `grading.js:~1178`), not `datetime('now',…)`. `guards_passed`/`guards_failed` are JSON-array TEXT. **B0 (2026-06-04):** Gate-3 would-fire events ride `guards_failed` as a `GATE3_WOULD_FIRE|mode=|claimed=|prop=|reason=` token (`SELECT … WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'`); `guards_failed` is display-only (`commands/admin.js:439`) and never gates grading.

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

**`bets.result`**: `pending`, `win`, `loss`, `push`, `void`

**`bets.grade`**: `WIN`, `LOSS`, `VOID`, `PUSH` (uppercase) or NULL while pending

**`bets.grading_state`** (live-verified 2026-06-10): `done`, `backoff`, `quarantined`
(attempts ≥ 20, terminal — no auto-exit), `ready`, `graded`. The mig-016 doc values
`pending`/`locked` no longer occur.

**`bets.source`** (live-verified 2026-06-10, by volume): `twitter_vision`, `vision_slip`,
`twitter_text`, `discord`, `twitter` (legacy), `untracked_win`, `hold_review_script`,
`twitter_mobile` (legacy), `manual_hold_release`. Set wherever `createBetWithLegs` is called.

**`pipeline_events.stage`**: `RECEIVED`, `AUTHORIZED`, `BUFFERED`, `EXTRACTED`, `PARSED`, `VALIDATED`, `STAGED`, `DROPPED`, `MANUAL_REVIEW_HOLD`, `MANUAL_REVIEW_DISMISSED`, `MANUAL_REVIEW_RELEASED`, `PURE_SLIP_SKIP_HOLD`, `OCR_FIRST`, `RECOVERY_ATTEMPT_FAILED`, `GRADING_ENTER`, `GRADING_SEARCH`, `GRADING_AI`, `GRADING_GUARDS`, `GRADING_COMPLETE`, `GRADING_DROPPED`. Enum lives at `services/pipeline-events.js:18`. **`RECOVERY_ATTEMPT_FAILED`** (added 2026-06-12): one row per hold-recovery attempt that burned vision+OCR but yielded no bet (`validator_drop` / `no_bet_found`, incl. extract throw); `COUNT(*)` per `ingest_id` is `recoverHold`'s retry-cap counter (`RECOVERY_RETRY_CAP`=5, `services/holdReview.js`) — at the cap, un-forced recovery refuses with `recovery_exhausted` (HTTP 429) **before** the Discord fetch, so an exhausted hold costs nothing per poll; API body `{force:true}` is the operator override. Trace-only, NOT a drop (the hold stays open); absent from `pipelineHealth.EXPECTED_STAGES` like the other markers. Note: `STAGE_ENTER` etc. listed here previously were `event_type` values, not stages — those are `STAGE_ENTER`, `STAGE_EXIT`, `DROP`, `ERROR` (line 32). Write-boundary enum validation shipped as #49: `warnUnknownEnums` (`services/pipeline-events.js:127`, called at the single write boundary L154) warn-only logs non-canonical values and still writes (fire-and-forget contract preserved; closes audit F-17).

**`pipeline_events.drop_reason`**: closed source-of-truth list is `DROP_REASONS` at `services/pipeline-events.js:42` (not enumerated here — read it there; the warn-only tripwire above flags any unregistered value). New values must be added to that array (and CODEMAP §Enums) before a call site emits them. **`GUARD5_INSUFFICIENT_SIGNALS`** (added 2026-06-11): GUARD 5's pre-buffer signal heuristic dropped a message (`looksLikePick` <2 signals, no celebration, no images). Deliberately distinct from `PRE_FILTER_NO_BET_CONTENT` so "a real bare total was discarded by the heuristic" is queryable apart from genuine non-bet text. Only fires OUTSIDE DubClub-split channels — those bypass GUARD 5 for both webhook and human authors (incident 2026-06-11).

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

| What | Line(s) |
| --- | --- |
| **Gate 1** `reduceParlayResult` (pure parlay reducer — keystone; LOSS>PENDING>WIN) | 209 (fn); `normalizeLegStatus` 202 |
| **Gate 2** `GRADER_VERSION` / `computeEvidenceHash` / `decideFinalGradeWrite` | 20 / 25 / 45 |
| **Gate 3** quote-bound grading — tri-state `QUOTE_BOUND_GRADING` (`off`/`shadow`(staged default)/`enforce`); **live on Fly = `enforce` as of 2026-06-10** (verified in-container; staged default is still `shadow`). shadow logs `[GATE3 would-fire]` and leaves the grade, enforce forces PENDING (`UNVERIFIED_QUOTE`); unknown/legacy → shadow | `normalizeQuoteWhitespace` 76; `validateEvidenceQuote` 89; `resolveGate3Mode` 115; `applyGate3` 129 (returns `claimed` for the marker) |
| **Gate 3 (B0)** `buildGate3WouldFireMarker` — pure; returns `GATE3_WOULD_FIRE\|mode=\|claimed=\|prop=\|reason=` token or `null` (off / quote ok). Caller pushes it onto `audit.guards_failed` (display-only; never gates grading) so the event rides the attempt's existing `grading_audit` row — **zero extra rows** (a dedicated row would perturb `shouldAutoVoidNoData`'s recent-5 + the daily cap). Query: `WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'` | 177 (fn); marker const 176 |
| **`parlayLegDataComplete`** — NEW #73, pure early leg-completeness guard: complete ⇔ `legCount ≥ 1` **AND** `legCount === ` the description's `•` bullet count (same structural signal as the leg-explosion guard). Exported via `_internal`. | 257 |
| `looksLikePlayerProp` | 286 (fn); structured gate → `tryStructured` call L2418 |
| `canFinalizeBet` (RETRY_CAP=15 → stamps `GRADE_BACKOFF_EXHAUSTED` + VOID in a txn) | 557 (`RETRY_CAP` 636; cap-void 640) |
| `scheduleRecheckAfterDenial` | 631 |
| `shouldAutoVoidNoData` — **the *other* void path**: recent-5 `grading_audit` rows all `PENDING` + no-data evidence, `grading_attempts ≥ 5`, age ≥ 12h → VOID (`auto_void_no_searchable_data`). Keys on audit *content*, not raw attempt count — why a 7-attempt bet can void while a 35-attempt bet does not (see BACKLOG "non-uniform auto-void"). | 708 (MIN_ATTEMPTS 710; MIN_AGE_MS 709) |
| `isSupportedSport(sport)` / `SUPPORTED_SPORTS` — exact single-key membership (`toUpperCase().trim()` → `SUPPORTED_SPORTS.has(s)`; rejects null/`UNKNOWN`/`N/A`). **OPEN FOLLOW-UP (#82 downstream):** does **not** split or normalize the stored sport, so a compound (`MLB/NHL`) or unmodeled (`KBO`) sport string is not in the flat set → returns false → the bet is **auto-voided** at the grade gate (`review_status='auto_void_unscoped_bet'`, skips ESPN+AI). #82 fixed the *parse-time* compound-sport leg validator, but a parlay whose stored `sport` survives as `MLB/NHL`, and all KBO bets, are still ungradeable here. Possible fix: split/normalize compound sport at this gate + add KBO to `SUPPORTED_SPORTS` and KBO team data to teams.json | `isSupportedSport` 387; `SUPPORTED_SPORTS` 267; auto-void gate 2022 (VOID write 2025–2037, `AUTO_VOIDED` return 2043) |
| `calcProfit` | 1011 |
| `gradeFromCelebration` | 1331 |
| `extractSubject` — **ordinal/period sentinel protection (#74)** + **slash/dash query fixes (#76)**. #74: stashes `1st`–`4th` / `1H`/`2H` / `1Q`–`4Q` / `F5` behind a U+0001 sentinel (`String.fromCharCode(1)`) *before* the `\d+\.?\d*` + market strips, then restores them in order, so `"1st Quarter"` survives while odds/lines still strip. #76: slash/backslash between tokens → **space** (`.replace(/[/\\]/g, ' ')`, runs *before* the symbol strip so it can't be eaten) — `"McGhee/Yannis ITD"` → `"McGhee Yannis ITD"`; and **orphan dash-runs** isolated by whitespace/boundary are dropped (`.replace(/(^\|\s)-+(?=\s\|$)/g, '$1')`) — `"Joanderson Brito ML (-165)"` → `"Joanderson Brito"`, while intra-word hyphens (`Saint-Denis`) survive (the ASCII `-` is deliberately kept out of the symbol class) | 1425 (fn); sentinel stash 1438; `SENT` const 1439; slash→space 1453; restore-in-chain 1459; orphan-dash drop 1466 |
| `buildGraderSearchQuery` (description-only; doc-comment 1471–1485) | 1486 |
| **`GATED_BACKENDS`** — NEW #74, `Set{brave, ddg}`: the only backends `searchWeb` SKIPS when their circuit is open. `bing`/`serper` are deliberately un-gated workhorses (failures recorded but still attempted; Bing-first preserved) | 1568 |
| `recordBackendResult` — #74: now stamps `lastSuccess` **only on a real success** (parse failures no longer record a false `ok`), so the breaker + snapshot stop scoring drifted 200s as healthy | 1581 |
| **`getBackendSnapshot`** — NEW #74, structured per-backend health for `/admin` + tests; state ∈ `idle`/`healthy`/`failing`/`open`(gated, searchWeb skipping)/`degraded`(un-gated bing/serper, circuit open but still tried) + last-success age in every state. Top-level export; consumed by `commands/admin.js` `fmtBackend` | 1612 |
| **`assessSearchResults`** — NEW #74, content sanity gate every backend routes through before recording success. Returns `{ results, status }`, status ∈ `ok` / `parse_empty` (0 usable hits → circuit failure + fall-through, all backends) / `generic_news` (Bing-only `checkRelevance`: parsed but no hit mentions a query token >3 chars → fall-through, no breaker trip) | 1676 |
| **`parseBingHtml(html)`** — NEW #76, pure Bing-SERP parser, exported via `_internal`. Tries `BING_BLOCK_DELIMITERS` (`b_algo` → `b_algoheader` → `b_ans`) in order — first delimiter yielding ≥1 hit wins, 5-block cap — and within each block runs ordered `BING_TITLE_SELECTORS` (`h2`/`h3`/`tilk`/anchor) + `BING_SNIPPET_SELECTORS` (`b_caption>p`/`b_lineclamp`/`b_algoSlug`/first-`p`) via `firstSelectorMatch`+`cleanBingFragment`. Total miss → `[]` (→ `assessSearchResults` `parse_empty` → honest fall-through to Brave; gate NOT weakened). Replaces the old single hard-coded `b_algo`+`b_caption>p` selector | `BING_BLOCK_DELIMITERS` 1797; `cleanBingFragment` 1812; `firstSelectorMatch` 1817; `parseBingHtml` 1829 |
| `searchBing` (content-gated #74 + #76: a 200 with garbage classes `parse_empty` (circuit fail) or `generic_news` (fall-through, no trip) → reaches Brave instead of scoring `ok`; now parses via `parseBingHtml` (#76) instead of the single drift-prone `b_algo` selector) | 1849 (`parseBingHtml` call 1865) |
| `gradePropWithAI` (dispatch: parlay→gradeParlay, else gradeSingleBet) | 2002; **1-leg parlay guard** (#73 — skips to PENDING only when `recordedLegs ≤ 1 && !parlayLegDataComplete`; complete 1-leg parlays now dispatch to `gradeParlay`) 2061 |
| `isTrustedLossLeg` (Bug A Part 1, v438) | 2077 |
| `aggregateParlayLegResults` (now downgrades untrusted-LOSS→PENDING, then delegates precedence to Gate 1 reducer) | 2132 (fn); reducer call 2169; "Parlay LOSS — leg N" emit 2179 |
| `gradeParlay` (builds per-leg `legBet` with `bet_type:'straight'` — legs have no stored prop flag) | 2198 |
| `writeGradingAudit` (module-level; extracted from the `gradeSingleBet` `writeAudit` closure, B0) — one `grading_audit` row per attempt; `timestamp` is epoch MILLIS | 2239 |
| `gradeSingleBet` | 2260; structured pre-check 2418; **Gate 3** quote check (`applyGate3` call 2620; B0 would-fire marker build 2631 / push 2632); grader waterfall providers.push 2497–2518 (groq-llama4-scout 2497 → cerebras-gpt-oss 2500 → openrouter 2506 → groq-gpt-oss 2509 → mistral 2512 → ollama-llama3.2-3b 2515 → groq-llama8b 2518) |
| GUARD 3 (too-recent) **event_date skew fallback** — when a stored `event_date` resolves >0.25h ahead of now, re-anchor to `created_at` (kills legacy time-only strings re-anchoring to "today" every poll → "too soon" forever → burned attempts to quarantine; pairs with mig 029 + `services/eventDate.js`) | marker `grade.event_date_skew_fallback` 2386 |
| `finalizeBetGrading` | 2757 (also exported as `gradeBet`); **Gate 2** idempotency check 2761; atomic write stamps `grader_version`+`evidence_hash` via `gradeBetRecord` |
| `resolvePlayerProp` | REMOVED (v459) — replaced by `tryStructured()` from services/sportsdata, called at L2353 |

### services/sportsdata/ (Phase 1 structured grading, v459)
| File | Purpose |
| --- | --- |
| index.js | Router: dispatches a bet to the right sport adapter; runs BEFORE search+LLM and short-circuits the LLM when `resolved=true` |
| mlb.js | MLB Stats API adapter (`statsapi.mlb.com/api/v1`) — official, no auth |
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
| `routes/admin.js` | READ-ONLY `/api/admin/*` (Phase 2a-1, `ADMIN_API_SECRET` via `adminAuth`): GET `/holds` L49, `/bets` L129, `/handles` L172 (all `scraper_handles` rows → `{count, handles:[{handle,enabled,added_at,note}]}`, ordered by handle), `/logs` L189 (tails `#admin-log`); catch-all 404. Now imports `adminAuth` from `./adminAuth`. Mounted bot.js L28. |
| `routes/adminCommands.js` | WRITE `/api/admin/*` (Phase 2b, `ADMIN_API_SECRET` via `adminAuth`): `POST /holds/:ingestId/dismiss` → `dismissHold` (200 dismissed/already_dismissed, 409 already_released, 404 not_found, 400 malformed; `handleDismissRoute` L52, route L76); `POST /holds/:ingestId/recover` (Phase 2b-2) → `recoverHold` (200 recovered/already_recovered, 409 already_resolved, 404 not_found, 422 no_image_yet/no_bet_found, 502 message_unreachable, 400 malformed; `handleRecoverRoute(req,res,deps)` L95, route L119 — `deps` is a test-only injection seam, prod route passes none); `POST /handles/:handle` → `handleSetHandleRoute` (L134, route L180): toggles a **seeded** `scraper_handles` row's `enabled` (int `0/1` or bool, required) + optional `note` (`COALESCE`; omitted leaves it); **never inserts** → unknown handle 404; 200 updated / 400 malformed / 500 error. All `handle*Route` fns exported for unit tests. **Mounted in bot.js L22 BEFORE the read router (L28)** so its catch-all 404 can't intercept the POSTs. |

> **`scraper_handles` management (mig 027; #46 table+seed+scraper read, #54 admin write toggle).** One table, two authed surfaces:
> - **Operator / dashboard** — `ADMIN_API_SECRET`: read `GET /api/admin/handles` (`routes/admin.js:172`, all rows) + write `POST /api/admin/handles/:handle` (`routes/adminCommands.js:134`, toggle `enabled`/`note` on a seeded row). The external dashboard's **Handles tab** is built on these two.
> - **Scraper-facing** — `MOBILE_SCRAPER_SECRET` (a *separate* secret): read-only `GET /api/scraper-handles` (`routes/api.js:68`) → just the `enabled = 1` handle names; the Surface Pro poller reads it each cycle. Toggling `enabled=0` is how a handle is turned off (e.g. `guess_pray_bets` — GNP now arrives via the DubClub bridge, not the scraper). Seed (`migrations/027_scraper_handles.sql`, 9 handles, `INSERT OR IGNORE`) preserves manual `enabled`/`note` edits across restarts.

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
> Line numbers refreshed 2026-06-10 **evening batch 2** (PR #77 `3ed77e2`, `main`@3ed77e2): the unified ROI block (`SETTLED_BET` + `CAPPER_STATS_COLUMNS` + `flagAbnormalRoi`) replaced the two inline ROI copies in `getCapperStats`/`getLeaderboard` (net +52), shifting everything below ~L790 down. Rows re-verified against `main`.

| What | Line(s) |
| --- | --- |
| `getOrCreateCapper` | 305 |
| `createBet` (single-bet insert; **write-gates `event_date`** via `normalizeEventDateForStorage` from `services/eventDate.js`) | 334 (fn); event_date gate at the INSERT, L350 |
| `createBetWithLegs` | 583 |
| **Capper ROI — single source of truth (#77).** `SETTLED_BET` SQL fragment (`result IN ('win','loss','push') AND profit_units IS NOT NULL`) + `CAPPER_STATS_COLUMNS` (the win/loss/push/win_pct/total_profit_units/`roi_pct` column block) are defined **once** and interpolated verbatim into both `getCapperStats` and `getLeaderboard` so the two can't drift. `roi_pct` = `Σ(profit_units) ÷ Σ(CAST(units AS REAL))` over `SETTLED_BET` rows, `NULLIF(denom,0)`+`COALESCE`-guarded (always finite, 0 when nothing settled); **no `MAX(units,1)` floor, no display cap.** | `SETTLED_BET` 712; `CAPPER_STATS_COLUMNS` 713 |
| `flagAbnormalRoi(row)` — #77: *logs* (never clamps) `Math.abs(roi_pct) > 500`; called by `getCapperStats` + `rows.forEach` in `getLeaderboard` | 731 |
| `getCapperStats` (selects `CAPPER_STATS_COLUMNS` + `pending`; one capper) | 737 |
| `getLeaderboard` (selects `CAPPER_STATS_COLUMNS`; sorted, limited) | 753 |
| `findPendingBetBySubject` | 960 |
| `gradeBet` | 601 (`gradeBetRecord`, exported as `gradeBet` L1109) |

### services/eventDate.js (event_date write-gate, #70 + mig 029)
The single write-path normalizer for `bets.event_date`. `normalizeEventDateForStorage(raw, createdAt=now)` returns **NULL or a parseable datetime** — rejects time-only (`"9:10PM ET"`) and free-text, ET-anchors wall-clock dates to UTC. Called from `createBet` (`database.js:350`) so every write is gated. The same rule was applied to existing rows by mig **029**; the read-side skew fallback lives in `grading.js` GUARD 3 (marker `grade.event_date_skew_fallback`).

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

## Twitter ingest — Surface scraper → /mobile-ingest → F-12 dedup

> Code refs accurate as of `main` post-#53 (commit `3cfc694`, 2026-06-07). This is the **direct HTTP** Twitter path through `services/twitter-handler.js`. It is NOT the **Twitter relay channels** (Dan/Cody/Harry/Gavin) under "Channels — ingestion routing" below: those arrive as Discord *messages* and run the `messageHandler` pipeline, so they never reach the F-12 gate.

**Source.** The live Twitter feed is the Surface Pro scraper (`zonetracker-scraper`, private repo — see its README "Polling & cursor behavior"), which POSTs tweet batches to the Fly Express endpoint `POST /api/mobile-ingest` (`routes/api.js:19`; router mounted at `/api` in `bot.js`). Auth: the `x-mobile-secret` header must equal `MOBILE_SCRAPER_SECRET` (`routes/api.js:21-22`), else 401. The route 200s immediately, then processes async via `handleTwitterWebhookPayload` (`routes/api.js:55`). The scraper pulls its handle list from `GET /api/scraper-handles` (`routes/api.js:68`; `scraper_handles` table, mig 027). Fly's own twitterapi.io poller (`services/twitter.js:90`) feeds the *same* handler but is kill-switched by `TWITTER_POLLER_DISABLED` (paused in prod — see "Env vars that gate behavior"), so the scraper is the sole live source.

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
| QUOTE_BOUND_GRADING | `gradeSingleBet` Gate 3 (`resolveGate3Mode`) | unset → `shadow` (log-only). **Live on Fly = `enforce`** (2026-06-10): a failed quote check forces PENDING (`UNVERIFIED_QUOTE`) |
| ALLOWED_WEBHOOK_IDS | `globalPipelineGuard` bot/webhook author allow-list (`handlers/messageHandler.js:315`; matches `webhook.id` first, `author.id` second) | Every bot/webhook author is denied `bot_not_whitelisted` (`:318`) → **all relay ingestion stops** (DubClub + TweetShift) |

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
