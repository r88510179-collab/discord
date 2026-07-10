#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// backfill-event-dates.js — event_date back-catalog pass (OPERATOR-run,
// in-container). Implements docs/PHASE3_BACKFILL_DIAGNOSIS.md §5's tightly
// scoped shape. DEFAULT IS DRY-RUN; nothing is written without --apply.
//
// TWO OPS, each opt-in (at least one required):
//
//   --scrub     NULL a POPULATED event_date on a still-PENDING bet when the
//               value is implausibly far from created_at (outside the shipped
//               write-gate bounds, services/eventDate.js: gap < -2d or > +60d).
//               This retro-applies the #153/#154 sanity guard to the rows
//               that pre-date it (migration 029's asymmetry: valid-but-WRONG
//               datetimes parse fine and survived) — converting actively
//               harmful wrong-year values (trusted event_date-first by the
//               search grader) into the designed-safe NULL. Finalized rows
//               are left alone (regrading is out of scope; their event_date
//               is audit trail now). Per the census only ~3 pending rows
//               qualify — small by design.
//
//   --populate  Tier-1 pre-staging backfill: event_date := the bet's own
//               created_at INSTANT (full ISO-UTC — NEVER date-only, which
//               shifts the ET day under a future EVENT_DATE_SLATE=enforce:
//               eventEtYMD("2026-06-18") = "2026-06-17"). Scope is exactly
//               PHASE3 §5's "if a backfill is run anyway": result='pending'
//               AND review_status='confirmed' AND event_date IS NULL AND
//               sport ∈ {MLB, NBA, NHL} (the only sports where a populated
//               event_date changes anything today — the absenceVoidAllowed
//               flip). Rows whose description carries a date-ish token
//               (weekday / month+day / M/D) are SKIPPED and flagged for the
//               operator — those are the Tier-2 "date in description
//               contradicts created_at" hazard where a created_at echo would
//               write a WRONG date.
//
// ⚠️  PHASE3 §5 RECOMMENDS **NOT** RUNNING --populate AS A BLANKET PASS: under
// the live shadow config it re-encodes created_at into event_date, unblocks
// essentially nothing, and its only live grade-effect is flipping
// absenceVoidAllowed→true for MLB/NBA/NHL structured props — a false-VOID
// hazard on any date-mismatched row. It exists here as pre-staging for a
// future EVENT_DATE_SLATE=enforce flip, to be run only after operator review
// of the dry-run report. The durable NULL-cohort fix is the §9 grader
// write-back (shipped, #156/#157) + the ingest population PR this script
// ships with. --scrub, by contrast, is pure harm-reduction and is the
// recommended op.
//
// NOTE — scrub→populate two-run convergence (intended): both plans are read
// BEFORE the apply transaction, so a row scrubbed in run 1 is NOT populated in
// the same run; on a LATER --populate run it is an ordinary Tier-1 candidate
// (NULL + pending + confirmed) and would get the created_at echo. That cohort
// is exactly the one where the extractor asserted a DIFFERENT date than
// created_at — review those rows' descriptions in the report before a second
// --apply.
//
// Safety rails (apply-regrade-s01-s05.js mold):
//   • dry-run by default; --apply is the only write gate; --apply --dry-run
//     conflict → exit 2. Dry-run opens the DB READONLY (cannot write).
//   • --db defaults to /data/bettracker.db (prod, in-container); any other
//     path is REFUSED without --allow-nonprod (exit 2).
//   • schema preflight (required bets columns) → mismatch exit 2.
//   • apply = ONE transaction; each UPDATE re-checks its predicate (populate
//     only fills event_date IS NULL; scrub only NULLs the exact old value) so
//     a concurrent writer can never be clobbered.
//   • per-row report + summary in both modes; exit 0 on success.
//
// Usage (in-container, operator):
//   node /tmp/backfill-event-dates.js --scrub                    # dry-run report
//   node /tmp/backfill-event-dates.js --scrub --apply            # write scrubs
//   node /tmp/backfill-event-dates.js --scrub --populate         # full dry-run
//   node /tmp/backfill-event-dates.js --populate --db /x --allow-nonprod
// ═══════════════════════════════════════════════════════════

