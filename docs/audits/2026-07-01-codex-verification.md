# Codex Verification - 2026-07-01 P0/P1 Audit Findings

Pinned HEAD: `e5cbe0e48f99297aa25f59d623594221dc914364` on branch `audit/2026-07-01-codex-verify`.

Scope: independent re-verification of V1-V8 against code at pinned HEAD and live Fly SQLite opened with `better-sqlite3` `{ readonly: true }`. Production DB commands used only `PRAGMA table_info` and `SELECT`; the only remote write was the permitted `/tmp/codex_verify_probe.js` script copy.

## Verdict Table

| Target | Verdict | One-line evidence | Fix adjudication |
|---|---|---|---|
| V1 DP-01 7-day sweeper LOSS | CONFIRMED | `services/grading.js:1691-1692` sets 7d cutoff, `:1721-1722` keys on `created_at`, `:1908` writes `loss`; live DB now shows 61 swept 30d, 61 LOSS, 61 NULL `event_date`, 5 MLB/NBA/NHL. | Agree with sweep-to-VOID + terminal telemetry; prefer VOID over PENDING unless a quarantine owner/SLO exists. |
| V2 T2-01 global graphic auto-grade | CONFIRMED | `handlers/messageHandler.js:667-700` calls global `findPendingBetBySubject`; `services/database.js:254-258` is `LIKE ?` across all confirmed pending bets ordered oldest-first; bankroll updates at `messageHandler.js:703-708`. | Agree, but make fallback `needs_review` instead of terminal grade; require capper scope and recency/date window before any auto-confirm. |
| V3 T1-08 ungated `stmts.gradeBet` | CONFIRMED | `services/database.js:188` defines ungated `UPDATE bets ... WHERE id = ?`; `rg "stmts\\.gradeBet"` finds definition only. | Delete it or route it through `gradeBetRecord`; no behavior risk if removed today. |
| V4 Twitter multi-pick sheet loss | CONFIRMED | `services/twitter-handler.js:184` sends only `imageUrls[0]` to vision; `:187-188` stages only `parsed.bets[0]`. | Agree; loop images and bets, or emit explicit drop rows for discarded images/bets. |
| V5 multi-image fabricated parlay | CONFIRMED | `handlers/messageHandler.js:1423-1428` merges whenever `imageUrls.length > 1 && parsed.bets.length > 1`; `:244-280` turns all bets into one low-confidence parlay. | Agree; `_confidence:'low'` gates to review, but the embed can still one-click ratify the wrong shape. |
| V6 silent terminal writers | CONFIRMED | Sweeper and graphic terminal writes have zero terminal-time `pipeline_events`/`grading_audit` rows in live DB; code paths contain only bet update + logs. | Agree; add `GRADING_COMPLETE`/terminal events and grading audit or equivalent terminal trace for all autonomous writers. |
| V7 event_date NULL rate | CONFIRMED | Live DB split: all bets 3089/3212 NULL-or-empty, 58 ISO datetime, 64 date-only, 1 other; pending 241/263 NULL-or-empty, 17 ISO datetime, 5 date-only. | Agree; event-date coverage is still the upstream blocker for date-keyed defenses. |
| V8 enforce flip verdicts | PARTIAL | Constants collide (`MAX_DEFER_MS` 7d at `grading.js:1009`, sweep 7d at `:1691-1692`) and current swept rows remain all NULL `event_date`; `PRE_FILTER_ENFORCE_BUCKETS` printed empty. | Agree on no-go; correction: #126 protects pre-event dated bets under enforce, but not NULL dates, far-future, or post-event settling. |

## V1 - DP-01 7-day sweeper

Code confirms the exact write site and policy. `services/grading.js:1691-1692` defines `SWEEP_DAYS = 7` and `SWEEP_CUTOFF_MS`. `evaluateSweep` computes age from `created_at` at `services/grading.js:1721-1722`, exempts props at `:1723-1725`, and only applies the event-aware guard when `EVENT_AWARE_RECHECK=enforce` and `nextAttemptForEvent(...).defer` at `:1740-1742`. The terminal write is `gradeBet(..., 'loss', ..., 'F', 'Auto-swept...', true, { requireGraderEligible: true })` at `services/grading.js:1908`; bankroll is updated at `:1911-1917`.

That path skips the AI grader's evidence gates: Gate 3 quote-bound evidence at `services/grading.js:3497-3522`, Gate 4 date-bound evidence at `:3525-3550`, and Gate 2 evidence-hash idempotency in `finalizeBetGrading` at `:3700-3710`. It does still call `canFinalizeBet` at `:1896-1900` and `requireGraderEligible` at `:1908`, so the correction is "bypasses evidence gates", not "bypasses every finalization guard."

