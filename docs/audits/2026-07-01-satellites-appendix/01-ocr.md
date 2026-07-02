> Track analysis produced by a read-only audit subagent from pinned clones + probe captures;
> reviewed, spot-verified (high-severity evidence lines re-read by the orchestrator), and filed
> by the audit orchestrator. Probe references (P-n, probes/*.txt) resolve to 20-live-probes.md.

# T1 — zonetracker-ocr @e21ee2c (first-ever audit)

Box checkout CLEAN at origin/main e21ee2c (probes/checkouts.txt:19-22). Service online 3D uptime, ↺0, pm2 id 1 (probes/pm2-list.txt:7). Publicly exposed: Tailscale Funnel `:8443 → 127.0.0.1:11436` (probes/exposure.txt:30-31,48-49); app itself binds loopback only (probes/exposure.txt:11).

## Route inventory

Whole surface = one file, `app.py` (no routers). All routes verified by reading zonetracker-ocr@e21ee2c app.py.

| Route | Handler type | Auth | Input validation | Timeout | Error shape | Logging |
|---|---|---|---|---|---|---|
| `GET /healthz` (app.py:141-149) | sync `def` (threadpool) | NONE (public via Funnel) | n/a | none | 200 `{ok,modelLoaded:true}` / 503 `{ok:false,modelLoaded:false,error:<repr of load error>}` | uvicorn access line only |
| `GET /version` (app.py:152-161) | sync `def` | NONE (public — scanners got 200: tails-ocr-proxy.txt:143-144) | n/a | none | always 200; leaks service/version/engineVersion/modelVersion/startedAt | uvicorn access line only |
| `POST /ocr` (app.py:164-249) | async `def` | Bearer token, `hmac.compare_digest` (app.py:169), checked BEFORE body read; empty/unset env ⇒ always 401 (fail-closed, app.py:62,83-84,169) | order: auth → model-loaded (503) → `await request.json()` (FULL body buffered, unbounded) → b64decode (full) → THEN size guard `len(raw)>OCR_MAX_IMAGE_BYTES` 8MB → 413 (app.py:186,198,205-215) → Pillow decode → OCR | NONE server-side — inference runs to completion even if client disconnected | 401/413/503 non-200 `{ok:false,error:{code,message}}`; decode/OCR failures HTTP 200 `ok:false` (app.py:96-111); success 200 `ok:true` | app log ONLY on OCR exception (`requestId` at app.py:229); success requests get uvicorn access line only — no requestId anywhere |

Concurrency: single process (ecosystem.config.js:12 `instances:1`), single uvicorn worker (app.py:255 `workers=1`), no semaphore/queue cap, no rate limit.

## Findings

### OCR-1 — P2 — blocking CPU inference on the asyncio event loop; no server-side deadline, no concurrency control
- **Confidence:** high
- **Evidence:** `POST /ocr` is `async def` (app.py:165) but `_run_ocr` → `STATE["ocr"](arr)` is synchronous CPU-bound ONNX inference called inline (app.py:227, 125). Single worker (app.py:255), `instances:1` (ecosystem.config.js:12). No timeout anywhere in app.py. Bot deadline is 8s total incl. image fetch (localOcr.js:47; ocrFirstWiring.js:73-75,527).
- **Impact:** during each OCR (~1-3s; larger images more) the event loop is fully blocked: `/healthz` (threadpool `def`, but dispatch needs the loop) and every concurrent `/ocr` stall. ≥3 near-simultaneous slips serialize past the bot's 8s budget → bot `TIMEOUT`s (breaker-tripping, localOcr.js:35-39) → after 3 consecutive, circuit opens 60s and ALL slips route to vision. Server meanwhile keeps burning CPU on requests whose client already gave up (no cancellation on disconnect — sync code can't observe it), prolonging the pile-up. Not silent slip loss (fallback is a route), but under cutover it guarantees timeout/breaker flapping on any multi-slip burst, and the public `/healthz` becomes a false negative under load.
- **Fix:** run inference off-loop (`def` endpoint or `anyio.to_thread`/`run_in_executor`) + an explicit concurrency cap (semaphore, reject-fast 503/429 when busy) + a server-side inference deadline < bot's 8s. Effort: **M**. BACKLOG: NEW (child of BACKLOG.md:1505 "COA audit pass for zonetracker-ocr").

### OCR-2 — P2 — memory bounds enforced too late: full body buffered + base64-decoded BEFORE the size guard; pixel dimensions never checked
- **Confidence:** high (code order verified); memory-kill scenario med
- **Evidence:** `await request.json()` reads the entire body with no Content-Length cap (app.py:186 — uvicorn/Starlette impose none), `base64.b64decode` runs on the whole string (app.py:198), and only THEN `len(raw) > OCR_MAX_IMAGE_BYTES` → 413 (app.py:205). So the 8MB "cap" bounds what reaches OCR, not memory. Separately, decoded-bytes ≠ decoded-pixels: a highly-compressible PNG under 8MB can be ~100-178Mpx (Pillow's default bomb guard is NOT overridden — no `MAX_IMAGE_PIXELS` in app.py — so >~178Mpx raises, caught as `IMAGE_DECODE_ERROR`), and `np.array(img)` at 100Mpx RGB is ~300MB+ before RapidOCR intermediates, vs `max_memory_restart:'1G'` (ecosystem.config.js:14).
- **Impact:** requires a valid token (auth precedes body read), so today only the bot — which self-caps fetches at 10MB (ocrFirstWiring.js:79) — can hit it. But if `OCR_SERVICE_TOKEN` ever leaks, oversized-body or dimension-bomb floods flap the process via pm2 memory-kill (dropping in-flight requests, model-reload window each restart). Defense-in-depth gap on a public endpoint.
- **Fix:** reject on `Content-Length` > ~1.4×OCR_MAX_IMAGE_BYTES before parsing; check `img.size` pixel budget after `Image.open` before `convert("RGB")`. Effort: **S**. BACKLOG: NEW.

### OCR-3 — P3 — `/version` (and `/healthz`) unauthenticated on the public Funnel; scanners already harvested it
- **Confidence:** high
- **Evidence:** no auth on either route (app.py:141-161). Internet scanners received `GET /version → 200 OK` on 2026-06-21 17:16:49 from 164.92.107.174 and 64.227.70.2 (tails-ocr-proxy.txt:143-144). Body reveals exact stack (`rapidocr-onnx 1.4.4`, PP-OCRv4, service v0.1.0) + `startedAt` boot times (health-curls.txt:4).
- **Impact:** fingerprinting a one-owner box for CVE targeting (uvicorn/fastapi float, see OCR-8) and reboot-schedule inference. No mutating/costly surface exposed (rubric ⇒ P3, not P0).
- **Fix:** require the bearer token on `/version` (bot never calls it in prod) or strip it to `{service}`; optionally gate `/healthz` detail. Effort: **S**. BACKLOG: NEW.

### OCR-4 — P3 — size-cap mismatch: bot fetches up to 10MB but service rejects >8MB decoded — that band can never OCR
- **Confidence:** high
- **Evidence:** bot `OCR_IMAGE_MAX_BYTES` default 10MB (ocrFirstWiring.js:79; .env.example:33) vs service `OCR_MAX_IMAGE_BYTES` default 8,000,000 (app.py:63; .env.example line 8 of ocr repo). 8-10MB image → service 413 (app.py:205) → bot `HTTP_4XX` (localOcr.js:136-139) → `FALLBACK_GEMINI`.
- **Impact:** no slip loss (falls back to vision) but a structurally-dead band: wasted fetch+upload of ~13MB base64 per occurrence, and shadow metrics book it as `OCR_HTTP_4XX`, polluting the cutover go/no-go signal.
- **Fix:** align caps (bot-side pre-check `base64 length ≤ 8MB·4/3` or raise service cap to 10MB). Effort: **S**. BACKLOG: NEW.

### OCR-5 — P3 — bot-side `checkHealth` has no production caller: the documented "healthz-200 closes the breaker" mechanism is inert
- **Confidence:** high
- **Evidence:** `grep -rn checkHealth` across worktree JS: only definition/export localOcr.js:184,222. Header claims "a GET /healthz 200 closes it" (localOcr.js:17).
- **Impact:** breaker recovery relies solely on the 60s cooldown half-open (localOcr.js:64-71) — works, but the advertised faster-recovery path never runs; dead code misleads future readers.
- **Fix:** delete the claim or wire a periodic health probe. Effort: **S**. BACKLOG: NEW (doc-drift class).

### OCR-6 — P3 — CONTRACT.md promises `requestId` is "echoed into server logs for tracing"; it is logged only on OCR exceptions
- **Confidence:** high
- **Evidence:** CONTRACT.md:44 vs app.py — the only `request_id` use is `LOG.exception("OCR failed for requestId=%s", ...)` (app.py:229). Successful/failed-decode requests emit no app-level line; uvicorn access log has IP/path/status only (verified across tails-ocr-proxy.txt).
- **Impact:** cannot correlate a bot-side shadow/cutover decision with a server-side request (latency, imageHash) — exactly the tracing needed to debug cutover disagreements. Code-contradicts-docs ⇒ doc-drift finding per shared rules.
- **Fix:** one INFO line per /ocr with requestId, latencyMs, imageHash, ok/error.code. Effort: **S**. BACKLOG: NEW.

### OCR-7 — P3 — log rotation absent + pm_id/log-suffix drift (docs say pm_id 3; pm2 says id 1; logs go to `out-3.log`)
- **Confidence:** high
- **Evidence:** no pm2-logrotate (`~/.pm2/modules` EMPTY, logs-disk.txt:11-14). ecosystem.config.js:15-16 names `./logs/out.log`/`error.log` but the live files are `logs/out-3.log`/`error-3.log` (pm2 pm_id suffixing, no `merge_logs`), growing since 2026-06-11 with scanner noise (tails-ocr-proxy.txt:5-6). Current pm2 id is 1 (pm2-list.txt:7) yet writes land in `-3` files — the probe's own guess at `out-1.log` hit "No such file" (tails-ocr-proxy.txt:1-4). docs/SURFACE-PRO.md:28 & :140 still say "pm_id 3".
- **Impact:** unbounded (slow) log growth; operators/tools tailing the wrong file conclude "no logs"; SURFACE-PRO.md drift.
- **Fix:** `merge_logs:true` (or accept suffix + fix docs), install pm2-logrotate box-wide, correct SURFACE-PRO.md pm_id. Effort: **S**. BACKLOG: NEW (rotation overlaps host-track hygiene).

### OCR-8 — P3 — dependency reproducibility: only rapidocr is pinned; fastapi/uvicorn/pillow/numpy float and onnxruntime is an unpinned transitive
- **Confidence:** high (pins verified; breakage scenario med)
- **Evidence:** requirements.txt:4-9 (`fastapi>=0.110,<1`, `uvicorn[standard]>=0.29,<1`, `numpy>=1.26,<3`, `pillow>=10,<12`; `rapidocr-onnxruntime==1.4.4` only pin; onnxruntime not listed at all). No lockfile. README deploy = plain `pip install -r` (README.md:57).
- **Impact:** a fresh host rebuild (the disaster-recovery path README documents) installs a different fastapi/uvicorn/numpy/onnxruntime combo than the validated one — the smoke-test guarantee ("variant A was clean") silently doesn't transfer.
- **Fix:** commit a `pip freeze` lockfile from the live venv. Effort: **S**. BACKLOG: NEW.

### OCR-9 — P3 — shadow OCR traffic ceased after 2026-06-28 14:33 (4-day silence at capture) — cause UNVERIFIED
- **Confidence:** low
- **Evidence:** access log shows 97 `POST /ocr` (all 200 OK, all from 64.34.84.154 = Fly egress) between Jun 11 and Jun 28 14:33:28 (tails-ocr-proxy.txt:196); nothing after except the Jul 2 localhost probe curls (tails-ocr-proxy.txt:204-205). Prior gaps existed (Jun 15→18, Jun 25→28), so low volume is plausible — but this is the longest observed gap and spans active MLB days.
- **Impact:** if `OCR_FIRST_MODE` regressed to `off` on a recent Fly deploy (env not probeable from these materials), the shadow-agreement dataset gating cutover has silently stopped accruing. Shadow never feeds the bot, so no ingest impact either way.
- **Fix:** check `fly ssh ... printenv OCR_FIRST_MODE` and `pipeline_events.ocr_shadow_decision` recency (the "verify prod env via printenv not code default" lesson). Effort: **S**. BACKLOG: NEW (verification task).

### OCR-10 — P3 — cutover as wired does NOT skip Gemini: vision parse always runs first at both seams; module header claims otherwise
- **Confidence:** high
- **Evidence:** both seams call `parseBetText` (vision) and only then `applyOcrFirst` (handlers/messageHandler.js:511→518 and :1095→1105); `runCutover` needs `liveParsed` for the non-new-bet guard (ocrFirstWiring.js:510). ocrFirst.js:5-6 says the ingest path "uses USE_OCR to skip Gemini".
- **Impact:** cutover changes *which* parse is staged but spends vision + OCR + Groq on every slip — if the flip's goal includes Gemini cost/quota relief, the current wiring doesn't deliver it. Doc-drift meanwhile.
- **Fix:** either re-order (OCR before vision, vision only on fallback — requires redesigning the Fix-2 non-new-bet guard) or correct the header/spec to "quality swap, not cost swap". Effort: **M** (re-order) / **S** (doc). BACKLOG: NEW.

## Contract table (bot ⇄ ocr)

Request fields:

| field | bot sends (localOcr.js) | server reads (app.py) | match |
|---|---|---|---|
| `imageBase64` | :124 | :191 required string | ✅ |
| `mediaType` | :125 | never read (informational per CONTRACT.md:43) | ✅ (documented) |
| `requestId` | :126 | :192, logged only on OCR exception :229 | ⚠️ OCR-6 |
| `source: 'ocrFirst'` | :127 | never read | ✅ (informational) |

Response fields (200 ok:true): server app.py:237-249 `text/lines/confidence/engine/version/latencyMs/imageHash/width/height/error:null` ⇄ bot consumes `ok,text,lines,confidence,latencyMs,imageHash,width,height` (localOcr.js:147-170; requires `typeof text==='string'` :156) — ✅ full parity, extra fields ignored safely.

Status codes / failure routing:

| server behavior | server file:line | bot classification | bot file:line | breaker | end state |
|---|---|---|---|---|---|
| 401 bad/missing token (or unset env) | app.py:169-174 | `HTTP_4XX` | localOcr.js:136-139 | no trip | FALLBACK_GEMINI (vision) |
| 413 decoded >8MB | app.py:205-215 | `HTTP_4XX` | localOcr.js:136-139 | no trip | FALLBACK_GEMINI — permanent for 8-10MB band (OCR-4) |
| 503 model not loaded | app.py:176-180 | `HTTP_5XX` | localOcr.js:132-134 | trips | FALLBACK_GEMINI; breaker after 3 |
| 200 `ok:false` (BAD_JSON/MISSING_IMAGE/BASE64_DECODE_ERROR/EMPTY_IMAGE/IMAGE_DECODE_ERROR/OCR_ERROR) | app.py:96-111,186-233 | `BAD_RESPONSE` (server code preserved in message) | localOcr.js:150-155 | no trip | FALLBACK_GEMINI |
| 200 `ok:true`, empty text | app.py:237 (text "") | ok → ocrFirst `OCR_EMPTY` | ocrFirst.js:249 | success | FALLBACK_GEMINI |
| network error / abort | n/a | `UNREACHABLE`/`TIMEOUT` | localOcr.js:89-95,171-175 | trips | FALLBACK_GEMINI |

Timeouts & retries:

| side | value | file:line |
|---|---|---|
| bot /ocr abort | `OCR_TIMEOUT_MS` default 8000 (also TOTAL cutover budget: fetch+OCR share one deadline) | localOcr.js:47,114; ocrFirstWiring.js:73-75,527-539; .env.example:31 |
| bot shadow image-fetch abort | `OCR_SHADOW_TIMEOUT_MS` 15000 (env), code fallback 8000 | .env.example:32; ocrFirstWiring.js:77 |
| server inference deadline | **NONE** — job runs to completion after client disconnect | app.py (absent) — OCR-1 |
| retries | bot /ocr: none (single attempt); server: none; Groq parse: 1 retry (bot-internal) | localOcr.js:103-177; ocrFirst.js:117 |

Idempotency/double-feed: the service is stateless pure-compute with sha256 `imageHash` returned (app.py:217) — it cannot double-feed the bot; duplication risk lives entirely bot-side. No mismatch found beyond OCR-4/OCR-6.

## Cutover go/no-go (service-side conditions for OCR_FIRST_MODE=cutover)

- **NO-GO until OCR-1 fixed:** off-loop inference + concurrency cap + server deadline < 8s. Otherwise any 3-slip burst = bot timeouts → breaker → 60s of pure-vision, i.e. cutover self-disables under exactly the load it's meant to absorb.
- **NO-GO until shadow data is confirmed flowing and read:** verify `OCR_FIRST_MODE` on Fly (OCR-9) and review `ocr_shadow_decision` agreement + `ocr_sgp_would_hold` splits (BACKLOG.md:313-316) — traffic appears stopped since Jun 28.
- Align size caps (OCR-4) so the 8-10MB band isn't a permanently dead HTTP_4XX lane in the metrics.
- Add per-request requestId logging (OCR-6) — first cutover disagreement will need bot⇄server trace correlation.
- Unify the wiring's divergent `SUPPORTED_SPORTS`/`isSupportedSport` with `canonicalizeSportForGrading` — pre-existing BACKLOG bot#5 (docs/BACKLOG.md:194): alias/compound sports OCR resolves may be skipped or mis-gated at cutover.
- Pin the venv (OCR-8) before cutover makes the box load-bearing — a rebuild must reproduce the validated engine.
- Decide the goal honestly (OCR-10): as wired, cutover is a quality swap that still pays for Gemini; if cost is the driver, the seam order needs redesign first.
- Accept (documented): pm2 `max_memory_restart 1G` restart drops in-flight requests → bot falls back to vision; ~1s model-reload window returns 503s (breaker-tripping but needs 3).

## Looked good

- **Auth is the strongest of the satellite services:** constant-time `hmac.compare_digest` (app.py:169), fail-CLOSED when `OCR_SERVICE_TOKEN` unset (empty ⇒ unconditional 401, app.py:62,169) with an explicit startup warning (app.py:83-84), and it runs before any body read/decode — a token-less public flood costs headers+TLS only. All 97 bot POSTs 200; every scanner probe in the log got 404/401-class responses (tails-ocr-proxy.txt throughout).
- **Loopback bind + Funnel-only exposure as designed:** `127.0.0.1:11436` (probes/exposure.txt:11), matching README.md:26 / .env.example; the one historical `0.0.0.0` bind on 2026-06-02 10:40 was corrected within 3 minutes (error-3.log in tails-ocr-proxy.txt:217-227).
- **No secret/body leakage in logs:** app.py logs no imageBase64/token anywhere (only startup, warning, OCR-exception lines); uvicorn access log = real client IP + path + status (Funnel's X-Forwarded-For honored — usefully better forensics than ollama-proxy's `from 127.0.0.1`).
- **Error taxonomy is well-designed and correctly consumed:** 200/ok:false ("healthy service, unreadable image") vs non-200 ("service problem") lets the bot's breaker trip only on TIMEOUT/UNREACHABLE/HTTP_5XX (localOcr.js:35-39) — input problems can't flap the circuit. Field-level contract parity verified three ways (CONTRACT.md ⇄ app.py ⇄ localOcr.js).
- **No silent-slip-loss path found:** every OCR failure mode traces to `FALLBACK_GEMINI` (ocrFirst.js finalize paths; ocrFirstWiring never throws, shadow is fire-and-forget self-swallowing) — the prime-directive "silently stop feeding the bot" vector is structurally closed while vision remains the fallback.
- **/healthz means model-ready, not just process-alive** (app.py:141-149; confirmed live `{"ok":true,"modelLoaded":true}`, health-curls.txt:2), and a model-load failure is surfaced via `STATE["modelError"]` rather than crash-looping.
- **Pillow's decompression-bomb guard left at defaults** (no `MAX_IMAGE_PIXELS` override in app.py) — bombs >~178Mpx raise and are caught as `IMAGE_DECODE_ERROR` (app.py:221-223).
- **Runtime posture:** box checkout clean at origin/main (probes/checkouts.txt:19-22), pm2 autorestart + 1G memory guard (ecosystem.config.js:13-14), ↺0 since the Jun 29 boot, model load 1035ms (tails-ocr-proxy.txt:249-253), disk 18% used.
