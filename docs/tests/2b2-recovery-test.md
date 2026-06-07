# Phase 2b-2 — On-Demand Unfurl Recovery: Production Test Record

**Date:** 2026-06-07 · **Commit under test:** `2cf77ef` (`feat/hold-recover-unfurl`, deployed) · **Verdict:** recovery works end-to-end (2/2 bets created, holds resolved, idempotent), but **recovered bets carry the recovery-time date, not the original slip date — and grading anchors on stored date columns, so recovered bets WILL mis-grade until the recover core populates `bets.event_date`.**

---

## 1. Feature under test

`recoverHold(ingestId, actor)` (`services/holdReview.js:289`) + `POST /api/admin/holds/:ingestId/recover` (`routes/adminCommands.js`), surfaced as the dashboard **Recover** button. Re-fetches a held HRB share message — held as `ai_is_bet_false` because it was graded text-only before Discord unfurled the slip image — and re-runs the **existing** `vision_slip` extraction+create path (`handlers/messageHandler.processSlipImage` → `createBetWithLegs(source:'vision_slip', review_status:'needs_review')` → war-room staging embed). On success it resolves the hold through the same `MANUAL_REVIEW_RELEASED` terminal the Release modal uses, plus a durable `hold_review_decisions` row (`human_decision='recovered'`, `source_label='unfurl_recovery'`). Idempotency keyed on `bets.source_message_id`, with `createBetWithLegs`'s fingerprint dedup as a second, lower guard.

## 2. Environment

- Production: `bettracker-discord-bot` on Fly.io, SQLite at `/data/bettracker.db`.
- Trigger: dashboard Recover button (actor recorded as `dashboard`).
- Verification access: **read-only** — `better-sqlite3` opened with `{ readonly: true }`, script delivered via the base64 `node -e` pattern over `fly ssh console`. No DB writes at any point.
- Subjects: two `#datdude-slips` HRB share messages (capper **DatDude**), both held `ai_is_bet_false` on their original post days (2026-06-01 and 2026-06-02), recovered from the dashboard on 2026-06-07.

## 3. Test steps

1. Identified two `MANUAL_REVIEW_HOLD` entries for DatDude HRB shares, hold reason `ai_is_bet_false`, hold sample text `"Check out this bet I placed on Hard Rock Bet! …"` (the pre-unfurl text-only content).
2. Clicked **Recover** on each from the dashboard. One attempt first returned `message_unreachable`, then succeeded on an immediate retry (§6).
3. Pulled the resulting rows read-only from production: full `bets` rows, `hold_review_decisions`, the complete `pipeline_events` trail per ingest, duplicate check by `source_message_id`, and `parlay_legs`.
4. Decoded each `source_message_id` as a Discord snowflake (`ms = (id >> 22) + 1420070400000`) and compared against stored date columns (§5).

## 4. Results

| | Recovery A | Recovery B |
|---|---|---|
| status | `recovered` | `recovered` |
| betId | `d3b219e38a08bd4c65d82ebdc0ed90a5` | `8d1fcaa3ebf6393e44dec240697f1d7d` |
| ingest_id | `disc_1511360679750402058` | `disc_1510950741336920197` |
| bet | MLB 5-leg hits parlay, +680, $10 → $91.64 | MLB 4-leg parlay, +700, $10 → $80.05 |
| original slip post (snowflake) | **2026-06-02 13:27:45 UTC** | **2026-06-01 10:18:49 UTC** |
| stored `created_at` | **2026-06-07 21:36:45** (= recovery time) | **2026-06-07 21:40:52** (= recovery time) |
| stored `event_date` | **NULL** | **NULL** |
| original-vs-stored gap | +5d 8h 9m | +6d 11h 22m |
| hold resolved | **y** — `MANUAL_REVIEW_RELEASED` via `unfurl_recovery`, `hold_review_decisions` #43 | **y** — same terminal, `hold_review_decisions` #44 |
| idempotent re-click | **y** — exactly 1 bet for this `source_message_id` | **y** — exactly 1 bet |
| current state | `result=pending`, `review_status=confirmed`, `grading_state=backoff` | same |

Snowflake decodes were sanity-checked against each ingest's `RECEIVED` pipeline event (match within 1s). Both recoveries took the OCR-first path with full OCR/vision leg agreement (`ocr_shadow_decision: USE_OCR`, 5/5 and 4/4 legs). Creation-time `review_status` was `needs_review` (per the `VALIDATED` pipeline payload); both rows now read `confirmed` with `slipfeed_message_id` set.

## 5. Date-integrity finding ⚠️

**The recovered bet carries the RECOVERY time, not the original slip date.**

