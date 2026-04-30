# Code tab task: Fix HRB silent-drop (defect 1) + add diagnostic instrumentation

You are working in the repo at `~/Documents/discord/`. Production app: `bettracker-discord-bot` on Fly.io.

## Background context (read first)

Read **ERRATA-2** in `skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md` before doing anything else. The previous prompt at `prompts/datdude-fix.md` was based on a wrong call-path diagnosis (it pointed at `parseBetSlipImage`, which is dead code) and was correctly halted before any code shipped. ERRATA-2 documents the corrected diagnosis. **Do not re-execute `datdude-fix.md`.**

Two defects were identified for the HRB silent-drop in `#datdude-slips`:

- **Defect 1 (this deploy):** `handlers/messageHandler.js:1084` uses strict equality `parsed.is_bet === false`. When `parseBetText` returns from its Type 1 Bet path with `is_bet` undefined and `bets:[]` (because `normalizeBet` filtered every bet out for empty top-level description), the strict check fails, no `dropAll` fires, the next `if (parsed.bets?.length > 0)` is also false, and the message exits silently with PARSED as the last event. Fix in this deploy.
- **Defect 2 (next deploy):** `services/ai.js:868-906` Gemma gate only checks for empty `legs`, not empty top-level `description`. AI returns `bets:[{description:"", legs:[<populated>]}]` → gate skips → `normalizeBet` strips → silent path. The fix requires raw-payload data we don't have yet — that's what the instrumentation in this deploy is designed to capture. Defect 2 lands next deploy once we have AI_RESPONSE_RAW + NORMALIZE_INPUT samples confirming the empty-description hypothesis.

This deploy = defect 1 fix + instrumentation. **No defect 2 work.**

## Deliverables (in order)

### Deliverable 1 — Defect 1 fix in `handlers/messageHandler.js`

Edit `handlers/messageHandler.js` around line 1084. Read lines 1080–1095 first to confirm the current shape; the fix must drop in cleanly between the ticket_status block (line 1041) and the `if (parsed.bets?.length > 0)` block (line 1090).

Two changes, in order:

**Change 1.1: loosen the `is_bet === false` check and use a NEW drop reason.**

Current:
```javascript
// Not a bet — silently ignore
if (parsed.is_bet === false) {
  console.log(`[Filter] AI rejected as non-bet: ${cleanText.substring(0, 60)}...`);
  dropAll('DROPPED', 'PRE_FILTER_NO_BET_CONTENT', { filter: 'ai_is_bet_false', sample: cleanText.slice(0, 80) });
  return;
}
```

Replace with:
```javascript
// AI explicitly said not-a-bet OR returned a shape with undefined is_bet
// (Type 1 Bet path returns { type:'bet', bets:[] } with no is_bet field
// when normalizeBet filters every bet out — see ERRATA-2.)
if (parsed.is_bet !== true) {
  console.log(`[Filter] AI response not a confirmed bet (is_bet=${parsed.is_bet}): ${cleanText.substring(0, 60)}...`);
  dropAll('DROPPED', 'PRE_FILTER_AI_RESPONSE_NOT_A_BET', {
    filter: 'ai_is_bet_not_true',
    is_bet_value: parsed.is_bet === undefined ? 'undefined' : String(parsed.is_bet),
    parsedType: parsed.type || null,
    betCount: parsed.bets?.length || 0,
    sample: cleanText.slice(0, 80),
  });
  return;
}
```

Notes on the new reason:
- Use `'PRE_FILTER_AI_RESPONSE_NOT_A_BET'` (NEW). Do NOT reuse `'PRE_FILTER_NO_BET_CONTENT'` — that bucket is for messages dropped before the AI ever ran (text length, settled markers, evaluateTweet pre-check). Conflating them makes pipeline_drops-24h unreadable.
- The new reason is NOT in the canonical `DROP_REASONS` array in `services/pipeline-events.js`. That's fine — `writeRow` doesn't validate against the enum (verified: no SQL CHECK constraint, the array is documentation). `services/pipeline-events.js` is **out of scope per the hard rules** — do not edit it.
- The Type 4 ignore branch in `services/ai.js:935-939` returns `is_bet: false` explicitly, so the loose check still catches the explicit-ignore case. Both `false` and `undefined` now get the same drop reason, which is correct: from the user's perspective both are "the AI said no."

**Change 1.2: add a second guard right after Change 1.1.**

