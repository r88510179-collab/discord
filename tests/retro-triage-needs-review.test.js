// ═══════════════════════════════════════════════════════════
// retro-triage-needs-review.js — CLI safety + selection/write correctness.
// Pattern: tests/reconcile-needs-review.test.js / backfill-event-dates.test.js
// (Section A DB-free unit cases, Section B seeded DB through the REAL
// services/database schema, Section C end-to-end CLI via child_process on
// isolated DB copies).
//
// Run: node tests/retro-triage-needs-review.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const S = require('../scripts/retro-triage-needs-review.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'retro-triage-needs-review.js');
const REPO_ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

// ── Section A — DB-free unit cases ──────────────────────────────────────────
console.log('Section A — parseArgs + helpers + pinned SQL');

check('A1: default is dry-run', S.parseArgs([]).mode === 'dry-run');
check('A1: defaults are batch 200 / since 2026-08-01 / until null(now)', (() => {
  const a = S.parseArgs([]);
  return a.batch === 200 && a.since === '2026-08-01' && a.until === null && !a.error;
})());
check('A1: --apply parses', S.parseArgs(['--apply']).mode === 'apply');
check('A1: --apply --dry-run conflict refused', !!S.parseArgs(['--apply', '--dry-run']).error);
check('A1: conflict is STICKY — --dry-run --apply --apply still errors', !!S.parseArgs(['--dry-run', '--apply', '--apply']).error);
check('A1: conflict is STICKY — --apply --dry-run --dry-run still errors', !!S.parseArgs(['--apply', '--dry-run', '--dry-run']).error);
check('A1: unknown arg → error', !!S.parseArgs(['--frobnicate']).error);

check('A2: --batch must be a positive int — 0 refused', !!S.parseArgs(['--batch', '0']).error);
check('A2: --batch non-numeric refused', !!S.parseArgs(['--batch', 'abc']).error);
check('A2: --batch missing value refused (never swallows the next flag)', !!S.parseArgs(['--batch', '--apply']).error);
check('A2: --batch 300 parses', S.parseArgs(['--batch', '300']).batch === 300);
check('A2: --since bad format refused', !!S.parseArgs(['--since', '08/01/2026']).error);
check('A2: --since impossible date refused (2026-02-30)', !!S.parseArgs(['--since', '2026-02-30']).error);
check('A2: --until before --since refused', !!S.parseArgs(['--since', '2026-08-01', '--until', '2026-07-01']).error);
check('A2: --until before the DEFAULT since refused', !!S.parseArgs(['--until', '2026-07-01']).error);
check('A2: --void-season missing value refused', !!S.parseArgs(['--void-season']).error);
check('A2: --apply --void-season X --batch N refused (separate interventions)',
  !!S.parseArgs(['--apply', '--void-season', 'Beta', '--batch', '50']).error);
check('A2: --apply --void-season X --since D refused', !!S.parseArgs(['--apply', '--void-season', 'Beta', '--since', '2026-08-01']).error);
check('A2: dry-run --void-season X --batch N coexist (both previews)', (() => {
  const a = S.parseArgs(['--void-season', 'Beta', '--batch', '50']);
  return !a.error && a.mode === 'dry-run' && a.voidSeason === 'Beta' && a.batch === 50;
})());

check('A3: ageBucket <1d', S.ageBucket('2026-08-10 12:00:00', Date.UTC(2026, 7, 10, 18)) === '<1d');
check('A3: ageBucket 1-7d', S.ageBucket('2026-08-05 12:00:00', Date.UTC(2026, 7, 10, 18)) === '1-7d');
check('A3: ageBucket 7-30d', S.ageBucket('2026-07-20 12:00:00', Date.UTC(2026, 7, 10, 18)) === '7-30d');
check('A3: ageBucket >30d', S.ageBucket('2026-06-01 12:00:00', Date.UTC(2026, 7, 10, 18)) === '>30d');
check('A3: ageBucket NULL → unknown', S.ageBucket(null) === 'unknown');
check('A3: nextDayYmd rolls months', S.nextDayYmd('2026-08-31') === '2026-09-01');

