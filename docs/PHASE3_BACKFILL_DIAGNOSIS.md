# Phase 3 — event_date backfill recoverability census (DIAGNOSIS, read-only)

**Status:** diagnosis only — NO DB writes, NO code changes were made. This doc measures the
backfill universe, tiers it by recoverability, cross-references the sweep-exempt cohort, confirms
backfill safety against the live code, and recommends a scope. **Recommendation: do _not_ run a
blanket bulk backfill** (rationale in §5).
**Date:** 2026-06-26. **Owner:** Smokke.
**Method:** live read-only prod SQL via `skills/zonetracker-regrade/scripts/run-fly-sql.sh`
(Fly app `bettracker-discord-bot`, `/data/bettracker.db`) + source read of the guard
(`services/eventDate.js`) and every event_date consumer, independently re-derived and
**adversarially verified** by a 7-agent workflow (independent census + 4 claim-refuters + 2 tier
classifications). Live env confirmed via `fly … printenv`:
`EVENT_DATE_SLATE=shadow`, `EVENT_AWARE_RECHECK=shadow`, `DATE_BOUND_GRADING=enforce`,
`SOCCER_GRADER_MODE=enforce`, `SOCCER_PROPS_MODE=enforce`.

> **Source-of-truth note (deviation):** the prompt cited `docs/EVENT_DATE_DIAGNOSIS.md` as a
> read input. That file does **not** exist on `main` or in this checkout — the Phase-0 diagnosis
> was written to a different worktree (`busy-mclean-fbd726`) and never merged. This pass relied on
> the live source (`services/eventDate.js`, `services/sportsdata/index.js`, `services/grading.js`,
> `services/espn.js`, `services/sportsdata/{mlb,nba,nhl}.js`) + `docs/specs/event-date-ingest.md`
> instead, which is canonical anyway.

---

## 0. TL;DR

- The "backfill universe" the prompt frames as ~2822 NULL rows is **not** the actionable set.
  Only **~138 NULL rows are still `pending`** — the rest (2711) are already graded/void, so
  backfilling them is a no-op. **~138 is the real scope.**
- That ~138 is **63% soccer-family** (World Cup 2026 + Soccer + EPL) and **~27% non-gradeable**
  (recaps/standings/promos/rants/vague stubs that should be voided, not dated).
- **A `date(created_at)` backfill is mechanically SAFE but largely INERT.** Under the live flags
  every event_date consumer already falls back to `created_at`, and the dominant soccer cohort
  grades off `created_at` entirely (event_date is never read). The **only** live grade-effect of a
  backfill is flipping `absenceVoidAllowed`→true for MLB/NBA/NHL player props — which unblocks at
  most a handful of DNP-absence cases and is a **false-VOID hazard** on any date-mismatched row.
- **Therefore the prompt's hypothesis is confirmed on safety but refuted on value:** a bulk Tier-1
  backfill does **not** "clear most of the 86 + broad stuck cohort." Those bets are stuck for
  adapter-coverage / human-hold / non-bet reasons, not because event_date is NULL.
- **Recommended:** skip the blanket backfill. Hand-grade/void the sweep-exempt cohort before the
  2026-06-30 deadline, void the ~23 non-bets out of `needs_review`, `/grade override` the 1–5 real
  date-mismatch rows, and treat the spec §9 grader write-back as the durable fix.

---

## 1. The NULL / wrong census (live prod, read-only)

> Two independent snapshots ~5 min apart are shown to convey that the DB is **live and moving**
> (a pending bet graded between them). Use the figures as "≈"; the shape is stable.

| Metric | Snapshot A (11:4x) | Snapshot B (11:50) |
|---|---:|---:|
| Total bets | 2940 | 2940 |
| `event_date` NULL | **2849 (96.9%)** | 2849 |
| `event_date` present | 91 (3.1%) | 91 |
| `created_at` NULL | 0 | 0 |
| **NULL AND `pending`** (the rescuable scope) | **138** | 137 |
| NULL AND non-pending (graded/void — out of scope) | 2711 | 2712 |
| present AND `pending` | 11 | 10 |
| present, **implausible** (gap `< -2d` or `> +60d` vs created_at) | **17** | 17 |
| …of those, still `pending` | **3** | 2 |
| present, cross-year (event vs created year differ) | 17 | 17 |
| `sweep_exempt_until` in the future (any result) | 136 | 136 |
| …future-exempt AND `pending` | 80 | 78 |
| …future-exempt AND `pending` AND NULL event_date | **74** | 73 |

