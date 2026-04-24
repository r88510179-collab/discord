---
name: zonetracker-regrade
description: Regrade a batch of pending sports bets from the ZoneTracker Discord bot's SQLite database against web sources. Use whenever the user mentions "regrade", "Batch NN", "pull a batch", "grade pending bets", "pending parlays", or any request to manually verify bet results from the bettracker-discord-bot on Fly.io. Covers the full workflow (pull from Fly SQLite, grade with ESPN/NHL.com/NBA.com/ATP/CBS PBP as whitelisted sources, cross-reference with a second grader, produce merged JSON final, update running totals) and the grading methodology (failed-leg-kills-parlay rule, capper-class target anchoring, Play-In date enumeration, injury-shortened game handling, anti-hallucination checks). Also use this skill when asked to build or update the P2b Grader Agent prompt for production — the methodology reference doc is its system prompt.
---

# ZoneTracker Bet Regrade

Manual regrade workflow for ZoneTracker pending bets. This is a two-part skill:
- **Workflow** (this file) — the mechanical steps to pull a batch, produce a final JSON, and report totals
- **Methodology** (`references/methodology.md`) — the grading rules and judgment calls. Read this BEFORE grading any bet.

## When to use

The user says any of: "regrade", "Batch NN", "pull a batch", "grade the pending bets", "run through the pending parlays", "ready for batch 10", or uploads a `regrade_batch_NN_graded.json` file asking to reconcile it with an earlier pass. Also use when the user asks to update or build the P2b Grader Agent prompt.

## Required context

