# 2026-07-03 — Pre-gate Tier B: same-opponent-series disambiguation (snowflake-hour pin, read-only)

**What:** the **8** same-opponent-series rows that the Tier B day-level re-anchor
([`docs/audits/2026-07-03-pregate-tierb-reanchor.md`](2026-07-03-pregate-tierb-reanchor.md))
could **not** anchor by ET slate *day* alone were re-examined at **minute** resolution.
Each row names a team that played the **same opponent** twice-or-thrice inside a 1–3-day
playoff series with the **opposite** grade, so the day-pin (which lands on the snowflake ET
day) disambiguates only in aggregate — for any single row the intended series game is unproven.
This pass recovers the true tweet-post instant from the X/Twitter snowflake id and pins the
intended game by the **pre-game-post model**: cappers post *before* the game, so the intended
game is the **earliest same-opponent game whose scheduled start is after the post**, provided
that lead is plausible (≤24h) and unambiguous.

Engine: [`scripts/tierb-series-disambiguation.js`](../../scripts/tierb-series-disambiguation.js)
— reuses the grade engine (`espn.parseBetDescription` / `gradeFromScore` / `teamMatches`) and
the alias tables from [`scripts/shadow-regrade-pregate.js`](../../scripts/shadow-regrade-pregate.js)
verbatim; the throttled+cached fetch wrapper, ET-slate date helpers, `extractTeams`, and
`suggestedPu` are copied verbatim from that engine; the snowflake constants + `statusId` /
`snowflakeMs` are copied verbatim from [`scripts/tierb-reanchor.js`](../../scripts/tierb-reanchor.js).
The **only** new code is the per-candidate scheduled-**start** fetch (`candidateGames` returns
finals but not start times) and the pin rule. It computes no grades of its own beyond the
verbatim engine call, writes nothing to the DB, and ships no correction script.

> **REPORT ONLY.** Corrections are a **separate operator-gated pass after per-game external
> verification** — each pinned game below must be independently re-verified against the public
> score API before any DB write. This document proposes nothing to the database and ships no
> apply script. The pinned-disagree rows are *candidates*, not corrections.

## The pin rule (minute resolution)

`post_ms = (tweet_id >> 22) + 1288834974657` (BigInt; ids exceed 2⁵³) → the true post instant.
Over the same-opponent series candidates in a **±3-day window** around the snowflake ET day,
sorted by scheduled start:

- **PIN** the earliest game whose start is **after** the post **and** within **24h** of it, if
  it is the *only* such game.
- **UNRESOLVED(`post_after_all_series_starts`)** — the post is after every same-opponent start
  (a post-game / in-game / recap post; nothing to pin pre-game).
- **UNRESOLVED(`next_start_gt_24h`)** — the nearest same-opponent game after the post starts
  **>24h** later (implausibly early to be a pre-game post for it; the same-day game already
  started).
- **UNRESOLVED(`ambiguous_two_within_24h`)** — two same-opponent games both start within 24h
  after the post.

**Same-opponent scope:** for a single-team bet the series is the games against the opponent the
team faced on the **snowflake day** (the game the day-pin would land on); for a two-team matchup
the series is games containing both named teams. UNRESOLVED is **not** a refutation of the
day-pin — it means the post *instant alone* cannot disambiguate the row, which therefore **stays
pending** for richer external verification (tweet text / screenshot / capper grading history).

## Controls

| control | result |
|---|---|
| **post-time parity** — snowflake ET post day vs the audit's day-pin snowflake date, all 8 rows | **8 / 8 identical** (same ET convention as the re-anchor) |
| **engine grade parity** — the 4 pinned games graded by the verbatim engine | **4 / 4** reproduce the audit's per-game verdict |
| **adversarial re-derivation** — 8 independent verifiers each re-fetched the public API from scratch (own snowflake math, own series enumeration, own pin + grade), refute-by-default | **8 / 8 confirm**, high confidence, **0 refutations** (post time matched to the minute on all 8) |

