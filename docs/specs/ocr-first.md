# Spec: OCR-first slip extraction (`services/localOcr.js` + `services/ocrFirst.js`)

**Status:** isolation-only modules built (this spec). NOT wired into the ingest path —
wiring is a separate prompt. No deploy, no merge.

This is the scoped spec for the OCR-first work. It is **separate from `PR_SPEC.md`** and does
not modify the in-flight slip-ingest path.

---

## 1. Goal

Today every betting-slip image goes straight to Gemini Vision (`services/ai.js` →
`parseBetSlipImage`, with a Gemma→Cerebras fallback). Vision is slow, rate-limited, and
occasionally hallucinates legs. We now run a **RapidOCR microservice on the Surface Pro**
([`zonetracker-ocr`](../../../zonetracker-ocr/CONTRACT.md)) that returns clean, ordered text
from Hard Rock Bet slips in ~3s.

The OCR-first path:

1. send the image bytes to the OCR service → raw text,
2. parse that text into a structured bet with **Groq** (cheap, fast text LLM),
3. **validate** the parse hard enough that we only trust it when it is unambiguously correct,
4. otherwise **fall back to the existing Gemini path** (never a silent drop).

The win: most slips never touch Vision. The safety property: a wrong OCR parse must
*degrade to Gemini*, not produce a bad bet.

Two modules, both **new files**, both **pure / network-isolated** so they can be unit-tested
without live calls and wired in later without touching `ai.js`:

- `services/localOcr.js` — typed HTTP client for the OCR service + circuit breaker.
- `services/ocrFirst.js` — orchestration: OCR → SGP gate → Groq parse → validate → **decision
  object**.

---

## 2. `services/localOcr.js` — OCR service client

Mirrors `zonetracker-ocr/CONTRACT.md` exactly. **Never throws** — every outcome is a typed
result.

### `callOcrService(imageBase64, mediaType, requestId) → Promise<result>`

`POST {OCR_SERVICE_URL}/ocr` with `Authorization: Bearer {OCR_SERVICE_TOKEN}`, JSON body
`{ imageBase64, mediaType, requestId, source: "ocrFirst" }`, aborted at `OCR_TIMEOUT_MS`.

```js
// success
{ ok: true, text, lines, confidence, latencyMs, imageHash, width, height }
// failure
{ ok: false, error: { code, message } }
```

`code` is one of the **closed client enum**:

| code           | when                                                                   | trips breaker |
|----------------|------------------------------------------------------------------------|:-------------:|
| `TIMEOUT`      | `AbortController` fired at `OCR_TIMEOUT_MS` (or `ETIMEDOUT`/`TimeoutError`) | ✅ |
| `UNREACHABLE`  | fetch threw (DNS/connect/reset), or `OCR_SERVICE_URL` unset             | ✅ |
| `HTTP_5XX`     | response status ≥ 500 (incl. `503 model-not-loaded`)                    | ✅ |
| `HTTP_4XX`     | response status 400–499 (incl. `401` auth, `413` too-large)             | — |
| `BAD_RESPONSE` | 200 but body unparseable / missing `ok` / **`ok:false`** decode failure | — |
| `CIRCUIT_OPEN` | breaker open — returned **with no network attempt**                     | — |

**Note on `200 / ok:false`** — the contract returns HTTP 200 with `ok:false` for a
*decode/OCR* failure ("service is up but couldn't read this image", server `error.code` =
`IMAGE_DECODE_ERROR` etc.). That is a healthy service, so it is mapped to `BAD_RESPONSE`
(the only enum member that means "got a response but it isn't usable OCR text") and does
**not** trip the breaker. The server's code is preserved in `error.message`.

### Circuit breaker (module-local)

- State `{ consecutiveFails, openUntil }` lives in the module (not exported except for the
  test hook).
- A **breaker-tripping** failure (`TIMEOUT` / `UNREACHABLE` / `HTTP_5XX`) increments
  `consecutiveFails`. At `OCR_CIRCUIT_BREAKER_FAILS` consecutive trips the breaker **opens**
  for `OCR_CIRCUIT_BREAKER_COOLDOWN_MS`.
