#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// reconcile-needs-review.js — status-only reconcile of bets that SETTLED
// (graded win/loss/push/void) while review_status was still 'needs_review'
// (OPERATOR-run, in-container). DEFAULT IS DRY-RUN; nothing is written
// without --apply.
//
// The grades are REAL and already counted in live ROI (the +229.39u cohort,
// BACKLOG 2026-07): capper stats / leaderboard count by `result` alone
// (SETTLED_BET has no review_status filter), so these rows are live in the
// record — only the confirmed-only surfaces (/dashboard, /capper analytics)
// hide them. This is a STATUS reconcile ONLY: the single write is
// bets.review_status → 'confirmed'. No grade, result, profit, units, or
// timestamp column is touched; no other table is touched; no schema changes.
//
// Derivations (documented in the PR body, sources in-line):
//   • "settled" result values — CODEMAP §Enums `bets.result`:
//     pending/win/loss/push/void; settled = the four terminal grades
//     win/loss/push/void (the exact set the 2026-07-08 terminal-state
//     invariant enumerates). The live legacy value 'archived' (season-reset
//     bookkeeping, not a graded outcome) is deliberately NOT settled here.
//   • target review_status 'confirmed' — the value the normal operator
//     review flow writes for a completed review: approveBet
//     (services/database.js, the /admin + POST approve path) sets
//     review_status='confirmed'; the DP-01 relabel one-shot
//     (docs/RUNBOOKS/db-interventions.md §Stats visibility) uses the same.
//   • cohort eras — bucketed by created_at against 2026-06-12, DP-01's
//     documented era bound for the #89 grader-skips-needs_review fix
//     (pre-#89 residue / operator batch writes vs the phase1-gates-v1 era);
//     a secondary grader_version breakdown is reported as a cross-check
//     (the gates stamp is 'phase1-gates-v1', services/grading.js).
//
// Safety rails (backfill-event-dates.js / apply-regrade-s01-s05.js mold):
//   • dry-run by default; --apply is the only write gate; --apply --dry-run
//     conflict → exit 2. Dry-run opens the DB READONLY (cannot write).
//   • --db defaults to /data/bettracker.db (prod, in-container); any other
//     path is REFUSED without --allow-nonprod (exit 2).
//   • schema preflight: PRAGMA table_info(bets) → abort (exit 2) if any
//     column this script reads or writes is absent.
//   • magnitude guard: expected population ≈ 161. If the live count deviates
//     >±20% (outside 129..193) a warning prints, and --apply additionally
//     requires --force (exit 2 without it). Exception: a count of ZERO is
//     idempotent success, not a wrong-population hazard — it skips the guard
//     so a re-run after apply exits 0 reporting "rows changed: 0".
//   • --apply = ONE transaction; the UPDATE's WHERE clause repeats the full
//     selection predicate verbatim (same SQL constant as the SELECT), so it
//     is idempotent — updated rows no longer match, a second run changes 0
//     rows — and a row that settled/changed between read and write is judged
//     by the predicate at write time, never by the earlier read.
//   • full before-state JSON per selected row printed in both modes so the
//     operator can archive it; info.changes printed after apply (DP-01).
//
// Usage (in-container, operator):
//   node scripts/reconcile-needs-review.js                    # dry-run report
//   node scripts/reconcile-needs-review.js --apply            # write, one txn
//   node scripts/reconcile-needs-review.js --apply --force    # write despite
//                                                             #   magnitude drift
//   node scripts/reconcile-needs-review.js --db /x --allow-nonprod   # test DB
// ═══════════════════════════════════════════════════════════

'use strict';

const PROD_DB_PATH = '/data/bettracker.db';

// CODEMAP §Enums bets.result — the four terminal grades. 'pending' is the
// only non-settled enum value; 'archived' (legacy season-reset state) is
// deliberately excluded: it is bookkeeping, not a graded outcome.
const SETTLED_RESULTS = ['win', 'loss', 'push', 'void'];

const SOURCE_REVIEW_STATUS = 'needs_review';
// What approveBet — the normal operator review flow — writes on completion.
const TARGET_REVIEW_STATUS = 'confirmed';

// The single selection predicate, shared VERBATIM by the SELECT and the
// UPDATE (exported + pinned by tests so the two can never drift apart).
const SELECTION_WHERE =
  `review_status = '${SOURCE_REVIEW_STATUS}' AND result IN (${SETTLED_RESULTS.map(r => `'${r}'`).join(', ')})`;

