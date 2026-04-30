# DatDude `#datdude-slips` silent-drop debug — investigation

**Date:** 2026-04-30
**Production target:** `bettracker-discord-bot` on Fly (machine v330, iad).
**Tooling baseline:** migration 018 + 021 (`pipeline_events`), shipped in v289 on 2026-04-17.
**Scope:** read-only investigation. No code changes proposed for this session — fix proposal documented but not written.

> **Bottom line up front.** The original premise (ig-dave-picks works, datdude-slips silently drops) is partially out-of-date. Both channels currently fail to produce bets. Vision AI returns `is_bet: false` ("ignore") for Hard Rock Bet share images framed by HRB boilerplate text, and the existing Gemma vision fallback does not trigger on the `ignore` verdict — so suspected bets die at the AI without reaching war-room. The instrumentation does record this as `PRE_FILTER_NO_BET_CONTENT / ai_is_bet_false`, so the drops are no longer silent in `pipeline_events`, just silent in the user's perception.

---

## Section 1 — Tooling validation

`pipeline_events` is healthy. Schema and counts confirmed via the new helper `skills/zonetracker-regrade/scripts/run-fly-sql.sh` (readonly, blocks DDL/DML at the client before sending to Fly).

**Schema** (10 cols, post-migration 021):

| col | type | notnull |
|---|---|---|
| id | INTEGER | PK |
| ingest_id | TEXT | nullable (021) |
| bet_id | TEXT | nullable |
| source_type | TEXT | NOT NULL |
| source_ref | TEXT | nullable |
| stage | TEXT | NOT NULL |
| event_type | TEXT | NOT NULL |
| drop_reason | TEXT | nullable |
| payload | TEXT | nullable (JSON) |
| created_at | INTEGER | unix epoch |

There is **no `channel_id` column.** For `source_type='discord'`, `source_ref` is the Discord message id and `channelId` is embedded in the `payload` JSON (only at RECEIVED / AUTHORIZED / BUFFERED — post-buffer stages omit it). Cross-stage channel attribution requires joining via `source_ref → RECEIVED.payload.channelId`.

**Row counts:**
- Last 24h: **1,081** rows
- Last 7d: **6,322** rows
- All-time: **10,673** rows
- Earliest event: `2026-04-17 20:40:01` UTC (matches v289 deploy)
- Latest event: `2026-04-30 03:45:30` UTC (live)

**Event types (24h):** `DROP=544`, `STAGE_ENTER=493`, `STAGE_EXIT=44`. Drop volume slightly exceeds enter — explained by drops emitted "for every underlying source_ref in the buffer" via the `dropAll` helper (handlers/messageHandler.js:885).

**Stages observed (24h):** `GRADING_AI=362`, `RECEIVED=181`, `DROPPED=128`, `AUTHORIZED=96`, `PARSED=74`, `EXTRACTED=68`, `GRADING_DROPPED=54`, `BUFFERED=52`, `STAGED=33`, `VALIDATED=33`. Both ingest-side and grading-side stages are firing.

**Source types (24h):** `discord=520`, `grading=416`, `twitter=145`. Discord ingest is the dominant traffic.

Tooling is sound. Investigation proceeds on solid evidence.

---

## Section 2 — Channel divergence query

Side-by-side, all-time (since v289):

| metric | `#datdude-slips` (1355182920163262664) | `#ig-dave-picks` (1473347391284576469) |
|---|---|---|
| `pipeline_events` rows total | **0** | 15 |
| Distinct messages (source_ref) | 0 | 5 |
| RECEIVED events | 0 | 5 |
| AUTHORIZED events | 0 | 5 |
| BUFFERED events | 0 | 5 |
| EXTRACTED events | 0 | 5 |
| PARSED events | 0 | 5 |
| DROP events | 0 | 5 (all post-PARSED) |
| Bets created (all-time) | 1 (2026-04-13, pre-v289) | 1 (2026-04-06, pre-v289) |
| Bets created since v289 | **0** | **0** |

**Interpretation.** The divergence the user observed is real, but the framing of "ig-dave-picks works, datdude-slips drops" no longer holds: **both channels are silently dropping every post since v289 deployed**, just with different observability.