- While open, `callOcrService` returns `CIRCUIT_OPEN` **immediately, no fetch**.
- After the cooldown elapses the breaker half-opens (counter reset) and the next call hits
  the network again.
- Any success (`ok:true`) resets the breaker. Non-tripping failures (`HTTP_4XX`,
  `BAD_RESPONSE`) leave the counter unchanged (they are not "service down" signals).
- `checkHealth(requestId)` does `GET {OCR_SERVICE_URL}/healthz`; a **200 closes the breaker**
  (per contract, the service returns 200 only when the model is actually loaded).
- `_resetCircuitBreaker()` is exported **for tests only**.

---

## 3. `services/ocrFirst.js` — orchestration → decision object

### `extractViaOcr(imageBase64, mediaType, requestId, deps?) → Promise<decision>`

**ALWAYS returns a decision object — NEVER `null`, NEVER throws.** `deps` is an optional
injection point (`{ callOcrService, callGroqParse }`) used by unit tests to mock the network;
production callers omit it.

```js
{
  action: "USE_OCR" | "FALLBACK_GEMINI",
  reason: <reason code>,                 // see §5
  parsedBet: {…} | null,                 // set only on USE_OCR
  ocrText: string,                       // "" when OCR failed
  validationErrors: [ <validation code> ],  // non-empty only on OCR_VALIDATE_FAIL
  evidence: { sgpToken|null, headerLegCount|null, parsedLegCount|null, ocrChars },
  timingsMs: { ocr, parse, validate, total },
  imageHash: string|null
}
```

### Flow

1. **OCR.** `callOcrService`. `!ok` → `FALLBACK_GEMINI`, `reason = "OCR_" + error.code`
   (e.g. `OCR_TIMEOUT`, `OCR_CIRCUIT_OPEN`, `OCR_BAD_RESPONSE`). On success: capture
   `ocrText`, `imageHash`, `evidence.ocrChars`.
   - empty/whitespace text → `OCR_EMPTY`.
   - clearly non-slip text (`< 20` chars **and** no digit) → `OCR_GARBAGE`.
2. **SGP gate (BEFORE Groq).** If `ocrText` matches
   `/\b(?:SGP|SGPMAX|SAME\s+GAME(?:\s+PARLAY)?)\b/i` → `FALLBACK_GEMINI`, `reason =
   OCR_SGP_GATE`, `evidence.sgpToken = matched token`. Same-game parlays have game-level
   odds and shared-matchup legs that the flat OCR→Groq path mis-attributes; Gemini Vision
   handles them, so we never even spend a Groq call.
3. **Groq parse.** `chat/completions`, `model = OCR_PARSE_MODEL || GROQ_MODEL ||
   "llama-3.3-70b-versatile"`, `temperature = OCR_PARSE_TEMPERATURE` (default `0`),
   `response_format: { type: "json_object" }`. System prompt + schema are reused verbatim
   from `prompts/groq-parse-test.md` (the proven go/no-go test). Invalid JSON → **retry
   once** → still invalid (or HTTP/network failure) → `FALLBACK_GEMINI`, `reason =
   OCR_PARSE_FAIL`.
4. **Validate (two-tier, §4).** Hard failure → `FALLBACK_GEMINI`, `reason =
   OCR_VALIDATE_FAIL`, `validationErrors = [sub-codes]`. Pass → `USE_OCR`, `reason =
   OCR_PARSE_OK`, `parsedBet = the Groq parse`.

---

## 4. Two-tier validation

Parsed bet shape (Groq schema from `prompts/groq-parse-test.md`):
`{ book, bet_type, total_odds, stake, payout, legs:[{ matchup, player, market, selection,
odds, start_time }] }`.

### HARD — failing any of these → `OCR_VALIDATE_FAIL` (degrade to Gemini)

| check | sub-code |
|-------|----------|
| `bet_type` present | `MISSING_BET_TYPE` |
| every leg has a non-empty `selection` (and ≥1 leg) | `MISSING_SELECTION` |
| every leg has ≥1 of `player` / `team` / `matchup` | `MISSING_ENTITY` |
| combined odds **or** payout present (`total_odds` ‖ `payout`) | `MISSING_COMBINED_ODDS` |
| no OCR-artifact residue in critical fields | `ARTIFACT_RESIDUE` |
| if a **confident** N-Bet header exists, `parsedLegCount === headerLegCount` | `LEG_COUNT_MISMATCH` |

