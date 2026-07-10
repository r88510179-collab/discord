// ═══════════════════════════════════════════════════════════
// reconcile-needs-review.js — selection/guard correctness + CLI safety.
// Pattern: tests/backfill-event-dates.test.js (Section A DB-free unit cases,
// Section B throwaway sqlite DB, Section C end-to-end CLI via child_process
// on an isolated DB).
//
// Run: node tests/reconcile-needs-review.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const S = require('../scripts/reconcile-needs-review.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'reconcile-needs-review.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

// ── Section A — DB-free unit cases ──────────────────────────────────────────
console.log('Section A — parseArgs + predicate constants + cohorts + magnitude');

check('A1: default is dry-run', S.parseArgs([]).mode === 'dry-run');
check('A1: default db is prod', S.parseArgs([]).dbPath === S.PROD_DB_PATH);
check('A1: --apply parses', S.parseArgs(['--apply']).mode === 'apply');
check('A1: --apply --dry-run conflict', !!S.parseArgs(['--apply', '--dry-run']).error);
check('A1: conflict is STICKY — --dry-run --apply --apply still errors', !!S.parseArgs(['--dry-run', '--apply', '--apply']).error);
check('A1: conflict is STICKY — --apply --dry-run --dry-run still errors', !!S.parseArgs(['--apply', '--dry-run', '--dry-run']).error);
check('A1: unknown arg → error', !!S.parseArgs(['--frobnicate']).error);
check('A1: --db with a MISSING value errors (never silently falls to prod)', !!S.parseArgs(['--db']).error);
check('A1: --db swallowing the next flag errors', !!S.parseArgs(['--db', '--apply']).error);
check('A1: --force without --apply → error', !!S.parseArgs(['--force']).error);
check('A1: --force --apply parses', (() => { const a = S.parseArgs(['--apply', '--force']); return a.mode === 'apply' && a.force === true && !a.error; })());

// Settled enums pinned to CODEMAP §Enums bets.result terminal grades — the
// derivation the prompt requires. 'pending' and legacy 'archived' excluded.
check('A2: SETTLED_RESULTS is exactly {win, loss, push, void}',
  JSON.stringify([...S.SETTLED_RESULTS].sort()) === JSON.stringify(['loss', 'push', 'void', 'win']));
check('A2: pending is NOT settled', !S.SETTLED_RESULTS.includes('pending'));
check('A2: archived is NOT settled (season-reset bookkeeping, not a grade)', !S.SETTLED_RESULTS.includes('archived'));
check('A2: target review_status is confirmed (the approveBet completed-review value)',
  S.TARGET_REVIEW_STATUS === 'confirmed');
check('A2: source review_status is needs_review', S.SOURCE_REVIEW_STATUS === 'needs_review');
check('A2: selection predicate carries BOTH clauses',
  S.SELECTION_WHERE.includes("review_status = 'needs_review'") &&
  S.SELECTION_WHERE.includes("result IN ('win', 'loss', 'push', 'void')"));

// Cohort eras — DP-01's #89 era bound.
check('A3: era bound is 2026-06-12', S.PRE89_ERA_BOUND === '2026-06-12');
check('A3: pre-bound row buckets pre-#89', S.bucketCohort({ created_at: '2026-05-01 12:00:00' }) === S.COHORT_PRE89);
check('A3: post-bound row buckets gates-era', S.bucketCohort({ created_at: '2026-07-01 12:00:00' }) === S.COHORT_GATES);
check('A3: the bound instant itself buckets gates-era (< is strict)', S.bucketCohort({ created_at: '2026-06-12' }) === S.COHORT_GATES);
check('A3: one second before the bound buckets pre-#89', S.bucketCohort({ created_at: '2026-06-11 23:59:59' }) === S.COHORT_PRE89);
check('A3: NULL created_at buckets unknown', S.bucketCohort({ created_at: null }) === S.COHORT_UNKNOWN);