- ig-dave-picks: 5 datdudestill posts entered the pipeline, all reached Vision AI, all dropped at the AI / validator stage. Drop reasons are now visible in `pipeline_events`.
- datdude-slips: 0 events period. Either DatDude has not posted in that channel since 2026-04-17, or messages are being lost upstream of `recordStage('RECEIVED')` (which is the very first line of `handleMessage`, before any guard). The backlog claim that "MessageHandler.ENTRY fires for both channels" was almost certainly observed pre-v289 and has not been re-verified against `pipeline_events`.

The original "Vision AI fires successfully but no bet appears" hypothesis is contradicted by the data: in 4 of 5 ig-dave-picks messages, Vision AI **does not** classify the image as a bet (`type: 'ignore', is_bet: false`).

---

## Section 3 — Sample bet traces

Only 5 message traces exist in scope. **No traces are available for `#datdude-slips`** — the channel has zero `pipeline_events` rows since instrumentation began. This is a finding, not a tooling gap: the entry-side instrumentation works, it just has nothing to record.

### IG-DAVE-PICKS traces (all 5)

```
Bet correlation key: 1494838529489113309
Channel:             #ig-dave-picks
Posted at:           2026-04-17 23:14:38 UTC
Events:
  - 23:14:38 RECEIVED         author=datdudestill ch=ig-dave-picks
  - 23:14:38 AUTHORIZED       guardReason=human_ok
  - 23:14:38 BUFFERED         author=datdudestill
  - 23:14:42 EXTRACTED        imageCount=2
  - 23:14:49 PARSED           type=ignore  isBet=false  betCount=0  ticketStatus=new
  - 23:14:49 DROPPED          PRE_FILTER_NO_BET_CONTENT (filter=ai_is_bet_false)
                              sample="Check out this bet I placed on Hard Rock Bet! ..."
Final state:         No bet created. Dropped at AI is_bet=false.

Bet correlation key: 1494838586208686283
Channel:             #ig-dave-picks
Posted at:           2026-04-17 23:14:52 UTC
Events:              same shape — terminal DROPPED PRE_FILTER_NO_BET_CONTENT (ai_is_bet_false)
Final state:         No bet created.

Bet correlation key: 1495523550801694842
Channel:             #ig-dave-picks
Posted at:           2026-04-19 20:36:40 UTC
Events:              same shape — terminal DROPPED PRE_FILTER_NO_BET_CONTENT (ai_is_bet_false)
Final state:         No bet created.

Bet correlation key: 1495523909972267221
Channel:             #ig-dave-picks
Posted at:           2026-04-19 20:38:05 UTC
Events:
  - 20:38:05 RECEIVED → AUTHORIZED → BUFFERED
  - 20:38:09 EXTRACTED  imageCount=2
  - 20:38:16 PARSED     type=bet  isBet=true  betCount=1  ticketStatus=new
  - 20:38:16 DROPPED    VALIDATOR_ENTITY_MISMATCH
                        keyWords=[aaron, record, threes, made, deni]
                        issue="No key entities from bet found in source text"
Final state:         No bet created. AI extracted a bet from the image,
                     but validator killed it because the bet's entities
                     do not appear in the source text (HRB share boilerplate).

Bet correlation key: 1495915664718954628
Channel:             #ig-dave-picks
Posted at:           2026-04-20 22:34:47 UTC
Events:              same shape as msg 1 — terminal DROPPED PRE_FILTER_NO_BET_CONTENT
Final state:         No bet created.
```

### DATDUDE-SLIPS traces

None. Zero `pipeline_events` rows for this channel since v289 deploy.

The single all-time bet from this channel (`a498c1008b111304ec27727e16be60d3`, source_message_id `1493331402098343986`, 2026-04-13 19:25:59) predates the instrumentation by four days.

**Anchor data point.** The single ig-dave-picks bet that **did** succeed (2026-04-06, source_message_id `1490824276914212926`) has `raw_text: "Check out this bet I placed on Hard Rock Bet!"` — **identical** to the boilerplate in all 5 failed messages. Vision AI is non-deterministic on this exact-shape input: same wrapper, same author, same channel, but only 1 of 6 historical attempts produced a bet.

---

## Section 4 — Source code review

Read-only. No edits.

### 4.1 Pre-buffer entry path is sound

