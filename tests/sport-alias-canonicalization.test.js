// ═══════════════════════════════════════════════════════════
// Sport-alias canonicalization before the SUPPORTED_SPORTS gate (audit B7).
//
// Background: services/grading.js auto-voids any bet whose sport is not an
// EXACT-STRING member of SUPPORTED_SPORTS. Gradeable sports under a
// non-canonical alias ("World Cup", "Hockey", "ATP") therefore die silently —
// createBet defaults review_status='confirmed', so no human ever sees them.
// canonicalizeSportForGrading() maps an unambiguous alias to its supported
// family token immediately before that gate.
//
// Covers:
//   A. Unit — each alias → its canonical supported token (case/space tolerant).
//   B. Gate composition — isSupportedSport(canonicalize(alias)) flips false→true
//      (the exact gate condition), while the RAW label is still rejected.
//   C. No false rescue — genuinely unsupported sports + the deliberately
//      EXCLUDED foreign leagues (KHL) stay unsupported; supported tokens and
//      unrelated labels pass through UNCHANGED (collision guard).
//   D. Compound rule — all-parts-same → rescue; genuinely mixed → untouched.
//   E. Invariant — every alias value is a real SUPPORTED_SPORTS member.
//   F. Null / empty safety.
//   G. Integration — gradePropWithAI does NOT auto-void a World Cup bet, STILL
//      auto-voids a genuine-garbage sport (with GRADE_AUTOVOID_UNSCOPED drop), and
//      diverts a real-but-unmodeled sport (Cricket) to manual review rather than
//      voiding it (see tests/unmodeled-sport-manual-review.test.js).
//
// Each behaviour-change assertion fails on pre-fix code (the helper does not
// exist, and pre-fix the World Cup bet is auto-voided).
//
// Run:  node tests/sport-alias-canonicalization.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — required only because requiring grading.js pulls in ai.js,
// and so the integration grader path fails fast instead of hitting the wire.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB for the integration write-path checks. Set BEFORE requiring
// database/grading so the real production DB is never opened.
const dbFile = path.join(os.tmpdir(), `bettracker-sport-alias-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const {
  canonicalizeSportForGrading,
  SPORT_ALIAS_TO_CANONICAL,
  isSupportedSport,
  SUPPORTED_SPORTS,
  gradePropWithAI,
} = grading;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// ── A. Unit: alias → canonical supported token ─────────────────────────
console.log('A. canonicalizeSportForGrading() alias mapping');

check('World Cup → SOCCER', canonicalizeSportForGrading('World Cup'), 'SOCCER');
check('FIFA World Cup → SOCCER', canonicalizeSportForGrading('FIFA World Cup'), 'SOCCER');
check('UEFA → SOCCER', canonicalizeSportForGrading('UEFA'), 'SOCCER');
check('Copa America → SOCCER', canonicalizeSportForGrading('Copa America'), 'SOCCER');
check('International Friendly → SOCCER', canonicalizeSportForGrading('International Friendly'), 'SOCCER');
check('Hockey → NHL', canonicalizeSportForGrading('Hockey'), 'NHL');
check('Ice Hockey → NHL', canonicalizeSportForGrading('Ice Hockey'), 'NHL');
check('IIHF → NHL', canonicalizeSportForGrading('IIHF'), 'NHL');
check('ATP → TENNIS', canonicalizeSportForGrading('ATP'), 'TENNIS');
check('WTA → TENNIS', canonicalizeSportForGrading('WTA'), 'TENNIS');
check('PGA → GOLF', canonicalizeSportForGrading('PGA'), 'GOLF');

// Case-insensitive + whitespace-tolerant (the same value from any casing).
check('lower world cup → SOCCER', canonicalizeSportForGrading('world cup'), 'SOCCER');
check('UPPER WORLD CUP → SOCCER', canonicalizeSportForGrading('WORLD CUP'), 'SOCCER');
check('mixed WoRlD cUp → SOCCER', canonicalizeSportForGrading('WoRlD cUp'), 'SOCCER');
check('padded "  atp  " → TENNIS', canonicalizeSportForGrading('  atp  '), 'TENNIS');

// ── B. Gate composition — the exact auto-void condition ────────────────
console.log('B. gate composition: isSupportedSport(canonicalize(alias))');
for (const alias of ['World Cup', 'FIFA World Cup', 'Hockey', 'Ice Hockey', 'IIHF', 'ATP', 'WTA', 'PGA', 'UEFA', 'Copa America']) {
  // PRE-FIX the RAW label is rejected by the gate (silently auto-voided)…
  ok(`raw "${alias}" is NOT a supported token (pre-fix void)`, isSupportedSport(alias) === false);
  // …POST-FIX the canonicalized label passes the gate.
  ok(`"${alias}" passes the gate after canonicalization`, isSupportedSport(canonicalizeSportForGrading(alias)) === true);
}

// ── C. No false rescue + collision guard ───────────────────────────────
console.log('C. no false rescue / unchanged passthrough');

// Genuinely unsupported sports stay unchanged AND unsupported.
for (const u of ['Cricket', 'Darts', 'Pickleball', 'Rugby', 'Snooker']) {
  check(`unsupported ${u} unchanged`, canonicalizeSportForGrading(u), u);
  ok(`unsupported ${u} still rejected by gate`, isSupportedSport(canonicalizeSportForGrading(u)) === false);
}

// Foreign domestic leagues the codebase deliberately EXCLUDES from the table
// (treated as unmodeled elsewhere) are NOT rescued.
for (const u of ['KHL', 'KBO', 'NPB']) {
  check(`excluded league ${u} unchanged`, canonicalizeSportForGrading(u), u);
  ok(`excluded league ${u} still unsupported`, isSupportedSport(canonicalizeSportForGrading(u)) === false);
}

// Bare fixture-type labels are NOT a sport — friendlies exist in basketball
// (FIBA), rugby and cricket, so "Friendly"/"Friendlies" must NOT force-map to
// SOCCER. The QUALIFIED "International Friendly" form (tested in A) is kept.
for (const u of ['Friendly', 'Friendlies', 'friendly']) {
  check(`bare ${u} NOT rescued`, canonicalizeSportForGrading(u), u);
  ok(`bare ${u} still rejected by gate`, isSupportedSport(canonicalizeSportForGrading(u)) === false);
}

// Already-supported tokens pass through UNCHANGED (no needless mutation, any casing).
for (const s of ['NBA', 'MLB', 'NHL', 'NFL', 'TENNIS', 'GOLF', 'SOCCER', 'MMA', 'UFC', 'BOXING', 'NCAAF']) {
  check(`supported ${s} unchanged`, canonicalizeSportForGrading(s), s);
}
check('supported lower "soccer" trimmed-only', canonicalizeSportForGrading('soccer'), 'soccer');
check('supported "  nba  " trimmed', canonicalizeSportForGrading('  nba  '), 'nba');

// ── D. Compound labels ─────────────────────────────────────────────────
console.log('D. compound labels (split on / & ,)');
// All parts agree → rescue to the shared canonical.
check('ATP/WTA → TENNIS', canonicalizeSportForGrading('ATP/WTA'), 'TENNIS');
check('Hockey/Ice Hockey → NHL', canonicalizeSportForGrading('Hockey/Ice Hockey'), 'NHL');
check('World Cup / Copa America → SOCCER', canonicalizeSportForGrading('World Cup / Copa America'), 'SOCCER');
check('World Cup + supported Soccer → SOCCER', canonicalizeSportForGrading('World Cup, Soccer'), 'SOCCER');
// Genuinely mixed → untouched (NOT force-canonicalized to one sport).
check('MLB/NBA untouched', canonicalizeSportForGrading('MLB/NBA'), 'MLB/NBA');
ok('MLB/NBA stays unsupported', isSupportedSport(canonicalizeSportForGrading('MLB/NBA')) === false);
check('MMA/Boxing untouched', canonicalizeSportForGrading('MMA/Boxing'), 'MMA/Boxing');
ok('MMA/Boxing stays unsupported', isSupportedSport(canonicalizeSportForGrading('MMA/Boxing')) === false);
// A modeled part + an unmodeled foreign league → untouched (no partial rescue).
check('MLB/KHL untouched', canonicalizeSportForGrading('MLB/KHL'), 'MLB/KHL');
// Mixed compounds where an ALIAS part disagrees — exercises the alias branch of
// _canonicalSportPart inside a mixed compound (must NOT force-canonicalize).
check('ATP/NBA untouched (alias + different supported)', canonicalizeSportForGrading('ATP/NBA'), 'ATP/NBA');
ok('ATP/NBA stays unsupported', isSupportedSport(canonicalizeSportForGrading('ATP/NBA')) === false);
check('ATP/Cricket untouched (alias + unsupported)', canonicalizeSportForGrading('ATP/Cricket'), 'ATP/Cricket');
ok('ATP/Cricket stays unsupported (no gradeability expansion)', isSupportedSport(canonicalizeSportForGrading('ATP/Cricket')) === false);
check('Hockey/ATP untouched (two different-sport aliases)', canonicalizeSportForGrading('Hockey/ATP'), 'Hockey/ATP');
// Bare "Friendly" is no longer a soccer signal — a World Cup + Friendly compound
// therefore does NOT rescue (the parts disagree: SOCCER vs unknown).
check('World Cup & Friendly NOT rescued', canonicalizeSportForGrading('World Cup & Friendly'), 'World Cup & Friendly');
// Dangling separator leaving ONE real part → still rescued (>= 1 branch);
// an unsupported single real part with a separator stays untouched.
check('trailing-separator "ATP/" → TENNIS', canonicalizeSportForGrading('ATP/'), 'TENNIS');
check('leading-separator "/World Cup" → SOCCER', canonicalizeSportForGrading('/World Cup'), 'SOCCER');
check('trailing-separator "Cricket/" NOT rescued', canonicalizeSportForGrading('Cricket/'), 'Cricket/');
check('separators only "/" unchanged', canonicalizeSportForGrading('/'), '/');

// ── E. Invariant: every alias value is a real supported token ──────────
console.log('E. table invariant');
for (const [alias, canon] of Object.entries(SPORT_ALIAS_TO_CANONICAL)) {
  ok(`value "${canon}" (for "${alias}") ∈ SUPPORTED_SPORTS`, SUPPORTED_SPORTS.has(canon));
  // And an alias key must never already be a supported token (would be a no-op / confusing).
  ok(`alias key "${alias}" is not itself supported`, !SUPPORTED_SPORTS.has(alias));
  // The lookup keys on trimmed.toUpperCase(), so a mis-cased/padded table key
  // would be a silently-dead entry. Lock the normalization contract.
  ok(`alias key "${alias}" is normalized (UPPER+trim)`, alias === alias.trim().toUpperCase());
}

// ── F. Null / empty safety ─────────────────────────────────────────────
console.log('F. null / empty safety');
check('null', canonicalizeSportForGrading(null), null);
check('undefined', canonicalizeSportForGrading(undefined), undefined);
check('empty', canonicalizeSportForGrading(''), '');
check('whitespace', canonicalizeSportForGrading('   '), '');

// ── G. Integration: gradePropWithAI auto-void behaviour ────────────────
console.log('G. integration — gradePropWithAI does not pre-void aliased sports');
const database = require('../services/database');
database.db.pragma('foreign_keys = OFF');

async function gradeRow(betRow) {
  // Downstream grading runs offline (fetch rejected) and may throw/return
  // PENDING; we only care whether the SUPPORTED_SPORTS gate fired (it is the
  // sole writer of review_status='auto_void_unscoped_bet').
  try { await gradePropWithAI({ ...betRow }); } catch (_) { /* offline downstream */ }
  return database.db.prepare('SELECT result, review_status FROM bets WHERE id = ?').get(betRow.id);
}

(async () => {
  // World Cup pick (no team that reclassifySport could catch) — must NOT be voided by the gate.
  const wc = database.createBet({
    capper_id: 'test-capper', sport: 'World Cup', description: 'Brazil to lift the trophy test-b7',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  const wcAfter = await gradeRow(wc);
  ok('World Cup NOT auto-voided by gate', wcAfter.review_status !== 'auto_void_unscoped_bet');
  ok('World Cup result not voided by gate', wcAfter.result !== 'void');

  // ATP pick — description carries no team/keyword reclassifySport could catch,
  // so this exercises the B7 alias path (ATP → TENNIS), not the reclassifier.
  const atp = database.createBet({
    capper_id: 'test-capper', sport: 'ATP', description: 'Alcaraz to win the title test-b7',
    bet_type: 'straight', odds: '-130', units: 1, source: 'test',
  });
  const atpAfter = await gradeRow(atp);
  ok('ATP NOT auto-voided by gate', atpAfter.review_status !== 'auto_void_unscoped_bet');

  // Genuine-garbage sport (a non-committal placeholder, no real league) — the gate
  // MUST still auto-void it. The manual-review divert below spares only REAL
  // unmodeled sports; null/Unknown/garbage are unchanged (declaresAnyUnmodeledLeague
  // returns false for placeholders). Description names no nation/team so the
  // national-team rescue does not fire and it reaches the gate as Unknown.
  const garbage = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown', description: 'generic promo wager no teams here test-b7',
    bet_type: 'straight', odds: '-150', units: 1, source: 'test',
  });
  const garbageAfter = await gradeRow(garbage);
  ok('Unknown garbage IS auto-voided (gate still works)', garbageAfter.review_status === 'auto_void_unscoped_bet');
  ok('Unknown garbage result void', garbageAfter.result === 'void');

  // A genuinely-unsupported REAL sport (Cricket) is NO LONGER auto-voided — like
  // KBO it is a real competition we can't grade, so the gate diverts it to manual
  // review instead of recording a silent (often false) void (see
  // tests/unmodeled-sport-manual-review.test.js). canonicalize still does not
  // rescue it (sections A/B), so it reaches the gate unsupported.
  const cricket = database.createBet({
    capper_id: 'test-capper', sport: 'Cricket', description: 'India to win the test match test-b7',
    bet_type: 'straight', odds: '-150', units: 1, source: 'test',
  });
  const cricketAfter = await gradeRow(cricket);
  ok('Cricket diverts to manual review (real unmodeled sport, not voided)', cricketAfter.review_status === 'manual_review_unmodeled_sport');
  ok('Cricket NOT voided (result stays pending)', cricketAfter.result === 'pending');

  // ── G2. Traceability of the unscoped void (audit B7 follow-up) ─────────
  // The terminal auto-void used to return its AUTO_VOIDED sentinel with NO
  // pipeline_events row, so every unsupported-sport void left an empty trail
  // (the empty trail that made the "World Cup keeps voiding" report look like a
  // separate sweep). It now records a DROP. FAILS on pre-fix code (no recordDrop):
  // the genuine-garbage void MUST leave exactly such a row AND stamp
  // bets.drop_reason; the World Cup pick — which grades, never voids — must NOT.
  const unscopedDropCount = (id) => database.db.prepare(
    "SELECT COUNT(*) AS c FROM pipeline_events WHERE bet_id = ? AND event_type = 'DROP' AND drop_reason = 'GRADE_AUTOVOID_UNSCOPED'",
  ).get(id).c;
  ok('garbage void records a GRADE_AUTOVOID_UNSCOPED drop (no longer silent)', unscopedDropCount(garbage.id) >= 1);
  ok('garbage void stamps bets.drop_reason', (database.db.prepare('SELECT drop_reason FROM bets WHERE id = ?').get(garbage.id) || {}).drop_reason === 'GRADE_AUTOVOID_UNSCOPED');
  ok('World Cup (graded, not voided) has NO unscoped-void drop', unscopedDropCount(wc.id) === 0);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\nsport-alias-canonicalization: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