// Pinned write SQL: full gate in the WHERE + the sweeper's exact column set
// (sweepExpiredBet → gradeBetRecord: result, profit_units, grade,
// grade_reason, graded_at, grading_state='done', grading_lock_until=NULL,
// grader_version).
check('A4: void UPDATE repeats the FULL gate in its WHERE clause',
  /WHERE id = \? AND result = 'pending' AND review_status = 'needs_review' AND season = \?/.test(S.VOID_UPDATE_SQL));
check('A4: void UPDATE carries the write-time tailed guard (NOT EXISTS user_bets)',
  /AND NOT EXISTS \(SELECT 1 FROM user_bets ub WHERE ub\.bet_id = bets\.id\)/.test(S.VOID_UPDATE_SQL));
check('A4: void UPDATE writes the sweeper column set',
  /result = 'void'/.test(S.VOID_UPDATE_SQL) &&
  /profit_units = 0/.test(S.VOID_UPDATE_SQL) &&
  /grade = 'VOID'/.test(S.VOID_UPDATE_SQL) &&
  /graded_at = datetime\('now'\)/.test(S.VOID_UPDATE_SQL) &&
  /grading_state = 'done'/.test(S.VOID_UPDATE_SQL) &&
  /grading_lock_until = NULL/.test(S.VOID_UPDATE_SQL) &&
  /grader_version = 'retro-triage-v1'/.test(S.VOID_UPDATE_SQL));
check('A4: void UPDATE never touches review_status or sweep_exempt_until',
  !/review_status\s*=/.test(S.VOID_UPDATE_SQL.replace(/WHERE[\s\S]*$/, '')) &&
  !/sweep_exempt_until/.test(S.VOID_UPDATE_SQL));
check('A4: population predicate pinned', S.PENDING_NR_WHERE === "result = 'pending' AND review_status = 'needs_review'");
check('A4: breadcrumb carries the retro-triage date tag + season',
  S.buildVoidReason('Beta', '2026-10-29') === '[retro-triage 2026-10-29] Beta needs_review backlog voided, evidence-free (sweeper semantics)');

check('A5: ingest identity prefers Discord ref', S.ingestIdentityFor({ id: 'x', source_message_id: '123' }).ingestId === 'disc_123');
check('A5: ingest identity falls to tweet ref', S.ingestIdentityFor({ id: 'x', source_tweet_id: '456' }).ingestId === 'twit_456');
check('A5: ingest identity falls to manual_<betId>', S.ingestIdentityFor({ id: 'abc' }).ingestId === 'manual_abc');

