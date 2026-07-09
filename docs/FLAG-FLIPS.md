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
would-defer population — emitted only when the void actually lands, so it exactly matches what
enforce would defer), then `enforce` after eyeballing. Enforce requeues adapter-covered cap voids
+24h, BOUNDED by an attempts ceiling (19 = RETRY_CAP+4): at the ceiling the cap void fires as
today. The ceiling is the terminal guarantee — the cap's pending-legs-parlay population is
un-sweepable (the sweeper's own terminal write is denied `pending_legs` by the same gate), so an
unbounded deferral would create immortal bets. Net effect of enforce: ~4 extra daily re-picks for
the adapter/per-leg grader before the same void (see BACKLOG WC-3 section).

## 2026-07-08 — RETRY_CAP_ADAPTER_EXEMPT: (unset) → shadow
PR #193. Shadow measures would-defer population (retry_cap_adapter_shadow events) for adapter-covered bets at the retry cap. Ceiling 19 (< quarantine 20). Enforce decision after reviewing shadow volume.

## 2026-07-08 — REAPER_MODE: introduced, NOT yet set (unset = off)
New flag (Stage 2 reaper PR). Unset/off is byte-identical to post-#193 behavior: the three
exhaustion writers (retry-cap void, no-data void, unscoped-sport void) still terminally VOID, and
the zombie sweep runs nothing. Flip plan: `shadow` first
(`SELECT payload FROM pipeline_events WHERE event_type='reaper_shadow'` shows the would-route
population — writer/sport/attempts per row; the three writers emit only when their void actually
lands, so those rows exactly match what enforce would route; zombie_sweep rows are the quarantined
no-exit backlog), then `enforce` after eyeballing volume against the review queue's capacity
(baselines: GRADE_BACKOFF_EXHAUSTED ~3/day per COA 2026-06-10; unscoped+no-data 54/day on
2026-06-10 PRE-Build-1d/#110-#113 — expect far lower now, shadow will give the real number).
Enforce parks exhausted bets in review_status='needs_review' (result stays pending, no
grade/profit) with one GRADE_EXHAUSTED_{ADAPTER|NO_SOURCE}_REVIEW drop each — void becomes
operator-only on those paths (WC-3 policy). #191 grace + #193 deferral run first, unchanged.

## 2026-07-08 — REAPER_MODE: (unset) → shadow
PR #194. Shadow measures would-route population (reaper_shadow events; dedupe zombie_sweep rows by bet — they re-emit per cycle) across the 3 exhaustion writers + quarantine zombie sweep. Enforce decision after volume review. Note: the event_settling sweep-hold (EVENT_AWARE_RECHECK unblock) is gated on REAPER_MODE=enforce — the EVENT_AWARE enforce flip chain is now: REAPER shadow review → REAPER enforce → EVENT_AWARE enforce.

## 2026-07-08 — EVENT_DATE_SANITY_MODE: introduced, NOT yet set (unset = off)
New flag (event_date population PR). ⚠️ ATYPICAL semantics — this flag gates TELEMETRY ONLY: the
write-gate sanity guard itself (NULL an extracted event_date outside −2d..+60d of created_at,
`services/eventDate.js`) shipped ALWAYS-ON in #153/#154 and is live prod behavior. Unset/off is
byte-identical to today: guard NULLs + warn-logs, no pipeline event. `shadow` additionally emits one
`event_date_sanity_rejected` pipeline_events row per rejection carrying the rejected value, gap-days,
and the raw extractor string — the queryable reject trail the ephemeral Fly warn log is not
(review: `SELECT payload FROM pipeline_events WHERE event_type='event_date_sanity_rejected'`).
`enforce` ≡ shadow today (enforcement pre-dates the flag; the third state keeps the ladder uniform).
Flip plan: `shadow` after deploy → review reject volume/shape (expect near-zero: the ingest paths
now instruct verbatim-copy-never-guess, and the guard is the backstop) → optionally `enforce` for
ledger cleanliness; the bounds are tuned from the reject rows if legitimate futures ever clip.
