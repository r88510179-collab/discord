# Database interventions — Fly prod (`bettracker-discord-bot`)

How to read and (rarely) write `/data/bettracker.db` on Fly safely. Written up
2026-06-10 after the v606 evening session, where two write attempts aborted *by
design* before touching a row — both are worked examples below.

**Three hard rules (the reason this runbook exists):**

1. **Never trust an agent-reported bet id.** They are routinely the **8-char
   truncation** shown in logs/summaries (`f71cbbc4…`), not the stored id
   (`f71cbbc5…`). A truncated id silently matches **zero** rows. Always
   re-resolve the target by `description LIKE` before any write, and gate the
   write on an explicit row-count check.
2. **Never assume column names.** Confirm against `PRAGMA table_info(bets)` or a
   prior verified script. The grading columns are `grading_attempts` /
   `grading_next_attempt_at` / `grading_lock_until` — there is **no** bare
   `attempts` column.
3. **Never hand-retype base64.** Emit the `fly ssh` one-shot with the base64
   payload **already inlined by tooling** and copy/paste it **verbatim** — do not
   retype, re-wrap, or "clean up" the blob by hand. A single transposed/omitted
   base64 character decodes to corrupt JS: on 2026-06-10 a hand-retyped payload
   produced a **corrupted `PRAGMA`** that failed on the box. Build the full
   command string in one step (see the canonical pattern below) and treat the
   base64 as opaque — if it doesn't fit on one line, that's fine, just don't edit
   it. Re-generate from the source `.js` rather than patching the blob.

---

## Query pattern — base64 → node on Fly (canonical)

The Fly machine image has **no `sqlite3` CLI**; the DB is reachable only through
the app's bundled `better-sqlite3` binding at `/app/node_modules/better-sqlite3`.
So queries run as a Node one-liner. Multi-line scripts don't survive `fly ssh
-C` quoting, so base64-encode the script locally and decode it on the box:

```bash
# 1. Write the JS locally (READ-ONLY example — open the DB readonly).
cat > /tmp/q.js <<'JS'
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db', { readonly: true });
const rows = db.prepare(`
  SELECT id, substr(description,1,60) AS d, grading_state, grading_attempts
  FROM bets WHERE grading_state = 'backoff'
  ORDER BY grading_attempts DESC LIMIT 20
`).all();
console.log(JSON.stringify(rows, null, 2));
JS

# 2. base64 it and decode+run on Fly (no temp file needed on the box).
B64=$(base64 < /tmp/q.js)
fly ssh console -a bettracker-discord-bot -C \
  "node -e \"$(printf '%s' "$B64" | { command -v gbase64 >/dev/null && gbase64 -d || base64 -d; })\""
