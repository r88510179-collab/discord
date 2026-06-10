# Surface Pro — service inventory

Authoritative host-level inventory of every long-running process on the Surface Pro
(`tracker@tracker-surface-pro`, Tailscale SSH). Complements `docs/WORKFLOWS.md`, which
covers the Mac-side *edit→PR→deploy* workflow per repo; **this** doc is the runtime
"what is actually running on the box, on which port, exposed how" map — including the
two services WORKFLOWS omits (`ollama-proxy`, `zonetracker-ocr`).

> **Discovery method (read-only, no restarts/config changes).** All facts below were
> captured live on 2026-06-10 over `ssh tracker@tracker-surface-pro`: `pm2 jlist`
> (parsed for `pm_cwd`/`pm_exec_path`/`exec_interpreter`/`args` only — never echoed
> raw, never env values), `git rev-parse`/`log -1` per checkout, `ss -tlnp`,
> `tailscale serve|funnel status`, `crontab -l`, `systemctl`. Env coverage lists **key
> names only — no values appear in this doc by design.**

Host: `Linux tracker-Surface-Pro 6.19.8-surface-3 x86_64`. Tailnet IP `100.89.87.116`,
hostname `tracker-surface-pro.tail65f8f0.ts.net`.

---

## At a glance

| PM2 app | id | mode | cwd (`/home/tracker/…`) | entry | listens | exposure |
|---|---|---|---|---|---|---|
| `ollama-proxy` | 1 | cluster | `ollama-proxy` | `proxy.js` (node) | `127.0.0.1:11435` | Funnel `:443` (public) |
| `zonetracker-scraper` | 0 | fork | `zonetracker-scraper` | `scraper.js` (node) | — (outbound only) | none |
| `zonetracker-dubclub` | 2 | fork | `zonetracker-dubclub` | `index.js` (node) | — (outbound only) | none |
| `zonetracker-ocr` | 3 | fork | `zonetracker-ocr` | `.venv/bin/python app.py` | `127.0.0.1:11436` | Funnel `:8443` (public, token) |
| `zonetracker-dashboard` | 4 | fork | `zonetracker-dashboard` | `server.js` (node) | `127.0.0.1:8787` | serve `:8444` (tailnet-only) |

Plus two systemd units (`ollama`, `pm2-tracker`) and one user crontab entry
(`zonetracker-stats`, cron-only — **not** a PM2 app). See below.

### Tailscale exposure map (verified live via `tailscale serve|funnel status`)

```
https://tracker-surface-pro.tail65f8f0.ts.net           (Funnel)  → 127.0.0.1:11435  ollama-proxy → 127.0.0.1:11434 ollama
https://tracker-surface-pro.tail65f8f0.ts.net:8443      (Funnel)  → 127.0.0.1:11436  zonetracker-ocr
https://tracker-surface-pro.tail65f8f0.ts.net:8444      (serve)   → 127.0.0.1:8787   zonetracker-dashboard   (tailnet only — NOT public)
```

Funnel only permits ports `443 / 8443 / 10000`; `:443` was taken by ollama-proxy, so OCR
took `:8443`. The dashboard is deliberately `serve` (tailnet) not `funnel` (public).

---

## ollama-proxy  (pm_id 1, cluster)

- **Repo:** ⚠️ **none — not a git repository** (`git rev-parse` fails; no `.git`, no remote).
  Lives only as files in `/home/tracker/ollama-proxy`. Edits are made directly on the box;
  there is no upstream to `git pull`. (See BACKLOG / risk note below.)
- **cwd / entry:** `/home/tracker/ollama-proxy` · `proxy.js` (node).
- **Port:** listens `127.0.0.1:11435`.
- **Exposure:** Tailscale **Funnel** (public) on the root domain `:443` → `127.0.0.1:11435`.
- **Canonical env:** `ecosystem.config.js` `env:` block (no `.env`, no dotenv —
  `proxy.js` reads `process.env` injected by PM2). **Key names:** `OLLAMA_PROXY_SECRET`.
- **What it does:** a ~50-line reverse proxy. Validates the `x-ollama-secret` request
  header against `OLLAMA_PROXY_SECRET`; on mismatch → `401`. On match, strips the header
  and forwards to Ollama at `http://127.0.0.1:11434` (both port and upstream are
  hardcoded in `proxy.js`).
