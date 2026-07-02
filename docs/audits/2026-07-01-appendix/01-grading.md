# T1 Grading Integrity — 2026-07-01 audit appendix

Worktree HEAD verified: `19ff594c8dd7553cdc6f41362b1a6f2f867e6ba8` (branch audit/2026-07-01-full). All paths below relative to `/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`. Runtime env values (gate modes on Fly) were NOT probed — no fly access in this track; where a finding is mode-gated the live mode is tagged UNVERIFIED.

## 1. Grade/status writer census (every UPDATE touching result/grade/profit_units/review_status/grading_state)

| # | Writer | Where | Gates covering it |
|---|--------|-------|-------------------|
| 1 | `gradeBetRecord` (central) | services/database.js:624-676 | atomic `result='pending'` + parlay pending-leg count; `requireGraderEligible` review-gate is OPT-IN (:647-649) |
| 2 | — caller: AI grader `finalizeBetGrading` | services/grading.js:3737-3744 | Gates 1-4 + G5-9 + Gate 2 (`decideFinalGradeWrite` :3708) + `canFinalizeBet` + requireGraderEligible |
| 3 | — caller: 7-day sweeper | services/grading.js:1908 | `evaluateSweep` + `canFinalizeBet` + requireGraderEligible; NO evidence gates (writes LOSS on age alone) |
| 4 | — caller: celebration auto-grade | services/grading.js:1976-1978 | pool `review_status='confirmed'` (:1946) + `canFinalizeBet`; NO evidence gates, NO requireGraderEligible, allowAutoConfirm=true |
| 5 | — caller: capper-graphic auto-grade | handlers/messageHandler.js:700 | pool confirmed-only (database.js:254-258) + `canFinalizeBet`; NO evidence gates, NO requireGraderEligible, allowAutoConfirm=true |
| 6 | — callers: manual `/grade`, war-room buttons, `/admin revert-hallucinations` | commands/grade.js:285; handlers/gradeButtons.js:61; commands/admin.js:333-338 | human-driven; `canFinalizeBet` only (by design) |
| 7 | Retry-cap VOID | services/grading.js:1089-1100 | `result='pending'` + `GRADER_ELIGIBLE_WHERE`; no evidence |
| 8 | No-data auto-VOID | services/grading.js:1240-1250 | audit-content heuristic + adapter exemption (:1202) + `GRADER_ELIGIBLE_WHERE` |
| 9 | Unmodeled divert (review_status/grading_state only) | services/grading.js:2809-2818 | `GRADER_ELIGIBLE_WHERE`; result untouched |
| 10 | Unscoped auto-VOID | services/grading.js:2853-2866 | `GRADER_ELIGIBLE_WHERE` |
| 11 | Parlay leg result | services/grading.js:3077-3079 | none (leg-level; parent write still gated) |
| 12 | `/grade override` rewrite | services/gradeOverride.js:84-106 | bypasses ALL gates by design; OWNER-gated (commands/grade.js:81), archives to bet_grade_history |
| 13 | `revertBetToPending` / `approveBet` / auto-confirm | services/database.js:728-741 / :233-241 / :672 | admin/war-room only |
| 14 | `!reset_season` archive | bot.js:482 | Administrator permission (bot.js:463) |
| 15 | Scheduling-only writes (claim/backoff/defer/unstick) | grading.js:948-977, 1134-1152, 1812; commands/admin.js:503-561 | non-terminal |
| 16 | Scripts (operator-run) | scripts/retro-parlay-loss.js:245; scripts/cleanup_*.js | offline |
| 17 | holdReview backdate + grace | services/holdReview.js:370, :385 | see T1-03 |

Paths bypassing ALL evidence gates: #3-#6, #12, #14, #16. Of these, #4/#5 are the only AUTONOMOUS ones (see T1-02).

## 2. Gate 3/4 enforce wiring — VERIFIED LIVE IN CODE
Gate 3 enforce branch forces PENDING via `earlyReturn` at services/grading.js:3517-3522 (`if (g3.forcePending)` → `UNVERIFIED_QUOTE`); Gate 4 at :3545-3550 (`if (g4.forcePending)` → `OFF_DATE_EVIDENCE`). Both are real control-flow, not markers. docs/BACKLOG.md:50 records both flags `enforce` in-container as of 2026-06-15 (runtime today UNVERIFIED).

---