// Magnitude guard boundaries: 161 ± 20% → integers 129..193 are in-band.
check('A4: 161 in band', S.checkMagnitude(161).ok);
check('A4: 129 in band (−19.9%)', S.checkMagnitude(129).ok);
check('A4: 193 in band (+19.9%)', S.checkMagnitude(193).ok);
check('A4: 128 OUT of band', !S.checkMagnitude(128).ok);
check('A4: 194 OUT of band', !S.checkMagnitude(194).ok);
check('A4: 0 OUT of band (guard math; runtime special-cases empty selection)', !S.checkMagnitude(0).ok);
check('A4: expected count is 161', S.EXPECTED_COUNT === 161);

// missingColumns — schema preflight helper.
check('A5: no missing on full schema', S.missingColumns([...S.REQUIRED_BETS_COLS, 'extra']).length === 0);
check('A5: reports the absent column', JSON.stringify(S.missingColumns(S.REQUIRED_BETS_COLS.filter(c => c !== 'grader_version'))) === JSON.stringify(['grader_version']));

// ── Section B — throwaway sqlite DB: selection correctness ──────────────────
console.log('\nSection B — selection against a seeded DB');

const Database = require('better-sqlite3');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-nr-'));
const DB_B = path.join(TMP, 'b.db');

function makeDb(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE bets (
    id TEXT PRIMARY KEY, description TEXT, result TEXT, grade TEXT,
    profit_units REAL, units REAL, review_status TEXT, graded_at TEXT,
    created_at TEXT, grader_version TEXT, grade_reason TEXT
  )`);
  return db;
}
function seed(db, id, { result, review_status, created_at = '2026-05-01 10:00:00', profit_units = 1.5, grader_version = null }) {
  db.prepare(`INSERT INTO bets (id, description, result, grade, profit_units, units, review_status, graded_at, created_at, grader_version, grade_reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `desc ${id}`, result, result === 'pending' ? null : result.toUpperCase(), profit_units, 1, review_status, result === 'pending' ? null : '2026-06-01 00:00:00', created_at, grader_version, `reason ${id}`);
}

{
  const db = makeDb(DB_B);
  // In-scope: settled + needs_review, one per settled value, across both eras.
  seed(db, 'in-win', { result: 'win', review_status: 'needs_review', created_at: '2026-05-02 09:00:00', profit_units: 2 });
  seed(db, 'in-loss', { result: 'loss', review_status: 'needs_review', created_at: '2026-05-03 09:00:00', profit_units: -1 });
  seed(db, 'in-push', { result: 'push', review_status: 'needs_review', created_at: '2026-06-20 09:00:00', profit_units: 0, grader_version: 'phase1-gates-v1' });
  seed(db, 'in-void', { result: 'void', review_status: 'needs_review', created_at: '2026-06-25 09:00:00', profit_units: 0, grader_version: 'phase1-gates-v1' });
  // Out of scope — every adjacent population.
  seed(db, 'out-pending', { result: 'pending', review_status: 'needs_review' });
  seed(db, 'out-confirmed', { result: 'win', review_status: 'confirmed' });
  seed(db, 'out-null-rs', { result: 'loss', review_status: null });
  seed(db, 'out-autovoid', { result: 'void', review_status: 'auto_void_unscoped_bet' });
  seed(db, 'out-unmodeled', { result: 'pending', review_status: 'manual_review_unmodeled_sport' });
  seed(db, 'out-archived', { result: 'archived', review_status: 'needs_review' });

  const rows = S.loadBeforeState(db);
  const ids = rows.map(r => r.id).sort();
  check('B1: selects exactly the 4 settled needs_review rows',
    JSON.stringify(ids) === JSON.stringify(['in-loss', 'in-push', 'in-void', 'in-win']), `got ${JSON.stringify(ids)}`);
  check('B1: pending + needs_review NOT selected', !ids.includes('out-pending'));
  check('B1: archived + needs_review NOT selected', !ids.includes('out-archived'));
  check('B1: settled + confirmed / NULL / auto_void NOT selected',
    !ids.includes('out-confirmed') && !ids.includes('out-null-rs') && !ids.includes('out-autovoid'));
  check('B1: before-state rows carry the archive fields',
    rows.every(r => 'result' in r && 'review_status' in r && 'graded_at' in r && 'created_at' in r && 'grader_version' in r && 'profit_units' in r));

  const { cohorts, graderVersions, profitSum } = S.summarizeCohorts(rows);
  check('B2: cohort split is 2 pre-#89 / 2 gates-era',
    cohorts[S.COHORT_PRE89] && cohorts[S.COHORT_PRE89].count === 2 &&
    cohorts[S.COHORT_GATES] && cohorts[S.COHORT_GATES].count === 2);
  check('B2: grader_version cross-check counts phase1-gates-v1 rows',
    graderVersions['phase1-gates-v1'] === 2 && graderVersions['(null)'] === 2);
  check('B2: profit sum is read-only informational (+1u here)', Math.abs(profitSum - 1) < 1e-9);
  db.close();
}