`handleMessage` at [messageHandler.js:668](handlers/messageHandler.js:668) emits RECEIVED on line 671 — the very first action, before any guard or filter. If a Discord MessageCreate event reaches `bot.js → handleMessage(message)`, RECEIVED fires. There is no code path between `client.on(Events.MessageCreate, …)` ([bot.js:245](bot.js:245)) and `recordStage(RECEIVED)` other than the IGNORED_CHANNELS fast-path ([bot.js:247](bot.js:247)) — and `1355182920163262664` is **not** in `IGNORED_CHANNELS` per prod env. So zero RECEIVED events for datdude-slips means **no messages have reached the bot from that channel since v289**, OR Discord is not delivering messages from that channel to the bot's gateway.

### 4.2 Buffer keying — no collision possible

[messageHandler.js:29](handlers/messageHandler.js:29):
```js
const key = `${message.author.id}:${message.channel.id}`;
```
Buffer is keyed by `(authorId, channelId)`. Same author posting in two different channels uses two distinct keys — no cross-channel collision. **H1 falsified.**

### 4.3 Vision-AI ignore verdict bypasses the Gemma fallback

[services/ai.js:874–906](services/ai.js:874): the `parseBetText` vision fallback decides whether to retry with Gemma+Cerebras based on:
- `!raw` → fallback
- `hasPlaceholder` (e.g. "missing legs", "capper hid") → fallback
- `noLegsFound` (computed only when `quick.type === 'bet'` or `quick.is_bet === true`) → fallback

When the primary returns `{type: 'ignore', is_bet: false, bets: []}`, **none** of these triggers fire. The `noLegsFound` block is gated on `quick.type === 'bet' || quick.is_bet === true` — so an `ignore` verdict skips the check entirely. There is no fallback for "AI dismissed the image as non-bet."

This is the root cause of 4/5 ig-dave-picks drops.

### 4.4 Validator entity check ignores `hasMedia`

[services/ai.js:1288–1304](services/ai.js:1288): `validateParsedBet` runs an entity-mismatch check against `sourceText`:
```js
if (src.length > 10 && desc.length > 10) {
  const betWords = desc.match(/\b[a-z]{4,}\b/g) || [];
  const NOISE = new Set([...]);
  const keyWords = betWords.filter(w => !NOISE.has(w) && w.length >= 4);
  if (keyWords.length >= 2) {
    const matchCount = keyWords.filter(w => src.includes(w)).length;
    if (matchCount === 0) {
      issues.push(`No key entities from bet found in source text. Bet words: [${keyWords.slice(0, 5).join(', ')}]`);
      maybeDrop('entity_mismatch', 'VALIDATOR_ENTITY_MISMATCH', { keyWords: keyWords.slice(0, 5) });
      return { valid: false, issues, reason: 'entity_mismatch' };
    }
  }
}
```

The brand-name check **just below** at lines 1314–1336 honours `hasMedia` via `brandExempt`. The entity-mismatch check above does not. For HRB image shares the source text is "Check out this bet I placed on Hard Rock Bet! …" and the bet entities live in the image — so `matchCount === 0` is guaranteed, even when the AI correctly extracted the bet. This killed message `1495523909972267221`.

### 4.5 Three early returns in `processAggregatedMessage` lack instrumentation

[messageHandler.js:990, 1035, 1080](handlers/messageHandler.js:990):
- line 990: `await autoGradeBet(...); return;` after `parsed.type === 'result'` — no `pipeline_event` emitted on return.
- line 1035: `await sendUntrackedWinEmbed(...); return;` after `parsed.type === 'untracked_win'` — no event emitted.
- line 1080: `return;` after the recap/ticket-status auto-grade branch — no event emitted, even though the function may have just graded N bets.

These are not the cause of the current drops (none of the 5 ig-dave-picks messages reached these branches — `parsed.type='ignore'` and `parsed.type='bet'` were the only outcomes seen) but they are real instrumentation blind spots that would resurface as "silent drop" reports the next time someone posts a result/celebration/recap shape.

### 4.6 No channel-specific branching

`grep -n "1355182920163262664\|1473347391284576469\|datdude\|ig-dave\|IgDave\|DatDude" services/*.js handlers/*.js commands/*.js bot.js` returns only two comment lines in [bot.js:212](bot.js:212) and [bot.js:215](bot.js:215). No conditional logic anywhere in the production path branches on either channel id or capper name. **H2 falsified at the code level.**

---

## Section 5 — Hypothesis ranking

