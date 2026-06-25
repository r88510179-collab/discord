# Spec: populate `bets.event_date` at ingest (slip-vision path)

**Status:** design locked — ready for implementation. No code/PR/deploy yet.
**Owner:** Smokke. **Date:** 2026-06-25.

---

## 1. Problem

`bets.event_date` is ~97% NULL. Coverage read: every automated source is 100% NULL **except**
`vision_slip`, which is ~698/788 NULL — only ~90 vision-slip rows carry a date. No migration
produced those 90 (`001` defines the column, `029` nulls unparseable; `normalize_event_dates.js`
reformats `WHERE event_date IS NOT NULL` and cannot create a value from NULL). **The 90 were
written live by the parse path.**

Downstream cost: the grading slate, the future/too-recent guards, and the event-aware recheck all
key off `event_date` and fall back to `created_at` when NULL. For a night-before / back-to-back
pick (`created_at` = day N, game = N+1) that fallback selects the wrong slate → misgrade. This is
the documented "irreducible residual" in `services/sportsdata/index.js:341-343` ("The real cure is
populating event_date at ingest (out of scope here)"). This spec is that cure.

## 2. Root cause (confirmed from source)

- The live slip-vision path is `handlers/messageHandler.js processSlipImage` -> **`parseBetText`**
  (image + OCR text). It is **not** `parseBetSlipImage` (dead, see §6).
- `parseBetText`'s system prompt was inspected end to end: it instructs leg extraction,
  ticket_status, ladder detection, sheet-vs-parlay, DFS, props, wager/payout, anti-promo,
  anti-hallucination — and contains **no instruction to read the game date/time** anywhere.
  `event_date` appears only as `null` in the two worked examples. The ~90 hits are the model
  volunteering a date unprompted (HRB slips show game times prominently).
- When present, the value flows: `parseBetText` -> `ai.js:485` (`event_date: bet.event_date || null`)
  -> `messageHandler.js:567` (tags `source:'vision_slip'`) -> the single write gate
  `services/database.js:369` -> `normalizeEventDateForStorage`.

The write gate already does the conversion: `normalizeEventDateForStorage(raw, created_at)` stores
ISO-UTC or NULL and re-anchors a time-only string to `created_at`'s ET day. At live ingest "today"
is unambiguous (= ingest day). So the model only needs to **emit the slip's displayed date/time
string verbatim**; deterministic code resolves it. Code work is small.

## 3. Scope

Two separable workstreams. (A) is primary and small; (B) is optional and later.

- **(A) Forward-harden ingest** — make new slips reliably carry `event_date`. Fixes the bleed,
  grows EVENT_DATE_SLATE enforce coverage from ~90 -> most, and (bonus, tempered in §5.5) improves
  `EVENT_AWARE_RECHECK` scheduling for these bets (today they hit the `no_event_date` phase ->
  flat +30m).
- **(B) Backfill** the ~151 pending+NULL rows — separate, optional. Needs per-bet date resolution
  after the fact. Design deferred; the §9 grader write-back is the better mechanism for it than
  description parsing. Do (A) first, measure residual, then decide.

## 4. Granularity decision

**Bet-level now; leg-level deferred.** The triggering misgrade was a same-day parlay — a single
bet-level slate date fixes it and the single-bet common case. Leg-level is correct for multi-day
parlays but `parlay_legs` has **no date column** (everything keys off the parent `event_date`, per
`services/grading.js:985`), so it is a migration + per-leg schedule resolution = real scope. Build
it only when a multi-day parlay actually misgrades.

**Multi-day-parlay shadow (cheap, deferred):** do not build a standalone detector — the structured
adapters already resolve each leg to a specific game when they grade. Piggyback: emit a shadow row
when a parlay's resolved leg-games fall on >1 ET date. Near-free, and the resolver is what leg-level
enforce would reuse. NB: the existing `slate_shadow` event (`services/pipeline-events.js:44`) fires
only when `event_date` is present AND differs from `created_at` — a different signal; this needs its
own event.

## 5. (A) design

### 5.1 Prompt directive (two edit sites)
Add to `parseBetText`'s sys prompt: emit the game date/time **verbatim as shown on the slip**
(e.g. "Today 7:10 PM ET", "Mon 1:05 PM ET", "Apr 12 5:00 PM") into `event_date`; if no date/time is
visible, leave it null — never invent one (matches the prompt's existing "set null, don't fabricate"
posture). Keep date math in deterministic code, not the LLM: the model emits the literal string,
`normalizeEventDateForStorage` resolves it against `created_at`.
- Add **one worked example with a populated `event_date`**, and **keep an existing null example
  alongside it** so the model sees both shapes and does not drift toward always-filling.
- **Second site, parity:** the Gemma->Cerebras normalizer (`parseGemmaOutputWithCerebras` sys
  prompt) also hardcodes `event_date:null`; add the same directive there. Dormant while
  `GEMMA_FALLBACK_DISABLED=true`, so completeness-only — not the hot path.
- **Blast radius:** `parseBetText` is the shared text+vision parser, so this also populates
  `event_date` for text picks showing a time (tweets, manual). Beneficial; null when absent;
  no downside.

### 5.2 Format widening (gap confirmed from source)
`normalizeEventDateForStorage` handles today: time-only `9:10PM ET` / `3:00 PM ET` (anchored to
`created_at` ET day), leading-weekday `THU 6:29AM ET`, weekday+month+day `Thu Apr 2 @ 10:30pm`
(year from `created_at`, >7d-back wraps +1yr), numeric `4/12/26 5:00 PM`, and any `len>8` string
`Date` can parse (ISO, `YYYY-MM-DD HH:MM:SS`).

**Missing — the primary gap:** relative tokens `Today` / `Tonight` / `Tomorrow` (+ time), which HRB
renders constantly; all three fall straight to NULL (the time-only regex is `^\d`-anchored, so a
leading word never matches). Add one branch **before** the generic parse: match
`^(today|tonight|tomorrow),?\s*<time>`, resolve vs `created_at` — `today`/`tonight` -> same ET day;
`tomorrow` -> the same ET calendar day **+ 1**, fed to `etWallClockToUtc` (which normalizes
day/month/year overflow AND applies the target day's DST offset). NB: use the +1-ET-day form, **not**
a fixed `anchor + 24h` ms add — the ms add lands a day off when the anchor sits in the short window
adjacent to a spring-forward/fall-back transition. No-time relative (`Today` alone) stays NULL
(don't guess a time).
Secondary/optional: bare month+day with no leading weekday (`Apr 2 10:30pm`) also misses; low
frequency, skip v1.

### 5.3 Ingest sanity bound (safety rail — REQUIRED)
Hardening extraction shifts the failure mode from "NULL -> safe fall-through" to "wrong date ->
active misgrade" whenever the model misreads (OCR garbage, wrong month, year typo). **A NULL is
safe; a wrong `event_date` actively misdirects the slate.** Preserve that invariant: after any
branch resolves a date, clamp it against `created_at` (the anchor) before returning —

- resolved `< created_at - 2d` -> NULL (a fresh pick's game cannot be in the past beyond the
  in-play window; -2d also covers next-morning winner/recap posts and the timezone slice
  artifact). **Correctness bound.**
- resolved `> created_at + 60d` -> NULL (year typos; far futures should not carry a single game
  date anyway — `bet_type:"future"` exists; +60d leaves room for real multi-week futures).
  **Efficiency bound.**

**Gap-only — do NOT add a cross-year / year-mismatch rule.** The gap bounds already null every
wrong-year date; a separate year rule adds zero catching power and would null legitimate same-week
Dec->Jan bets (bowls, NFL W17/18, NBA) — cross-year but only days apart. Compare instants by gap,
never by calendar year. (A cross-year rule shipped as "Phase 1" in #153 and is **removed here**:
this guard keeps #153's tuned bounds but drops the year rule, so same-week Dec->Jan bets are now
preserved.)

Named constants (`EVENT_DATE_GUARD_MIN_GAP_DAYS = -2`, `EVENT_DATE_GUARD_MAX_GAP_DAYS = 60`),
tunable — **retained from the shipped #153 guard rather than retuned** to the originally-proposed
-36h/+21d, since the wider +60d forward window correctly preserves legitimate Dec->Jan / bowl /
early-playoff posts. Applied at every successful return path (incl. the new relative-token branch)
via `applyEventDateSanityGuard`. The existing `[eventDateStorage]` warn carries gapDays + an
out-of-bounds reason so the thresholds can be tightened from real logs. **Tradeoff (accepted):**
legitimately-old slips (3+ day throwback posts) lose their precise date and fall back to
`created_at` — low harm (those are usually already-settled winner slips, not live-graded).

### 5.4 Write-gate contract
Unchanged in spirit: stores ISO-UTC or NULL; junk nulls. Now **also** nulls out-of-bounds dates
(§5.3). Do **not** loosen the NULL-on-junk behavior.

### 5.5 `event_date` semantics (state explicitly)
`event_date` is a **slate-date anchor — date-accurate, not a precise settle-time.** For a single bet
it is the game time. For a same-day parlay all legs share the ET day, so any one leg's value is
correct. For a multi-day parlay the model grabs one leg's time (usually the first), so the
`EVENT_AWARE_RECHECK` "bonus" is partial: a recheck may fire before the last leg settles — it
self-corrects (finds not-final, re-defers), so not harmful, but not the clean win singles get.
Document this; do not oversell the recheck benefit.

### 5.6 Tests (unit-only — no live LLM in CI)
Do not assert against live vision in CI (flaky, costs calls, breaks the existing
`event-date-validation.test.js` pattern of deterministic normalizer + createBet write-path tests).
- `normalizeEventDateForStorage` unit cases: the three relative tokens (`today`/`tonight`/`tomorrow`
  + time -> correct ISO anchored to a fixed `created_at`).
- Bound cases: past date -> NULL, year-typo future -> NULL, normal in-bounds -> ISO.
- Write-path: a relative string through createBet -> stored ISO; junk still -> NULL.
- Regression: hot-path createBet still defaults `event_date` NULL when no date is read
  (`tests/hold-recover.test.js:611` pattern).
- The **prompt directive** is validated in prod (§8), not CI.

## 6. Non-goals / landmines

- **Do not touch `parseBetSlipImage`.** Dead code: zero call sites in the canonical checkout (only
  the definition, its own log strings, the export, and comments in `review-holds.js` /
  `linkReader.js`). Its one prospective caller — linkReader's screenshot-cutover — is shelved
  (2026-06-24). Two prior sessions mis-aimed here (ERRATA-2, datdude-silent-drop retrospective). Its
  sys prompt also has no date field. Wrong target on every axis.
- **Do not loosen** the `normalizeEventDateForStorage` NULL-on-junk / NULL-on-out-of-bounds behavior.
- **Worktree hygiene:** 16 stale `.claude/worktrees/` copies 17x every grep and are the
  wrong-worktree footgun residue — prune the abandoned ones (`git worktree list`).

## 7. Pre-implementation verification

1. ~~Prompt tail~~ **RESOLVED** — full prompt inspected through its close. No date directive
   anywhere; `event_date` only `null` in examples. Confirmed "not instructed" -> add the directive
   (two sites, §5.1).
2. ~~Write-gate formats~~ **RESOLVED** — enumerated in §5.2 from source. Gap = relative tokens; one
   new branch covers it.
3. **Shadow reuse (deferred)** — when leg-level is built, confirm the structured grader exposes
   per-leg resolved game dates at a single point so the multi-day shadow reads them without
   re-resolving.
4. **(B) source-of-truth (deferred)** — prefer §9 grader write-back over description parsing for the
   151 backfill.

## 8. Rollout + post-deploy proof (measure with existing instrumentation — no new logging)

(A) ships as a prompt + normalizer change, validated by unit tests + live sampling post-deploy. No
new feature flag. Standard `DEPLOY_CHECKLIST.md`: clean `main`, `--no-cache`, commit-hash + release-
version + log proof. Code-tab agent opens the PR and stops; Smokke squash-merges and deploys.

Proof, both zero-code:
- **Populate rate:** SQL `event_date IS NOT NULL` share for `source='vision_slip' AND created_at >
  <deploy_ts>` vs the ~11% baseline. Expect a step up.
- **Widening backlog:** grep the existing `[eventDateStorage] unparseable ... NULL` warn for formats
  the model emits that the normalizer still drops -> that is the next widening list and the bound-
  threshold tuning input.

## 9. Roadmap (NOT this PR): grader write-back

The robust long-term fix: when a structured adapter resolves a leg's game during grading, write that
game's authoritative date back to `event_date`. Deterministic, no OCR/hallucination risk — and the
better mechanism for the (B) backfill (adapter-resolve the 151 matchups -> dates, vs parsing
descriptions). More scope; touches grading writes, so idempotency/`grader_version` care required.
Keep (A) the minimal extraction fix; revisit this after (A) ships.