// ── Section C — end-to-end CLI on an isolated DB ────────────────────────────
console.log('\nSection C — CLI: dry-run default, guards, apply, idempotency');

function run(args, dbFile) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--db', dbFile, '--allow-nonprod', ...args], { encoding: 'utf8' });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}
function snapshotRow(dbFile, id) {
  const db = new Database(dbFile, { readonly: true });
  const row = db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
  db.close();
  return row;
}

// C0: non-prod refusal without --allow-nonprod.
{
  const db = makeDb(path.join(TMP, 'c0.db')); db.close();
  let refused;
  try { execFileSync(process.execPath, [SCRIPT, '--db', path.join(TMP, 'c0.db')], { encoding: 'utf8' }); refused = false; }
  catch (err) { refused = err.status === 2 && /REFUSED/.test(`${err.stderr}`); }
  check('C0: non-prod --db without --allow-nonprod → exit 2 REFUSED', refused);
}

// C1: schema preflight aborts on a missing column.
{
  const f = path.join(TMP, 'c1.db');
  const db = new Database(f);
  db.exec('CREATE TABLE bets (id TEXT PRIMARY KEY, result TEXT, review_status TEXT)');
  db.close();
  const r = run([], f);
  check('C1: missing columns → exit 2 naming them', r.status === 2 && /schema mismatch/.test(r.out) && /grader_version/.test(r.out));
}

// C2: dry-run is the default, writes nothing, prints count + cohorts + JSON.
const DB_C = path.join(TMP, 'c2.db');
{
  const db = makeDb(DB_C);
  seed(db, 'tgt-1', { result: 'win', review_status: 'needs_review', created_at: '2026-05-02 09:00:00', profit_units: 2 });
  seed(db, 'tgt-2', { result: 'void', review_status: 'needs_review', created_at: '2026-06-20 09:00:00', profit_units: 0 });
  seed(db, 'keep-pending', { result: 'pending', review_status: 'needs_review' });
  seed(db, 'keep-confirmed', { result: 'win', review_status: 'confirmed' });
  db.close();

  const before = snapshotRow(DB_C, 'tgt-1');
  const r = run([], DB_C);
  check('C2: dry-run exits 0', r.status === 0);
  check('C2: reports total selected: 2', /total selected: 2/.test(r.out));
  check('C2: prints the before-state JSON marker', /BEFORE-STATE JSON \(archive this\):/.test(r.out));
  check('C2: JSON block parses and holds the 2 target ids', (() => {
    const m = r.out.match(/BEFORE-STATE JSON \(archive this\):\n(\[[\s\S]*?\n\])/);
    if (!m) return false;
    const ids = JSON.parse(m[1]).map(x => x.id).sort();
    return JSON.stringify(ids) === JSON.stringify(['tgt-1', 'tgt-2']);
  })());
  check('C2: magnitude warning fires (2 is far from 161)', /WARNING: live count 2/.test(r.out));
  check('C2: says DRY RUN, no writes', /DRY RUN — no writes/.test(r.out));
  check('C2: dry-run wrote nothing', JSON.stringify(snapshotRow(DB_C, 'tgt-1')) === JSON.stringify(before));
}