- `bets.created_at` = `datetime('now')` at insert — i.e. the moment Recover was clicked (2026-06-07 21:36/21:40 UTC), 5–6 days after the slips were posted (2026-06-02 / 2026-06-01 per snowflake).
- `bets.event_date` exists but is **NULL** on both rows. HRB slips print only **relative** dates — `raw_text` shows `"Today, 6:40pm EDT"` per leg, never an absolute game date — so the vision parser has nothing absolute to emit. "Today" on the slip means the **original post day**, which only the snowflake knows.
- `parlay_legs` has no event/game-date column at all; per-leg dates exist nowhere.

This is already biting in production: both bets' `grading_last_failure_reason` reads `"Event was 0.1–0.2h ago — too soon to grade"` — the grader believes games that finished **5–6 days ago** just ended, because it anchored on recovery-time `created_at`.

## 6. Transient `message_unreachable`

One recovery attempt first returned `message_unreachable` (the `recoverHold` status for a failed Discord channel/message fetch), then succeeded on an immediate retry. The failure mode is safe: `recoverHold` returns before any extraction or write — no bet, no stage advance, hold left intact — so a re-click is always safe. But a one-shot fetch will not survive a bulk recovery sweep; see follow-up #2.

## 7. Grading-anchor finding ⚠️

Grading anchors **exclusively on stored bet-date columns**; nothing derives the game date from the matchup or slip text:

- **AI grading path** (`services/grading.js`, `gradeSingleBet` ~L2080–2090): GUARD 1/2 take `bet.event_date || bet.created_at` as the event date — used for the TOO_RECENT gate, the future-game gate, and (via `buildGraderSearchQuery`, L1393) the date baked into the evidence search query.
- **Deterministic sportsdata path** (`services/sportsdata/index.js:45–48`, `getBetDate`): **prefers `created_at`**, falls back to `event_date` (comment: "Prefers created_at (always populated)"), then queries the league scoreboard for exactly that date (`no_game_on_date` otherwise).

**Conclusion: a recovery-time date WILL mis-grade.** With `event_date` NULL and `created_at` = recovery time, both paths anchor on the wrong day: the AI path searches 2026-06-07 box scores for 2026-06-01/02 games (wrong-date attribution — the exact anti-pattern the regrade methodology guards against), and the sportsdata path asks the scoreboard for the recovery date. Same matchup on the wrong day = silently wrong grade; no game that day = permanent `no_game_on_date`/PENDING.

**The recover core must populate `bets.event_date`** with the original slip date, derived from the snowflake-decoded `source_message_id` timestamp (which also resolves the slip's relative `"Today, h:mmpm EDT"` times). One landmine remains even then: `getBetDate` *prefers* `created_at` over `event_date`, so the sportsdata path stays wrong unless the recover core **also** backdates `created_at` to the snowflake time (restoring the live-path invariant `created_at ≈ slip post time` that `getBetDate`'s comment assumes) or `getBetDate` flips its preference. Populating `event_date` is necessary either way; the `created_at`/`getBetDate` decision should ride along in the same fix.

## 8. Idempotency + resolution detail

- **No duplicates:** `SELECT source_message_id, COUNT(*) FROM bets … GROUP BY source_message_id` returns exactly 1 row per recovered message (verified for both).
- **Re-run behavior:** `recoverHold`'s bet-exists check (by `source_message_id`) runs **before** the terminal-stage check, so a post-success re-click returns `already_recovered` (HTTP 200) without touching the DB; the fingerprint dedup in `createBetWithLegs` is the second guard.
- **Resolution recorded:** each ingest has exactly one `MANUAL_REVIEW_RELEASED` stage row (payload `via: 'unfurl_recovery'`, `recovered_by: 'dashboard'`, bet id(s)) and exactly one `hold_review_decisions` row (#43, #44; `human_decision='recovered'`). The full pipeline trail is intact: `RECEIVED → AUTHORIZED → BUFFERED → EXTRACTED → PARSED(ignore) → MANUAL_REVIEW_HOLD` on the original day, then `PARSED(vision_slip) → VALIDATED → STAGED → MANUAL_REVIEW_RELEASED` at recovery.

## 9. Follow-ups

1. **`bets.event_date` population in the recover core** (blocker for grading correctness — §7): set from the snowflake-decoded original message timestamp; decide the companion `created_at`-backdate vs `getBetDate`-preference question in the same change.
2. **Fetch retry inside `recoverHold`:** 2–3 attempts with short backoff before returning `message_unreachable`. A one-shot fetch was already flaky for a 2-click manual test; a bulk recovery sweep will burn holds on transient Discord fetch failures.
3. **Going-forward automation:** a `messageUpdate` listener — when a message holding an `ai_is_bet_false` hold gains its unfurl embed/attachment, trigger the same recover core automatically instead of waiting for a dashboard click. The dashboard button stays as the manual/backfill path.
