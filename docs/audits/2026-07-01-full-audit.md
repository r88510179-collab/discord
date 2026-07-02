# ZoneTracker Full System Audit — 2026-07-01 (report only)

Third-generation full audit of the ZoneTracker bot (`bettracker-discord-bot`). Predecessors: [2026-05-22](2026-05-22-full-audit.md), [2026-06-10 COA](2026-06-10-coa-full-audit.md). This pass regression-checked every prior finding, audited everything shipped since, and probed live production data read-only. **REPORT ONLY — zero production changes.**

- **Pinned HEAD:** `19ff594` (`feat(admin): Phase A read endpoints … (#161)`, 2026-07-02), branch `audit/2026-07-01-full`, clean tree. node v25.8.1.
- **Live runtime during audit:** Fly `bettracker-discord-bot` v756–v758 (three deploys within the audit window) — the running image may not equal HEAD; runtime-dependent claims are tagged.
- **DB access:** read-only `better-sqlite3 {readonly:true}` via `skills/zonetracker-regrade/scripts/run-fly-sql.sh`. All Phase-2 probes executed; nothing mutated.
- **Method:** 12 parallel read-only analyst subagents (baseline regression, env inventory, live probes, tracks T1–T9). Evidence is file:line at HEAD or command+output. Full evidence in `docs/audits/2026-07-01-appendix/`.
- **Live flag state (verified via granted echo):** `QUOTE_BOUND_GRADING=enforce`, `DATE_BOUND_GRADING=enforce`, `EVENT_AWARE_RECHECK=shadow`, `EVENT_DATE_SLATE=shadow`, `PRE_FILTER_MODE=shadow`, `SOCCER_GRADER_MODE=enforce`, `SOCCER_PROPS_MODE=enforce`, `OCR_FIRST_MODE=shadow`, `LINK_READER_MODE=shadow`, `AUTOGRADER_DISABLED=false`, `GEMMA_FALLBACK_DISABLED=true`, `TWITTER_POLLER_DISABLED=true`, `CAN_FINALIZE_ENFORCE=true`, `GRADING_STATE_MACHINE_ENABLED=true`, `STRICT_MODE=true`.

---

## 1. Executive summary — top 10 findings

Ranked by severity × likelihood × blast radius. Prime directive throughout: *a wrong grade is worse than pending or void.*

