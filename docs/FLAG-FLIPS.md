# Flag-Flip Ledger

Mode flags on `bettracker-discord-bot` are set (or unset) with `fly secrets set`. That command
leaves **no commit, no PR, and no DEPLOY_CHECKLIST trace** — the flag's value lives only in the
running Fly app's env, so a flip is invisible in `git log` and in every review surface. This file
is the missing paper trail: **one line per flip**, newest-first, so a flag's mode history is
reconstructable without SSHing into the container.

**Scope:** the mode flags that gate grader / ingest behavior — the tri-state
`off | shadow | enforce` flags and the boolean kill-switches. Not application config, not
secrets/credentials.

**How to log a flip:** in the same session you run `fly secrets set <FLAG>=<value>`, append a row
to the ledger. If you discover a flip after the fact and can't date it precisely, mark it
`(backfill, approx)` and record what you can.

## Flip ledger

| date | flag | from→to | why | who |
|------|------|---------|-----|-----|
| 2026-07-04 | `SOCCER_PROPS_MODE` | `enforce`→`shadow` | Flip-back for shadow review. The **DNP→VOID sign-off** (Build 1b deviation) was never recorded, so props should not have been enforcing. Investigation this session found **no prop-grade corruption**: all **57** VOID soccer props were auto-void / 7-day-sweeper / retry-exhaustion voids with `grader_version=NULL` — **not** `espn_soccer` grades. The props adapter never settled a live row to VOID. | this session |
| (backfill, approx) | `SOCCER_PROPS_MODE` | `unset`/`shadow`→`enforce` | ≈late June 2026, reason unrecorded — this is the flip the 2026-07-04 row reverted. Predates this ledger; dated and attributed only approximately. | unknown |

## Current mode-flag state

Verified via `fly ssh console -a bettracker-discord-bot -C 'printenv'` against the running **v785**
image, this session (2026-07-04):

| flag | value | effect |
|------|-------|--------|
| `SOCCER_GRADER_MODE` | `enforce` | match-level soccer grades **live** |
| `SOCCER_PROPS_MODE` | `shadow` | soccer player-props emit would-verdicts only — **no** live grade |
| `EVENT_DATE_SLATE` | `shadow` | slate keys off `created_at`; `event_date` is **NOT** consulted for the slate |
| `OCR_FIRST_MODE` | `shadow` | OCR-first is measured, not wired into the live extract path |
| `GEMMA_FALLBACK_DISABLED` | `true` | Gemma vision fallback is **OFF** |
| `AUTOGRADER_DISABLED` | `false` | the autograder cron is **RUNNING** (grading enabled) |

## 2026-07-08 — PIPELINE_IDEM_MODE: (unset) → shadow
PR #189 (v-next). Shadow measures grading-side DROP duplicate rate (expected source: deferRecapMatchToReview re-parks). Review query in PR #189 body. Enforce decision after ~1wk of shadow data.

## 2026-07-08 — RETRY_CAP_ADAPTER_EXEMPT: introduced, NOT yet set (unset = off)
New flag (retry-cap adapter exemption PR — WC-3 residual). Unset/off is byte-identical to today: an
adapter-covered sport at RETRY_CAP=15 still terminally cap-voids. Flip plan: `shadow` first
(`SELECT payload FROM pipeline_events WHERE event_type='retry_cap_adapter_shadow'` shows the
would-defer population), then `enforce` after eyeballing — enforce requeues adapter-covered cap
voids +24h instead (7-day sweeper stays the backstop). Sign-off point: sweeper-exempt PROPS in
adapter sports ride indefinitely at 1 attempt/day under enforce (see BACKLOG WC-3 section).