// Magnitude guard — the prompt's expected population.
const EXPECTED_COUNT = 161;
const MAGNITUDE_TOLERANCE = 0.20;

// DP-01's era bound for the #89 grader-skips-needs_review fix
// (docs/RUNBOOKS/db-interventions.md, worked example 2026-06-12).
const PRE89_ERA_BOUND = '2026-06-12';
const COHORT_PRE89 = `pre-#89 residue / operator batch writes (created_at < ${PRE89_ERA_BOUND})`;
const COHORT_GATES = `phase1-gates-v1 era (created_at >= ${PRE89_ERA_BOUND})`;
const COHORT_UNKNOWN = 'unknown era (created_at missing)';

// Every column this script reads or writes — preflighted via PRAGMA.
const REQUIRED_BETS_COLS = [
  'id', 'description', 'result', 'grade', 'profit_units', 'units',
  'review_status', 'graded_at', 'created_at', 'grader_version', 'grade_reason',
];

// ── Pure helpers (exported for unit tests) ──────────────────

function parseArgs(argv) {
  const out = { mode: null, dbPath: null, allowNonprod: false, force: false };
  // 'conflict' is STICKY: once both modes have been seen, no later repeat of
  // either flag may un-conflict the parse — any command line that contains
  // --dry-run must never reach apply (e.g. `--dry-run --apply --apply`).
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = (out.mode === 'dry-run' || out.mode === 'conflict') ? 'conflict' : 'apply';
    else if (a === '--dry-run') out.mode = (out.mode === 'apply' || out.mode === 'conflict') ? 'conflict' : 'dry-run';
    else if (a === '--force') out.force = true;
    else if (a === '--allow-nonprod') out.allowNonprod = true;
    else if (a === '--db') {
      // A missing value must NOT silently fall through to the prod default.
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { error: '--db requires a path value' };
      out.dbPath = v;
    } else return { error: `unknown arg: ${a}` };
  }
  if (out.mode === 'conflict') return { error: '--dry-run and --apply are mutually exclusive' };
  if (out.mode == null) out.mode = 'dry-run'; // DRY RUN is the default
  if (out.force && out.mode !== 'apply') return { error: '--force only makes sense alongside --apply' };
  if (out.dbPath == null) out.dbPath = PROD_DB_PATH;
  return out;
}

// created_at is stored as an ISO/SQLite datetime string, so the era test is
// a plain lexicographic compare against the YYYY-MM-DD bound.
function bucketCohort(row) {
  const c = row && row.created_at;
  if (!c || typeof c !== 'string') return COHORT_UNKNOWN;
  return c < PRE89_ERA_BOUND ? COHORT_PRE89 : COHORT_GATES;
}

// >±20% deviation from the expected magnitude → not ok.
function checkMagnitude(count, expected = EXPECTED_COUNT, tolerance = MAGNITUDE_TOLERANCE) {
  const deviation = Math.abs(count - expected) / expected;
  return { ok: deviation <= tolerance, deviation };
}

function missingColumns(pragmaNames, required = REQUIRED_BETS_COLS) {
  const have = new Set(pragmaNames);
  return required.filter(c => !have.has(c));
}

function loadBeforeState(db) {
  return db.prepare(`
    SELECT id, substr(description, 1, 80) AS description, result, grade,
           profit_units, units, review_status, graded_at, created_at,
           grader_version, substr(grade_reason, 1, 80) AS grade_reason
    FROM bets
    WHERE ${SELECTION_WHERE}
    ORDER BY created_at
  `).all();
}

