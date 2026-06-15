// ═══════════════════════════════════════════════════════════
// Sport-casing canonicalization — write-site + dispatch + backfill.
//
// Covers (see prompts/sport-casing-normalize.md):
//   A. canonicalizeSport() — every known sport × casings → canonical;
//      acronym leagues stay UPPERCASE, word sports Title-Case; unknown /
//      compound passthrough; empty/null safe.
//   B. Dispatch is case-insensitive — services/sportsdata.normalizeSport()
//      maps lower/mixed "mlb"/"nba"/"nhl" to the adapter key, so sport casing
//      can never affect adapter routing (Soccer/Tennis are not dispatched).
//   C. Backfill idempotency — a temp SQLite with mixed-casing rows is
//      normalized on the first --apply and changes 0 rows on the second.
//   D. Write sites — createBet() and writeGradingAudit() persist canonical
//      sport values.
//
// Run:  node tests/sport-casing.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — required only because requiring grading.js pulls in ai.js.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB for the createBet / writeGradingAudit write-site checks. Set
// BEFORE requiring database/grading so the real DB is never opened.
const dbFile = path.join(os.tmpdir(), `bettracker-sport-casing-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const Database = require('better-sqlite3');
const { canonicalizeSport, CANONICAL_SPORT_BY_KEY } = require('../services/sportNormalize');
const { normalizeSport } = require('../services/sportsdata');
const { backfillOnce } = require('../scripts/backfill-sport-casing');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// ── A. canonicalizeSport ──────────────────────────────────────────────
console.log('A. canonicalizeSport()');

// Acronym leagues — UPPERCASE canonical, from any casing.
for (const acro of ['MLB', 'NBA', 'NHL', 'NFL', 'NCAAB', 'NCAAF', 'MLS', 'EPL', 'UCL', 'F1', 'NASCAR', 'UFC', 'MMA']) {
  check(`${acro} upper`, canonicalizeSport(acro), acro);
  check(`${acro} lower`, canonicalizeSport(acro.toLowerCase()), acro);
  check(`${acro} mixed`, canonicalizeSport(acro[0] + acro.slice(1).toLowerCase()), acro);
}

// Word sports — Title-Case canonical, from any casing. This is the live fork.
const WORD = { soccer: 'Soccer', SOCCER: 'Soccer', Soccer: 'Soccer', sOcCeR: 'Soccer',
  tennis: 'Tennis', TENNIS: 'Tennis', golf: 'Golf', GOLF: 'Golf', boxing: 'Boxing', BOXING: 'Boxing' };
for (const [input, want] of Object.entries(WORD)) check(`word ${input}→${want}`, canonicalizeSport(input), want);

// Multi-word league proper nouns — Title-Case.
check('LA LIGA', canonicalizeSport('LA LIGA'), 'La Liga');
check('la liga', canonicalizeSport('la liga'), 'La Liga');
check('Serie A', canonicalizeSport('serie a'), 'Serie A');
check('world cup', canonicalizeSport('world cup'), 'World Cup');
check('Copa America (detectSport label)', canonicalizeSport('COPA AMERICA'), 'Copa America');

// HARD CONSTRAINT — the dispatch acronyms must never lose their uppercase form.
for (const a of ['MLB', 'NBA', 'NHL', 'NFL']) ok(`${a} stays uppercase`, canonicalizeSport(a.toLowerCase()) === a);

// Whitespace is trimmed (only).
check('trim known', canonicalizeSport('  soccer  '), 'Soccer');
check('trim unknown', canonicalizeSport('  KBO  '), 'KBO');

// Unknown / compound → passthrough UNCHANGED (case preserved, never mangled).
check('unknown KBO', canonicalizeSport('KBO'), 'KBO');
check('unknown kbo lower', canonicalizeSport('kbo'), 'kbo');
check('compound MLB/NHL', canonicalizeSport('MLB/NHL'), 'MLB/NHL');
check('placeholder Unknown', canonicalizeSport('Unknown'), 'Unknown');
check('generic Baseball', canonicalizeSport('Baseball'), 'Baseball');

// Empty / null / undefined → safe.
check('null', canonicalizeSport(null), null);
check('undefined', canonicalizeSport(undefined), undefined);
check('empty', canonicalizeSport(''), '');
check('whitespace', canonicalizeSport('   '), '');

// Map self-consistency: every canonical value re-canonicalizes to itself.
for (const v of Object.values(CANONICAL_SPORT_BY_KEY)) check(`idempotent ${v}`, canonicalizeSport(v), v);

// ── B. Case-insensitive adapter dispatch ──────────────────────────────
console.log('B. dispatch (services/sportsdata.normalizeSport)');
// tryStructured() dispatches on normalizeSport(bet.sport); proving it maps
// lower/mixed casings to the adapter key proves routing is case-insensitive.
check('mlb→MLB', normalizeSport('mlb'), 'MLB');
check('Mlb→MLB', normalizeSport('Mlb'), 'MLB');
check('nba→NBA', normalizeSport('nba'), 'NBA');
check('NhL→NHL', normalizeSport('NhL'), 'NHL');
check('canon MLB routes', normalizeSport(canonicalizeSport('mlb')), 'MLB');
// The casing-divergent sports are NOT dispatched — their casing cannot affect routing.
check('Soccer not dispatched', normalizeSport('Soccer'), null);
check('soccer not dispatched', normalizeSport('soccer'), null);
check('Tennis not dispatched', normalizeSport('Tennis'), null);

// ── C. Backfill idempotency ───────────────────────────────────────────
console.log('C. backfill idempotency (scripts/backfill-sport-casing.backfillOnce)');
const tmpBackfill = path.join(os.tmpdir(), `bettracker-sport-casing-backfill-${Date.now()}.db`);
const bdb = new Database(tmpBackfill);
try {
  bdb.exec('CREATE TABLE bets (id TEXT PRIMARY KEY, sport TEXT)');
  bdb.exec('CREATE TABLE grading_audit (id TEXT PRIMARY KEY, sport_in TEXT, sport_out TEXT)');
  const ib = bdb.prepare('INSERT INTO bets (id, sport) VALUES (?, ?)');
  // 3× soccer + 1× SOCCER (off-casing) + 2× canonical Soccer + MLB + mlb + KBO + compound + NULL.
  [['b1', 'soccer'], ['b2', 'soccer'], ['b3', 'soccer'], ['b4', 'SOCCER'],
   ['b5', 'Soccer'], ['b6', 'Soccer'], ['b7', 'MLB'], ['b8', 'mlb'],
   ['b9', 'KBO'], ['b10', 'MLB/NHL'], ['b11', null]].forEach(([id, s]) => ib.run(id, s));
  // sport_in AND sport_out both carry off-casing (the backfill converges both columns).
  const ia = bdb.prepare('INSERT INTO grading_audit (id, sport_in, sport_out) VALUES (?, ?, ?)');
  [['a1', 'soccer', 'SOCCER'], ['a2', 'soccer', 'SOCCER'], ['a3', 'Soccer', 'Soccer'],
   ['a4', 'soccer', 'soccer'], ['a5', 'TENNIS', 'TENNIS']].forEach(([id, si, so]) => ia.run(id, si, so));

  // Dry run — must report the off-casing values without mutating.
  console.log('  --- DRY RUN ---');
  const dry = backfillOnce(bdb, { apply: false, log: (m) => console.log('  ' + m) });
  ok('dry run finds divergent', dry.grandTotal > 0);
  const dryBets = dry.perTable.find((t) => t.table === 'bets');
  // bets off-casing rows: 3 soccer + 1 SOCCER + 1 mlb = 5 (Soccer/MLB/KBO/MLB-NHL/NULL untouched).
  check('dry bets row count', dryBets.diffs.reduce((s, d) => s + d.count, 0), 5);
  const beforeBets = bdb.prepare('SELECT COUNT(*) c FROM bets WHERE sport = ?').get('soccer').c;
  check('dry run did not mutate', beforeBets, 3);

  // First apply — normalizes (one transaction across bets.sport + sport_out + sport_in).
  console.log('  --- APPLY (1st) ---');
  const first = backfillOnce(bdb, { apply: true, log: (m) => console.log('  ' + m) });
  ok('first apply changed rows', first.grandTotal > 0);
  // 5 bets + 4 sport_out (2 SOCCER +1 soccer +1 TENNIS) + 4 sport_in (3 soccer +1 TENNIS).
  check('first apply total', first.grandTotal, 5 + 4 + 4);
  check('no lowercase soccer left', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='soccer'").get().c, 0);
  check('no UPPER SOCCER left', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='SOCCER'").get().c, 0);
  check('soccer merged into Soccer', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='Soccer'").get().c, 6);
  check('mlb→MLB', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='MLB'").get().c, 2);
  check('KBO untouched', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='KBO'").get().c, 1);
  check('compound untouched', bdb.prepare("SELECT COUNT(*) c FROM bets WHERE sport='MLB/NHL'").get().c, 1);
  // 2× SOCCER + 1× soccer normalized + 1× pre-existing Soccer (a3) = 4.
  check('audit sport_out SOCCER→Soccer', bdb.prepare("SELECT COUNT(*) c FROM grading_audit WHERE sport_out='Soccer'").get().c, 4);
  check('audit sport_out TENNIS→Tennis', bdb.prepare("SELECT COUNT(*) c FROM grading_audit WHERE sport_out='Tennis'").get().c, 1);
  // sport_in is converged too: 3× soccer + a3 pre-existing Soccer = 4; TENNIS→Tennis = 1.
  check('audit sport_in soccer→Soccer', bdb.prepare("SELECT COUNT(*) c FROM grading_audit WHERE sport_in='Soccer'").get().c, 4);
  check('audit sport_in lowercase gone', bdb.prepare("SELECT COUNT(*) c FROM grading_audit WHERE sport_in='soccer'").get().c, 0);
  check('audit sport_in TENNIS→Tennis', bdb.prepare("SELECT COUNT(*) c FROM grading_audit WHERE sport_in='Tennis'").get().c, 1);

  // Second apply — IDEMPOTENT, changes nothing.
  console.log('  --- APPLY (2nd, idempotency) ---');
  const second = backfillOnce(bdb, { apply: true, log: (m) => console.log('  ' + m) });
  check('second apply is idempotent (0 rows)', second.grandTotal, 0);
} finally {
  bdb.close();
  try { if (fs.existsSync(tmpBackfill)) fs.unlinkSync(tmpBackfill); } catch (_) {}
}

// ── D. Write sites ────────────────────────────────────────────────────
console.log('D. write sites (createBet, writeGradingAudit)');
const database = require('../services/database');
const grading = require('../services/grading');
database.db.pragma('foreign_keys = OFF');

// createBet — off-casing sport in → canonical stored.
const created = database.createBet({
  capper_id: 'test-capper', sport: 'soccer', description: 'Arsenal ML test-sport-casing',
  bet_type: 'straight', odds: '-110', units: 1, source: 'test',
});
check('createBet canonicalizes sport', created.sport, 'Soccer');

const createdUpper = database.createBet({
  capper_id: 'test-capper', sport: 'SOCCER', description: 'Chelsea ML test-sport-casing',
  bet_type: 'straight', odds: '-120', units: 1, source: 'test',
});
check('createBet UPPER→Title', createdUpper.sport, 'Soccer');

const createdNull = database.createBet({
  capper_id: 'test-capper', description: 'no-sport test-sport-casing',
  bet_type: 'straight', odds: '-110', units: 1, source: 'test',
});
check('createBet null sport → Unknown', createdNull.sport, 'Unknown');

// writeGradingAudit — sport_out fork ("SOCCER") persists canonical "Soccer".
grading._internal.writeGradingAudit({
  bet_id: 'audit-test-1', sport_in: 'soccer', sport_out: 'SOCCER', final_status: 'WIN',
});
const auditRow = database.db.prepare(
  'SELECT sport_in, sport_out FROM grading_audit WHERE bet_id = ?'
).get('audit-test-1');
check('audit sport_out canonical', auditRow.sport_out, 'Soccer');
check('audit sport_in canonical', auditRow.sport_in, 'Soccer');

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\nsport-casing: ${pass} passed, ${fail} failed`);
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
process.exit(fail === 0 ? 0 : 1);
