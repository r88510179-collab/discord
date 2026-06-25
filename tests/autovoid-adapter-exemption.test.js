// ═══════════════════════════════════════════════════════════
// Build 1d — exempt deterministic-adapter sports from the no-data auto-void.
//
// The bug (data-integrity, sport-wide): shouldAutoVoidNoData auto-voids any bet
// with 5+ consecutive no-data PENDINGs over 12h+. It was firing on sports that
// HAVE a deterministic adapter (Soccer/NBA/MLB/NHL/World Cup), wrongly voiding
// live bets — "search data unavailable" is exactly the case those adapters exist
// to settle, so the no-data void must never fire for an adapter-covered sport.
//
// Two units under test:
//   1. hasDeterministicAdapter(sport)  — the pure predicate (services/sportsdata).
//      UNION of: structured ADAPTERS (MLB/NBA/NHL via normalizeSport), soccer
//      (Soccer/World Cup/FIFA via isSoccerSport), and the ESPN grader allowlist
//      (ESPN_ENDPOINTS keys → adds NFL). Casing-insensitive; unknown → false.
//   2. shouldAutoVoidNoData(bet)       — the void decision (services/grading.js).
//      An adapter-covered sport returns null (NO void); a sourceless sport with the
//      IDENTICAL void-criteria fixture still returns void-info. The shared fixture
//      proves the void criteria ARE met, so the adapter sports' null is caused by the
//      Build-1d exemption — not by a fixture that fails the 5-PENDING/12h threshold.
//
// Run:  node tests/autovoid-adapter-exemption.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// No real network — requiring grading.js transitively pulls ai.js. The functions
// under test never touch the wire, but reject fetch so any stray path fails fast.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB. Set DB_PATH BEFORE requiring database/grading so the production DB
// is never opened. Random suffix (not just Date.now()) so back-to-back / parallel
// runs can never collide on the same file and leak grading_audit rows between runs.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-autovoid-exemption-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`);
delete process.env.GRADING_STATE_MACHINE_ENABLED;

const sportsdata = require('../services/sportsdata');
const { hasDeterministicAdapter } = sportsdata;
const grading = require('../services/grading');
const database = require('../services/database');
const { shouldAutoVoidNoData } = grading;

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

// ── 1. hasDeterministicAdapter — coverage predicate ─────────────────────────
console.log('1. hasDeterministicAdapter — adapter-covered sports true, sourceless false');

// TRUE: structured adapters (MLB/NBA/NHL), soccer, ESPN-only (NFL), and the
// casing / alias / substring spellings the grader actually stores.
const COVERED = [
  'MLB', 'NBA', 'NHL', 'NFL',                          // canonical (structured + ESPN)
  'Soccer', 'World Cup', 'FIFA World Cup', 'FIFA',     // soccer adapter (isSoccerSport)
  'mlb', 'nba', 'nhl', 'nfl',                          // lowercase
  'soccer', 'world cup', 'fifa world cup',             // lowercase soccer
  'Baseball', 'Basketball', 'Hockey',                  // normalizeSport aliases → MLB/NBA/NHL
  'NBA Finals',                                        // substring match (includes 'NBA')
];
for (const s of COVERED) ok(`covered → true: "${s}"`, hasDeterministicAdapter(s) === true);

// FALSE: sourceless sports (no adapter, no ESPN endpoint) — these still auto-void.
const SOURCELESS = [
  'Boxing', 'NCAAW', 'NCAAB', 'Tennis', 'UFC', 'MMA', 'Golf', 'Cricket', 'Darts',
  '', '   ', 'asdf', 'qwerty',
];
for (const s of SOURCELESS) ok(`sourceless → false: "${s}"`, hasDeterministicAdapter(s) === false);

// Nullish / non-string inputs never throw and resolve false.
ok('null → false', hasDeterministicAdapter(null) === false);
ok('undefined → false', hasDeterministicAdapter(undefined) === false);
ok('0 → false', hasDeterministicAdapter(0) === false);

// Documented edge: the ESPN-only sports (NFL) are matched on espn.js's EXACT
// uppercase gate (tryGradeViaESPN does ESPN_ENDPOINTS[sport.toUpperCase()]), so a
// decorated "NFL Week 1" is NOT covered — exactly as the real ESPN grader behaves.
// (Structured sports keep normalizeSport's substring match, hence "NBA Finals" is.)
ok('ESPN exact gate: "NFL Week 1" → false (mirrors espn.js)', hasDeterministicAdapter('NFL Week 1') === false);

// ── 2. shouldAutoVoidNoData — adapter sports exempt, sourceless still void ───
console.log('2. shouldAutoVoidNoData — adapter sports NO void; sourceless still void-info (shared fixture)');