### T1-01 [P1] [confidence: high] Gate 5 absent: a season-aggregate quote can still grade a single-game bet — zero deterministic enforcement
- Where: services/evidenceRecords.js:20-22, :222; services/grading.js:3408 (`scope: TODO(Gate 5)`), :3412-3430 (prompt)
- What / Why it matters: the only defenses against grading "Player X has 25 HR this season" as a single-game Over are (a) the prompt line "If no final score found for this game on ${betDate}, return PENDING" and (b) Gate 4's DATE check. A season-stats page published on game day passes Gate 3 (quote is a verbatim substring) and Gate 4 (article date in-window; or `no_date_signal` pass-through), and Guards 5-9 check teams/scores, not scope. `scope: null` is an explicit stub. This is the highest-probability remaining wrong-grade vector for props that fall through the adapters to search+LLM.
- Evidence: evidenceRecords.js:222 `scope: null, // scope: TODO(Gate 5) — season-vs-game scope tag added later`; grading.js prompt (read at :3412-3430) contains no season/aggregate rule; M-15 in docs/audits/2026-06-10-coa-full-audit.md:49 already named this — unchanged since.
- Proposed fix: implement the planned scope tagger on evidence records (regex tier: "this season", "season high", "in his last N games", per-season stat-line shapes) + a Gate-5 tri-state that forces PENDING when the quote-bearing record is season-scoped. Ship shadow first, same B0 marker pattern. (Effort M)
- Backlog: existing — BACKLOG "Grading gates 4–5 (off-date + season-vs-game scope reject)" (~line 529) / M-15.

### T1-02 [P1] [confidence: high] Celebration auto-grade matches on ANY shared ≥3-char word — can settle the WRONG bet as WIN/LOSS and auto-confirm it
- Where: services/grading.js:1964-1978
- What / Why it matters: `words.some(w => w.length >= 3 && desc.includes(w))` — generic tokens ("the", "over", "under", "runs", "team") pass the length filter and match as SUBSTRINGS anywhere in the description. A celebration whose AI-extracted subject contains one generic word grades the OLDEST pending confirmed bet from that capper containing that substring — evidence-free, `allowAutoConfirm=true`, bankroll applied. Bypasses Gates 2/3/4 and G5-9 entirely. #94 fixed the POOL (confirmed-only, :1946); the MATCH predicate is the unfixed half. Sibling `autoGradeBet` (messageHandler.js:670 → database.js:254-258 `LIKE %term%`) is less loose (whole-subject substring) but shares the no-evidence, no-word-boundary shape.
- Evidence: grading.js:1965 `const match = words.some(w => w.length >= 3 && desc.includes(w));` — e.g. subject "the over" vs any description containing "over".
- Proposed fix: require ≥2 non-stopword word-boundary matches (or one multi-token proper-noun match), stopword-list the market words (over/under/team/runs/the), and log the matched term to the War-Room embed for human audit. (Effort S)
- Backlog: NEW.