- **Deploy procedure:**
  - *Code change:* edit `proxy.js` on the box → `pm2 restart ollama-proxy`.
  - *Env/secret change:* edit `ecosystem.config.js` → `pm2 delete ollama-proxy && pm2 start ecosystem.config.js && pm2 save`
    (`pm2 restart` reads the saved dump, **not** the file — the delete/start/save cycle
    is required to re-read the env block; mirrors `docs/DEPLOY_CHECKLIST.md` Step 9's
    three-location rule: file ↔ `~/.pm2/dump.pm2` ↔ runtime).

## zonetracker-scraper  (pm_id 0, fork)

- **Repo:** `git@github.com-zonetracker:r88510179-collab/zonetracker-scraper.git`
  · HEAD `e28d768` (2026-06-10, "Merge PR #3 fix/s01-dead-air-watchdog").
- **cwd / entry:** `/home/tracker/zonetracker-scraper` · `scraper.js` (node).
- **Port:** none — outbound HTTP client only.
- **Exposure:** none.
- **Canonical env:** TWO sources.
  - `.env` (loaded by `require('dotenv').config()`, `scraper.js:6`) — **keys:**
    `INGEST_URL`, `MOBILE_SCRAPER_SECRET`, `TWITTER_API_KEY`, `TWITTER_EMAIL`,
    `TWITTER_PASSWORD`, `TWITTER_USERNAME`.
  - `ecosystem.config.js` `env:` block — **keys:** `ALERT_WEBHOOK_URL`,
    `DEAD_AIR_CYCLES`, `NODE_ENV`.
  - (A stale `ecosystem.config.js.bak.20260610-115918` is also present — ignore.)
- **Call graph:** scrapes X/Twitter timelines → `POST` to the Fly bot
  `INGEST_URL` (default `https://bettracker-discord-bot.fly.dev/api/mobile-ingest`)
  with header `x-mobile-secret = MOBILE_SCRAPER_SECRET` (bot side: `routes/api.js:19-22`).
- **Deploy procedure:**
  - *Code:* `cd ~/zonetracker-scraper && git pull && pm2 restart zonetracker-scraper`.
  - *Env (ecosystem block):* edit → `pm2 delete && pm2 start ecosystem.config.js && pm2 save`.
  - *Env (`.env`):* edit `.env` → `pm2 restart zonetracker-scraper`.

## zonetracker-dubclub  (pm_id 2, fork)

- **Repo:** `git@github.com-dubclub:r88510179-collab/zonetracker-dubclub.git`
  · HEAD `b55c449` (2026-06-10, "Merge PR #2 fix/u1-browser-watchdog").