Immediately after the `if (parsed.is_bet !== true) { ... return; }` block, before the existing `if (parsed.bets?.length > 0) {` block at line 1090, add:

```javascript
// Defense-in-depth: is_bet was true but bets array is empty.
// Should not happen with the current parseBetText paths (Type 1 always
// produces non-empty bets when is_bet is true), but if normalizeBet's
// behavior changes or a future return shape forgets to set is_bet=false
// on empty bets, this prevents another silent exit.
if (!parsed.bets || parsed.bets.length === 0) {
  console.log(`[Filter] AI claimed is_bet=true but returned zero bets: ${cleanText.substring(0, 60)}...`);
  dropAll('DROPPED', 'PRE_FILTER_AI_RETURNED_ZERO_BETS', {
    filter: 'is_bet_true_but_no_bets',
    parsedType: parsed.type || null,
    sample: cleanText.slice(0, 80),
  });
  return;
}
```

This guard closes the silent-exit hole permanently regardless of how defect 2 (Gemma gate blind spot) is resolved later. If the gate is fixed in the next deploy and Gemma rescues these cases, this guard becomes unreachable on the rescue path — but it remains as a safety net for any future shape that bypasses both checks.

After both changes the order is: ticket_status branch (existing) → is_bet !== true branch (new) → bets.length === 0 branch (new) → bets.length > 0 main bet creation block (existing).

### Deliverable 2 — Diagnostic instrumentation in `services/ai.js parseBetText`

Edit `services/ai.js` `parseBetText` (line 782). Six new `recordStage` calls at the points listed below. Each MUST include the correlation context derived from `options` so they can be filtered later. **Do NOT add instrumentation to `parseBetSlipImage` — it's dead code per ERRATA-2, instrumenting it produces no production data.**

If `recordStage` and `makeIngestId` are not already imported into `services/ai.js`, add the import:
```javascript
const { recordDrop, recordStage, makeIngestId } = require('./pipeline-events');
```
(`recordDrop` is already imported at line 9 — extend that destructure rather than adding a new line.)

**Threading context from messageHandler:** `parseBetText` currently accepts `options = {}`. Add support for `options.messageId`, `options.channelId`, `options.authorId`. Existing callers pass `{ imageUrl }` or `{ tweetId, imageUrl }` — those keep working unchanged. Update the three `messageHandler.js` callers to pass context too:

- `handlers/messageHandler.js:478` (inside `processSlipImage`): change `parseBetText(prompt, imageUrl, { imageUrl })` to `parseBetText(prompt, imageUrl, { imageUrl, channelId: opts.channelId, authorId: capperId, messageId: opts.messageId })`
- `handlers/messageHandler.js:949` (inside `processAggregatedMessage` single-image branch): change `parseBetText(textPrompt, imageUrl, { imageUrl })` to `parseBetText(textPrompt, imageUrl, { imageUrl, channelId: message.channel?.id, authorId: message.author?.id, messageId: message.id })`
- `handlers/messageHandler.js:960` (inside `processAggregatedMessage` multi-image loop): same pattern as 949 with the loop's `imageUrls[i]`
- `handlers/messageHandler.js:649` (the no-image text path): change `parseBetText(cleanText)` to `parseBetText(cleanText, null, { channelId: message.channel?.id, authorId: message.author?.id, messageId: message.id })`
- `services/twitter-handler.js:137` is **out of scope per hard rules** — do not modify. The instrumentation falls back gracefully when `messageId` is absent (see helper below).

Inside `parseBetText`, near the top of the function (after the `if (!imageUrl) { regex fast-path }` block at line 784–790), build a shared event-context helper once so the six new calls don't repeat themselves:

```javascript
const evtCtx = options.messageId
  ? {
      ingestId: makeIngestId('discord', options.messageId),
      sourceType: 'discord',
      sourceRef: options.messageId,
    }
  : null;
```

Wrap every new `recordStage` call in `if (evtCtx) { recordStage({ ...evtCtx, ... }) }`. When the caller didn't pass `messageId` (e.g., twitter-handler), `evtCtx` is null and the instrumentation no-ops. This avoids polluting pipeline_events with `null` ingestIds, which `writeRow` would silently drop anyway (line 86 of `services/pipeline-events.js`: `if (!ingestId && sourceType !== 'grading') return;`).

**The six instrumentation points:**