Before starting, confirm these are in place:
- Fly CLI authenticated as the account with access to `bettracker-discord-bot`
- Local Docker running (needed for `fly deploy`, not for this skill's read-only operations)
- `pull-batch.js` present locally (or ready to regenerate — see `scripts/pull-batch.template.js`)
- Read `references/methodology.md` fully — it has the rules the grading depends on
- Read `references/capper-classes.md` — anchoring rules differ by capper type
- Read `references/evidence-whitelist.md` — know which URLs count as primary sources

## The workflow

### 1. Pull the batch

Regenerate `pull-batch.js` with the current exclusion list (all IDs already graded across prior batches), upload via `fly ssh sftp shell`, then execute with `NODE_PATH=/app/node_modules`.

Critical mechanics (learned the hard way):
- **Upload**: `cd ~/Downloads && fly ssh sftp shell -a bettracker-discord-bot` → at `»` prompt use `put pull-batch.js /tmp/pull-batch.js` → Ctrl+D to exit. NOT `exit` or `quit`.
- **Execute**: `fly ssh console -a bettracker-discord-bot -C 'bash -c "NODE_PATH=/app/node_modules node /tmp/pull-batch.js"' > batch_NN.json` — the `bash -c` wrapper is required for env vars to propagate. `better-sqlite3` lives at `/app/node_modules`.
- **zsh gotcha**: don't paste `[BRACKET]` comment headers into the terminal — zsh interprets them as globs and fails. Use `#` comments or no comments.
- **Verify**: `python3 -c "import json; d=json.load(open('batch_NN.json')); print(len(d))"` — expect 25.

The template at `scripts/pull-batch.template.js` takes an `EXCLUDED_IDS` array and queries `bets` where `result='pending' AND id NOT IN (exclusions)`, ordered by `created_at ASC`, limit 25.

### 2. Grade each bet

For each of the 25 bets in the batch, apply the methodology (`references/methodology.md`) to produce a verdict: `win`, `loss`, or `unknown` with `profit_units` (or `null` for unknown / missing odds).

Output schema is defined in `references/output-schema.md`. Every bet entry needs: `bet_id`, `result`, `profit_units`, `grade_reason`, `evidence_url`, `evidence_source`, `evidence_quote` (last three are `null` for unknown).

Do NOT assume or hallucinate. If a bet's target date is ambiguous, check the capper class (`references/capper-classes.md`) and pull the raw bet description from the DB rather than guessing. When in doubt, mark `unknown`.

**Pulling raw bet details on demand.** When a specific bet's description, `event_date`, `odds`, `units`, or `source_url` is needed (for disambiguation, target-date anchoring, or capper-class lookup), use `scripts/pull-single-bet.sh`:

```bash
bash scripts/pull-single-bet.sh <bet_id_1> <bet_id_2> ...
```

This runs a one-off SQL query via `fly ssh console` and returns full row details. Used during Batches 07, 08, and the Race-to-20 resolution to disambiguate target dates and verify ambiguous descriptions. Always prefer pulling raw data over guessing — user preference is explicit about this ("Never assume or hallucinate").

### 3. Cross-reference with a second grader

ZoneTracker regrades use a multi-grader tiebreaker ladder:

**Tier 1 — Initial grading pass.** Two independent passes produce `regrade_batch_NN_graded.json` (e.g., ChatGPT) and a primary pass (e.g., Claude via this skill). Both apply the same methodology.

**Tier 2 — Diff the two passes.** For each bet:
- If both agree on result → accept.
- If one says `unknown` and the other has specific evidence → adopt the specific-evidence verdict IF the evidence is from the whitelist and the date matches (see `anti-patterns.md` §Wrong-date attribution).
- If results conflict (e.g., WIN vs LOSS) or both say `unknown` → escalate to Tier 3.

**Tier 3 — Gemini tiebreaker / deeper research.** For escalated bets:
- Send only the disputed bet IDs + descriptions + target dates to Gemini
- Ask a narrow question: "For bet X, is the claim Y supported by official sources? Quote verbatim."
- Gemini's output is treated as **evidence, not authority**. If Gemini returns `first_to_20: null` or "insufficient data", the bet stays `unknown` — don't assume Gemini got it and Claude missed something.
- If Gemini provides a specific quote from a whitelisted source, re-verify by direct `web_fetch` on the cited URL. This catches Gemini's known failure modes (hallucinated quotes, wrong-date attribution).

**Tier 4 — Direct PBP / box-score fetch.** If Gemini can't resolve a leg and the bet is high-value, fetch the play-by-play or box score directly (e.g., `cbssports.com/nba/gametracker/playbyplay/NBA_YYYYMMDD_AWAY@HOME/`). This is the highest-confidence source but most time-expensive.

**Applied example — Race-to-20 parlay (Batch 07, bet `ecd0d2c2`):**
- Tier 1: Claude initial pass → `unknown` (can't resolve Portland leg without PBP)
- Tier 2: Second grader agreed unknown
- Tier 3: Gemini resolved 3 of 5 legs, returned `null` for Portland
- Tier 4: Direct `web_fetch` on CBS PBP page → confirmed Blazers reached 20 first (Avdija 3PT at 6:22 Q1) → flipped bet to WIN +4.31u

**Anti-pattern:** Do not treat Gemini as an oracle. Re-verify its cited quotes by fetching the source. Gemini has all the same failure modes this skill codifies — wrong-date attribution, hallucinated quotes, missed evidence.

### 4. Produce the merged final JSON

Write a flat array (no wrapper) of 25 entries to `graded_batch_NN_final.json` in `/home/claude/` (the working directory), then `present_files` to the user so they can download. Do not write to `/mnt/user-data/uploads` — that's read-only.

### 5. Report totals

After the final JSON is saved, compute and present:
- **This batch**: `X graded / Y unknown`, `breakdown: {win, loss, unknown}`, `net P&L`
- **Running totals table** (all batches to date) with grade rate and cumulative P&L
- **New patterns learned** — any methodology updates that should be added to `references/methodology.md`

### 6. Update the skill (if applicable)

If this batch surfaced a new pattern or anti-pattern, update `references/methodology.md` before closing the session. The methodology doc is the P2b agent's future system prompt — every lesson that doesn't get written down is a bug that will recur in production.

## Output format (reporting to user)

Keep reporting concise. Smokke processes fast — no preamble.

```
## Batch NN locked

**{W}W / {L}L / {U} unknown, net {P}u.**

[1–2 line summary — highlight any bets that flipped from the parallel grader's call and why.]

## Running totals (N of N batches)

| Batch | Graded | Net P&L | Unknown |
|---|---|---|---|
| ...   | ...    | ...     | ...     |
| **Total** | **X/Y** | **Zu** | **U** |

{grade rate}% grade rate.

## New patterns for roadmap

1. [Any new lesson discovered in this batch]
2. ...

## Next

Ready for Batch N+1? Want the updated pull-batch.js?
```

## Common anti-patterns to avoid

See `references/anti-patterns.md` for the full list. Top three that bite in almost every batch:
1. **Wrong-date attribution** — citing a stat line from the wrong game date. Anchor to `created_at` in ET, then apply capper class anchoring.
2. **Hallucinated evidence quotes** — fabricating a quote that sounds plausible. Every `evidence_quote` must be copy-pasted from a real source.
3. **Over-voiding** — marking as `unknown` when one confirmed failed leg already settles a parlay as LOSS.

## For the P2b production agent

When lifting this skill into the P2b Grader Agent:
- **Use** `references/methodology.md`, `references/capper-classes.md`, `references/evidence-whitelist.md`, `references/output-schema.md`, `references/anti-patterns.md` as the agent's system prompt (concatenate them)
- **Do NOT include** this SKILL.md body — it's written for a human-guided session workflow, not autonomous grading
- **Add** production-only constraints the agent needs: cost budget per bet, fallback to `unknown` on any tool timeout, write to `grade_audit` table instead of JSON
