All verification complete. Composing the appendix.

# T2 — Ingestion and drops — 2026-07-01 audit appendix

All file:line refs verified at worktree `/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`, HEAD `19ff594` (branch `audit/2026-07-01-full`). Env values are Fly secrets and unreadable here; anything value-dependent is tagged UNVERIFIED.

**Entry paths traced (drop-point classification):**
- **Discord messageHandler** (`bot.js:278/494` MessageCreate, `bot.js:498-508` MessageUpdate on embeds 0→N → `handlers/messageHandler.js:727 handleMessage` → buffer `:980` → `processAggregatedMessage :987`). Every early return emits a pipeline_events row except: dedup short-circuit (`:797`, intentionally silent per #84), SLIP_IMAGE_CAP overflow (`:645`, warn-only — T2-07), multi-image result-image discard (`:1074-1091` — T2-12), in-memory buffer loss on crash (BUFFERED dangling, no terminal event), DubClub-bypass catch (`:958-960`, console-only; low reach since `processAggregatedMessage`'s own catch at `:1516-1526` records errors).
- **Twitter `/api/mobile-ingest`** (`routes/api.js:19-60`, `x-mobile-secret`; responds 200 then processes async — post-200 payload errors console-only at `:57-59`) and the twitterapi.io poller (`services/twitter.js:202`) both feed `services/twitter-handler.js:92 handleTwitterWebhookPayload`. Per-tweet drops/errors all recorded; silent losses are T2-02 (extra images/bets) and T2-04 (no retry after mark-processed).
- **DubClub**: no HTTP route in this repo (routes/ = api.js, admin.js, adminAuth.js, adminCommands.js only). DubClub bridge posts arrive as Discord webhook messages → `ALLOWED_WEBHOOK_IDS` allowlist (`messageHandler.js:315-323`) → DUBCLUB split bypass (`:944-961`) → straight to `processAggregatedMessage` (skips buffer + GUARD 5 only; hold gates downstream still apply).
- **Human submission channels**: same messageHandler path, authorized via `HUMAN_SUBMISSION_CHANNEL_IDS` (`:328/334`); holds at the two branches below.
- **/slip command** (`commands/slip.js:46` → `processSlipImage`, `messageHandler.js:483-587`): vision-empty → `VISION_EXTRACTION_FAILED :526`; validator kill → mapped drop `:556`; dedup → `DUPLICATE_IMAGE :581`. No silent exits found.

**is_bet hard-rule sites (v335 class):** strict `parsed.is_bet === false` at `messageHandler.js:1234`; indeterminate guard requires BOTH `is_bet !== true` AND empty bets (`:1331`); twitter uses `is_bet !== false` (`twitter-handler.js:186`, correctly admits undefined). `normalizeParsedBets` returns only `{bets}` (`services/ai.js:491-495`) so successful parses leave `is_bet` undefined — consumers are correct. **#137 pre-hold filter did NOT touch the gate**: `preFilterDecision` runs inside the branch after strict-false already matched (`:1255-1282`, `:1354-1381`), default `PRE_FILTER_MODE` unset → `'pass'` no-op (`services/preFilter.js:52-54`).

**Hold-gate matrix (code-verified):** at both non-bet branches, `HUMAN && !PURE_SLIP` → MANUAL_REVIEW_HOLD (`:1241-1296`, `:1338-1395`); `HUMAN && PURE_SLIP` → `PURE_SLIP_SKIP_HOLD` marker + `PRE_FILTER_*` drop (`:1297-1312`, `:1396-1420`); non-HUMAN → drop. Note: LockedIn/GNP are both DUBCLUB_SPLIT and (per CODEMAP) PURE_SLIP, so a DubClub bare total the AI rejects as non-bet is **dropped**, not held. Buffer keying is composite `${author.id}:${channel.id}` (`:73`, F-02 fixed). OCR-first: `OCR_FIRST_MODE` load-time tri-state, default `off` = zero-cost short-circuit (`services/ocrFirstWiring.js:37-42`), seams gated `MODE !== 'off'` at `messageHandler.js:517` and `:1104`; shadow never mutates `parsed`.

### T2-01 [P0] [confidence: high] Vision-classified recap/result auto-grades a global substring-matched pending bet — cross-capper, auto-confirmed
- Where: handlers/messageHandler.js:667-724 (autoGradeBet), :1127 (result path), :1217 (recap global fallback); services/database.js:254-258
- What / Why it matters: when vision classifies an ingested image as `type:'result'` or a winner/loser ticket, `autoGradeBet` grades the match via `findPendingBetBySubject` — a **global** `LIKE '%term%'` over ALL cappers' confirmed pending bets, oldest-first, no capper scope, no date scope, no odds/line check (`database.js:256-258`). The grade is written with auto-confirm=true (`:700`) and bankroll updated (`:704-708`). The recap path tries capper-scoped `gradeFromCelebration` first (`grading.js:1932-1947`, confirmed-only per #94) but falls back global (`:1217`); the `type:'result'` path (`:1127`) is global-only from the start.
- Evidence: `findPendingBySubject: ... WHERE b.result = 'pending' AND b.review_status = 'confirmed' AND LOWER(b.description) LIKE LOWER(?) ORDER BY b.created_at ASC LIMIT 1` (database.js:254-258); `gradeBetRecord(bet.id, result, profitUnits, null, 'Auto-graded from capper graphic', true)` (messageHandler.js:700). searchTerms are leg team names / first description lines (`:1194-1204`).
- Proposed fix: scope `findPendingBetBySubject` to the posting capper (or require capper match + event-date window); at minimum route global-fallback matches to needs_review instead of terminal grade. (Effort S)
- Backlog: NEW (no BACKLOG/prior-audit coverage of autoGradeBet/findPendingBetBySubject found)

### T2-02 [P1] [confidence: high] Twitter vision path silently discards all images past [0] and all bets past bets[0]
- Where: services/twitter-handler.js:184, :186-189
- What / Why it matters: `parseBetText(visionPrompt, imageUrls[0], …)` — a tweet with N slip photos gets one vision call; and `const bet = parsed.bets[0]` — a sheet/multi-bet slip (the ai.js:1073 SHEET rule deliberately emits per-pick straights) stages only the first. No drop row, no log for the remainder → the P1 silent-loss class. F-07 (#61) fixed exactly this for the slip feed but not here.
- Evidence: twitter-handler.js:184 `imageUrls[0]`; :187 `const bet = parsed.bets[0];` with no handling of `parsed.bets.slice(1)`.
- Proposed fix: loop images (mirror `selectSlipImages` cap) and stage every validated bet in `parsed.bets`, or at minimum `recordDrop` the discarded remainder with a distinct reason. (Effort M)
- Backlog: NEW (adjacent to BACKLOG:233 which notes twitter holds store only imageCount)

### T2-03 [P1] [confidence: high] mergeBetsIntoParlay fabricates a parlay from independent straights on multi-image batches (the "parlay mis-split/mis-merge" class)
- Where: handlers/messageHandler.js:1426-1428 (trigger), :244-281 (merge)
- What / Why it matters: `imageUrls.length > 1 && parsed.bets.length > 1` → ALL bets from ALL buffered images are collapsed into ONE parlay — directly undoing the SHEET-vs-PARLAY prompt rule (services/ai.js:1073) that emits independent straights. Relay channels (Dan/Cody/Gavin/Harry) buffer by author:channel with a resetting 4s timer (`:73`, `:100-101`), so two separate picks relayed within the window merge into a fake parlay whose one losing leg falsely LOSSes the winning pick. Mitigation: merged output is `_confidence:'low'` (`:279`) → `needs_review` (`:1456`), so a human gate exists — but the embed presents a plausible parlay and one click ratifies the wrong shape.
- Evidence: `const betsToSave = (imageUrls.length > 1 && parsed.bets.length > 1) ? [mergeBetsIntoParlay(parsed.bets)] : parsed.bets;` (:1426-1428). Note: the task premise named this "Gavin parlay mis-split" — no Gavin-named incident exists in BACKLOG.md or `git log --grep=gavin` (UNVERIFIED as a named incident); the mechanism above is the only channel-adjacent parlay-splitting defect found.
- Proposed fix: only merge when images share one ticket (same wager/payout or explicit parlay framing); otherwise stage per-image bets as straights, keeping needs_review. (Effort M)
- Backlog: NEW (related: BACKLOG "Let user split a parlay into singles… from the war room embed", :770)

### T2-04 [P2] [confidence: high] Tweet marked processed before parsing — AI failure/rate-limit permanently loses the pick (no retry)
- Where: services/twitter-handler.js:135 (insert), :211-215 (429 continue), :225-227
- What / Why it matters: `INSERT OR IGNORE INTO processed_tweets` runs before the vision/text parse. A 429 or AI error records an ERROR/VISION_EXTRACTION_FAILED row and `continue`s — but the tweet is already in `processed_tweets`, so the scraper's re-delivery dedups at :128-134 and the pick can never be re-attempted. Traceable but unrecoverable; a provider outage silently zeroes a whole polling cycle's picks.
- Evidence: :135 insert precedes the `await delay(3000); aiCalls++` parse block (:172+); 429 path at :211-215 does not delete the dedup row.
- Proposed fix: move the `processed_tweets` insert to after a terminal decision, or delete the row on ERROR paths. (Effort S)
- Backlog: NEW

### T2-05 [P2] [confidence: high] TEXT_EXTRACTION_FAILED drop enum is dead — AI outages masquerade as "indeterminate/non-bet" to the operator
- Where: services/ai.js:1154, :1173 (gated on `options.ingestId`); callers messageHandler.js:510/:1060/:1071, twitter-handler.js:184, commands/bet.js:26
- What / Why it matters: the `recordDrop(TEXT_EXTRACTION_FAILED)` sites inside `parseBetText` only fire when a caller passes `ingestId` — no production caller does (verified by grep: all pass `{ imageUrl }`/`{ tweetId, imageUrl }` only). An AI-unavailable/parse-failed return (`{bets:[], error}`) then flows into the indeterminate branch and is recorded as `PRE_FILTER_AI_EMPTY_RESULT` / held as `ai_indeterminate_no_bets` — the `error` string is not propagated to the hold/drop payload (:1342-1351, :1413-1419). A provider outage is indistinguishable from genuine non-bet content in drop stats. Same inert-`opts.ingestId` class as the documented `maybeDrop` footgun (CODEMAP §linkReader), but this instance is unmapped — pipeline-events.js:76 describes the enum as live.
- Evidence: ai.js:1154 `if (options.ingestId) {`; grep of all `parseBetText(` call sites shows none passing ingestId.
- Proposed fix: propagate `parsed.error` into the indeterminate hold/drop payloads (no new wiring needed), or thread ingestId — but per the CODEMAP footgun, if threading, annotate/dedupe against caller-side writes. (Effort S)
- Backlog: NEW (cross-ref CODEMAP maybeDrop footgun note, #136)

### T2-06 [P2] [confidence: med] MessageUpdate re-entry can double-stage one message (fingerprint keyed on parse output, not message)
- Where: bot.js:498-508; handlers/messageHandler.js:796-798; services/database.js:302-317
- What / Why it matters: embed unfurl (0→N) re-runs the full pipeline under dedup key `update:<id>` by design. The only bet-level dedup is the fingerprint, which hashes capper|channel|message_id|type|description|odds|units — the Update pass parses text+embed content (Create parsed text only), so descriptions differ → different fingerprint → second bet staged for the same message. Text parses default `review_status:'confirmed'` when audit mode is off (`messageHandler.js:1456`; `isAuditMode` = DB setting `audit_mode==='on'`, database.js:1012 — current prod value UNVERIFIED), so duplicates can double-count without a human gate. Likely also a contributor to the BACKLOG "on-ingest duplicate hold rows" observation (:1336-1358) alongside the by-design per-constituent `stageAll` emission (#132 fixed only the /holds view).
- Failure scenario: capper posts pick text + sportsbook link; Create stages bet A; Discord unfurls the card seconds later; Update stages bet B with embed-enriched description.
- Proposed fix: on `isUpdate`, skip staging when a bet with the same `source_message_id` already exists (cheap indexed check), or make Update parse-only-if-Create-dropped. (Effort S)
- Backlog: "On-ingest duplicate hold rows" (BACKLOG :1330-1358) — root cause still open

### T2-07 [P2] [confidence: high] SLIP_IMAGE_CAP overflow is warn-only — silent bet loss with no pipeline_events row
- Where: handlers/messageHandler.js:643-646 (cap 4 at :597)
- What / Why it matters: a slip-feed message with >4 real attachments drops attachments 5+ with `console.warn` only — exactly the explicit-drop-enum P1 class this table exists for; unqueryable after the fact. CODEMAP documents it as "console.warn-only (no new drop enum)" — accepted debt, but it remains a silent-loss point.
- Evidence: `console.warn(\`[SlipFeed] ${attachmentCount} real slip attachments exceed cap…\`)` with no recordDrop (:644-646).
- Proposed fix: `recordDrop` one row per dropped image (`SLIP_IMAGE_CAP_OVERFLOW` or reuse `VISION_EXTRACTION_FAILED` with a `where` tag) using `slipImageIngestId`. (Effort S)
- Backlog: CODEMAP §messageHandler F-07 row (documented caveat); NEW as an action item

### T2-08 [P2] [confidence: med] Discord relay channels have zero content-window dedup — F-12 and its leak-check are twitter-source-only
- Where: services/twitter-handler.js:81 (`source IN ('twitter_text','twitter_vision')`); services/dedupLeakCheck.js:57; handlers/messageHandler.js:1465 (relay bets store `source` = 'twitter'/'vision_slip')
- What / Why it matters: TweetShift re-emits the same tweet as a NEW Discord message on edit/media-attach (BACKLOG :1538 — ~45% of holds are re-emit duplicates). New message id → new fingerprint → both stage if both parse as bets. `findRecentRepost` and the daily leak-check never see Discord-sourced bets, so this dup class is both unguarded and unmonitored. CODEMAP :490 acknowledges relay channels "never reach the F-12 gate" — known, but the exposure is bets, not just holds.
- Failure scenario: Cody's tweet relays at t0 (stages, confirmed), TweetShift re-fires at t0+30s with media attached → second identical bet, both grade, capper record double-counts.
- Proposed fix: extend `findRecentRepost` sources to relay-channel bets (key on capper+normalized-desc+odds as today), or add the source values to dedupLeakCheck first to measure. (Effort S–M)
- Backlog: CODEMAP :490 caveat + BACKLOG :1538 (holds framing) — bet-side gap is NEW

### T2-09 [P2] [confidence: high] Escape hatch stages junk "bets" for every image tweet whose vision+text parses both fail
- Where: services/twitter-handler.js:169 (`structureDetected = hasImages || …`), :232-243
- What / Why it matters: `structureDetected` is unconditionally true for any tweet with an image, so a promo/meme graphic whose vision returns non-bet and whose text fallback returns null is force-staged as `sport:'Unknown', description: text.slice(0,200)` — the COA-audit "escape-hatch junk bets" class, still present at this HEAD. needs_review-gated, but it manufactures review-queue noise and Unknown-sport bets that downstream auto-void paths must then handle.
- Evidence: :236 `pick = { sport: 'Unknown', type: 'straight', description: text.slice(0, 200), … }`.
- Proposed fix: require a text pick-signal (reuse `looksLikePick`) in addition to `hasImages` before escape-hatch staging; otherwise drop with a distinct reason. (Effort S)
- Backlog: BACKLOG :713 "Twitter validator drops on escape-hatch stubs (P3)" (adjacent); COA 2026-06-10 audit "escape-hatch junk bets"

### T2-10 [P3] [confidence: high] CODEMAP drift: messageHandler table ~100 lines stale; PRE_FILTER_MODE / PRE_FILTER_ENFORCE_BUCKETS absent from the env-var table
- Where: docs/CODEMAP.md:170/174/178 vs handlers/messageHandler.js:987/1234/1331; docs/CODEMAP.md §"Env vars that gate behavior"
- What / Why it matters: CODEMAP places `processAggregatedMessage` at 917 (actual 987), is_bet=false at 1128 (actual 1234), indeterminate at 1173 (actual 1331) — the #137 wiring shifted the file and no refresh landed (CODEMAP's own note says a refresh is "owed"). `PRE_FILTER_MODE`/`PRE_FILTER_ENFORCE_BUCKETS` — behavior-gating env vars with an enforce mode that can DROP would-be holds — appear nowhere in CODEMAP (grep: zero hits). Violates CODEMAP workflow rule 5.
- Evidence: `grep -n "PRE_FILTER_MODE" docs/CODEMAP.md` → no output; line comparisons above read directly.
- Proposed fix: refresh the §messageHandler table and add both env vars with off/shadow/enforce semantics. (Effort S)
- Backlog: CODEMAP note "#84: full messageHandler.js table refresh is owed separately"

### T2-11 [P3] [confidence: high] /slip bets carry no fingerprint — repeat /slip of the same image duplicates
- Where: commands/slip.js:46-49 (no messageId passed); services/database.js:304 (`if (!betData.source_message_id) return null;`)
- What / Why it matters: interaction path passes no `source_message_id`, so `buildFingerprint` returns null and dedup is skipped entirely. Owner-facing and needs_review-gated (`messageHandler.js:572`), so low blast radius, but a double-tap /slip yields double bets.
- Proposed fix: pass `interaction.id` as messageId (stable per invocation, still dedups retries of the same interaction) or hash the attachment URL into a synthetic fingerprint. (Effort S)
- Backlog: NEW

### T2-12 [P3] [confidence: med] Multi-image loop discards a result/recap image when sibling images carry bets — no VISION_RESULT_RECAP row, recap not graded
- Where: handlers/messageHandler.js:1074-1091
- What / Why it matters: in the sequential multi-image loop, a `result`/`untracked_win` image is kept only in `parsed` (:1083-1085); if any other image produced bets, `parsed` is overwritten at :1089-1091 and the result image vanishes — no drop row (F17 instrumentation covers only the whole-message classification), no auto-grade. Trace shows EXTRACTED(imageCount=N) then bets staged, with one image unaccounted.
- Proposed fix: record a per-image `VISION_RESULT_RECAP` drop (suffix ingestId as `-img${i}`) when a result-image is superseded by merged bets. (Effort S)
- Backlog: NEW (extends F17 #109)

### T2-13 [P3] [confidence: med] parseBetText Type-4 coerces a `type:'bet'` response missing `is_bet` into `ignore` — populated bets stripped
- Where: services/ai.js:1214-1217
- What / Why it matters: `isBet` requires `is_bet === true` (or string 'true'); a provider response `{type:'bet', bets:[…]}` lacking the flag returns `{type:'ignore', is_bet:false, bets:[]}` — the bets are discarded and downstream records a non-bet drop/hold. Fail-closed toward drop (consistent with the prime directive) and prompt-guarded (all prompt examples emit `is_bet:true`), but it is a real-bet loss vector on provider-shape drift, and it is asymmetric with the Gemma path's check (`:892` treats only explicit ignore/false as non-bet).
- Proposed fix: treat `type==='bet' && bets.length>0` as a bet regardless of the missing flag (mirrors `:1116`'s `quick.type === 'bet' || quick.is_bet === true`). (Effort S)
- Backlog: NEW

## Looked good
- **v335 regression class**: strict `=== false` intact at messageHandler.js:1234; indeterminate guard is the safe two-condition form (:1331); #137 wiring sits entirely inside the branches and defaults to no-op — the hard rule is untouched, matching BACKLOG :302's mandate.
- **Buffer keying** composite `author:channel` (messageHandler.js:73) — F-02 fixed as claimed.
- **F-07 multi-image slip feed** (`selectSlipImages`/`slipImageIngestId`, :597-615) — attachment-only selection, per-image ingestId suffixing, embed thumbnails never multiply-processed.
- **F17 instrumentation** present at all four post-EXTRACTED exits (:1126, :1137, :1189, :1492) matching BACKLOG :159.
- **#84 closures** verified: `no_guild` → CHANNEL_UNAUTHORIZED (:773-775), partial-fetch → recordError (:779-788), GUARD5_INSUFFICIENT_SIGNALS (:975); DubClub bypass author-agnostic with `bypassImages` (:944-957).
- **GUARD 5 bare-total latent bug** (no O/U-total signal in PICK_SIGNALS :202-212) — still present but documented in CODEMAP and queryable since #84.
- **pipeline-events write boundary**: never-throw, soft enum tripwire (F-05), ingest-side ingestId required (pipeline-events.js:176) — sound.
- **F-12 12h repost dedup** (twitter-handler.js:61-90) matches its documented normalize/window/odds-null contract; ladder steps get the same gate (:281-286).
- **Twitter poller and /mobile-ingest converge** on the same audited handler (`services/twitter.js:202`), so drop accounting is shared.

## UNVERIFIED / open questions
- **Live env values**: HUMAN_SUBMISSION (17) / PURE_SLIP (13) / DUBCLUB_SPLIT / ALLOWED_WEBHOOK_IDS (6) counts and the subset invariant are CODEMAP claims verified 2026-05-21 via fly ssh — not re-verifiable read-only here. The **DatDude-pulled-from-PURE_SLIP** memory claim is not reflected in CODEMAP §Channels (still lists #datdude-slips among the 13) and appears in no BACKLOG entry — either doc drift or a stale memory; needs the CODEMAP §Subset-invariant fly one-liner to settle.
- **PRE_FILTER_MODE / OCR_FIRST_MODE / LINK_READER_MODE prod values** — code defaults are off/pass; memory says OCR_FIRST shadow was live; unverifiable here.
- **`audit_mode` DB setting** — determines whether text-parse bets stage as `confirmed` vs `needs_review` (messageHandler.js:1456); materially changes T2-01/T2-06/T2-08 blast radius; needs a prod `SELECT value FROM settings WHERE key='audit_mode'`.
- **"Gavin parlay mis-split"** as a named incident: zero hits in BACKLOG, git log, or prior audits — T2-03 is the mechanism-level match; confirm with operator whether a specific Gavin incident exists outside the repo record.
- **Frequency of T2-01**: how often `type:'result'`/ticket recaps fire in prod (`SELECT … WHERE drop_reason IN ('VISION_RESULT_RECAP','VISION_TICKET_RECAP')`) would size the wrong-grade exposure; not queryable read-only here.