// Seed 5 PENDING + no-data audit rows for a bet_id so the void CRITERIA are met.
function seedNoDataAudit(betId, n = 5) {
  const stmt = database.db.prepare(
    `INSERT INTO grading_audit (id, bet_id, attempt_num, timestamp, final_status, final_evidence)
     VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < n; i++) {
    stmt.run(crypto.randomBytes(8).toString('hex'), betId, i + 1, Date.now() - (n - i) * 1000, 'PENDING', 'no search results');
  }
}

// IDENTICAL void-criteria fixture for every sport: 13h old, 5 attempts, 5 no-data
// PENDINGs. Only bet.sport differs — so the result difference is purely the exemption.
const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
function fixture(sport, idTag) {
  const id = `autovoid-${idTag}`;
  seedNoDataAudit(id);
  return { id, sport, created_at: thirteenHoursAgo, grading_attempts: 5 };
}

// Adapter-covered sports → NO void (null), despite meeting every void criterion.
ok('Soccer (adapter) meeting void criteria → NO void (null)', shouldAutoVoidNoData(fixture('Soccer', 'soccer')) === null);
ok('NBA (adapter) meeting void criteria → NO void (null)', shouldAutoVoidNoData(fixture('NBA', 'nba')) === null);
ok('World Cup (soccer adapter) meeting void criteria → NO void (null)', shouldAutoVoidNoData(fixture('World Cup', 'wc')) === null);
ok('MLB (adapter) meeting void criteria → NO void (null)', shouldAutoVoidNoData(fixture('MLB', 'mlb')) === null);
ok('NFL (ESPN adapter) meeting void criteria → NO void (null)', shouldAutoVoidNoData(fixture('NFL', 'nfl')) === null);

// Sourceless sport, SAME fixture → still returns void-info (proves the criteria are
// met; the adapter sports above are exempted by Build 1d, not by a failing fixture).
const boxingVoid = shouldAutoVoidNoData(fixture('Boxing', 'boxing'));
ok('Boxing (sourceless) meeting void criteria → void-info object', boxingVoid !== null && typeof boxingVoid === 'object');
ok('Boxing void-info: attempts = 5', boxingVoid && boxingVoid.attempts === 5);
ok('Boxing void-info: hours ~13', boxingVoid && boxingVoid.hours >= 12 && boxingVoid.hours <= 14);

const tennisVoid = shouldAutoVoidNoData(fixture('Tennis', 'tennis'));
ok('Tennis (sourceless) meeting void criteria → void-info object', tennisVoid !== null && typeof tennisVoid === 'object');
ok('Tennis void-info: attempts = 5', tennisVoid && tennisVoid.attempts === 5);
ok('Tennis void-info: hours ~13', tennisVoid && tennisVoid.hours >= 12 && tennisVoid.hours <= 14);

// Parlay-leg audit branch: parlays write audit rows at `${betId}-leg%`, not the
// parent bet_id, so shouldAutoVoidNoData's query is `bet_id = ? OR bet_id LIKE ?`.
// Seed a SOURCELESS bet's 5 no-data PENDINGs ONLY at the `-leg%` suffixes (parent has
// zero rows) — it must still return void-info, exercising the LIKE branch.
const parlayId = 'autovoid-parlay';
for (let i = 1; i <= 5; i++) {
  database.db.prepare(
    `INSERT INTO grading_audit (id, bet_id, attempt_num, timestamp, final_status, final_evidence)
     VALUES (?,?,?,?,?,?)`,
  ).run(crypto.randomBytes(8).toString('hex'), `${parlayId}-leg${i}`, i, Date.now() - (6 - i) * 1000, 'PENDING', 'no search results');
}
const parlayVoid = shouldAutoVoidNoData({ id: parlayId, sport: 'Boxing', created_at: thirteenHoursAgo, grading_attempts: 5 });
ok('Boxing parlay (audit at -leg%, parent empty) → void-info (LIKE branch)', parlayVoid !== null && parlayVoid.attempts === 5);

// Age-gate control, ORTHOGONAL to the exemption: a SOURCELESS (non-exempt) bet that
// is too young returns null via the 12h age gate — NOT via hasDeterministicAdapter —
// so it proves the age threshold fires independently of Build 1d. (No audit rows
// needed: the age check returns before the query.)
const youngBoxing = { id: 'autovoid-young', sport: 'Boxing', created_at: new Date().toISOString(), grading_attempts: 5 };
ok('Boxing too-young (sourceless) → null via age gate, not exemption', shouldAutoVoidNoData(youngBoxing) === null);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nautovoid-adapter-exemption: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
