All evidence gathered. Composing the appendix.

# T3 — Data and Schema — 2026-07-01 audit appendix

Scope: schema-vs-CODEMAP diff, orphan risk, timestamp-unit consistency, index coverage vs hot queries, event_date health. Worktree HEAD `19ff594` (`audit/2026-07-01-full`). Live-side facts come from the probe pack; note the pack copy received by this track carried the **condensed probe log only** (table list, migration rows, index-presence confirmation, timestamp-convention verification) — not the verbatim `pragma_table_info` dump. The "live" side of the column diff is therefore reconstructed from code (base DDL + migrations 001→031, all confirmed applied in the pack) and boot-time DDL in `services/database.js`; per-column PRAGMA re-verification is listed under UNVERIFIED.

### T3-01 [P3] [confidence: high] CODEMAP schema/migration sections have four drift points at this HEAD (resolver_events undead, Migrations table ends at 029, grading_audit "NOT a numbered migration" is false, §9 write-back WHERE quote missing the #157 gate)
- Where: docs/CODEMAP.md:118, :536-550, :110, :35, :474
- What / Why it matters: CODEMAP is the declared authoritative map ("read FIRST"); each drift below misleads the next session.
  1. **resolver_events still listed as a live table.** CODEMAP:118 lists `resolver_events (orphaned)` among "Other tables" and :474 says "Only the orphaned `resolver_events` table" remains. Mig `030_drop_resolver_events.sql` drops it, and the probe pack confirms 26 tables with resolver_events gone.
  2. **§Migrations table (CODEMAP:538-550) ends at 029** — no rows for 030 (drop resolver_events) or 031 (`idx_pipeline_events_event_type_created`), even though CODEMAP:402 (routes/admin.js entry, updated by #161) references "mig 031". Half the doc knows about 031; the section that inventories migrations doesn't.
  3. **grading_audit provenance claim is false.** CODEMAP:110: "Created via `CREATE TABLE IF NOT EXISTS` in `services/database.js:97` (NOT a numbered migration)". `migrations/014_add_grading_audit.sql:1-22` creates the identical 20-column table, and the pack shows 014 applied in `schema_migrations`. (The two definitions are column-identical — verified side by side — so no live-shape ambiguity, just a wrong provenance claim.)
  4. **§9 write-back WHERE quote is pre-#157.** CODEMAP:35 quotes the self-heal UPDATE as `UPDATE … WHERE id=? AND event_date IS NULL`; the actual statement at services/grading.js:2709 is `… AND event_date IS NULL AND ${GRADER_ELIGIBLE_WHERE}` (the #157 gate, merged at ee1a2ee before this HEAD). Anyone auditing the write-back's blast radius from CODEMAP alone would miss that a reverted/needs_review bet also refuses the date side-write.
- Evidence: file reads above; `git log --oneline` shows ee1a2ee (#157) and 71d05a5 (#160) ancestors of 19ff594; probe pack P0 ("26 tables — resolver_events gone", "031 … present").
- Proposed fix: one docs PR — delete the two resolver_events mentions, add 030/031 rows, correct the grading_audit note to "mig 014 + defensive boot DDL", append `AND GRADER_ELIGIBLE_WHERE` to the :35 quote. (Effort S)
- Backlog: NEW (docs-sync class; last full sweep was #123)

### T3-02 [P2] [confidence: med] `/admin pipeline drops` still runs two unindexed full-table COUNT(*) scans on pipeline_events — the exact event-loop-blocking pathology mig 031 fixed for the HTTP twin
- Where: services/pipelineRender.js:123, :125 (caller commands/admin.js:876)
- What / Why it matters: `renderPipelineDrops` computes window totals via `SELECT COUNT(*) FROM pipeline_events WHERE created_at >= ?` — bare `created_at` predicate. No live index leads with `created_at` (reconstructed set: `(ingest_id, created_at)`, `(bet_id)`, `(stage, event_type)`, partial `(drop_reason, created_at)`, `(event_type, created_at)` from 031 — none applies), so both statements are full scans + better-sqlite3 is synchronous. Mig 031's own header (migrations/031:1-7) states the table has "no retention pruning" and that scans there were "synchronous … on the bot's event loop"; #161 indexed the two `/drops` HTTP queries (routes/admin.js:465-479, predicates `event_type='DROP' AND created_at >= ?` — index-matched, confirmed present in the pack) but the Discord-command sibling's denominator queries were left behind. The drop-reason GROUP BY queries in the same function (:129-139) *are* 031-served; only the two totals scan. Frequency is operator-driven (low), but each invocation stalls ingestion/grading for the scan duration, and the table only grows (~9k DROP rows/14d per pack P5, plus all non-drop stage rows).
- Evidence: pipelineRender.js:118-127 read above (`const nowSec = Math.floor(Date.now()/1000)` → unit correct, coverage absent); index inventory from migrations 018/021/031 + database.js boot DDL.
- Proposed fix: reuse 031's index by adding `AND event_type IS NOT NULL`-free equivalent is impossible for an all-events total — either (a) add `idx_pipeline_events_created` (mig 032), or (b) change the denominator to drop-rows-only (already indexed) since the command renders drop shares. (Effort S)
- Backlog: extends BACKLOG:182 (#161 Phase A entry, which documents the scan pathology) — command-surface remainder is NEW

### T3-03 [P3] [confidence: high] Referential integrity outside parlay_legs is convention-only, and FK enforcement is per-connection — orphan probes for grading_audit/pipeline_events were never run
- Where: services/database.js:15 (`db.pragma('foreign_keys = ON')`); migrations/014 (grading_audit — `bet_id TEXT NOT NULL`, **no FK**); migrations/021:15-26 (pipeline_events.bet_id — no FK); migrations/025 (hold_review_decisions.bet_id — no FK)
- What / Why it matters: Only `parlay_legs`, `bankrolls`, `daily_snapshots`, `bet_props`-class tables carry `REFERENCES … ON DELETE CASCADE` (migrations/001). The audit/event tables (`grading_audit`, `pipeline_events`, `hold_review_decisions`, `parlay_legs_dedup_events`, `bet_grade_history`) reference `bets.id`/`ingest_id` with zero constraints — deliberate for trace tables, but it means "audit row exists ⇒ bet exists" is unenforced, and the smokke capper-merge / retro-fix style manual interventions (run over `fly ssh` sqlite3 or ad-hoc runners that do NOT set `foreign_keys = ON`, which is per-connection) can silently orphan even the FK'd tables. The probe pack verified only one orphan class (`bet_grade_history`: none). The rest were not probed. Exact SQL for the next probe run (all read-only):
  - `SELECT COUNT(*) FROM parlay_legs pl LEFT JOIN bets b ON pl.bet_id=b.id WHERE pl.bet_id IS NOT NULL AND b.id IS NULL;` (FK'd but pre-FK/manual-write residue possible)
  - `SELECT COUNT(*) FROM parlay_legs WHERE bet_id IS NULL;` (column is nullable)
  - `SELECT COUNT(*) FROM grading_audit ga LEFT JOIN bets b ON ga.bet_id=b.id WHERE b.id IS NULL;`
  - `SELECT COUNT(*) FROM hold_review_decisions h LEFT JOIN bets b ON h.bet_id=b.id WHERE h.bet_id IS NOT NULL AND b.id IS NULL;` (released-hold rows pointing at deleted bets)
  - superseded/dup chains: `SELECT fingerprint, COUNT(*) c FROM bets WHERE fingerprint IS NOT NULL GROUP BY fingerprint HAVING c>1;` (must be 0 — `idx_bets_fingerprint_unique` partial UNIQUE, migrations/001:84) and `SELECT COUNT(*) FROM bets b1 JOIN bets b2 ON b1.source_message_id=b2.source_message_id AND b1.id<b2.id WHERE b1.source_message_id IS NOT NULL;` (near-duplicate pairs like the pack's two `Spain -2.5` sweeps)
  All counts UNVERIFIED this run.
- Evidence: file reads above; probe pack P4 ("no orphan history rows" — bet_grade_history only).
- Proposed fix: add these five to the standing probe script for the next audit generation; no schema change proposed (trace tables intentionally FK-free). (Effort S)
- Backlog: NEW (probe-pack coverage gap)

### T3-04 [P1] [confidence: high] event_date after #154+#156: newest-cohort NULL rate fell 97%→83% — real but insufficient; the NULL majority still disables every date-keyed defense (corroborates DP-02/DP-01)
- Where: bets.event_date; write paths services/eventDate.js:96-97 (gap-only guard −2d/+60d) via database.js:372 (`createBet`) and services/grading.js:2680-2709 (§9 write-back, NULL-only + `GRADER_ELIGIBLE_WHERE`)
- What / Why it matters: Probe 8 interpretation: created <3d = 114 NULL / 23 ISO (**83% NULL**), 3–7d = 95% NULL, 7–30d = 95% NULL, pending stock = 230/21 (**92% NULL**). Against the pre-#154 baseline (96.9% NULL, event_date diagnosis), ingest population improved roughly 6× on the newest cohort — the #154/#156 pipeline verifiably works — but five shipped defenses (event-date-first adapters, Gate 4 anchor, EVENT_DATE_SLATE, EVENT_AWARE defer, its enforce-only sweep guard at grading.js:1740) remain inert for >4 of 5 new bets, and the pack's DP-01 shows the concrete cost (60/60 swept LOSSes on NULL event_date). Data quality itself is clean: mig 029's invariant held (probe 8b: zero non-ISO garbage anywhere); the one bad-*year* row (`2024-07-07` on a 2026-06-18 WNBA bet) parses as a valid datetime so 029 correctly ignores it, and the bet predates the #154 gap-guard's deploy window (timing UNVERIFIED) — it is parked in `manual_review_unmodeled_sport`, not gradeable, so contained.
- Evidence: probe pack probes 8/8b; eventDate.js:96-97/103-104 (gap-only rule, no cross-year rule — matches memory #154 superseding #153).
- Proposed fix: per DP-02 — measure extraction hit-rate per channel and close at ingest; grader-resolved-date backfill for the pending stock (Phase-3 diagnosis: `date(created_at)` bulk backfill is INERT — do not run). (Effort M)
- Backlog: existing event_date arc (BACKLOG:56-57 per pack; DP-01/DP-02)

### T3-05 [P3] [confidence: high] `parlay_legs.sport` and three other columns exist only via boot-time DDL, so `migrations/` alone does not reproduce the live schema
- Where: services/database.js:82 (`ALTER TABLE parlay_legs ADD COLUMN sport TEXT`), :56 (`user_bets.risk_amount`); tables `users`/`processed_tweets` (database.js:23, :47) also boot-only
- What / Why it matters: A fresh DB built from `migrations/*.sql` (e.g. a test harness or restore tooling that runs the migrator without importing `services/database.js`) lacks `parlay_legs.sport` — a column the grader reads/writes for leg-sport resolution (#114 arc) — and `user_bets.risk_amount`. Everything self-heals when the app boots (idempotent `PRAGMA table_info` checks), so production is unaffected; the risk is tooling/tests that assume migrations are the complete schema, plus the CODEMAP:106 parlay_legs line documenting `sport` with no hint it is boot-DDL-only. Same class as the grading_audit note in T3-01(3) but that one at least *has* a migration.
- Evidence: `grep "ADD COLUMN" services/database.js` output above; `grep "ALTER TABLE" migrations/*.sql` shows no `parlay_legs … sport` and no `risk_amount`.
- Proposed fix: fold the boot-only DDL into a catch-up migration (032) or annotate CODEMAP §Schemas that four objects are boot-DDL-owned. (Effort S)
- Backlog: NEW

## Canonical timestamp-unit table (code-verified at HEAD; live conventions confirmed by probe pack "Looked good")

| Column | Unit | Writer (verified) |
|---|---|---|
| bets.created_at / graded_at / grading_*_at / grading_lock_until / sweep_exempt_until / event_date | ISO TEXT, UTC | migrations/001 defaults; `datetime('now')` (database.js:652); eventDate.js ISO-8601 |
| bets.drop_reason_set_at | epoch **sec** | `Math.floor(Date.now()/1000)` services/bets.js:76 |
| pipeline_events.created_at | epoch **sec** | default `strftime('%s','now')` (mig 021:26) + explicit pipeline-events.js:193 |
| hold_review_decisions.created_at | epoch **sec** | holdReview.js:139, :334 |
| parlay_legs_dedup_events.created_at | epoch **sec** | default (mig 024) |
| grading_audit.timestamp | epoch **ms** | `Date.now()`; windows use `(unixepoch()-86400)*1000` (grading.js:1776, commands/admin.js:511, routes/admin.js:500) |
| search_backend_calls.ts | epoch **ms** | `Date.now()` (routes/admin.js:492-496 comment; pack-verified) |
| twitter_audit_log / processed_tweets / bot_health_log / vision_failures / bet_grade_history / regrade_results / parlay_legs / cappers | ISO TEXT | `datetime('now')` defaults (001/009/010/017/022) |

**Wrong-unit query sites found: none.** Every windowed site greppable in services/, commands/, routes/ uses the matching unit: ISO tables use `datetime('now', …)` (twitter-handler.js:82, healthReport.js:80/253/260/280-281, commands/admin.js:301/616-619/662-670, database.js:215/899/907, dedupLeakCheck.js:58 with correct `strftime('%s', created_at)` CAST bridging); epoch-sec tables use `strftime('%s','now')`/`Date.now()/1000` (pipelineHealth.js:39, sgpWouldHoldPulse.js:33, replayHolds.js:138, pipelineRender.js:118, routes/admin.js:460, commands/admin.js:947/953, bets.js:76); epoch-ms tables use `*1000` (grading.js:1776, routes/admin.js:500/537, commands/admin.js:511/1137-1155). The mig-023 `ts` column declares only `INTEGER` with no unit comment — the pack confirms MILLIS in the data, and routes/admin.js:495 now documents it.

## Index coverage vs hot queries (index list reconstructed from 001/006/016/020/026/018/021/023/024/025/031 + boot DDL; 031 physically present per pack)

- **getPendingBets** (database.js:701-710): `result='pending'` + `review_status NOT IN` + `grading_state IN` + two `datetime('now')` bound columns, ORDER BY created_at DESC → served by `idx_bets_grading_queue (result, review_status, grading_state, grading_next_attempt_at, grading_lock_until)` (mig 016:21-22); result-equality prefix + ~250-row residual makes the trailing sort immaterial. Covered.
- **7-day sweeper** (grading.js:1720-1761): pure JS filter over the getPendingBets snapshot + per-bet PK point reads (`:1708`, `:1756`). No additional SQL surface. Covered.
- **Recheck/defer writes**: UPDATE by PK. Covered.
- **/api/admin/drops** (routes/admin.js:461-479): both queries predicate `event_type='DROP' AND created_at >= ?` (+ optional `drop_reason=?`) → exactly `idx_pipeline_events_event_type_created` (mig 031:8-9). **Confirmed: 031's index matches the #161 query shapes**, including the ORDER BY created_at DESC prefix.
- **/api/admin/grader-health** (routes/admin.js:502-540): bets `result='pending'` → idx_bets_result; grading_audit `timestamp >= ?` → idx_grading_audit_timestamp; search_backend_calls `ts >= ?` → idx_sbc_ts. Covered.
- **Gaps**: (a) T3-02's two bare `created_at` COUNTs — the one real miss; (b) `/holds` (routes/admin.js:182-187) selects ALL `stage='MANUAL_REVIEW_HOLD'` rows unbounded with a temp-sort on `created_at DESC, id DESC` (`idx_pipeline_events_stage_type` serves the equality, not the order) — row count is hold-volume-bounded (~1-2k lifetime), acceptable today, will degrade linearly with no retention pruning; (c) commands/admin.js:619/662/665 `graded_at` windows scan bets (no graded_at index) — ~3.2k-row table, immaterial.

## Column-level diff: reconstructed live schema vs CODEMAP §Schemas

- **bets**: 42 columns reconstructed (001's 21 + 002 review_status + 004 wager/payout + 006 season + 007 is_ladder/ladder_step + 008 + 011×2 + 012 + 016×6 + 020×2 + 026×2 + 028) = CODEMAP:23-64's 42 rows, names and types matching. **No mismatch.**
- **pipeline_events**: mig 021:15-26 rebuild (10 cols) = CODEMAP:70-79. **No mismatch** (incl. nullable ingest_id).
- **hold_review_decisions**: mig 025 (14 cols) = CODEMAP:85-98. **No mismatch.**
- **parlay_legs_dedup_events**: mig 024 = CODEMAP:102 one-liner. **No mismatch.**
- **parlay_legs**: 001 (6) + 013 evidence/graded_at + boot-DDL sport = CODEMAP:106's 9. **No mismatch** (provenance caveat → T3-05).
- **grading_audit**: mig 014 = database.js:99-106 = CODEMAP:110 column list. **No mismatch** (provenance claim wrong → T3-01).
- **Other tables**: CODEMAP:118 explicitly defers to PRAGMA — except the stale resolver_events listing (T3-01). Expected live table census (25 named + sqlite_sequence = 26) matches the pack's 26.

## Looked good
- Zero wrong-unit time-window queries across services/, commands/, routes/ — the CODEMAP §Database-quirks discipline (:554-557) is holding in code, and routes/admin.js:492-496 now documents the per-table units inline at the newest query site.
- bets/pipeline_events/hold_review_decisions column sets: code, migrations, and CODEMAP all agree; mig 029's "NULL or parseable datetime only" invariant confirmed intact live (pack probe 8b: zero non-ISO garbage).
- #160's dup-006 design verified end-to-end: only `006_add_season_column.sql` on disk (superset with the 3 extra indexes); pack shows the `_to_bets` schema_migrations row inert-present exactly as documented (BACKLOG:242).
- Mig 031 shipped complete: SQL matches both #161 /drops query shapes, physically present in prod (pack), and the header comment accurately describes the pathology it fixes.
- §9 write-back plumbing at HEAD includes the #157 eligibility gate (grading.js:2709) — code is ahead of its own docs, the safe direction.
- getPendingBets/sweeper hot path fully index-covered by mig 016's composite; sweeper does no separate table scan.
- `foreign_keys = ON` + WAL + busy_timeout set at the single app connection (database.js:14-16).

## UNVERIFIED / open questions
- Per-column PRAGMA re-verification against the live DB: the pack copy received here omitted the verbatim `pragma_table_info` join output, so the column diff above rests on "all migrations 001→031 applied" (pack-confirmed) + boot DDL — a divergent live column (e.g. from a historical manual ALTER) would not be caught. Next probe run: re-attach the verbatim column map to the appendix.
- All five orphan/superseded-chain counts in T3-03 (SQL provided, not executed — no DB access granted this track).
- Deploy timing of #154 vs the 2026-06-18 creation of the lone bad-year (`2024-07-07`) event_date row — presumed pre-guard residue, not a guard hole; needs `graded_at`-vs-release cross-check per CODEMAP:556 discipline.
- Actual live size of `pipeline_events` (drives T3-02's real-world severity) — not in the pack; `SELECT COUNT(*) FROM pipeline_events;` next run.
- Whether any external tooling (dashboard repo, restore scripts) builds schema from `migrations/` alone (T3-05's blast radius).
