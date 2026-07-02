All verification complete. Assembling the appendix.

# T8 — Config, Deploy, Docs Drift — 2026-07-01 audit appendix

All claims verified at worktree `/Users/smokke/Documents/discord/.claude/worktrees/audit-2026-07`, HEAD `19ff594` (branch `audit/2026-07-01-full`). No production DB/fly access used; live secret **values** are UNVERIFIED throughout — the prod secret **name list** was supplied by the audit orchestrator and is treated as given, not independently verified.

## 1. Flag semantics table

| Flag | Read at (file:line) | Accepted values | Unset default | Comparison | Semantics |
|---|---|---|---|---|---|
| QUOTE_BOUND_GRADING | grading.js:3505 (per-call → `applyGate3`; resolver `resolveGate3Mode` :137-140) | off/shadow/enforce | **shadow** | whitelist (trim+lowercase; unknown→shadow, never silently enforce) | enforce forces PENDING `UNVERIFIED_QUOTE`; BACKLOG:54 says prod=enforce (live value UNVERIFIED) |
| DATE_BOUND_GRADING | grading.js:3535 (per-call; `resolveGate4Mode` :228-231) | off/shadow/enforce | **shadow** | whitelist, same idiom | enforce forces PENDING `OFF_DATE_EVIDENCE`; BACKLOG:50 says prod=enforce |
| EVENT_AWARE_RECHECK | grading.js:1051-1056 (per-call) | enforce/shadow/else off | **off** | strict `===` | shadow = `event_aware_shadow` telemetry only; enforce = defer recheck to event time |
| EVENT_DATE_SLATE | sportsdata/index.js:344-349 (per-call) | shadow/enforce/else off | **off** | strict `===` | enforce keys prop slate off ET game day (`eventEtYMD` :355). **Zero mentions in CODEMAP or BACKLOG** — see T8-05 |
| PRE_FILTER_MODE | messageHandler.js:1255 & 1354 (per-message); decision `preFilter.js:51-68` | shadow/enforce/else pass | **off** (pure no-op) | strict compare in preFilter.js:52 | enforce drops only buckets listed in companion `PRE_FILTER_ENFORCE_BUCKETS` (messageHandler.js:1256) — see T8-06 |
| SOCCER_GRADER_MODE | sportsdata/index.js:68-73, applied :195 (per-call) | shadow/enforce/else off | **off** (master kill-switch: both classes off) | strict `===` | master + match-level mode |
| SOCCER_PROPS_MODE | sportsdata/index.js:76-80; ladder `soccerEffectiveModes` :88-94 | off/shadow/enforce, else null=inherit | **inherit `min(master,'shadow')`** — inherited enforce capped at shadow | strict `===` | props enforce requires explicit value |
| OCR_FIRST_MODE | ocrFirstWiring.js:38-42 (**module load**, not per-call) | off/shadow/cutover | **off** | whitelist (trim+lowercase) | flip requires process restart (fly secret set restarts the machine, so still ops-flippable on Fly) |
| LINK_READER_MODE | linkReader.js:45 (**module load**) | 'shadow' else off (`cutover` reserved → off) | **off** | strict `===` | shadow adds additive `share_link` field only |
| STRICT_MODE | messageHandler.js:805 (sole read) | 'true' | **off** (no admin-log strict alert) | strict `=== 'true'` | informational alert only |
| AUTOGRADER_DISABLED | grading.js:1764; in-memory toggle commands/admin.js:395-396 | 'true' | **unset → grader RUNS** | strict `=== 'true'` | `/admin` toggle is in-memory, lost on restart |
| GEMMA_FALLBACK_DISABLED | ai.js:983 (`shouldFallbackToGemma` :982) | 'true' | unset → fallback eligible (2nd guard fails closed without OLLAMA_URL/SECRET, ai.js:802-805) | strict `=== 'true'` | CODEMAP:567 claim (ai.js:982) EXACT at HEAD |
| TWITTER_POLLER_DISABLED | twitter.js:90; cron registered bot.js:611/614 only when TWITTERAPI_KEY/APITWITTER_KEY set | 'true' | **unset → poller RUNS** | strict `=== 'true'` | matches CODEMAP:569 |
| CAN_FINALIZE_ENFORCE | grading.js:930 (`_gateLog`) | only literal 'false' disables | **unset → ENFORCE** (default-on) | `(env \|\| 'true') !== 'false'` | non-'false' garbage value = enforce. Undocumented (T8-05) |
| GRADING_STATE_MACHINE_ENABLED | database.js:695 (`getPendingBets`) | only literal 'false' → legacy broad query | **unset → state machine ON** | `(env \|\| 'true') === 'false'` | Undocumented (T8-05) |
| DUBCLUB_SPLIT_CHANNEL_IDS | messageHandler.js:944 (CSV) | id list | unset → no bypass | CSV membership | matches CODEMAP §DubClub (claim :943, actual :944) |
| sweep/defer consts | SWEEP_DAYS=7 grading.js:1691; SWEEP_CUTOFF_MS :1692; event-aware consts :1005-1009 (MAX_DEFER_MS=168h :1009); AUTO_GRADE_INTERVAL_MINUTES bot.js:565 (default 15) | hardcoded except interval | n/a | n/a | MAX_DEFER_MS(7d)==SWEEP_CUTOFF(7d) still true at HEAD, but see T8-03 (#126 guard) |

No flag's unset-default contradicts documented intent: every tri-state gate defaults to shadow/off (fail-safe); the two default-ON flags default in the protective direction — but both are absent from the docs (T8-05).

Secrets cross-reference (against the orchestrator-provided prod name list): **every mode flag above is present as a prod secret** — none runs on code default — except companion `PRE_FILTER_ENFORCE_BUCKETS`, which is read by code (messageHandler.js:1256) but absent from the secret list (T8-06).

## 2. Findings

### T8-01 [P2] [confidence: high] CODEMAP grading.js and ai.js tables are stale far beyond the ±20 rule (up to +598 lines)
- Where: docs/CODEMAP.md:258-343 (§grading.js), :223-238 (§ai.js), :383-397 (§7-Day Sweeper)
- What / Why it matters: CODEMAP declares itself authoritative ("Read this at the START of every session", :3; ±20 refresh rule, :11) and every agent/operator is directed to it first (AGENTS.md:7). The grading.js preamble admits only "~stale-by-~103" (:297); actual drift is 2–6× that. An agent trusting these line refs lands in the wrong function — in the file that writes grades.
- Evidence (F-20 spot-check, 10 claims, claimed→actual, ± vs CODEMAP's own ±20 rule):
  1. :35 `bets.event_date` row — `database.js:369`→372 ✓PASS; GUARD-3 skew marker `grading.js:2893`→3248 (+355) **FAIL**
  2. :110 `grading_audit` row — DDL `database.js:97`→99 ✓; daily cap `grading.js:~1178`→1776 (+598) **FAIL**; `commands/admin.js:439`→478 (+39) **FAIL**
  3. :145 stage enum — `pipeline-events.js:18`→18 ✓; EVENT_TYPES 34→35 ✓; `warnUnknownEnums` 142→154 ✓ **PASS**
  4. :147 drop reasons — DROP_REASONS 43→47 ✓; VISION_* 61-63→73-75 ✓; messageHandler dropAll 995→996, drops 1125/1136/1188→1126/1137/1189 ✓; but `grading.js:2528/2531`→~2883/2886 (+355) **partial FAIL**
  5. :164-193 messageHandler — `sendHoldReviewEmbed` 13→16 ✓, `getImageAttachments` 413→415 ✓, `handleSlipFeed` 605→618 ✓; `processAggregatedMessage` 917→987 (+70) **FAIL**, is_bet=false branch 1128→1234 (+106) **FAIL** (drift from #137's pre-filter insert; the #84 note :195 already owed a refresh)
  6. :226-237 ai.js — `parseBetText` 909→998 (+89), `parseBetSlipImage` 1135→1225 (+90), `validateParsedBet` 1602→2009 (+407), `KBO_TEAMS` 1716→1871 (+155), `validateLegSportConsistency` 1949→2220 (+271) — **entire table FAIL**
  7. grading.js core rows — `reduceParlayResult` 209→349 (+140), `canFinalizeBet` 860→906 (+46), `scheduleRecheckAfterDenial` 1029→1075 (+46), `gradeSingleBet` 2767→3122 (+355), `finalizeBetGrading` 3303→3696 (+393) — **FAIL**
  8. §7-Day Sweeper rows — SWEEP_DAYS `grading.js:1128`→1691 (+563), `evaluateSweep` 1154→1720 (+566) — **FAIL**
  9. holdReview — `handleHoldInteraction` 21→21 ✓, `dismissHold` 84→84 ✓, `recoverHold` 340→450 (+110) **FAIL**, GRACE_DAYS 333→383 (+50) **FAIL**
  10. database.js/bot.js — `getOrCreateCapper` 321→321, `createBet` 350→350, `createBetWithLegs` 602→606, `getPendingBets` 690→694, `approveBet` 967→971; bot.js import 30→43, InteractionCreate 135→149, RECEIPTS 729→743 — **all PASS** (≤±20)
- Proposed fix: full refresh of the grading.js + ai.js + messageHandler + holdReview tables against HEAD (the shift sources are #146/#149/#150/#153/#154/#156/#157). Effort M
- Backlog: NEW (CODEMAP :195 "full messageHandler table refresh is owed" is the only tracked fragment)

### T8-02 [P2] [confidence: high] BACKLOG soccer Build 1/1b/1c/1d headers still say "PR open / not deployed"; deploy-state prose contradicts prod secret set
- Where: docs/BACKLOG.md:200, 209, 213, 216, 219-220
- What / Why it matters: #140 (`4f265ff`), #142 (`2c2c706`), #144 (`d61bf82`), #145 (`b0dbea8`) are all merged at HEAD (git log verified), yet the headers say "PR open / not deployed" and :213/:220 assert "prod secret `SOCCER_GRADER_MODE=shadow` + `SOCCER_PROPS_MODE` unset" / "default off, PR open". `SOCCER_PROPS_MODE` **is present** in the prod secret list, contradicting "unset" (its value — reportedly `enforce` since 2026-06-26 — is UNVERIFIED here). Same stale claim is hardcoded in the code comment `services/sportsdata/index.js:65-67`. An operator consulting BACKLOG before touching the soccer flags gets the pre-flip world: the props DNP→VOID "sign-off pending" warning (:212, :217) reads as still-gating when the flag may already be enforcing.
- Evidence: `git log --oneline` shows all four merged; BACKLOG:209 "— additive, PR open / not deployed"; index.js:66 "Current prod secret SOCCER_GRADER_MODE=shadow with SOCCER_PROPS_MODE unset"
- Proposed fix: mark the four Builds SHIPPED with merge hashes; record the actual current flag values after an in-container `printenv` check; fix the index.js comment. Effort S
- Backlog: extends the prior audit's M-11 class (docs/audits/2026-06-10-coa-full-audit.md:202)

### T8-03 [P2] [confidence: med] EVENT_AWARE_RECHECK enforce-flip "blocked" item not updated for #126, which shipped the prescribed remedy
- Where: docs/BACKLOG.md:226-227; docs/CODEMAP.md:572 (env row) and :316 (consts row, "Resolve before flipping … sweep-exempt deferred bets — the latter touches the sweeper, outside #124's scope")
- What / Why it matters: the blocker's own listed remedy — "sweep-exempt deferred bets" — was shipped 2026-06-18 as #126 (`50d9296`): `evaluateSweep` (grading.js:1740-1742) returns `{eligible:false, reason:'event_pending'}` under enforce when `nextAttemptForEvent(bet.event_date, now).defer` is true, exactly closing the defer-then-false-LOSS window the blocker describes. Neither BACKLOG nor the CODEMAP env row mentions it, so the flip decision is being made against stale risk facts (either the flip is needlessly deferred, or the guard gets re-implemented). CODEMAP's `evaluateSweep` row (:392) also still lists the reason enum as `fresh|prop|grace|eligible` — missing `event_pending` (#126) and `parked` (grading.js:1757).
- Evidence: grading.js:1740 `if (eventAwareRecheckMode() === 'enforce' && nextAttemptForEvent(bet.event_date, now).defer) return { eligible: false, reason: 'event_pending' };` — vs BACKLOG:227 "Resolve before flipping: … or sweep-exempt deferred bets"
- Proposed fix: update both docs to state the collision is guard-mitigated by #126; re-scope the open item to the residual flip-readiness reads (shadow split + attempts/day baseline). Whether the flip is now safe is a maintainer call. Effort S
- Backlog: docs/BACKLOG.md:226 (the item itself is the stale artifact)

### T8-04 [P3] [confidence: high] docs/MEMORY.md ledger convention effectively abandoned — newest entry #156 while #157–#161 are merged; ~25 earlier merges never appended
- Where: docs/MEMORY.md:8-13
- What / Why it matters: the ledger's stated convention is "append one line per significant merge, newest first" (:8). At HEAD, merged-but-absent: #157, #158, #159, #160, #161 (git log: `ee1a2ee`, `0068cbd`, `1000e75`, `71d05a5`, `19ff594`) plus the entire #128-#155 range except #130 (missing code PRs include #128, #129, #132, #134, #135, #137-#140, #142-#146, #149, #150, #153, #154). Only #156 was ever appended after the ledger's creation (#131/#133). A "what shipped" ledger that stops at #156 actively misleads the sessions it exists to protect from memory drift.
- Evidence: docs/MEMORY.md:13 (top entry `- **#156**`); `git log --oneline -40` at HEAD lists the five newer merges
- Proposed fix: backfill one line per missing significant merge; either enforce the convention (CI presence check like the DEPLOY_CHECKLIST one in ci.yml:36-39) or drop the convention text. Effort S
- Backlog: NEW

### T8-05 [P3] [confidence: high] CODEMAP "Env vars that gate behavior" table missing ≥6 live gating flags; EVENT_DATE_SLATE and PRE_FILTER_* absent from ALL docs
- Where: docs/CODEMAP.md:561-576
- What / Why it matters: the table covers 7 flags but omits: `EVENT_DATE_SLATE` (#134 — zero hits anywhere in CODEMAP or BACKLOG despite workflow rule 5 "update this file in the same PR"), `PRE_FILTER_MODE`/`PRE_FILTER_ENFORCE_BUCKETS` (#137 — zero hits in either doc), `OCR_FIRST_MODE` (named only in BACKLOG:292/:313, not CODEMAP), `CAN_FINALIZE_ENFORCE` and `GRADING_STATE_MACHINE_ENABLED` (zero hits in either doc — and both are default-ON with only-literal-'false' kill switches, the exact shape an operator can misjudge). STRICT_MODE is also absent from the table (covered only under §#admin-log).
- Evidence: `grep -n "PRE_FILTER_MODE\|EVENT_DATE_SLATE\|CAN_FINALIZE_ENFORCE\|GRADING_STATE_MACHINE_ENABLED" docs/CODEMAP.md docs/BACKLOG.md` → only 2 BACKLOG OCR_FIRST hits; read sites verified at messageHandler.js:1255/1256, sportsdata/index.js:344-349, grading.js:930, database.js:695
- Proposed fix: add the missing rows using the semantics table in §1 above. Effort S
- Backlog: NEW

### T8-06 [P2] [confidence: med] PRE_FILTER_MODE=enforce is a silent no-op without PRE_FILTER_ENFORCE_BUCKETS — companion var not in prod secrets and documented nowhere
- Where: handlers/messageHandler.js:1256-1257; services/preFilter.js:16-17, 64-65
- What / Why it matters: enforce drops only buckets opted in via `PRE_FILTER_ENFORCE_BUCKETS` (CSV of promo/recap/sweat). That var is absent from the prod secret list, so setting `PRE_FILTER_MODE=enforce` today would change nothing (every match falls to `action:'shadow'`, preFilter.js:67). The per-bucket opt-in is a deliberate safety design (preFilter.js header) — but it is documented only in the source file; an operator "flipping enforce" from the flag list would believe non-bets are being dropped when holds still fire. Operator-deception, not correctness.
- Evidence: preFilter.js:64 `if (mode === 'enforce' && enforced) { return { bucket, reason, action: 'drop' }; }` — `enforced` false for every bucket when the CSV is empty
- Proposed fix: document the two-var contract in CODEMAP env table (T8-05) and log a boot/first-use warning when mode=enforce with an empty bucket list. Effort S
- Backlog: NEW

### T8-07 [P3] [confidence: high] Seven prod secrets have zero code reads — dead legacy toggles, one a live credential
- Where: repo-wide (no file — that is the finding)
- What / Why it matters: `TWITTER_EMAIL`, `TWITTER_PASSWORD`, `TWITTER_USERNAME`, `TWITTER_RAPIDAPI_KEY`, `APIFY_WEBHOOK_SECRET`, `RAPIDAPI_KEY`, `BALLDONTLIE_API_KEY` appear in the prod secret list but have **zero** references anywhere in the repo (code, scripts, docs). `TWITTER_PASSWORD` is presumably a real credential sitting in the environment of a process that never uses it — pure exposure surface. (Names only per audit rules; presence in prod is per the orchestrator-provided list, UNVERIFIED directly.)
- Evidence: `grep -rn "TWITTER_EMAIL\|TWITTER_PASSWORD\|TWITTER_USERNAME\|TWITTER_RAPIDAPI_KEY\|APIFY_WEBHOOK_SECRET\|RAPIDAPI_KEY\|BALLDONTLIE_API_KEY" --include="*.js" .` (excl. node_modules) → 0 hits; docs grep → 0 hits
- Proposed fix: `fly secrets unset` the seven after a maintainer confirms no off-repo consumer (Surface Pro services read their own env, not Fly's — but confirm). Effort S
- Backlog: NEW

### T8-08 [P3] [confidence: high] #157's grader-eligibility gate missing from CODEMAP's §9 write-back rows (same-PR doc rule violated)
- Where: docs/CODEMAP.md:35 (bets schema row) and the §grading.js `writeBackResolvedEventDate` row (:340)
- What / Why it matters: both rows describe the write-back UPDATE as `WHERE id=? AND event_date IS NULL`; the shipped SQL (post-#157, `ee1a2ee`) is `... AND ${GRADER_ELIGIBLE_WHERE}` (grading.js:2709). Minor, but it is a correctness-relevant invariant (the side-write now refuses alongside a refused grade) that the authoritative map doesn't know about.
- Evidence: grading.js:2709 `` `UPDATE bets SET event_date = ? WHERE id = ? AND event_date IS NULL AND ${GRADER_ELIGIBLE_WHERE}` ``
- Proposed fix: one-line edits to both rows. Effort S
- Backlog: NEW

### T8-09 [P3] [confidence: high] Prompt-vs-repo drift: this audit's spec says `docs/AGENTS.md`; the file lives at repo root
- Where: AGENTS.md:1 (repo root); docs/ contains no AGENTS.md (only AGENT-GIT-SAFETY.md)
- What / Why it matters: reported per track instructions — the audit spec's own path is wrong, not the repo. Repo convention (root) is consistent with the auto-memory note "AGENTS.md:6-10" and with #133 wiring the read-list into root AGENTS.md.
- Evidence: `ls docs/` → no AGENTS.md; `Read AGENTS.md` → read-list at :6-11
- Proposed fix: correct the audit-spec template for future runs. Effort S
- Backlog: n/a (audit-tooling, not repo)

### T8-10 [P3] [confidence: high] CODEMAP Conventions header still pins accuracy to `d76761d` (2026-05-20), six weeks and ~40 merges stale
- Where: docs/CODEMAP.md:9
- What / Why it matters: "Line numbers are accurate as of commit `d76761d` (main, 2026-05-20)" is contradicted by every per-section refresh note below it and by T8-01's measurements; it anchors false confidence in exactly the doc that demands trust.
- Evidence: docs/CODEMAP.md:9 vs refresh notes at :260-297, :357-362, :429
- Proposed fix: replace with "per-section refresh dates; see section preambles" or update on each refresh. Effort S
- Backlog: NEW

## Looked good
- **DEPLOY_CHECKLIST.md matches code/infra at HEAD.** Step numbering coherent (1, 2, 2a, 3, 3a, 4, 4a, 4b, 5, 5a, 6, 7, 8, 9); step 5a running-container marker-grep present (:156-170) and consistent with CODEMAP §Fly deploy invariants (:653-658); step 9's ollama round-trip env vars still read in code (`OLLAMA_URL` ai.js:58/802, grading.js:3387); step 7's example commands all exist (`/health quick` commands/health.js:22/61, `/admin list-channels` commands/admin.js:101/401, `/grade test` commands/grade.js:21/133). No impossible/renamed steps.
- **CI matches the "check + tests only" invariant** — .github/workflows/ci.yml runs `npm run check` + `npm run test:reliability` (which includes `tests/migration-validation.js` and `tests/grader-gate-sync.test.js`) plus two doc-presence asserts; no deploy step; fly.toml `[env]` carries only NODE_ENV/PORT — all flags live as secrets.
- **docs/SEASON-RESET.md is accurate at HEAD** — every sampled claim exact: `ACTIVE_SEASON` database.js:175, season bind :378, `getCapperStats`/`getLeaderboard` :804/:820, bypass sites bot.js:314/:462, boot guard database.js:62, migrator PK :24 / sorted discovery :42-44 / duplicate-column tolerance :61-71 / no on-disk assertion for recorded filenames; `006_add_season_to_bets.sql` confirmed deleted, `006_add_season_column.sql` survives (closes dup-006 as documented at BACKLOG:241-242).
- **All tri-state gates fail safe** — unknown/typo'd values resolve to shadow (Gates 3/4) or off (soccer/event-aware/slate/OCR/link-reader); none can silently enforce.
- **#118/#125 gate-parity claim is real** — `tests/grader-gate-sync.test.js` exists and is in `test:reliability`; the BACKLOG:174 "no test enforces the equality" caveat is superseded by #125 (this is itself a micro-staleness inside a shipped entry, noted not filed).
- **database.js, bot.js, pipeline-events.js, holdReview.js (top rows) CODEMAP tables** — all within ±20 (see T8-01 items 3, 9, 10).

## UNVERIFIED / open questions
- **Live values of every mode flag** (QUOTE_BOUND/DATE_BOUND=enforce, EVENT_AWARE=shadow, SOCCER_GRADER/SOCCER_PROPS, EVENT_DATE_SLATE, PRE_FILTER_MODE, OCR_FIRST_MODE, LINK_READER_MODE, etc.) — no fly access granted this track; the prod secret **name** list itself is orchestrator-provided. Doc-vs-value claims in T8-02 rest on presence-in-list plus session memory, not an in-container `printenv`.
- **Whether runtime image (v756–v758) == HEAD** — deploys landed during the audit; every "at HEAD" claim here is about the repo, not the running container.
- **Off-repo consumers of the 7 dead secrets (T8-07)** — Surface Pro services and the scraper live in other repos; confirm none read Fly's env (they shouldn't — they have their own PM2 env) before unsetting.
- **`flydeploy` alias** — referenced by DEPLOY_CHECKLIST step 5 as an operator shell alias; not verifiable from the repo.
- **Whether #126's `event_pending` guard fully unblocks the EVENT_AWARE enforce flip (T8-03)** — the guard closes the described defer-then-sweep window, but the post-event recheck-vs-sweep residual and the shadow-read sizing steps remain a maintainer judgment.