The adversarial pass independently surfaced two facts that do **not** change any verdict: the
MTL–CAR series ran to a **game 5** on 05-25 (outside the ±3 window and >24h from the post), and
the LAA–CIN series had **three** games (04-10/04-11/04-12) — all before the `2c12a667` post. Both
are already handled by the engine's window + pin (see per-row notes).

## Per-row disambiguation (all 8)

Post = true tweet-post instant (ET). "start" = scheduled first pitch / puck drop / tip (ET).
`h` = hours from post to that start (negative = the game had already started when the post went out).

| id | sport / market | pick | post (ET) | same-opponent series candidates (start ET, h from post → grade) | pin | engine verdict | stored | agree? |
|---|---|---|---|---|---|---|---|---|
| `f754713d` | NBA spread | Timberwolves +6.5 | 2026-04-18 14:23 | **04-18 vs DEN** (15:30, **+1.1h** → LOSS) · 04-20 vs DEN (22:30, +56.1h → WIN) | **04-18** | **LOSS** | win | ✗ **disagree** |
| `af6e2ca4` | NHL ML | Wild ML | 2026-04-18 16:21 | **04-18 vs DAL** (17:30, **+1.2h** → WIN) · 04-20 vs DAL (21:30, +53.2h → LOSS) | **04-18** | **WIN** | loss | ✗ **disagree** |
| `b1418864` | NHL ML | Flyers ML | 2026-04-25 18:22 | 04-22 vs PIT (19:00, −71.4h → WIN) · **04-25 vs PIT** (20:00, **+1.6h** → LOSS) · 04-27 vs PIT (19:00, +48.6h → LOSS) | **04-25** | **LOSS** | win | ✗ **disagree** |
| `d61d4559` | NBA spread | New York Knicks -5.5 | 2026-04-18 16:43 | **04-18 vs ATL** (18:00, **+1.3h** → WIN) · 04-20 vs ATL (20:00, +51.3h → LOSS) | **04-18** | **WIN** | loss | ✗ **disagree** |
| `aef0b95b` | NHL ML | Canadiens ML (+170) | 2026-05-21 23:13 | 05-21 vs CAR (20:00, **−3.2h**, already started → would-WIN) · 05-23 vs CAR (19:00, **+43.8h**) | **UNRESOLVED** | — | loss | — |
| `e949537b` | NBA spread | San Antonio Spurs -6.5 | 2026-05-04 22:51 | 05-04 vs MIN (21:30, **−1.4h**, already started → would-LOSS) · 05-06 vs MIN (21:30, **+46.7h**) | **UNRESOLVED** | — | win | — |
| `3a2b1755` | NHL spread | Colorado Avalanche +1.5 | 2026-05-26 21:34 | 05-24 vs VGK (20:00, −49.6h) · 05-26 vs VGK (21:00, **−0.6h**, started ~35m before post → would-WIN) | **UNRESOLVED** | — | loss | — |
| `2c12a667` | MLB ML | Los Angeles Angels ML | 2026-04-12 16:52 | 04-10 vs CIN (18:45, −46.1h) · 04-11 vs CIN (16:10, −24.7h) · 04-12 vs CIN (13:40, **−3.2h**, started ~3.2h before post → would-WIN) | **UNRESOLVED** | — | loss | — |

**Outcome:** 4 **PINNED + DISAGREE**, 0 pinned+agree, 4 **UNRESOLVED**.

## Hour-pin vs the audit's day-pin

The day-pin proposed a terminal correction for all 8; the hour-pin **confirms 4** and **cannot
confirm 4** (the two largest day-pin swings among them). Every one it cannot confirm is a case
where the post was published **after** that day's game had already started, with the next
same-opponent game >24h out — i.e. the post instant genuinely does not select a pre-game bet.

