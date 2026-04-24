# Grading Anti-Patterns

Specific error modes observed in prior grading passes (production AutoGrader and manual regrades). Each one caused at least one bet to be graded incorrectly. Use this as a mental checklist before finalizing any verdict.

## 1. Wrong-date attribution

**Pattern**: Citing a stat line from the wrong game date. E.g., regrade cited "Knueppel 13 pts (5-13 FG)" from March 29 to grade a bet posted April 13 targeting Play-In games 4/14–4/17.

**Why it happens**: Source aggregators return multiple game logs for a player. Grader picks the first matching result without checking the date matches the target window.

**Prevention**: Before quoting a stat, verify the evidence's date is within ±1 day of the target date (per `methodology.md` target-date anchoring). If the evidence date is outside the target window, reject it and search again.

## 2. Hallucinated evidence quotes

**Pattern**: Generating a plausible-sounding `evidence_quote` that does not appear in the cited URL. Observed in production: "HALLUCINATION: AI claimed 04-07 but not in search results" in slip-receipts grading reason.

**Why it happens**: Grader relies on LLM recall instead of re-fetching and grep-verifying the quote.

**Prevention**: Every `evidence_quote` must be a verbatim copy-paste from an explicitly fetched URL. If using a tool like `web_fetch`, the quote must appear in the fetched content. If not, reject the quote and either find a real one or mark `unknown`.

**Detection at runtime (P2b agent)**: After grading, re-fetch the `evidence_url` and grep for the `evidence_quote`. If not found verbatim, flag as hallucination and mark `unknown`.

## 3. Number-comparison inversion

**Pattern**: Grading "Over 220.5" as WIN when the actual total was 210. Or grading "Suns -3.5" as WIN when Suns lost by 4.

**Why it happens**: Grader eyeballs numbers without applying the spread/total math explicitly.

**Prevention**: Apply the `methodology.md` number-comparison validator before finalizing any numeric-threshold bet. State the inequality explicitly in the reasoning: "Total was 210, threshold was 220.5, 210 < 220.5 → UNDER → Over bet LOSS."

## 4. Failed-leg over-voiding

**Pattern**: Marking a parlay as `unknown` because you couldn't verify ALL legs, when in fact you verified at least one failed leg.

**Why it happens**: Grader treats "partially unverifiable" as "entirely unverifiable."

**Prevention**: A single confirmed failed leg is sufficient to mark parlay LOSS. Verify one failed leg and stop. See `methodology.md` failed-leg-kills-parlay rule.

**Applied example**: 8-leg NBA parlay where 7 legs are un-fetchable but Knueppel 15+ leg clearly fails (6 pts) → parlay LOSS, not unknown.

## 5. Cross-sport / cross-league parser errors at grading

**Pattern**: Bet description says "Utah Jazz Chisholm Player To Record 1+ Hits" — mixing NBA team with MLB player. Grader either accepts the mash-up as real or forces a grade.

**Why it happens**: Slip extraction concatenated two separate bets' text into one description. Grader doesn't detect the cross-sport mash.

**Prevention**: Before grading, check that the bet's `sport` / `league` field matches the entities in the description. If bet is MLB but the description references an NBA team, flag as `UNGRADABLE_CROSS_SPORT` and mark `unknown`. Do NOT try to grade the salvageable parts.

## 6. Recap-vs-pregame misclassification

**Pattern**: Bet from `bobby__tracker` posted 10:31pm ET April 13 graded as targeting the April 18 playoff Game 1 (because that's the "next Lakers game" after posting). But bobby__tracker is a `recap_tracker` — the bet was recapping the April 12 regular-season finale where LeBron was pulled at halftime.

**Why it happens**: Grader applies default `pregame_picks` anchoring to a capper that's actually a `recap_tracker`.

**Prevention**: Always check `capper-classes.md` before applying target-date anchoring. If capper is not in the table, classify based on their posting history (see `capper-classes.md` discovery process) before grading.

## 7. Trusting Gemini / ChatGPT tiebreakers uncritically

**Pattern**: A second grader's verdict is adopted without verifying the evidence, even when the tiebreaker cites the wrong game date or hallucinates a stat.

**Why it happens**: Multi-grader setups create social-proof bias — "if the other grader said LOSS, it's probably LOSS."

**Prevention**: For any disagreement between graders, independently re-verify the evidence. Do not defer to the grader that sounds more confident. Defer to the grader whose cited URL, quote, and date actually match.

**Gemini-specific guidance**: Gemini is useful as a Tier 3 tiebreaker (see SKILL.md §3) because it has different training and retrieval patterns than Claude — it often resolves legs Claude missed. But Gemini has the same failure modes this anti-patterns doc lists. Treat Gemini output as evidence, not authority:
- If Gemini returns `null` / "insufficient data" for a leg, the bet stays `unknown`. Do not assume Gemini knows something Claude doesn't.
- If Gemini provides a specific quote, re-fetch the cited URL and verify the quote appears verbatim. Gemini hallucinates quotes at a similar rate to Claude.
- If Gemini's date conflicts with the target window per capper-class anchoring, reject Gemini's verdict.
- Never skip re-verification because "Gemini has the better search tools." It doesn't — it just has different search tools with their own biases.

**Applied example**: Gemini returned `first_to_20: null` for the Race-to-20 Portland leg. Accepting this would have kept the bet `unknown`. Direct `web_fetch` of the CBS Sports PBP page resolved it (Blazers first to 20) and flipped the parlay to WIN.

## Meta-pattern: failure mode drift

Over 10 batches, the failure modes have shifted as the methodology improved:
- Batches 1–3: Over-voiding on parlays with single verifiable failed legs
- Batches 4–5: Number-comparison inversion
- Batches 6–7: Wrong-date attribution (especially around Play-In windows)
- Batch 8: Capper-class misclassification (bobby__tracker)
- Batch 9: Same as 8, now caught by the class table
- Batch 10: **Pre-ingestion noise dominates** — 68% of batch was ungradable junk (placeholder labels, reactions, SGP headers without legs, ambiguous multi-side descriptions). Root cause is upstream in ingestion, not in grading. Rolled out ambiguous-multi-side rule in methodology.

Track the failure mode mix per batch. If a "solved" failure mode reappears, the methodology update didn't stick — treat that as a bug and re-harden the relevant rule.
