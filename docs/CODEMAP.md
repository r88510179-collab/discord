# ZoneTracker Codemap

Authoritative file/line map. Read this at the START of every session before doing any investigation.

When a session discovers a new location worth remembering, update this file in the same PR as the work.

## Conventions

- Line numbers are accurate as of commit `d76761d` (main, 2026-05-20). Mapped source files are byte-identical to the merged hold-review feature (#27).
- "L1132" means line 1132 in that file
- If a line number drifts more than ±20 lines from reality, refresh the section
- When something gets resolved by a query (schema, enum values, channel ID → name), commit the answer to this file in the same PR. Do not re-discover next session.

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

**`pipeline_events.stage`**: `STAGE_ENTER`, `EXTRACTED`, `PARSED`, `MANUAL_REVIEW_HOLD`, `DROPPED`, `GRADE_*` variants. Enum lives at `services/pipeline-events.js:18`.

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
| What | Line(s) |
| --- | --- |
| `gradeFromCelebration` | 1030 |
| `finalizeBetGrading` | 2183 (also exported as `gradeBet` L2280) |
| `calcProfit` | 753 |
| `canFinalizeBet` | 299 |
| `scheduleRecheckAfterDenial` | 373 |
| Grader waterfall (groq-llama4-scout → cerebras-gpt-oss → tail) | 1954–1980 (`providers[]` L1957; groq-llama4-scout 1959 → cerebras-gpt-oss 1962 → groq-qwen 1965 → openrouter 1968 → groq-gpt-oss 1971 → mistral 1974 → ollama 1977 → groq-llama8b 1980). NOTE: prior ~L1369 hint was `searchBing`, not the waterfall. |
| `searchBing` (BROKEN — returns 200 OK with garbage HTML) | 1369 |
| `aggregateParlayLegResults` "Parlay LOSS — leg N" emit | 1624 (fn), 1663 (leg-loss emit) |
| `isTrustedLossLeg` (Bug A Part 1, v438) | 1569 |
| `looksLikePlayerProp` gate to structured grading | 28 (fn), 1877 (gate → `tryStructured` L1879) |
| `resolvePlayerProp` | REMOVED (v459) — replaced by `tryStructured()` from services/sportsdata, called at L1879 |

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

## Database — quirky things

- `pipeline_events.created_at` is INTEGER Unix epoch seconds, NOT ISO text. Filter with `created_at >= strftime('%s','now') - N`, NOT `datetime('now','-N seconds')` — type mismatch silently returns 0 rows.
- `pipeline_events.drop_reason` is its own column. No json_extract needed.
- Always run `PRAGMA table_info(<table>)` before time-windowed queries.
- DB lives at `/data/bettracker.db` on Fly. Local clone reads via `fly ssh console`.
- **Scripts in `/tmp` cannot `require('better-sqlite3')`** — `/tmp` has no node_modules. Always `cd /app` before running, or copy script under `/app/scripts/`.

## Channels (verified 2026-05-21)

### Pure-slip (no hold gating — operator-confirmed bets-only)

| Channel | ID | Notes |
|---------|-----|-------|
| #datdude-slips | 1355182920163262664 | HRB-heavy, 42% parse success rate |
| #ig-dave-slips | 1473347391284576469 | |
| #smokke-slips | 1473341333325217950 | |
| #lockedin-slips | 1473343783876821198 | 101 bets/30d, most active |
| #gnp-slips | 1473343838587457626 | |

### Admin

| Channel | ID | Env var |
|---------|-----|---------|
| #admin-log | 1486825605105192960 | `ADMIN_LOG_CHANNEL_ID` |

### Active channels from last-30d bet activity (names TBD)

Resolved from `SELECT DISTINCT source_channel_id FROM bets WHERE created_at >= ... GROUP BY source_channel_id`. These produced bets in the last 30d but channel name is not yet mapped here:

| Channel ID | 30d bet count | Notes |
|------------|---------------|-------|
| 1284613965128925234 | 60 | TODO name |
| 1284620792713318472 | 47 | TODO name |
| 1284613911055695893 | 47 | Cody recap channel per 2026-05-21 case |
| 1284614717071032464 | 37 | TODO name |

To resolve names → IDs in one shot (run when convenient):

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "const m=process.env.CAPPER_CHANNEL_MAP; try { const parsed=JSON.parse(m); console.log(JSON.stringify(parsed, null, 2)); } catch { console.log(m); }"'
```

Paste output into this section. Goal: zero `TODO name` lines.

### Other env-mapped channels

`WAR_ROOM_CHANNEL_ID`, `SLIP_FEED_CHANNEL_ID`, `RECEIPTS_CHANNEL_ID`, `SUBMIT_CHANNEL_ID`, `DASHBOARD_CHANNEL_ID`, `AUDIT_REPORT_CHANNEL_ID`, `PICKS_CHANNEL_IDS` (CSV). Resolve via:

```bash
fly ssh console -a bettracker-discord-bot -C 'sh -c "node -e \"[\\\"WAR_ROOM_CHANNEL_ID\\\",\\\"SLIP_FEED_CHANNEL_ID\\\",\\\"RECEIPTS_CHANNEL_ID\\\",\\\"SUBMIT_CHANNEL_ID\\\",\\\"DASHBOARD_CHANNEL_ID\\\",\\\"AUDIT_REPORT_CHANNEL_ID\\\",\\\"PICKS_CHANNEL_IDS\\\"].forEach(k => console.log(k+\\\" = \\\"+(process.env[k]||\\\"UNSET\\\")))\""'
```

Paste output here.

## Env vars that gate behavior

| Var | Read by | What happens if unset |
| --- | --- | --- |
| ADMIN_LOG_CHANNEL_ID | sendHoldReviewEmbed, multiple admin notices | Hold embeds silently never post. Confirmed set in prod: 1486825605105192960 |
| HUMAN_SUBMISSION_CHANNEL_IDS | messageHandler hold branches | Human-channel slips fall through to PRE_FILTER drop |
| GEMMA_FALLBACK_DISABLED | Gemma vision fallback | (v431 sets true — Surface hardware ceiling) |
| AUTOGRADER_DISABLED | autograder cron | If true, no auto-grading runs |
| TWITTER_POLLER_DISABLED | Fly Twitter poller | Currently paused; Surface Playwright replaces |

### Full env var inventory (names verified live 2026-05-21)

Channel routing: `ADMIN_LOG_CHANNEL_ID`, `HUMAN_SUBMISSION_CHANNEL_IDS`, `PICKS_CHANNEL_IDS`, `SUBMIT_CHANNEL_ID`, `WAR_ROOM_CHANNEL_ID`, `SLIP_FEED_CHANNEL_ID`, `RECEIPTS_CHANNEL_ID`, `DASHBOARD_CHANNEL_ID`, `AUDIT_REPORT_CHANNEL_ID`, `IGNORED_CHANNELS`, `TRACKED_CHANNELS`, `CAPPER_CHANNEL_MAP`, `TWITTER_CAPPER_MAP`.

Feature flags: `AUTOGRADER_DISABLED`, `TWITTER_POLLER_DISABLED`, `GEMMA_FALLBACK_DISABLED`, `GRADING_STATE_MACHINE_ENABLED`, `CAN_FINALIZE_ENFORCE`, `STRICT_MODE`.

Model selection: `GEMINI_MODEL`, `GROQ_MODEL`, `CEREBRAS_MODEL`, `OPENROUTER_MODEL`, `OLLAMA_MODEL`, `OLLAMA_URL`.

Secrets (NEVER echo values): `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `BRAVE_API_KEY` (returns 402), `SERPER_API_KEY`, `BALLDONTLIE_API_KEY`, `ODDS_API_KEY`, `ODDS_API_KEY_BACKUP`, `RAPIDAPI_KEY`, `OCR_SPACE_API_KEY`, `APIFY_WEBHOOK_SECRET`, `APITWITTER_KEY`, `TWITTERAPI_KEY`, `TWITTER_RAPIDAPI_KEY`, `MOBILE_SCRAPER_SECRET`, `OLLAMA_PROXY_SECRET`, `DISCORD_TOKEN`, `OWNER_ID`, `ALLOWED_WEBHOOK_IDS`, `TWITTER_EMAIL`, `TWITTER_PASSWORD`, `TWITTER_USERNAME`.

Other: `DB_PATH`, `NODE_ENV`, `PORT`, `PRIMARY_REGION`, `ACTIVE_SEASON`, `AUTO_GRADE_INTERVAL_MINUTES`, `DEFAULT_BANKROLL`, `DEFAULT_UNIT_SIZE`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `RESOLVER_URL`, `RESOLVER_VERSION`, `TWITTERAPI_CREDIT_BUDGET`.

## Fly deploy invariants

- Auto-deploy from main is UNRELIABLE (verified 2026-05-18). ci.yml only runs check + tests. fly.toml has no `[deploy]`.
- Every deploy is manual: `fly deploy --local-only --yes --no-cache -a bettracker-discord-bot`
- `--no-cache` is MANDATORY every time — phantom deploys without it shipped stale COPY layers (v281, v289).
- `fly secrets set` produces "Staged" status until next deploy. **A staged secret is NOT live** — the running process still sees the old value. Verify with `fly ssh console -C "node -e 'console.log(process.env.X)'"` after deploy. DEPLOY_CHECKLIST.md Step 5.5 codifies this.

## Common queries (proven 2026-05-21)

### Schema check (run before any DB work on an unfamiliar table)

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); console.log(db.prepare(\\\"PRAGMA table_info(bets)\\\").all().map(c=>c.name).join(','));\""
```

### Recent bets by source (sanity check ingestion)

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); console.log(JSON.stringify(db.prepare('SELECT source, COUNT(*) as n FROM bets WHERE created_at >= ? GROUP BY source ORDER BY n DESC').all(new Date(Date.now()-7*86400000).toISOString()), null, 2));\""
```

### Pipeline drops last 24h by reason

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); const cutoff = Math.floor(Date.now()/1000) - 86400; console.log(JSON.stringify(db.prepare('SELECT drop_reason, COUNT(*) as n FROM pipeline_events WHERE stage = ? AND created_at >= ? GROUP BY drop_reason ORDER BY n DESC').all('DROPPED', cutoff), null, 2));\""
```

### Unresolved holds (last 7d)

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); const cutoff = Math.floor(Date.now()/1000) - 7*86400; console.log(JSON.stringify(db.prepare(\\\"SELECT ingest_id, source_ref, created_at FROM pipeline_events WHERE stage='MANUAL_REVIEW_HOLD' AND created_at >= ? AND ingest_id NOT IN (SELECT ingest_id FROM hold_review_decisions WHERE ingest_id IS NOT NULL) ORDER BY created_at DESC\\\").all(cutoff), null, 2));\""
```

### Bet lookup by ID (full row)

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); console.log(JSON.stringify(db.prepare('SELECT * FROM bets WHERE id=?').get('BET_ID_HERE'), null, 2));\""
```

### Distinct values for any enum-ish column

```bash
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); console.log(JSON.stringify(db.prepare('SELECT DISTINCT review_status, COUNT(*) as n FROM bets WHERE review_status IS NOT NULL GROUP BY review_status').all(), null, 2));\""
```

### Run a script from /tmp against /data/bettracker.db

`/tmp` lacks node_modules. Always `cd /app` first:

```bash
fly ssh console -a bettracker-discord-bot -C "sh -c 'cd /app && node /tmp/SCRIPT.js'"
```

For dry-run / commit toggle on mutation scripts:

```bash
fly ssh console -a bettracker-discord-bot -C "sh -c 'cd /app && COMMIT=1 node /tmp/SCRIPT.js'"
```

## Verification commands

### Is X env var live in the running container?

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "console.log(process.env.VAR_NAME || \"MISSING\")"'
```

