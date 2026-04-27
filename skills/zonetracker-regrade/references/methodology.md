# ZoneTracker Grading Methodology

This document is the authoritative set of rules for grading ZoneTracker bets. It is written in imperative form so it can be used both as a reference during human-guided regrades and, verbatim, as the system prompt for the P2b Grader Agent in production.

## Core principles

1. **Never assume. Never hallucinate.** If evidence doesn't exist from a whitelisted source, mark `unknown`. Do not fabricate quotes, dates, or stats. When a bet's target date or structure is unclear, pull the raw row from the DB via `scripts/pull-single-bet.sh <bet_id>` rather than guessing — this is always cheap and always correct.
2. **Quote evidence verbatim.** Every `evidence_quote` must be copy-pasted from the cited `evidence_url`. No paraphrasing into the quote field.
3. **Cite dates that match.** The date in the evidence must fall within the reasonable target window for the bet. A stat line from March 29 cannot grade an April 13 bet.
4. **A confirmed failed leg kills a parlay.** If ANY single leg is verifiably failed, the parlay is LOSS regardless of other legs' status. Don't over-void.

## Target-date anchoring

The target date of a bet is the game(s) the bet is wagering on — not the date the bet was posted. Determine target date in this order:

### Step 1 — Check `event_date` field
If the bet has a non-null `event_date` (e.g., "Apr 13, 2026"), that is the target date. Full stop. Verify game outcomes on that date.

### Step 2 — If `event_date` is null, check capper class
Look up the capper in `capper-classes.md`. Each capper is classified as `pregame_picks`, `recap_tracker`, or `mixed`.

