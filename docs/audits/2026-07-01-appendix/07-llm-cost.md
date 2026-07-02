# T7 — LLM usage and cost — 2026-07-01 audit appendix

Verified at worktree HEAD `19ff594` (`/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`). Volume numbers cite the probe pack (grading_audit 30d provider histogram, drops 14d, created-bets 3d, live flag echo). Prior-audit anchors: docs/audits/2026-06-10-coa-full-audit.md M-2 (grader parse-abort, owned by T4) and its Track-3 max_tokens read.

## 1. Call-site inventory (every network LLM call at HEAD)

| # | Site | file:line | Provider chain + model | Model env var | max_tokens | temp | response_format | timeout |
|---|------|-----------|------------------------|---------------|-----------|------|-----------------|---------|
| 1 | Intake waterfall core `callLLMResult` (shared by 2–5) | services/ai.js:241 (dispatch), :99 `callOpenAI`, :169 `callGemini` | PROVIDERS object order (ai.js:18–65): gemini → groq → openrouter → cerebras → mistral → ollama; image-capable sorted first when image present (:253–255); text-only retry after all vision fail (:302–317) | GEMINI_MODEL (`gemini-2.0-flash`), GROQ_TEXT_MODEL (`llama-3.1-8b-instant`), GROQ_VISION_MODEL (`meta-llama/llama-4-scout-17b-16e-instruct`), OPENROUTER_TEXT_MODEL / OPENROUTER_MODEL (vision `qwen/qwen3.6-plus-preview:free`), CEREBRAS_MODEL (`gpt-oss-120b`), MISTRAL_TEXT_MODEL / MISTRAL_MODEL, OLLAMA_MODEL | 1024 (:127); Gemini `maxOutputTokens` 1024 (:178) | 0.2 (:126, :178) | `json_object` text-only calls; OMITTED on vision (:118–131); Gemini `responseMimeType: application/json` (:178) | 15s cloud / 25s ollama (:134); Gemini 15s (:183) |
| 2 | `parseBetText` — intake text+vision parse | ai.js:998, primary call :1087 | waterfall (#1); Gemma fallback gate :1127 (DEAD — see T7-05) | as #1 | as #1 | as #1 | as #1 | as #1 |
| 3 | `parseBetSlipImage` (requireImage) | ai.js:1225, call :1236 | waterfall (#1), vision-only | as #1 | as #1 | as #1 | vision → NONE | as #1 |
| 4 | `gradeBetAI` — stylistic A–F letter grade | ai.js:1319–1328 via `callLLM` | waterfall (#1) | as #1 | 1024 | 0.2 | json_object | 15s |
| 5 | `generateRecap` / `parseTwitterPick` | ai.js:1337–1340 / :1330–1335 via `callLLM` | waterfall (#1) | as #1 | 1024 | 0.2 | json_object | 15s |
| 6 | `extractPickFromTweet` — tweet bouncer | ai.js:1343–1421; call :1402–1407 | Groq SDK direct, single model, no fallback | GROQ_MODEL (`llama-3.1-8b-instant`) | **not set** (SDK default) | 0 | json_object | **none** (SDK default) |
| 7 | Gemma vision fallback `tryVisionGemma` | ai.js:801; model :815 | Ollama `/api/generate` on Surface Pro | OLLAMA_VISION_MODEL (`gemma3:4b`) | n/a (options.temperature:0 only, :830) | 0 | n/a (raw text) | 90s (:820) |
| 8 | `parseGemmaOutputWithCerebras` | ai.js:865; call :886 via `callLLM` | **full waterfall #1, Gemini first — NOT Cerebras** (see T7-06) | as #1 | 1024 | 0.2 | json_object | 15s |
| 9 | Grading waterfall (inside `gradeSingleBet`) | services/grading.js:3368–3392 (ladder), request :3444–3455 | groq-llama4-scout → cerebras-gpt-oss → groq-qwen (`qwen/qwen3-32b`) → openrouter (`llama-3.3-70b-instruct:free`) → groq-gpt-oss (`openai/gpt-oss-120b`) → mistral (`mistral-small-latest`) → ollama → groq-llama8b (`llama-3.1-8b-instant`) | **all hardcoded literals** except ollama (OLLAMA_MODEL, :3388); CEREBRAS_MODEL secret unused here (BACKLOG.md:1216) | 1000 (:3453) | 0 (:3452) | json_object (:3451) | 20s cloud / 25s ollama (:3439) |
| 10 | ocrFirst Groq parse `callGroqParse` | services/ocrFirst.js:100–140; body :105–114 | Groq direct, single model, retry ×2 on bad JSON (:117) | OCR_PARSE_MODEL → GROQ_MODEL → `llama-3.3-70b-versatile` (:103); OCR_PARSE_TEMPERATURE (:104) | 2000 (:108) | 0 | json_object (:109) | 15s (:121) |

Non-LLM look-alikes (zero AI cost, verified): `evaluateTweet` is pure regex (ai.js:1426–1541); pre-filter #137 is the `guessDisposition` heuristic (services/preFilter.js:21,51 — no network); the structured prop/adapter grading paths (`tryStructured`, ESPN/MLB adapters) are deterministic. `processSlipImage` Stage-1 OCR (`extractTextFromImage`, services/ocr.js) and localOcr (:11436 RapidOCR) are OCR services, not LLMs.

Live callers: messageHandler.js:510 + :1060/:1071 (`parseBetText`), twitter-handler.js:184 (`parseBetText` vision, fed by POST /api/webhooks/apify → routes/api.js:55 — live despite `TWITTER_POLLER_DISABLED=true`, which only gates the poller, services/twitter.js:90), twitter-handler.js:197/:204/:221 (`extractPickFromTweet`), commands/bet.js:26, commands/grade.js:283 (`gradeBetAI`, manual), commands/recap.js:29 (manual), holdReview.js:264 → processSlipImage (vision re-burn, capped at RECOVERY_RETRY_CAP=5), ocrFirstWiring seams messageHandler.js:517–522/:1105.

## 2. Token adequacy + JSON handling per site

- **Grading (site 9):** `max_tokens: 1000` confirmed at grading.js:3453 — the memory/BACKLOG "grader caps max_tokens=200" is stale (fixed post-v442; BACKLOG.md:587–605 documents the starvation postmortem). 1000 is ~12× the ~80-token contract output — adequate, including cerebras `gpt-oss-120b` reasoning overhead (probe: 58 finalizations in 30d). Parse handling: **strict** `JSON.parse` at :3489, loop breaks on first non-empty `raw` (:3470–3476), parse-fail → PENDING attempt burned — **M-2 unchanged at HEAD** (T4's finding; noted here for the cost angle: one garbage response wastes the whole attempt's search + backoff slot).
- **Intake (sites 1–5):** 1024 tokens for output that can be a 10–20-leg parlay JSON with `legs[]` + `props[]` — see T7-03. Parse: tolerant `parseJSON` (fence-strip + outermost-brace slice, ai.js:400–413); on null → recordDrop TEXT/VISION_EXTRACTION_FAILED, `{bets:[]}`. Same first-non-empty-wins shape as M-2: a provider returning HTTP-200 garbage wins the waterfall (callLLMResult returns on any non-empty content, :283–288) and no later provider is tried; the only recovery was the Gemma gate, which is disabled (T7-05).
- **ocrFirst (site 10):** best-in-repo — 2000 tokens, retry-once on invalid JSON, tolerant parse.
- **Tweet bouncer (site 6):** no max_tokens, no timeout, strict `JSON.parse` inside try → any failure returns null; twitter-handler then drops `PARSER_NO_LEGS` or fires the escape hatch (junk `Unknown` bet, twitter-handler.js ~232–240 — COA 06-10 known issue).
- Temperature: grading/ocrFirst/bouncer/Gemma all 0; intake waterfall 0.2 for a "STRICT parser" (minor).

## 3. Daily volume and free-tier headroom

- **Grading:** attempts 96–955/day, avg ~380 (probe pack); LLM completions 30d: groq-llama4-scout 7147 + cerebras 1172 + groq-qwen 81 + groq-gpt-oss 7 = 8407 ≈ **280/day**; 136 attempts/30d exited pre-provider. DAILY_CAP=10_000 attempts/24h (grading.js:1774) — never approached (peak 955).
- **Intake (estimate):** bets created ≈46/day (137/3d, probe 8b) + BOUNCER_REJECTED ≈196/day (2738/14d — each is a post-parse drop, so each burned ≥1 completion) + is_bet=false holds/drops ⇒ **~250–350 parse completions/day**. No DB telemetry exists to make this exact (T7-02).
- **Documented limits (code/docs only):** Groq free **30 RPM** (grading.js:984 comment); Gemini free **20 RPD** for the flash-lite tier per BACKLOG.md:796 ("Bot's Vision call volume regularly exceeds this within hours") — 20 RPD vs ~250+ intake calls/day means Gemini is quota-dead ~92% of each day and **Groq scout is the de-facto intake primary**, exactly as BACKLOG records. Intake self-pacing: waitSlot 2100ms groq / 4200ms others (ai.js:87–92) ≈ 28.6/14 RPM per provider **in the intake path only — the grading ladder never calls waitSlot** (429-backoff only, :3457–3461), so grading bursts contend with intake on the same GROQ_API_KEY. Cerebras absorbing 14% of grading completions is consistent with routine Groq 429 spillover. Vendor limits for Cerebras/Mistral/OpenRouter: not documented anywhere in repo — UNVERIFIED.

### T7-01 [P2] [confidence: high] GROQ_API_KEY is the single load-bearing key for every LLM tier — intake, ocrFirst, tweet bouncer, and rungs 1/3/5/8 of grading
- Where: services/ai.js:28-29,1346,1402-1404; services/ocrFirst.js:101; services/grading.js:3369-3391
- What / Why it matters: With Gemini quota-dead most of the day (BACKLOG.md:796) and openrouter/mistral/ollama at zero observed grading completions in 30d (probe 9), Groq models carried 7235/8407 = **86%** of grading completions and (per BACKLOG) the bulk of intake vision. The tweet bouncer and ocrFirst have **no fallback at all** past Groq. One key revocation/plan change collapses intake parsing to Gemini's ~20 RPD + Cerebras text-only, and grading to cerebras alone — mass TEXT_EXTRACTION_FAILED drops and GRADE_AI pendings feeding the 7-day sweeper (DP-01's wrong-LOSS generator).
- Evidence: probe 9 histogram; grading ladder :3369/:3375/:3381/:3390 all `process.env.GROQ_API_KEY`; ocrFirst.js:101-102 returns `{ok:false}` when GROQ_API_KEY missing; extractPickFromTweet returns null on any Groq error (ai.js:1417-1420).
- Proposed fix: add a second funded tier (paid Gemini per BACKLOG:796 option 1, or wire Cerebras into ocrFirst/bouncer); alert when any single provider exceeds ~80% of completions over 7d. (Effort M)
- Backlog: BACKLOG.md:796 (Gemini quota decision, open since 2026-05) + BACKLOG.md:892-class "single points of failure"; alerting: NEW

### T7-02 [P2] [confidence: high] Intake LLM usage has zero persisted telemetry — provider/model/cost per parsed bet is unauditable
- Where: services/ai.js:286-287 (winner → console.log only); contrast grading_audit.provider_used (grading.js writes it, CODEMAP:110)
- What / Why it matters: This track could not answer "code order vs observed distribution" for intake because nothing records which provider parsed each bet — the probe pack's provider data covers grading only. Quality regressions (e.g. llama-3.1-8b as intake text provider #2 parsing real bets when Gemini is quota-dead) and cost drift are invisible; vision_failures logs failures only, and only on the (disabled) Gemma path.
- Evidence: `[AI] Winner: ${provider.name}` at ai.js:286 is console-only; no bets/pipeline_events column carries the parse provider (bets schema, CODEMAP:21-64).
- Proposed fix: add `parse_provider`/`parse_model` to the PARSED pipeline_events payload (zero schema change — payload is JSON) at the 4 parse call sites. (Effort S)
- Backlog: NEW

### T7-03 [P2] [confidence: med] Intake max_tokens 1024 can truncate long multi-leg parlay JSON → silent bet loss, with the Gemma rescue tier disabled
- Where: services/ai.js:127 (callOpenAI), :178 (Gemini `maxOutputTokens: 1024`)
- What / Why it matters: normalizeBet expects parlay descriptions up to 2000 chars (ai.js:428, shipped for leg-explosion truncation) and the prompt demands full `legs[]` + `props[]` per leg — a dense 12+ leg slip response can exceed 1024 tokens. Truncated JSON → `parseJSON` brace-slice fails (unbalanced) → null → with `GEMMA_FALLBACK_DISABLED=true` (live flag echo) the message drops as VISION/TEXT_EXTRACTION_FAILED. ocrFirst budgets 2000 tokens (ocrFirst.js:108) for strictly less content — the inconsistency is the tell. Occurrence not measurable from the probe pack (VISION_EXTRACTION_FAILED 3/14d is low but nonzero); mechanism verified.
- Evidence: file reads above; probe 5 drop histogram.
- Proposed fix: raise intake max_tokens to 2000 (matches ocrFirst; both models support it) — one-line ×2. (Effort S)
- Backlog: NEW (adjacent to BACKLOG "Leg-explosion truncation root cause", shipped 2026-05-18, which fixed the input side only)

### T7-04 [P3] [confidence: high] Grading-ladder comment describes a different chain than the code; all 8 models hardcoded; 39%-hallucination llama8b still last rung (corroborates DP-06)
- Where: services/grading.js:3366-3367 (comment) vs :3370 (code leads groq-llama4-scout, absent from the comment); :3391 (llama8b)
- What / Why it matters: The comment claims "ordered by hallucination rate (lowest first)" starting cerebras and includes "groq-kimi 7.6%" — no kimi rung exists in code. Models are string literals (CEREBRAS_MODEL secret dead at this site), so a bad-model hotfix needs a deploy. llama-3.1-8b-instant (code's own "39%" label) is 0-used in 30d but one multi-provider outage from finalizing grades — and the SAME model is the intake text default (GROQ_TEXT_MODEL, ai.js:28) and the whole tweet bouncer (site 6), where it parses live bets **daily**, guarded only by the bouncer/validator.
- Evidence: file reads above; probe 9 (llama8b 0 rows).
- Proposed fix: fix comment; env-var the ladder models (BACKLOG:1216 pattern); drop or review-gate llama8b as a grading rung. (Effort S)
- Backlog: BACKLOG.md:1216 (env-var wiring, existing); comment/llama8b: DP-06 / NEW

### T7-05 [P3] [confidence: high] Gemma fallback chain (~180 lines incl. the ignore-verdict HRB rescue and parseBetSlipImage's requireImage P0 fix) is dead in prod; parseBetSlipImage has NO production caller yet CODEMAP says it handles slip channels
- Where: services/ai.js:983 (`GEMMA_FALLBACK_DISABLED==='true'` → gate constant-false; live flag = true); ai.js:1225 (parseBetSlipImage); docs/CODEMAP.md:614
- What / Why it matters: (a) Every `shouldFallbackToGemma` trigger — placeholder, no-legs, fallback-eligible error, ignore-verdict — is off; the only vision recovery is the provider ladder itself + the v434 admin-log notice (BACKLOG:298 documents this deliberately — not drift, but the inventory must not count Gemma as a live tier). (b) `parseBetSlipImage` is referenced only by tests/comments (repo-wide grep); the real slip path is `processSlipImage → parseBetText` (messageHandler.js:510). CODEMAP:614 ("Vision extraction (parseBetSlipImage) handles the bet") misleads future work into "fixing" a function nothing calls. Also dead: `parseTwitterPick` (zero callers), the `gradeBetAI` import at grading.js:3 (never called there).
- Evidence: grep outputs above; live flag echo (probe pack).
- Proposed fix: CODEMAP correction + delete-or-mark the dead exports next docs pass. (Effort S)
- Backlog: BACKLOG:298 (Gemma disable, documented); CODEMAP drift: NEW

### T7-06 [P3] [confidence: high] `parseGemmaOutputWithCerebras` never preferentially uses Cerebras — it dispatches the full waterfall, Gemini first; `vision_failures.cerebras_response` stores whichever provider won
- Where: services/ai.js:886 (`callLLM(gemmaRaw, sys)`), :865 (name), :908-916 (column write); block comment :724 ("Cerebras → structured JSON")
- What / Why it matters: Operator-deception only (and currently dormant behind T7-05): anyone debugging a `vision_failures.cerebras_response` row or tuning "the Cerebras parse step" is reasoning about the wrong provider — the parse is Gemini/Groq/whoever won the generic chain. If Gemma is ever re-enabled (Surface Pro upgrade is a standing idea), the misdirection goes live.
- Evidence: getProviders iterates PROVIDERS object order gemini-first (ai.js:68-83, :3 comment matches code here); callLLM has no provider pinning.
- Proposed fix: rename or pin the call to cerebras; at minimum fix the comment + column name in the next migration touching vision_failures. (Effort S)
- Backlog: NEW

### T7-07 [P3] [confidence: med] OCR_FIRST shadow burns a duplicate Groq parse (2000-token, up-to-×2) per eligible slip indefinitely, with no promotion/expiry criteria in repo
- Where: services/ocrFirstWiring.js:38-42 (MODE at load; live = shadow), :434 (runShadow fire-and-forget); seams messageHandler.js:517-522, :1105
- What / Why it matters: Every single-image slip runs BOTH the live vision waterfall AND localOcr + `callGroqParse` (retry ×2) purely for a comparison event. At slip volume this is tens of extra Groq calls/day on the already-concentrated key (T7-01) — fine as a bounded measurement, but no doc in repo states the shadow's success criteria or end date, so it defaults to forever-cost.
- Evidence: file reads above; live flag echo `OCR_FIRST_MODE=shadow`.
- Proposed fix: define the cutover/rollback decision metric and date for the `ocr_shadow_decision` data; otherwise flip to off. (Effort S — ops decision)
- Backlog: docs/specs/ocr-first.md arc (existing); decision deadline: NEW

## Looked good
- Grading max_tokens=1000 + temp 0 + json_object + 20s timeout (grading.js:3448-3455) — the v441 Cerebras 200-token starvation class is structurally gone; memory note "grader caps max_tokens=200" is confirmed stale.
- Provider order vs observed distribution in GRADING matches code intent: scout(1st) 7147 ≫ cerebras(2nd) 1172 ≫ qwen(3rd) 81 ≫ gpt-oss(5th) 7 — clean fall-through ordering, no rung dominating out of position (probe 9).
- GUARD 4 "no search results = no AI call" (grading.js:3357-3363) and GRADE_TOO_RECENT gating keep LLM spend evidence-gated; DAILY_CAP 10k never approached.
- ocrFirst's parse hygiene (retry-once, tolerant JSON, SGP gate before spend) is the model the other sites should copy.
- requireImage on parseBetSlipImage correctly prevents the text-only empty-bets masking (ai.js:297-301) — even if the function is currently uncalled.
- Intake image pipeline cost controls: sharp downscale/grayscale/JPEG-80 + SHA-256 12h dedup cache (ai.js:342-398).
- evaluateTweet + preFilter + GUARD 5 all reject pre-AI — genuine zero-cost filters, confirmed non-LLM.

## UNVERIFIED / open questions
- Whether OPENROUTER_API_KEY / MISTRAL_API_KEY are set in prod (zero completions in 30d = unset OR always-failing; `provider_used` only records winners, and env inspection is out of scope). If set-but-dead, each exhausted chain burns 2 failed HTTP calls + latency; the intake OpenRouter vision default `qwen/qwen3.6-plus-preview:free` (ai.js:37) is an unverifiable model slug — a 404 would make that rung permanently dead.
- Actual current vendor rate limits (Groq 30 RPM, Gemini 20 RPD, Cerebras/Mistral/OpenRouter free tiers): only the code comment grading.js:984 and BACKLOG.md:796 exist in-repo; no external verification performed per track rules. BACKLOG:796 also names `gemini-2.5-flash-lite` while the code default is `gemini-2.0-flash` — which model GEMINI_MODEL pins in prod is unknown.
- Intake provider distribution (which provider actually parses most bets) — unmeasurable until T7-02; the "Groq is de-facto intake primary" claim rests on BACKLOG:796's dated observation, not live data.
- Whether ollama's OpenAI-compat endpoint honors `response_format: json_object` on the grading rung (grading.js:3451) — untestable without OLLAMA_URL access; rung is dormant (0 rows/30d) so no observed impact.
- extractPickFromTweet's real-world truncation rate (no max_tokens set — Groq SDK default applies, value unverified without vendor docs).