- **Artifact residue** scans the critical string fields (`selection`, `player`, `matchup`,
  `market`, `odds`, top-level `total_odds`) for un-cleaned OCR garbage that a correct parse
  would have fixed: a stray leading capital-O glued to a digit (`O0ver0.5`, `/\bO\d/`,
  `/O0/`) or a middot `·` (U+00B7) where a `+` or digit belongs. Their presence means Groq
  passed the artifact through instead of correcting it → don't trust the parse.
- **N-Bet header** is parsed from the OCR text via `/(\d{1,2})\s*-?\s*bet\b/i` (matches
  `3-Bet Parlay`, `5-BetParlay`, `4-Bet Parlay`). It is **advisory**: only treated as
  "confident" when it yields a clean integer in `[1, 30]`. If the header is **absent or
  itself OCR-corrupted**, the leg-count check is skipped — we do **not** block on it.

### NICE-TO-HAVE — absence does NOT fail (and is never fabricated)

`stake`, per-leg `odds`, full `matchup`. Missing values stay missing; we never invent them.

---

## 5. Reason-code taxonomy (`decision.reason`)

| reason | action | meaning |
|--------|:------:|---------|
| `OCR_PARSE_OK` | `USE_OCR` | validated parse — trust it |
| `OCR_TIMEOUT` | FALLBACK | OCR service aborted at `OCR_TIMEOUT_MS` |
| `OCR_UNREACHABLE` | FALLBACK | OCR service unreachable / URL unset |
| `OCR_HTTP_4XX` | FALLBACK | OCR service 4xx (auth, too-large, …) |
| `OCR_HTTP_5XX` | FALLBACK | OCR service 5xx (incl. model-not-loaded) |
| `OCR_BAD_RESPONSE` | FALLBACK | malformed body, or 200/`ok:false` decode failure |
| `OCR_CIRCUIT_OPEN` | FALLBACK | breaker open — no call attempted |
| `OCR_EMPTY` | FALLBACK | OCR returned no text |
| `OCR_GARBAGE` | FALLBACK | OCR text too short and digit-free to be a slip |
| `OCR_SGP_GATE` | FALLBACK | same-game parlay — route to Vision (before Groq) |
| `OCR_PARSE_FAIL` | FALLBACK | Groq returned invalid JSON after one retry, or failed |
| `OCR_VALIDATE_FAIL` | FALLBACK | hard-validation failed (see `validationErrors`) |

`validationErrors` ⊆ `{ MISSING_BET_TYPE, MISSING_SELECTION, MISSING_ENTITY,
MISSING_COMBINED_ODDS, ARTIFACT_RESIDUE, LEG_COUNT_MISMATCH }` (only on `OCR_VALIDATE_FAIL`).

---

## 6. Shadow-vs-cutover flag behavior (wiring contract)

These modules are pure decision-makers; they read no rollout flag themselves. The **wiring
prompt** will gate the ingest path on a single mode flag (proposed `OCR_FIRST_MODE`, owned by
that prompt, **not** added to `.env.example` here):

- **`off`** (default) — ingest never calls `extractViaOcr`; behavior identical to today.
- **`shadow`** — ingest calls `extractViaOcr`, **logs** the decision (action, reason,
  timings, evidence, and a comparison against whatever Gemini produced) but **always uses the
  existing Gemini result**. Pure observation: measure `USE_OCR` rate, reason histogram, and
  agreement vs Vision with zero risk to live grading.
- **`cutover`** — on `action === "USE_OCR"`, ingest uses `parsedBet` and **skips** Gemini;
  on `FALLBACK_GEMINI`, ingest falls through to the existing Vision path. Either way a slip
  is never dropped — `FALLBACK_GEMINI` is a route, not a rejection.

Recommended rollout: `off → shadow` (validate the `USE_OCR` rate and that fallbacks are
benign) → `cutover`.

---

## 7. Environment variables

Read by these modules (appended to `.env.example`, documented, no values):

