# ZoneTracker Satellite Services Audit — 2026-07-01 (report only)

Report-only follow-up to `docs/audits/2026-06-10-coa-full-audit.md` (§§C–D) and companion to
the main-bot audit on `audit/2026-07-01-full`. **Zero changes** were made to any service, repo
checkout, or the Surface Pro host: all satellite code was read from fresh Mac-side clones, bot
code from this audit's own worktree at `origin/main`, and every live fact came from the
read-only SSH command whitelist in the prompt (no `pm2 jlist/conf/env/show`, no mutation, no
Pro-side `git fetch/pull`, no secret values). Scratch clones under `/tmp/zt-satellite-audit`
were deleted at the end.

**Scope:** `zonetracker-scraper`, `zonetracker-dubclub`, `zonetracker-dashboard`,
`zonetracker-ocr` (first-ever audit — deepest track), the Surface Pro host, and every
cross-repo contract. `zonetracker-ollama-proxy` was added to the clone set for the
bot→ollama-proxy edge and the host exposure map.

**Prime directive answered:** *where can a satellite silently stop feeding the bot, feed it
garbage, double-feed it, or expose the system publicly?* The five load-bearing answers are in
the exec summary; the OCR verdict is in §4.

Pinned revisions (all clones fresh, treated read-only):

| Repo | HEAD | Box HEAD | Committed |
|---|---|---|---|
| bettracker-discord-bot (worktree) | `19ff594` | Fly (live) | 2026-07-01 |
| zonetracker-scraper | `ff1a906` | **`ff9fda0` (1 behind)** | 2026-06-10 |
| zonetracker-dubclub | `633d084` | `633d084` (dirty) | 2026-06-12 |
| zonetracker-dashboard | `d392754` | `d392754` (clean) | 2026-06-17 |
| zonetracker-ocr | `e21ee2c` | `e21ee2c` (clean) | 2026-06-02 |
| zonetracker-ollama-proxy | `62b8c6b` | `62b8c6b` (clean) | 2026-06-10 |

Appendix (evidence): `00-baseline.md` (pins + full regression table), `01-ocr.md`,
`02-scraper.md`, `03-dubclub.md`, `04-dashboard.md`, `05-host.md`, `06-contracts.md`,
`20-live-probes.md` (every whitelisted command + redacted output).

---

## 1. Executive summary — top findings (severity × likelihood × blast radius)

The single most important finding is not a code defect: **a satellite feed is dark right now.**

| # | Finding | Sev | Where | One-line fix |
|---|---|---|---|---|
| 1 | 🚨 **LIVE: GNP DubClub feed dead ≥3 days** behind an expired login wall; 97 admin alerts fired carrying the *wrong* re-seed instruction; the two designed safety nets (dead-air alarm, watchdog) structurally cannot see it | P1 | dubclub DC-1 | **Re-seed now** (seed-mac.js→scp); then fix alert text (U-9) + persist storageState (U-11) + alert cooldown (U-7) |
| 2 | 🚨 **DubClub picks posted while the bot is down are permanently, silently lost** — Discord accepts the webhook, dubclub marks it `\Seen`, the bot has no startup backfill and GUARD 4 drops >2-min-old messages on replay. Every Fly deploy is a loss window | P1 | contracts CT-2 | Boot-time bounded backfill of split channels, or move dubclub to an authenticated retrying bot endpoint |
| 3 | 🚨 **Scraper `/api/mobile-ingest` early-200 loses in-flight batches on any bot restart** (at-most-once), and the pre-parse `processed_tweets` insert dedup-poisons any resend. June M-16a, still open at bot HEAD | P1 | scraper SC-1 / CT-1 | Persist-then-ack: `ingest_queue` insert before the 200, drain async, delete on completion |
| 4 | 🚨 **Caption-less slip tweets always dropped before the image check**, and a `tweetText` selector drift ships `text:''` for every tweet → 100% silent feed loss with all monitors green. June M-16b, still open | P1 (latent-total) | scraper SC-2 / CT-1 | One-liner: `if (!tweetId \|\| (!text && imageUrls.length === 0))` |
| 5 | 🛠️ **OCR cutover is NO-GO**: inference blocks the single-worker event loop with no server-side deadline or concurrency cap, so any multi-slip burst blows the bot's 8s budget → timeout → breaker → pure-vision, i.e. cutover self-disables under the exact load it exists to absorb | P2 (blocks cutover) | ocr OCR-1 | Off-loop inference + concurrency cap + server deadline < 8s, before flipping `OCR_FIRST_MODE=cutover` |