| id | audit day-pin → ΔPU | hour-pin | note |
|---|---|---|---|
| `f754713d` | 04-18 loss → −5.7273 | **04-18 loss (confirmed)** | pinned game == day-pin game |
| `af6e2ca4` | 04-18 win → +5.7270 | **04-18 win (confirmed)** | pinned game == day-pin game |
| `b1418864` | 04-25 loss → −3.8182 | **04-25 loss (confirmed)** | pin picks 04-25 out of a **3-game** PHI–PIT stretch |
| `d61d4559` | 04-18 win → +3.8180 | **04-18 win (confirmed)** | pinned game == day-pin game |
| `aef0b95b` | 05-21 win → **+13.5000** | **UNRESOLVED** | post 23:13 ET = **3.2h after** the 05-21 puck drop; next CAR game +43.8h |
| `e949537b` | 05-04 loss → **−9.5455** | **UNRESOLVED** | post 22:51 ET = **1.4h after** the 05-04 tip; next MIN game +46.7h |
| `2c12a667` | 04-12 win → +3.9048 | **UNRESOLVED** | post 16:52 ET = **3.2h after** the 04-12 first pitch; all CIN games precede it |
| `3a2b1755` | 05-26 win → +1.7407 | **UNRESOLVED** | post 21:34 ET = **~35m after** the 05-26 puck drop; no later COL–VGK game in window |

The day-pin's proposed swing for the 4 confirmed rows nets **−0.0005u** (a wash); the day-pin's
swing for the 4 it cannot confirm totalled **+9.60u** (dominated by the +13.5u `aef0b95b` and the
−9.55u `e949537b`). **The hour-pin strips exactly the two largest and riskiest day-pin
corrections down to "unproven, stays pending."**

## PINNED + DISAGREE — correction *candidates* (report-only; sorted by |ΔPU|)

