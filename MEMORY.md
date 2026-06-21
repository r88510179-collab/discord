# ZoneTracker Memory

A concise, chronological index of significant shipped changes — one line per merge with its PR
number, pointing to the canonical detail elsewhere. This is **not** a duplicate of
[CODEMAP](docs/CODEMAP.md) (the file/line map) or [BACKLOG](docs/BACKLOG.md) (work tracking);
it's the "what shipped, when, why, see #N" ledger.

**Convention:** append one line per significant merge, newest first; CODEMAP/BACKLOG hold the
canonical detail.

## Shipped (newest first)

- **#130** — Guard `mlb.gradeMlbBet` to refuse mis-routed MLB player props (a non-run player stat in the description) before fetch — they fall to manual review instead of a false game-total WIN.
- **#127** — Docs-only: bring CODEMAP + BACKLOG current for the already-merged #124 event-aware grading recheck (flag, planner, wiring sites, consts); no code change.
- **#126** — Enforce-gated event-aware sweep guard: `evaluateSweep` skips (`event_pending`) a just-deferred future-event bet so the 7d sweeper can't finalize it to a false loss.
- **#124 — Event-aware grading recheck.** Flag `EVENT_AWARE_RECHECK=off|shadow|enforce` (currently `shadow`, v691). `nextAttemptForEvent()` defers future-dated / pending-leg bets to event-time instead of a flat +30m recheck; wired at `scheduleRecheckAfterDenial` + the `runAutoGrade` pre-claim skip. ⚠️ **Enforce flip blocked:** `MAX_DEFER_MS` (7d) == sweeper `SWEEP_CUTOFF` (7d) and the sweeper keys off `created_at`, so a ~7d-out event could be swept before its deferred recheck — resolve (lower `MAX_DEFER`, or sweep-exempt deferred bets) before flipping. Shadow emits `event_aware_shadow` pipeline_events rows; read that split + `grading_audit` attempts/day baseline first. Detail: CODEMAP §grading.js/§pipeline-events.js, BACKLOG grading section. Documented by #127.
- **#122** — Widen the `looksLikePlayerProp` gate to admit all-caps initial first names (e.g. "CJ Abrams") so those props reach the structured grader instead of the search/LLM loop.
- **#121** — Broaden the structured-grader gate (`PLAYER_PROP_STAT_HINTS`) to MLB+NBA+NHL so NBA/NHL props route there, and add shared `isTeamTotalBet` so the team graders refuse team totals.
- **#120** — Route "O/U N stat" player props to the structured grader (`isPropBet` now also uses per-sport `looksLikePlayerProp`, team-total guarded), closing the shape gap that sent them to the team grader and stalled at PENDING.
- **#119** — `GET /api/admin/holds` returns a per-hold `imageUrl`, joined by `ingest_id` from the separate EXTRACTED event (null when none), so the dashboard can show the bet-slip image.
- **#118** — Gate autonomous terminal grader writes on `review_status` (dual of `getPendingBets`) so a bet reverted to needs_review mid-flight is a no-op, not voided/graded out of the queue.
- **#117** — Add a player-prop branch to `buildGraderSearchQuery` building "<subject> <stat> <date> box score" instead of "<player> final score", so props hit stat-line pages, not recaps.
- **#116** — Add bot-side `POST /api/admin/bets/:id/approve` (adminAuth) reusing the exact `approveBet()` UPDATE to release a needs_review bet — no parallel write path; inert until the dashboard ships.
- **#115** — Offseason-bouncer rescue (`resolveInSeasonForOffseason`) matches team names on word boundaries, not substrings — surnames like "Abrams" no longer mislabel a pick's sport and drop it.
- **#114** — Grade-path `reclassifySport`/`inferLegSport` use #103's whole-word matcher + a KBO carve-out (not bare `desc.includes`), so MLB/KBO legs no longer mis-flip to substring-matched NFL.
- **#113** — Route unmodeled-league bets (KBO/KHL/NPB, etc.) to a terminal manual-review state instead of auto-voiding, so a human grades them rather than getting a silent false void; sweeper-safe.
- **#112** — Rescue no-leg Unknown bets whose description names a soccer national team (whole-word) to sport=Soccer before the auto-void gate; adds 'iraq', defers on non-soccer signals.
- **#111** — Emit a `GRADE_AUTOVOID_UNSCOPED` DROP event when `gradePropWithAI` auto-voids an unsupported-sport bet, so each void is queryable instead of leaving an empty trail (B7 follow-up).
- **#110** — Canonicalize unambiguous sport-alias labels (World Cup/Hockey/ATP/PGA → SOCCER/NHL/TENNIS/GOLF) before the supported-sport gate, so aliased picks grade instead of silent auto-void.
- **#109** — Record terminal DROP events on four previously-silent post-EXTRACTED relay-image exits, so those ingests stop vanishing without a trace (audit F17); instrumentation only.
- **#104** — Add a shared `canonicalizeSport()` at bet/audit/war-room write sites plus an idempotent backfill, collapsing the daily `grading_audit.sport_out` casing fork (SOCCER vs Soccer).
- **#103** — Match the leg-sport consistency scan on word boundaries, not substrings, so surnames like "CJ Abrams" no longer false-trigger NFL "rams" and mis-drop clean parlays.
- **#101** — Annotate the Discord `sportsbook_brand` bouncer-reject drop with an additive `share_link` (no-op unless `LINK_READER_MODE=shadow`), so the shadow metric stops undercounting that exit.
- **#100** — Add World Cup national teams as a separate whole-word list, adopted as Soccer in the validator's Unknown branch, so international picks parse at ingest instead of going to needs_review.
- **#99** — Offseason bouncer re-resolves ambiguous team nicknames to an in-season league before dropping, so MLB picks like "SF Giants ML" aren't silently rejected as out-of-season NFL.
- **#98** — Stop treating market phrases (e.g. "both teams to score") as team names, and let Unknown/placeholder legs adopt the signaled sport instead of being dropped as a mismatch.
- **#97** — Gate 4 — off-date evidence reject (`DATE_BOUND_GRADING`=off|shadow|enforce, default shadow) + a dated evidence-record layer, catching right-quote/wrong-fixture grades (incident e5d27de0).
- **#96** — Add a shadow-only link-reader (`LINK_READER_MODE`) annotating hold events with allow-listed sportsbook share/shortlink URLs; bump the hold sample 80→400ch so reviewers see hidden slips.
- **#94** — Narrow `gradeFromCelebration`'s auto-grade pool to `review_status='confirmed'` only, closing the last path that auto-graded/bankrolled review-queue bets (a #89 shield bypass).
- **#95** — Add an OWNER-gated `/admin` approve-by-id (partial-id, atomic `approveBet`) to confirm review-queue bets buried below `/review`'s top-25; no #slip-feed post; runbook updated.
- **#93** — `revertBetToPending` sets `review_status='needs_review'` so reverts park in the protected queue; `approveBet` is one atomic gated UPDATE that refuses with null, never a false success.
- **#91** — Hold-recovery retry cap (5), counted via RECOVERY_ATTEMPT_FAILED events: exhausted holds stop burning vision/OCR quota (`recoverHold` refuses before fetch); `force` bypasses the cap.
- **#90** — Skip the leg-team consistency check when the declared sport names only unmodeled leagues (KBO/KHL/NPB/Soccer), so foreign clubs sharing US nicknames stop false-dropping.
- **#92** — `approveBet` fully resets grader state (ready, attempts=0, locks/next/failure NULL) and stamps a 3-day sweep grace, so approved bets aren't left invisible or insta-voided.
