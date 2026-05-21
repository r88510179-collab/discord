# ZoneTracker Codemap

Authoritative file/line map. Read this at the START of every session before doing any investigation.

When a session discovers a new location worth remembering, update this file in the same PR as the work.

## Conventions

- Line numbers are accurate as of commit `d76761d` (main, 2026-05-20). Mapped source files are byte-identical to the merged hold-review feature (#27).
- "L1132" means line 1132 in that file
- If a line number drifts more than ±20 lines from reality, refresh the section

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

## Env vars that gate behavior

| Var | Read by | What happens if unset |
| --- | --- | --- |
| ADMIN_LOG_CHANNEL_ID | sendHoldReviewEmbed, multiple admin notices | Hold embeds silently never post |
| HUMAN_SUBMISSION_CHANNEL_IDS | messageHandler hold branches | Human-channel slips fall through to PRE_FILTER drop |
| GEMMA_FALLBACK_DISABLED | Gemma vision fallback | (v431 sets true — Surface hardware ceiling) |
| AUTOGRADER_DISABLED | autograder cron | If true, no auto-grading runs |
| TWITTER_POLLER_DISABLED | Fly Twitter poller | Currently paused; Surface Playwright replaces |

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
