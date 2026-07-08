# event_date diagnosis — findings (READ-ONLY pass, no code changed)

**Date:** 2026-06-25 · **HEAD:** `fb96490` (== main) · **Live prod env:** `EVENT_DATE_SLATE=shadow`, `SOCCER_GRADER_MODE=enforce` (verified via `fly ssh`).

Method: 4-way parallel static code analysis (write-paths / consumers / flag / wrong-vs-null) with an independent reconciliation pass, plus read-only SQL against prod `/data/bettracker.db` (`run-fly-sql.sh`, `{readonly:true}`). **No code, no PR, no DB writes.**

---

## TL;DR

- **event_date is NULL on 96.9% of bets (2822 / 2913).** Only **91** rows are populated, and **every one of them comes from `source='vision_slip'`** — even there the hit-rate is only 11.5% (91 / 793). Every other ingest path (`twitter_vision` 1376, `twitter_text` 383, `discord` 193, `twitter` 104, `untracked_win` 61, …) is **100% NULL.**
- **NULL and WRONG are two separate bugs**, with different causes, code paths, and blast radii:
  - **NULL (the 96.9%)** = an *ingest population gap*. No ingest path threads a game date into `event_date`; the only opportunistic populator is the vision model, unprompted and unreliable. NULL is the *designed-safe* outcome — every consumer falls back to `created_at` — but the fallback misgrades back-catalog / series bets (e.g. `8cac8e5d`).
  - **WRONG (≈17 of the 91 populated)** = *corrupt written values*. The vision extractor sometimes emits a real-but-wrong ISO datetime (mostly stale tournament years for soccer/WC, e.g. `e2feed30` "Japan vs Sweden" → `2023-11-26`). These pass the write-gate (they *are* valid datetimes) and are then **trusted event_date-first** by the AI grader + search-query builder → wrong-year grading.
- **The fix is primarily INGEST-side** (populate `event_date` correctly at write), with a **grade-side backfill** for the stuck back-catalog and a **small write-gate sanity guard** to stop the wrong-year writes. `EVENT_DATE_SLATE=enforce` is the *consumer* of good population — it stays a near-no-op until population is fixed.

---

## 1. Where is event_date WRITTEN?

**One gate, one bypass.** Every bet-creation path funnels through `createBet()` (`services/database.js:350`) → `insertBet` (`:185`, `:359`), and the `event_date` column value is always `normalizeEventDateForStorage(betData.event_date)` (`services/database.js:369`; gate body `services/eventDate.js:78-127`). `createBetWithLegs` (`:602`) delegates to `createBet` (`:609`). The gate returns **NULL or an ISO-8601 UTC datetime, never a raw string**. The **only** write that bypasses the gate is `recoverHold`'s backdate `UPDATE bets SET created_at=?, event_date=?` (`services/holdReview.js:370`), which writes a date-only `YYYY-MM-DD` derived from the Discord message snowflake (`:353-358`) and is intentionally un-normalized (`eventDate.js:21-23`).

