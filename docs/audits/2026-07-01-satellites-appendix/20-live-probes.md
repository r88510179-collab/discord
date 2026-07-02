# 20 — Live probes (Surface Pro, read-only whitelist)

Captured 2026-07-02 ~09:15 ET over `ssh tracker@tracker-surface-pro`. Whitelist per audit
prompt Hard rule 5 — the exact commands below and nothing else; no pm2 jlist/conf/env/show,
no mutations, no git fetch/pull on Pro checkouts, no secret values echoed. Raw outputs were
staged in the audit scratch dir (`/tmp/zt-satellite-audit/probes/`, deleted at audit end);
token-like content is redacted in the snippets below.

Box context: `uptime` → up 3 days (rebooted **2026-06-29 00:24 ET**), load ~1.1–1.4.

---

## P-1 `pm2 list`

```
ollama-proxy           id 0  cluster  3D   ↺0   online   58.9mb
zonetracker-ocr        id 1  fork     3D   ↺0   online  147.1mb  (version N/A)
zonetracker-dashboard  id 2  fork     3D   ↺0   online   76.4mb
zonetracker-dubclub    id 3  fork     6h   ↺12  online  137.6mb
zonetracker-scraper    id 4  fork     3D   ↺0   online  135.6mb
```

**Read:** all five online. dubclub's ↺12 over 3 days (~4/day) is its *designed* IMAP
crash-only exit cycle (each `IMAP connection closed → exit → PM2 restart`, see P-8), same
class as June's ↺4/13h — not a regression, not healthy-by-silence either. pm_ids have
**shuffled** vs `docs/SURFACE-PRO.md` (doc: scraper 0 / proxy 1 / dubclub 2 / ocr 3 /
dashboard 4) — doc drift, and it corrupts log-file naming expectations (see P-4).

## P-2 Per-checkout HEAD + clean status (`git -C … rev-parse HEAD; status --porcelain; log -1`)

