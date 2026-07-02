# T5 SECURITY — 2026-07-01 audit appendix

Scope: every Express route in `routes/` + `bot.js`; SQL construction discipline; SSRF/prompt-injection/secret-logging surfaces. HEAD 19ff594. All findings verified against on-disk code at this HEAD.

## Endpoint inventory (verified)

| Method + path | Handler | Auth mechanism | Body-size | Rate limit |
| --- | --- | --- | --- | --- |
| GET `/` | bot.js:11 | none (liveness) | — | none |
| GET `/health` | bot.js:12 | none | — | none |
| GET `/api/health` | routes/api.js:11 | none | — | none |
| POST `/api/mobile-ingest` | routes/api.js:19 | `MOBILE_SCRAPER_SECRET` via `x-mobile-secret`, **`!==` compare (not timing-safe)** | global `express.json()` default 100kb | none |
| GET `/api/scraper-handles` | routes/api.js:68 | `MOBILE_SCRAPER_SECRET`, `!==` compare | — | none |
| POST `/api/admin/holds/:ingestId/dismiss` | adminCommands.js:96 | `adminAuth` (timing-safe Bearer) | 100kb | none |
| POST `/api/admin/holds/:ingestId/recover` | adminCommands.js:147 | `adminAuth` | 100kb | none |
| POST `/api/admin/handles/:handle` | adminCommands.js:208 | `adminAuth` | 100kb | none |
| POST `/api/admin/bets/:id/approve` | adminCommands.js:249 | `adminAuth` | 100kb | none |
| GET `/api/admin/holds` | admin.js:178 | `adminAuth` | — | none |
| GET `/api/admin/bets` | admin.js:290 | `adminAuth` | — | none |
| GET `/api/admin/handles` | admin.js:333 | `adminAuth` | — | none |
| GET `/api/admin/logs` | admin.js:350 | `adminAuth` | — | none |
| GET `/api/admin/leaderboard` (#161) | admin.js:399 | `adminAuth` | — | none |
| GET `/api/admin/drops` (#161) | admin.js:443 | `adminAuth` | — | none |
| GET `/api/admin/grader-health` (#161) | admin.js:497 | `adminAuth` | — | none |
| POST `/api/webhooks/apify` | bot.js:32 | none — 410 stub, no processing | 100kb | none |

`adminAuth` (routes/adminAuth.js:22-53) is correct: fail-closed 503 when `ADMIN_API_SECRET` unset, `crypto.timingSafeEqual` with length guard, never echoes the token. `APIFY_WEBHOOK_SECRET` is no longer referenced (webhook is a 410 stub). `ALLOWED_WEBHOOK_IDS` gates Discord message authors, not HTTP.

---

### T5-01 [P2] [confidence: high] Blind SSRF: image fetchers have no host allow-list on the legacy vision/OCR path
- Where: services/ai.js:344 (`processImageForAI`), services/ocr.js:24 (`extractTextFromImage`)
- What / Why it matters: Both do `await fetch(imageUrl)` with **no protocol or host validation**. `imageUrl` is untrusted: from Discord `embed.image.url` (messageHandler.js:428/449 — arbitrary URL set by the poster) and from third-party tweet media (`extractImageUrls` → twitter-handler.js:184 `parseBetText(..., imageUrls[0])` → processImageForAI). An attacker who can post an embed in an ingest channel, or influence a scraped tweet's `media_url_https`, makes the bot issue server-side GETs to arbitrary hosts (internal Fly services, `http://` targets, cloud metadata). Blind (response feeds the vision model, not returned), but still a working SSRF. Note the contrast: the newer OCR-first path DOES gate this — `fetchImageBytes` restricts to `https:` + `{cdn.discordapp.com, media.discordapp.net}` (ocrFirstWiring.js:252, ALLOWED_IMAGE_HOSTS L62). The legacy paths that actually run in prod today were never hardened.
- Evidence: `services/ai.js:344 const res = await fetch(imageUrl);` (no URL parse); `services/ocrFirstWiring.js:252 if (parsedUrl.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(...))` shows the allow-list exists but only on the wiring path.
- Proposed fix: Factor the ocrFirstWiring allow-list (`new URL` + `https:` + Discord/Twitter CDN host set) into a shared `assertFetchableImageUrl()` and call it at the top of `processImageForAI` and `extractTextFromImage`; reject others without fetching. (Effort S)
- Backlog: NEW

### T5-02 [P2] [confidence: high] No rate limiting on any HTTP endpoint (F-03 half-open)
- Where: bot.js:9-37 (no `express-rate-limit`/`helmet`/`slow-down` — absent from package.json); routes/api.js:19, routes/admin.js, routes/adminCommands.js
- What / Why it matters: F-03 (2026-05-22 audit, P1) called for "`express.json({limit})`, per-IP throttle, malformed-body tests." The body-size half is actually covered by `express.json()`'s default 100kb cap, but **there is still zero rate limiting anywhere**. `/api/mobile-ingest` accepts a secret via header then does unbounded async work per request (parse + vision + DB writes); the admin write routes (`approve`, `handles`, `dismiss`, `recover`) have no throttle, so a leaked/guessed `ADMIN_API_SECRET` or `MOBILE_SCRAPER_SECRET` allows unbounded credential-brute-force and grader/vision cost amplification. `recoverHold` in particular spends vision/OCR budget per call.
- Evidence: `grep -in "rate-limit\|helmet\|slow-down" package.json` → NONE; `bot.js:10 app.use(express.json());` (no per-route limiter). Prior audit: `docs/audits/2026-05-22-full-audit.md:11,163-168`.
- Proposed fix: Add `express-rate-limit` — a strict per-IP limiter on `/api/admin/*` and `/api/mobile-ingest` (e.g. 30/min), lenient on read GETs. Optionally `helmet`. Close F-03. (Effort S)
- Backlog: F-03 (docs/audits/2026-05-22-full-audit.md)

### T5-03 [P2] [confidence: med] Non-timing-safe comparison of `MOBILE_SCRAPER_SECRET`
- Where: routes/api.js:22 and routes/api.js:71
- What / Why it matters: Both scraper-facing routes compare `secret !== process.env.MOBILE_SCRAPER_SECRET` with a plain `!==`, which short-circuits on first differing byte — a classic timing side-channel. The admin router deliberately uses `crypto.timingSafeEqual` (adminAuth.js:26) for exactly this reason, so this is an inconsistency, not an oversight of principle. `MOBILE_SCRAPER_SECRET` guards ingest (`/mobile-ingest`) and the handle list; recovering it via timing over the network is hard but the fix is trivial and the codebase already has `safeEqual` exported.
- Evidence: `routes/api.js:22 if (!process.env.MOBILE_SCRAPER_SECRET || secret !== process.env.MOBILE_SCRAPER_SECRET)`; vs `routes/adminAuth.js:26 return crypto.timingSafeEqual(a, b);`
- Proposed fix: Import `safeEqual` from `./adminAuth` and use it in both `/mobile-ingest` and `/scraper-handles` (guard the unset case first). (Effort S)
- Backlog: NEW

### T5-04 [P2] [confidence: med] Evidence-poisoning / prompt-injection can drive a wrong grade; Gate 4 (the date-bound defense) is still shadow
- Where: services/grading.js:3398 (`evidenceForModel = searchSnippets`), :3414-3418 (prompt interpolates `bet.description` + snippets), :3542-3549 (Gate 4 forcePending)
- What / Why it matters: The grader prompt is built from (a) `bet.description` — untrusted slip/tweet text — and (b) `evidenceForModel`, raw web-search snippets keyed off a query derived from that same text (`buildGraderSearchQuery`, :2096). Gate 3 (:3504) mitigates hallucination by requiring `evidence_quote` to be an exact substring of the snippet blob, but it does NOT verify the snippet's *provenance* — if an attacker gets adversarial text (fake "Final score X 118 Y 112") into the search results for a target game (a controlled tweet/page the query surfaces), Gate 3 binds to it and the bet grades wrong. GUARD 5 (:3553, scores-in-snippets) and Gate 4 (off-date reject) are the backstops, but per docs/CODEMAP.md:576 `DATE_BOUND_GRADING` is "**staged shadow; not yet flipped**" — so the date-provenance check does not currently force PENDING in prod. Prime-directive relevant: this is the most plausible path to a *wrong grade* from crafted input, though it requires search-result poisoning (high bar).
- Evidence: `services/grading.js:3398 const evidenceForModel = searchSnippets.slice(0, 1500);` fed to both the prompt (:3416) and `applyGate3` (:3504); CODEMAP env table marks Gate 4 shadow.
- Proposed fix: Prioritize the Gate 4 enforce flip (blocked on the MAX_DEFER/SWEEP collision per BACKLOG); consider constraining grader search to whitelisted result domains (ESPN/league sites) so free-text web pages can't become quote-bindable evidence. (Effort M)
- Backlog: `gate4-off-date-reject` (docs/BACKLOG.md)

### T5-05 [P3] [confidence: high] Missing fetch timeouts on legacy outbound calls (hang risk)
- Where: services/ai.js:344, services/ocr.js:24, services/grading.js:1538, services/odds.js:49/57
- What / Why it matters: These `fetch()` calls pass no `AbortSignal`/timeout, so a slow or hostile endpoint (reachable via the T5-01 SSRF, or a stalled OCR.space/Odds API) can hang the request indefinitely, tying up the event loop / grader worker. Adapters that were written later do this right (`AbortSignal.timeout(...)` in espn.js:132, sportsdata/*.js, twitter.js:64, localOcr, ocrFirstWiring). The legacy image/score fetchers were never retrofitted.
- Evidence: `services/ai.js:344 const res = await fetch(imageUrl);` (bare); vs `services/espn.js:131 const res = await fetch(url, { signal: AbortSignal.timeout(10000), ... })`.
- Proposed fix: Add `AbortSignal.timeout(N)` to each bare fetch (image ~15s, odds/score ~10s). (Effort S)
- Backlog: NEW

### T5-06 [P3] [confidence: high] String-interpolated SQL in healthReport time-window and table-count loops
- Where: services/healthReport.js:38 (`since = datetime('now', '-${hours} hours')`), used at :39/:43/:53/:76-79/:110/:183; :128 (`FROM ${t}` in a table loop)
- What / Why it matters: These build SQL by string interpolation rather than binding. Currently NOT injectable — `hours` is a fixed integer from cron/commands (bot.js:680/684/688 pass 1/24/168; commands/health.js passes 24/1) and `t` iterates a hardcoded table list (:124) — but it's an interpolation pattern one careless caller away from injection, and it diverges from the parameterized discipline everywhere else. (I verified all user-facing routes are fully parameterized: routes/admin.js `/bets` filters bind via `params.push` :298-307, `/drops` binds `since`/`reason`/`limit` :462-479, `reason` is also format-validated `^[A-Z0-9_]+$` :456; the only other `${}`-in-SQL sites are the whitelisted `getLeaderboard` sort col :833 and the `PURGEABLE_TABLES`-guarded `purgeTable` :914.)
- Evidence: `services/healthReport.js:38 const since = \`datetime('now', '-${hours} hours')\`;` then `db.prepare(\`... created_at > ${since} ...\`)`.
- Proposed fix: Bind the window as a param (`created_at > datetime('now', ?)` with `` `-${hours} hours` `` argument, matching dedupLeakCheck.js:60's already-correct pattern) and keep the table loop as a hardcoded constant array. (Effort S)
- Backlog: NEW

### T5-07 [P3] [confidence: med] `/mobile-ingest` has no per-request tweet-count cap and fire-and-forgets processing
- Where: routes/api.js:43-60
- What / Why it matters: After the secret check the route 200s immediately (:50) then `await handleTwitterWebhookPayload` async. `tweets` is only checked for `Array.isArray` — no length cap — so within the 100kb body an authenticated caller can queue a large batch, each element driving OCR/vision/DB work (and, via T5-01, an outbound image fetch). Combined with T5-02 (no rate limit), this is a cost/DoS amplifier. Lower severity because it requires the scraper secret.
- Evidence: `routes/api.js:43 if (!handle || !tweets || !Array.isArray(tweets))` — no `.length` bound; `:55 await handleTwitterWebhookPayload({ handle, tweets, displayName }, client);`
- Proposed fix: Reject `tweets.length > N` (e.g. 50) with 400; pair with the T5-02 limiter. (Effort S)
- Backlog: NEW

## Looked good
- `adminAuth` fail-closed Bearer with `crypto.timingSafeEqual` + length guard, and it never logs the presented token (adminAuth.js:22-53). Auth-fail logs print method/path only.
- All user-facing/admin HTTP routes use parameterized queries; the three `${}`-in-SQL sites reachable from HTTP are either whitelisted (`getLeaderboard` sort col against `['total_profit_units','roi_pct','win_pct','total_bets']`, database.js:822) or bound (`/drops`, `/bets`). `/drops` `reason` is additionally format-validated then bound (admin.js:456-463).
- `GRADER_ELIGIBLE_WHERE` (grading.js:25) is a **hardcoded literal** with no interpolation; the review-status gate in `gradeBet` binds the status list as `?` placeholders (database.js:648/660-664). No injection surface.
- OCR-first image fetch is properly SSRF-hardened: `https:`-only + Discord CDN host allow-list, content-length pre-check, and a streaming byte ceiling that aborts mid-download (ocrFirstWiring.js:245-285).
- linkReader Phase B/Q2 network fetch is confirmed **shelved** — `services/linkReader.js` contains no `fetch`/`axios`/`http` call, only URL parsing/allow-list detection (#141 shelve holds). No SSRF from share-link handling today.
- Secret-logging hygiene: no auth headers or token values are logged. The one env-value log (`ai.js:841 url=${url}`) prints `OLLAMA_URL` (a host), not the `x-ollama-secret` header; the secret rides the header, not the URL. API keys go in headers (`X-API-Key`, Bearer) except the Odds API, whose key is in the querystring but is never logged (only `res.status` is, odds.js:56).
- Read router is genuinely read-only (SELECT-only, catch-all 404 for any non-GET); write router mounted before it so its 404 can't shadow the POSTs (bot.js:22 before :28). CORS deliberately absent (admin.js:24-26).

## UNVERIFIED / open questions
- Whether `ADMIN_API_SECRET` / `MOBILE_SCRAPER_SECRET` are actually set in the running v756–v758 image is not checkable read-only (would require `fly secrets`/`printenv`, out of scope). If `ADMIN_API_SECRET` is unset the admin router fail-closes (safe); if `MOBILE_SCRAPER_SECRET` is unset, `/mobile-ingest` and `/scraper-handles` 401 everything (also safe) — both fail closed by construction.
- T5-04 severity assumes an attacker can influence web-search results for a specific game/date. I did not attempt to demonstrate a poisoning path; rated med on the mitigations (Gate 3 substring bind + GUARD5), with the caveat that Gate 4 is shadow in prod per CODEMAP.
- Twitter `media_url_https` trust boundary (T5-01): whether twitterapi.io ever returns attacker-controlled hosts for a tracked handle's media was not empirically tested; the code-level absence of a host check is the verified fact.
