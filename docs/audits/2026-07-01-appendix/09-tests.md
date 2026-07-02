All evidence gathered. Composing the appendix now.

# T9 — Tests and CI — 2026-07-01 audit appendix

Worktree `/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07` @ `19ff594` (branch `audit/2026-07-01-full`). Static analysis only; suite NOT executed (write-forbidden). CI greenness verified via read-only `gh`.

## 1. Suite inventory

96 `.js` files under `tests/` (5 are `*.stub.js` service stubs, 1 fixture JSON). Execution is defined by two hand-maintained `&&` chains in `package.json`: `check` (syntax-only, `node --check`, package.json:10) and `test:reliability` (executes 82 files, package.json:11). CI (`.github/workflows/ci.yml:26-30`) runs both, plus two docs-presence checks (ci.yml:36-44). No `node --test` runner exists anywhere.

Cross-diff of disk vs the two chains (command: python set-diff over package.json + `os.walk('tests')`, output verified this session):

- **On disk but NEVER EXECUTED (9 files):** `grade-skip-too-recent.test.js`, `nba-nhl-canonicalize-substring.test.js` (both syntax-checked only), `holds-dedup.test.js`, `pre-filter.test.js`, `parsed-payload-shape.test.js`, `ocr-scanner.test.js`, `twitter-image-parsing.test.js`, `prop-engine-validation.js`, `vision-fallback-validation.js` (this last one intentionally CI-unrunnable — needs OLLAMA_URL, self-described "sanity probe", tests/vision-fallback-validation.js:1-10).
- **Executed but not syntax-checked (4, cosmetic):** `db-concurrency-validation.js`, `grading-validation.js`, `message-handler.integration.js`, `reliability-validation.js` — execution parses them, so no gap in practice.

## 2. Findings