| Checkout | Pro HEAD | origin/main (Mac-side clone) | Tree |
|---|---|---|---|
| zonetracker-scraper | `ff9fda0` 2026-06-10 (#4 s01-observability) | `ff1a906` 2026-06-10 (#5 eco-untrack) | **1 behind**; ` M ecosystem.config.js` + `?? ecosystem.config.js.bak.20260610-115918` |
| zonetracker-dubclub | `633d084` 2026-06-12 (#6 docs sync) | `633d084` ✓ | ` M config.json`; `?? config.json.bak-20260610`, `?? ecosystem.config.cjs`, `?? storageState.json.bak-20260615` |
| zonetracker-dashboard | `d392754` 2026-06-17 (#9 thumbnail) | `d392754` ✓ | clean |
| zonetracker-ocr | `e21ee2c` 2026-06-02 | `e21ee2c` ✓ | clean |
| ollama-proxy | `62b8c6b` 2026-06-10 | `62b8c6b` ✓ (zonetracker-ollama-proxy) | clean |

**Read:** scraper box is one merge behind origin/main — and the missing commit (#5) is the
one that **untracks** `ecosystem.config.js`, so the box shows it locally modified (real env
values in a still-tracked file) and a future `git pull` will hard-conflict on it (finding
HO-3/SC-6). dubclub's modified `config.json` + untracked canonical `ecosystem.config.cjs`
are expected per SURFACE-PRO.md but unreproducible-from-git (finding DC-6). The
`storageState.json.bak-20260615` timestamp = last session re-seed Jun 15 — 17 days before
the live login-wall incident in P-8.

## P-3 `du -sh ~/.pm2/logs` + `ls -lh ~/.pm2/logs` + `ls ~/.pm2/modules`

```
46M  /home/tracker/.pm2/logs
 6.6K Jun 25 05:38  zonetracker-dashboard-error-4.log
  59K Jul  2 08:46  zonetracker-dashboard-out-4.log
  20M Jul  2 08:23  zonetracker-dubclub-error.log
  13M Jul  2 08:23  zonetracker-dubclub-out.log
 130K Jun 10 07:36  zonetracker-scraper-error.log    (STALE)
  15M Jun 10 12:36  zonetracker-scraper-out.log      (STALE)
~/.pm2/modules → EMPTY
```

**Read:** (a) **pm2-logrotate is still not installed** — H-1 remains OPEN and even the June
"Module: ollama-proxy" entry is gone post-reboot. (b) dubclub-error grew 16M→20M and
dubclub-out 11M→13M since Jun 10 (~4M+2M / 3 weeks, unbounded). (c) The scraper's
`~/.pm2/logs` files froze at the Jun-10 delete/start cycle — its live logs moved to
`~/zonetracker-scraper/logs/{out,error}.log` (repo-local, per ecosystem config). OCR and
ollama-proxy likewise log to repo-local `logs/` (P-4). So the 46M figure **understates**
total log growth; repo-local log sizes were not obtainable under the whitelist (`ls`/`du`
allowed only under `~/.pm2`) — UNVERIFIED, obtainable via `du -sh ~/zonetracker-scraper/logs
~/zonetracker-ocr/logs ~/ollama-proxy/logs`.

## P-4 Log tails — `tail -n 200` per service log

Live log locations discovered (ecosystem configs at pinned HEADs + tail probes):

| Service | Active out log | Active error log | Note |
|---|---|---|---|
| scraper | `~/zonetracker-scraper/logs/out.log` | `…/logs/error.log` | `merge_logs: true` → no id suffix |
| ocr | `~/zonetracker-ocr/logs/out-3.log` | `…/logs/error-3.log` | suffix = **old** pm_id 3 (now id 1) |
| ollama-proxy | `~/ollama-proxy/logs/out-{0,1}.log` | `…/logs/error-{0,1}.log` | cluster instances across restarts |
| dubclub | `~/.pm2/logs/zonetracker-dubclub-out.log` | `…-error.log` | pm2 defaults (no ecosystem log paths) |
| dashboard | `~/.pm2/logs/zonetracker-dashboard-out-4.log` | `…-error-4.log` | suffix = old pm_id 4 (now id 2) |

**Read:** during an incident, an operator following SURFACE-PRO.md's id map or pm2's
current ids will tail the wrong (or frozen) file for 3 of 5 services — operator-deception
hazard (finding HO-4).

### P-4a scraper (`logs/out.log`, `logs/error.log`)

```
2026-07-02 08:35:00: ═══ Cycle start 2026-07-02T12:35:00.541Z ═══
2026-07-02 08:35:00: [Init] Browser launched, 13 cookies loaded
2026-07-02 08:35:00: [Handles] fetched 8 active from Fly
2026-07-02 08:35:12: [Poll] @bobby__tracker 10 fetched, 0 new
…
error.log (window Jun 23 → Jul 2):
2026-06-23 18:30:37: …[Strike] @bookitwithtrent strike 5/5 (page.goto: Timeout 30000ms…)
2026-06-23 18:30:37: …[Disable] @bookitwithtrent hit 5 strikes (cooldown 6h)
2026-06-23 18:33:33: …[DeadAir] zero-fetch cycle 5/3 (8 active handles, 0 tweets fetched)
2026-06-23 18:35:38: …[Alarm] 🚨 [zonetracker-scraper] Dead air: 0 tweets fetched across ALL
                     handles for 6 consecutive cycles (~30 min)… Check browser_cookies.json…
2026-06-23 18:35:48: [Alarm] webhook failed: The operation was aborted due to timeout
   (…[DeadAir] counts to 77/3 through ~00:36, [Alarm] re-fires every 3 cycles, then ✅ recovery)
```

**Read:** scraper healthy NOW — cycles running (08:35 same morning), cookies loading (13),
handle list fetched from Fly (8 active), per-handle polls fetching. S-01 observability is
**live-fire proven**: the Jun 23 x.com/network outage exercised the entire state machine
in production — ISO-stamped `[Strike]`/`[Disable]`, `[DeadAir] zero-fetch cycle 5/3 … 77/3`,
`[Alarm]` re-firing every 3 cycles (78 DeadAir/Alarm lines in the tail window), and a
recovery notice next morning. Critically, the same outage also shows **`[Alarm] webhook
failed: … timeout`** — the alarm transport shares the box's failure domain, so during a
full-network outage the Discord alarm may never arrive (finding SC-8). The arm-time line
prints at boot only (outside a 200-line tail of a 3-day-old process); arm state is
corroborated by the webhook attempts themselves (see 02-scraper.md).

### P-4b ocr (`logs/out-3.log`, `logs/error-3.log`)

```
out-3.log — uvicorn access log, PUBLIC scanner traffic on the Funnel:
2026-06-11 15:57:19: INFO: 178.128.207.138:0 - "GET /actuator/env HTTP/1.1" 404 Not Found
2026-06-11 15:57:20: INFO: 142.93.143.8:0   - "GET /.vscode/sftp.json HTTP/1.1" 404 Not Found
2026-06-30 17:18:08: INFO: 147.185.132.123:0 - "GET /metrics HTTP/1.1" 404 Not Found
2026-06-30 20:21:35: INFO: 205.210.31.171:0 - "GET /v1/metadata HTTP/1.1" 404 Not Found
2026-07-02 09:17:04: INFO: 127.0.0.1:33680 - "GET /healthz HTTP/1.1" 200 OK   (this audit)
error-3.log:
2026-06-29 00:24:42: … starting zonetracker-ocr v0.1.0 on 127.0.0.1:11436 (engine rapidocr-onnx 1.4.4)
2026-06-29 00:24:43: … RapidOCR model loaded in 1035 ms
```

**Read:** empirical proof the Funnel `:8443` is internet-reachable — background scanners
(DigitalOcean/Censys-class IPs) probe it continuously; all 404 (only `/healthz`, `/version`,
`/ocr` exist). Uvicorn logs the real client IP (Funnel preserves it), paths and status only —
no bodies, no tokens. Clean Jun-29 boot, model loads in ~1s. Low request volume overall
(200 lines span Jun 11 → Jul 2 ≈ 10 lines/day — scanner noise dominates legitimate traffic;
OCR_FIRST shadow traffic is visible only as occasional authenticated POSTs).

### P-4c ollama-proxy (`logs/out-{0,1}.log`)

```
2026-06-27 20:31:14: [2026-06-28T00:31:14.805Z] 401 GET /.git/config from 127.0.0.1
2026-07-02 08:59:35: [2026-07-02T12:59:35.251Z] 401 GET / from 127.0.0.1
```

**Read:** same scanner pressure on Funnel `:443`; every request without the secret → 401
(gate works). Hygiene note: the proxy logs the *loopback* peer (`from 127.0.0.1` = tailscaled)
— unlike uvicorn it never sees/logs the real client IP, so abuse attribution is impossible
from this log. `error-1.log` shows stale Apr-17 `proxy error: socket hang up` entries only.

### P-4d dubclub (`~/.pm2/logs/zonetracker-dubclub-{error,out}.log`)

```
error.log — exit cycle + LIVE incident:
2026-06-29 00:24:43: [dubclub] FATAL: Error: getaddrinfo EAI_AGAIN imap.gmail.com   (boot, DNS not up yet)
2026-07-01 06:02:38 / 06:13:08 / 13:29:08 / 13:40:20 / 22:33:43 …: IMAP connection closed. Exiting so PM2 can restart.
2026-07-02 08:23:44: … UID 11484: login wall detected for capper GuessAndPrayBets. Alerting admin, leaving unseen.
2026-07-02 08:23:45: … UID 11485: login wall detected …
2026-07-02 08:23:46: … UID 11499: login wall detected …
2026-07-02 08:23:47: … UID 11514: login wall detected …
out.log:
2026-07-01 13:29:09 (+ every boot): Browser watchdog armed (probe every 300000ms, timeout 10000ms,
  relaunch ≤3× backoff [1000,5000,15000]ms, dead-air 86400000ms).
2026-07-02 08:23:42: IMAP exists event (count=1118). Triggering sweep.
2026-07-02 08:23:42: Sweep: 7 unseen DubClub email(s) to process.
2026-07-02 08:23:43: UID 11261: subject does not match "New plays from X!" — "Your Payment Receipt from DubClub". Skipping (leaving unseen).
2026-07-02 08:23:43: UID 11336: capper "ZoeLab" not in config.json. Skipping (leaving unseen).
2026-07-02 08:23:43: UID 11484: capper=GuessAndPrayBets scraping https://u23455199.ct.sendgrid.net/ls/click?upn=REDACTED-TRACKING-TOKEN
```

**Read:** (a) U-1 watchdog **live** — arm line on every boot with sane knobs. (b) IMAP
crash-only exit cycle operating as designed (~4 exits/day, PM2 restarts, no zombie). (c)
**LIVE P1-class incident:** every GuessAndPrayBets "New plays" email since ≥Jul 1 22:33 (4
UIDs and counting) hits a DubClub **login wall** — zero GNP picks delivered; the box's last
session re-seed was Jun 15 (P-2). Admin alerts ARE firing (alert-fatigue: re-alerts per UID
per sweep). (d) Permanently-unseen mail (receipts, trial notices, unconfigured capper
"ZoeLab") is re-fetched and re-skipped every sweep — June U-7 class live. (e) Hygiene: the
out log prints full sendgrid click-tracking URLs (bearer-ish `upn` tokens) — redacted here.

### P-4e dashboard (`~/.pm2/logs/zonetracker-dashboard-{error-4,out-4}.log`)

```
error-4.log (mtime Jun 25; NO timestamps on lines):
[proxy] POST /api/admin/holds/disc_1510607698473914429/recover -> ERROR (TimeoutError)   ×7 same id
[proxy] POST /api/admin/holds/disc_1518994551967055952/recover -> ERROR (TypeError)
[proxy] POST /api/admin/holds/disc_1519556256157798600/recover -> ERROR (TimeoutError)   (+5 more ids)
out-4.log (current):
[zonetracker-dashboard] listening on http://127.0.0.1:8787 -> proxying /api/admin/* to https://bettracker-discord-bot.fly.dev (secret: loaded)
[proxy] GET /api/admin/leaderboard?limit=5 -> 200
[proxy] GET /api/admin/drops?hours=24 -> 200
[proxy] GET /api/admin/grader-health -> 200
```

**Read:** the BACKLOG "hold-recover hammering" symptom is visible: repeated recover POSTs
against the same hold with no backoff, all TimeoutError (bot-side recover > dashboard proxy
timeout), plus one `TypeError`. Log lines carry **no timestamps** (`log_date_format` unset
for this app) — incident forensics degraded. The #161 Phase A read endpoints are already
being exercised through the proxy (200s) — consumption exists before any dashboard UI ships
them (operator curl or in-flight UI work).

## P-5 `df -h /`

```
/dev/nvme0n1p2  233G  38G  183G  18% /
```
**Read:** ample headroom; log growth is a hygiene problem, not a disk-pressure problem yet.

## P-6 `ss -tlnp` + `tailscale serve status` + `tailscale funnel status`

```
ss -tlnp (deduplicated):
100.89.87.116:443 / :8443 / :8444 / :45723   tailscaled (tailnet ingress)
[fd7a:…:57bb]:443 / :8443 / :8444 / :37554   tailscaled (tailnet v6)
127.0.0.1:8787   node  (dashboard)          127.0.0.1:11435  PM2/node (ollama-proxy)
127.0.0.1:11436  python (ocr)               127.0.0.1:631    cups
*:11434          (ollama — ALL interfaces)  0.0.0.0:22       sshd
127.0.0.53/54:53 systemd-resolved

tailscale serve/funnel:
https://tracker-surface-pro.tail65f8f0.ts.net       (Funnel on) → 127.0.0.1:11435  [PUBLIC]
https://tracker-surface-pro.tail65f8f0.ts.net:8443  (Funnel on) → 127.0.0.1:11436  [PUBLIC]
https://tracker-surface-pro.tail65f8f0.ts.net:8444  (tailnet only) → 127.0.0.1:8787
```

**Read:** matches SURFACE-PRO.md's intended map exactly — two public token-gated funnels
(ollama-proxy, ocr), dashboard tailnet-only, no accidental extra funnel. Residual exposure:
**ollama `*:11434` remains unauthenticated on every interface** (LAN + tailnet can bypass
the proxy's secret entirely); sshd on 0.0.0.0:22 (expected). See 05-host.md exposure table.

## P-7 `systemctl status ollama pm2-tracker --no-pager`

```
ollama.service      active (running) since 2026-06-29 00:24:39; Drop-In: override.conf
pm2-tracker.service active (running) since 2026-06-29 00:24:40; 211 tasks; Mem 1.7G (peak 2.2G)
```
**Read:** both units boot-resurrected cleanly on the Jun-29 reboot. pm2 tree 1.7G/peak 2.2G
(Playwright Chromium children included) — within the box's limits; task count 211 vs limit
7951. `override.conf` contents not readable under the whitelist (UNVERIFIED — likely the
OLLAMA_HOST bind; cross-ref HO-2).

## P-8 Unauthenticated localhost health curls

```
GET 127.0.0.1:11436/healthz → {"ok":true,"modelLoaded":true}
GET 127.0.0.1:11436/version → {"service":"zonetracker-ocr","version":"0.1.0","engine":"rapidocr-onnx",
                               "engineVersion":"1.4.4","modelVersion":"PP-OCRv4","startedAt":"2026-06-29T04:24:42Z"}
GET 127.0.0.1:8787/          → 200 (dashboard static)
GET 127.0.0.1:11435/ (no secret) → 401 (ollama-proxy gate works)
GET 127.0.0.1:11434/         → "Ollama is running"; /api/version → {"version":"0.20.5"}
```

**Read:** OCR healthy with model loaded since boot; dashboard serving; proxy fails closed
without the secret; ollama itself answers **without any auth** on 11434 (reachable beyond
loopback per P-6 — the finding is the bind, not the reply).

---

## Whitelist-blocked items (UNVERIFIED, with the obtaining command)

| Item | Why blocked | Command that would obtain it |
|---|---|---|
| Repo-local log dir sizes (scraper/ocr/ollama-proxy) | `ls`/`du` whitelisted only under `~/.pm2` | `du -sh ~/zonetracker-scraper/logs ~/zonetracker-ocr/logs ~/ollama-proxy/logs` |
| PM2 runtime env convergence (H-2 exact) | `pm2 env/show/jlist` forbidden (value echo) | `pm2 jlist` parsed for key NAMES only |
| `ollama.service` override.conf contents | file read not whitelisted | `systemctl cat ollama --no-pager` |
| crontab entry still present (zonetracker-stats) | `crontab` forbidden this run | `crontab -l` |
| Full scraper arm-time log line (boot-time, outside tail window) | only `tail -n 200` allowed | `grep -m1 'Dead-air watchdog' ~/zonetracker-scraper/logs/out.log` |
| Public-internet reachability from a non-tailnet vantage | audit ran from a tailnet Mac | `curl https://tracker-surface-pro.tail65f8f0.ts.net:8443/healthz` from any external host (scanner traffic in P-4b already proves it empirically) |