| var | default | used by |
|-----|---------|---------|
| `OCR_SERVICE_URL` | — | `localOcr` — base URL of the Surface Pro OCR service |
| `OCR_SERVICE_TOKEN` | — | `localOcr` — bearer token for `/ocr` |
| `OCR_TIMEOUT_MS` | `8000` | `localOcr` — per-request abort deadline |
| `OCR_PARSE_MODEL` | `llama-3.3-70b-versatile` | `ocrFirst` — Groq parse model |
| `OCR_PARSE_TEMPERATURE` | `0` | `ocrFirst` — Groq temperature |
| `OCR_CIRCUIT_BREAKER_FAILS` | `3` | `localOcr` — consecutive trips to open |
| `OCR_CIRCUIT_BREAKER_COOLDOWN_MS` | `60000` | `localOcr` — open duration |

Prerequisites (pre-existing secrets, not added here): `GROQ_API_KEY` (Groq parse). If
`OCR_PARSE_MODEL` is unset the code also honors `GROQ_MODEL` before the literal default.

`OCR_TIMEOUT_MS=8000` matches the measured ~3s OCR latency with headroom (see the
`zonetracker-ocr` service notes).

---

## 8. Wiring (`services/ocrFirstWiring.js`) — shadow/cutover into the slip path

The isolation modules (§2–§5) are now gated into the slip-ingest path behind the
tri-state `OCR_FIRST_MODE` flag by `services/ocrFirstWiring.js`. Status: **shadow-ready,
cutover dormant. No deploy, no merge.** (Updates the §6 contract with the as-built seam.)

### Seams (two — both slip-image entry points share ONE tested dispatch)

`extractViaOcr` needs `base64 + mediaType`; the slip seams carry a Discord CDN **URL**,
so the wiring fetches the bytes itself (in the background in shadow; inside the timeout
budget in cutover). The flag is read **at module load**. The seam guards on
`MODE !== 'off'` so off-mode makes **zero** calls and is byte-for-byte unchanged.

| seam | file | reached by | role |
|------|------|-----------|------|
| `processAggregatedMessage` (after `PARSED`) | `handlers/messageHandler.js` | main buffer path — **pure-slip capper channels (DatDude, Smokke, …) flow here** | **primary** shadow-data source |
| `processSlipImage` (after the vision parse) | `handlers/messageHandler.js` | `/slip` command + `SLIP_FEED_CHANNEL_ID` | secondary |

> **Deviation from the prompt's singular "seam":** the prompt named `processSlipImage`,
> but production slip traffic flows through `processAggregatedMessage` (verified:
> `handleMessage` → `bufferMessage` → `processAggregatedMessage`; `processSlipImage`
> only serves `/slip` + the dedicated slip-feed channel). Both are wired through the
> shared `applyOcrFirst` dispatch so shadow actually observes live parlays (the §8.1
> bar) while still honoring the named function.

### Mode behavior (as built)

- **off** — `applyOcrFirst` is never called (seam guard). Zero OCR/network/Groq calls.
- **shadow** — `runShadow` is **fire-and-forget**: `extractViaOcr` is kicked off WITHOUT
  `await` on the request path, so the ~4s OCR floor adds **zero** latency and the bet
  stages exactly as today. The staged bet is **never** modified. On resolve it emits one
  `ocr_shadow_decision` event comparing OCR to the live vision parse. ALL errors are
  swallowed.
- **cutover (dormant)** — `runCutover` awaits `extractViaOcr` within `OCR_TIMEOUT_MS`. It
  replaces `parsed` with the converted OCR bet (`ocrBetToInternalBets`, emits `ocr_used`)
  **only when all §8.2 eligibility guards pass** (new bet + single-image + supported sport).
  `FALLBACK_GEMINI` / timeout / throw / any failed guard → returns null, live path runs
  unchanged (emits `ocr_fallback` with the specific reason). A thrown or null-y ocrFirst can
  never break the live path in any mode.

### 8.1 Shadow acceptance criteria (bar to clear before flipping shadow → cutover)

- **≥ ~50–100 live STANDARD (non-SGP) parlays** observed in shadow.
- **0 critical mismatches** — a `USE_OCR` whose `parsedBet` disagrees with a *correct*
  live Gemini parse (wrong/missing leg, wrong selection, wrong combined odds).
