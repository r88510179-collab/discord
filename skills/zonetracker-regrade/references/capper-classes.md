# Capper Classification Table

Each capper is classified by their posting pattern. Target-date anchoring (see `methodology.md` §Target-date anchoring) depends on this classification.

## Classes

- **`pregame_picks`** — posts picks BEFORE the game starts. Target = next game after `created_at`. Default for most cappers.
- **`recap_tracker`** — posts records of picks AFTER the game. Target = last game before `created_at`. Usually a tracking/aggregation account, not the original capper.
- **`mixed`** — posts both pre-game and recaps. Requires explicit date signal (`event_date` set, or game mentioned in description). Mark `unknown` if no signal.

## Known cappers

| Source | Class | Notes |
|---|---|---|
| `bobby__tracker` (X) | `recap_tracker` | Posts results of picks hours-to-days after event. Evidence: Estevam ML recap 4/7 for 4/6 fight; Altmaier ML recap 4/7 for 4/6 match; Musetti ML 4/9 for 4/9 match. Posted "LeBron DD" 4/13 23:00 ET — that recapped the 4/12 game. |
| `guess_pray_bets` (X) | `mixed` | Observed both recap (Lightning/Bruins posted 4/13 for 4/11 game) and near-real-time posts. Treat as `mixed` — require `event_date` or explicit game mention. |
| `nrfianalytics` | `pregame_picks` | Posts NRFI picks before MLB first pitch. Occasional promo posts — filter for "500 LIKES" / "HALF-SEASON PASS" / "Who is going to get the last few spots". |
| `bookitwithtrent` | `pregame_picks` | NBA/MLB picks. Also posts Whatnot/card-break promos — filter those as `UNGRADABLE_PROMO`. |
| `capperledger` | `recap_tracker` | Posts recap tweets for grading. Roadmap: parse these as grading SOURCE, not picks. |
| DubClub/Discord capper channels (DatDude, IgDave, LockedIn, Bane, Cody, Dan, Gavin, Rica, DrunkGuy, etc.) | `pregame_picks` | Standard pregame posting in dedicated capper channels. |

## Rules for applying class

1. Read `source_url` or `source` field to identify the capper.
2. Look up in this table.
3. If not in table, check prior session memories / conversation history.
4. If still unknown, default to `pregame_picks` BUT log the uncertainty in `grade_reason`.

## Discovery process

When a new capper appears, examine 3–5 of their past posts in the slip-receipts channel export or the `bets` table:
- Compare `created_at` of each post to the target game time (if identifiable).
- If posts consistently come BEFORE the game → `pregame_picks`.
- If consistently AFTER → `recap_tracker`.
- If mixed → `mixed`.

Add the new entry to this table with the evidence that determined classification.

## Anti-patterns

- **Don't assume a capper is `pregame_picks` just because they sound like an active handicapper.** bobby__tracker has handicapper-style names but is actually a recap account.
- **Don't treat `mixed` as `pregame_picks` when the timing is ambiguous.** A 20+ hour gap between `created_at` and the "next game" is usually a recap, not a pre-game pick posted days early.

## bobby__tracker — multi-name parlay syntax convention

bobby__tracker (recap_tracker class) routinely posts multi-leg parlays as comma-separated or space-separated player surnames, often with "vs" or "x" as a separator between the first two names. The convention does NOT mean head-to-head; it means parlay legs.

**Observed patterns:**
- `Yagshimuradov vs McKee` — 2-leg ML parlay (B13 `e101c301`, confirmed via odds-field disambiguation)
- `Fonseca x Darderi, Shelton, Bergs` — likely 4-leg parlay (B11 `7ad74564`, unconfirmed because odds null)

**Grading approach:** apply the odds-field disambiguation supplement (see methodology.md). When odds populated and math implies parlay, grade as parlay. When odds null, mark unknown — do not assume parlay structure from capper convention alone, because misclassifying a single-side bet as a multi-leg parlay would produce false LOSS verdicts when one of the named players loses.

**Why this convention exists:** bobby__tracker posts after events as a recap-style tracker, so the listed names are typically the cap's outright ML picks. The "vs" / "x" between the first two names appears to be stylistic shorthand carried over from h2h-style writing, not a structural indicator.