Runner-ups worth surfacing: **ollama `*:11434` is unauthenticated on all interfaces**
(LAN/tailnet bypass of the proxy secret — HO-1/CT-9, P2); **any tailnet device gets all four
admin writes with no further auth** and one flag (`serve`→`funnel`) from a P0 (DB-2); the
**scraper box can't be deployed by its documented runbook** (a modified, secret-bearing tracked
`ecosystem.config.js` that origin has since untracked → guaranteed `git pull` conflict, and a
`git add -A` would leak the live alert webhook — HO-3/SC-4); and the **dashboard recover
"hammering"** is the UI instructing operators to retry recovers that actually succeeded, because
the 15s proxy timeout is shorter than the bot's vision-bearing recover (DB-1/CT-7).

**Public exposure is clean.** Only the two intended, token-gated Funnel paths are internet-
reachable (`:443`→ollama-proxy, `:8443`→ocr); the dashboard is correctly tailnet-only. Internet
scanners demonstrably reach the box's Funnel ports (404/401 noise in the OCR/proxy logs), so the
token gates are doing real work — but that same proof is why the unauthenticated ollama bind and
the no-auth tailnet admin surface deserve hardening rather than "observation only."

**Both June P1s are fixed and live-verified.** S-01 (scraper dead-air) fired its entire state
machine during a real Jun 23 network outage; U-1 (dubclub browser watchdog) arms on every boot.
The satellite services are meaningfully more resilient than in June — the open items are the
*next* layer of silent-loss holes, not regressions.

---

## 2. Findings register

Severity rubric: **P0** public exposure of a mutating/costly surface or data corruption today;
**P1** silent feed loss or duplicate-feed into the bot; **P2** reliability/cost/operator-
deception; **P3** hygiene/drift. Each row: severity · confidence · one-line evidence (full
file:line + probe cites in the named appendix). Fix effort S/M/L.

### P1 — silent feed loss / duplicate feed

| ID | Finding | Conf | Fix | Effort | Appendix |
|---|---|---|---|---|---|
| DC-1 | LIVE GNP feed dark ≥3 days (expired session, U-11 no re-persist); 97 alerts with the wrong fix text | high | re-seed + U-7/U-9/U-11 patches | S ops + S×3 | 03 |
| CT-2 | Webhook feeds lost permanently during any bot-down window (no delivery coupling, GUARD 4 drops replays) | high/med | boot backfill of split channels, or authenticated retrying endpoint | M | 06 |
| SC-1 / CT-1 | mobile-ingest early-200 → at-most-once; `processed_tweets` pre-insert poisons resend | high | persist-then-ack `ingest_queue` | M | 02, 06 |
| SC-2 / CT-1 | caption-less tweets dropped pre-image; `tweetText` drift = 100% silent loss, monitors green | high | `(!text && imageUrls.length===0)` | S | 02, 06 |
| CT-3 | dubclub partial-failure re-post duplicates; bot webhook path has no content dedup (`source='discord'`) | high | extend `findRecentRepost` to discord source (bot) + per-email progress (dubclub) | S+M | 06 |

### P2 — reliability / cost / operator-deception / posture