```

Gotchas:
- **Copy the `B64=…`/`fly ssh …` command VERBATIM (Rule 3).** The base64 blob is
  opaque — never hand-retype, re-wrap, or edit it. One wrong character decodes to
  corrupt JS (a hand-retyped payload produced a corrupted `PRAGMA` on the box
  2026-06-10). If you need to change the query, edit `/tmp/q.js` and **re-run
  `base64`**, don't patch the blob.
- Open **`{ readonly: true }`** for every investigative query — it makes an
  accidental write impossible, not just unlikely.
- `require('/app/node_modules/better-sqlite3')` by absolute path (or `cd /app`
  first / set `NODE_PATH=/app/node_modules`) — a bare `require('better-sqlite3')`
  resolves only from the cwd Fly drops you in.
- Some older runbooks (e.g. `datdude-tracediff.md`) show `sqlite3
  /data/bettracker.db "…"`. That form is **not reliable on the current machine
  image** — confirm `sqlite3` exists before depending on it; prefer the node
  pattern above.

---

## `bets` grading columns (verified — mig 016 + mig 028)

| Column | Type / default | Notes |
| --- | --- | --- |
| `grading_state` | TEXT DEFAULT `'done'` | enum (app-enforced, no CHECK): `done` (terminal **or** not yet eligible) / `ready` (eligible next cycle) / `backoff` (waiting until `grading_next_attempt_at`) / `quarantined` (attempts ≥ 20, needs admin). Live-observed also: `graded`. |
| `grading_attempts` | INTEGER DEFAULT 0 | grade-cycle counter. **Not** `attempts`. |
| `grading_next_attempt_at` | TEXT DEFAULT NULL | backoff gate; SQLite datetime string. |
| `grading_lock_until` | TEXT DEFAULT NULL | in-flight lock; SQLite datetime string. |
| `grading_last_attempt_at` | TEXT DEFAULT NULL | mig 016. |
| `grading_last_failure_reason` | TEXT DEFAULT NULL | mig 016. |
| `sweep_exempt_until` | TEXT DEFAULT NULL | mig **028** — sweeper grace window; `recoverHold` stamps `now + GRACE_DAYS`. |

Source of truth: `migrations/016_add_grading_state_columns.sql`,
`migrations/028_add_sweep_exempt_until.sql`. Re-run `PRAGMA table_info(bets)` if
anything here looks off — schema drifts faster than docs.

---

## Twitter-handle tables — `scraper_handles` + `tracked_twitter` (verified)

Two **separate** tables with two **different** jobs. Conflating them is the root
cause of duplicate-capper splits — see `docs/CODEMAP.md` §Twitter ingest.

| Table | Job | Key columns |
| --- | --- | --- |
| `scraper_handles` (mig **027**) | **scrape set** — which accounts the Surface Pro scraper polls. Served to the box at `HANDLES_URL` = `GET /api/scraper-handles` (`enabled=1` only). | `handle` TEXT **PK**, `enabled` INTEGER DEFAULT 1, `added_at` INTEGER (unix epoch **seconds** — `unixepoch()`), `note` TEXT |
| `tracked_twitter` (mig **001**) | **capper attribution** — which capper a handle's bets file under. A handle with **no** row here attributes under its **raw handle** (= a stray duplicate capper). | `twitter_handle` TEXT **UNIQUE**, `display_name` TEXT, `guild_id` TEXT NOT NULL, `channel_id` TEXT NOT NULL, `active` INTEGER DEFAULT 1, `id`/`last_tweet_id`/`created_at` |

Enabling a handle in `scraper_handles` makes it **scraped**; inserting the paired
`tracked_twitter` row makes it **attributed**. A clean capper needs **both**.

### Worked example — LockedIn handle swap (2026-06-10, `lockedin_sportz` → capper `LockedIn`)

Inserting a new handle into **both** tables. Note the differing epoch
conventions (`scraper_handles.added_at` = seconds; `tracked_twitter.created_at` =
SQLite datetime string) and the **required** `guild_id`/`channel_id` on
`tracked_twitter`. Read-only-verify both tables first; both inserts are guarded
idempotent.

```js
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db'); // write mode
// 1. SCRAPE SET — INSERT OR IGNORE keeps it idempotent (handle is PK).
db.prepare(`INSERT OR IGNORE INTO scraper_handles (handle, enabled, note)
            VALUES ('lockedin_sportz', 1, 'LockedIn swap 2026-06-10 (replaces TeamLockTalk)')`).run();
// 2. ATTRIBUTION — twitter_handle is UNIQUE; guild_id/channel_id are NOT NULL.
db.prepare(`INSERT OR IGNORE INTO tracked_twitter (twitter_handle, display_name, guild_id, channel_id)
            VALUES ('lockedin_sportz', 'LockedIn', ?, '1485091165308190780')`).run(GUILD_ID);
