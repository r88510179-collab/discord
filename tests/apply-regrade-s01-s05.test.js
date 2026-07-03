// ═══════════════════════════════════════════════════════════
// apply-regrade-s01-s05 — fixture test.
//
// Section A (DB-FREE): input validation + the pure buildPlan/resolveMmaSport
// logic against an injected getBet. Runs on any machine (the script's
// better-sqlite3 require lives in main() behind require.main), so it is safe
// inside `npm run check`.
//
// Section B (DB-BACKED): builds a real migrated throwaway DB via services/
// database.js, seeds representative rows (a void, a plain win/loss, the
// unit+sport-corrected 8436c0c7, the MMA anchor, and an already-stamped row),
// then exercises buildPlan + applyPlan and asserts the archive rows + the
// bets result/grade/profit/units/sport writes + idempotency. Self-SKIPS (exit
// 0 on the Section-A result) when better-sqlite3 / database.js can't load, so
// the file is still safe in `npm run check` on a bare machine.
// ═══════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const os = require('os');

const S = require('../scripts/apply-regrade-s01-s05.js');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }

// Ids from the real correction tables.
const SPORT_ID = '8436c0c7a28e303fed1d561af23fa595';
const ANCHOR_ID = '7e0e7777d778776b69531156c19b6544';
const UNIT_ID = '716a7b2cd0dadea096350c0c6d353c94';

// ── Section A: DB-free ──────────────────────────────────────
console.log('Section A — DB-free plan/validation');

// A1. validateEntries: good + each bad shape.
{
  const good = [
    { bet_id: 'a'.repeat(32), result: 'win', profit_units: 1.5, grade_reason: 'x' },
    { bet_id: 'b'.repeat(32), result: 'loss', profit_units: -2, grade_reason: 'x' },
    { bet_id: 'c'.repeat(32), result: 'unknown', profit_units: null, grade_reason: 'x' },
  ];
  // add the mandated correction ids so validateEntries' presence gate passes
  for (const id of Object.keys(S.UNIT_CORRECTIONS)) good.push({ bet_id: id, result: 'win', profit_units: 1, grade_reason: 'x' });
  const c = S.validateEntries(good);
  check('A1: valid input -> counts', c.win === 1 + 7 && c.loss === 1 && c.unknown === 1);
  check('A1: bad bet_id throws', throws(() => S.validateEntries([{ bet_id: 'zzz', result: 'win', profit_units: 1, grade_reason: 'x' }])));
  check('A1: win with pu<=0 throws', throws(() => S.validateEntries([{ bet_id: 'a'.repeat(32), result: 'win', profit_units: -1, grade_reason: 'x' }])));
  check('A1: loss with pu>=0 throws', throws(() => S.validateEntries([{ bet_id: 'a'.repeat(32), result: 'loss', profit_units: 1, grade_reason: 'x' }])));
  check('A1: unknown with pu!=null/0 throws', throws(() => S.validateEntries([{ bet_id: 'a'.repeat(32), result: 'unknown', profit_units: 5, grade_reason: 'x' }])));
  check('A1: unknown with pu=0 accepted', !throws(() => S.validateEntries(good.concat([{ bet_id: 'd'.repeat(32), result: 'unknown', profit_units: 0, grade_reason: 'x' }]))));
  check('A1: duplicate id throws', throws(() => S.validateEntries([good[0], good[0]])));
  check('A1: empty grade_reason throws', throws(() => S.validateEntries([{ bet_id: 'a'.repeat(32), result: 'win', profit_units: 1, grade_reason: '  ' }])));
}

// A2. resolveMmaSport: anchor / fallback / override.
{
  const withAnchor = (id) => (id === ANCHOR_ID ? { sport: 'MMA' } : null);
  check('A2: anchor MMA used', S.resolveMmaSport(withAnchor).value === 'MMA' && /anchor/.test(S.resolveMmaSport(withAnchor).source));
  const anchorSoccer = (id) => (id === ANCHOR_ID ? { sport: 'Soccer' } : null);
  check('A2: anchor non-MMA -> fallback MMA', S.resolveMmaSport(anchorSoccer).value === 'MMA' && /fallback/.test(S.resolveMmaSport(anchorSoccer).source));
  check('A2: anchor absent -> fallback', S.resolveMmaSport(() => null).value === 'MMA');
  check('A2: override wins', S.resolveMmaSport(withAnchor, 'UFC').value === 'UFC');
  check('A2: looksLikeMmaSport', S.looksLikeMmaSport('mma') && S.looksLikeMmaSport('UFC') && !S.looksLikeMmaSport('Soccer'));
}