1. **`AI_RESPONSE_RAW`** — immediately after `let raw = await callLLM(...)` at line 866, **before** the gate at 868. Capture the raw response (truncated):
```javascript
if (evtCtx) {
  recordStage({
    ...evtCtx,
    stage: 'AI_RESPONSE_RAW',
    eventType: 'STAGE_ENTER',
    payload: {
      hasRaw: !!raw,
      rawLen: typeof raw === 'string' ? raw.length : 0,
      rawSnippet: typeof raw === 'string' ? raw.slice(0, 2000) : null,
      hasImage: !!imageBase64,
      source: 'parseBetText',
    },
  });
}
```
The `safeJson` truncation in `pipeline-events.js:71-79` caps payload at 4000 chars total — `rawSnippet` of 2000 leaves room for the wrapping JSON. Verify by inspection that the truncation doesn't lose the snippet entirely.

2. **`GATE_DECISION`** — at line ~888 immediately after `const shouldFallback = !raw || hasPlaceholder || noLegsFound;`. Inside the existing `if (imageBase64) { ... }` block, before the `if (shouldFallback) { ... }` branch:
```javascript
if (evtCtx) {
  recordStage({
    ...evtCtx,
    stage: 'GATE_DECISION',
    eventType: 'STAGE_ENTER',
    payload: {
      hasRaw: !!raw,
      hasPlaceholder,
      noLegsFound,
      shouldFallback,
      source: 'parseBetText',
    },
  });
}
```

3. **`GEMMA_FALLBACK_TRIGGERED`** — inside the existing `if (shouldFallback) { ... }` block at line 889, after the existing `console.log` and BEFORE the `await runGemmaVisionFallback(...)` call. Use the existing `trigger` variable:
```javascript
if (evtCtx) {
  recordStage({
    ...evtCtx,
    stage: 'GEMMA_FALLBACK_TRIGGERED',
    eventType: 'STAGE_ENTER',
    payload: { reason: trigger, source: 'parseBetText' },
  });
}
```

4. **`GEMMA_FALLBACK_RESULT`** — immediately after `const gemmaJson = await runGemmaVisionFallback({...})` returns, before the `if (gemmaJson) {...}` branch at line 899:
```javascript
if (evtCtx) {
  recordStage({
    ...evtCtx,
    stage: 'GEMMA_FALLBACK_RESULT',
    eventType: 'STAGE_ENTER',
    payload: { hasResult: !!gemmaJson, source: 'parseBetText' },
  });
}
```

5. **`NORMALIZE_INPUT`** — at line 942, **before** `applyConfidenceGating(normalizeParsedBets(parsed), text)`. Captures the post-AI / pre-normalize bet shape — this is the data we need to confirm or refute defect 2's empty-description hypothesis:
```javascript
if (evtCtx) {
  const inputBets = Array.isArray(parsed.bets) ? parsed.bets : [];
  recordStage({
    ...evtCtx,
    stage: 'NORMALIZE_INPUT',
    eventType: 'STAGE_ENTER',
    payload: {
      betCount: inputBets.length,
      sampleBet: inputBets[0] ? JSON.stringify(inputBets[0]).slice(0, 500) : null,
      source: 'parseBetText',
    },
  });
}
```

6. **`NORMALIZE_OUTPUT`** — at line 943 (between the `applyConfidenceGating(...)` call and `result.type = 'bet';`). Captures the post-normalize bet count so we can directly observe how many bets `normalizeBet` filters:
```javascript
if (evtCtx) {
  recordStage({
    ...evtCtx,
    stage: 'NORMALIZE_OUTPUT',
    eventType: 'STAGE_ENTER',
    payload: {
      betCount: result.bets?.length || 0,
      source: 'parseBetText',
    },
  });
}
```

The Type 1 Bet path is the only path that reaches NORMALIZE_INPUT/NORMALIZE_OUTPUT — Type 2/3/4 return early. That's intentional: defect 2 only manifests on Type 1, so capturing only that path is sufficient.

### Deliverable 3 — ERRATA-2 footnote

Edit `skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md`. Append at the very bottom of the ERRATA-2 section (after the "Validation pending" subsection, before the `---` separator that precedes Section 1):

