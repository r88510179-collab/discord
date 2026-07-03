# 2026-07-03 — Pre-gate audit Tier B: snowflake re-anchor + delta (read-only)

**What:** the 467 pre-gate AI-graded settled straights that *remain* after the 2026-07-02
Tier A apply (`prompts/pregate-export-v2.json` = the original 491 minus the 24 high-confidence
rows corrected in [#168](../../scripts/apply-pregate-corrections.js)) were **re-anchored** off the
true tweet-post time recovered from each row's X/Twitter snowflake id, and every row whose ET
slate day moved was **shadow re-graded** with the corrected anchor by re-running the unchanged
[`scripts/shadow-regrade-pregate.js`](../../scripts/shadow-regrade-pregate.js) engine verbatim.
The re-anchor is [`scripts/tierb-reanchor.js`](../../scripts/tierb-reanchor.js). Input was the
local export only; network was limited to the same public score APIs the engine already uses.

> **NO corrections applied.** Report-only. The correction candidates below are a **separate
> operator-gated pass after external verification** — see the last section. This run writes
> nothing to the DB and ships no correction script.

## Why re-anchor

The 2026-07-02 shadow regrade anchored each row to `event_date` (present on only 2 of 467) or
else `created_at`. For scraped tweets `created_at` is the **scrape time, not the post time** — and
scrapes trail posts by 0–5 days (deep backfills more), so the `created_at`-derived ET slate day
can land on the wrong game. That is exactly why **47 of the 71 v1 disagreements were flagged
low-confidence ("LC")**. Tier B recovers the real post instant from the tweet id
(`post_ms = (id >> 22) + 1288834974657`, done in BigInt — ids exceed 2⁵³) and re-derives the ET
slate day with the engine's own `etParts` conversion.

Across the 205 re-anchorable rows the recovered post time fell **before** `created_at` on every
single row (gap 0.0–4.7 days, median 0.38 d), and **0** fell outside the sanity window — direct
confirmation that the scrape-trails-post model holds.

## Controls (both green before any delta was trusted)

| control | result |
|---|---|
| **v1-anchor parity** — `tierb-reanchor.js`'s replicated v1 anchor vs the engine's baseline `anchor_ymd` | **467 / 467 identical** (the re-anchor shares the engine's ET convention exactly) |
| **engine determinism** — 5 unmoved v1-agree rows (MLB×3, NHL, NBA) re-graded UNPATCHED before the batch | **5 / 5 identical verdicts** (`014fc848` L, `01ee4b0c` W, `042f178d` W, `0436fd8b` L, `05a112ac` L) |

The determinism control ran *before* the moved-row batch and would have aborted it on any
mismatch; a moved-row verdict change is therefore attributable to the moved anchor, not engine
flake. The moved batch itself fetched fresh finals (55 API calls, **0 fetch errors**).

## Anchor stats

| bucket | count | definition |
|---|---:|---|
| **moved** | **117** | `source LIKE 'twitter%'` + `/status/` id, in window, snowflake ET day ≠ v1 ET day |
| unmoved (re-anchorable) | 88 | snowflake ET day == v1 ET day (`created_at` already on the right slate) |
| unanchorable | 262 | 209 `vision_slip` + 20 `discord` + 1 `hold_review_script` + **32 twitter rows whose stored url is a `discord.com` relay permalink**, not a tweet `/status/` url |
| anchor_reject | **0** | none — every recovered post time was inside `[created_at − 21d, created_at + 1h]` |

**Day-shift distribution (moved rows, snowflake − v1, in calendar days):**

| shift | −1 | −2 | −3 | −5 |
|---|---:|---:|---:|---:|
| rows | 93 | 16 | 7 | 1 |

All shifts are **negative** (post precedes scrape) — as physics demands. −1 day dominates: the
typical failure was a tweet scraped the morning/day after the game it referenced.

## Delta matrix vs v1 (only the 117 moved rows can transition; unmoved rows keep their v1 verdict, and the determinism control proves it)

| prior class (v1) | total | unmoved (unchanged) | moved | → now-agree | → now-disagree | → now-unresolved |
|---|---:|---:|---:|---:|---:|---:|
| **v1-agree** (327) | 327 | 267 | 60 | 53 | **6** | 1 |
| **v1-LC-disagree** (47) | 47 | 41 | 6 | **5 dissolved** | **1 confirmed** | 0 |
| **v1-unresolved** (93) | 93 | 42 | 51 | 21 | **6** | 24 |

Reading the three prior classes:

- **v1-LC-disagree (47):** the whole point of Tier B. **5 dissolve** — the v1 "disagreement" was an
  artifact of the wrong `created_at` anchor and re-anchoring **vindicates the stored grade**
  (`f2949896` Blue Jays ML: v1 graded a May 13 WIN, but the real post-date May 12 game was a LOSS =
  stored; likewise `f8554e78`, `6b665dd5`, `24b4dcaa`, `7cee7844`). **1 is confirmed** on the exact
  snowflake anchor (`3a2b1755`). The other **41 are unmoved** — their snowflake ET day equals their
  `created_at` ET day, i.e. the anchor was already correct, so those 41 disagreements are now
  **anchor-confirmed** rather than low-confidence. Net: of the 47 LC leads, 5 were false alarms and
  42 are genuine (41 unmoved-confirmed + 1 moved-confirmed). The LC flag held back exactly the rows
  that needed a date check.
- **v1-agree (327):** 60 moved; **6 became disagreements** on the true post date — the stored grade
  had quietly matched a *different* game the v1 anchor happened to land on. 1 (`929ffce7` Lakers -4.5)
  went ambiguous.
- **v1-unresolved (93):** 51 moved; the exact snowflake anchor **resolved 27** of them (21 agree,
  **6 disagree**), while 24 stay unresolved (multi-pick / segment / no matching game even on the
  corrected day).

**13 moved rows re-graded to a terminal disagreement.** Each was then **adversarially
re-verified** against the public score APIs (§ next). One was refuted; **12 survive**.

## External verification (adversarial, refute-by-default)

Every one of the 13 was handed to an independent verifier that **re-fetched the public API itself**
(not trusting the engine's evidence) and tried to *refute* the correction: multi-pick check,
did-the-team-play-a-final-on-the-snowflake-date, independent score, independent line math, and a
check for a competing game on the v1 date. Results were **cross-checked a second time by hand**
against `statsapi.mlb.com`, `api-web.nhle.com`, and ESPN; both passes agreed on all 13.

**1 REFUTED — excluded from the candidate set:**

| id | why refuted |
|---|---|
| `9aa55f5b` | **Not a single bet — a 3-leg card:** "Pistons/Magic UNDER 209.5, **Rockets -3.5, Cavaliers -3.5**". The engine graded only leg 1 (the under hit, 172 < 209.5) and called it a WIN. Graded as the parlay it actually is, it **LOSES** — Rockets lost to LAL 78-98 and Cavaliers lost to TOR 110-112 (OT), so two legs miss → stored **loss is correct**. **Classifier gap:** the multi-pick guard only splits on newlines and `and`/`&`; a **comma-separated** multi-pick slips through as a lone `game_total`. (Backlog item below.) |

The confidence split among the **12 confirmed** turns on *how* the named side is pinned to the
snowflake day:

- **Pinned (5)** — high confidence. Matchup totals (the engine requires **both** named teams in the
  game, so only that one matchup can match) and single-team picks whose adjacent games are against
  **different opponents** (so the tweet date + line pins the game).
- **Same-opponent series (7)** — the named team played the *same* opponent again within 1–3 days
  with the **opposite** grade (playoff series). The snowflake (tweet-post day) selects the same-day
  game, which is the correct disambiguator in aggregate, but for any single row the operator should
  confirm the bettor's intended series game before applying. These are flagged, not high-confidence.

## NEW correction candidates (report-only; sorted by |ΔPU|)

Apply-script schema per row: `id`, `expect_stored_result` (guard: refuse if the stored result no
longer matches), `new_result`, `new_pu` (from stored American odds; where odds are empty,
`0.909 × units`, flagged **default-odds**), plus dated evidence. `ΔPU = new_pu − stored_pu`.

| # | id | conf | sport / market | pick | v1 class | stored→new | new_pu | ΔPU | anchor v1→snowflake | evidence (independently re-fetched) |
|--:|---|---|---|---|---|---|---:|---:|---|---|
| 1 | `aef0b95b` | series | NHL ML | Canadiens ML (+170) | v1-unresolved | loss→**win** | +8.5000 | **+13.5000** | 05-22→**05-21** | MTL 6, CAR 2 (Final, api-web.nhle.com 2026-05-21). ⚠ series: MTL also *lost* 2-3 on 05-23; ⚠ units=5 but text says "2u" |
| 2 | `e949537b` | series | NBA spread | San Antonio Spurs -6.5 (-110) | v1-agree | win→**loss** | −5.0000 | **−9.5455** | 05-07→**05-04** | SAS 102, MIN 104 (Final, ESPN 2026-05-04) → -6.5 misses & lost outright. ⚠ series: SAS *covered* on 05-06 (133-95) & 05-08 (115-108) |
| 3 | `320bc36b` | **pinned** | NHL game_total | Lightning / Bruins OVER 6.5 | v1-unresolved | win→**loss** | −3.0000 | −5.7273 | 04-13→**04-11** | TBL 2, BOS 1 = 3 < 6.5 (Final, api-web.nhle.com 2026-04-11) |
| 4 | `f754713d` | series | NBA spread | Timberwolves +6.5 | v1-agree | win→**loss** | −3.0000 | −5.7273 | 04-20→**04-18** | DEN 116, MIN 105 → +6.5 misses (ESPN 2026-04-18). ⚠ series: MIN *covered* 04-20 (won 119-114) |
| 5 | `af6e2ca4` | series | NHL ML | Wild ML | v1-agree | loss→**win** | +2.7270 | +5.7270 | 04-20→**04-18** | MIN 6, DAL 1 (Final, api-web.nhle.com 2026-04-18). default-odds. ⚠ series: MIN *lost* 04-20 (2-4) |
| 6 | `2c12a667` | **pinned** | MLB ML | Los Angeles Angels ML | v1-agree | loss→**win** | +1.9048 | +3.9048 | 04-13→**04-12** | LAA 9, CIN 6 (Final, statsapi 2026-04-12). Adjacent 04-13 game is vs NYY (diff opponent) |
| 7 | `b1418864` | series | NHL ML | Flyers ML | v1-agree | win→**loss** | −2.0000 | −3.8182 | 04-30→**04-25** | PIT 4, PHI 2 (Final, api-web.nhle.com 2026-04-25). ⚠ series: PHI *won* 04-29 (1-0) |
| 8 | `d61d4559` | series | NBA spread | New York Knicks -5.5 | v1-agree | loss→**win** | +1.8180 | +3.8180 | 04-20→**04-18** | NYK 113, ATL 102 → -5.5 covers (ESPN 2026-04-18). default-odds. ⚠ series: NYK *lost* 04-20 (106-107) |
| 9 | `d7bf7159` | **pinned** | NBA spread | Toronto Raptors -13.5 | v1-unresolved | loss→**win** | +0.9091 | +1.9091 | 04-06→**04-03** | TOR 128, MEM 96 → -13.5 covers (ESPN 2026-04-03). Adjacent games vs SAC/BOS (diff opponents, -13.5 fits only MEM blowout) |
| 10 | `b5bb1ad7` | **pinned** | NBA game_total | Bulls Knicks Over 237.5 | v1-unresolved | win→**loss** | −1.0000 | −1.9091 | 04-06→**04-03** | CHI 96, NYK 136 = 232 < 237.5 (ESPN 2026-04-03) |
| 11 | `f4946029` | **pinned** | NBA game_total | Hornets Pacers Under 235.5 | v1-unresolved | win→**loss** | −1.0000 | −1.9091 | 04-06→**04-03** | CHA 129, IND 108 = 237 > 235.5 (ESPN 2026-04-03) |
| 12 | `3a2b1755` | series | NHL spread | Colorado Avalanche +1.5 (-135) | v1-LC-disagree | loss→**win** | +0.7407 | +1.7407 | 05-27→**05-26** | COL 1, VGK 2 → +1.5 covers (Final, api-web.nhle.com 2026-05-26). ⚠ series: COL *lost cover* 05-27 (1-3); ⚠ units=1 but text says "3u" |

**Net ΔPU if applied:**

| set | rows | net ΔPU |
|---|---:|---:|
| **all 12 confirmed** | 12 | **+1.9631u** |
| pinned only (high-confidence) | 5 | −3.7316u |
| same-opponent-series only | 7 | +5.6947u |

The pinned corrections are net **negative** (three matchup totals were stored as wins that actually
lost); the series-class rows net positive, driven by the +13.5u Canadiens row — which is exactly
the one most in need of per-game confirmation. (For contrast, the raw script's undecomposed
`net_delta_if_applied` was +11.5u; **+9.5u of that was the invalid multi-pick `9aa55f5b`**.)

Two rows carry a **stake mismatch** (`aef0b95b` stored units=5 vs text "2u"; `3a2b1755` stored
units=1 vs text "3u") — the pre-existing units-as-dollars parse issue (backlog `3e5c01a0`, PR #165); ΔPU above uses the
**stored** units, so any apply must reconcile stake
first.

## Report-only — corrections are a separate operator-gated pass

This document proposes nothing to the database. Any apply is a distinct step, gated on **per-row
external verification of the intended game** (especially the 7 same-opponent-series rows and the
two stake-mismatch rows), following `docs/RUNBOOKS/db-interventions.md`: dry-run first, then a
single archived transaction with an `expect_stored_result` guard that refuses tailed rows.

## Reproduce

```
export NODE_PATH=<main-checkout>/node_modules
# 1. baseline (v1 anchors) for the 467-row export:
node scripts/shadow-regrade-pregate.js prompts/pregate-export-v2.json --out baseline-v2.json
# 2. re-anchor + determinism control + moved-row shadow re-run + delta:
node scripts/tierb-reanchor.js prompts/pregate-export-v2.json \
     --baseline baseline-v2.json --out tierb-results.json --artifact-dir .
```

`tierb-reanchor.js` spawns the unchanged engine as a child process on a patched export (moved rows
carry the post instant as `event_date`, the only field the engine's `anchorFor` prefers over
`created_at`); it computes **no grades itself**.

## Follow-up / backlog

- **Multi-pick classifier gap (real bug):** `services/…` shadow classifier (and, by inheritance,
  the reasoning behind the prod multi-pick guard) refuses multi-pick strings only on newline and
  `and`/`&` splits — a **comma-separated** card ("A UNDER x, B -3.5, C -3.5") slips through as a
  lone total. `9aa55f5b` is the in-the-wild instance. Worth a guard extension + a targeted test.