| # | ID | Sev | Finding | One-line fix |
|---|----|-----|---------|--------------|
| 1 | **DP-01** | **P0** | The 7-day sweeper coined **60 evidence-free LOSS grades in 30 days** (bankroll debited), **100% on NULL-event_date bets**, 21+ in sports with working adapters (Tennis 37, Soccer 16, MLB 3, NBA 2). "Ungradeable" is being converted into "lost." | Sweep to **VOID** (or `manual_review_swept`), not LOSS, at least for adapter sports / NULL event_date. (S) |
| 2 | **T2-01** | **P0** | Vision-classified recap/result images auto-grade a bet found by a **global `LIKE '%term%'`** across *all cappers'* confirmed pending bets, oldest-first, no capper/date/line scope — then auto-confirm + bankroll. Cross-capper wrong-grade. | Scope `findPendingBySubject` to the posting capper + event window; route fallback to needs_review. (S) |
| 3 | **T1-02** | **P1** | Celebration auto-grade matches on **any single shared ≥3-char word** as a substring (`words.some(w => w.length>=3 && desc.includes(w))`) — "over"/"runs"/"the" match anywhere — then grades evidence-free with `allowAutoConfirm=true`. #94 fixed the pool, not the predicate. | Require ≥2 non-stopword word-boundary matches; stopword market terms. (S) |
| 4 | **DP-02 / T3-04** | **P1** | `event_date` is still NULL on **83% of the newest 3-day cohort (92% of pending stock)**. #154/#156 improved it ~6× but every date-keyed defense (adapters, Gate 4 anchor, slate, event-aware defer+its sweep guard) is inert for the NULL majority — the upstream cause of DP-01. | Measure #154 extraction hit-rate per channel; grader-resolved-date backfill for pending. (M) |
| 5 | **DP-03 / T4-03** | **P2** | Search redundancy has **collapsed to Bing alone**: serper 0 ok / 115 fail, ddg 0 ok / 91 parse_empty, brave quota-degraded (14d). A Bing markup drift now silently no-data-VOIDs (12h) or 7d-sweep-LOSSes every non-adapter sport. | Fix/remove serper key, investigate ddg parse rot; make an unhealthy search layer suppress terminal writes + alert. (S–M) |
| 6 | **T6-01** | **P1** | The two silent terminal writers (7-day sweep LOSS, celebration/graphic auto-grade) emit **zero pipeline_events and zero grading_audit** — so every #161 health surface showed a healthy grader for the whole month DP-01 was firing. | Emit one terminal event per write (mirror `GRADE_AUTOVOID_UNSCOPED`). (S) |
| 7 | **T5-01** | **P2** | Blind **SSRF**: legacy vision/OCR fetchers (`processImageForAI`, `extractTextFromImage`) do `fetch(imageUrl)` with no host/protocol allow-list on attacker-settable Discord embed / tweet-media URLs. The newer OCR-first path is hardened; the paths that run in prod today are not. | Factor the OCR-first allow-list into a shared `assertFetchableImageUrl()`; call at both legacy sites. (S) |
| 8 | **T1-04 / DP-05** | **P2** | `EVENT_AWARE_RECHECK` enforce-flip still blocked by `MAX_DEFER_MS(7d) == SWEEP_CUTOFF(7d)`, and #126's guard only covers the pre-event window — post-event settling, >7d-out events, and postponed games still sweep to false LOSS. BACKLOG entry is stale (doesn't credit #126). | Drop `MAX_DEFER_MS` to ~5d + extend the :1740 guard to post-event/far-future; rewrite the BACKLOG item. (S) |
| 9 | **T9-01** | **P1** | **Four merged-PR invariant tests never execute in CI** — including #139's `nba-nhl-canonicalize-substring.test.js`, which guards a *wrong-grade class* (prop routed to game-total grader). They sit in `check` (syntax-only) or on disk unwired; a regression fails no CI step. | Add the 4 to `test:reliability`; add a meta-test that fails when a `*.test.js` is unwired. (S) |
| 10 | **T1-03** | **P1** | `recoverHold` writes a **date-only** `event_date` (`iso.slice(0,10)`) via raw UPDATE, bypassing `normalizeEventDateForStorage` — breaks the CODEMAP invariant and, under `EVENT_DATE_SLATE=enforce`, resolves the ET slate one day early (false DNP-VOIDs; adjacent-day series mis-match → wrong WIN/LOSS). Slate is `shadow` today, so latent. | Route the backdate through `normalizeEventDateForStorage`, or store NULL and let §9 self-heal. (S) |

**The through-line:** findings 1, 2, 3, 6 are all the same root shape — **terminal grade writes that skip the gate stack, run on weak or no evidence, auto-confirm, and emit no telemetry.** The gate stack (Gates 1–4, idempotency, eligibility) is genuinely solid on the *autonomous AI grader path* (see §"Looked good"), but three writers route around it: the sweeper (age-only), celebration auto-grade (one-word substring), and graphic auto-grade (cross-capper substring). Finding 4 (NULL event_date) is the fuel that pushes bets into finding 1.

---

## 2. Full findings register

Severity counts (excluding STALE/ALIAS regression rows): **2 P0, 8 P1, 20 P2, 24 P3.**

### P0 — can emit a wrong grade or lose money today
- **DP-01** [20-data-probes] 7-day sweeper: 60 evidence-free LOSS/30d, 100% NULL event_date. *(corroborated by T1-06, T6-01)*
- **T2-01** [02-ingestion] Vision recap/result → global cross-capper substring auto-grade + auto-confirm.

### P1 — silent bet/data loss, or an unenforced invariant
- **T1-02** [01-grading] Celebration auto-grade one-word substring match → evidence-free auto-confirmed grade.
- **T1-03** [01-grading] `recoverHold` date-only event_date bypasses the storage guard (ET off-by-one under slate enforce).
- **DP-02 / T3-04** [probes/03] event_date NULL on 83–92% of bets — every date-keyed defense inert.
- **T6-01** [06-observability] Sweep + auto-grade terminal writes emit zero telemetry — dashboards blind.
- **T6-02** [06-observability] `auto_void_no_searchable_data` void finalizes with an empty pipeline trail (CODEMAP-acknowledged sibling gap, still open).
- **T2-02** [02-ingestion] Twitter vision path silently discards images past `[0]` and bets past `bets[0]` (F-07 fixed slip feed, not this).
- **T2-03** [02-ingestion] `mergeBetsIntoParlay` fabricates a parlay from independent straights on multi-image batches (the "parlay mis-split" class).
- **T4-02** [04-reliability] 4-second in-memory ingest buffer lost on every restart; no reconciliation of stuck-at-BUFFERED.
- **T9-01** [09-tests] Four merged-PR invariant tests (incl. a wrong-grade guard) never run in CI.
- **F-01** [regression, OPEN since 05-22] Pipeline event writer fails silently, flow continues.