Live DB probe:

```text
SELECT grade_reason, COUNT(*) ... WHERE grade_reason LIKE 'Auto-swept%'
=> "Auto-swept: pending >7 days with no score/confirmation", c=113

30d summary:
=> total=61, loss_count=61, null_event_date=61, mlb_nba_nhl=5,
   first_graded=2026-06-02 23:46:15, last_graded=2026-07-02 13:31:02

30d sport split:
=> Tennis 37, Soccer 17, MLB 3, NBA 2, UCL 1, UFC 1; every row NULL event_date
```

The current 30-day count is 61, one higher than the audit's 60 because a new sweep occurred after the audit window. The mechanism and concentration are confirmed.

Fix adjudication: ship sweep-to-VOID for no-evidence stale bets. `PENDING+quarantine` is semantically purer but only safe with an owned queue and age SLO; otherwise it recreates invisible backlog. `VOID` is the correct immediate bankroll/leaderboard semantic because "ungradeable" must not debit units. Add terminal telemetry in the same patch or immediately before it.

## V2 - T2-01 graphic/result auto-grade

Code confirms the global matcher. `handlers/messageHandler.js:667-700` calls `findPendingBetBySubject(subjects)`, grades the returned bet with `allowAutoConfirm=true`, and uses reason `Auto-graded from capper graphic`. The query at `services/database.js:254-258` is:

```sql
WHERE b.result = 'pending' AND b.review_status = 'confirmed'
AND LOWER(b.description) LIKE LOWER(?)
ORDER BY b.created_at ASC LIMIT 1
```

There is no capper, channel, event-date, odds, or line bound. The recap path tries capper-specific `gradeFromCelebration` first at `handlers/messageHandler.js:1208-1210`, then falls back to global auto-grade at `:1216-1218`; the result-image path calls `autoGradeBet` directly at `:1127`. Bankroll writes happen at `handlers/messageHandler.js:703-708`.

Fix adjudication: the audit's capper-bound + event-window fix is necessary. I would make global fallback non-terminal: create/reuse a review action with matched candidates and never call `gradeBetRecord` automatically unless capper and recency/date bounds are satisfied.

## V3 - T1-08 ungated `stmts.gradeBet`

`services/database.js:188` defines:

```js
gradeBet: db.prepare('UPDATE bets SET result = ?, profit_units = ?, grade = ?, grade_reason = ?, graded_at = datetime('now') WHERE id = ?')
```

It lacks `result='pending'`, pending-leg, review-status, and provenance gates. `rg "stmts\\.gradeBet"` returns only the definition, so it is dead at pinned HEAD. Verdict is CONFIRMED as a dead footgun, not an active exploit path.

Fix adjudication: delete the prepared statement. If a future caller needs grading, use `gradeBetRecord`.

## V4 - Twitter multi-pick sheet loss

Both halves are confirmed. In the vision branch, `services/twitter-handler.js:184` calls `parseBetText(..., imageUrls[0], ...)`, so images after index 0 are not sent to vision. When parsing succeeds, `services/twitter-handler.js:187-188` takes `const bet = parsed.bets[0]` and builds exactly one staged pick. There is no loop over `imageUrls` or `parsed.bets`.

Fix adjudication: loop over all selected images and every validated parsed bet. If that is too large for one patch, emit explicit drop rows for `discarded_image_count` and `discarded_bet_count` so the loss is visible.

## V5 - multi-image fabricated parlay

The trigger is confirmed at `handlers/messageHandler.js:1423-1428`: any multi-image parse with more than one bet becomes `[mergeBetsIntoParlay(parsed.bets)]`. `mergeBetsIntoParlay` at `handlers/messageHandler.js:244-280` pushes every straight description into `allLegs`, sets `bet_type` to `parlay` when there is more than one leg at `:271`, and marks `_confidence: 'low'` at `:279`. That low confidence routes to `needs_review` at `handlers/messageHandler.js:1455-1456`.

The mitigation is real, but insufficient: the human sees a plausible parlay-shaped item and one approval ratifies the fabricated shape. Fix should preserve independent straights unless a shared ticket/parlay signal is detected.

## V6 - silent grade writers

Code confirms no terminal telemetry at the autonomous bypass writers:

- Sweeper: `services/grading.js:1893-1923` writes `gradeBet`, bankroll, snapshot, and `console.log`; no `recordDrop`, `recordStage`, `transitionTo`, or `writeGradingAudit`.
- Graphic auto-grade: `handlers/messageHandler.js:667-724` writes `gradeBetRecord`, bankroll, Discord notification, and `console.log`; no pipeline or grading audit write.
- Celebration auto-grade: `services/grading.js:1932-1995` writes `gradeBet`, bankroll, snapshot, and `console.log`; no pipeline or grading audit write.

