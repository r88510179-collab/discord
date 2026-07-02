> Track analysis produced by a read-only audit subagent from pinned clones + probe captures;
> reviewed, spot-verified (high-severity evidence lines re-read by the orchestrator), and filed
> by the audit orchestrator. Probe references (P-n, probes/*.txt) resolve to 20-live-probes.md.

# T6 — Cross-repo contracts (edge table) — 2026-07-02

Pinned revisions: bot @19ff594 (worktree /Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07-satellites), scraper @ff1a906, dubclub @633d084, dashboard @d392754, ocr @e21ee2c, ollama-proxy @62b8c6b. All file:line cites verified by direct read at these revisions. Fly env VALUES and the live `audit_mode` DB setting are unreadable under audit rules — anything depending on them is tagged UNVERIFIED.

## Edge table

### Edge 1 — scraper → bot: POST /api/mobile-ingest + GET /api/scraper-handles

**Auth.** Header `x-mobile-secret`, secret name `MOBILE_SCRAPER_SECRET` on both sides, both endpoints. Scraper sends: scraper@ff1a906 scraper.js:29 (env), :187 (ingest header), :299 (handles header). Bot validates fail-closed (unset secret ⇒ 401): bot@19ff594 routes/api.js:22 (ingest), :71 (handles). Same secret grants read (handles) + write (ingest) — single blast radius, documented in SURFACE-PRO.md:102/228.

**Payload schema — POST /api/mobile-ingest.**

| field | scraper builds (scraper.js) | bot consumes | verdict |
|---|---|---|---|
| `handle` | string, no `@` (:173) | routes/api.js:31; cleaned/lowercased twitter-handler.js:98 | match |
| `displayName` | **not sent** | defaults to cleanHandle (twitter-handler.js:99); capper key `twitter_<handle>` (:267) | known gap: raw-handle capper attribution splits (BACKLOG.md:104) |
| `tweets[].id` | `String(t.id)` (:175) | `tweet.id \|\| tweet_id \|\| rest_id \|\| id_str` (twitter-handler.js:108) | match |
| `tweets[].text` | `t.text \|\| ''` (:176) | `text \|\| full_text \|\| tweetText` (:109); **`!text` ⇒ drop before images checked** (:117-119, June M-16b caption-less half) | match; caption-less-drop still present |
| `tweets[].created_at` | ISO or now (:177) | audit `posted_at` only (:113) | match |
| `tweets[].extendedEntities.media[]` | `{type:'photo', media_url_https}` (:178-180) | extractImageUrls first branch (:16-21) | match |
| `tweets[].media[]` | `{type:'photo', url}` (:181) | second branch (:24-29), only if first empty | match (redundant belt+braces) |
| response | reads `(json).count` for log only (:195) | `{status:'accepted', count: tweets.length}` (routes/api.js:50) — count = received, **not staged** | harmless (log-only), but misleading name |

Also accepted bot-side: legacy single-tweet format `{id, text, author}` (routes/api.js:34-38) — unused by this scraper; live mutating surface kept alive on the same secret.

**Bot-down / slow behavior.** POST timeout 30s (scraper.js:189). Non-200/throw ⇒ `{ok:false}` (:191-199) ⇒ processHandle does **not** insert seen_tweets / advance `last_tweet_id` (:250-258) ⇒ full refetch next 5-min cycle. No queueing; correct at-least-once *until the bot answers 200*. Two loss modes remain:
- **Early-200 (June M-16a) still present at HEAD 19ff594**: routes/api.js:49-50 ACKs `200` *before* processing and awaits `handleTwitterWebhookPayload` after (:52-55). Scraper marks all tweets seen on that 200 (scraper.js:251-256). A Fly restart/deploy/crash mid-batch (~3s/tweet AI pacing, twitter-handler.js:172) loses the batch permanently. Amplifier: bot inserts into `processed_tweets` *before* parsing (twitter-handler.js:135), so even a hypothetical resend would dedup-drop.
- **Bounded fetch window**: fetch depth is fixed at 10/cycle (scraper.js:43,208). If the bot is down long enough for a capper to post >10 tweets, the older ones scroll out of the window when ingestion resumes — silent, uncounted.

**GET /api/scraper-handles.** Bot returns `{handles:[...]}` `WHERE enabled=1` (routes/api.js:76-81). Scraper: 10s timeout (scraper.js:296), success (incl. **empty array**) is authoritative and overwrites the cache (:306-311); failure ⇒ on-disk `active_handles.json` cache (:322-327) ⇒ built-in 9-handle const (:23-26,329-330). Empty active set sets `eligible:false` so the dead-air alarm is deliberately suppressed (:361-367) — see CT-11.

**Drift verdicts.** Wire shapes in sync. M-16a and the caption-less `!text` drop both still open at bot HEAD (BACKLOG M-16 unresolved). `count` semantics cosmetic.

### Edge 2 — dubclub → Discord webhooks → bot messageHandler

**Auth / resolution.** No shared secret with the bot; trust = Discord webhook possession + bot-side allowlist. dubclub: `config.json[capperKey].webhookUrlEnvVar` → env **`GNP_WEBHOOK_URL`** / **`LOCKEDIN_WEBHOOK_URL`** (dubclub@633d084 index.js:177; config.json keys `GuessAndPrayBets`→channel 1473343838587457626, `TeamLockTalk`→channel 1473343783876821198). Payload per pick: `{content: "<capper>\n<normalizePick(pick)>", username: <capper>}` (index.js:128-134, 236-238; whole-slip fallback :260-263). Bot: webhook must hit `ALLOWED_WEBHOOK_IDS` (messageHandler.js:315-323) AND land in an authorized channel (PICKS/SLIP/SUBMIT/HUMAN, :327-339). Channel-ID linkage config.json↔Fly `DUBCLUB_SPLIT_CHANNEL_IDS`/`CAPPER_CHANNEL_MAP` is env-value-dependent — UNVERIFIED.

**Full path of a GNP pick → bet row** (gates in order, at bot HEAD):
1. globalPipelineGuard: allowlist + channel (:303-346) — enforced.
2. Hard filters: `replying to` (:860), vxtwitter-no-pick (:865) — enforced.
3. handleSlipFeed (:872) — no-op (not the slip channel).
4. GUARD 3 replies in mapped channels (:887); **GUARD 4 age>2min drop (:893-897)**.
5. Image-only guard (:910-919) — webhook is bot ⇒ whitelisted.
6. **DUBCLUB SPLIT BYPASS (:944-961): skips the 4s aggregation buffer AND GUARD 5 signal heuristic** — straight into `processAggregatedMessage` with `images=[]` for webhook authors (:954).
7. In processAggregatedMessage: capper via `CAPPER_CHANNEL_MAP` (resolveCapper :392-395, source='discord'); outer settled-marker + `evaluateTweet` reject_settled pre-filters (:1040-1053); AI parse; `validateParsedBet` (:1437); `createBetWithLegs` with `review_status = (isAuditMode() || bet._confidence==='low') ? 'needs_review' : 'confirmed'` (:1455-1456,1472).

**Gates a webhook pick bypasses vs a human message elsewhere:** aggregation buffer, GUARD 5 (≥2-signal heuristic). Gates it *never* sees vs the twitter path: `processed_tweets` id-dedup, **F-12 12h content dedup** (`findRecentRepost` filters `source IN ('twitter_text','twitter_vision')`, twitter-handler.js:76-83 — dubclub bets are source `'discord'`, messageHandler.js:1465), and twitter's hard-coded `review_status:'needs_review'` (twitter-handler.js:287,318).

**Dedup coverage on this path** = fingerprint only, and the fingerprint hashes `source_message_id` (database.js:303-317) ⇒ any re-post is a **new Discord message id ⇒ new bet row**. June U-2's downstream half is unfixed at bot HEAD (CT-3).

**Far-side-down behavior.**
- *Discord down / webhook non-2xx:* split loop breaks on first failure, email left unseen "for retry" (index.js:239-254) — but retry only fires on the next unrelated `exists` event, a watchdog relaunch, or a process restart (no sweep timer — June U-3 unfixed, index.js:389-405; only safeSweep callers are initial :404, `exists` :389-392, onRelaunch browser-watchdog wiring :334). Already-posted picks 1..k re-post from pick 0 on that retry ⇒ duplicates (CT-3).
- *Bot down (Fly deploy/restart), Discord up:* Discord returns 2xx, dubclub marks `\Seen` (:268-276) and will never resend; the bot has **no startup backfill** (only single-message re-fetch, messageHandler.js:132) and GUARD 4 drops anything >2min old anyway ⇒ **picks posted during any bot downtime window are permanently, silently lost** (CT-2). Same class applies to scraper→bot? No — that edge retries. Unique to the webhook edges.

**Drift verdicts.** Code comment at messageHandler.js:942-943 ("war-room needs_review still gates everything that gets through") and June audit's "war-room human gate is the only stop" are contradicted by :1455-1456 unless the DB setting `audit_mode='on'` (database.js:1012-1014) — live value UNVERIFIED (CT-4). U-2/U-3 BACKLOG state (open) matches code — no doc drift, just unfixed.

### Edge 3 — dashboard → bot /api/admin/*

**Auth.** Dashboard→bot: `Authorization: Bearer` + secret name **`ADMIN_API_SECRET`**, injected server-side (dashboard@d392754 server.js:32,92); bot verifies timing-safe, fail-closed 503 when unset (routes/adminAuth.js:30-53, mounted router-wide routes/admin.js:40, per-route adminCommands.js:96,147,208,249). Browser/tailnet-client→dashboard: **no auth** — protection is loopback bind (server.js:30) + `tailscale serve` tailnet-only :8444 (probes/exposure.txt:33,42).

**Endpoint inventory at bot HEAD 19ff594 vs proxy gate (server.js:155-165: GET = always forwarded; non-GET = 4 anchored POST regexes :74-77, else 405).**

| bot endpoint | file:line | dashboard-reachable? |
|---|---|---|
| GET /holds | routes/admin.js:178 | yes (generic GET) |
| GET /bets | :290 | yes |
| GET /handles | :333 | yes |
| GET /logs (admin-log channel tail) | :350 | yes |
| GET /leaderboard (#161) | :399 | yes — **auto-exposed, no dashboard change** (confirmed consumed: probes/tails-pm2-logs dashboard out-4 shows 200s) |
| GET /drops (#161) | :443 | yes — auto-exposed |
| GET /grader-health (#161) | :497 | yes — auto-exposed |
| POST /holds/:id/dismiss | adminCommands.js:96 | yes (DISMISS_PATH, no body ⇒ actor defaults 'dashboard', :79-80) |
| POST /holds/:id/recover | :147 | yes (RECOVER_PATH, no body ⇒ `force` never sent — cap bypass unreachable from dashboard, :130-131) |
| POST /handles/:handle | :208 | yes (rebuilt `{enabled, note?}` body only, server.js:183-187) |
| POST /bets/:id/approve | :249 | yes (APPROVE_PATH, no body) |

**Far-side-down behavior.** `UPSTREAM_TIMEOUT_MS = 15_000` (server.js:54) on fetch AND body-read (mid-body guard :118-125 — June D-1 fixed, verified in-tree). Timeout/refused ⇒ 502 JSON; no retry, no queue — correct for an operator UI, **except** recover: bot-side recover runs Discord fetch (3 attempts + 0.5/1.5s backoffs, holdReview.js:218-219) plus vision extraction (provider timeouts 15–90s, ai.js:134,820) ⇒ routinely >15s ⇒ dashboard shows 502 while the bot keeps going and often succeeds. Live-corroborated: 12+ `POST .../recover -> ERROR (TimeoutError)` incl. a repeat on the same ingest id (probes/tails-pm2-logs.txt:404-415). Bot-side `inFlightRecoveries` + `already_recovered` self-heal (holdReview.js:448-457,483-491) prevent double-create on re-click — deception, not corruption (CT-7).

**Drift verdicts.** Status-string contract in sync: server.js header comments (:10-15,63-73) match adminCommands.js maps (:64-69,:101-112,:153-156) incl. `validator_drop`/`recovery_exhausted`/actor-default. "FOUR writes" comment matches 4 regexes (June D-3 class fixed). Structural note: the generic-GET forward means every **future** bot read endpoint is instantly reachable by any tailnet device with zero dashboard-side review — accepted-by-design today, worth a stated invariant (CT-10).

### Edge 4 — bot → zonetracker-ocr: POST /ocr (edge view; T1 owns depth)

**Auth.** `Authorization: Bearer` + secret name **`OCR_SERVICE_TOKEN`** both sides (bot services/localOcr.js:46,121; ocr@e21ee2c app.py:62, constant-time compare :168-169). Empty server token ⇒ every request 401 (app.py:83-84).

**Schema.** Request `{imageBase64, mediaType?, requestId?, source:'ocrFirst'}` (localOcr.js:123-128) = CONTRACT.md table exactly. Response handling mirrors CONTRACT field-for-field: 401/413 ⇒ `HTTP_4XX` non-breaker (:136-139); 5xx/503-model-not-loaded ⇒ `HTTP_5XX` breaker-tripping (:132-135); `200 ok:false` decode-failure envelope ⇒ `BAD_RESPONSE`, non-tripping (:150-155); `ok:true` unpacks text/lines/confidence/latencyMs/imageHash/width/height (:160-170). **No drift found** — the "bot repo mirrors this file" promise holds at both pinned HEADs.

**Far-side-down.** Timeout `OCR_TIMEOUT_MS` default 8000ms (:47) vs observed server-side ~1–3s OCR (probes/health-curls: model load 1035ms; SHARED: OCR ~3s) + Funnel RTT — adequate headroom. No retry per call; circuit breaker: 3 consecutive TIMEOUT/UNREACHABLE/HTTP_5XX ⇒ open 60s, `CIRCUIT_OPEN` with zero network (:35-39,:48-49,:76-83,:108-111); healthz 200 closes it (:196-200). Every failure code funnels to `FALLBACK_GEMINI` in ocrFirst.js:234-241 — i.e., OCR outage ⇒ the pre-existing Gemini vision path, **no ingest loss, only cost/latency**. Whole seam is gated `OCR_FIRST_MODE` off|shadow|cutover, default off (ocrFirstWiring.js:37-42; live mode UNVERIFIED).

### Edge 5 — bot → ollama-proxy → ollama: x-ollama-secret

**Auth.** Header `x-ollama-secret`, secret name **`OLLAMA_PROXY_SECRET`**. Proxy: exact-match reject 401, strips header, forwards to `127.0.0.1:11434`, 502 on upstream error, no upstream timeout of its own (ollama-proxy@62b8c6b proxy.js:6,11-18,29,36-40). Bot senders (all attach the header only if the env is set):
- text-parse waterfall provider `ollama` (needs only `OLLAMA_URL` to enlist — ai.js:57-64,82; header :139-140; 25s timeout :134). If `OLLAMA_PROXY_SECRET` is unset the bot still calls and eats 401s — fails through, no crash.
- AI-grader waterfall, position **7 of 8** (after groq-scout/cerebras/groq-qwen/openrouter/groq-gpt-oss/mistral, before groq-llama8b last-resort — grading.js:3368-3392; header :3441-3442; 25s timeout :3439).
- Gemma vision fallback `tryVisionGemma` `/api/generate`, 90s timeout, own circuit breaker; hard-disabled when `GEMMA_FALLBACK_DISABLED==='true'` (ai.js:801-855, gate :983 — live value UNVERIFIED, memory says disabled).
- `/admin gemma-health` probes `/api/tags` (3s) + `/api/generate` (10s) (commands/admin.js:1041-1043,1066-1070).

**Proxy/ollama outage effect on grading:** each graded bet pays ≤25s on the ollama attempt then falls through to groq-llama8b (39% hallucination per grading.js:3365-3367 comment); if *everything* fails ⇒ PENDING, retried later (:3483-3486). No data loss; latency + quality degradation only.

**Drift verdicts.** Header/secret names in sync across bot/proxy/SURFACE-PRO.md. Two notes: (1) **ollama itself binds `*:11434` unauthenticated** (probes/exposure.txt:14) — anything on LAN/tailnet can bypass the proxy entirely (CT-9); (2) SURFACE-PRO.md:246 cites `services/grading.js:3076` as the grader's secret site — at HEAD that line is the parlay-leg loop; the real site is :3441-3442 (CT-12).

### Edge 6 (caught, minimum-set +) — alert webhooks: scraper `ALERT_WEBHOOK_URL`, dubclub `ADMIN_ALERT_WEBHOOK_URL` → Discord
Covered in Alert-path inventory below; the load-bearing discovery is CT-5 (alarm webhook died exactly when the alarm fired).

## Findings

**CT-1 — /api/mobile-ingest early-200 still converts at-least-once to at-most-once (June M-16a unfixed at 19ff594)**
Severity P1 | Confidence high | Evidence: bot routes/api.js:49-55 (200 before processing, async after); scraper scraper.js:250-257 (cursor+seen advance on the 200); amplifier twitter-handler.js:135 (processed_tweets insert before parse). | Impact: Fly restart/deploy mid-batch permanently loses every unprocessed tweet in the batch; scraper believes delivery succeeded; nothing re-sends. | Fix: persist-then-ack (synchronous insert to an `ingest_queue` table before the 200, drain async, delete on completion) exactly per June resolution; alternatively ack after `handleTwitterWebhookPayload` with scraper timeout raised. | Effort M | BACKLOG: M-16(a) — open since 2026-06-10.

**CT-2 — DubClub picks posted while the bot is down are permanently and silently lost (webhook edge has no delivery coupling)**
Severity P1 | Confidence high (mechanism), medium (frequency) | Evidence: dubclub index.js:268-276 (`\Seen` on Discord 2xx — Discord accepts regardless of bot state); bot has no startup message backfill (only the single-message unfurl re-fetch, messageHandler.js:132; no `messages.fetch` catch-up anywhere in bot.js/messageHandler.js); GUARD 4 drops messages >2min old even on replay (messageHandler.js:893-897). | Impact: every bot deploy/restart window (routine on Fly) is a silent loss window for GNP/LockedIn picks — dubclub reports success, bot never saw the message, no drop event exists anywhere. Also applies to any other allowlisted webhook feed. | Fix (pick one): boot-time bounded backfill of `DUBCLUB_SPLIT_CHANNEL_IDS` channels (last N minutes, dedup via fingerprint — needs GUARD 4 exemption for the backfill path), or move dubclub to an authenticated bot HTTP endpoint with the scraper's retry semantics. | Effort M | BACKLOG: NEW (adjacent to U-2/U-3 but distinct).

**CT-3 — dubclub partial-failure re-post duplicates: U-2 downstream half unfixed at bot HEAD**
Severity P2 (escalates to P1 if `audit_mode` is off — see CT-4) | Confidence high | Evidence: dubclub index.js:239-254 (break on first split-post failure, leave unseen, next sweep re-posts from pick 0; picks 1..k already delivered); bot fingerprint includes `source_message_id` (database.js:305-317) so a re-post = new message id = new bet; content-window dedup is twitter-source-only (twitter-handler.js:76-83) and dubclub bets are `source='discord'` (messageHandler.js:1465). Also: success-then-`messageFlagsAdd`-failure re-posts the whole sheet (index.js:276-279). | Impact: duplicate bet rows for the same pick, inflating capper records; only the (conditional) needs_review gate stops them reaching the graded ledger. | Fix: bot-side — extend `findRecentRepost` to `source='discord'` webhook-channel bets (same 12h window); dubclub-side — persist per-email post progress keyed `UIDVALIDITY:UID` (June U-2 resolution). | Effort S (bot) / M (dubclub) | BACKLOG: U-2.

**CT-4 — "war-room needs_review gates everything" comment is contradicted by code: split-bypass picks save as `confirmed` unless the `audit_mode` DB setting is on**
Severity P2 | Confidence high (code), UNVERIFIED (live setting) | Evidence: messageHandler.js:942-943 (bypass justification comment) vs :1455-1456 (`reviewStatus = (isAuditMode() || bet._confidence==='low') ? 'needs_review' : 'confirmed'`); isAuditMode = DB `settings.audit_mode==='on'` (database.js:1012-1014); contrast twitter path hard-codes `'needs_review'` (twitter-handler.js:287,318). | Impact: if audit_mode is off, GNP/LockedIn webhook picks skip human review entirely — combined with CT-3 that is unreviewed duplicate feed into grading; the in-code invariant used to justify the GUARD 5 bypass silently depends on a runtime toggle. | Fix: pin `review_status:'needs_review'` for `isDubclubSplitChannel` webhook saves (mirror twitter), or document the audit_mode dependency where the bypass is justified. | Effort S | BACKLOG: NEW (downstream of U-2's "war-room gate" assumption).

**CT-5 — Scraper dead-air alarm webhook shares its failure domain with the monitored network — live-proven silent alarm on Jun 23**
Severity P2 | Confidence high | Evidence: probes/tails-repo-logs.txt:255-261 — `[Alarm] 🚨 ... Dead air: 0 tweets fetched across ALL handles for 6 consecutive cycles` immediately followed by `[Alarm] webhook failed: The operation was aborted due to timeout` (repeated at cycles 9 and 12); root cause was box-wide `ERR_CONNECTION_TIMED_OUT` (same lines, x.com fetches). sendAlert downgrades to console-only by design (scraper.js:264-280). Bot-side complement absent: nearest is the 7-day dead-handle alert (healthReport.js:258-263), not the June-proposed "no mobile-ingest for N hours" check. | Impact: the exact outage class S-01 was built for (network loss) is also the class the Discord webhook cannot traverse — a ≥45-min total feed outage alarmed only into an unrotated local log. | Fix: bot-side ingest-freshness alert (twitter_audit_log/pipeline_events already carry timestamps; alert #admin-log when 0 mobile-ingest RECEIVED events in N hours during active windows). | Effort S | BACKLOG: M-16b complement to S-01 — open.

**CT-6 — Per-handle strike→disable→retry loop never alerts: single-capper feed death is silent indefinitely**
Severity P2 | Confidence high | Evidence: scraper.js:214-221 (strike/disable path logs only, no sendAlert); dead-air alarm is cycle-global all-zero (`recordCycle({fetchedTotal, ...})` scraper.js:363-367; threshold logic watchdog.js:109-121) so one dead handle among live ones never trips it; Jun 23 log shows 7 handles hitting `[Disable] ... cooldown 6h` (probes/tails-repo-logs.txt:206-254). Backstop is the 7-day bot-side dead-handle alert (healthReport.js:258-263). | Impact: a capper whose page layout/redirect breaks polls in a strike(5)→disable(6h) loop for up to 7 days before any operator signal; their picks are silently absent. | Fix: sendAlert on the `[Disable]` transition (rate-limited per handle per 24h) — transport already exists. | Effort S | BACKLOG: NEW (S-01 residual).

**CT-7 — Dashboard 15s proxy timeout < bot recover runtime: operators see 502 for recovers that succeed**
Severity P2 (operator-deception) | Confidence high | Evidence: server.js:54 (`UPSTREAM_TIMEOUT_MS=15_000`) vs recover cost = Discord fetch ≤3 attempts +0.5/1.5s backoff (holdReview.js:218-219) + vision extraction with 15–90s provider timeouts (ai.js:134,:820); live: 12+ `recover -> ERROR (TimeoutError)` incl. one id twice (probes/tails-pm2-logs.txt:404-415). Bot-side `inFlightRecoveries` + `already_recovered` (holdReview.js:448-457,483-491) prevent double-create, and each abandoned-but-continuing recover still burns vision quota against `RECOVERY_RETRY_CAP=5` (:410) on real failures. | Impact: operator retries a "failed" recover that already worked or is in flight; UI state contradicts DB state; repeated clicks burn attempts toward recovery_exhausted on genuinely-failing holds. | Fix: recover-specific upstream timeout (60s) or 202-with-poll pattern; surface `in_flight`/`already_recovered` statuses in the UI copy. | Effort S | BACKLOG: NEW (post-June; D-1 fixed the crash half — mid-body guard verified in-tree at server.js:118-125).

**CT-8 — dubclub "leave unseen for retry" still has no retry trigger (June U-3 unfixed at 633d084)**
Severity P2 | Confidence high | Evidence: index.js — safeSweep callers are exactly: initial sweep (:404), IMAP `exists` (:389-392), watchdog onRelaunch (:334). No sweep interval exists (only setInterval in the repo is the browser probe, browser-watchdog.js:217). Live corroboration: login-wall UIDs re-processed only at irregular sweep triggers (probes/tails-pm2-logs.txt:95-105). | Impact: a transient webhook/scrape failure on the night's last email delays those picks until the next unrelated email or the ~4/day IMAP restarts; retries are luck-scheduled. | Fix: June U-3 one-liner — `setInterval(safeSweep, 10*60*1000)` + clearInterval in cleanup; the sweeping/pendingSweep mutex (:371-387) already makes it safe. | Effort S | BACKLOG: U-3.

**CT-9 — ollama listens on `*:11434` with no auth: the proxy's secret is bypassable from LAN/tailnet**
Severity P2 | Confidence high | Evidence: probes/exposure.txt:14 (`LISTEN ... *:11434`); proxy loopback-only :11435 (:10) is the only authed path (proxy.js:11-18,45); probes/health-curls: `:11434 → "Ollama is running"`. | Impact: any LAN or tailnet device gets free inference/model-pull/delete on the box (resource burn, model tampering); the Funnel-public path stays authed, so this is adjacency exposure, not internet exposure. | Fix: `OLLAMA_HOST=127.0.0.1` in ollama.service. | Effort S | BACKLOG: NEW (host-hardening class; overlaps June H-findings — flagging from the edge view since it nullifies Edge 5's auth on-box).

**CT-10 — Dashboard generic-GET forwarding auto-exposes every current and future bot read endpoint to unauthenticated tailnet clients**
Severity P3 (accepted-by-design; watch item) | Confidence high | Evidence: server.js:159 (only non-GET is gated), :192-193 (GET forwarded verbatim); #161's brand-new /leaderboard /drops /grader-health were consumable with zero dashboard change (bot routes/admin.js:399,443,497; consumption confirmed in dashboard out-4 probe); /logs = admin-log Discord channel tail (routes/admin.js:350) also reachable; dashboard itself has no auth layer (June D-2, still true — no middleware in server.js). | Impact: the bot-side read surface now grows without any dashboard-side review gate; any device on the tailnet reads holds/bets/logs/leaderboard. | Fix: none required today; record the invariant ("adding a GET /api/admin route on the bot = exposing it to the whole tailnet") in SURFACE-PRO.md + routes/admin.js header. | Effort S | BACKLOG: NEW (doc).

**CT-11 — An all-disabled `scraper_handles` table silently stops the entire feed with the dead-air alarm deliberately suppressed**
Severity P3 | Confidence high | Evidence: empty `{handles:[]}` is authoritative and cache-overwriting (scraper.js:306-311); cycle then runs 0 handles and reports `eligible:false` ⇒ watchdog no-ops (scraper.js:361-367; watchdog.js "intentionally-empty ... is not dead air"). The dashboard handle-toggle write (adminCommands.js:186-188) makes all-disable a few clicks. | Impact: operator footgun — "disabled the last handle" is indistinguishable from a healthy quiet system; no alarm will ever fire. | Fix: scraper logs loudly + one-shot sendAlert when active set transitions non-empty→empty; or bot refuses to disable the last enabled handle without `force`. | Effort S | BACKLOG: NEW.

**CT-12 — SURFACE-PRO.md cites a stale grader line for the x-ollama-secret site**
Severity P3 (doc drift) | Confidence high | Evidence: docs/SURFACE-PRO.md:246 cites `services/grading.js:3076`; at HEAD 19ff594 that line is the parlay-leg grade loop (verified), the actual header-injection site is grading.js:3441-3442 (ai.js:140 and commands/admin.js:1042,1068 cites remain correct). | Impact: line-anchored runbook misdirects during an incident. | Fix: update the anchor. | Effort S | BACKLOG: NEW (doc sweep).

## Alert-path inventory

| service | env name | transport | fires on | if webhook dead/unset | verdict |
|---|---|---|---|---|---|
| zonetracker-scraper | `ALERT_WEBHOOK_URL` | Discord webhook | dead-air ≥3 all-zero cycles + recovery (scraper.js:264-280; watchdog.js:103,114); 10s timeout, never throws | unset ⇒ console.error only (by design, :39); dead ⇒ `[Alarm] webhook failed` console line only — **live-observed failing during the very outage it reported (Jun 23)** | CT-5; also note env lives in gitignored ecosystem.config.js on a box still one commit behind (#5 eco-untrack not deployed — probes/checkouts.txt) |
| zonetracker-scraper (gap) | — | none | per-handle strike/disable (scraper.js:216-220) | console only, always | CT-6 |
| zonetracker-dubclub | `ADMIN_ALERT_WEBHOOK_URL` | Discord webhook | login wall (index.js:198), empty scrape (:207), split-dropped lines (:225), 0-pick fallback (:258), watchdog relaunch/dead-air/fatal (browser-watchdog.js:143,164,189,205; dead-air default 24h `DEAD_AIR_MAX_MS`) | unset ⇒ errlog only (:138-140); non-ok/throw ⇒ errlog only (:144-147) — silent-alarm class, no retry | works when Discord+network up; login-wall re-alerts every sweep with no cooldown (June U-7 residual — live spam since Jul 1, probes/tails-pm2-logs.txt:95-105) |
| bot (bettracker) | `ADMIN_LOG_CHANNEL_ID` (channel id, not webhook) | Discord bot client send | strict-mode unauthorized pipeline triggers (messageHandler.js:805-815, per-channel cooldown), pipeline errors (reportErrorToAdmin :1537-1549) | channel missing/client down ⇒ swallowed catch, console only | depends on the same Discord session it monitors — acceptable for its scope |
| zonetracker-dashboard | — | none | — | all failures are console+HTTP-response only | fine (interactive UI) |
| zonetracker-ocr | — | none | — | uvicorn logs only | fine (bot-side breaker + gemma fallback absorb it) |
| zonetracker-ollama-proxy | — | none | — | console 401/error lines only (and real client IP is invisible behind tailscaled — probes/tails-ocr-proxy.txt) | fine (bot waterfall absorbs it) |
| dubclub feed webhooks | `GNP_WEBHOOK_URL`, `LOCKEDIN_WEBHOOK_URL` | Discord webhook (feed, not alarm) | every pick | non-2xx ⇒ leave-unseen retry with no timer (CT-8); 2xx while bot down ⇒ permanent silent loss (CT-2) | the only feed edge with neither retry-against-the-bot nor loss accounting |

## Looked good

- **Edge 4 is a model contract**: CONTRACT.md and services/localOcr.js are in field-level lockstep (verified every request/response field and status code); breaker-tripping vs non-tripping error taxonomy is correct (auth/4xx can't flap the breaker); every failure lands in the pre-existing Gemini path so an OCR outage costs money, never bets.
- **Scraper cursor discipline**: seen_tweets + last_tweet_id advance only after a 2xx (scraper.js:250-258), handles-endpoint empty-set vs fetch-failure semantics are carefully distinguished (authoritative-empty vs cache fallback, :306-330), and the handles cache is write-through with a last-resort const.
- **Admin auth stack**: single shared fail-closed timing-safe bearer middleware (routes/adminAuth.js) on both read and write routers; dashboard never forwards client headers, never echoes upstream headers, rebuilds the one body it forwards (server.js:90-95,183-187); write surface is 4 anchored regexes with the June mid-body 502 guard now in-tree (:118-125); dismiss/recover/handle/approve status enums match the dashboard's expectations string-for-string.
- **Recover idempotency**: in-flight set + already_recovered self-heal + retry cap with explicit force override (holdReview.js:448-507) means the observed dashboard timeout storm produced zero duplicate bets.
- **Ollama outage containment**: grader waterfall position 7/8 with per-provider try/catch and PENDING-on-total-failure (grading.js:3436-3486) — a Surface Pro power-off degrades grading quality/latency, never corrupts a result.
- **globalPipelineGuard** as single choke point: webhook allowlist + channel authorization evaluated identically for Create and Update paths (messageHandler.js:303-346), with the DubClub bypass placed *after* it — the bypass skips heuristics, never authorization.