```markdown
---

**Update — v[NEW VERSION] / commit [HASH]:** addresses defect 1 (loose `is_bet` check + new `PRE_FILTER_AI_RESPONSE_NOT_A_BET` drop reason + secondary `PRE_FILTER_AI_RETURNED_ZERO_BETS` guard) and adds diagnostic instrumentation to `parseBetText` (AI_RESPONSE_RAW, GATE_DECISION, GEMMA_FALLBACK_TRIGGERED, GEMMA_FALLBACK_RESULT, NORMALIZE_INPUT, NORMALIZE_OUTPUT). Defect 2 (Gemma gate blind spot for empty-description bets) awaits raw payload data captured by AI_RESPONSE_RAW + NORMALIZE_INPUT in this deploy and lands in the next deploy.
```

Replace `[NEW VERSION]` and `[HASH]` after the deploy lands and you have the values.

### Deliverable 4 — Deploy through full DEPLOY_CHECKLIST

This is a `services/ai.js` and `handlers/messageHandler.js` edit. v284, v289, and prior deploys touching `services/` required `--no-cache` rebuilds because the COPY layer goes stale. **Use `--no-cache` from the start.**

Follow `docs/DEPLOY_CHECKLIST.md` all 8 steps. Required outputs in your final report:

- **Step 1**: `git log --oneline -5` and `git diff HEAD~1 services/ai.js handlers/messageHandler.js skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md | head -200`
- **Step 2**: 
  - `grep -n "PRE_FILTER_AI_RESPONSE_NOT_A_BET\|PRE_FILTER_AI_RETURNED_ZERO_BETS" handlers/messageHandler.js` — must show both new drop reasons
  - `grep -n "AI_RESPONSE_RAW\|GATE_DECISION\|GEMMA_FALLBACK_TRIGGERED\|GEMMA_FALLBACK_RESULT\|NORMALIZE_INPUT\|NORMALIZE_OUTPUT" services/ai.js` — must show all six new instrumentation calls
  - `node -c services/ai.js && node -c handlers/messageHandler.js` — must both print OK
- **Step 3**: N/A (no migration)
- **Step 4**: `git push origin main` output
- **Step 5**: `fly releases -a bettracker-discord-bot | head -3`
- **Step 6** (post-deploy verification): post a fresh HRB image in `#datdude-slips` (ask the user to do this — do not attempt yourself), wait 30 seconds, then run:
  ```
  cd ~/Documents/discord/skills/zonetracker-regrade
  bash scripts/run-fly-sql.sh "SELECT created_at, source_ref, stage, event_type, drop_reason, substr(payload, 1, 400) as payload FROM pipeline_events WHERE created_at > strftime('%s','now') - 600 AND source_ref IN (SELECT source_ref FROM pipeline_events WHERE created_at > strftime('%s','now') - 600 AND payload LIKE '%datdude-slips%') ORDER BY created_at ASC, id ASC"
  ```
  
  **Expected events for the test post (in order):**
  - RECEIVED, AUTHORIZED, BUFFERED, EXTRACTED (existing)
  - **AI_RESPONSE_RAW** showing `hasRaw=true`, `rawLen>0`, and the actual AI JSON in `rawSnippet`
  - **GATE_DECISION** showing whether the gate triggered (this is the diagnostic data for defect 2)
  - If `shouldFallback=true`: **GEMMA_FALLBACK_TRIGGERED** + **GEMMA_FALLBACK_RESULT**
  - **NORMALIZE_INPUT** showing the pre-normalize bet count and a serialized first bet (description visibility = direct evidence for defect 2)
  - **NORMALIZE_OUTPUT** showing the post-normalize count
  - PARSED (existing)
  - Then ONE OF:
    - **DROPPED `PRE_FILTER_AI_RESPONSE_NOT_A_BET`** if `is_bet !== true` (defect 1 fix confirmed firing)
    - **DROPPED `PRE_FILTER_AI_RETURNED_ZERO_BETS`** if `is_bet === true` but bets empty (secondary guard firing — also correct)
    - VALIDATED + STAGED (the gate worked, Gemma rescued, bet flowed through)
  
  **Pass criteria:** the test post has at least one terminal DROPPED event OR a STAGED event. **No silent exits.** If the trace ends at PARSED with no follow-up DROPPED/STAGED, the fix didn't take and you should NOT close the deploy as successful — investigate and report.
  
  **Bonus diagnostic (do not gate the deploy on this):** if NORMALIZE_INPUT shows `sampleBet` with empty `description` and populated `legs`, defect 2's empty-description hypothesis is confirmed and the next-deploy fix is locked in. Note the finding in your final report.