| Ingest path | Sets event_date? | Source | Proof |
|---|---|---|---|
| Discord slip image — OCR-first | **no** | never (hardcoded `null`) | `services/ocrFirstWiring.js:218`; slip branch `handlers/messageHandler.js:567` (`source:'vision_slip'`) |
| Discord slip image — AI/vision (`parseImage`) | **conditional** | vision-extracted (model sometimes emits a date) | `services/ai.js:485` (`event_date: bet.event_date \|\| null`); vision prompt has **no date directive** — only `event_date:null` JSON-shape examples (`ai.js:872/1031/1034`, slip prompt `:775-789`) |
| Discord text (no image) | **no** | never | `messageHandler.js:1464`; AI parse `ai.js:485`; regex fast-path hardcodes `null` `ai.js:693` |
| DubClub split-channel bridge | **no** | never | `messageHandler.js:931-959` → `processAggregatedMessage` `:987` → same text path `:1464`. No DubClub-specific date logic. |
| Twitter relay | **no** | never | `services/twitter-handler.js:287` (ladder), `:318` (picks) **omit** `event_date` → `undefined` → gate returns null |
| `/bet` slash command | **no** | never | `commands/bet.js:42` (`event_date: bet.event_date` from `parseBetText`, always null) |
| WarRoom split-parlay → singles | **no** | never (**drops parent's date**) | `services/warRoom.js:452`, `:491` copy fields but omit `event_date` |
| WarRoom untracked-win log | **no** | never | `services/warRoom.js:601` |
| recoverHold backdate (post-create UPDATE) | **conditional** | Discord snowflake (date-only, ungated) | `holdReview.js:710` (initial `null`) then `:350-372` backdate UPDATE; skipped if timestamp missing |
| `/grade`, `/grade override`, `/admin` | n/a | not bet-creation | `commands/grade.js:148` (in-memory fakeBet, never inserted), `:193`/`commands/admin.js:223` are read-only SELECTs |

**Concrete reasons event_date ends up NULL at write time:**
1. **The AI/vision/regex parsers never set it.** `normalizeBet` does `event_date: bet.event_date || null` (`ai.js:485`); the vision/Gemma prompts contain no date-extraction directive; the regex fast-path hardcodes `null` (`ai.js:693`). → every text bet, `/bet`, and the OCR-first slip path store NULL.
2. **Twitter + WarRoom payloads omit the field entirely** (`twitter-handler.js:287/318`, `warRoom.js:452/491/601`) → `undefined` → gate → NULL.
3. **The gate drops anything unparseable to NULL** (`eventDate.js:79`, `:125-126`): null/undefined, empty, bare numbers (`length<=8`), or strings matching none of the time-only / month-day / M-D-Y / generic-Date branches.

---

## 2. WHY is it null/wrong? (prod DB distribution)

> Snapshot taken mid-session; total drifted 2913 → 2916 as live bets ingested. Rates below use the 2913 baseline.

**Overall:** `null=2822 (96.9%)`, `populated=91 (3.1%)`. `created_at` is **never null** (`0 / 2916`).

**By `source` (there IS a `source` column — the prompt's "no source column" premise was wrong; it's the cleanest proxy):**

| source | n | null | populated |
|---|---|---|---|
| twitter_vision | 1376 | 1376 | **0** |
| vision_slip | 793 | 702 | **91** |
| twitter_text | 383 | 383 | 0 |
| discord | 193 | 193 | 0 |
| twitter | 104 | 104 | 0 |
| untracked_win | 61 | 61 | 0 |
| hold_review_script | 3 | 3 | 0 |
| twitter_mobile / manual_hold_release | 1 / 1 | 1 / 1 | 0 |

→ **`vision_slip` (Discord slip OCR/vision) is the sole populator of `event_date`.** Notably `twitter_vision` (the Twitter slip-image equivalent, and the *single largest bucket*) is 100% null because Twitter ingestion routes through `twitter-handler.js`, which omits the field.

**By month (legacy vs current):** `2026-04` 7/677 · `2026-05` 31/1263 · `2026-06` 53/975. Even June 2026 is **94.6% null** → this is an **ongoing** write-side gap, *not* merely old rows. (Migration `029` did null out legacy junk — see §contributing history — but it does not explain current writes.)

**Lane proxy (Discord vs Twitter-relay, by `source_tweet_id` presence):** discord-lane `75/1311` populated; twitter-lane `16/1603` populated. All 91 populated rows are `vision_slip` (slip images arrive via both lanes).

**Pending bets:** `162 / 176 = 92%` NULL. Pending is dominated by **Soccer 91 (89 null)** + **World Cup 23 (20 null)** + MLB 18 — matching the "Tier C stuck-PENDING" report. The `sweep_exempt_until` cohort (the prior Tier-C exemption) = 587 rows, 511 null, 135 pending.

**The "wrong" cohort — of the 91 populated rows:** `17` year-mismatch (event year ≠ created year), `17` event_date *before* created_at, `3` >7d after created (these 3 are **benign** legit future events, +8/+9d in April 2026). The wrong rows are **all `vision_slip`** and cluster hard in **Soccer / World Cup / NCAAM** with 2001 / 2022 / 2023 dates:

```
id        sport   event       created     dd     descr
5a56c9bf  NCAAM   2001-04-04  2026-04-04  -9131  Michigan vs Arizona Over 157.5
150c23cb  Soccer  2022-11-26  2026-06-18  -1300  Son Heung-Min 2+ Shots …
e2feed30  WorldCup 2023-11-26 2026-06-25   -942  Japan vs Sweden Over 2.5 Goals
496aa9bb  Soccer  2023-11-21  2026-06-25   -947  Both Teams To Score / Arda Güler …
…(13 more, mostly Nov–Dec 2022/2023 soccer)
```

**Root-cause hypothesis (null vs wrong are TWO bugs):**
- **NULL** = missing/absent input. The dominant, systemic gap: no ingest path supplies a date; `vision_slip` is the only opportunistic source and it succeeds only 11.5% of the time. Safe-by-design (consumers fall back to `created_at`) but causes wrong-day misgrades on series/back-catalog bets.
- **WRONG** = corrupt-but-valid input. The vision model occasionally emits a real ISO datetime with a stale year (recognising e.g. "Japan vs Sweden" as a 2023 fixture and dating it accordingly). The write-gate accepts it because `datetime('2023-11-26 …')` parses. ~37% of the *populated* values are implausible. Actively harmful because downstream code trusts a present `event_date` over `created_at`.

The forward-only year-wrap in the gate (`eventDate.js:106-107`, mirror `ai.js:2393`) is **not** the cause of the 2023 values — it can only push a date to year+1, never back to 2023. The 2023 values are written **verbatim** from the model's string via the generic / M-D-Y branches (`eventDate.js:113-118`, `:122-123`).

---

## 3. What CONSUMES event_date? (fallback map + traced examples)

**The fallback direction is inconsistent across consumers — this is the crux.**

| Consumer | File | Date precedence | On NULL |
|---|---|---|---|
| `getBetDate` (structured slate selector) | `services/sportsdata/index.js:300-302` | **created_at FIRST** (`created_at \|\| event_date`) | event_date branch is **dead** (created_at never null) → slate = created_at's YMD |
| `tryStructured` slate + `absenceVoidAllowed` | `index.js:401-433` | off/shadow: `getBetDate` (created_at-first); enforce: `eventEtYMD(event_date) \|\| createdYMD` | off/shadow: slate=created_at, VOID forbidden; enforce: falls back to createdYMD, VOID forbidden |
| `routeSoccer` (soccer adapter day) | `index.js:203` → `soccer.js:163-181` | **created_at FIRST** (`getBetDate`), queries fifa.world scoreboard at `dateYMD ± 1` | created_at drives it; ±1 absorbs TZ slack, **not** a multi-day gap |
| `tryGradeViaESPN` (ESPN game day) | `services/espn.js:417-438` | **event_date FIRST** (`event_date \|\| created_at`); UTC slice, tries `dateStr` then `dateStr-1` | falls back to created_at; both null → `no_date` |
| AI-grader GUARD 1/2/3 (future / too-recent) | `services/grading.js:3128-3172` | **event_date FIRST** (`:3135`) | uses created_at; both null → GUARD 1 PENDING "No event date" |
| `buildGraderSearchQuery` (LLM search date) | `grading.js:2095-2105` (`:3239`) | **event_date FIRST** | dates the search string off created_at |
| `nextAttemptForEvent` (recheck / sweep guard) | `grading.js:1022-1045` | **event_date ONLY** (no created_at fallback, `:997-999`) | `reason:'no_event_date'`, `defer=false` → **NOT** sweep-protected |
| `evaluateSweep` (7d sweeper) | `grading.js:1719-1760` | **age keyed on created_at** (`:1720`); event_date only via enforce-gated guard | NULL → not shielded → eligible to be swept to a **false loss** if >7d, non-prop, not parked |
| `/admin verify-grades` suspect query | `commands/admin.js:218-224` | flags `event_date IS NULL OR date(event_date)>=today` | NULL treated as **SUSPECT** |

**The exact chain for a NULL-event_date bet reaching the slate:** off/shadow → `slateYMD = getBetDate = created_at's YMD`, `absenceVoidAllowed = Boolean(eventYMD && createdYMD===eventYMD) = false`; enforce → `eventEtYMD(null)=null` → `slateYMD = createdYMD`, `absenceVoidAllowed = false`. In **every** mode a null bet is sliced against `created_at` and the DNP/absence VOID is forbidden (falls through to search/LLM). `getBetDate` specifically does **not** fall back created_at→event_date — the event_date branch only fires if `created_at` itself is falsy, which never happens.

### Traced example A — `8cac8e5d` (misgrade via NULL → created_at fallback)
- `event_date = NULL`, `source = vision_slip`, `created_at = 2026-06-24 22:31:55`. Parlay; leg 2 = "Nationals vs Phillies Under 9.5".
- **Archived original grade** (`bet_grade_history`, before `/grade override`): `result=loss (-15u), grade D` — *"leg 2 … lost. Total 23 > 9.5. Phillies 14, Nationals 9 (Final)"*. That's the **6/23** game.
- Real **6/24** game: Phillies 5-4 → total 9 → Under 9.5 **wins**.
- **Mechanism:** with NULL `event_date`, the grader keyed off `created_at` (event_date-first chain falls back to created_at). Nationals/Phillies played a multi-day series; lacking an authoritative game date the grader resolved the **wrong day** (6/23, total 23 → false LOSS). A human corrected it with `/grade override` (`grade_reason` records the diagnosis). **A correct populated event_date (the real 6/24 first-pitch datetime) would have pinned the right game.** → This is the **NULL** bug, *not* a wrong written value.

### Traced example B — `e2feed30` (slate/grade hazard via WRONG written value)
- `event_date = 2023-11-26T19:00:00.000Z` (valid ISO, wrong year), `source = vision_slip`, `created_at = 2026-06-25`, World Cup, **pending**.
- The 2023 value is a **wrong written value** from vision extraction — distinct from NULL.
- Under the **current** config (`EVENT_DATE_SLATE=shadow`, so structured paths are created_at-first), the **structured soccer adapter** queries the **2026** fifa.world slate → "Japan vs Sweden" not found → **stuck PENDING** (the immediate symptom). But the **event_date-first** consumers — `buildGraderSearchQuery` (`grading.js:2098`, → "November 26, 2023") and the ESPN game path (`espn.js:421`) — *do* key on 2023, so the bet is a latent **wrong-year misgrade** hazard via the search/LLM grader. Flipping `EVENT_DATE_SLATE=enforce` would *also* point the structured soccer/prop slate at 2023. The fifa.world slug is fixed (`soccer.js:31`); only the **date param** selects the tournament — so the wrong *year* is the entire cause, not a "default to old tournament."

**Verdict on the prompt's questions:** the stale-date misgrade in (a)/`8cac8e5d` is the **null→created_at fallback**; the slate-miss in (b)/`e2feed30` is a **genuinely-wrong written value**. They are different bugs.

---

## 4. EVENT_DATE_SLATE flag

Confined entirely to the structured layer (`services/sportsdata/index.js`) — `grep` confirms **0** references in `grading.js`. Default `'off'` for unset/unknown (`index.js:344-349`). Live prod secret = **`shadow`** (verified via `fly ssh`; the flag is absent from `fly.toml`, `.env.example`, and `docs/` — it's a Fly secret only).

- **off** (default): `slateYMD = getBetDate` (created_at-first); `absenceVoidAllowed = Boolean(eventYMD && createdYMD===eventYMD)`. Byte-equivalent to pre-#134.
- **shadow** (current prod): real result identical to off; additionally emits one `slate_shadow` pipeline_events row when `eventEtYMD(event_date)` is present **and** differs from `createdYMD` (`index.js:438-449`) — pure telemetry.
- **enforce**: `slateYMD = eventEtYMD(event_date) || createdYMD` (event_date-first, resolved to the **ET** game day via `etParts` so a ≥8pm-ET game doesn't roll a UTC day); `absenceVoidAllowed = Boolean(eventEtYMD)`. Adapters inherit the corrected meaning via `opts.absenceVoidAllowed !== false` (e.g. `nba.js:442`), signature unchanged.

**Would fixing population unblock enforce? — YES; they are coupled, with population as the prerequisite.**
- enforce only changes behavior for bets whose `event_date` is **present and parseable**. With `event_date = NULL`, `eventEtYMD(null)=null` → enforce degrades **exactly to off** (`slateYMD=createdYMD`, VOID forbidden — the "irreducible residual," `index.js:341-343`). So today, on a 96.9%-null table, enforce is a **near-no-op**: safe, but it buys almost nothing.
- Worse, enforce **trusts** a present `event_date` enough to fire a provable-absence VOID against that slate. With ~37% of *populated* values being wrong-year garbage, flipping enforce *today* would convert some of those into **false VOIDs** that off's stricter `created==event same-day` predicate currently refuses.
- The code itself names the cure: *"The real cure is populating event_date at ingest (out of scope here)"* (`index.js:343`). **enforce is the consumer; population is the supplier.** Fix population (non-null **and** correct) → enforce widens coverage from the tiny present-and-divergent slice to the full night-before / back-to-back / series back-catalog, and its VOID-trust becomes well-founded.

---

## 5. Contributing history (why NULL has two provenances)

- `bets.event_date` exists since the **initial commit** `2522dcf` (2026-03-18); it was **ungated for ~3 months** — `createBet` stored the extractor's raw string verbatim.
- The write-gate (`normalizeEventDateForStorage`) + **migration `029_null_unparseable_event_dates.sql`** both landed in `2e0d75b` (2026-06-10, PR #70). `029` runs on every boot via `runMigrations` (`database.js:19`) and **NULLed every legacy row** whose value SQLite couldn't parse (time-only, junk). **Asymmetry:** `datetime('2023-11-26 …')` parses fine → `029` never touched a **valid-but-wrong** legacy datetime; those survive untouched (a second source of wrong-year rows alongside today's verbatim passthrough).
- `scripts/normalize_event_dates.js` (`658035e`, 2026-04-12) is a one-shot manual `fly ssh` backfill with **no caller, no runner, no doc reference** — no evidence it ever ran. It is not the explanation for anything.

So today's NULLs are overwhelmingly **current write-side gaps** (the 94.6% June rate), not legacy `029` residue.

---

## 6. Recommended fix SHAPE (not implemented — diagnosis only)

**Both sides, sequenced; ingest-side is the root cure.**

1. **INGEST-side population (root cause, highest leverage).** Thread a real game date into `event_date` at write for the paths that currently drop it:
   - Add an explicit **date/time extraction directive** to the vision + text parsing prompts (`ai.js`) and surface it through `normalizeBet` (`ai.js:485`) instead of `|| null`. The slip image almost always prints a start time; the model just isn't asked for it.
   - Map the **tweet/post timestamp** into `event_date` on the Twitter path (`twitter-handler.js:287/318`) and **stop dropping the parent's `event_date`** when WarRoom splits a parlay (`warRoom.js:452/491`).
   - This is where 96.9% lives. Scope it per-path; `twitter_vision` (1376, 0 populated) and `vision_slip` (the 88.5% of slips still null) are the biggest wins.

2. **Write-gate sanity guard (stops the WRONG bug cheaply).** In `normalizeEventDateForStorage` (`eventDate.js`), reject / NULL a parsed datetime that is **implausibly far from `createdAt`** (e.g. year mismatch, or more than N days before created). This converts the 17 wrong-year rows from *actively-harmful corrupt values* into *safe NULLs*, and prevents new ones — independent of and complementary to (1). (Choose the window deliberately: legit pre-game windows are short; the wrong rows are 700–9000 days off, so the signal is clean.)

3. **GRADE-side backfill for the stuck back-catalog (unblocks the PENDING cohort now).** A read-mostly resolver that derives an `event_date` for existing null/wrong rows — from the slip's printed time, the matched scoreboard event, or the Discord/tweet timestamp — and writes it back (the `recoverHold` backdate path, `holdReview.js:370`, is the existing ungated precedent). This is what actually frees the ~162 stuck PENDING bets (Soccer/WC-dominated) without waiting for new ingests.

4. **Then, and only then, flip `EVENT_DATE_SLATE` → enforce.** It is the consumer of (1)+(3); enforcing before population is correct is a near-no-op at best and a false-VOID hazard on the wrong-value rows at worst. Use the existing `slate_shadow` telemetry to measure divergence before flipping. Note the live interaction with `SOCCER_GRADER_MODE=enforce`: soccer is already enforcing match-level off `getBetDate` (created_at-first), so populating soccer `event_date` + a future enforce flip is what aligns the soccer slate with the true match day.

**Sequencing:** (2) is a small, safe, standalone guard — ship first. (1) is the durable cure — largest scope. (3) clears the existing backlog in parallel. (4) is gated on (1)+(3). **No code changed in this pass — STOP here per the prompt.**

---

### Appendix — verification provenance
- Code claims: 4 parallel analysts + 1 reconciler, all file:line citations re-resolved at HEAD `fb96490`; only a stale `CODEMAP.md` skew-fallback line-ref (`:2893` → actually `grading.js:3159`) noted, no substantive analyst error.
- DB claims: read-only SQL via `skills/zonetracker-regrade/scripts/run-fly-sql.sh` (`better-sqlite3 {readonly:true}` + client keyword-block). Live env via `fly ssh console`. Example `8cac8e5d` original grade pulled from `bet_grade_history`.