By contrast, the AI grader initializes an audit object at `services/grading.js:3126-3145`, writes audit rows through `writeGradingAudit` at `:3093-3118`, and records pending drops in `earlyReturn` at `:3152-3203`.

Live terminal-time probe:

```text
sweeper_terminal_or_later_rows
=> swept=61, pipeline_events_at_or_after=0, grading_audit_at_or_after=0

graphic_terminal_or_later_rows
=> auto_graphic=13, pipeline_events_at_or_after=0, grading_audit_at_or_after=0
```

The broader join found historical pipeline/audit rows for those bet IDs, but no row at or after the autonomous terminal write timestamp. The silent terminal-writer finding is confirmed.

Fix adjudication: emit a terminal event for each autonomous terminal writer. If `GRADING_COMPLETE` remains registered, make it real here. Include result, source path, matched terms/subject, and whether bankroll was changed.

## V7 - event_date split

Live DB probe after `PRAGMA table_info(bets)`:

```text
event_date_split_all
=> total=3212, null_or_empty=3089, iso_datetime=58, iso_date_only=64, free_text_other=1

event_date_split_pending
=> total=263, null_or_empty=241, iso_datetime=17, iso_date_only=5, free_text_other=0
```

This independently confirms the audit's direction. The current pending NULL-or-empty rate is 241/263 = 91.6%. The all-time rate is 3089/3212 = 96.2%. Date-keyed defenses still do not cover the majority of pending stock.

Fix adjudication: prioritize ingest extraction hit-rate and safe resolved-date write-back/backfill. Do not rely on event-aware sweep protection until event_date coverage materially improves.

## V8 - flip verdicts

### EVENT_AWARE_RECHECK

Constants at pinned HEAD still collide: `MAX_DEFER_MS = 168 * 3600e3` at `services/grading.js:1009`; sweeper cutoff is `SWEEP_DAYS = 7` and `SWEEP_CUTOFF_MS = SWEEP_DAYS * 24 * 60 * 60 * 1000` at `services/grading.js:1691-1692`.

The sweep guard exists at `services/grading.js:1740-1742`, but only for `eventAwareRecheckMode() === 'enforce'` and `nextAttemptForEvent(...).defer`. `nextAttemptForEvent` returns `defer:false` for missing event dates at `services/grading.js:1026-1027`, far-future suspect dates at `:1038-1040`, and post-event settling at `:1045`.

Live DB shows the current 30d swept set is 61/61 NULL `event_date`, so the guard would protect approximately zero of this observed DP-01 class today. The audit's "sweep guard protects ~0 bets at current event_date coverage" is confirmed for the current swept cohort. Correction: #126's pre-event guard is real for dated, within-7d future events; it just does not address the dominant NULL cohort or the far-future/post-event residuals.

### PRE_FILTER

Single-variable in-container check:

```text
fly ssh console -a bettracker-discord-bot -C "sh -c 'printenv PRE_FILTER_ENFORCE_BUCKETS || true'"
=> empty output
```

Code reads the companion var at `handlers/messageHandler.js:1255-1257` and `:1354-1356`. `services/preFilter.js:51-67` drops only when `mode === 'enforce'` and the matched bucket is included in `PRE_FILTER_ENFORCE_BUCKETS`; otherwise it returns `action:'shadow'`.

Live shadow counts remain small:

```text
PRE_FILTER_WOULD_DROP by bucket => recap 28, promo 14, sweat 1
```

Fix adjudication: no-go for a blanket flip. Setting only `PRE_FILTER_MODE=enforce` with an empty companion var is a silent no-op: matched buckets still shadow and holds still fire. Enforce individual buckets only after the bucket/decision false-positive join is computed and the companion var is explicitly set.

## Adjacent Defects

- The graphic auto-grade path had 13 terminal writes in 30d with no terminal telemetry. I did not independently prove any were wrong, but the frequency is nonzero and the matcher is globally scoped.
- The production rolling window moved during verification; the sweeper count is now 61 rather than the audit's 60. This supports, rather than weakens, DP-01.

Safe to ship fixes for: [DP-01 sweep-to-VOID + terminal telemetry, T2-01 scoped/non-terminal graphic matching, T1-08 delete dead stmts.gradeBet, T2-02 Twitter multi-image/multi-bet loop, T2-03 preserve independent straights, DP-02 event_date coverage instrumentation/backfill, V8 docs/guard updates]