- **Step 7**: Run `/health quick` in Discord. Confirm "Bot Pipeline" shows non-zero processing if any bets came in during the deploy window. Confirm no new errors in alerts.
- **Step 8**: `/health quick` showing memory in normal range, no spike.

Build the deploy command with `--no-cache`:
```
fly deploy --local-only --yes --no-cache -a bettracker-discord-bot
```

If the build fails, stop and report — do not retry without diagnosis.

## Hard rules

- Hard rules from `prompts/datdude-fix.md` still apply. Reproduced for clarity:
  - Do NOT delete the existing Gemma gate at `services/ai.js:868-906`. Defect 2's fix is deferred — the gate stays untouched in this deploy.
  - Do NOT modify any code under `services/grading.js`, `services/grading_old.js`, `services/pipeline-events.js`, `services/twitter-handler.js`, or any path outside `services/ai.js`, `handlers/messageHandler.js`, and the retrospective file.
  - Do NOT skip `--no-cache`. v284 and v289 prove this is required.
  - Do NOT push if any DEPLOY_CHECKLIST verification step fails.
  - Do NOT run any DELETE/UPDATE/INSERT against `bettracker.db`.
  - Pre-existing repo dirty state stays unstaged — touch only the three files listed.
- New scope-specific rules:
  - Do NOT add instrumentation to `parseBetSlipImage`. It's dead code per ERRATA-2. Don't waste pipeline_events rows on a function with no live caller.
  - Do NOT change `parseBetText`'s existing return shapes or business logic. Instrumentation is read-only — it observes, it does not transform.
  - Do NOT touch the Type 1 Bet path's `result.type = 'bet'` assignment or the absence of `result.is_bet`. Adding `result.is_bet = true` on the Type 1 path would mask defect 1 — defeating the diagnostic purpose. The fix lives in messageHandler, not the parser. (The next-deploy defect 2 fix may revisit this, but not now.)
  - Do NOT widen the `evtCtx` ternary to fall back to `imageUrl`-derived ingest IDs or any synthetic value. If `messageId` is absent, instrumentation no-ops — that's the contract.

## Verification before push

1. Both new drop reasons present and correctly named: `grep -n "PRE_FILTER_AI_RESPONSE_NOT_A_BET\|PRE_FILTER_AI_RETURNED_ZERO_BETS" handlers/messageHandler.js`
2. All six instrumentation stages present: `grep -n "stage: 'AI_RESPONSE_RAW'\|stage: 'GATE_DECISION'\|stage: 'GEMMA_FALLBACK_TRIGGERED'\|stage: 'GEMMA_FALLBACK_RESULT'\|stage: 'NORMALIZE_INPUT'\|stage: 'NORMALIZE_OUTPUT'" services/ai.js`
3. `parseBetSlipImage` is unchanged: `git diff HEAD services/ai.js | grep -A1 "parseBetSlipImage"` should show only the function declaration line (not modified) — instrumentation is in `parseBetText` only.
4. The four `messageHandler.js` callers pass the new context fields: `grep -n "messageId\|channelId\|authorId" handlers/messageHandler.js | grep -v "^[0-9]*:.*//"` should include the four parseBetText call sites.
5. `node -c services/ai.js && node -c handlers/messageHandler.js` — both print OK.
6. The existing gate at `services/ai.js:868-906` is structurally unchanged: `git diff HEAD services/ai.js | grep "^-" | grep -v "^---" | head -20` should show only added lines, no deletions inside the gate block.
7. ERRATA-2 footnote present: `grep -n "v\[NEW VERSION\]\|defect 2 awaits raw payload" skills/zonetracker-regrade/retrospectives/2026-04-datdude-silent-drop.md`

All 7 checks must pass before commit.

## Final report

After Step 8 verifies clean, paste:

- Commit hash and `fly releases` output
- Output of the post-deploy test query showing the new pipeline_events rows
- Whether the test post terminated at DROPPED (with which reason) or STAGED
- The `NORMALIZE_INPUT.sampleBet` value — this is the key diagnostic for defect 2's hypothesis
- Whether `GEMMA_FALLBACK_TRIGGERED` fired
- Anything unexpected encountered

If any deliverable can't complete — a verification check fails, the test post still exhibits a silent exit, the build fails twice with --no-cache, or the AI_RESPONSE_RAW snippet shows a payload shape that contradicts the ERRATA-2 hypothesis — STOP at that step and report. Don't push a half-fix and don't try to derive a defect-2 fix from in-flight data; that's the next deploy's job.