### P2 — reliability, cost, operator-deception
DP-03 (search collapsed to Bing), DP-04 (human queues slowest stage: 187 needs_review, 226 open holds, 4.3d median), DP-05 (event-aware enforce still shadow), T1-04 (sweep race residuals), T1-05 (§9 wrong-but-nearby date pinned permanently), T1-06 (sweeper terminal is LOSS not VOID), T1-07 (war-room buttons compute profit from embed not DB), T2-04 (tweet marked processed before parse → unrecoverable), T2-05 (TEXT_EXTRACTION_FAILED enum dead — outages look like non-bets), T2-06 (MessageUpdate double-stage), T2-08 (Discord relay channels have no content dedup), T4-01/M-7 (no graceful shutdown; 3 abrupt kill paths), T4-03 (search outage → silent no-data VOID), T4-05 (no bot-side scraper dead-air alarm), T4-06/M-2 (grader waterfall aborts on first garbage JSON), T5-02/F-03 (no rate limiting on any endpoint), T5-03 (non-timing-safe `MOBILE_SCRAPER_SECRET` compare), T5-04 (evidence-poisoning → wrong grade; Gate 4 mitigates), T6-03/T6-04 (enforce-decision reads uncomputed), T6-05 (pipeline_events never purged — the "90-day purge" doesn't exist), T6-06 (backend health RAM-wiped daily → chronic failures read healthy), T7-01 (GROQ_API_KEY single load-bearing key), T7-02 (intake LLM usage has zero telemetry), T7-03 (intake max_tokens 1024 truncates long parlays; Gemma rescue disabled), T8-02/T8-03/T8-06 (BACKLOG deploy-state + enforce-flip + pre-filter-companion drift), T3-02 (`/admin pipeline drops` unindexed full scans), F-05 (god-files, worse).

### P3 — hygiene, drift, docs
T1-08 (dead ungated `stmts.gradeBet` footgun), T1-09/M-4 (quarantine still no auto-exit), T1-10 (`/grade override` leaves stale grade letter + Gate-2 hash), T2-07/T2-09/T2-11/T2-12/T2-13 (SLIP_IMAGE_CAP silent overflow, escape-hatch junk bets, /slip no fingerprint, multi-image recap discard, Type-4 is_bet coercion), T3-01/T3-03/T3-05 (CODEMAP schema drift, FK convention-only, boot-DDL-only columns), T4-07/T4-08/T4-09/T4-10 (quarantine invisibility, no cron overlap guard, in-memory cron telemetry, BACKLOG #125 drift), T5-05/T5-06/T5-07 (missing fetch timeouts, interpolated healthReport SQL, no /mobile-ingest batch cap), T6-07/T6-08/T6-09 (pipelineHealth tautology, dead stage enums, review actions untraced), T7-04/T7-05/T7-06/T7-07 (grading-ladder comment wrong + llama8b, Gemma dead code, mislabeled Cerebras parse, OCR shadow no expiry), DP-06 (provider-ladder comment contradicts code), DP-07 (58MB WAL = DB size), T8-01/T8-04/T8-05/T8-07/T8-08/T8-09/T8-10 (CODEMAP line drift up to +598, MEMORY ledger abandoned, missing env-var rows, 7 dead secrets, #157 gate undocumented, AGENTS.md path, stale conventions pin), plus the F-15/F-16/F-18/F-19/F-20 regression carries.

---

## 3. Regression verdict

Full table in [00-baseline.md §B](2026-07-01-appendix/00-baseline.md). Summary:

| Prior audit | Findings | FIXED | OPEN | REGRESSED | STALE/alias |
|---|---|---|---|---|---|
| 2026-05-22 (F-01…F-21) | 21 | 6 | 11 | **0** | 4 |
| 2026-06-10 main (M-1…M-16) | 15 | ~5 fully + partials | ~8 | **0** | 2 |
| 2026-06-10 satellites (S/U/D/H) | ~30 | mixed | mixed | **0** | — verified against local checkouts, several UNVERIFIED-LOCAL |

**Nothing REGRESSED — no previously-fixed finding broke again.** That is the single best structural signal in this audit.

**But the P1s persist.** Both 2026-05-22 P1s that were real (F-01 silent pipeline writer, F-03 endpoint hardening) are still OPEN six weeks later. Of the 2026-06-10 mains: **M-3 FIXED** (search breaker no longer parse-blind — #74/#76 shipped `assessSearchResults`), **M-4 partially fixed** (`/admin grading-unstick` exists; no auto-reaper), **M-2 / M-5 / M-7 still OPEN** (grader parse-abort, no retention, no graceful shutdown). **F-21 resolver FIXED** (service deleted, mig 030 dropped the table, zero code refs — confirmed live: 26 tables, resolver_events gone). **F-14 dup-006 FIXED** (#160).

**Satellite note:** local Mac checkouts of the four satellite repos are on stale feature branches (dashboard on a deleted origin branch, dubclub 7 behind origin/main), so satellite regression rows reflect last-fetched refs, not the deployed Surface Pro state — several are tagged UNVERIFIED-LOCAL. No ssh was performed (hard rule); host H-* rows are doc-claimed only.

---

## 4. Enforce-flip verdicts (grounded in Phase-2 numbers)

### `EVENT_AWARE_RECHECK` → enforce: **NO-GO** (conditions below)
- Shadow telemetry (since v691, 2026-06-18): **364 rows, 52 would-defer / 312 would-window**, against a grading baseline of 96–955 attempts/day. Enforce would skip only **~4 claims/day** — a small RPM win.
- The *safety* half — the `event_pending` sweep guard (#126) — activates only under enforce and has **zero shadow measurement**; today it would protect ~0 bets because all 60 DP-01 sweeps had NULL event_date (→ `defer=false`). **The guard is worthless until event_date coverage (DP-02) improves.**
- **Hard blocker unchanged:** `MAX_DEFER_MS(168h) == SWEEP_CUTOFF_MS(7d)` (grading.js:1009 vs :1691). A 7d-out deferred bet can be swept before its recheck. **Conditions to flip:** (1) drop `MAX_DEFER_MS` below the sweep cutoff (~5d); (2) extend the :1740 guard to `phase==='post_event'` (settle horizon) and `suspect_far_future`; (3) raise event_date coverage so the guard has bets to protect. Flip only after all three.

### `PRE_FILTER_ENFORCE_BUCKETS` → enforce: **NO-GO — not yet decidable**
- Only **43 shadow would-drops since 2026-06-24** (recap 28 / promo 14 / sweat 1), against 327 lifetime hold decisions at 102.6h median latency — most shadow rows are still unlabeled.
- The per-bucket false-positive read (would-drop ⋈ hold_review_decisions by bucket) **is derivable from existing schema but nobody computes it** (T6-03). And `PRE_FILTER_ENFORCE_BUCKETS` is **absent from prod secrets** (T8-06), so setting `PRE_FILTER_MODE=enforce` today drops nothing — a silent no-op. **Conditions:** run the bucket-FP join, accumulate ~3–4 more weeks, enforce a bucket only when it has ≥N decided rows with 0 recovered, and actually set the companion var.

---

## 5. Quick wins vs structural work

**Quick wins (one agent-session each, high value):**
- DP-01/T1-06 — sweep to VOID not LOSS (one literal + policy sign-off). *Directly stops the P0.*
- T2-01/T1-02 — scope auto-grade matchers to capper + word-boundary + stopwords. *Stops the other P0/P1.*
- T6-01/T6-02 — emit a terminal event on the three silent grade/void writers. *Makes DP-01-class visible.*
- T5-01/T5-03/T5-05 — shared image-URL allow-list, timing-safe compare, fetch timeouts.
- T9-01 — wire the 4 orphaned tests + a meta-test.
- T8-04/T8-05/T8-08/T3-01 — one docs-sync PR (CODEMAP line refresh, MEMORY backfill, missing env rows, #157 gate, resolver_events removal).
- T8-07 — unset the 7 dead secrets (after confirming no off-repo consumer).

**Structural (multi-session):**
- DP-02 — event_date ingest hit-rate + grader-resolved backfill (the keystone; unblocks the sweep guard and the enforce flip).
- DP-03/T4-03 — search-tier resilience (second funded provider + health-gated terminal writes).
- T4-01/T4-02/M-7 — graceful shutdown + buffer persistence.
- T6-05/M-5 — retention policy for pipeline_events/grading_audit (hold-aware purge).
- F-05 — begin god-file extraction (grading.js is 3,878 lines, +45% since June).

**Maps to the existing P1–P5 roadmap:** DP-02 is the standing event_date arc; DP-03 is the "search weakest-link" arc; the enforce flips are already tracked (BACKLOG:226-227) — this audit supplies the missing numbers. The two P0s are NEW and should preempt the roadmap.

---

## 6. Proposed 30-day plan (measure-before-build, shadow-before-enforce)

**Week 1 — stop the bleeding (P0s + visibility):**
1. Sweep→VOID for adapter sports / NULL event_date (DP-01). Ship behind a flag, shadow-count how many LOSSes become VOIDs for one cycle, then enforce.
2. Scope both auto-grade matchers (T2-01, T1-02) — capper-scoped + word-boundary + stopwords.
3. Terminal-event emission on sweep/celebration/graphic/no-data-void writers (T6-01, T6-02) — ship first so 1 & 2's effect is measurable.
4. Run the zonetracker-regrade batch over the 60 swept LOSSes to quantify how many were actually wrong (the UNVERIFIED half of DP-01).

**Week 2 — evidence integrity:**
5. event_date ingest hit-rate measurement per channel + grader-resolved backfill design (DP-02).
6. Search-tier: remove/fix serper, investigate ddg, health-gate terminal writes so an unhealthy search layer can't VOID/sweep (DP-03, T4-03).
7. Security quick wins: shared image-URL allow-list (T5-01), timing-safe compare (T5-03), rate limiting (T5-02/F-03), fetch timeouts (T5-05).

**Week 3 — reliability + tests:**
8. Graceful shutdown + buffer flush (T4-01, T4-02); cron overlap guard (T4-08).
9. Wire orphaned tests + meta-test + the top-10 test list (T9-01…T9-05).
10. Grader waterfall parse-inside-loop (M-2/T4-06).

**Week 4 — enforce-flip prep + docs:**
11. Add the sweep-guard shadow counter (T6-04) and the pre-filter bucket-FP join (T6-03); let both accumulate.
12. Resolve the `MAX_DEFER`/`SWEEP_CUTOFF` collision (T1-04); *do not flip yet* — flip is a post-plan decision once event_date coverage is up and the shadow counters are non-trivial.
13. One docs-sync PR (T8-01/04/05/08, T3-01, T6-08).

---

## 7. "Could not verify" & open questions for Smokke

1. **Actual wrongness of the 60 swept LOSSes (DP-01).** The finding is mechanism-based (evidence-free terminal grades); per-bet correctness needs a regrade batch — recommend running zonetracker-regrade over them. Samples like `Japan ML`, `Spain -2.5`, `Ronaldo Goal` are World-Cup soccer picks whose real results are knowable.
2. **Runtime image vs HEAD.** v756–758 deployed *during* the audit; every "at HEAD" claim is about the repo. Confirm the deployed commit if acting on a line-ref.
3. **`audit_mode` DB setting** — decides whether text-parse bets stage `confirmed` vs `needs_review`, which materially changes the blast radius of T2-01/T2-06/T2-08. Needs `SELECT value FROM settings WHERE key='audit_mode'`.
4. **"Gavin parlay mis-split"** (from the audit spec) has zero hits in BACKLOG, git log, or prior audits. T2-03 (`mergeBetsIntoParlay`) is the mechanism-level match — confirm whether a specific Gavin incident exists outside the repo record.
5. **DatDude-pulled-from-PURE_SLIP** (auto-memory) is not reflected in CODEMAP §Channels (still lists it among the 13). Doc drift or stale memory — needs the CODEMAP §Subset-invariant fly one-liner to settle.
6. **7 dead secrets (T8-07)** incl. `TWITTER_PASSWORD` — confirm no off-repo (Surface Pro) consumer before unsetting.
7. **Satellite repos** — audited against stale local checkouts; a fresh COA pass on the deployed Surface Pro state (dubclub 7 commits behind locally) is owed.
8. **Orphan-integrity counts (T3-03)** — five read-only SQL probes specified but not run this pass; add to the standing probe script.

---

*Appendices (full evidence): [00-baseline](2026-07-01-appendix/00-baseline.md) · [01-grading](2026-07-01-appendix/01-grading.md) · [02-ingestion](2026-07-01-appendix/02-ingestion.md) · [03-data-schema](2026-07-01-appendix/03-data-schema.md) · [04-reliability](2026-07-01-appendix/04-reliability.md) · [05-security](2026-07-01-appendix/05-security.md) · [06-observability](2026-07-01-appendix/06-observability.md) · [07-llm-cost](2026-07-01-appendix/07-llm-cost.md) · [08-config-docs](2026-07-01-appendix/08-config-docs.md) · [09-tests](2026-07-01-appendix/09-tests.md) · [20-data-probes](2026-07-01-appendix/20-data-probes.md)*