// ── Section B — seeded DB through the real schema ───────────────────────────
let database;
try {
  process.env.DB_PATH = path.join(os.tmpdir(), `retro-triage-${process.pid}-${process.hrtime.bigint()}.db`);
  database = require('../services/database');
} catch (err) {
  console.log(`\nSection B/C — SKIPPED (services/database unavailable: ${err.message})`);
  console.log(`\nretro-triage-needs-review: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\nSection B — seed through the real schema');
const db = database.db;

function seedBet(id, f) {
  const row = Object.assign({
    id, capper_id: null, sport: 'MLB', bet_type: 'straight', description: `seed ${id}`,
    odds: -110, units: 1, result: 'pending', profit_units: null, grade: null,
    grade_reason: null, graded_at: null, source: 'vision_slip', created_at: '2026-08-10 12:00:00',
    review_status: 'needs_review', season: 'S2', grading_state: 'backoff', grading_attempts: 7,
    grading_lock_until: null, grader_version: null, source_message_id: null, source_tweet_id: null,
  }, f);
  db.prepare(`INSERT OR REPLACE INTO bets (id, capper_id, sport, bet_type, description, odds, units,
      result, profit_units, grade, grade_reason, graded_at, source, created_at, review_status, season,
      grading_state, grading_attempts, grading_lock_until, grader_version, source_message_id, source_tweet_id)
    VALUES (@id,@capper_id,@sport,@bet_type,@description,@odds,@units,@result,@profit_units,@grade,
      @grade_reason,@graded_at,@source,@created_at,@review_status,@season,@grading_state,@grading_attempts,
      @grading_lock_until,@grader_version,@source_message_id,@source_tweet_id)`).run(row);
}

// Approve cohort (season S2). In the default --since 2026-08-01 range:
// a1 (newest), a2, a4 — a3 and old1 sit OUTSIDE the range.
seedBet('a1-newest', { created_at: '2026-08-10 12:00:00', source_message_id: 'msg-a1' });
seedBet('a2-second', { created_at: '2026-08-09 12:00:00', source_tweet_id: 'tw-a2' });
seedBet('a4-third', { created_at: '2026-08-08 12:00:00' });
seedBet('a3-outrange', { created_at: '2026-07-20 12:00:00' });
seedBet('old1-outrange', { created_at: '2026-07-01 12:00:00' });
// Adjacent populations that must NEVER be selected.
seedBet('conf1-pending-confirmed', { review_status: 'confirmed', created_at: '2026-08-10 13:00:00' });
seedBet('settled1-needsreview', { result: 'win', profit_units: 1.5, grade: 'WIN', graded_at: '2026-08-11 00:00:00', created_at: '2026-08-10 14:00:00', grading_state: 'done', grading_attempts: 0 });
// Void cohort (season Beta, all out of the approve range).
seedBet('b1-void-me', { season: 'Beta', created_at: '2026-06-10 12:00:00', grading_lock_until: '2026-09-01 00:00:00' });
seedBet('b2-tailed', { season: 'Beta', created_at: '2026-06-11 12:00:00' });
seedBet('b3-confirmed', { season: 'Beta', created_at: '2026-06-12 12:00:00', review_status: 'confirmed' });
seedBet('b4-settled', { season: 'Beta', created_at: '2026-06-13 12:00:00', result: 'loss', profit_units: -1, grade: 'LOSS', graded_at: '2026-06-14 00:00:00', grading_state: 'done', grading_attempts: 0 });

db.prepare("INSERT OR REPLACE INTO users (id, username) VALUES ('u1', 'tester')").run();
db.prepare("INSERT INTO user_bets (user_id, bet_id, action, status, created_at) VALUES ('u1', 'b2-tailed', 'tail', 'pending', '2026-08-01 00:00:00')").run();

check('B1: population count is 7 (5 S2 + 2 Beta pending needs_review)',
  db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE ${S.PENDING_NR_WHERE}`).get().n === 7);
check('B1: tailed bet visible via user_bets join',
  db.prepare(`SELECT COUNT(*) AS n FROM bets b JOIN user_bets ub ON ub.bet_id = b.id WHERE ${S.PENDING_NR_WHERE}`).get().n === 1);

// ── Section C — end-to-end CLI on isolated DB copies ────────────────────────
console.log('\nSection C — CLI: dry-run, batch apply, idempotency, void, refusals');

db.pragma('wal_checkpoint(TRUNCATE)');

function freshCopy(tag) {
  const f = path.join(os.tmpdir(), `retro-triage-child-${tag}-${process.pid}-${process.hrtime.bigint()}.db`);
  fs.copyFileSync(process.env.DB_PATH, f);
  return f;
}
function runCli(args, dbFile) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DB_PATH: dbFile, APP_ROOT: REPO_ROOT },
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}
const Database = require('better-sqlite3');
function snapshot(dbFile) {
  const d = new Database(dbFile);
  const bets = d.prepare('SELECT * FROM bets ORDER BY id').all();
  const events = d.prepare('SELECT COUNT(*) AS n FROM pipeline_events').get().n;
  const history = d.prepare('SELECT COUNT(*) AS n FROM bet_grade_history').get().n;
  d.close();
  return { bets, events, history };
}
function betRow(dbFile, id) {
  const d = new Database(dbFile);
  const row = d.prepare('SELECT * FROM bets WHERE id = ?').get(id);
  d.close();
  return row;
}