- **cwd / entry:** `/home/tracker/zonetracker-dubclub` · `index.js` (node).
- **Port:** none — IMAP in, Discord webhooks out.
- **Exposure:** none.
- **Canonical env:** **`ecosystem.config.cjs`** (the canonical env source as of the
  S-01/U-1 wiring) `env:` block — **keys:** `ADMIN_ALERT_WEBHOOK_URL`,
  `BROWSER_PROBE_INTERVAL_MS`, `BROWSER_PROBE_TIMEOUT_MS`, `BROWSER_RELAUNCH_BACKOFF_MS`,
  `BROWSER_RELAUNCH_MAX_ATTEMPTS`, `DEAD_AIR_MAX_MS`, `DUBCLUB_FROM`, `GNP_WEBHOOK_URL`,
  `HEADLESS`, `IMAP_APP_PASSWORD`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`,
  `LOCKEDIN_WEBHOOK_URL`.
  - A `.env` is also present with an overlapping subset (`ADMIN_ALERT_WEBHOOK_URL`,
    `DUBCLUB_FROM`, `GNP_WEBHOOK_URL`, `HEADLESS`, `IMAP_*`, `LOCKEDIN_WEBHOOK_URL`) and is
    loaded by `import 'dotenv/config'` (`index.js:1`). PM2 injects the ecosystem env at
    spawn and dotenv does **not** override already-set vars, so the **`.cjs` values win** —
    treat `ecosystem.config.cjs` as canonical.
- **Call graph:** watches Gmail via IMAP (`IMAP_HOST`/`IMAP_USER`/`IMAP_APP_PASSWORD`) for
  DubClub "New plays" mail → Playwright-scrapes the plays page → posts to per-capper
  Discord webhooks (`GNP_WEBHOOK_URL`, `LOCKEDIN_WEBHOOK_URL`) → ingested by the Fly bot's
  normal `messageHandler` path.
- **Deploy procedure:**
  - *Env:* edit `ecosystem.config.cjs` → `pm2 delete zonetracker-dubclub && pm2 start ecosystem.config.cjs && pm2 save`.
  - *Code:* `git pull && pm2 restart zonetracker-dubclub`.

## zonetracker-ocr  (pm_id 3, fork)  — *RapidOCR microservice*

- **Repo:** `git@github.com-ocr:r88510179-collab/zonetracker-ocr.git`
  · HEAD `e21ee2c` (2026-06-02, "docs(readme): deploy steps reflect Surface Pro reality").
  Has its own `README.md` + `CONTRACT.md` (wire format the bot mirrors) + `ecosystem.config.js`.
- **cwd / entry:** `/home/tracker/zonetracker-ocr` · `.venv/bin/python app.py`
  (Python FastAPI/uvicorn running **RapidOCR** `rapidocr-onnxruntime`, CPU ONNX PP-OCRv4).
- **Port:** listens `127.0.0.1:11436`.
- **Exposure:** Tailscale **Funnel** (public, bearer-token-gated) on `:8443` → `127.0.0.1:11436`.
- **Canonical env:** **`.env`** (loaded by python-dotenv `load_dotenv()`, `app.py:29`) —
  **keys:** `HOST`, `OCR_MAX_IMAGE_BYTES`, `OCR_SERVICE_TOKEN`, `PORT`.
  Plus `ecosystem.config.js` `env:` block — **key:** `PYTHONUNBUFFERED`.
- **Endpoints (see repo `CONTRACT.md`):** `GET /healthz` (`200 {ok,modelLoaded:true}` only
  if the model loaded, else `503`), `GET /version`, `POST /ocr`
  (`Authorization: Bearer <OCR_SERVICE_TOKEN>`; body `{imageBase64,mediaType,requestId,source}`;
  `401` no token, `413` over `OCR_MAX_IMAGE_BYTES`, `503` model not loaded).
- **Live (verified 2026-06-10 via the Funnel URL):** `/healthz` → `{"ok":true,"modelLoaded":true}`;
  `/version` → `zonetracker-ocr 0.1.0 / engine rapidocr-onnx 1.4.4 / model PP-OCRv4 /
  startedAt 2026-06-09T23:45:40Z`.
- **Call graph:** the **Fly bot** is the only consumer. `services/localOcr.js` does
  `POST {OCR_SERVICE_URL}/ocr` with `Authorization: Bearer {OCR_SERVICE_TOKEN}`, where the
  bot's `OCR_SERVICE_URL` = `https://tracker-surface-pro.tail65f8f0.ts.net:8443` (see
  `.env.example:29-30`, `docs/specs/ocr-first.md`). Funnel `:8443` terminates to
  `127.0.0.1:11436`. **No on-box process calls `:11436`** (grep evidence below).
- **Deploy procedure:**
  - *Code:* `cd ~/zonetracker-ocr && git pull && pm2 restart zonetracker-ocr`.
  - *Python deps:* `.venv/bin/python -m pip install -r requirements.txt` → `pm2 restart`.
  - *Env (`.env`):* edit `.env` → `pm2 restart zonetracker-ocr`.
  - Host quirks (per repo README): private repo via per-repo SSH deploy key + `~/.ssh/config`
    alias `github.com-ocr`; venv pip bootstrapped with `get-pip.py` (`ensurepip` missing).

## zonetracker-dashboard  (pm_id 4, fork)

- **Repo:** `github.com-dashboard:r88510179-collab/zonetracker-dashboard.git`
  · HEAD `b37e51a` (2026-06-10, "fix(proxy): contain upstream mid-body failure (D-1) (#5)").
- **cwd / entry:** `/home/tracker/zonetracker-dashboard` · `server.js` (node).
- **Port:** listens `127.0.0.1:8787`.
- **Exposure:** Tailscale **serve** (tailnet-only, **not** Funnel) on `:8444` → `127.0.0.1:8787`.
- **Canonical env:** **`.env`** (loaded by `process.loadEnvFile('.env')`, `server.js:23`) —
  **keys:** `ADMIN_API_SECRET`, `FLY_BOT_URL`, `PORT`. Plus `ecosystem.config.js` `env:`
  block — **key:** `NODE_ENV`.