| ID | Finding | Conf | Fix | Effort | Appendix |
|---|---|---|---|---|---|
| OCR-1 | inference blocks the event loop; no server deadline / concurrency cap → burst timeouts, breaker flap | high | off-loop + semaphore + deadline<8s | M | 01 |
| OCR-2 | body buffered + base64-decoded before the 8MB guard; no pixel-dimension cap | high/med | Content-Length precheck + `img.size` budget | S | 01 |
| HO-1 / CT-9 | ollama `*:11434` unauthenticated on all interfaces — proxy secret bypassable from LAN/tailnet | high | `OLLAMA_HOST=127.0.0.1` | S | 05, 06 |
| DB-2 | any tailnet device = all 4 admin writes, no further auth; one flag from a P0 public mutating surface | high/low | Tailscale ACL on :8444 (or dashboard session token) | S/M | 04 |
| DB-1 / CT-7 | 15s proxy timeout < vision-bearing recover → "unreachable, Try again" for recovers that succeed (root of the recover-hammering) | high | per-path 60–120s timeout + classify the proxy's own 502 | S | 04, 06 |
| HO-3 / SC-4 | scraper box runs a modified, secret-bearing **tracked** ecosystem.config.js that origin #5 deleted → pull conflict + `git add -A` leaks the alert webhook | high | deliberate #5 cutover (checkout→pull→restore untracked) | S | 05, 02 |
| DC-3 | IMAP connect-failure = alertless, backoff-less crash-loop that launches a Chromium per cycle (9 FATALs in 12s, Jun 23) | high/med | in-proc retry+backoff+alert; launch browser after connect; commit `.cjs` w/ backoff | S/M | 03 |
| DC-4 | dead-air alarm can't fire: ~4/day crash-restarts reset its 24h in-memory clock; cleanup() disables it during a hang | high | persist lastSuccessAt to disk / derive from newest `\Seen` | S | 03 |
| DC-5 | cleanup() has no timeouts — a wedged Chromium at IMAP-close turns crash-only exit into a silent zombie | high/med | withTimeout both awaits + exit guard | S | 03 |
| DC-6 / CT-4 | webhook non-2xx never alerts; an `ALLOWED_WEBHOOK_IDS` miss → bridge `\Seen`s picks the bot silently drops (May 31 ~860-post class); split-bypass saves `confirmed` unless `audit_mode` on | high (UNVERIFIED live setting) | alert on non-2xx + rotation runbook; pin `needs_review` for split webhooks | S | 03, 06 |
| SC-3 / CT-5 / CT-6 | ingest-failure and per-handle strike→disable never alarm; dead-air webhook shares the box's failure domain (died Jun 23) | high | scraper failed-ingest counter + `[Disable]` alert; **bot-side "no mobile-ingest for N h" check** (the out-of-domain complement) | S | 02, 06 |
| SC-5 | S-02 unfixed: initBrowser partial failure orphans a Chromium per 5-min cycle | high | `shutdownBrowser()` in the catch | S | 02 |
| SC-6 / NEW-1 | S-03 unfixed: no cycle deadline; a wedged Playwright call zombifies the daemon **and mutes the S-01 alarm** | high | `runCycleWithDeadline()` → `process.exit(1)` | S | 02 |
| SC-7 | timeline under-render (2–8 of 10 requested); the Jun-10 missed-slip probe is still owed | med | run the owed instrumentation, then tune scroll/wait | S+S | 02 |
| SC-8 | dead-air alarm: success never logged, re-alarms unbounded, shares failure domain | high | log 2xx, space re-alarms, add bot-side complement | S | 02 |
| SC-9 | cookie-death re-seed procedure documented nowhere (the expected eventual failure) | high | README + SURFACE-PRO runbook (hot-swap, no restart) | S | 02 |
| DC-7 | U-7 live-costly: 97 admin pings in 2.5 days, no cooldown; permanent-skip UIDs re-download full bodies every sweep | high | envelope-first fetch + skippedUids set + 1h cooldown | S | 03 |
| DC-8 | ZoeLab capper emailing since ≥Jul 1 but not in config — picks skipped log-only | high/low | complete/disable ZoeLab; alert on first unknown capper | S | 03 |
| CT-8 / DC-12 | U-3 unfixed: "leave unseen for retry" has no retry timer (masked by crash-churn) | high | `setInterval(safeSweep, 10m)` | S | 03, 06 |
| HO-2 | log-location chaos: stale/frozen files + wrong-pm_id suffixes deceive operators mid-incident | high | convergence pass + `merge_logs` + logrotate | S | 05 |
| HO-5 | dubclub canonical env + restart policy exist only as an untracked on-box `.cjs` (single point of loss; policy unreviewable) | med | commit sanitized `.cjs.example` with backoff | S | 05 |
| HO-7 | boot-order race: pm2 resurrects before DNS ready (dubclub FATAL 3s after boot) | med | `After=network-online.target` / in-app boot-EAI_AGAIN retry | S | 05 |

### P3 — hygiene / drift (condensed; full text in appendices)

- **Scraper:** SC-10 `.env.example` real burner values + README `DEAD_AIR_CYCLES "(min 1)"` nit;
  SC-11 boot banner "Handles: 9"; SC-12 built-in fallback list drifted (would double-feed GNP +
  drop lockedin_sportz); SC-13 retweet flag not forwarded (misattribution on `socialContext`
  drift); SC-14 no `exp_backoff_restart_delay`; SC-15 `@toptierpicks_` cursor frozen since Mar 17.
- **DubClub:** DC-9 config/env/docs disagree (box 1 capper vs repo 2; U-8 LOCKEDIN omitted; U-10
  CODEMAP anchors +4); DC-10 token-bearing SendGrid URLs logged 3-4×/sweep + echoed to Discord;
  DC-11 chrome-regex silent-eat class + U-5 scrapePicks longest-element.