Replace `VAR_NAME`. `fly secrets set` without subsequent `fly deploy` leaves the secret staged but not in the running container.

### Latest release + age

```bash
fly releases -a bettracker-discord-bot | head -5
```

### Is X commit shipped?

```bash
git log --oneline -20
```

Cross-reference commit hash against release timestamp from `fly releases`.

### Bot health (Discord-side)

In Discord: `/health quick`

### Specific log lines (proof code ran)

```bash
fly logs -a bettracker-discord-bot --no-tail | grep -iE "<distinctive log line>" | tail -5
```

## Memory errata (entries pointing at wrong path)

These userMemories entries reference `services/messageHandler.js` (wrong path) — actual file is `handlers/messageHandler.js`. CODEMAP §"Ingestion pipeline" is authoritative.

- **Memory #9** — "is_bet hard rule in messageHandler.js (~line 1098)" → `handlers/messageHandler.js:1128` (is_bet=false branch)
- **Memory #12** — "msgHandler:1095/:1141 stage hold" → `handlers/messageHandler.js:1132` (is_bet=false) and `:1177` (ai_indeterminate)
- **Memory #15** — "msgHandler:845 image-only bouncer bypass" → check `handlers/messageHandler.js`
- **Memory #20** — "messageHandler.js:989-992" merge logic → `handlers/messageHandler.js:995–1020`

Stale Claude Code worktree at `/app/.claude/worktrees/magical-robinson-46cfc6/` ships duplicate `bot.js` and `commands/admin.js` in the production image. Add to `.dockerignore`. Filed in BACKLOG.

## Workflow rules — non-negotiable

1. Read this CODEMAP at the start of every session before grep'ing for known locations.
2. Verify shipped status via `git log` before proposing rework of any feature (memory drift is common).
3. DEPLOY_CHECKLIST.md applies for every non-trivial deploy. Step 2 (grep for call sites) catches half-shipped functions. Step 5.5 catches staged-but-not-deployed secrets.
4. Run `PRAGMA table_info` on any table you query for the first time in a session.
5. Update this file in the same PR as any change that moves or adds the locations above.
6. When a session resolves an unknown (channel name, schema column, env var value, file path), commit the answer to CODEMAP in the same PR. Do not re-discover next session.