// A3. buildPlan: mapping, corrections, skip, missing, warnings, summary.
{
  const rows = {
    [ANCHOR_ID]: { id: ANCHOR_ID, description: 'anchor', bet_type: 'straight', sport: 'MMA', odds: -110, units: 1, result: 'loss', profit_units: -1, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    [SPORT_ID]: { id: SPORT_ID, description: 'rodriguez', bet_type: 'straight', sport: 'Soccer', odds: null, units: 1, result: 'loss', profit_units: -1, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    [UNIT_ID]: { id: UNIT_ID, description: 'unit', bet_type: 'straight', sport: 'MLB', odds: -110, units: 5, result: 'loss', profit_units: -5, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    win1: { id: 'win1', description: 'plain win', bet_type: 'straight', sport: 'MLB', odds: -110, units: 2, result: 'loss', profit_units: -2, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    void1: { id: 'void1', description: 'plain void', bet_type: 'straight', sport: 'MLB', odds: -110, units: 3, result: 'loss', profit_units: -3, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    lossM: { id: 'lossM', description: 'loss mismatch', bet_type: 'straight', sport: 'MLB', odds: -110, units: 1, result: 'loss', profit_units: -1, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null },
    already: { id: 'already', description: 'stamped', bet_type: 'straight', sport: 'MLB', odds: -110, units: 1, result: 'win', profit_units: 1, grade: 'WIN', grade_reason: 'old', graded_at: 't', grader_version: S.GRADER_VERSION },
  };
  const getBet = (id) => rows[id] || null;
  const entries = [
    { bet_id: ANCHOR_ID, result: 'loss', profit_units: -1, grade_reason: 'anchor stays' },
    { bet_id: SPORT_ID, result: 'win', profit_units: 4.6512, grade_reason: 'UFC not soccer', evidence_source: 'ufc_com', evidence_url: 'https://x' },
    { bet_id: UNIT_ID, result: 'loss', profit_units: -1, grade_reason: 'unit fix loss' },
    { bet_id: 'win1', result: 'win', profit_units: 1.82, grade_reason: 'won' },
    { bet_id: 'void1', result: 'unknown', profit_units: null, grade_reason: 'ungradeable' },
    { bet_id: 'lossM', result: 'loss', profit_units: -3, grade_reason: 'stake disagrees' }, // pu -3 but units 1 -> warn
    { bet_id: 'already', result: 'win', profit_units: 1, grade_reason: 'already applied' },
    { bet_id: 'missing1'.padEnd(32, '0'), result: 'win', profit_units: 1, grade_reason: 'not in db' },
  ];
  const { plans, apply, missing, summary } = S.buildPlan(entries, { getBet, mmaSport: 'MMA' });

  check('A3: missing detected', missing.length === 1 && missing[0].startsWith('missing1'));
  const bySport = apply.find(p => p.entry.bet_id === SPORT_ID);
  check('A3: sport correction Soccer->MMA', bySport.next.sport === 'MMA' && bySport.sportCorrection === 'MMA');
  check('A3: sport correction units 1->10', bySport.next.units === 10 && bySport.unitCorrection === 10);
  check('A3: sport correction profit verbatim', near(bySport.next.profit_units, 4.6512) && bySport.next.grade === 'WIN');
  const byUnit = apply.find(p => p.entry.bet_id === UNIT_ID);
  check('A3: unit-corrected loss units 5->1', byUnit.next.units === 1 && byUnit.next.result === 'loss');
  check('A3: unit-corrected loss profit verbatim (-1)', near(byUnit.next.profit_units, -1));
  const byVoid = apply.find(p => p.entry.bet_id === 'void1');
  check('A3: void -> profit 0 + grade VOID', byVoid.next.profit_units === 0 && byVoid.next.result === 'void' && byVoid.next.grade === 'VOID');
  const byLossM = apply.find(p => p.entry.bet_id === 'lossM');
  check('A3: loss=-units mismatch warns', byLossM.warnings.some(w => /!= -units/.test(w)));
  const skipped = plans.find(p => p.entry.bet_id === 'already');
  check('A3: already-stamped skipped', skipped.action === 'skip');
  check('A3: summary counts', summary.win === 2 && summary.loss === 3 && summary.void === 1 && summary.unitCorrections === 2 && summary.sportCorrections === 1 && summary.toArchive === 6 && summary.skipped === 1);
}

// A4. parseArgs: defaults, conflict, non-prod guard surfaces via main (unit here).
{
  check('A4: default dry-run', S.parseArgs([]).mode === 'dry-run');
  check('A4: --apply', S.parseArgs(['--apply']).mode === 'apply');
  check('A4: conflict', S.parseArgs(['--apply', '--dry-run']).error != null);
  check('A4: unknown arg', S.parseArgs(['--nope']).error != null);
  check('A4: default db is prod', S.parseArgs([]).dbPath === S.PROD_DB_PATH);
  check('A4: input/db passthrough', S.parseArgs(['--input', '/i', '--db', '/d']).inputPath === '/i' && S.parseArgs(['--db', '/d']).dbPath === '/d');
}

// A5. THE load-bearing invariant: the REAL co-located regrade-final.json maps
// to the exact sanity target main() prints (58W/35L/20void/7unit/1sport/113).
// DB-free (stub getBet returns a row per id), so a dropped/added/reclassified
// JSON entry or a removed correction id fails CI — not just the operator dry-run.
{
  const REAL = path.join(__dirname, '..', 'scripts', 'regrade-final.json');
  const entries = S.loadEntries(REAL); // load + validate the shipped payload
  const c = S.validateEntries(entries);
  check('A5: payload counts 113/58/35/20', c.total === 113 && c.win === 58 && c.loss === 35 && c.unknown === 20);
  // stub: a row per id, loss units aligned to |pu| (no spurious warns), old pu 0
  // so netDelta == Σ new profit_units; anchor MMA, sport-correction bet Soccer.
  const getBet = (id) => {
    const e = entries.find(x => x.bet_id === id);
    if (!e) return null;
    const sport = id === S.SPORT_CORRECTION.id ? 'Soccer' : (id === S.SPORT_CORRECTION.anchorBetId ? 'MMA' : 'MLB');
    const units = e.result === 'loss' ? Math.abs(e.profit_units) : 1;
    return { id, description: 'x', bet_type: 'straight', sport, odds: -110, units, result: 'loss', profit_units: 0, grade: 'LOSS', grade_reason: 'old', graded_at: 't', grader_version: null };
  };
  const mma = S.resolveMmaSport(getBet);
  const { summary, missing } = S.buildPlan(entries, { getBet, mmaSport: mma.value });
  check('A5: MMA resolved to MMA from anchor', mma.value === 'MMA');
  check('A5: sanity target MATCH', summary.win === 58 && summary.loss === 35 && summary.void === 20
    && summary.unitCorrections === 7 && summary.sportCorrections === 1 && summary.toArchive === 113 && missing.length === 0);
  check('A5: no internal loss=-units contradictions (0 warnings)', summary.warnings === 0);
  check('A5: new-state Σ profit_units = +59.7u (void=0)', near(summary.netDelta, 59.7, 0.005));
}

console.log(`\nSection A: ${pass} passed, ${fail} failed`);
const sectionAFail = fail;

// ── Section B: DB-backed (self-skips if node_modules unavailable) ────────────
let database;
try {
  process.env.DB_PATH = path.join(os.tmpdir(), `regrade-s01-s05-${process.pid}-${entriesStamp()}.db`);
  database = require('../services/database');
} catch (err) {
  console.log(`\nSection B — SKIPPED (database.js/better-sqlite3 unavailable: ${err.message})`);
  process.exit(sectionAFail === 0 ? 0 : 1);
}
function entriesStamp() { return String(process.hrtime.bigint()); }

console.log('\nSection B — DB-backed apply');
{
  const db = database.db;
  function seed(id, f) {
    const row = Object.assign({ id, sport: 'MLB', bet_type: 'straight', description: 'seed ' + id, odds: -110, units: 1, result: 'loss', profit_units: -1, grade: 'LOSS', grade_reason: 'Auto-swept: 7-day', season: 'Beta', graded_at: '2026-05-01 00:00:00', grader_version: null }, f);
    db.prepare(`INSERT OR REPLACE INTO bets (id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason, season, graded_at, grader_version)
      VALUES (@id,@sport,@bet_type,@description,@odds,@units,@result,@profit_units,@grade,@grade_reason,@season,@graded_at,@grader_version)`).run(row);
  }
  // representative rows
  seed(ANCHOR_ID, { sport: 'MMA' });                                   // MMA anchor (stays loss)
  seed(SPORT_ID, { sport: 'Soccer', units: 1 });                       // sport+unit corrected win
  seed(UNIT_ID, { units: 5, result: 'loss', profit_units: -5 });       // unit-corrected loss
  seed('winbet00000000000000000000000000a1', { units: 2, profit_units: -2 });
  seed('voidbet0000000000000000000000000a2', { units: 3, profit_units: -3 });
  seed('stamped000000000000000000000000a3', { result: 'win', profit_units: 9, grade: 'WIN', grader_version: S.GRADER_VERSION });

  const entries = [
    { bet_id: ANCHOR_ID, result: 'loss', profit_units: -1, grade_reason: 'Nickal TKO R1' },
    { bet_id: SPORT_ID, result: 'win', profit_units: 4.6512, grade_reason: 'UFC not soccer', evidence_source: 'ufc_com', evidence_url: 'https://ufc' },
    { bet_id: UNIT_ID, result: 'loss', profit_units: -1, grade_reason: 'unit loss' },
    { bet_id: 'winbet00000000000000000000000000a1', result: 'win', profit_units: 1.82, grade_reason: 'won it' },
    { bet_id: 'voidbet0000000000000000000000000a2', result: 'unknown', profit_units: null, grade_reason: 'ungradeable' },
    { bet_id: 'stamped000000000000000000000000a3', result: 'win', profit_units: 9, grade_reason: 'already' },
  ];

  const getBet = (id) => db.prepare(`SELECT ${S.REQUIRED_BETS_COLS.join(', ')} FROM bets WHERE id = ?`).get(id) || null;
  const mma = S.resolveMmaSport(getBet);
  check('B: MMA resolved from anchor', mma.value === 'MMA' && /anchor/.test(mma.source));

  const { apply, missing, summary } = S.buildPlan(entries, { getBet, mmaSport: mma.value });
  check('B: no missing', missing.length === 0);
  check('B: 5 actionable, 1 skipped', summary.toArchive === 5 && summary.skipped === 1);

  const res = S.applyPlan(db, apply);
  check('B: applied 5 updated + 5 archived', res.updated === 5 && res.archived === 5);

  // bets writes
  const sportRow = db.prepare('SELECT * FROM bets WHERE id = ?').get(SPORT_ID);
  check('B: sport corrected Soccer->MMA', sportRow.sport === 'MMA');
  check('B: units corrected 1->10', sportRow.units === 10);
  check('B: result/grade = win/WIN', sportRow.result === 'win' && sportRow.grade === 'WIN');
  check('B: profit verbatim 4.6512', near(sportRow.profit_units, 4.6512));
  check('B: grader_version stamped', sportRow.grader_version === S.GRADER_VERSION);
  check('B: grade_reason breadcrumb + evidence', /^\[regrade S01–S05\]/.test(sportRow.grade_reason) && /src: ufc_com/.test(sportRow.grade_reason));

  const unitRow = db.prepare('SELECT * FROM bets WHERE id = ?').get(UNIT_ID);
  check('B: unit-loss units 5->1', unitRow.units === 1 && unitRow.result === 'loss' && near(unitRow.profit_units, -1));

  const voidRow = db.prepare('SELECT * FROM bets WHERE id = ?').get('voidbet0000000000000000000000000a2');
  check('B: void row result/grade/profit', voidRow.result === 'void' && voidRow.grade === 'VOID' && voidRow.profit_units === 0);
  check('B: void row units untouched (3)', voidRow.units === 3);

  const anchorRow = db.prepare('SELECT * FROM bets WHERE id = ?').get(ANCHOR_ID);
  check('B: anchor stays loss, sport untouched (MMA)', anchorRow.result === 'loss' && anchorRow.sport === 'MMA' && anchorRow.units === 1);

  const stampedRow = db.prepare('SELECT * FROM bets WHERE id = ?').get('stamped000000000000000000000000a3');
  check('B: pre-stamped row untouched (profit 9)', near(stampedRow.profit_units, 9) && stampedRow.grade_reason === 'Auto-swept: 7-day');

  // archive: prior state captured, unit/sport deltas folded into reason
  const h = db.prepare('SELECT * FROM bet_grade_history WHERE bet_id = ?').get(SPORT_ID);
  check('B: archive old_result loss', h.old_result === 'loss' && near(h.old_profit_units, -1));
  check('B: archive old_grade_reason preserved', h.old_grade_reason === 'Auto-swept: 7-day');
  check('B: archive archived_by tag', h.archived_by === S.ARCHIVED_BY);
  check('B: archive folds units+sport deltas', /units 1->10/.test(h.reason) && /sport Soccer->MMA/.test(h.reason));
  const noArchiveStamped = db.prepare('SELECT COUNT(*) n FROM bet_grade_history WHERE bet_id = ?').get('stamped000000000000000000000000a3').n;
  check('B: skipped row NOT archived', noArchiveStamped === 0);

  // verifyPostApply
  const v = S.verifyPostApply(db, entries);
  // win=3: the 2 applied wins + the pre-stamped win row (verifyPostApply reports
  // ALL rows now carrying grader_version — the final stamped state).
  check('B: post-apply counts', v.byResult.win === 3 && v.byResult.loss === 2 && v.byResult.void === 1 && v.archived === 5);

  // ── idempotency: re-run must be a full no-op ──
  const { apply: apply2, summary: sum2 } = S.buildPlan(entries, { getBet, mmaSport: mma.value });
  check('B: re-run plan all skipped', sum2.toArchive === 0 && sum2.skipped === 6);
  const res2 = S.applyPlan(db, apply2);
  check('B: re-run applied nothing', res2.updated === 0 && res2.archived === 0);
  const archTotal = db.prepare('SELECT COUNT(*) n FROM bet_grade_history').get().n;
  check('B: no double-archive after re-run', archTotal === 5);
}

// ── Section C: end-to-end CLI via child_process (main() safety guards) ───────
// Exercises the real main() over an isolated copy of the migrated schema seeded
// with all 113 real ids: the --db refusal, abort-on-missing, dry-run-no-writes,
// --apply, and idempotency — the blast-radius controls for an irreversible run.
console.log('\nSection C — CLI safety guards (child_process)');
{
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');
  const db = database.db;
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'apply-regrade-s01-s05.js');
  const REAL = path.join(__dirname, '..', 'scripts', 'regrade-final.json');
  const realEntries = JSON.parse(fs.readFileSync(REAL, 'utf8'));

  // Seed the parent DB fresh with all 113 real ids (grader_version NULL), clear
  // Section B's leftover bets + archive rows, checkpoint, then copy to an
  // isolated file the children use.
  db.exec('DELETE FROM bets');
  db.exec('DELETE FROM bet_grade_history');
  const ins = db.prepare('INSERT OR REPLACE INTO bets (id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason, season, grader_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)');
  db.transaction(() => {
    for (const e of realEntries) {
      const sport = e.bet_id === S.SPORT_CORRECTION.id ? 'Soccer' : (e.bet_id === S.SPORT_CORRECTION.anchorBetId ? 'MMA' : 'MLB');
      const u = e.result === 'loss' ? Math.abs(e.profit_units) : 1;
      ins.run(e.bet_id, sport, 'straight', 'seed', -110, u, 'loss', e.result === 'loss' ? e.profit_units : -u, 'LOSS', 'Auto-swept: 7-day', 'Beta');
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const CHILDDB = path.join(os.tmpdir(), `regrade-child-${process.pid}-${process.hrtime.bigint()}.db`);
  fs.copyFileSync(process.env.DB_PATH, CHILDDB);

  // read-write (not readonly) so it reads any WAL frames the child left cleanly.
  const openDb = () => new Database(CHILDDB, { fileMustExist: true });
  const archiveCount = () => { const d = openDb(); const n = d.prepare('SELECT COUNT(*) n FROM bet_grade_history').get().n; d.close(); return n; };
  const stampedCount = () => { const d = openDb(); const n = d.prepare('SELECT COUNT(*) n FROM bets WHERE grader_version = ?').get(S.GRADER_VERSION).n; d.close(); return n; };
  // run the CLI; returns { status, stdout, stderr } whether it exits 0 or not.
  function runCli(cliArgs) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...cliArgs], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status == null ? -1 : err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
  }

  check('C: baseline copy has 0 archive, 0 stamped', archiveCount() === 0 && stampedCount() === 0);

  // C1. --db refusal: non-prod db without --allow-nonprod -> exit 2, no writes.
  const c1 = runCli(['--db', CHILDDB, '--apply']);
  check('C1: refuses non-prod --db (exit 2, REFUSED)', c1.status === 2 && /REFUSED/.test(c1.stderr));
  check('C1: refusal wrote nothing', archiveCount() === 0 && stampedCount() === 0);

  // C2. abort-on-missing: real payload has one extra id absent from CHILDDB.
  const MISSING_ID = 'f'.repeat(32);
  const missInput = path.join(os.tmpdir(), `regrade-missing-${process.pid}.json`);
  fs.writeFileSync(missInput, JSON.stringify(realEntries.concat([{ bet_id: MISSING_ID, result: 'win', profit_units: 1, grade_reason: 'not in db' }])));
  const c2 = runCli(['--db', CHILDDB, '--allow-nonprod', '--apply', '--input', missInput]);
  check('C2: aborts on absent bet_id (exit 1, ABORT)', c2.status === 1 && /ABORT/.test(c2.stderr) && c2.stderr.includes(MISSING_ID));
  check('C2: abort wrote nothing', archiveCount() === 0 && stampedCount() === 0);

  // C3. dry-run (default) makes NO writes.
  const c3 = runCli(['--db', CHILDDB, '--allow-nonprod', '--input', REAL]);
  check('C3: dry-run exit 0 + MATCH', c3.status === 0 && /sanity target.*MATCH/.test(c3.stdout));
  check('C3: dry-run wrote nothing', archiveCount() === 0 && stampedCount() === 0);

  // C4. --apply writes all 113; C5. re-run is idempotent.
  const c4 = runCli(['--db', CHILDDB, '--allow-nonprod', '--apply', '--input', REAL]);
  check('C4: apply exit 0 + APPLIED 113', c4.status === 0 && /APPLIED: 113 bets rewritten, 113 archived/.test(c4.stdout));
  check('C4: apply stamped 113 + archived 113', stampedCount() === 113 && archiveCount() === 113);
  check('C4: post-apply verification win=58 loss=35 void=20', /win=58 loss=35 void=20/.test(c4.stdout));

  const c5 = runCli(['--db', CHILDDB, '--allow-nonprod', '--apply', '--input', REAL]);
  check('C5: idempotent re-run exit 0 + APPLIED 0', c5.status === 0 && /APPLIED: 0 bets rewritten, 0 archived/.test(c5.stdout));
  check('C5: no double-apply (still 113 archived)', archiveCount() === 113 && stampedCount() === 113);

  try { fs.unlinkSync(CHILDDB); fs.unlinkSync(missInput); } catch (_) { /* best-effort cleanup */ }
}

console.log(`\napply-regrade-s01-s05: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