function summarizeCohorts(rows) {
  const cohorts = {};
  const graderVersions = {};
  let profitSum = 0;
  for (const r of rows) {
    const c = bucketCohort(r);
    if (!cohorts[c]) cohorts[c] = { count: 0, profit_units: 0 };
    cohorts[c].count++;
    cohorts[c].profit_units += r.profit_units || 0;
    profitSum += r.profit_units || 0;
    const gv = r.grader_version == null ? '(null)' : String(r.grader_version);
    graderVersions[gv] = (graderVersions[gv] || 0) + 1;
  }
  return { cohorts, graderVersions, profitSum };
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = {
  parseArgs,
  bucketCohort,
  checkMagnitude,
  missingColumns,
  loadBeforeState,
  summarizeCohorts,
  SELECTION_WHERE,
  SETTLED_RESULTS,
  SOURCE_REVIEW_STATUS,
  TARGET_REVIEW_STATUS,
  EXPECTED_COUNT,
  MAGNITUDE_TOLERANCE,
  PRE89_ERA_BOUND,
  COHORT_PRE89,
  COHORT_GATES,
  COHORT_UNKNOWN,
  PROD_DB_PATH,
  REQUIRED_BETS_COLS,
};

// ═════════════════════════ runtime ══════════════════════════

const USAGE = 'Usage: node scripts/reconcile-needs-review.js [--db <path>] [--dry-run|--apply] [--force] [--allow-nonprod]';

// Operator flow is sftp-upload to /tmp in the container (merged != deployed),
// where a bare require resolves nothing on the /tmp ancestor chain — same
// fallback as backfill-event-dates.js / apply-regrade-s01-s05.js.
function requireBetterSqlite() {
  const path = require('path');
  const APP_ROOT = process.env.APP_ROOT || '/app';
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

  // Schema preflight — verify every column read or written before assuming
  // anything (DP-01 Rule 2; the prompt's "status" column is bets.result).
  const betsCols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
  const missing = missingColumns(betsCols);
  if (missing.length) {
    console.error(`schema mismatch — bets is missing expected column(s) [${missing.join(', ')}]; re-verify against PRAGMA table_info(bets) before running.`);
    db.close();
    process.exit(2);
  }

  console.log(`reconcile-needs-review — ${apply ? 'APPLY' : 'DRY RUN (readonly)'} against ${args.dbPath}`);
  console.log(`selection: ${SELECTION_WHERE}`);
  console.log(`write:     review_status → '${TARGET_REVIEW_STATUS}' (the approveBet completed-review value); no other column, no other table\n`);

  const rows = loadBeforeState(db);
  const { cohorts, graderVersions, profitSum } = summarizeCohorts(rows);

  console.log(`total selected: ${rows.length} (expected ≈ ${EXPECTED_COUNT})`);
  console.log('per-cohort breakdown (created_at era):');
  for (const [name, c] of Object.entries(cohorts).sort()) {
    console.log(`  ${name}: ${c.count} rows, Σ profit_units ${c.profit_units >= 0 ? '+' : ''}${round2(c.profit_units)}u`);
  }
  console.log('grader_version breakdown (cross-check):');
  for (const [gv, n] of Object.entries(graderVersions).sort()) console.log(`  ${gv}: ${n}`);
  console.log(`Σ profit_units across selection: ${profitSum >= 0 ? '+' : ''}${round2(profitSum)}u (already live in ROI — unchanged by this script)`);

  console.log('\nBEFORE-STATE JSON (archive this):');
  console.log(JSON.stringify(rows, null, 2));

  const magnitude = checkMagnitude(rows.length);
  if (rows.length > 0 && !magnitude.ok) {
    console.log(`\n⚠ WARNING: live count ${rows.length} deviates ${(magnitude.deviation * 100).toFixed(1)}% from the expected ~${EXPECTED_COUNT} (>±${MAGNITUDE_TOLERANCE * 100}%).`);
    console.log('  Something about the population has changed since the audit — investigate before applying.');
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  if (rows.length > 0 && !magnitude.ok && !args.force) {
    console.error(`\nABORT: count ${rows.length} is outside the ±${MAGNITUDE_TOLERANCE * 100}% band around ${EXPECTED_COUNT} — re-run with --apply --force to override. Nothing was written.`);
    db.close();
    // exitCode + natural exit (NOT process.exit): the before-state JSON just
    // printed can exceed the 64KB pipe buffer, and process.exit() drops
    // undrained stdout — truncating the operator's archive exactly when the
    // population is anomalous.
    process.exitCode = 2;
    return;
  }

  // ONE transaction; the WHERE clause repeats the full selection predicate,
  // so the write is idempotent (updated rows no longer match) and judges
  // every row at write time.
  const upd = db.prepare(`UPDATE bets SET review_status = '${TARGET_REVIEW_STATUS}' WHERE ${SELECTION_WHERE}`);
  let changes = 0;
  db.transaction(() => { changes = upd.run().changes; })();

  console.log(`\nAPPLIED: rows changed = ${changes} (one transaction, committed).`);
  if (changes !== rows.length) {
    console.log(`  note: ${rows.length} rows were selected at read time — the ${Math.abs(rows.length - changes)}-row difference means concurrent writes moved rows across the predicate between read and write; the predicate governed.`);
  }
  db.close();
}

if (require.main === module) main();