| # | Hypothesis | Likelihood | Rationale | Falsification test |
|---|---|---|---|---|
| H1 | Buffer key collision between two channels by same author | **L** | Buffer key includes `channelId`; impossible to collide cross-channel. ([messageHandler.js:29](handlers/messageHandler.js:29)) | Add a temporary log of `messageBuffer.size` and key set on each `bufferMessage` call; observe two simultaneous keys when DatDude posts to both channels. |
| H2 | Channel-specific branch in some downstream gate | **L** | No code references either channel id; all per-channel config (humans, picks, capper map) is symmetric. | grep already done, returns nothing. |
| H3 | Race condition: vision result arrives after war-room embed for the other channel | **L** | Channels are processed independently; no shared buffer or shared parsed-result store. | N/A — already excluded by code structure. |
| H4 | Vision AI returns `type: 'ignore'` for HRB image shares; Gemma fallback doesn't trigger on ignore verdict | **H** | 4 of 5 traced messages dropped here. Gemma fallback gate at [services/ai.js:879](services/ai.js:879) excludes `type: 'ignore'`. | Force-feed an HRB share image+text to `parseBetText` with logging of fallback triggers; expect Gemini→ignore, no fallback. |
| H5 | DatDude has not posted in `#datdude-slips` since v289 deployed (or bot is not receiving from that channel) | **H** | Zero `pipeline_events` rows since 2026-04-17; backlog "ENTRY fires" claim was not re-verified post-v289. | User posts a fresh test message in `#datdude-slips`; check for a RECEIVED `pipeline_event` within seconds. |
| H6 | `validateParsedBet` entity-mismatch check ignores `hasMedia` and kills image-only bets | **M** | Killed 1 of 5 ig-dave-picks messages. Brand check on the same function honours `hasMedia`; entity check inconsistently does not. | Patch `if (src.length > 10 && desc.length > 10 && !hasMedia)` and replay the dropped message via offline harness. |

H4 and H5 are the load-bearing hypotheses. H4 is observable in the data; H5 needs a fresh test post.

---

## Section 6 — Proposed minimal fix (NOT WRITTEN)

**Primary fix — H4.** Trigger the existing Gemma+Cerebras vision fallback when:
- an image was provided, AND
- the primary returned `type: 'ignore'`, AND
- the source text contains a known sportsbook share URL (HRB, DK, FanDuel, Caesars, BetMGM, PrizePicks, Underdog).

**File / line:** [services/ai.js:879–887](services/ai.js:879).

Current code (lines 879–887):
```js
if (raw && !hasPlaceholder) {
  try {
    const quick = parseJSON(raw);
    if (quick && (quick.type === 'bet' || quick.is_bet === true)) {
      const bets = Array.isArray(quick.bets) ? quick.bets : [];
      noLegsFound = bets.length === 0 || !bets.some(b => Array.isArray(b.legs) && b.legs.length > 0);
    }
  } catch (_) {}
}
```

Proposed code (same range):
```js
if (raw && !hasPlaceholder) {
  try {
    const quick = parseJSON(raw);
    if (quick && (quick.type === 'bet' || quick.is_bet === true)) {
      const bets = Array.isArray(quick.bets) ? quick.bets : [];
      noLegsFound = bets.length === 0 || !bets.some(b => Array.isArray(b.legs) && b.legs.length > 0);
    }
    // Image present + AI says ignore + source text has a sportsbook
    // share URL → high-confidence the bet lives in the image and the
    // wrapper text fooled the anti-promo rule. Force the Gemma chain.
    if (quick && quick.type === 'ignore'
        && /share\.hardrock\.bet|draftkings\.com|sportsbook\.fanduel\.com|caesars\.com\/sportsbook|betmgm\.com|prizepicks\.com|underdogfantasy\.com/i.test(text || '')) {
      noLegsFound = true;
    }
  } catch (_) {}
}
```

**Why this fixes the divergence.** The 4 dropped HRB-share messages all match this condition (image + `type: 'ignore'` + `share.hardrock.bet` in text). Forcing the fallback runs Gemma→Cerebras on the image, which is a separate pipeline less prone to the anti-promo bias.

**New `pipeline_event` to add post-deploy.** When fallback runs, emit a `recordStage` at stage `EXTRACTED` with `payload.fallback='gemma_chain_forced'` so the new path is observable. (Suggested addition; not part of the minimal one-block change above.)