### T1-03 [P1] [confidence: med] recoverHold writes a DATE-ONLY event_date directly, bypassing normalizeEventDateForStorage — CODEMAP invariant broken; ET off-by-one under EVENT_DATE_SLATE=enforce
- Where: services/holdReview.js:355-374 (write at :370)
- What / Why it matters: `_backdateRecoveredBets` stores `eventDate: iso.slice(0, 10)` ("2026-06-01") via a raw `UPDATE bets SET created_at = ?, event_date = ?`. CODEMAP:35 asserts event_date is "Write-gated by normalizeEventDateForStorage … never time-only/free-text", and the §9 write-back comment (grading.js:2666-2667) states date-only "breaks eventEtYMD under EVENT_DATE_SLATE enforce". A date-only string parses as UTC midnight → `eventEtYMD` (services/sportsdata/index.js:355-361, etParts) resolves to the PREVIOUS ET day. Under `EVENT_DATE_SLATE=enforce` (:417-421) the slate is that wrong day AND `absenceVoidAllowed = Boolean(evEt)` = true → false DNP-VOIDs, and for consecutive-day series (MLB) the adapter can match the prior day's game between the same teams → wrong WIN/LOSS. Mode-gated: live EVENT_DATE_SLATE value UNVERIFIED; in off/shadow the damage is limited to eventYMD===createdYMD granting same-day absence-VOID off a UTC-sliced day.
- Evidence: holdReview.js:357 `eventDate: iso.slice(0, 10), // 2026-06-01`; :370 raw UPDATE; contrast eventDate.js:142-217 (the guard this skips).
- Proposed fix: route the backdate through `normalizeEventDateForStorage(message ISO, dates.createdAt)` (stores the full slip-post instant or NULL), or store NULL event_date and let §9 self-heal it. (Effort S)
- Backlog: NEW (event_date arc; relates #153/#154/#134).

### T1-04 [P2] [confidence: high] EVENT_AWARE_RECHECK=enforce is still not sweep-safe: #126 guard covers pre-event only; post-event settling and >7d-out events are unprotected — and the BACKLOG entry is stale
- Where: services/grading.js:1740-1742, :1038-1045, :1691-1692, :1882-1908; docs/BACKLOG.md:225-226
- What / Why it matters: constants verified: `MAX_DEFER_MS = 168h` (:1009) == `SWEEP_CUTOFF_MS` (SWEEP_DAYS=7, :1691-1692), sweeper keys off `created_at` (:1721-1722). The original "deferred bet swept before recheck" race is CLOSED for the defer window: (a) #126's guard (:1740) skips `defer:true` bets under enforce, and (b) a deferred bet has future `grading_next_attempt_at`, so `getPendingBets` (database.js:708) hides it from the snapshot entirely. THREE residuals remain: (1) `phase='post_event'` returns `defer:false` (:1045) — the cycle the recheck fires, a >7d-old bet gets exactly ONE grade attempt; if it returns PENDING (adapter "game not yet final", data settling — the exact case POST_EVENT_RECHECK_MS=45m exists for), the sweeper in the SAME cycle sweeps it to FALSE LOSS (:1882-1908; backoff state doesn't protect — only `grading_state='done'` does, :1756-1757). (2) `suspect_far_future` (>7d-out event, :1038-1040) returns `defer:false` → a legitimately-dated future bet older than 7d sweeps to LOSS even under enforce. (3) postponed games: event passes, `defer:false` forever → swept LOSS, not VOID. Also drift: BACKLOG:225-226 still says the flip is "blocked … resolve before flipping: … sweep-exempt deferred bets" without acknowledging #126 shipped that guard, and cites stale lines (:963/:1593/:1622 vs actual :1009/:1691/:1720).
- Evidence: `nextAttemptForEvent` :1042-1045 (`msUntil > 0` is the only defer=true branch); `evaluateSweep` :1740 gates only on `.defer`; sweeper loop :1893-1908 runs after the grader loop on the same snapshot.
- Proposed fix (required before enforce): extend the :1740 guard to also skip `phase === 'post_event'` within a settle horizon (e.g. `now < readyAt + 24h`), and skip `reason === 'suspect_far_future'` (or stamp `sweep_exempt_until` when writing an enforce defer). Update the BACKLOG entry either way. (Effort S)
- Backlog: existing — BACKLOG "Event-aware recheck — enforce flip blocked" (needs rewrite to the residual list above).

### T1-05 [P2] [confidence: med] §9 event_date write-back verified sound, but a wrong-but-nearby adapter match permanently pins a wrong date (no correction path), including from PENDING resolutions
- Where: services/grading.js:2680-2724 (write :2708-2710), call sites :3295, :3319; services/sportsdata/mlb.js:268, nba.js:153
- What / Why it matters: verified at HEAD: NULL-only (`AND event_date IS NULL`), #157's `GRADER_ELIGIBLE_WHERE` present (:2709), routed through `normalizeEventDateForStorage` (−2d/+60d gap guard, eventDate.js:96-97 — blocks cross-year/2023-slate garbage), parlay legs are a structural no-op (synthetic `-legN` id :3062 has no bets row). Adapter dates are full ISO instants (mlb `gameDate`, espn `event.date`) so no date-only/timezone regression. Residual: adapters slate off `created_at` in off/shadow mode (sportsdata/index.js:426-430), so a same-teams adjacent-day match (MLB series, doubleheaders) inside the −2/+60 window resolves the WRONG game — its date is then written ONCE and never corrected (NULL-only means no self-heal of a wrong heal), and event-date-first consumers (slate enforce, event-aware defer, Gate 4 anchor) trust it thereafter. Note `resolved:true, status:'PENDING'` ("game not yet final") ALSO writes (:3287-3295 fires on `structured.resolved` regardless of status) — reasonable, but it means a mismatched scheduled game can pin the date before any grade exists.
- Evidence: grading.js:3287 `if (structured.resolved) { … writeBackResolvedEventDate(bet, structured.eventDate, …)`; mlb.js:268 returns `resolved: true, status: 'PENDING', … eventDate: game.gameDate`.
- Proposed fix: log-and-monitor first (the write already logs :2716); consider excluding `status==='PENDING'` resolutions or adding an operator `event_date=NULL` reset to `/admin revert-by-id`. (Effort S)
- Backlog: NEW (annotation on the event_date arc; do not regress #156/#157).

### T1-06 [P2] [confidence: high] The 7-day sweeper's terminal is LOSS, never VOID — "no data after 7d" becomes a wrong grade for postponed/canceled events and is the designated backstop for adapter-exempt bets
- Where: services/grading.js:1902-1922; :1194-1195
- What / Why it matters: `gradeBet(bet.id, 'loss', …)` (:1908) writes a real LOSS with bankroll impact on nothing but age. The Build-1d no-data-void exemption explicitly names "the untouched 7-day sweeper" as the backstop for adapter sports (:1194-1195) — i.e. bets the system COULDN'T settle get a false LOSS, not a VOID, violating "a wrong grade is worse than pending or void". Postponed/canceled games and dated futures (event >7d out, T1-04 residual 2) are the concrete wrong-grade shapes. Ops history (Tier-C 86-bet exemption, B1 re-arms) shows this fires on real backlogs.
- Evidence: :1908 grade literal `'loss'` + reason "Auto-swept: pending >7 days"; no code path sweeps to void.
- Proposed fix: sweep to VOID (or to a `manual_review_swept` park) when the bet has zero WIN/LOSS-capable audit rows (all attempts no-data), keeping LOSS only where at least one attempt saw real game evidence. (Effort M — policy change, needs owner sign-off)
- Backlog: NEW.

### T1-07 [P2] [confidence: high] War-room grade buttons compute profit from EMBED-parsed odds/units, not the DB row
- Where: handlers/gradeButtons.js:36-62
- What / Why it matters: `odds`/`units` are parsed out of the Discord embed fields (:42-44) with defaults −110/1, then `calcProfit` + bankroll write. A stale, edited, or units-omitted embed silently writes wrong `profit_units`/bankroll for a correct result — books lie to the operator. The bet row is fetched from the DB only AFTER grading (:69).
- Evidence: :42 `const odds = parseInt((oddsField?.value || '-110')…)`; :48 `calcProfit(odds, units, result)`; DB fetch at :69 post-write.
- Proposed fix: fetch the bet row first and compute from `bet.odds`/`bet.units` (embed as display only). (Effort S)
- Backlog: NEW.

### T1-08 [P3] [confidence: high] Dead, UNGATED `stmts.gradeBet` prepared statement — a one-call footgun that overwrites finalized grades
- Where: services/database.js:188
- What / Why it matters: `UPDATE bets SET result=?, … WHERE id = ?` with NO `result='pending'` gate, no leg check, no review gate. Zero callers at HEAD (verified: every `gradeBet` reference resolves to `gradeBetRecord` or grading.js `finalizeBetGrading`), but it sits one refactor away from becoming a gate-bypassing writer.
- Evidence: `grep -n "stmts.gradeBet" services/*.js` → no call sites; statement text at :188.
- Proposed fix: delete the statement. (Effort S)
- Backlog: NEW.

### T1-09 [P3] [confidence: high] Quarantine (M-4 update): still no automatic exit; only a per-bet manual release exists
- Where: services/grading.js:967-976 (entry, attempts≥20); commands/admin.js:496-579 (exit)
- What / Why it matters: entry unchanged. Exit at HEAD: `/admin grading-unstick` lists quarantined (LIMIT 25, :516-520) and force-readies ONE bet per invocation (:559-561). No reaper, no bulk release, no terminal void — quarantined pending bets are permanent zombies unless individually rescued (June audit counted 11-18 live). Partial progress vs M-4 ("no admin surface" now false; "no reaper" still true).
- Evidence: pickup query `grading_state IN ('ready','backoff')` (database.js:706, grading.js:956) never re-picks; only writer setting `quarantined→ready` is the single-bet unstick.
- Proposed fix: M-4's proposed nightly reaper (void quarantined >7d, mirroring GRADE_BACKOFF_EXHAUSTED) — or park them to `needs_review` for human triage per the T1-06 philosophy. (Effort M)
- Backlog: existing — M-4 (2026-06-10 audit :135-146).

### T1-10 [P3] [confidence: high] /grade override leaves stale `grade` letter and Gate-2 provenance on the corrected row
- Where: services/gradeOverride.js:84-87
- What / Why it matters: the override UPDATE rewrites `result/profit_units/grade_reason/graded_at` but NOT `grade` (a win→loss override keeps grade='B'), `evidence_hash`, or `grader_version`. Displays and any future Gate-2 audit read a letter/provenance contradicting the result — operator-deception hygiene. Grade write itself is safe (bet_grade_history archived, OWNER-gated, txn).
- Evidence: :85-87 `UPDATE bets SET result = ?, profit_units = ?, grade_reason = ?, graded_at = datetime('now') WHERE id = ?` — no `grade`/hash columns.
- Proposed fix: set `grade` from the result map and null the Gate-2 hash (marking "human final"). (Effort S)
- Backlog: NEW (#150 follow-up).

## 7. Parlay `-legN` convention — verified consistent
Writer: `gradeParlay` synthesizes `${parlayBet.id}-leg${i+1}` (grading.js:3062); those ids flow into `grading_audit` (writeGradingAudit :3093-3118) and `pipeline_events` (earlyReturn recordDrop :3184). Consumers that PARSE the suffix: `shouldAutoVoidNoData` (`bet_id = ? OR bet_id LIKE '${id}-leg%'`, :1219-1222), migration-016 backfill (database.js:162), scripts/retro-parlay-loss.js:143/:160. Bet ids are 32-char hex (`crypto.randomBytes(16).toString('hex')`, database.js:294) — cannot contain `-leg`, and ids embed no LIKE metacharacters, so no false suffix matches. `pipeline_events` rows with synthetic bet_ids have no bets row; the only reader found (routes/admin.js /drops) displays rather than joins — no consumer breaks.

## Looked good
- Gate 2 idempotency: `decideFinalGradeWrite` (grading.js:67-84) + atomic stamp in gradeBetRecord (database.js:654-655); version bump alone cannot rewrite a final.
- #118/#125/#157 grader-vs-revert closure: `GRADER_ELIGIBLE_WHERE` on all four terminal grader writes (:1100, :1250, :2815, :2863) AND the §9 side-write (:2709); parity test `tests/grader-gate-sync.test.js` exists; sweeper + AI grader pass `requireGraderEligible`.
- getPendingBets dual-selector review exclusion NULL-safe (database.js:694-711); celebration + graphic pools confirmed-only (#94 holds).
- approveBet single atomic gated UPDATE incl. `sweep_exempt_until` +3d (database.js:233-241); `sweepGraceUntil` compares in SQLite clock (grading.js:1707-1713).
- Parlay never sweeps with ungraded legs: `parlay_legs.result DEFAULT 'pending'` (migrations/001:42) → `canFinalizeBet` pending_legs denial → retry-cap VOID, not LOSS.
- Unmodeled-league divert is sweeper-safe twice over (review_status + grading_state='done' live re-read, grading.js:1756-1757); migration-016 boot backfill is settings-gated one-shot, does not re-arm parked bets.
- §9 parlay no-op, NULL-only, guard-NULLed-date refusal all verified as documented in CODEMAP:35.

## UNVERIFIED / open questions
- Live env modes today (QUOTE_BOUND_GRADING / DATE_BOUND_GRADING / EVENT_AWARE_RECHECK / EVENT_DATE_SLATE / CAN_FINALIZE_ENFORCE / SOCCER_*): no fly access this track; BACKLOG:50 attests Gates 3/4 enforce as of 2026-06-15, EVENT_AWARE shadow per #124 — runtime may differ from HEAD (v756-758 deployed mid-audit).
- T1-02 live frequency: mechanics confirmed from code; how often the celebration classifier emits generic-word subjects needs a `pipeline_events`/log read (production DB out of scope).
- T1-03 blast radius: count of recovered bets carrying date-only event_date needs a prod query (`WHERE length(event_date)=10`).
- Whether espn.js's own game-date search window can select an adjacent-day game (T1-05 premise) was not traced into services/espn.js matching internals this pass.
- BACKLOG:146 compound-sport parlays (`MLB/NHL`) still auto-void at the `isSupportedSport` gate — money-neutral (VOID) so not re-ranked here; still open.