**Premise corrections (the prompt's numbers are stale/over):**
- "~2822 NULL to backfill" → only **~138 are pending** (backfilling graded/void rows changes
  nothing). 96.9% NULL is correct as a coverage figure but **not** the backfill scope.
- "~37 wrong-date rows" → actual **17** (guard bounds) ≡ all 17 are cross-year; only **3** are
  still pending (the rest already finalized, so unfixable-by-backfill). All 17 are `vision_slip`
  rows where the vision model read a real-but-stale year off a back-catalog/throwback slip
  (2001 NCAAM, 2022/2023 World Cup, 2024 Euro/Copa). **These are exactly what the shipped Phase-1
  guard now NULLs for new bets** (gaps −354 … −9131 d, far outside −2/+60).
- "86 sweep-exempt stuck bets" → the live sweep-exempt + pending + NULL cohort is **74** (drifted
  down from the documented 86 as some graded/voided; cf. memory `project_tierc_exemption_extend`).

**Rescuable set (138 NULL+pending) cross-tab:**

| By sport | n | | By source | n | | By review_status | n |
|---|---:|---|---|---:|---|---|---:|
| Soccer | 72 | | twitter_vision | 62 | | **confirmed** | **101** |
| World Cup | 14 | | vision_slip | 45 | | needs_review | 32 |
| MLB | 20 | | twitter | 16 | | manual_review_unmodeled_sport | 5 |
| Tennis | 7 | | twitter_text | 8 | | | |
| Unknown | 6 | | discord | 6 | | | |
| MMA | 5 | | untracked_win | 1 | | | |
| NBA 4, WNBA 3, KBO 2, UFC 2, EPL 1, NHL 1, N/A 1 | | | | | | | |

Soccer + World Cup + EPL = **87 / 138 (63%)** — soccer-family dominates. **37 / 138** are
human-gated (`needs_review` 32 + `manual_review_unmodeled_sport` 5) and will **not** auto-grade
regardless of event_date. Only the **101 confirmed** rows are even in the auto-grade pipeline.

---

## 2. Recoverability tiers of the rescuable set (NULL + pending)

Two independent classifications (one tuned strict-on-non-bets, one strict-on-date-mismatch) were
reconciled. They agree on the shape; the spread is shown.

| Tier | Count | What it is | Backfill verdict |
|---|---:|---|---|
| **Tier 1** — `created_at` IS the event date | **~105–113** | Live-ingested, current-matchup, same-day bets (2026 World Cup soccer + current MLB / NBA Summer-League / WNBA / Tennis / MMA / UFC / KBO). No conflicting date in the description. | `date(created_at)` backfill **safe** (= the grader's existing created_at fallback). |
| **Tier 2** — date in description, `created_at` likely WRONG | **1 firm + ~4 soft** | Firm: `40815408` "FRA @ NOR • **Fri 3:00 PM ET**" ingested on a Thursday → game is **next day** (date(created) off by one). Soft: older back-catalog rows `e196b33b` (Apr15 MLB HR-prop pitcher slate), `b0140947` (May25 Spurs/Thunder), `19c41f5f` (May13 Vegas NHL), `b24aedaf` (Apr19 NBA) — created weeks before "now", worth per-game verification. | Needs per-game resolution; `date(created_at)` would write a **wrong** date. **Higher risk.** |
| **Tier 3** — unrecoverable / not a single-game wager | **~24–29** (of which **~23–24 are non-bets**) | The 12 **"72 World Cup Bets … Draw Record"** draw-recap posts (`dbd35e4e, 335a78fd, ace42928, 3c1d1f96, 455b8efd, 1263c32c, 86913333, 95854a31, 91dc3972, bf409064, e8ba5e17, e4d3e7e3`); 6 standings/"Update"/"Full Recap" posts (`bb06299e, 9e94a322, 276569dc, 4e1a2797, 2d7faa28, d06ac076`); 1 scammer rant (`37146c66`); vague stubs `cac55abf` "over 2.5", `8501fe1a` "UFC winner", `f7c45bf0`/`cb19da6a` "Multiple MLB picks", `1ecbe04f` "$50 to $1,000 Lock Train Bet 1". | Not a backfill problem at all — **void/discard as non-bets** (all sit in `needs_review`, `swx=0`). |

**Key structural fact the tiers expose:** the rescuable set is dominated by (a) current-WC soccer
that grades off `created_at` regardless of event_date, and (b) non-bets. The bets where a populated
event_date would actually *change* a grade are precisely the **Tier-2** rows where event_date ≠
created_at — and those are the ones a `date(created_at)` backfill gets **wrong**.

---

## 3. The sweep-exempt stuck cohort (the "86", now 74)

The live "stuck and shielded" set = `sweep_exempt_until` future AND `pending` AND NULL event_date =
**74 rows, all `review_status='confirmed'`** (i.e. in-pipeline, not held). Cross-referenced to the
tiers:

| Sweep-exempt sport | n | Tier | Helped by a Tier-1 backfill? |
|---|---:|---|---|
| Soccer | 50 | Tier 1 | **No** — `routeSoccer` grades off `getBetDate` (created_at-first, `index.js:203`); event_date never read. |
| MLB | 12 | Tier 1 | **Only the DNP-absence subset** — backfill flips `absenceVoidAllowed`→true (see §4). |
| Tennis | 7 | Tier 1 | **No** — no structured adapter; AI/search path is `event_date \|\| created_at` (inert when equal). |
| MMA 2, EPL 1, World Cup 1, NBA 1 | 5 | Tier 1 | No / NBA same as MLB. |

**Answer to "how much hand-grading does a Tier-1 backfill eliminate?" → essentially none.** Of the
74, ~73–74 are Tier-1 (so *safe* to backfill), but the backfill **unblocks at most the MLB/NBA
DNP-absence subset (≤13 rows, realistically a handful)**. The 60+ soccer/tennis/MMA rows grade off
`created_at` whether or not event_date is set, and stay stuck for adapter-coverage reasons
(1H / ladder / exotic / live markets the soccer adapter can't resolve, and tennis having no
deterministic adapter). **The 2026-06-30 hand-grade-or-void deadline is not relieved by a backfill.**

---

## 4. Backfill-safety check (against the live code)

All four safety claims were adversarially refuted-tested against source. Results:

**(A) Guard-conformance — CONFIRMED.** A backfill writing `event_date := the created_at instant`
as an ISO-8601 UTC datetime (e.g. `2026-06-21T14:15:24.000Z`) has gap = 0 from `created_at`, which
is inside `[EVENT_DATE_GUARD_MIN_GAP_DAYS=-2, MAX=60]` (`eventDate.js:96-130`), so
`applyEventDateSanityGuard` would return it unchanged. **Note:** the guard runs **only** on the
createBet write-path (`database.js:372` → `normalizeEventDateForStorage`); a direct
`UPDATE bets SET event_date=…` **bypasses it entirely** — so the backfill is not re-validated, but
the value is guard-conformant regardless.

**(B) Storage format — store the INSTANT, not date-only (CONFIRMED constraint).**
A date-only `'YYYY-MM-DD'` (= `date(created_at)`) is:
- **Harmless under the current live `EVENT_DATE_SLATE=shadow`** — the real slate uses
  `getBetDate → toYMD` (`index.js:288-302`), a leading-regex `slice(0,10)` that **keeps** the
  correct day; and the other date gates (`grading.js:3143` GUARD-2 `eventDay`, `:3314` Gate-4
  `anchorISO`, `espn.js:424` `dateStr`) all UTC-slice via `toISOString().split('T')[0]` — also
  unaffected.
- **UNSAFE on a future `EVENT_DATE_SLATE=enforce` flip** — `eventEtYMD` does
  `new Date('YYYY-MM-DD')` = **midnight UTC**, then resolves it in `America/New_York` (`etParts`)
  → lands on the **PRIOR ET day** (verified empirically: `eventEtYMD("2026-06-18") = "2026-06-17"`).
  The enforce branch (`index.js:414-421`) then sets `slateYMD` to the wrong (day-earlier) slate
  **and** `absenceVoidAllowed = Boolean(evEt) = true` — the exact pairing that yields a
  **false-absence VOID**.
- **Mitigation:** store the full `created_at` instant as ISO-UTC (`eventEtYMD("…T18:30:00Z")` →
  correct ET day for any afternoon/evening-ET post). A **bulletproof** alternative is an ET-noon
  anchor (`…T16:00:00Z`), immune to the roll in both EST and EDT.
- **Residual:** even the full instant is only "the game day" to the extent `created_at`'s ET day =
  the game's ET day. A late-night / cross-UTC post can still be off by one — but that is the
  *same* ambiguity the existing `created_at` fallback already carries, so the backfill is still
  "at-worst-equal."

**(C)/(D) Inertness — REFUTED as stated, with exactly ONE live exception.**
A created_at-instant backfill is **at-worst-equal (no grade change)** for every event_date consumer
that carries a `created_at` fallback:
- soccer — `getBetDate` created_at-first, event_date never read (`index.js:203`, `routeSoccer`);
- AI grader date GUARDs — `rawEventDate = event_date || created_at` then UTC-sliced
  (`grading.js:3135/3143`); identical when event_date = created_at instant;
- Gate-4 / `DATE_BOUND_GRADING=enforce` anchor — `anchorISO` derives from the same
  `event_date || created_at` (`grading.js:3314`); UTC day == created_at UTC day;
- `buildGraderSearchQuery` (`grading.js:2098`, `event_date || created_at`);
- `espn.js:421` (`event_date || created_at`, with a `prevDate` fallback);
- `nextAttemptForEvent` / sweeper-defer — `EVENT_AWARE_RECHECK=shadow`, so the enforce-gated paths
  (`grading.js:1739`) are telemetry-only and do not change scheduling.

**The one exception (the universal-inertness claim was correctly refuted):** under
`EVENT_DATE_SLATE=shadow` the slate still computes
`absenceVoidAllowed = Boolean(eventYMD && createdYMD === eventYMD)` (`index.js:430`). NULL event_date
→ `false`; a created_at-instant backfill → `eventYMD == createdYMD` → **`true`**. For the MLB/NBA/NHL
**structured player-prop** path (`index.js:465-478`) this **enables the provable-absence / DNP VOID**
(`mlb.js:567`, `nba.js:422,442`, `nhl.js:402`) — a bet that today search-grades or stays PENDING
becomes a **terminal VOID** on its next cycle. This is **correct for a same-day (Tier-1)** bet and a
**false-VOID hazard for a date-mismatched (Tier-2)** bet. No additional enforced consumer reads
event_date without a created_at fallback (claim D survives). (The whole result assumes prod runs in
UTC, which Fly does; storing the backfill in `created_at`'s own space-separated no-Z format would
neutralize even that latent TZ-parse concern.)

**Re-arm / next-cycle behavior (prompt §4):** the 138 are already in the pipeline
(`grading_state` `backoff`/`ready`, polled on schedule). A backfill is a bare `UPDATE` that does not
touch `grading_state`, `grading_next_attempt_at`, or `sweep_exempt_until`, so **no re-arm is
needed** — but there is also **no auto-grade windfall**: backfilled bets keep failing for the same
non-date reasons, *except* the MLB/NBA/NHL DNP-absence subset, which would VOID on its next poll.

---

## 5. Findings & recommended scope

**Hypothesis under test:** *"Tier 1 = automated guarded bulk backfill (event_date := date(created_at),
safe, clears most of the 86 + broad stuck cohort); Tier 2 = case-by-case via /grade override, NOT
bulk; Tier 3 = leave null / hand-void."*

**Verdict: confirm the safety + the Tier-2/Tier-3 handling; REFUTE the Tier-1 value claim.**
- ✅ Tier-1 backfill is *safe* — but **must store the created_at INSTANT (ISO-UTC), not a date-only
  string** (§4B), and it is **largely inert** (§4C/D): it does **not** "clear most of the cohort."
  The stuck cohort is stuck for adapter-coverage / human-hold / non-bet reasons, not NULL event_date.
- ✅ Tier-2 → `/grade override` per-bet, not bulk — confirmed (and the set is tiny: 1 firm + ~4 soft).
- ⚠️ Tier-3 → not merely "leave null": **~23–24 are non-bets** that should be **voided/discarded**
  out of `needs_review` (recaps/standings/promos/rants/vague stubs), independent of event_date.

**Recommendation — do NOT run a blanket bulk Tier-1 backfill.** Under the live shadow config it
re-encodes `created_at` into `event_date`, buys essentially zero unblocks, and introduces a
(small) false-VOID risk via the `absenceVoidAllowed` flip on any misclassified Tier-2 row. The
juice is not worth the squeeze.

**If a backfill is run anyway** (only justified as pre-staging for a future
`EVENT_DATE_SLATE=enforce` flip), scope and format it tightly:
1. `event_date := created_at` rendered as a **full ISO-UTC instant** (or ET-noon anchor) — never
   date-only.
2. Restrict to `review_status='confirmed' AND result='pending' AND sport ∈ {MLB,NBA,NHL}` (the only
   sports where event_date is actually consumed for a structured VOID), and **spot-verify** the
   handful of older back-catalog rows first to exclude Tier-2 misfires.
3. Recognize this still yields almost nothing today and supplies a created_at *echo*, not a real
   game date.

**The real levers (independent of backfill):**
- **Hand-grade / void the 74 sweep-exempt stuck bets before 2026-06-30** — a backfill does not
  relieve this. Most are soccer/tennis the adapters can't resolve.
- **Void / discard the ~23–24 non-bets** out of `needs_review` (the "72 World Cup Bets" recap
  family, standings/"Update"/"Full Recap" posts, the rant, and vague stubs).
- **`/grade override` the 1–5 genuine Tier-2 date-mismatch rows** (e.g. `40815408` "Fri 3:00 PM ET").
- **Durable fix = spec §9 grader write-back:** when a structured adapter resolves a leg's game, write
  that game's *authoritative* date back to `event_date`. This is the correct mechanism for the
  spec's "(B) backfill" — it supplies a real game date (deterministic, no created_at echo, no OCR
  risk) and is the only thing that makes a future `EVENT_DATE_SLATE=enforce` flip pay off on the
  night-before / back-to-back (Tier-2) cases that motivated the whole event_date effort.
- Already shipped — Phases **1** (write-time sanity guard, #153/#154) and **2** (ingest extraction,
  #154) — stop the bleed of new NULL/wrong-date rows, so the backlog is bounded and shrinking.

— END (diagnosis only; no writes, no code) —