**Risk / blast radius.**
- The fallback is already in production for null/placeholder/no-legs cases. Adding one more trigger only changes which messages enter it; it does not alter what the fallback does.
- Cost: a few extra Gemma+Cerebras calls for sportsbook-share-URL messages that the primary classified as ignore. Volume is low (current rate ≈ 1–2/day across all channels per the 5 ig-dave-picks traces over 4 days).
- Regression risk: minimal. Other cappers (Twitter relays via `TWITTER_CAPPER_MAP`) post text containing the actual bet entities, not a sportsbook share URL — they will not match the regex and their behavior does not change.
- Cross-channel impact: applies to any channel where users post HRB / DK / FanDuel share URLs. Likely beneficial across the board.

**Secondary fix — H6 (one-liner).** [services/ai.js:1289](services/ai.js:1289) — add `&& !hasMedia` to the outer guard so the entity-mismatch check is skipped on image-bearing messages, paralleling the brand-exempt path. This salvages bets where Vision AI succeeded but the wrapper text doesn't echo the bet entities. Lower priority than H4 (1 of 5 vs 4 of 5), can ship in the same PR or as a follow-up.

**Out of scope for this fix.** The three uninstrumented early returns at messageHandler.js:990, 1035, 1080 are real blind spots but did not cause the observed drops. Filed as Section 7 follow-up rather than bundled into the minimal fix.

---

## Section 7 — Open questions

1. **Has DatDudeStill posted any message in `#datdude-slips` since v289 deployed (2026-04-17)?** Pipeline_events shows zero RECEIVED events for that channel. The "MessageHandler.ENTRY fires" claim in the backlog was almost certainly observed pre-v289. Need either a fresh test post (user-side) or `console.log` greps from Fly logs covering 2026-04-17 onward to confirm whether the gateway is delivering messages from that channel to the bot.
2. **Is the bot's view/read permission on `#datdude-slips` intact at the Discord channel-permissions layer?** Env config (`HUMAN_SUBMISSION_CHANNEL_IDS`, `CAPPER_CHANNEL_MAP`) lists both channel ids, but Discord channel permissions are independent of bot env config. A perms regression would silently stop MessageCreate delivery without any log line. User-side verification.
3. **The `evaluateTweet` pre-filter at [services/ai.js:1092](services/ai.js:1092) currently returns `reject_recap` for plain HRB share boilerplate ("Check out this bet I placed on Hard Rock Bet!").** The call site at [messageHandler.js:937](handlers/messageHandler.js:937) only acts on `reject_settled`, so `reject_recap` doesn't drop. But it's a latent footgun — if a future change starts honouring `reject_recap`, every HRB share will die at the pre-filter. Worth a comment on the call site clarifying intent.
4. **Should H6 (validator `hasMedia` parity) ship in the same PR as the H4 fix, or wait for production data on H4 alone?** Tightly related but independent code paths. Author's call.
5. **The single successful ig-dave-picks bet (2026-04-06) had identical wrapper text to the failed messages.** What changed between 2026-04-06 and 2026-04-17 that flipped Vision AI's behavior on this exact-shape input? Possibilities: prompt update in `parseBetText`, model swap in `callLLM`, or just AI nondeterminism crossing a threshold. `git log services/ai.js` between those dates would narrow it.
6. **Three uninstrumented early returns at processAggregatedMessage — file as a separate cleanup commit?** Specifically:
   - [messageHandler.js:990](handlers/messageHandler.js:990) (autograde result)
   - [messageHandler.js:1035](handlers/messageHandler.js:1035) (untracked_win)
   - [messageHandler.js:1080](handlers/messageHandler.js:1080) (recap auto-grade)
   Each should emit a `recordStage('STAGE_EXIT', payload: { branch: '...', graded: N })` so future "silent drop" reports on result/celebration messages are immediately diagnosable.

---

## Reference — helper script written this session

`skills/zonetracker-regrade/scripts/run-fly-sql.sh` — readonly SQL helper for `bettracker.db` on Fly. Mirrors `pull-single-bet.sh`'s pattern (local JS file → sftp → ssh console node) to avoid quote-escape collisions. Refuses any string containing `INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|TRUNCATE` client-side, before sending to Fly. SQL is base64-encoded into the temp script so it survives nested quoting unchanged. Used for every query in this report.
