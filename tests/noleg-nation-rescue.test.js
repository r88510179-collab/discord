// ═══════════════════════════════════════════════════════════
// Grade-time national-team rescue for NO-LEG Unknown bets (Codex blocker).
//
// Background: #100 adopts a soccer national team's sport ONLY inside
// validateLegSportConsistency(), which runs for MULTI-LEG picks
// (pick.legs && pick.legs.length > 0). A single-pick / no-leg row that stores
// sport='Unknown' never enters that function, so a bare World-Cup nation pick
// reaches gradePropWithAI still Unknown and auto-voids at the SUPPORTED_SPORTS
// gate. Browser audit (2026-06-16): "GNP Iraq team total over .5" → sport=
// Unknown → auto_void, while the SAME batch's leg-bearing "GNP Algeria team
// total under .5" → Soccer. #110's canonicalizeSportForGrading maps non-
// canonical sport LABELS ("World Cup") but not DESCRIPTIONS, so an Unknown-LABEL
// nation pick is still missed.
//
// rescueNoLegNationalTeamSport(sport, description) runs immediately after
// canonicalizeSportForGrading and before the gate. It REUSES #100's whole-word
// matcher (descNamesNationalTeam / NATIONAL_TEAM_RE, `\b…\b`), only rescues a
// placeholder sport, and defers on a strong non-soccer signal (inferLegSport).
//
// Covers:
//   A. Unit — placeholder + whole-word nation → 'Soccer' (incl. the Iraq
//      browser-audit regression; null/N/A/TBD placeholders).
//   B. No false rescue — no nation named → sport UNCHANGED (still voids).
//   C. Known sport NEVER overridden — MLB/NHL/NBA/Tennis + a nation word stay.
//   D. Whole-word guard — a nation substring inside a surname/word/longer name
//      does NOT trigger (mirror #100's leak guard).
//   E. Strong non-soccer signal defers — a prop-action keyword ("double double"
//      → NBA, "total bases" → MLB) alongside a nation → stays Unknown.
//   F. Gate composition — isSupportedSport(rescue(Unknown, nation)) flips
//      false→true (the exact auto-void condition), no-nation stays false.
//   G. List regression — 'iraq' is now whole-word matched by descNamesNationalTeam
//      (it was absent from SOCCER_NATIONAL_TEAMS), and 'Frances' still is not.
//   H. Composition with #110 — a "World Cup"-LABELED pick is already SOCCER at
//      the rescue point, so the rescue no-ops (does not double-fire/conflict).
//   I. Integration — gradePropWithAI does NOT auto-void a no-leg Unknown nation
//      pick, but DOES still auto-void a no-nation Unknown pick (gate intact).
//
// Each behaviour-change assertion fails on pre-fix code: the helper does not
// exist (unit/gate), 'iraq' is absent from the list (G), and pre-fix the Iraq
// pick is auto-voided by gradePropWithAI (I).
//
// Run:  node tests/noleg-nation-rescue.test.js
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
const dbFile = path.join(os.tmpdir(), `bettracker-noleg-nation-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const {
  rescueNoLegNationalTeamSport: rescue,
  canonicalizeSportForGrading,
  isSupportedSport,
  gradePropWithAI,
} = grading;
const { descNamesNationalTeam } = require('../services/ai');

// Fail FAST and LOUD on pre-fix code: pre-fix both exports are undefined, so
// rather than a raw TypeError mid-suite, assert their presence up front with an
// explicit message. (The suite still exits non-zero on pre-fix — a valid red.)
assert.strictEqual(typeof rescue, 'function', 'rescueNoLegNationalTeamSport must be exported from services/grading.js');
assert.strictEqual(typeof descNamesNationalTeam, 'function', 'descNamesNationalTeam must be exported from services/ai.js');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// ── A. Unit: placeholder + whole-word nation → 'Soccer' ─────────────────
console.log('A. rescue(): placeholder + nation → Soccer');
// Direct browser-audit regression — Iraq was a no-leg Unknown row that voided.
check('Unknown "Iraq team total over .5" → Soccer', rescue('Unknown', 'Iraq team total over .5'), 'Soccer');
check('Unknown "Spain draw" → Soccer', rescue('Unknown', 'Spain draw'), 'Soccer');
check('Unknown "Iran/New Zealand draw" → Soccer', rescue('Unknown', 'Iran/New Zealand draw'), 'Soccer');
check('Unknown "Belgium ML" → Soccer', rescue('Unknown', 'Belgium ML'), 'Soccer');
check('Unknown "Netherland / Japan under 2.5" → Soccer', rescue('Unknown', 'Netherland / Japan under 2.5'), 'Soccer');
// Every placeholder form (null / N/A / TBD / empty / whitespace) is rescuable.
check('null + "Spain draw" → Soccer', rescue(null, 'Spain draw'), 'Soccer');
check('undefined + "Portugal ML" → Soccer', rescue(undefined, 'Portugal ML'), 'Soccer');
check('"N/A" + "Brazil to lift the trophy" → Soccer', rescue('N/A', 'Brazil to lift the trophy'), 'Soccer');
check('"TBD" + "Egypt clean sheet" → Soccer (inferred SOCCER still rescues)', rescue('TBD', 'Egypt clean sheet'), 'Soccer');
check('"" + "Morocco draw" → Soccer', rescue('', 'Morocco draw'), 'Soccer');
check('"   " + "Qatar over 1.5" → Soccer', rescue('   ', 'Qatar over 1.5'), 'Soccer');

// ── B. No false rescue — no nation named → unchanged ────────────────────
console.log('B. no nation → unchanged (still voids)');
check('Unknown no-nation chatter unchanged', rescue('Unknown', 'random qwerty chatter here'), 'Unknown');
check('Unknown empty description unchanged', rescue('Unknown', ''), 'Unknown');
check('Unknown null description unchanged', rescue('Unknown', null), 'Unknown');
ok('no-nation Unknown stays unsupported (gate still voids)', isSupportedSport(rescue('Unknown', 'random qwerty chatter here')) === false);

// ── C. Known sport is NEVER overridden ──────────────────────────────────
console.log('C. known sport + nation word → unchanged');
check('MLB + "Ohtani 2+ hits vs Japan" stays MLB', rescue('MLB', 'Ohtani 2+ hits vs Japan'), 'MLB');
check('NHL + "Canada draw" stays NHL', rescue('NHL', 'Canada draw'), 'NHL');
check('NBA + "Spain over 220.5" stays NBA', rescue('NBA', 'Spain over 220.5'), 'NBA');
check('Tennis + "France in straight sets" stays Tennis', rescue('Tennis', 'France in straight sets'), 'Tennis');
check('Soccer + "Brazil ML" stays Soccer (already known)', rescue('Soccer', 'Brazil ML'), 'Soccer');

// ── D. Whole-word guard (mirror #100's substring-leak guard) ────────────
console.log('D. whole-word: nation substring inside a word does NOT trigger');
check('Unknown "Frances Tiafoe to win" unchanged (france ⊄ Frances)', rescue('Unknown', 'Frances Tiafoe to win'), 'Unknown');
check('Unknown "japanese pitcher strikeouts" unchanged (japan ⊄ japanese)', rescue('Unknown', 'japanese pitcher strikeouts'), 'Unknown');
check('Unknown "Australian Open R1 winner" unchanged (australia ⊄ australian)', rescue('Unknown', 'Australian Open R1 winner'), 'Unknown');
check('Unknown "Prince of Wales trophy" — wales IS whole-word here', rescue('Unknown', 'Prince of Wales trophy'), 'Soccer'); // accepted residual (#100): whole-word "wales" matches; recoverable mislabel, never a drop
check('Unknown "miranda over 1.5" unchanged (iran ⊄ miranda)', rescue('Unknown', 'miranda over 1.5'), 'Unknown');

// ── E. Strong non-soccer signal defers (conservative) ───────────────────
console.log('E. nation + strong non-soccer prop-action keyword → defer');
check('Unknown "USA double double" stays Unknown (NBA signal)', rescue('Unknown', 'USA double double'), 'Unknown');
check('Unknown "Japan total bases over 3.5" stays Unknown (MLB signal)', rescue('Unknown', 'Japan total bases over 3.5'), 'Unknown');
ok('deferred "USA double double" stays unsupported (voids as before)', isSupportedSport(rescue('Unknown', 'USA double double')) === false);

// ── F. Gate composition — the exact auto-void condition ─────────────────
console.log('F. gate composition: isSupportedSport(rescue(Unknown, nation))');
for (const desc of ['Iraq team total over .5', 'Spain draw', 'Iran/New Zealand draw', 'Belgium ML']) {
  // The gate rejects a bare Unknown row (the void condition the rescue lifts).
  // This is a static property of isSupportedSport, NOT the behavior-change check;
  // the discriminating assertion is the next line.
  ok(`gate rejects bare Unknown for "${desc}"`, isSupportedSport('Unknown') === false);
  // DISCRIMINATING (fails pre-fix): the rescued sport passes the gate.
  ok(`"${desc}" passes the gate after rescue`, isSupportedSport(rescue('Unknown', desc)) === true);
}

// ── G. List regression — 'iraq' now matched, 'Frances' still not ────────
console.log('G. SOCCER_NATIONAL_TEAMS list regression (iraq added)');
ok("descNamesNationalTeam('Iraq team total over .5') === true (iraq added to list)", descNamesNationalTeam('Iraq team total over .5') === true);
ok("descNamesNationalTeam('iraqi descent') === false (whole-word, no trailing boundary)", descNamesNationalTeam('iraqi descent') === false);
ok("descNamesNationalTeam('Frances Tiafoe') === false (no substring leak)", descNamesNationalTeam('Frances Tiafoe') === false);

// ── H. Composition with #110 (canonicalizeSportForGrading) ──────────────
console.log('H. composes with #110 — World Cup label already SOCCER → no-op');
// A "World Cup"-LABELED nation pick is canonicalized to SOCCER FIRST, so by the
// rescue point it is no longer a placeholder → the rescue must not double-fire.
const wcCanon = canonicalizeSportForGrading('World Cup');         // → 'SOCCER'
check('canonicalize("World Cup") → SOCCER', wcCanon, 'SOCCER');
check('rescue(SOCCER, "Brazil ML") → SOCCER (already known, no-op)', rescue(wcCanon, 'Brazil ML'), 'SOCCER');
check('canonicalize("Unknown") → Unknown (rescue then handles it)', canonicalizeSportForGrading('Unknown'), 'Unknown');

// ── I. Integration — gradePropWithAI auto-void behaviour ────────────────
console.log('I. integration — gradePropWithAI does not pre-void no-leg nation picks');
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
  // No-leg Unknown nation pick — the browser-audit regression. Must NOT be
  // voided by the gate now. FAILS on pre-fix code (pre-fix → auto_void_unscoped_bet).
  const iraq = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown', description: 'Iraq team total over .5 test-noleg',
    bet_type: 'straight', odds: '-110', units: 1, source: 'test',
  });
  const iraqAfter = await gradeRow(iraq);
  ok('Iraq no-leg Unknown NOT auto-voided by gate', iraqAfter.review_status !== 'auto_void_unscoped_bet');
  ok('Iraq result not voided by gate', iraqAfter.result !== 'void');

  // A second no-leg Unknown nation pick (different nation / market).
  const spain = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown', description: 'Spain draw test-noleg',
    bet_type: 'straight', odds: '+200', units: 1, source: 'test',
  });
  const spainAfter = await gradeRow(spain);
  ok('Spain no-leg Unknown NOT auto-voided by gate', spainAfter.review_status !== 'auto_void_unscoped_bet');

  // No-nation Unknown pick — the gate MUST still auto-void it (no false rescue,
  // gate intact).
  const chatter = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown', description: 'random qwerty chatter no teams here test-noleg',
    bet_type: 'straight', odds: '-150', units: 1, source: 'test',
  });
  const chatterAfter = await gradeRow(chatter);
  ok('no-nation Unknown IS auto-voided (gate still works)', chatterAfter.review_status === 'auto_void_unscoped_bet');
  ok('no-nation Unknown result void', chatterAfter.result === 'void');

  // Strong non-soccer signal + nation under Unknown — deferred (stays Unknown) →
  // the gate still voids it (the conservative path; not turned into Soccer).
  const usa = database.createBet({
    capper_id: 'test-capper', sport: 'Unknown', description: 'USA double double test-noleg',
    bet_type: 'straight', odds: '-115', units: 1, source: 'test',
  });
  const usaAfter = await gradeRow(usa);
  ok('deferred "USA double double" IS auto-voided (not false-rescued to Soccer)', usaAfter.review_status === 'auto_void_unscoped_bet');

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\nnoleg-nation-rescue: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
