> Track analysis produced by a read-only audit subagent from pinned clones + probe captures;
> reviewed, spot-verified (high-severity evidence lines re-read by the orchestrator), and filed
> by the audit orchestrator. Probe references (P-n, probes/*.txt) resolve to 20-live-probes.md.

# T4 — zonetracker-dashboard (@d392754; box runs same SHA, clean)

## Findings

### DB-1 — Recover proxy timeout (15s) is misclassified as "Discord message unreachable — Try again", inducing the hold-recover hammering; root cause of BACKLOG "Recover-loop noise"
- **ID:** DB-1 · **Severity:** P2 · **Confidence:** high
- **Evidence:**
  - dashboard@d392754 `server.js:54` `UPSTREAM_TIMEOUT_MS = 15_000` applies to EVERY relayed request (`server.js:103` `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`), including `POST /holds/:id/recover`.
  - On timeout the proxy returns its OWN 502: `server.js:106-108` → `{ error: 'Bad Gateway', detail: 'Upstream timed out.' }` — a body with **no `status` key**.
  - dashboard `public/app.js:342-359` `classifyRecover`: with no status string, falls to `httpStatus === 502 → 'unreachable'` (`app.js:355`) — indistinguishable from the bot's genuine `message_unreachable` 502. UI then shows **"Discord message unreachable — not recovered. Try again."** (`app.js:396-398`); bulk chip renders red `unreachable` (`app.js:502-515`).
  - Bot-side recover is routinely slower than 15s: `services/holdReview.js` (bot@19ff594) runs Discord fetch with retry backoff (`:218-219` `FETCH_MAX_ATTEMPTS=3`, backoff `[500,1500]`ms) **plus the full vision_slip extraction** (`:526-544`). Probe `probes/tails-pm2-logs.txt` (dashboard-error-4.log) shows 76 `POST .../recover -> ERROR` lines (75 TimeoutError + 1 TypeError), same id up to ×7 (`disc_1510607698473914429`), while out-4.log shows other recovers completing 200/422 — i.e. slow-but-working upstream, not a dead one.
  - The aborted proxy fetch does **not** abort the bot: the recover runs to completion server-side (nothing in `routes/adminCommands.js:118-147` watches request close), so the operator is told to retry work that is still running or already done.
  - No automatic retry exists dashboard-side (verified every fetch call site in `app.js`: `fetchJSON`, `dismissHold`, `recoverHold`, `performBulkCall`, `setHandleEnabled`, `approveBet`, `loadMeta` — none retry; bulk runs each id once, `app.js:766-790`). The "no backoff hammering" is therefore the **operator retry loop the UI itself instructs** ("Try again"), single-row and re-selected bulk runs — not a runaway poller.
  - The `GET /holds → TypeError` (×2) and one `POST recover → TypeError` in the same log are the **contained** undici network-failure path: `server.js:105-108` catches non-timeout fetch failures (undici wraps them in `TypeError: fetch failed`), logs `ERROR (TypeError)`, returns 502 JSON. Post-D-1-fix this is not a crash class; reproducible by interrupting connectivity mid-request. BACKLOG's open question is answerable: no dashboard bug beyond the misclassification above.
  - Timing note: error-4.log mtime Jun 25 (probes/logs-disk.txt:5) — the hammering incident predates the Jun 29 reboot; recover timeouts still occur but at lower volume.
- **Impact:** operator-deception (wrong diagnosis + explicit retry instruction), wasted retries against in-flight recovers, and repeated vision-burning attempts when the slow attempt ultimately fails bot-side (`no_bet_found`/`validator_drop` each increment the RECOVERY_RETRY_CAP=5 counter, `holdReview.js:410,543,562-566`). One mitigating design point: retries that end `message_unreachable`/`no_image_yet` cost no quota and don't count toward the cap (`holdReview.js:399-409` comment), which is why a single id could accumulate 7 timeouts without exhausting.
- **Proposed fix:** (a) per-path timeout: give the recover POST its own budget (60–120s) instead of the blanket 15s; (b) make the classifier distinguish the proxy's own 502 (its body carries `detail: 'Upstream timed out.'` and no `status`) from the bot's `message_unreachable`, and render "Recover still running upstream — refresh in a minute" instead of "Try again"; (c) optionally bot-side: respond 202-accepted early for recover. (a)+(b) are dashboard-only.
- **Effort:** S (dashboard-only a+b) · **BACKLOG mapping:** roots docs/BACKLOG.md:229-230 "Recover-loop noise — repeated hold-recover timeouts with no backoff" (symptom entry; this closes its three open questions: caller = operator/bulk retry loop induced by the UI, backoff absent because retries are human, TypeError = contained undici network failure).

### DB-2 — Any tailnet device reaching :8444 gets all four admin writes with no further auth (dismiss is unrecoverable)
- **ID:** DB-2 · **Severity:** P2 (posture; not public) · **Confidence:** high (facts) / low (threat likelihood)
- **Evidence:** dashboard has **no auth layer of its own** — protection is `HOST='127.0.0.1'` (`server.js:30`, hardcoded) + `tailscale serve` tailnet-only on :8444 (probes/exposure.txt:3,33-34,42-43 — serve, NOT funnel). The proxy injects the bearer server-side for **every** request it relays (`server.js:90-95`), so any browser on the tailnet can: `POST /holds/:id/dismiss` (permanent — dismissed holds are unrecoverable, ~42% of image holds historically contained real bets, per the dashboard's own modal warning `app.js:843`), `POST /holds/:id/recover` (burns vision quota), `POST /handles/:handle` (silence/enable scraper feeds), `POST /bets/:id/approve` (release bets to grading), plus read everything (`/bets`, `/holds`, `/logs` = admin-log channel tail, and the Phase A reads). `/healthz` + `/api/meta` are also unauthenticated (`server.js:60-61`; meta discloses the upstream bot URL — trivial).
- **Impact:** the effective admin boundary is "possession of any device on the tailnet", not "possession of the ADMIN_API_SECRET". A shared/expired-key/compromised tailnet node can silently destroy the hold queue or approve bets. Bearer auth being bot-side only is fine for the internet; the tailnet hop has zero authn/authz granularity.
- **Assessment:** acceptable **only** while the tailnet is strictly single-operator. Escalation trigger: if :8444 is ever funneled (one flag away — the box already funnels :443/:8443) this becomes a P0 public mutating surface with no auth. Cheap hardening: Tailscale ACL restricting :8444 to the owner's devices (host-side, S), or a dashboard-side session token.
- **Effort:** S (ACL) / M (dashboard login) · **BACKLOG mapping:** June audit D-2 restated the posture accurately; the ASSESSMENT of the grown write surface (4 writes vs 1 at D-2 time) is NEW.

### DB-3 — `in_flight` recover status unhandled: dashboard reports "Already resolved — can't recover" for a recovery that is actively running
- **ID:** DB-3 · **Severity:** P3 · **Confidence:** high
- **Evidence:** bot returns `{ ok:false, status:'in_flight' }` with HTTP 409 when the same ingest is already being recovered (`services/holdReview.js:448-459` in-flight set; `routes/adminCommands.js:106` `in_flight: 409`). Dashboard `classifyRecover` (`app.js:342-359`) has **no `in_flight` branch**; the status string misses, so `httpStatus === 409 → 'already_resolved'` (`app.js:353`) → UI shows "Already resolved — can't recover. Refreshing…" (`app.js:365`, red) and the hold visibly persists after refresh.
- **Impact:** compounds DB-1 directly: proxy times out at 15s → operator retries per the UI's instruction → bot answers `in_flight` → UI now claims the hold is *resolved* while it is mid-recovery. Two contradictory lies about one hold in two clicks. Non-destructive (never dismisses/creates anything).
- **Proposed fix:** add `if (s === 'in_flight') return 'in_flight'` + message "Recovery already running — refresh shortly" (and a chip label). The bot-side comment (`adminCommands.js:27-30`) even predicted unknown statuses would fall through "back-compatibly" — true, but the 409 fallback picks the wrong label rather than a neutral one.
- **Effort:** S · **BACKLOG mapping:** NEW (D-3-class contract drift; first status-enum drift since the June "no drift" verdict — introduced when bot recover gained the in-flight guard).

### DB-4 — D-6 still open at HEAD: upstream-supplied strings rendered as `href` verbatim (no scheme check); surface grew with the #9 slip-link
- **ID:** DB-4 · **Severity:** P3 · **Confidence:** high (code) / low (exploitability)
- **Evidence:** `app.js:92-100` `discordUrl(row)` returns `String(direct)` from the first of `message_link/jump_url/message_url/messageUrl/url/link` with **no URL-parse or scheme allowlist**; rendered as `href` at `app.js:110` (jump link), `:119` (message-id link), and — new since June — `:1158-1161` (the #9 slip thumbnail's wrapping `<a class="slip-link">`). `el()` sets it via `setAttribute` (`app.js:22`), so a `javascript:` value would execute on click. No `safeHttpUrl()` anywhere (grep). Mitigations verified: all *messageUrl* writes bot-side are Discord-generated `message.url` (`handlers/messageHandler.js:1250-1407`), so exploitation requires attacker-controlled data reaching a `*url*` key of an API row — not currently reachable from tweet content. The **imageUrl** `<img src>` (attacker-influenceable per the code's own comment, `app.js:1149-1150`) is a lesser vector: `javascript:` is inert in `img src`; residual risk is hotlink tracking of operator IP/UA, partially mitigated by `referrerpolicy: no-referrer` (`app.js:1156`).
- **Impact:** latent one-click XSS behind a data-integrity assumption about the bot DB; the dashboard's origin holds no secrets (bearer is server-side) but scripts there can drive all four writes.
- **Proposed fix:** the June-audit D-6 patch as written — `safeHttpUrl()` (URL-parse, http/https only) around `discordUrl`'s return and `holdImageSrc`.
- **Effort:** S · **BACKLOG mapping:** June audit D-6, unfixed; surface enlarged by dashboard #9.

### DB-5 — D-4/H-1 still open: every proxied request logged, no timestamps, no rotation — and it already cost incident forensics
- **ID:** DB-5 · **Severity:** P3 · **Confidence:** high
- **Evidence:** `server.js:126` logs `[proxy] METHOD url -> status` for **every** relayed request (not gated `status >= 400`); error variants `:107`/`:123` via `console.error`. No timestamps: plain `console.log`, and `ecosystem.config.js:6-23` still has no `log_date_format`/`merge_logs`. Rotation still absent host-wide: `~/.pm2/modules` EMPTY (probes/logs-disk.txt:11, SHARED capture). Live confirmation of the cost: the DB-1 hammering incident in `dashboard-error-4.log` is **undatable from content** — the only dating evidence was file mtime Jun 25. Volume itself is currently modest (out-4.log 59K, probes/logs-disk.txt:6) because auto-poll is opt-in (`app.js:9` `POLL_MS=30_000`; checkboxes default unchecked, `index.html:32/65/75/85`); worst case (4 panels polling) is still the June estimate ≈11.5K lines/day, unbounded.
- **Impact:** reliability/ops — incidents can't be timelined; disk growth unbounded in principle.
- **Proposed fix:** June D-4 verbatim: `pm2 install pm2-logrotate` (+size/retain/compress), add `log_date_format` (+`exp_backoff_restart_delay`, H-2) to ecosystem.config.js, and/or gate the success line on `status >= 400`. Timestamps are the part DB-1 proved matters.
- **Effort:** S · **BACKLOG mapping:** June audit D-4 + H-1, unfixed.

### DB-6 — Visible UI header still claims "Read-only dashboard" while shipping four writes (D-3 remnant)
- **ID:** DB-6 · **Severity:** P3 · **Confidence:** high
- **Evidence:** `public/index.html:18` `<p>Read-only dashboard · …</p>`. The code comments were correctly updated to "FOUR narrowly-allowed writes" (`server.js:10-15`, `app.js:3-6`), but the operator-facing label was not — the exact sub-item June's D-3 called out (`index.html` "visible UI label") with the suggested text "Admin dashboard (read-mostly)".
- **Impact:** operator-deception-lite: the header asserts a safety property (read-only) the page no longer has; dismiss is destructive.
- **Proposed fix:** change the label per D-3.
- **Effort:** S · **BACKLOG mapping:** June audit D-3, partially fixed (comments yes, UI label no).

### DB-7 — Test gaps unchanged: no path-escape test (D-8) and the D-2 mount-order pinning test was never added
- **ID:** DB-7 · **Severity:** P3 · **Confidence:** high
- **Evidence:** 114 tests across 4 files at HEAD (proxy 72, app-bulk 21, app-logic 18, upstream-midbody 3) — none exercises the path-escape guard (`server.js:141-149`; needs the raw-socket `%2e%2e` test D-8 specified, since fetch normalizes dot-segments client-side) and none pins the proxy-before-static mount order (`server.js:137` vs `:197`; D-2's proposed `app.router.stack` order assert — grep of `test/*.js` finds no reference to `express.static`/`public`/mount order). The invariant currently holds by inspection; nothing stops a refactor from silently mounting static first.
- **Impact:** the two properties the June audit called compensating controls for the no-auth design are unpinned.
- **Proposed fix:** add both tests as specified in the June audit.
- **Effort:** S · **BACKLOG mapping:** June audit D-8 + D-2 follow-up, unfixed.

### DB-8 — D-5 still open: Pico CSS from jsdelivr floating `@2` tag, no SRI
- **ID:** DB-8 · **Severity:** P3 · **Confidence:** high
- **Evidence:** `public/index.html:7-10` loads `https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css` — floating major tag, no `integrity` attribute. Stylesheet only (CSS injection, not script, on CDN compromise); offline/tailnet-without-internet = unstyled UI.
- **Impact:** availability/appearance + minor supply-chain surface.
- **Proposed fix:** vendor `public/pico.min.css` per D-5.
- **Effort:** S · **BACKLOG mapping:** June audit D-5, unfixed.

### DB-9 — 400-class upstream responses surfaced as "Server error (400)" in the dismiss/approve classifiers
- **ID:** DB-9 · **Severity:** P3 · **Confidence:** high
- **Evidence:** `classifyDismiss` (`app.js:245-255`) and `classifyApprove` (`app.js:1047-1056`) map anything not 404/409/5xx/2xx to `'error'`, and the shared error message template prints "Server error (${res.status})" (`app.js:314`, `:1087`) — so a bot 400 `malformed` renders as "Server error (400)". `classifyRecover` has the same fall-through. Unreachable via the UI today (ids are always non-empty and URL-encoded), so cosmetic.
- **Impact:** mislabeled diagnosis if a malformed request ever occurs (e.g. future manual URL use).
- **Proposed fix:** classify 400 as `malformed` with a distinct message, or drop the word "Server".
- **Effort:** S · **BACKLOG mapping:** NEW (cosmetic).

## Write-path contract table (dashboard ⇄ bot)

Exactly **four** write paths at HEAD — #6 bulk Recover/Dismiss is NOT a fifth: it strictly re-issues the two per-hold POSTs sequentially with pacing (`app.js:747-790`, 1s recover / 250ms dismiss), no new endpoint, no concurrency. Proxy allowlist regexes: `server.js:74-77`; every other non-GET → 405 before body parsing (`server.js:155-165`).

| # | Dashboard sends | Proxy transform (server.js) | Bot handler @19ff594 → statuses | Dashboard classification (app.js) | Drift |
|---|---|---|---|---|---|
| 1 | `POST /holds/:ingestId/dismiss`, no body (`app.js:300-304`) | forwards POST, strips any body, injects bearer (`:191-193`) | `handleDismissRoute` (`adminCommands.js:72-96`): `dismissed` 200 / `already_dismissed` 200 / `already_released` 409 / `not_found` 404 / `malformed` 400 / `error` 500; actor defaults `'dashboard'` | `classifyDismiss` (`:245-255`): all strings + 404→stale, 409→already_released | none material; 400→"Server error (400)" (DB-9); proxy-timeout 502→'error' "not dismissed" could rarely be wrong if the dismiss landed (dismiss is a fast DB write — low risk) |
| 2 | `POST /holds/:ingestId/recover`, no body — **never sends `force`**, so the RECOVERY_RETRY_CAP bypass is unreachable from the dashboard (good; `adminCommands.js:126-131` requires literal `true`/`1`) | same as dismiss | `handleRecoverRoute` (`adminCommands.js:118-147`): `recovered` 200 / `already_recovered` 200 / `already_resolved` 409 / **`in_flight` 409** / `not_found` 404 / `no_image_yet` 422 / `no_bet_found` 422 / `validator_drop` 422 / `recovery_exhausted` 429 / `message_unreachable` 502 / `malformed` 400 / `error` 500 | `classifyRecover` (`:342-359`): all strings EXCEPT `in_flight`; 404→stale, 409→already_resolved, 429→recovery_exhausted, 502→unreachable | **two real drifts**: `in_flight` → mislabeled "Already resolved" (DB-3); proxy's own timeout-502 → mislabeled "message unreachable / Try again" (DB-1). `recovery_exhausted` message "needs a bot-side force" (`:409`) is accurate |
| 3 | `POST /handles/:handle` `{enabled: 0\|1}` (`app.js:976-980`; UI never sends `note`) | parses ≤8kb JSON AFTER the gate, forwards ONLY rebuilt `{enabled, note?}` — unknown fields stripped (`:173-189`) | `handleSetHandleRoute` (`adminCommands.js:162-206`): `updated` 200 (returns fresh row under `handle`) / `not_found` 404 / `malformed` 400 / `error` 500; COALESCE keeps note when omitted; never inserts | `res.ok` → in-place update from `data.handle` (`:995-998`); failures via `describeHandleError` (`:947-955`) map 404/not_found and 400/malformed correctly, revert the switch | none |
| 4 | `POST /bets/:id/approve`, no body (`app.js:1074-1078`) | forwards POST, strips body, injects bearer | `handleApproveRoute` (`adminCommands.js:220-249`): `approved` 200 / `not_approvable` 409 (approveBet returned null — missing/confirmed/terminal; **never 404s**) / `malformed` 400 / `error` 500; reuses atomic `approveBet` (services/database.js gated UPDATE) | `classifyApprove` (`:1047-1056`): approved / not_approvable / 404→stale (dead branch — harmless) / 409→not_approvable | none material; 400 mislabel (DB-9). Live out-log confirms idempotency held under double-fire: repeat approve of same id → 409 (probes/tails-pm2-logs.txt) |

**Reads consumed by UI at HEAD:** `/holds`, `/bets` (+ the exact 6 filter keys the bot recognizes — `BETS_FILTER_KEYS` `app.js:1184` ≡ `routes/admin.js:293`, incl. `needsReview=true`), `/handles`, `/logs` (`{count, channelId, messages}` shape matched). **Phase A** (`/leaderboard`, `/drops`, `/grader-health`): **no UI exists at HEAD** — `PANELS` (`app.js:1186-1272`) defines only holds/bets/handles/log. The 200s in out-4.log were manual testing riding the proxy's generic GET forwarding (`server.js:192` — any GET under /api/admin relays). Added poll volume from Phase A today: **zero**; when tabs ship, each opted-in panel adds 1 request + 1 log line per 30s.

## Auth posture verdict

**Bind:** cannot regress to 0.0.0.0 — `HOST` is a hardcoded const `'127.0.0.1'` (`server.js:30`), not env-read; setting `HOST` in the environment does nothing. `PORT` is env-read with garbage falling back to 8787 (`:31`). Fail-closed startup: missing `ADMIN_API_SECRET` or bad `FLY_BOT_URL` → `process.exit(1)` (`:37-52`). `.env.example` names exactly the three vars server.js reads (PORT, FLY_BOT_URL, ADMIN_API_SECRET).

**Exposure:** loopback :8787 + tailnet-only `tailscale serve` :8444 (probes/exposure.txt:3,9,33-34) — NOT funneled. Proxy-before-static order holds at HEAD (`server.js:137` vs `:197`) but is untested (DB-7).

**Bearer:** injected server-side only (`server.js:92`); client headers never forwarded, upstream headers never copied, so the secret cannot appear in any response (asserted by proxy.test.js:116-123). Bot-side enforcement verified at 19ff594: read router router-wide `router.use(adminAuth)` (`routes/admin.js:40`), write router per-route (`routes/adminCommands.js:96,147,208,249`); `adminAuth` is fail-closed 503 on unset secret, timing-safe compare, never logs the token (`routes/adminAuth.js:30-53`); write router mounted BEFORE the read router's catch-all 404 (`bot.js:21-28`).

**Verdict:** internet-facing posture is sound (both sides verified). The tailnet hop is the soft spot: any tailnet device = full 4-write admin with no further auth (DB-2); the compensating controls (loopback bind, mount order) are real but the latter is unpinned by tests. One flag (`funnel` instead of `serve`) separates this from a P0.

## Looked good

- **D-1 fixed and regression-tested:** the mid-body body-read guard is in `relayUpstream` (`server.js:117-125`) and `test/upstream-midbody.test.js` reproduces the original crash in a child process (spawn + socket-destroy mid-body, asserts liveness + 502). Box runs this SHA.
- **Proxy write allowlist discipline:** anchored exact-path regexes, method/path gate BEFORE any body parsing (malformed JSON on a disallowed write stays a clean 405 — tested), no wildcard POST forwarding, handle-toggle body rebuilt to `{enabled, note?}` only, dismiss/recover/approve bodies stripped. 72 proxy tests including %2F-single-segment and gate-before-parse cases.
- **XSS text discipline held:** all text rendering via `createTextNode`/`textContent` (`app.js:25,107,186-189`); zero `innerHTML`/`insertAdjacentHTML`/`document.write` in app.js (grep). The only gap is the href/src attribute scheme check (DB-4).
- **Dashboard can never bypass the recover retry cap:** it sends no body, and the bot requires literal `force:true|1` — the "pollers must never send it" contract is structurally enforced from this client.
- **Bulk UX safety engineering:** strictly sequential paced calls, per-row outcome chips, stop-after-current, refresh paused mid-batch with a post-await re-check (`app.js:1320-1345`), selection pruned to visible rows and dropped on failed loads (bias-safe), and the bulk-dismiss modal with explicit "I understand" gate + per-hold recover-history disclosure honestly labelled session-scoped.
- **No automatic non-2xx retry anywhere** — every retry is operator-initiated; auto-poll is opt-in per panel.
- **Approve/dismiss idempotency confirmed live:** double-fired approves resolved 200-then-409 with no double effect (out-4.log).
- **Filter contract exact:** dashboard sends only the 6 filter keys the bot echoes; `needs_review` read via `review_status` enum (the #8 fix) matches `approveBet`'s gate.
