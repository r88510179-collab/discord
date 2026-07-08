# Output Schema

The final graded batch is a **flat JSON array** (no wrapper object, no metadata, no summary). One entry per bet. Always 25 entries per batch.

## Entry schema

```json
{
  "bet_id": "string (32-char hex, matches the bets.id column)",
  "result": "win | loss | unknown",
  "profit_units": "number | null",
  "grade_reason": "string (1–3 sentences, factual, no hedging)",
  "evidence_url": "string (from the whitelist) | null",
  "evidence_source": "espn_mlb | espn_nba | espn_nhl | espn_soccer | nba_com | mlb_com | nhl_com | atp_official | cbssports_nba_pbp | ... | null",
  "evidence_quote": "string (verbatim from evidence_url) | null"
}
```

## Field rules

### `bet_id`
Always 32 hex chars. Copy exactly from the batch input file. Do NOT truncate to 12 chars in the output — truncation is only for display/logs.

### `result`
One of:
- `"win"` — all legs verified to have cleared
- `"loss"` — at least one leg verifiably failed (for parlays), or single bet failed
- `"unknown"` — evidence insufficient to settle

Do NOT use: `"pending"`, `"push"`, `"void"`, `"graded"`, or any other value. A pushed leg in a parlay is handled by `profit_units` calculation, not by a separate status.

### `profit_units`
- For `win`: positive number = wager × (odds to decimal – 1). See formula below.
- For `loss`: negative number = -wager (just the loss of the staked units)
- For `unknown`: `null`
- For `win` with missing odds: `null` (reason must mention "odds missing, profit cannot be computed")

#### Profit formulas
Given American odds and wager in units:

```
if odds > 0:   profit = wager × (odds / 100)
if odds < 0:   profit = wager × (100 / |odds|)
```

Examples:
- 1u at +100 → profit = 1.00
- 1u at +431 → profit = 4.31
- 5u at -175 → profit = 5 × (100/175) = 2.857
- 1u at -110 → profit = 0.909
- 3u at -115 → profit = 2.609

Round to 4 decimal places in the stored JSON. Display to 2 decimals in user-facing summaries.

### `grade_reason`
1–3 factual sentences. Structure:
1. What the final score/stat line was
2. Why that does or doesn't hit the bet
3. (For parlays) Which specific leg failed and why the rest doesn't matter

No hedging language. No "likely", "appears to have", "probably". If there's uncertainty, the result is `unknown` and the reason explains what couldn't be verified.

### `evidence_url`
A URL from the whitelist in `evidence-whitelist.md`. One URL per bet — the most authoritative single source. If multiple sources were consulted, pick the Tier 1 one.

For `unknown`: `null`.

### `evidence_source`
A short slug identifying the source type. Use the established slugs:
- `espn_mlb`, `espn_nba`, `espn_nhl`, `espn_soccer`, `espn_tennis`, `espn_golf`, `espn_mma`
- `nba_com`, `mlb_com`, `nhl_com`
- `atp_official`, `wta_official`
- `cbssports_nba_pbp` (specifically for play-by-play pages used for race-to-N / exact timing)
- `pga_tour`, `ufc_com`
- `baseball_savant`
- `rotowire`, `statmuse` (Tier 2 — use only when a Tier 1 isn't available)

For `unknown`: `null`.

### `evidence_quote`
A verbatim copy-paste from the `evidence_url`. Between 5 and 200 characters. No ellipsis in the middle unless the original had one.

For `unknown`: `null`.

**Anti-pattern**: do not write "Player X scored 19 points" as the quote if the source said "James finished with 19 points". Use the exact source wording.

## File naming

`graded_batch_NN_final.json` where `NN` is the two-digit batch number. Store in `/home/claude/` (the working directory), then `present_files` to share with the user.

Do NOT name it `graded_batch_NN.json` (no `_final`) — that collides with parallel grading passes (ChatGPT's output, etc.) and causes confusion when reconciling.

## Validation before saving

Before calling `present_files`, verify:
1. Array has exactly 25 entries
2. Every `bet_id` is 32 hex chars
3. Every `result` is one of `win` / `loss` / `unknown`
4. For `win`: `profit_units` is positive OR `null` (with odds-missing reason)
5. For `loss`: `profit_units` is negative
6. For `unknown`: `profit_units` is `null`, and all three evidence fields are `null`
7. No `evidence_quote` exceeds 200 chars
8. Sum of `profit_units` (excluding nulls) rounds sensibly — if net P&L is > |100u| with 25 bets, double-check a leg for decimal/unit misread

A simple Python validation script:

```python
import json, re

d = json.load(open('/home/claude/graded_batch_NN_final.json'))
assert len(d) == 25, f'Expected 25 entries, got {len(d)}'
for b in d:
    assert re.match(r'^[0-9a-f]{32}$', b['bet_id']), f'Bad bet_id: {b["bet_id"]}'
    assert b['result'] in ('win', 'loss', 'unknown'), f'Bad result: {b["result"]}'
    if b['result'] == 'win':
        assert b['profit_units'] is None or b['profit_units'] > 0
    elif b['result'] == 'loss':
        assert b['profit_units'] < 0
    elif b['result'] == 'unknown':
        assert b['profit_units'] is None
        assert b['evidence_url'] is None
        assert b['evidence_source'] is None
        assert b['evidence_quote'] is None
    if b.get('evidence_quote'):
        assert len(b['evidence_quote']) <= 200

print('OK')
```