- **Call graph:** operator browser (on the tailnet) → `:8444` → dashboard `:8787` → calls the
  Fly bot admin API at `FLY_BOT_URL` using `ADMIN_API_SECRET` (same value as the Fly
  `ADMIN_API_SECRET` secret).
- **Deploy procedure:**
  - *Code:* `git pull && pm2 restart zonetracker-dashboard`.
  - *Env (`.env`):* edit `.env` → `pm2 restart zonetracker-dashboard`.

---

## systemd units

| unit | state | role |
|---|---|---|
| `ollama.service` | active (running) | Ollama LLM server. Listens `*:11434` (all interfaces). This is the upstream behind `ollama-proxy`; the proxy adds the `x-ollama-secret` auth gate in front of it for the public Funnel. |
| `pm2-tracker.service` | active (running) | PM2 process manager (boot-resurrects the 5 PM2 apps via the saved dump). |

> Note: `ollama` binds `*:11434` (every interface), not `127.0.0.1`. Public access is
> gated by `ollama-proxy`'s secret on the Funnel, but `:11434` itself is reachable on the
> LAN/tailnet without that gate. Observation only — out of scope for this doc.

## crontab (user `tracker`)

```
0 2 * * * cd /home/tracker/zonetracker-stats && /usr/bin/node scripts/nightly_refresh.js >> logs/nightly.log 2>&1
```

- One entry: a nightly ~02:00 (box-local) refresh for **`zonetracker-stats`** — a sixth
  on-box directory that is **cron-only, not a PM2 app** and not otherwise inventoried here.
  WORKFLOWS.md lists it as `[TODO confirm]`. Flagged for a future inventory pass.

---

## Call-graph summary & evidence

**Inbound (Fly bot → Surface Pro):**
1. OCR slip text — Fly `services/localOcr.js` → Funnel `:8443` → `:11436` `zonetracker-ocr`.
2. Ollama/Gemma vision fallback — Fly `services/ai.js:140,819` / `services/grading.js:2326` /
   `commands/admin.js:998,1024` send `x-ollama-secret` to `OLLAMA_URL`
   (`https://tracker-surface-pro.tail65f8f0.ts.net`, the Funnel root `:443`) → `:11435`
   `ollama-proxy` → `:11434` `ollama`.

**Outbound (Surface Pro → Fly bot):**
3. `zonetracker-scraper` → `POST /api/mobile-ingest` (`x-mobile-secret`).
4. `zonetracker-dubclub` → per-capper Discord webhooks (ingested by `messageHandler`).
5. `zonetracker-dashboard` → Fly admin API at `FLY_BOT_URL` (`ADMIN_API_SECRET`).

**Who consumes the localhost-only ports (step-5 trace, with the exact greps):**

- **`:11436` (OCR)** → consumer = **the Fly bot**, via Funnel `:8443`. Evidence:
  - On the box, `grep -rn 11436` and `grep -rn tail65f8f0`/`8443` across
    `zonetracker-scraper`, `zonetracker-dubclub`, `zonetracker-dashboard`, `ollama-proxy`
    (excluding `node_modules`/`.git`) → **no matches** ⇒ no on-box caller.
  - In the discord checkout: `OCR_SERVICE_URL`/`OCR_SERVICE_TOKEN` used by
    `services/localOcr.js:46`, defined in `.env.example:29-30`, spec `docs/specs/ocr-first.md`.
  - The repo's own `README.md`/`CONTRACT.md` state the base URL is "the Tailscale Funnel
    HTTPS endpoint of the Surface Pro" and the result goes "to the Fly bot over Tailscale".
- **`:11435` (ollama-proxy)** → consumer = **the Fly bot**, via Funnel root `:443`. Evidence:
  - On the box, `grep -rn 11435` matched only `ollama-proxy/proxy.js` (the listener itself)
    and its logs ⇒ no on-box caller.
  - In the discord checkout: `x-ollama-secret` senders at `services/ai.js:140,819`,
    `services/grading.js:2326`, `commands/admin.js:998,1024`; `OLLAMA_URL` confirmed set on
    Fly to the Funnel host (`docs/BACKLOG.md:786`, `docs/DEPLOY_CHECKLIST.md`).

No consumer was left UNKNOWN.