// C1: dry-run default — full report, zero writes.
{
  const f = freshCopy('c1');
  const before = snapshot(f);
  const r = runCli(['--void-season', 'Beta'], f);
  check('C1: dry-run exits 0', r.status === 0, r.out.slice(0, 400));
  check('C1: reports the backlog total (7)', /pending needs_review backlog: 7 bets/.test(r.out));
  check('C1: by-season section present', /by season:/.test(r.out) && /S2: 5/.test(r.out) && /Beta: 2/.test(r.out));
  check('C1: age-bucket + sport + source sections present',
    /by age bucket/.test(r.out) && /by sport \(top 10\):/.test(r.out) && /by source \(top 10\):/.test(r.out));
  check('C1: tailed count 1, id listed', /tailed \(user_bets row exists\): 1/.test(r.out) && /b2-tailed/.test(r.out));
  check('C1: approve preview = the 3 in-range (newest first), out-of-range absent',
    /WOULD approve 3 bets/.test(r.out) && /a1-newes/.test(r.out) && /a4-third/.test(r.out) && !/old1-out/.test(r.out) && !/a3-outra/.test(r.out));
  check('C1: void preview marks the tailed row SKIP', /WOULD void 1 bets \(1 tailed → SKIP\)/.test(r.out) && /b2-taile.*SKIP \(tailed\)/.test(r.out));
  check('C1: says DRY RUN, no writes', /DRY RUN — no writes/.test(r.out));
  const after = snapshot(f);
  check('C1: dry-run wrote NOTHING (bets + events + history identical)',
    JSON.stringify(before) === JSON.stringify(after));
}

// C2/C3: --apply --batch 2 approves exactly the 2 newest in range; re-runs
// drain the remainder, then approve 0.
{
  const f = freshCopy('c2');
  const r = runCli(['--apply', '--batch', '2', '--since', '2026-08-01'], f);
  check('C2: apply exits 0 reporting approved=2 refused=0', r.status === 0 && /approved=2 refused=0/.test(r.out), r.out.slice(0, 600));

  const a1 = betRow(f, 'a1-newest');
  check('C2: a1 approved — review_status confirmed', a1.review_status === 'confirmed');
  check('C2: a1 clean-slate grading reset (ready / 0 attempts / locks cleared)',
    a1.grading_state === 'ready' && a1.grading_attempts === 0 && a1.grading_lock_until == null && a1.grading_next_attempt_at == null);
  check('C2: a1 sweep grace stamped (sweep_exempt_until set)', a1.sweep_exempt_until != null);
  check('C2: a1 result untouched (still pending — grader decides)', a1.result === 'pending');
  check('C2: a2 (second newest) also approved', betRow(f, 'a2-second').review_status === 'confirmed');
  check('C2: a4 (in range, OLDER than the batch) left needs_review', betRow(f, 'a4-third').review_status === 'needs_review');
  check('C2: out-of-range rows untouched',
    betRow(f, 'a3-outrange').review_status === 'needs_review' && betRow(f, 'old1-outrange').review_status === 'needs_review');
  check('C2: already-confirmed + settled rows untouched',
    betRow(f, 'conf1-pending-confirmed').review_status === 'confirmed' && betRow(f, 'settled1-needsreview').result === 'win');

  const d = new Database(f);
  const ev = d.prepare(`SELECT ingest_id, bet_id FROM pipeline_events
    WHERE stage = 'VALIDATED' AND event_type = 'STAGE_EXIT' AND payload LIKE '%"retroTriage":"approve"%'`).all();
  d.close();
  check('C2: one VALIDATED/STAGE_EXIT retroTriage event per approved bet', ev.length === 2,
    JSON.stringify(ev));
  check('C2: events carry the bets\' own ingest identity (disc_/twit_)',
    ev.some(e => e.ingest_id === 'disc_msg-a1') && ev.some(e => e.ingest_id === 'twit_tw-a2'));

  const r2 = runCli(['--apply', '--batch', '10', '--since', '2026-08-01'], f);
  check('C3: re-run drains only the remainder (approved=1, never the same rows)', r2.status === 0 && /approved=1 refused=0/.test(r2.out));
  const r3 = runCli(['--apply', '--batch', '10', '--since', '2026-08-01'], f);
  check('C3: third run approves 0 (idempotent — range exhausted)', r3.status === 0 && /approved=0 refused=0/.test(r3.out));
}