'use strict';

const path = require('path');

// App-module resolution root (operator runs this from /tmp via sftp — a
// relative ../services require would MODULE_NOT_FOUND there). Matches
// apply-regrade-s01-s05.js / apply-pregate-corrections.js.
const APP_ROOT = process.env.APP_ROOT || '/app';

// The shipped write-gate bounds — required from the app so the scrub predicate
// can never drift from what the gate enforces on new writes. eventDate.js is a
// pure leaf module (zero requires, no DB open at load).
const {
  EVENT_DATE_GUARD_MIN_GAP_DAYS,
  EVENT_DATE_GUARD_MAX_GAP_DAYS,
} = require(path.join(APP_ROOT, 'services/eventDate'));

const PROD_DB_PATH = '/data/bettracker.db';

// Sports where a populated event_date is actually consumed today (the
// structured-prop absenceVoidAllowed flip) — PHASE3 §5 scope.
const POPULATE_SPORTS = new Set(['MLB', 'NBA', 'NHL']);

// Tier-2 tripwire: a description that itself names a day is the cohort where
// created_at may be the WRONG day (PHASE3 Tier 2, e.g. 40815408 "FRA @ NOR •
// Fri 3:00 PM ET" posted Thursday). Weekday tokens (word-bounded so "Suns" /
// "Friday"→fri+day still match intent), month-name + day-number, and numeric
// M/D. Deliberately over-broad — a flagged row is SKIPPED for the operator to
// verify, never auto-populated.
const DATEISH_RE = new RegExp(
  [
    String.raw`\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b`,
    // "tomorrow" contradicts a created_at echo BY DEFINITION (game = created
    // day + 1). "today"/"tonight" are NOT flagged — they agree with the echo.
    String.raw`\btomorrow\b`,
    // month-name + day number, ordinal suffix included ("June 24th").
    String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b`,
    String.raw`\b\d{1,2}/\d{1,2}\b`,
  ].join('|'),
  'i',
);

const DAY_MS = 86400000;

// Parse a stored bets timestamp into a UTC Date. SQLite CURRENT_TIMESTAMP and
// the recoverHold backdate both store space-separated UTC with no zone marker
// ("2026-06-21 14:15:24") — new Date() would read that as LOCAL time, so it is
// normalized to an explicit-UTC ISO first. Date-only ("2026-06-21",
// recoverHold's event_date format) anchors at UTC midnight — the same instant
// every read-side consumer derives from it. Returns null when unparseable.
function parseStoredUtc(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) iso = `${s.replace(' ', 'T')}Z`;
  // T-separated but ZONE-LESS ("2026-06-21T19:00:00") — SQLite's datetime()
  // reads it as UTC (so such legacy values survived mig 029), but bare
  // new Date() reads it as LOCAL time, which would make the gap math depend
  // on the host TZ (operator-Mac dry-run vs in-container apply). Pin it UTC.
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) iso = `${s}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// The scrub predicate — the gate's gap rule, verbatim semantics.
function gapDays(eventDate, createdAt) {
  return (eventDate.getTime() - createdAt.getTime()) / DAY_MS;
}
function isImplausibleGap(g) {
  return g < EVENT_DATE_GUARD_MIN_GAP_DAYS || g > EVENT_DATE_GUARD_MAX_GAP_DAYS;
}

function hasDateishToken(description) {
  return DATEISH_RE.test(String(description || ''));
}

// created_at → the full ISO-UTC instant to write (never date-only).
function populateValueFromCreatedAt(createdAt) {
  const d = parseStoredUtc(createdAt);
  return d ? d.toISOString() : null;
}

// ── plan builders (read-only; shared by dry-run and apply) ──────────────────

function buildScrubPlan(db) {
  const rows = db.prepare(`
    SELECT id, sport, source, review_status, created_at, event_date, description
      FROM bets
     WHERE result = 'pending' AND event_date IS NOT NULL
     ORDER BY created_at
  `).all();

  const plan = [];
  for (const r of rows) {
    const ev = parseStoredUtc(r.event_date);
    const cr = parseStoredUtc(r.created_at);
    if (!ev || !cr) {
      plan.push({ op: 'scrub', row: r, action: 'SKIP_UNPARSEABLE', gap: null });
      continue;
    }
    const g = gapDays(ev, cr);
    plan.push({
      op: 'scrub',
      row: r,
      action: isImplausibleGap(g) ? 'SCRUB_NULL' : 'SKIP_IN_BOUNDS',
      gap: Math.round(g * 10) / 10,
    });
  }
  return plan;
}

function buildPopulatePlan(db) {
  const rows = db.prepare(`
    SELECT id, sport, source, review_status, created_at, event_date, description
      FROM bets
     WHERE result = 'pending' AND event_date IS NULL AND review_status = 'confirmed'
     ORDER BY created_at
  `).all();

  const plan = [];
  for (const r of rows) {
    if (!POPULATE_SPORTS.has(String(r.sport || '').toUpperCase())) {
      // Out-of-scope sports are not even reported row-by-row — the report
      // notes the aggregate count instead (they are the majority: soccer/
      // tennis grade off created_at regardless, PHASE3 §3).
      plan.push({ op: 'populate', row: r, action: 'SKIP_SPORT', silent: true });
      continue;
    }
    if (hasDateishToken(r.description)) {
      plan.push({ op: 'populate', row: r, action: 'SKIP_TIER2_DATEISH_DESC' });
      continue;
    }
    const value = populateValueFromCreatedAt(r.created_at);
    if (!value) {
      plan.push({ op: 'populate', row: r, action: 'SKIP_UNPARSEABLE' });
      continue;
    }
    plan.push({ op: 'populate', row: r, action: 'POPULATE', value });
  }
  return plan;
}

// ── report ──────────────────────────────────────────────────────────────────

function printPlan(plan) {
  const visible = plan.filter(p => !p.silent);
  for (const p of visible) {
    const r = p.row;
    const bits = [
      p.op.toUpperCase().padEnd(8),
      r.id.slice(0, 8),
      String(r.sport || '?').padEnd(9),
      String(r.source || '?').padEnd(14),
      `created=${r.created_at}`,
      `event_date=${r.event_date == null ? 'NULL' : r.event_date}`,
      `→ ${p.action}`,
    ];
    if (p.gap != null) bits.push(`gap=${p.gap}d`);
    if (p.value) bits.push(`new=${p.value}`);
    // Description shown on every populate-side row (POPULATE included, not
    // just the Tier-2 skips) so the operator can eyeball what each row IS
    // before blessing an --apply.
    if (p.op === 'populate') bits.push(`desc="${String(r.description || '').slice(0, 60)}"`);
    console.log('  ' + bits.join(' '));
  }
}

function summarize(plan) {
  const counts = {};
  for (const p of plan) counts[`${p.op}:${p.action}`] = (counts[`${p.op}:${p.action}`] || 0) + 1;
  return counts;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { mode: null, dbPath: null, allowNonprod: false, scrub: false, populate: false };
  // 'conflict' is STICKY: once both modes have been seen, no later repeat of
  // either flag may un-conflict the parse — any command line that contains
  // --dry-run must never reach apply (e.g. `--scrub --dry-run --apply --apply`
  // used to parse as a clean APPLY because the second --apply overwrote the
  // sentinel). Same fix as scripts/reconcile-needs-review.js.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = (out.mode === 'dry-run' || out.mode === 'conflict') ? 'conflict' : 'apply';
    else if (a === '--dry-run') out.mode = (out.mode === 'apply' || out.mode === 'conflict') ? 'conflict' : 'dry-run';
    else if (a === '--allow-nonprod') out.allowNonprod = true;
    else if (a === '--scrub') out.scrub = true;
    else if (a === '--populate') out.populate = true;
    else if (a === '--db') {
      // A missing value must NOT silently fall through to the prod default —
      // the operator typed --db intending to point somewhere specific.
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { error: '--db requires a path value' };
      out.dbPath = v;
    } else return { error: `unknown arg: ${a}` };
  }
  if (out.mode === 'conflict') return { error: '--dry-run and --apply are mutually exclusive' };
  if (out.mode == null) out.mode = 'dry-run'; // DRY RUN is the default
  if (!out.scrub && !out.populate) return { error: 'pick at least one op: --scrub and/or --populate' };
  if (out.dbPath == null) out.dbPath = PROD_DB_PATH;
  return out;
}

const USAGE = 'Usage: node scripts/backfill-event-dates.js (--scrub|--populate|both) [--db <path>] [--dry-run|--apply] [--allow-nonprod]';

const REQUIRED_BETS_COLS = ['id', 'sport', 'source', 'description', 'event_date', 'created_at', 'result', 'review_status'];

function requireBetterSqlite() {
  const candidates = ['better-sqlite3', path.join(APP_ROOT, 'node_modules', 'better-sqlite3')];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const apply = args.mode === 'apply';

  // Safety: refuse a non-prod DB unless explicitly allowed.
  if (args.dbPath !== PROD_DB_PATH && !args.allowNonprod) {
    console.error(`REFUSED: --db='${args.dbPath}' is not ${PROD_DB_PATH}. Pass --allow-nonprod to target a non-prod DB.`);
    process.exit(2);
  }

  const Database = requireBetterSqlite();
  let db;
  try {
    db = new Database(args.dbPath, { readonly: !apply, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open --db=${args.dbPath}: ${err.message}`);
    process.exit(2);
  }

  // Schema preflight — verify columns before assuming anything.
  const betsCols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
  const missing = REQUIRED_BETS_COLS.filter(c => !betsCols.includes(c));
  if (missing.length) {
    console.error(`schema mismatch — bets missing [${missing}]`);
    db.close();
    process.exit(2);
  }

  console.log(`backfill-event-dates — ${apply ? 'APPLY' : 'DRY RUN'} against ${args.dbPath}`);
  console.log(`guard bounds: ${EVENT_DATE_GUARD_MIN_GAP_DAYS}d .. +${EVENT_DATE_GUARD_MAX_GAP_DAYS}d (services/eventDate.js)\n`);

  const plan = [];
  if (args.scrub) plan.push(...buildScrubPlan(db));
  if (args.populate) plan.push(...buildPopulatePlan(db));

  printPlan(plan);

  const counts = summarize(plan);
  console.log('\nSummary:');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);

  const writes = plan.filter(p => p.action === 'SCRUB_NULL' || p.action === 'POPULATE');
  console.log(`  total writes planned: ${writes.length}`);
  if (plan.some(p => p.action === 'SKIP_TIER2_DATEISH_DESC')) {
    console.log('  ⚠ Tier-2 date-ish rows were SKIPPED — verify each by hand (/grade override is the per-bet tool).');
  }
  if (args.populate) {
    console.log('  ⚠ PHASE3 §5: --populate is pre-staging for EVENT_DATE_SLATE=enforce, not a fix — review before --apply.');
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  // ONE transaction; every UPDATE re-checks its own predicate so a row that
  // changed since the read (grader write-back, live grading) is left alone.
  const scrubStmt = db.prepare("UPDATE bets SET event_date = NULL WHERE id = ? AND result = 'pending' AND event_date = ?");
  const populateStmt = db.prepare("UPDATE bets SET event_date = ? WHERE id = ? AND result = 'pending' AND event_date IS NULL AND review_status = 'confirmed'");
  let scrubbed = 0;
  let populated = 0;
  let raced = 0;
  db.transaction(() => {
    for (const p of writes) {
      if (p.action === 'SCRUB_NULL') {
        const info = scrubStmt.run(p.row.id, p.row.event_date);
        if (info.changes === 1) scrubbed++; else raced++;
      } else {
        const info = populateStmt.run(p.value, p.row.id);
        if (info.changes === 1) populated++; else raced++;
      }
    }
  })();

  console.log(`\nAPPLIED: scrubbed=${scrubbed} populated=${populated}${raced ? ` raced/skipped=${raced} (row changed since read — left alone)` : ''}`);
  db.close();
}

module.exports = {
  parseArgs,
  parseStoredUtc,
  gapDays,
  isImplausibleGap,
  hasDateishToken,
  populateValueFromCreatedAt,
  buildScrubPlan,
  buildPopulatePlan,
  summarize,
  PROD_DB_PATH,
  POPULATE_SPORTS,
  DATEISH_RE,
};

if (require.main === module) main();