- **Dashboard:** DB-3 `in_flight` status unhandled (says "already resolved" mid-recovery); DB-4
  D-6 href/src no scheme check (surface grew with #9 thumbnail); DB-5/NEW-2 per-request log, no
  timestamps (undatable incident forensics), no rotation; DB-6 "Read-only dashboard" label vs 4
  writes; DB-7 D-8 path-escape + D-2 mount-order tests missing; DB-8 Pico floating `@2` no SRI;
  DB-9 400→"Server error (400)" mislabel.
- **OCR:** OCR-3 `/version` unauthenticated (scanners harvested the stack fingerprint); OCR-4
  8–10MB dead band (bot fetches 10MB, service rejects >8MB); OCR-5 `checkHealth` has no prod
  caller (documented breaker-recovery path inert); OCR-6 `requestId` logged only on exception
  (CONTRACT promises tracing); OCR-7 log rotation + pm_id/suffix drift; OCR-8 only rapidocr
  pinned (fastapi/uvicorn/numpy/onnxruntime float — a rebuild won't reproduce the validated
  engine); OCR-9 shadow OCR traffic ceased Jun 28 (cause UNVERIFIED); OCR-10 cutover still runs
  vision first (quality swap, not the cost swap the header claims).
- **Host/contracts:** HO-6 SURFACE-PRO.md pm_id map 100% wrong + 2 stale HEAD lines; HO-8 H-3
  (a partial / b partial / **c regressed** bak accumulation); HO-9 ollama-proxy logs every public
  hit as `from 127.0.0.1` (zero client-IP forensics); CT-10 generic-GET forward auto-exposes
  every future bot read endpoint to the tailnet; CT-11 all-disabled handles table silently stops
  the feed with the alarm suppressed; CT-12 SURFACE-PRO.md stale grader line anchor.

---

## 3. Regression verdict on the June satellite/host findings

Full table with per-item evidence in `00-baseline.md §3`. Headline:

- **7 of 25 tracked items closed** — **FIXED:** S-01, U-1, U-4, D-1, D-2. **FIXED-with-caveat:**
  U-6 (resolved differently — untracked on-box `.cjs`; its restart policy is unverifiable under
  the whitelist), D-3 (comments/tests updated; the visible "Read-only dashboard" label remains).
- **Both June P1s (S-01, U-1) are closed and live-verified** — S-01's alarm machine fired end-to-
  end during the real Jun 23 outage; U-1's watchdog arms on every dubclub boot.
- **Nothing REGRESSED behaviorally.** The one behavioral regression-adjacent item is **H-3(c):**
  `.bak` files multiplied on the box (dubclub gained `storageState.json.bak-20260615`; scraper
  carries `ecosystem.config.js.bak…`) — a drift-trap, not a runtime fault.
- **Loud call-out — the same open items are now compounding live:** U-7 + U-9 + U-11 are the
  three ingredients of the DC-1 multi-day GNP outage happening as this was written. Individually
  P3; together, a live P1. And **M-16a/M-16b, which June rated P3, are re-rated P1 here** under
  this audit's silent-feed-loss rubric — both still open at bot HEAD `19ff594`.

---

## 4. OCR verdict — exposure, contract, and cutover go/no-go

`zonetracker-ocr` had never been audited. Full analysis in `01-ocr.md`; summary:

**Exposure (P3, controlled).** Publicly Funnel-exposed on `:8443`, but auth is the *strongest*
of any satellite: constant-time `hmac.compare_digest`, **fail-closed** when `OCR_SERVICE_TOKEN`
is unset (empty → unconditional 401 with a startup warning), and it runs *before* any body read
— a token-less flood costs only headers+TLS. Internet scanners hit it continuously (all 404).
The one real exposure gap is `/version` (and detailed `/healthz`) being unauthenticated —
scanners already harvested the exact engine/model/uptime fingerprint (OCR-3, P3).

**Contract (sound, no silent-loss path).** `CONTRACT.md` ⇄ `app.py` ⇄ `services/localOcr.js` are
in field-level lockstep; the error taxonomy (200/`ok:false` = healthy-but-unreadable vs non-200
= service-problem) is correctly consumed so input errors can't flap the bot's circuit breaker;
**every** failure mode routes to `FALLBACK_GEMINI` — while vision remains the fallback, an OCR
outage costs latency/money, never a dropped slip. Minor: an 8–10MB dead band (OCR-4) and
`requestId` logged only on exceptions (OCR-6).

**Cutover — service-side go/no-go for `OCR_FIRST_MODE=cutover`:**
- ❌ **NO-GO until OCR-1 fixed** — single-worker blocking inference with no server deadline or
  concurrency cap means any 3-slip burst serializes past the bot's 8s budget → timeouts →
  breaker opens → 60s of pure vision. Cutover self-disables under exactly the load it targets.
- ❌ **NO-GO until shadow data is confirmed flowing and read** — authenticated OCR POSTs appear
  to have stopped Jun 28 14:33 (OCR-9); verify `OCR_FIRST_MODE` on Fly (printenv, not code
  default) and review `ocr_shadow_decision` agreement + `ocr_sgp_would_hold` splits before flip.
- ⚠️ **Before flip:** align size caps (OCR-4) so the 8–10MB band isn't a permanent dead HTTP_4XX
  lane in the metrics; add per-request `requestId` logging (OCR-6) for bot⇄server trace on the
  first disagreement; pin the venv (OCR-8) so the box, once load-bearing, reproduces the
  validated engine on a rebuild; unify the wiring's divergent `SUPPORTED_SPORTS` with
  `canonicalizeSportForGrading` (existing BACKLOG bot#5).
- 📝 **Decide the goal honestly (OCR-10):** as wired, cutover runs vision *then* OCR — a quality
  swap that still pays for Gemini. If cost relief is the driver, the seam order needs redesign
  first.

---

## 5. Quick wins vs structural; open questions; could-not-verify

**Quick wins (S, mostly one-liners, high value):**
1. Re-seed the DubClub session now (stops the live DC-1 outage). *(operational, not a code change — flagged for Smokke.)*
2. `if (!tweetId || (!text && imageUrls.length === 0))` in twitter-handler (SC-2 — closes a total-silent-loss amplifier).
3. `OLLAMA_HOST=127.0.0.1` (HO-1/CT-9 — closes the proxy-secret bypass).
4. `pm2 install pm2-logrotate` (H-1/HO-4/DB-5/SC-14/DC-10 — one command, five findings' log halves).
5. `shutdownBrowser()` in the scraper initBrowser catch (SC-5) and a `runCycleWithDeadline` wrapper (SC-6).
6. Dashboard: per-path recover timeout + classify the proxy's own 502 (DB-1/CT-7 — ends the recover "hammering").
7. Fix the dubclub wall-alert text (U-9) + add an alert cooldown (U-7).

**Structural (M–L, need design/sign-off):**
- Persist-then-ack `ingest_queue` for mobile-ingest (SC-1/CT-1) and a bot-side webhook backfill
  or authenticated dubclub endpoint (CT-2) — the two P1 silent-loss classes that aren't one-liners.
- OCR off-loop inference + concurrency cap + deadline (OCR-1) — the cutover blocker.
- A dashboard-side auth/session or Tailscale ACL for the admin write surface (DB-2).
- Commit the dubclub canonical `.cjs.example` and reconcile box↔repo config drift (HO-5/DC-9).

**Open questions for Smokke:**
- Is the DubClub session meant to auto-refresh (U-11), or is periodic manual re-seed acceptable?
  The current design guarantees a ~2-week silent outage cycle.
- Is `audit_mode` on in prod? If off, split-channel webhook picks skip human review (CT-4) — is
  that intended, or should split webhooks pin `needs_review` like the twitter path?
- Should ZoeLab be live (DC-8)? Emails are arriving; nothing is wired to accept them.
- `@toptierpicks_` has produced nothing since Mar 17 (SC-15) — dormant capper (disable) or silent
  scrape failure (investigate)?

**Could-not-verify (whitelist/rule bounded — see `20-live-probes.md` and each appendix's
UNVERIFIED list; each names the obtaining command):** repo-local `logs/` dir sizes (true log
growth); `pm2 env`↔file↔runtime convergence (H-2 exact); `ollama.service`/`pm2-tracker.service`
unit contents; box `ecosystem.config.js`/`.cjs` restart-policy keys; Fly `OCR_FIRST_MODE` /
`audit_mode` / `GEMMA_FALLBACK_DISABLED` live values; `~/zonetracker` dead-checkout presence;
current `crontab -l`; sshd auth posture; `OLLAMA_PROXY_SECRET` rotation status; external (non-
tailnet) reachability of the Funnels (the scanner traffic in the OCR/proxy logs already proves
it empirically).