// C4: --apply --void-season Beta — tailed hard-skip, sweeper column set,
// archive-row-first, full gate at write time.
{
  const f = freshCopy('c4');
  const before = betRow(f, 'b1-void-me');
  const r = runCli(['--apply', '--void-season', 'Beta'], f);
  check('C4: exits 0 reporting voided=1 skipped_tailed=1', r.status === 0 && /voided=1 skipped_tailed=1/.test(r.out), r.out.slice(0, 600));
  check('C4: tailed skip printed with the id', /SKIP \(tailed\): b2-taile/.test(r.out));

  const after = betRow(f, 'b1-void-me');
  check('C4: b1 voided with the breadcrumb',
    after.result === 'void' && /^\[retro-triage \d{4}-\d{2}-\d{2}\] Beta needs_review backlog voided, evidence-free \(sweeper semantics\)$/.test(after.grade_reason || ''));
  check('C4: b1 carries retro-triage-v1 (the ONLY distinguisher from a swept void besides the breadcrumb)',
    after.grader_version === 'retro-triage-v1');
  const changed = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
  check('C4: changed columns are EXACTLY the sweeper void set',
    JSON.stringify(changed) === JSON.stringify(['grade', 'grade_reason', 'graded_at', 'grader_version', 'grading_lock_until', 'grading_state', 'profit_units', 'result']),
    `changed: ${changed.join(',')}`);
  check('C4: profit 0 / grade VOID / state done / lock cleared',
    after.profit_units === 0 && after.grade === 'VOID' && after.grading_state === 'done' && after.grading_lock_until == null);
  check('C4: review_status stays needs_review (deliberate)', after.review_status === 'needs_review');

  const d = new Database(f);
  const hist = d.prepare('SELECT * FROM bet_grade_history WHERE bet_id = ?').all('b1-void-me');
  const tailedHist = d.prepare('SELECT COUNT(*) AS n FROM bet_grade_history WHERE bet_id = ?').get('b2-tailed').n;
  d.close();
  check('C4: archive row written FIRST with old_result=pending + provenance',
    hist.length === 1 && hist[0].old_result === 'pending' && hist[0].archived_by === S.ARCHIVED_BY && /void/.test(hist[0].reason || ''));
  check('C4: NO archive row for the tailed skip', tailedHist === 0);
  check('C4: tailed bet untouched (still pending needs_review)',
    betRow(f, 'b2-tailed').result === 'pending' && betRow(f, 'b2-tailed').review_status === 'needs_review');
  check('C4: confirmed + settled Beta rows untouched',
    betRow(f, 'b3-confirmed').result === 'pending' && betRow(f, 'b4-settled').result === 'loss');

  const r2 = runCli(['--apply', '--void-season', 'Beta'], f);
  check('C4: re-run voids 0 (b1 no longer matches the gate)', r2.status === 0 && /voided=0 skipped_tailed=1/.test(r2.out));
}

// C5: refusals — flag conflict, bad input, wrong DB file.
{
  const f = freshCopy('c5');
  const r = runCli(['--apply', '--dry-run'], f);
  check('C5: --apply --dry-run → exit 2 mutually exclusive', r.status === 2 && /mutually exclusive/.test(r.out));
  const r2 = runCli(['--apply', '--batch', '0'], f);
  check('C5: --batch 0 → exit 2', r2.status === 2 && /positive integer/.test(r2.out));
  const r3 = runCli(['--since', '2026-13-01'], f);
  check('C5: impossible --since date → exit 2', r3.status === 2);

  const empty = path.join(os.tmpdir(), `retro-triage-empty-${process.pid}.db`);
  const d = new Database(empty); d.exec('CREATE TABLE not_bets (x)'); d.close();
  const r4 = runCli([], empty);
  check('C5: DB without the expected tables → exit 2 schema mismatch', r4.status === 2 && /schema mismatch/.test(r4.out));
  fs.unlinkSync(empty);
}