Apply-script schema per row (for the eventual operator-gated pass, mirroring #168/#172):
`id`, `expect_stored_result` (guard: refuse if the stored result no longer matches),
`new_result`, `new_pu` (stored American odds; empty odds → `0.909 × units`, flagged
**default-odds**), plus the re-fetched dated evidence. `ΔPU = new_pu − stored_pu`.

| # | id | pick | stored → new | new_pu | ΔPU | odds/units | pinned game — evidence (engine, re-fetched 2026-07-03) |
|--:|---|---|---|---:|---:|---|---|
| 1 | `f754713d` | Timberwolves +6.5 | win → **loss** | −3.0000 | **−5.7273** | odds NULL / 3u | DEN 116, MIN 105 → 105 + 6.5 = 111.5 < 116, missed (ESPN, 2026-04-18; tip 15:30 ET, post +1.1h) |
| 2 | `af6e2ca4` | Wild ML | loss → **win** | +2.7270 | **+5.7270** | odds NULL / 3u · **default-odds** | Wild 6, Stars 1 (api-web.nhle.com, 2026-04-18; puck drop 17:30 ET, post +1.2h) |
| 3 | `b1418864` | Flyers ML | win → **loss** | −2.0000 | **−3.8182** | odds NULL / 2u | PIT 4, PHI 2 (api-web.nhle.com, 2026-04-25; puck drop 20:00 ET, post +1.6h) |
| 4 | `d61d4559` | New York Knicks −5.5 | loss → **win** | +1.8180 | **+3.8180** | odds NULL / 2u · **default-odds** | NYK 113, ATL 102 → 113 − 5.5 = 107.5 > 102, covered (ESPN, 2026-04-18; tip 18:00 ET, post +1.3h) |

**Net ΔPU if all 4 applied: −0.0005u ≈ 0.00u** — a near-perfect wash (two default-odds wins
recovered, +2.727u and +1.818u; two stored wins flipped to losses, −3u and −2u; the −0.0005u
residual is the 0.909-vs-10/11 default-odds rounding). This is a materially different picture
from the day-pin's series-bucket net of +5.6947u (7 rows) / +9.5995u (with `2c12a667`): almost
all of that positive net lived in the **unconfirmable** `aef0b95b`.

**`user_bets` tails (per-row).** Read-only from this worktree cannot enumerate `user_bets` (no DB
access per the run gates). Every tail in the table belongs to the single synthetic
`user_id='1059681615418236948'` (25 rows, all `action='fade'`, `status='pending'` — see
[`docs/audits/2026-07-03-pregate-tierb-reanchor.md`](2026-07-03-pregate-tierb-reanchor.md) and
BACKLOG §`user_bets` is unsettled). **Operator pre-apply step:** for each of the 4 candidates
above, count its `user_bets` tails; any that carries one needs the **#173 tailed-settle pattern**
(`scripts/apply-tierb-tailed-corrections.js`) — flip bet → archive → settle the fade tail
opposite the bet, scoped to that synthetic id — rather than a bare `applyGradeOverride`, whose
HARD GATE refuses tailed rows. A fade tail settles `'lost'` when the bet wins and `'won'` when
the bet loses.

## PINNED + AGREE — none

No row pinned to a game whose engine verdict matched the stored grade. (The day-pin already
resolved the agree cases; every row that reaches minute-resolution here either flips or is
unresolvable.)

## UNRESOLVED — stays pending (4)

Not refuted — **not pinnable by the post instant alone.** Each stays `pending`; the day-pin's
proposed correction is neither confirmed nor refuted here and needs per-game external
verification of the bettor's intended game.

| id | pick | reason | detail |
|---|---|---|---|
| `aef0b95b` | Canadiens ML (+170) | `next_start_gt_24h` | post **2026-05-21 23:13 ET** is 3.2h *after* the 05-21 MTL–CAR puck drop (20:00 ET); the next MTL–CAR game is 05-23 (19:00 ET, **+43.8h**). The series ran to a game 5 on 05-25 (outside window, further out). ⚠ **stake mismatch**: `units=5` but text says "2u" (units-as-dollars, backlog `3e5c01a0` / PR #165). |
| `e949537b` | San Antonio Spurs −6.5 | `next_start_gt_24h` | post **2026-05-04 22:51 ET** is 1.4h *after* the 05-04 SAS–MIN tip (21:30 ET); the next SAS–MIN game is 05-06 (21:30 ET, **+46.7h**). |
| `2c12a667` | Los Angeles Angels ML | `post_after_all_series_starts` | post **2026-04-12 16:52 ET** is ~3.2h *after* the 04-12 LAA–CIN first pitch (13:40 ET); **all three** CIN games (04-10/04-11/04-12) precede the post. The next Angels game (04-13 vs NYY, different opponent) starts +26.2h — so even the un-scoped "any Angels game" reading is UNRESOLVED. Confirms the re-anchor's reclassification of this row out of the pinned set. |
| `3a2b1755` | Colorado Avalanche +1.5 | `post_after_all_series_starts` | post **2026-05-26 21:34 ET** is ~35m *after* the 05-26 COL–VGK puck drop (21:00 ET); the only earlier COL–VGK game (05-24) started long before; no COL–VGK game in the window starts after the post. ⚠ **stake mismatch**: `units=1` but text says "3u" (same class as above). |

Both stake-mismatch rows are UNRESOLVED, so the mismatch is moot for now; it must still be
reconciled if either is ever corrected.

## Reproduce

```
export NODE_PATH=<main-checkout>/node_modules
node scripts/tierb-series-disambiguation.js prompts/pregate-export-v2.json --out series-disambig-results.json
```

All candidate games are final (April–May 2026 playoff games), so the fetch is deterministic. The
script hits only `statsapi.mlb.com`, `api-web.nhle.com`, and ESPN (the engine's own endpoints),
caches by URL, and throttles to ≤3/s.

## Report-only — next step

The 4 pinned-disagree rows are **candidates**. The correction pass is a **separate operator-gated
step**, gated on **per-row external verification of the intended pinned game**, following
`docs/RUNBOOKS/db-interventions.md`: dry-run first, then a single archived transaction with an
`expect_stored_result` guard, and the #173 tailed-settle path for any candidate carrying a
synthetic `user_bets` tail. The 4 UNRESOLVED rows are **not** correction candidates and stay
pending.