// 3. Verify.
console.log(db.prepare(`SELECT handle, enabled FROM scraper_handles WHERE handle='lockedin_sportz'`).get());
console.log(db.prepare(`SELECT twitter_handle, display_name, channel_id FROM tracked_twitter WHERE twitter_handle='lockedin_sportz'`).get());
```

Result live-verified the same session: scraper reported `[Handles] fetched 8
active from Fly`; new `lockedin_sportz` picks now attribute under the **LockedIn**
capper, not the raw handle. (Bets ingested *before* the `tracked_twitter` row
existed still sit under the raw handle and need a later merge — BACKLOG "Capper
dedup / merge".) Source of truth: `migrations/027_scraper_handles.sql`,
`migrations/001_initial_schema.sql`. Re-run `PRAGMA table_info(<name>)` before
assuming structure.

---

## Worked example — pool-wide `grading_attempts` reset (2026-06-10, v606)

After the search-honesty fix (#74) shipped, **298** `backoff` bets carried
attempt counters accrued during the broken-search era (264 were ≥5 attempts and
would have auto-voided after 1–2 *honest* tries). They were reset to give the
honest pipeline a clean read:

```js
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db'); // write mode
const n = db.prepare(`SELECT COUNT(*) c FROM bets WHERE grading_state='backoff'`).get().c;
// POOL-SIZE GUARD: abort unless the count is in the expected band.
if (n < 250 || n > 350) { console.error(`ABORT: backoff pool=${n} outside [250,350]`); process.exit(1); }
const info = db.prepare(`UPDATE bets SET grading_attempts = 0 WHERE grading_state='backoff'`).run();
console.log(`reset grading_attempts=0 on ${info.changes} backoff bets`);
```

Guards that made this safe: (1) scoped strictly to `grading_state='backoff'`;
(2) **pool-size guard** (250–350) aborts if the WHERE matches an unexpected
count; (3) `grading_next_attempt_at` left **untouched** (backoff timing
preserved). BEFORE distribution: 3..35 attempts.

---

## Worked example — incident-era grading damage on review-queue bets (2026-06-12)

Before the grader-skips-needs_review fix (PR #89), the AutoGrader claimed
`review_status='needs_review'` bets, accruing `grading_attempts` (and
`grading_state='quarantined'` at attempts ≥ 20 via `applyBackoff`). Two row
classes carry that damage; they need **different** handling:

**Class 1 — still `pending` + `needs_review`: DO NOT repair by hand.** Once the
approveBet clean-slate fix is deployed, these self-heal the moment a human
clicks Approve (`approveBet` resets `grading_state='ready'`,
`grading_attempts=0`, clears lock/backoff/failure, and stamps a 3-day
`sweep_exempt_until` grace). A manual reset would only re-expose them to the
grader **while still un-reviewed** — recreating the original incident.

**Class 2 — `pending` + `confirmed` + damaged state: judgment required.** Bets
approved *during* the broken era went through the old `'done'`-only branch, so
Approve never repaired them — they sit invisible (`quarantined`) or one honest
attempt from the retry-cap/no-data void thresholds. These **cannot be
mechanically distinguished** from legitimately-quarantined bets (attempts ≥ 20
accrued honestly *after* confirmation), so inspect before writing:

```js
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db', { readonly: true });
console.log(JSON.stringify(db.prepare(`
  SELECT id, substr(description,1,50) AS d, grading_state, grading_attempts,
         substr(grading_last_failure_reason,1,60) AS why, created_at
  FROM bets
  WHERE result='pending' AND review_status='confirmed'
    AND (grading_state='quarantined' OR grading_attempts >= 5)
    AND created_at < '2026-06-12'  -- era bound: post-fix bets accrue attempts HONESTLY and must not pollute this set
  ORDER BY created_at
`).all(), null, 2));
```

Judgment rubric: failure reasons from the broken-search era (`parse_empty`,
`no_result`, provider errors) on bets that *should* be gradeable → repair;
attempts accrued honestly on genuinely unsearchable events → leave quarantined
(or void deliberately). Then reset **explicit ids only**, with a count guard,
mirroring `approveBet`'s reset — **including the sweep grace stamp**: a > 7-day
old bet reset to `ready` *without* `sweep_exempt_until` is 7-day-swept to a
FALSE loss in its first visible cycle (the PR #62 trap).

```js
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db'); // write mode
const ids = ['<full id 1>', '<full id 2>']; // from the readonly pass — FULL ids, never 8-char prefixes
const upd = db.prepare(`UPDATE bets SET
  grading_state='ready', grading_attempts=0, grading_lock_until=NULL,
  grading_next_attempt_at=NULL, grading_last_failure_reason=NULL,
  sweep_exempt_until=datetime('now','+3 days')
  WHERE id = ? AND result='pending' AND review_status='confirmed'`);