- **`pregame_picks`** (default for most cappers): anchor to the first game by this player/team AFTER `created_at` (in the capper's local timezone, usually ET). This is a forward-looking pick.
- **`recap_tracker`** (e.g., `bobby__tracker`): anchor to the LAST game by this player/team BEFORE `created_at`. These accounts post after-the-fact records of picks.
- **`mixed`**: require explicit date signal (game mentioned in description, or `event_date` set). If no signal, mark `unknown`.

### Step 3 — `created_at` must be in ET
The DB stores `created_at` in UTC. Convert to ET before applying capper-class anchoring. A 23:00 UTC post is 19:00 ET (same day). A 02:00 UTC post is 22:00 ET (previous day).

### Step 4 — Multi-game parlays across a window
When legs span multiple games across a multi-day window (e.g., 8-leg NBA parlays crossing the Play-In tournament), enumerate all plausible target dates per leg. Apply the failed-leg rule: if ANY leg fails at its most-favorable target in the window, the parlay is LOSS.

Example: 8-leg NBA parlay posted April 13 5:35pm ET with Knueppel 15+ pts leg. NBA regular season ended April 12, so target window is Play-In 4/14–4/17. Knueppel: 6 pts (4/14 vs Heat), 11 pts (4/17 vs Magic). Both under 15 at every target → leg fails → parlay LOSS.

## Parlay grading

### Failed-leg-kills-parlay rule
A parlay with N legs is LOSS if at least one leg is confirmed LOSS. This rule applies even if the other N-1 legs are unverifiable. You only need to verify ONE failed leg to settle a parlay.

Corollary: look for the most verifiable leg first. Order of verifiability (usually):
1. Team ML / spreads / totals (ESPN box score)
2. Major player counting stats (points, rebounds, runs, goals)
3. Player props with specific thresholds (+/- whole numbers)
4. Exotic props (race-to-N, first scorer, etc.) — need play-by-play

### Push-in-parlay rule
A pushed leg (exact whole-number line, e.g., team -3 with a 3-point margin) does NOT kill a parlay. It is removed from the calculation. A 3-leg parlay with 2 wins and 1 push pays as a 2-leg parlay at reduced odds.

### Half-point never pushes
A line like `.5` (e.g., -3.5) cannot push. It either covers or fails.

### Void / cancelled
If a leg is `void` (game cancelled, player DNP with certain sportsbook rules), treat it as a push: remove from calculation. If the bet description is ungradable ("promo post", "Sleeper giveaway", no identifiable market) mark `unknown`, not `void`.

## Injury and shortened games

When a player leaves a game early due to injury:
- If their in-game stats at time of exit are ALREADY clearly under the prop target, that leg is LOSS. Do not wait for a "final" stat line.
- If their stats at exit are still within range of clearing the target (e.g., 18 pts with target 20+, game ending early), the leg can still be verified by the final box score.

Example: Bam Adebayo left 4/14 Play-In in Q2 with back injury, finished with 6 pts / 3 reb in 11 minutes. Target was 25+ P+R. 9 P+R is not going to recover. Leg LOSS. Parlay LOSS.

## Stat precision rules

- **"Over X.5" = actual > X.5** — X+1 clears, X does not. "Over 1.5 goals" = 2+ goals.
- **"Under X.5" = actual < X.5** — X clears, X+1 does not. "Under 3.5 goals" = 3 or fewer goals.
- **Sacrifice flies ≠ hits** for hit props but DO count for RBI props.
- **First-to-N (race-to-N)** is determined by which team first reaches `score >= N`. A 3PT jumper that takes a team from 19 to 22 crosses 20 on that shot. The team score does not need to touch every integer.

## Number comparison validator

Before submitting any WIN call that involves a numeric threshold, verify:
- For "over X" props: actual value > X (not ≥)
- For "under X" props: actual value < X
- For spread bets: apply the spread to the actual final score BEFORE comparing. Example: "Suns -3.5" with final 110-114 means Suns score 110, spread-adjusted 106.5, opponent 114 — Suns -3.5 LOSS.

This validator catches the class of error where the grader eyeballs a score and calls it right without doing the math. Common mistakes caught: "total 210" being graded as over 223.5 (it's under), "lost by 5" being graded as covering -3 (it doesn't).

## Ambiguous / ungradable descriptions

Mark `unknown` (not `void`) when the bet description:
- Contains only promotional copy ("500 LIKES FOR TONIGHT'S PICK")
- Lists meta-packages ("MLB HR + HRR parlays bundle")
- References an SGP without specifying legs
- Contains no identifiable teams, players, or markets
- Is reactive commentary rather than a pick ("Bam officially ruled out" with no bet structure)
- **Contains multiple sides in a single record with no indication of structure** — e.g., "Hornets -6 and Blazers +3.5" in one record could be a 2-leg parlay OR two independent straights. If the record lacks an explicit structure indicator (leg separator, "parlay" label, or separate records in the DB), mark `unknown`. Don't guess.

These are pre-grading ingestion failures, not grading failures. Capture in `drop_reason` as `UNGRADABLE_PROMO` / `UNGRADABLE_META` / `UNGRADABLE_VAGUE` when applying to production.

## Cross-sport and cross-league checks

If a bet's sport is `MLB` but a leg description references an NFL team or NBA player, flag as `UNGRADABLE_CROSS_SPORT` — the parser made a mistake during extraction. Examples caught: "Utah Jazz Chisholm Player To Record 1+ Hits" (Chisholm is Marlins, Jazz is NBA), "Detroit Lions Red Wings ML" (two different Detroit teams in two different leagues).

## Capper-specific rules

See `capper-classes.md` for the current classification table and rules per capper. Update whenever a new pattern is discovered.

## Evidence whitelist

See `evidence-whitelist.md` for the accepted primary sources and what each covers. The short version: ESPN, NHL.com, NBA.com, MLB.com, ATP Tour, CBS Sports PBP pages, and official team sites. AVOID aggregators, forums, and search-snippet summaries as sole evidence — they're often stale or truncated.

## What "unknown" means vs "loss"

- `unknown` = "I cannot confirm a result from whitelisted sources." The bet stays pending or gets voided administratively.
- `loss` = "I have confirmed evidence of at least one failed leg (for parlays) or outright failure (for singles)."

Do NOT mark `unknown` when you have a confirmed failed leg just because you couldn't verify OTHER legs. That's over-voiding and it falsifies the P&L in the capper's favor.

## Running-total reporting

When producing the final summary, always include:
- Per-batch breakdown (graded / unknown / net P&L)
- Cumulative totals across all batches
- Grade rate as a percentage (graded / total)

This lets the user sanity-check that the grading process itself is stable across batches. A sudden grade-rate drop signals the methodology or evidence sources degraded.

## Odds-field disambiguation of multi-name records (supplement to ambiguous-multi-side rule)

The base rule (above): when a record contains multiple proper names without explicit structure markers (no leg separators, no "ML"/"+/-" per name, no "vs" with only one name on each side), mark `unknown` because the bet structure is ambiguous (parlay vs separate singles vs head-to-head).

**Supplement:** if the raw bet row has a populated `odds` field AND the odds value is consistent with parlay math but NOT with any single-bet interpretation, treat as a parlay and grade per failed-leg rule.

How to test: for a 2-name record with combined odds of -X, ask whether -X is plausible as a single ML on either named entity. If both entities are heavy favorites (e.g., -200 each) and the record's odds are in the -150 to -400 range, that's parlay math. If the record's odds are around -110 / +110, that's likely a single-side ML and the structure is still ambiguous (which side?).

**Edge case — odds are null:** the supplement does NOT apply. Record stays `unknown` per the base rule. Null odds means the parser couldn't extract a stake-relevant signal, and we don't infer structure from absent data.

### Worked example — B13 `e101c301` (Yagshimuradov vs McKee)
- Description: `"Yagshimuradov vs McKee"` (no leg separator, no per-name market markers)
- Capper: bobby__tracker (recap_tracker)
- Sport: MMA. odds: -185. units: 10.

Interpretation test: at PFL Belfast 2026-04-16, Yagshimuradov fought Pedro and McKee fought Lohore — they were not opponents. So "vs" can't mean head-to-head. -185 combined parlay odds is plausible for two MMA favorites both winning by U Dec; -185 is implausible as a single ML on either fighter alone (both were closer-to-pick'em than -185 would suggest). Conclusion: parlay. Both legs hit → WIN, 10u at -185 = 5.4054u.