- **≥ 90 % valid-parse (`USE_OCR`) rate** on standard (non-SGP) parlays.
- **shadow OCR path p95 < 5s** — non-blocking; never affects ingest either way.
- **every fallback route exercised at least once:** `OCR_TIMEOUT`, `OCR_UNREACHABLE`,
  `OCR_CIRCUIT_OPEN`, `OCR_SGP_GATE`, `OCR_PARSE_FAIL`, `OCR_VALIDATE_FAIL`.

Observe via `pipeline_events` where `stage='OCR_FIRST'` and
`event_type='ocr_shadow_decision'`: `action`/`reason` histogram, `agreement` rate,
`ocrLegCount` vs `liveLegCount`, and `ocrMs` for the p95.

### 8.2 Cutover eligibility guards (in code; from Codex review of PR #33)

Cutover (`runCutover`) replaces the staged bet **ONLY when ALL three hold**: the live
parse is a **new bet**, it is **single-image**, and the OCR parse resolves a **supported
sport**. Every other case emits `ocr_fallback` with a distinct reason and stays on the
live path. Guards run cheapest-first so the OCR call is skipped when we already know we'll
fall back. (All dormant — `OCR_FIRST_MODE=off` — but enforced + tested.)

| guard | skip reason | rationale |
|-------|-------------|-----------|
| live parse is `result` / `untracked_win` / `ticket_status` winner\|loser | `OCR_CUTOVER_SKIP_NONBET` | never restage a settled recap as a new bet (Fix 2) |
| `imageCount > 1` | `OCR_CUTOVER_SKIP_MULTI_IMAGE` | OCR sees only `image[0]`; don't clobber the merged multi-image parse (Fix 3) |

> **`imageCount` counts REAL slip attachments, not share-embed thumbnails.** HRB
> shares post as 1 attachment + 1 Discord share-embed thumbnail; counting the
> embed inflated `imageCount` to 2, so cutover skipped the slip and shadow forced
> `scope=image[0]_of_multi` + `agreement=false` (signal unreadable). The seam now
> derives `imageCount` from `ocrFirstWiring.eligibleImageCount(combinedImages)`,
> which counts only images tagged `origin:'attachment'` by `getImageAttachments`
> (direct uploads + forwarded snapshot attachments) and excludes embed thumbnails
> (`origin:'embed'`). A genuine 2-attachment post still counts as 2; the slip+embed
> artifact collapses to 1. Fail-safe: with no real attachment tagged it falls back
> to the total image count, so a real multi-image slip is never wrongly collapsed.
| OCR-derived sport ∉ {MLB,NBA,NFL,NHL,SOCCER,TENNIS,GOLF,MMA} | `OCR_CUTOVER_SKIP_SPORT` | no Unknown-sport replacements (Fix 4) |

**Image-fetch hardening (Fix 1, holds in shadow AND cutover).** `fetchImageBytes` never
fetches an arbitrary host: **HTTPS + Discord-CDN allowlist** (`cdn.discordapp.com`,
`media.discordapp.net`) — a disallowed/non-https URL returns `OCR_IMAGE_HOST_BLOCKED` with
no network call. An `AbortController` actually **aborts** the underlying fetch at the
deadline (shadow: `OCR_SHADOW_TIMEOUT_MS` → `OCR_IMAGE_TIMEOUT`; cutover: remaining
`OCR_TIMEOUT_MS` budget). Bytes are capped at `OCR_IMAGE_MAX_BYTES` (default 10MB) via a
content-length pre-check **and** a streaming ceiling that aborts mid-download
(`OCR_IMAGE_TOO_LARGE`) — never buffered unbounded.

**Sport inference (Fix 4 first pass).** `ocrBetToInternalBets` infers sport lazily from the
leg text via `ai.js inferLegSport` (the same map used live); it stays `'Unknown'` when
nothing resolves, and the guard above then falls back. Full OCR-side sport inference (e.g.
when only player names are present) is a later enhancement.

**Remaining gap (not yet addressed; shadow must confirm before flip):** `validateParsedBet`
runs against the Discord message text, not the OCR text — OCR slips rely on its
`hasMedia:true` slip-exemption. Shadow must confirm OCR bets survive that validator before
cutover.