let changed = 0;
db.transaction(() => { for (const id of ids) changed += upd.run(id).changes; })();
if (changed !== ids.length) console.error(`WARNING: reset ${changed}/${ids.length} — re-check ids`);
console.log(`reset ${changed} bet(s) to ready with 3d sweep grace`);
```

**Class 3 — already FINALIZED while still `needs_review`: the incident's
visible casualties.** The broken-era writers had no review_status guard, so
some review-queue bets were terminally graded without ever being confirmed:
`result='void'` + `review_status` still `'needs_review'` (retry-cap void), or
`review_status` flipped to `auto_void_unscoped_bet` / swept to a LOSS (which
auto-confirms as it grades). Inspect with:

```js
const db = require('/app/node_modules/better-sqlite3')('/data/bettracker.db', { readonly: true });
console.log(JSON.stringify(db.prepare(`
  SELECT id, substr(description,1,50) AS d, result, review_status,
         substr(grade_reason,1,60) AS why, created_at, graded_at
  FROM bets
  WHERE created_at < '2026-06-12'
    AND ((result != 'pending' AND review_status = 'needs_review')
         OR review_status LIKE 'auto_void%')
  ORDER BY graded_at
`).all(), null, 2));
```

Repair, where the underlying pick is real and judgeable, is **revert + requeue
via existing tooling** — `/admin revert-by-id` (`revertBetToPending`: result
back to pending, full grading-state reset) — NOT raw SQL. CAVEAT: neither
`revertBetToPending` nor raw UPDATEs unwind a swept LOSS's bankroll/snapshot
impact (`updateBankroll` already ran at sweep time); if the bet had
`result='loss'` + a capper bankroll, reverse the `profit_units × unit_size`
delta by hand and re-run `saveDailySnapshot` — voids stamped `profit_units=0`
need no unwind.

---

## Case study 1 — wrong column name (aborted, no write)

A nudge script intended to re-ready one bet referenced a column `attempts`. The
script's own pre-flight (`SELECT … WHERE`) threw / matched nothing because
`attempts` does not exist — real columns are `grading_attempts` /
`grading_next_attempt_at` / `grading_lock_until`. **No write occurred.**

Lesson → **Rule 2.** Confirm column names against `PRAGMA table_info(bets)` or a
prior verified script *before* writing the UPDATE. `node`/`better-sqlite3` will
happily throw at runtime on a bad column — but only if your query actually
references it; a `SET attempts=0` with a typo'd target is worse.

## Case study 2 — truncated bet id (aborted on row-count guard)

The same script was pointed at agent-reported id `f71cbbc4…`. That was the
**8-char log truncation**; the stored id is `f71cbbc5…`. The script's row-count
guard saw the target WHERE match **0 rows** and aborted. **No write occurred.**
(The bet itself — `f71cbbc5…` "• Marlins ML +130" — graded fine once #73 was
live; see the evening close-out.)

Lesson → **Rule 1.** Re-resolve by description before writing, and guard on the
count:

```js
const hits = db.prepare(`SELECT id FROM bets WHERE description LIKE ?`).all('%Marlins ML%');
if (hits.length !== 1) { console.error(`ABORT: matched ${hits.length} rows, expected 1`); process.exit(1); }
const id = hits[0].id; // the full, stored id — never the 8-char prefix
// … now write against `id`.
```

---

## Checklist before any write

- [ ] Opened a `{ readonly: true }` query first and eyeballed the exact rows.
- [ ] Target re-resolved by `description LIKE` (or full id), **not** an 8-char prefix.
- [ ] Column names confirmed via `PRAGMA table_info(bets)` / prior script.
- [ ] Row-count guard (`if (count !== expected) process.exit(1)`) wraps the write.
- [ ] Scope columns left untouched where timing matters (`grading_next_attempt_at`).
- [ ] Logged `info.changes` so the write is auditable after the fact.