// ── Section D — void-worker race seams (PR #211 review findings) ────────────
// Drives buildVoidWorker directly on the in-process DB to simulate the
// selection→write races the CLI cannot reproduce in one process. Runs LAST so
// its seeds never leak into the Section C copies.
console.log('\nSection D — write-time recheck inside the void transaction');
{
  const insertCols = ['bet_id', 'old_result', 'old_profit_units', 'old_grade', 'old_grade_reason', 'old_graded_at', 'archived_by', 'reason'];
  const reason = S.buildVoidReason('Beta', '2026-10-29');
  const voidOne = S.buildVoidWorker(db, { season: 'Beta', reason, insertCols });
  const histCount = id => db.prepare('SELECT COUNT(*) AS n FROM bet_grade_history WHERE bet_id = ?').get(id).n;

  // D1: tail/fade accepted AFTER selection (worker built = selection done).
  seedBet('w1-race-tailed', { season: 'Beta', created_at: '2026-06-15 12:00:00' });
  db.prepare("INSERT INTO user_bets (user_id, bet_id, action, status, created_at) VALUES ('u1', 'w1-race-tailed', 'fade', 'pending', '2026-10-29 00:00:00')").run();
  check('D1: post-selection tail → worker outcome tailed', voidOne('w1-race-tailed') === 'tailed');
  const w1 = db.prepare('SELECT result, review_status FROM bets WHERE id = ?').get('w1-race-tailed');
  check('D1: race-tailed bet NOT voided (still pending needs_review)', w1.result === 'pending' && w1.review_status === 'needs_review');
  check('D1: race-tailed bet left NO archive row', histCount('w1-race-tailed') === 0);
  check('D1: the UPDATE itself refuses a tailed bet (NOT EXISTS guard, changes=0)',
    db.prepare(S.VOID_UPDATE_SQL).run(reason, 'w1-race-tailed', 'Beta').changes === 0);

  // D2: operator confirmed the bet AFTER selection.
  seedBet('w2-race-confirmed', { season: 'Beta', created_at: '2026-06-15 12:00:00' });
  db.prepare("UPDATE bets SET review_status = 'confirmed' WHERE id = 'w2-race-confirmed'").run();
  check('D2: post-selection confirm → worker outcome gate_noop', voidOne('w2-race-confirmed') === 'gate_noop');
  check('D2: confirmed bet NOT voided', db.prepare('SELECT result FROM bets WHERE id = ?').get('w2-race-confirmed').result === 'pending');
  check('D2: refused void left NO archive row', histCount('w2-race-confirmed') === 0);

  // D3: clean candidate still voids, archive row from the LIVE read.
  seedBet('w3-clean', { season: 'Beta', created_at: '2026-06-15 12:00:00' });
  check('D3: clean candidate → worker outcome voided', voidOne('w3-clean') === 'voided');
  const w3 = db.prepare('SELECT result, grade, grading_state, grader_version FROM bets WHERE id = ?').get('w3-clean');
  check('D3: voided with sweeper set + retro-triage-v1',
    w3.result === 'void' && w3.grade === 'VOID' && w3.grading_state === 'done' && w3.grader_version === 'retro-triage-v1');
  const w3h = db.prepare('SELECT old_result, archived_by FROM bet_grade_history WHERE bet_id = ?').all('w3-clean');
  check('D3: exactly one archive row, old_result from the live read', w3h.length === 1 && w3h[0].old_result === 'pending' && w3h[0].archived_by === S.ARCHIVED_BY);
  check('D3: worker is idempotent (second call gate_noop, no second archive row)',
    voidOne('w3-clean') === 'gate_noop' && histCount('w3-clean') === 1);

  // D4: missing bet → gate_noop, nothing written.
  check('D4: unknown bet id → gate_noop, no archive row', voidOne('nope-does-not-exist') === 'gate_noop' && histCount('nope-does-not-exist') === 0);
}

console.log(`\nretro-triage-needs-review: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