### T9-01 [P1] [confidence: high] Four merged-PR invariant tests exist on disk but never execute in CI — including the #139 wrong-grade-class guard
- Where: package.json:11 (`test:reliability`) vs tests/nba-nhl-canonicalize-substring.test.js, tests/holds-dedup.test.js, tests/pre-filter.test.js, tests/grade-skip-too-recent.test.js
- What / Why it matters: `nba-nhl-canonicalize-substring.test.js` (added by #139, commit `ea589a5`) pins the word-boundary `canonicalize()` fix in `services/sportsdata/nba.js`/`nhl.js` — its own header (lines 11-13) says the substring bug "could route a player prop to the game-total grader — the same class as the MLB #130 false-WIN." It is in `check` (syntax only) but absent from `test:reliability`, so a regression re-opening a wrong-grade path fails NO CI step. Same pattern: `holds-dedup.test.js` (#132, `70a21cf`) and `pre-filter.test.js` (#137, `83dde73`) both say "Run: node --test …" in their headers but no `node --test` runner exists and neither chain lists them; `grade-skip-too-recent.test.js` self-labels "P1 — bet-idempotency" (line 2) and is syntax-checked only. The invariant enforcement CODEMAP and PR descriptions claim is, for these four, zero.
- Evidence: python set-diff output this session: "In check but NOT in test:reliability: tests/grade-skip-too-recent.test.js, tests/nba-nhl-canonicalize-substring.test.js"; "ON DISK but NOT in test:reliability: … holds-dedup … pre-filter …". `grep -c preFilter package.json` → `0`. tests/holds-dedup.test.js:14 "Run: node --test tests/holds-dedup.test.js"; tests/pre-filter.test.js:17 same idiom.
- Proposed fix: add the four to `test:reliability` (they are hermetic: holds-dedup/pre-filter are pure, no DB; the other two use temp DB_PATH). Verify green locally first. (Effort S)
- Backlog: NEW

### T9-02 [P2] [confidence: high] Test wiring is two hand-maintained &&-chains; forgetting to wire is a proven, recurring failure mode
- Where: package.json:10-11
- What / Why it matters: every new test must be appended to two ~8KB single-line strings. T9-01 shows this failed on at least 4 separate merged PRs (#132, #137, #139, plus the SKIP_TOO_RECENT test) — each shipped believing its test gated CI. The chain is also fail-fast (`&&`), so one mid-chain failure hides every later failure (the Jul-1 red run reported only the first breakage), and there is no per-test reporting.
- Evidence: package.json:11 (single `&&` chain of 82 invocations); gh run 28540182756 job log shows the suite step as a single pass/fail unit.
- Proposed fix: replace both chains with a small runner that globs `tests/**/*.test.js` + the `-validation.js` list (explicit exclude-list for the OLLAMA probe), runs each in a child process, and reports all failures. `check` similarly derivable. (Effort M)
- Backlog: NEW

### T9-03 [P2] [confidence: high] Message-buffer keying/merge semantics have zero direct coverage
- Where: handlers/messageHandler.js:69-73 (`messageBuffer`, key `${userId}:${channelId}`, 4s window) vs tests/message-handler.integration.js
- What / Why it matters: the buffer is the front door for every multi-message post (TweetShift text+image). The integration suite enters at `processAggregatedMessage` or the bypass path (tests/message-handler.integration.js:447, 507, 519) — `bufferMessage`'s key construction, timer reset, and flush are never exercised. A keying regression (e.g. dropping userId) would silently merge different cappers' picks in one channel into one bet — a wrong-attribution/wrong-content bet with no failing test.
- Evidence: `grep -n "bufferMessage" tests/message-handler.integration.js` → no hits (only `processAggregatedMessage` at :39, :417, :447, :507, :519).
- Proposed fix: unit test `bufferMessage` with fake timers/injected delay: (a) two users, same channel, same instant → two flushes; (b) one user, two messages <4s → one flush with both images; (c) >4s gap → two flushes. (Effort M)
- Backlog: NEW

### T9-04 [P2] [confidence: high] createBetWithLegs fingerprint dedup (last-line duplicate-bet defense) has no direct test; the integration suite substitutes a re-implemented mock
- Where: services/database.js:304, 351-382 (`buildFingerprint`, `getBetByFingerprint` lookup, concurrent-insert race catch at :382)
- What / Why it matters: this is the final defense against double-counted bets (upstream `findRecentRepost` deliberately ignores tweet id and is well-tested; the fingerprint is the only gate for id-different duplicates outside the 12h window). No test requires or asserts it: `grep -rln "buildFingerprint\|getBetByFingerprint" tests/` → empty. Worse, `message-handler.integration.js` fakes dedup with its own `dedupeWriter` key logic (tests/message-handler.integration.js:108-165), so the mock can drift from the real invariant and every integration test stays green.
- Evidence: grep output above; tests/sweeper-grace.test.js:71 comment "unique → no fingerprint dedup" (tests dodge it rather than test it).
- Proposed fix: DB-level test: insert identical betData twice → same id, 1 row; simulate the UNIQUE-constraint race branch (:382) → returns existing row, no throw. (Effort S)
- Backlog: NEW

### T9-05 [P2] [confidence: med] 7-day sweep terminal-LOSS path has no end-to-end test; only its parts are covered
- Where: services/grading.js:1883-1908 (evaluateSweep verdict → `canFinalizeBet` → `gradeBet(bet.id, 'loss', …, { requireGraderEligible: true })`)
- What / Why it matters: the sweep is the system's only unattended auto-LOSS writer. `evaluateSweep` is pure-tested (tests/sweeper-grace.test.js, incl. real `sweep_exempt_until` stamps :86; tests/event-aware-sweep-guard.test.js A1 `event_pending` :107-113), and the gradeBet eligibility flag is tested in isolation (tests/grader-revert-race.test.js:216-219, "sweeper-shaped call"). But no test drives the actual loop: a >7d pending bet in the DB ends with `result='loss'`, and a `sweep_exempt_until`-stamped or `event_pending` bet does not. The glue (verdict→gate→write ordering, the re-read noted at grading.js:1905) is where a wiring regression would emit wrong LOSSes at scale.
- Evidence: greps above; no test file references `sweeper_7d` (grading.js:1896) or invokes the runAutoGrade sweep block.
- Proposed fix: integration test on a temp DB invoking the sweep block (export via `_internal` if needed): eligible→loss written; exempt/grace/event_pending/needs_review→untouched. (Effort M)
- Backlog: NEW

### T9-06 [P3] [confidence: high] docs/BACKLOG.md still claims "no test enforces" the GRADER_ELIGIBLE_WHERE parity that #125 enforces
- Where: docs/BACKLOG.md:174 vs tests/grader-gate-sync.test.js:1-33
- What / Why it matters: BACKLOG:174 ends "**Sync risk (documented, not asserted): … no test enforces the equality.**" — stale since #125 shipped `grader-gate-sync.test.js`, which imports both runtime constants and asserts set-equality (and IS in `test:reliability`). Operator reading BACKLOG would re-do or mistrust shipped enforcement. CODEMAP:309 already states it correctly — the two docs contradict.
- Evidence: both files read this session at HEAD.
- Proposed fix: one-line BACKLOG edit pointing at the test. (Effort S)
- Backlog: existing BACKLOG §#118 entry (correct the note)

### T9-07 [P3] [confidence: high] CI hygiene: Node 20 deprecation on runners; docs-presence steps are content-free
- Where: .github/workflows/ci.yml:20, 36-44
- What / Why it matters: gh annotations on every run: "Node.js 20 is deprecated … forced to run on Node.js 24" (actions runtime; `node-version: '20'` for steps still installs 20 — prod Dockerfile parity should be confirmed before bumping). The two `test -s docs/*.md` steps gate only non-emptiness — they cannot fail meaningfully. Nothing in ci.yml uses `continue-on-error` (good — no silent skips).
- Evidence: `gh run view 28540182756` ANNOTATIONS block (output this session); ci.yml read at HEAD.
- Proposed fix: bump `node-version` to match the Dockerfile's runtime; leave docs checks or replace with a link-check. (Effort S)
- Backlog: NEW

## 3. Invariant coverage map (P0/P1 list derived from CODEMAP + both prior audits)

| Invariant | Status | Where |
|---|---|---|
| Gate 1 parlay reduction | COVERED | parlay-reducer.test.js, parlay-loss-shortcircuit.test.js, oneleg-parlay-complete.test.js (all executed) |
| Gate 2 idempotency (decideFinalGradeWrite + flipped-status no-overwrite) | COVERED | grade-idempotency.test.js:1-12 (pure table + DB integration) |
| Gate 3 quote-bound (mode resolution incl. garbage→shadow, never silent enforce; enforce→PENDING) | COVERED | grade-quote-validator.test.js:117-142; gate3-would-fire-audit.test.js |
| Gate 4 date-bound | COVERED | gate4-evidence-records.test.js, gate4-off-date.test.js:2 |
| GRADER_ELIGIBLE_WHERE ⇔ GRADER_HIDDEN_REVIEW_STATUSES parity (#125) | COVERED | grader-gate-sync.test.js (live-constant set-equality); BACKLOG stale → T9-06 |
| Sweeper cutoff + sweep_exempt_until + event_pending guard | PARTIAL | components: sweeper-grace.test.js:86, event-aware-sweep-guard.test.js:107-113, grader-revert-race.test.js:216-219; loop glue untested → T9-05 |
| nextAttemptForEvent defer math | COVERED | event-aware-recheck.test.js |
| is_bet===false hard rule (incl. pure-slip skip-hold) | COVERED | message-handler.integration.js:253-278, :333-385 |
| Buffer keying (userId:channelId, 4s merge) | **ZERO** | → T9-03 |
| Dedup: findRecentRepost 12h window | COVERED | twitter-repost-dedup.test.js, dedup-leak-check.test.js |
| Dedup: createBetWithLegs fingerprint + race catch | **ZERO** | → T9-04 |
| Leg-sport validators (set-split, unmodeled skip, \b anchoring) | COVERED | leg-sport-consistency-validation.js, leg-sport-substring.test.js, validator-leg-shape.test.js, leg-sport-resolution.test.js |
| canonicalizeSport / alias canonicalization | COVERED | sport-casing.test.js, sport-alias-canonicalization.test.js |
| event_date write guard (#153/#154 gap-only, Dec→Jan preserved) | COVERED | event-date-guard.test.js:1-28, event-date-validation.test.js |
| event_date write-back + #157 eligibility gate + NULL-only no-clobber | COVERED | event-date-writeback.test.js:103-152 (A6/A7 pin the GRADER_ELIGIBLE_WHERE clause) |
| Hold release / approve atomicity, needs_review exclusion everywhere | COVERED | admin-approve-write.test.js, approve-resets-grading-state-validation.js, revert-hardening-validation.js, grader/celebration-skips-needs-review-validation.js |
| Unmodeled-sport divert (#113) | COVERED | unmodeled-sport-manual-review.test.js |
| No-data-void adapter exemption (#145) | COVERED | autovoid-adapter-exemption.test.js (fetch stubbed offline, :31) |
| OCR-first gating + SGP gate | COVERED | tests/ocr-first/{ocr-first,wiring,sgp-gate}.test.js (all executed) |
| NBA/NHL word-boundary canonicalize (#139) | **TEST NEVER RUNS** | → T9-01 (CODEMAP:350-351 cites the test as enforcement — drift) |
| /holds messageUrl collapse (#132); pre-filter decision table (#137); SKIP_TOO_RECENT audit suppression; PARSED payload shape | **TESTS NEVER RUN** | → T9-01 |
| Phantom-team stopwords + GUARD 7b (#149) | COVERED | stopword-alias-phantom.test.js |
| MLB prop→total guard / matchup reroute / surname collision (#130/#135/#138) | COVERED | mlb-prop-total-guard, mlb-matchup-prop-reroute, mlb-canonicalize-substring-surname (all executed) |

## 4. Top 10 highest-value tests (ranked)

1. **Wire the 4 orphaned tests into test:reliability** (T9-01) — arrange: append to chain; assert: CI executes them. (S)
2. **createBetWithLegs fingerprint dedup** (T9-04) — insert identical betData twice on temp DB; assert same id + 1 row; force UNIQUE race → returns existing. (S)
3. **bufferMessage keying** (T9-03) — two users same channel same instant → 2 aggregates; same user split post → 1 aggregate with both images. (M)
4. **Sweep end-to-end LOSS write** (T9-05) — >7d pending bet → result='loss'; sibling with sweep_exempt_until / needs_review / future event_date → untouched. (M)
5. **Migrator legacy-row tolerance** — seed schema_migrations containing deleted `006_add_season_to_bets.sql` row (post-#160 state); assert migrator runs clean and applies 031+ (protects every future migration against the dup-006 class; migration-validation.js:35-42 only covers fresh DBs). (M)
6. **Pre-filter hold-branch integration** — messageHandler MANUAL_REVIEW_HOLD branch with mode=shadow: assert hold still written + one shadow event; mode=off byte-identical (extends the pure test that isn't even wired). (M)
7. **runner meta-test** (with T9-02) — glob tests/ and fail if a `*.test.js` is absent from the executed set; makes T9-01's failure mode structurally impossible even before the runner rewrite. (S)
8. **normalizeForDedup / fingerprint interplay** — a repost 13h later with identical content: findRecentRepost passes it, fingerprint must NOT collapse it (asserts the deliberate id-in-fingerprint behavior BACKLOG:16 describes). (S)
9. **grader-health MILLIS windows** — freeze clock; grading_audit row at now−23h (millis) counted, now−25h excluded; guards the seconds-vs-millis quirk admin-read-endpoints relies on (grading.js:2288). (S)
10. **PARSED payload shape wiring** — add parsed-payload-shape.test.js to the chain; invariant "type and betCount cannot disagree" (its header cites a real v340 prod lie). (S)

## 5. CI status

- **What CI gates:** `npm run check` (syntax) + `npm run test:reliability` + 2 docs-presence checks (ci.yml:26-44). Triggers: push→main and PR→main only. No lint, no coverage, no continue-on-error, 10-min timeout. CI does not deploy — merged ≠ deployed (Fly manual), so runtime v756–v758 may differ from HEAD.
- **Main is green:** `gh run list --branch main --limit 8` — all 8 success; latest 28590701697 (#161 merge, 2026-07-02T12:40Z, 3m10s).
- **Jul-1 #159 episode (verified):** PR run 28540182756 (docs-only #158 branch) failed at "Reliability test suite" 2026-07-01T23:25Z — wall-clock dependence: NBA/NHL season windows ended Jun 30, flipping offseason-dependent expectations. Fixed by #159 (injectable `opts.now`, TEST_NOW=2026-05-07 pinned — tests/validate-parsed-bet.test.js:20-23); main push run 28554286373 success 23:21Z. Note precisely: no main *push run* ever failed (no push landed while red); the redness surfaced on PR runs — "main went red" in docs/MEMORY.md is shorthand for "the suite at main's tree was red."
- Adapter tests are network-hermetic (global.fetch stubbed: soccer-grader.test.js:246, dnp-terminal-state.test.js:55, autovoid-adapter-exemption.test.js:31 rejects outright).

## Looked good

- Every Gate (1-4), the #157 write-back eligibility gate, and the #125 parity assertion are executed in CI with real temp-DB integration, not just pure-function checks (grade-idempotency Part B; event-date-writeback A6/A7).
- Tests isolate DB_PATH to os.tmpdir() before requiring database.js (event-date-guard.test.js:35-38 idiom, consistent across suite) — no prod-DB touch risk from CI.
- Post-#159 the known wall-clock dependence class is pinned (TEST_NOW), and offseason logic is injectable end-to-end.
- ci.yml has zero skip/soft-fail paths; docs checks aside, everything is a hard gate.
- RED-proof discipline is documented inside test headers (event-date-guard.test.js:24-27) — tests state how to prove they can fail.

## UNVERIFIED / open questions

- Whether the 4 orphaned tests are currently green (suite execution forbidden this audit; holds-dedup/pre-filter are pure and likely fine, but nba-nhl-canonicalize and grade-skip-too-recent load service modules that have since evolved — they may have silently rotted; run them before wiring).
- Whether `ocr-scanner.test.js`, `twitter-image-parsing.test.js`, `prop-engine-validation.js` are deliberately retired legacy (they predate the chains' current form; git archaeology not done) — if retired, delete; if not, wire or mark.
- Dockerfile Node version vs ci.yml `node-version: '20'` parity (Dockerfile not read this track — T9-07 fix should confirm before bumping).
- Whether prod QUOTE_BOUND_GRADING / DATE_BOUND_GRADING are enforce or shadow (env-only, no fly access granted this track; tests cover both modes either way).