// C3: --apply without --force aborts on magnitude deviation, writes nothing.
{
  const r = run(['--apply'], DB_C);
  check('C3: apply blocked without --force → exit 2', r.status === 2 && /ABORT/.test(r.out) && /--force/.test(r.out));
  check('C3: nothing written on abort', snapshotRow(DB_C, 'tgt-1').review_status === 'needs_review');
}

// C4: --apply --force flips review_status ONLY; adjacent rows untouched.
{
  const before = snapshotRow(DB_C, 'tgt-1');
  const r = run(['--apply', '--force'], DB_C);
  check('C4: apply --force exits 0 reporting rows changed = 2', r.status === 0 && /rows changed = 2/.test(r.out));
  const after = snapshotRow(DB_C, 'tgt-1');
  check('C4: target row review_status → confirmed', after.review_status === 'confirmed');
  const untouched = Object.keys(before).filter(k => k !== 'review_status');
  check('C4: EVERY other column byte-identical (grades/profit untouched)',
    untouched.every(k => JSON.stringify(before[k]) === JSON.stringify(after[k])),
    untouched.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).join(','));
  check('C4: pending + needs_review row untouched', snapshotRow(DB_C, 'keep-pending').review_status === 'needs_review');
  check('C4: already-confirmed row untouched', snapshotRow(DB_C, 'keep-confirmed').review_status === 'confirmed');
}

// C5: idempotency — second apply selects 0, needs no --force, changes 0 rows.
{
  const r = run(['--apply'], DB_C);
  check('C5: second --apply exits 0 (empty selection skips the magnitude guard)', r.status === 0);
  check('C5: second run reports total selected: 0', /total selected: 0/.test(r.out));
  check('C5: second run changes 0 rows', /rows changed = 0/.test(r.out));
}

// C6: in-band population (161 rows) applies WITHOUT --force.
{
  const f = path.join(TMP, 'c6.db');
  const db = makeDb(f);
  for (let i = 0; i < 161; i++) {
    seed(db, `bulk-${String(i).padStart(3, '0')}`, {
      result: S.SETTLED_RESULTS[i % 4],
      review_status: 'needs_review',
      created_at: i < 156 ? '2026-05-15 10:00:00' : '2026-06-20 10:00:00',
    });
  }
  db.close();
  const dry = run([], f);
  check('C6: 161-row dry-run has NO magnitude warning', dry.status === 0 && !/WARNING: live count/.test(dry.out));
  const r = run(['--apply'], f);
  check('C6: in-band --apply needs no --force, changes 161', r.status === 0 && /rows changed = 161/.test(r.out));
  const db2 = new Database(f, { readonly: true });
  const left = db2.prepare("SELECT COUNT(*) AS n FROM bets WHERE review_status = 'needs_review'").get().n;
  const conf = db2.prepare("SELECT COUNT(*) AS n FROM bets WHERE review_status = 'confirmed'").get().n;
  db2.close();
  check('C6: all 161 now confirmed, none left needs_review', left === 0 && conf === 161);
}

// C7: magnitude abort with a LARGE population must not truncate the archived
// JSON — >64KB of before-state through a pipe survives the exit-2 path
// (process.exitCode + natural exit, never process.exit after the JSON print).
{
  const f = path.join(TMP, 'c7.db');
  const db = makeDb(f);
  for (let i = 0; i < 250; i++) {
    seed(db, `big-${String(i).padStart(3, '0')}`, { result: 'win', review_status: 'needs_review' });
  }
  db.close();
  const r = run(['--apply'], f);
  check('C7: 250-row --apply without --force → exit 2', r.status === 2 && /ABORT/.test(r.out));
  check('C7: abort output is big enough to exercise the pipe buffer (>64KB)', r.out.length > 65536);
  check('C7: archived JSON survives the abort intact (parses, 250 rows)', (() => {
    const m = r.out.match(/BEFORE-STATE JSON \(archive this\):\n(\[[\s\S]*?\n\])/);
    if (!m) return false;
    try { return JSON.parse(m[1]).length === 250; } catch (_) { return false; }
  })());
  check('C7: nothing written on the big-population abort', snapshotRow(f, 'big-000').review_status === 'needs_review');
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nreconcile-needs-review: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