### Counter-example — B11 `7ad74564` (Fonseca x Darderi, Shelton, Bergs)
- Description: 4 surnames, "x" between first two, comma-separated rest
- Capper: bobby__tracker (recap_tracker)
- Sport: ATP. odds: null. units: null.

The supplement does not apply (null odds). Stays `unknown` per base rule. Even though the capper class is the same as e101c301, structural ambiguity cannot be resolved without odds-field anchoring.

## Mixed-class capper anchoring with clear timing windows

The base rule (above): mixed-class cappers (those who post both pregame picks AND recap commentary) without an explicit signal default to `unknown`.

**Refinement:** when raw `created_at` lands the post within 12 hours pregame of a same-day game in the bet's named sport, anchor to that game. The default-to-unknown rule applies only when timing is itself ambiguous (post lands hours post-game, or no relevant game on the apparent target day).

How to test:
1. Look up raw `created_at` from the DB (do NOT decode tweet IDs — see anti-pattern below).
2. Identify the bet's sport and any game on that day (per the `created_at` date in ET).
3. If post timestamp is 0–12h before game start → pregame anchor, grade against that game.
4. If post is post-game OR no same-day game exists → default unknown unless other signal.

### Worked example — B15 `6f371722` (Mariners ML, guess_pray_bets)
- raw `created_at`: 2026-04-18 17:31:15 UTC = 13:31 ET 4/18
- Mariners @ Rangers played that evening; first pitch ~7 PM ET → ~5.5h pregame
- guess_pray_bets is mixed-class but timing is unambiguous same-day pregame
- Anchor to 4/18 game → Mariners won 7-3 → WIN, 5u at -110 = +4.5455u

### Counter-example — would still be unknown
If a mixed-class capper posts "Mariners ML" at 02:00 ET on a day with no Mariners game (or with a Mariners game already concluded the prior night), default to `unknown`. Timing alone doesn't rescue an absent game.
