// ═══════════════════════════════════════════════════════════
// Per-leg sport resolution: MLB/KBO prop legs were resolving to NFL.
//
// Bug (verified against live DB, 2026-06-16):
//   For PARLAY prop legs, grading_audit.sport_in came out NFL even though
//   bets.sport was correct, because the grade path's sport resolvers
//   (reclassifySport @ gradePropWithAI, inferLegSport @ gradeParlay) used a bare
//   `desc.includes(keyword)` SUBSTRING scan over SPORT_TEAM_MAP — the same flaw
//   #103 already fixed in validateLegSportConsistency but never extended to the
//   grade path.
//
//   • bets.sport=MLB (Tatis / CJ Abrams / Wood / Laureano "Over 0.5 Hits",
//     live 0f50c2bf): "CJ Ab*rams*" ⊃ the NFL nickname "rams" → reclassifySport
//     flips MLB → NFL, every leg searches "<player> NFL final score", finds
//     nothing, the slip stalls PENDING.
//   • bets.sport=KBO (Hanwha Eagles / SSG Landers / Samsung Lions, live
//     38ab5396): "Eagles" / "Lions" → NFL (size 1) → reclassifySport flips
//     KBO → NFL BEFORE gradePropWithAI's supported-sport gate, so the gate sees a
//     supported sport and the #113 unmodeled-league divert never fires — the bet
//     grades every leg against the wrong league and LOOPS on backoff (attempt 8+).
//   • bets.sport=NBA (Maxey / Oubre / Castle / Reid, live 52937045): the player
//     names carry no nickname substring, so it already resolved NBA correctly.
//
// Fix (services/ai.js): reuse #103's `legTextHasTeamWord` (\b-anchored whole-word)
//   in BOTH reclassifySport and inferLegSport, and mirror the validator's
//   `matchesKboTeam` carve-out so KBO clubs (which share US nicknames and aren't
//   in SPORT_TEAM_MAP) don't reclassify/infer to the colliding US league. After
//   the fix MLB stays MLB, KBO stays KBO (so the #113 divert fires), NBA is
//   unchanged, and a leg that genuinely names a different-sport team is still
//   honored.
//
// Behaviour-change assertions FAIL on pre-fix code:
//   reclassifySport('MLB', '…CJ Abrams…') === 'NFL' (pre) vs 'MLB' (post);
//   reclassifySport('KBO', 'Hanwha Eagles…') === 'NFL' (pre) vs 'KBO' (post);
//   inferLegSport('CJ Abrams O0.5 Hits') === 'NFL' (pre) vs null (post);
//   inferLegSport('Hanwha Eagles +1.5') === 'NFL' (pre) vs null (post);
//   integration KBO-nickname parlay: graded/looped (pre) vs diverted to
//   manual_review_unmodeled_sport (post).
//
// Run:  node tests/leg-sport-resolution.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — requiring grading.js pulls in ai.js; the divert branch
// returns BEFORE any grader dispatch, but reject the wire so a stray downstream
// path fails fast instead of hanging.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB for the integration write-path checks. Set BEFORE requiring
// database/grading so the real production DB is never opened.
const dbFile = path.join(os.tmpdir(), `bettracker-leg-sport-res-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.GRADING_STATE_MACHINE_ENABLED;

const { reclassifySport, inferLegSport, matchesKboTeam } = require('../services/ai');
const grading = require('../services/grading');
const { buildGraderSearchQuery, gradePropWithAI } = grading;
const database = require('../services/database');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// The three live specimens this PR quotes.
const MLB_LEGS = ['Fernando Tatis Jr. O0.5 Hits', 'CJ Abrams O0.5 Hits', 'James Wood O0.5 Hits', 'Ramon Laureano O0.5 Hits'];
const KBO_LEGS = ['Hanwha Eagles +1.5', 'SSG Landers +1.5', 'Samsung Lions ML'];
const NBA_LEGS = ['Tyrese Maxey O22.5 Points', 'Kelly Oubre Jr. O12.5 Points', 'Stephon Castle O14.5 Points', 'Naz Reid O10.5 Points'];

// gradeParlay computes each leg's sport as `inferLegSport(leg) || parlaySport`,
// where parlaySport is the (reclassified) bets.sport. Mirror it exactly so the
// asserted value is what becomes grading_audit.sport_in.
function legSportFor(legDesc, parlaySport) {
  return inferLegSport(legDesc) || parlaySport || 'Unknown';
}

// ── A. reclassifySport — the parlay-level corruption (gradePropWithAI:2287) ──
console.log('A. reclassifySport — substring/KBO corruption no longer flips the parlay sport');
check('MLB parlay desc (incl. "CJ Abrams") → MLB, NOT NFL (substring "rams" defused)',
  reclassifySport('MLB', MLB_LEGS.join(' / ')), 'MLB');
check('KBO parlay desc (Eagles/Landers/Lions) → KBO, NOT NFL (KBO carve-out)',
  reclassifySport('KBO', KBO_LEGS.join(' / ')), 'KBO');
check('NBA parlay desc → NBA (no regression — already worked)',
  reclassifySport('NBA', NBA_LEGS.join(' / ')), 'NBA');
// Single-leg forms of the corruption (each in isolation).
check('reclassifySport("MLB", "CJ Abrams O0.5 Hits") → MLB (not NFL)', reclassifySport('MLB', 'CJ Abrams O0.5 Hits'), 'MLB');
check('reclassifySport("KBO", "Hanwha Eagles +1.5") → KBO (not NFL)', reclassifySport('KBO', 'Hanwha Eagles +1.5'), 'KBO');
check('reclassifySport("KBO", "Samsung Lions ML") → KBO (not NFL)', reclassifySport('KBO', 'Samsung Lions ML'), 'KBO');
// City-injected KBO Vision corruption: the KBO carve-out runs BEFORE
// disambiguateAmbiguousTeam, so the injected "Philadelphia" can't force NFL.
check('reclassifySport("KBO", "Hanwha Philadelphia Eagles +1.5") → KBO (city-injection tolerated)',
  reclassifySport('KBO', 'Hanwha Philadelphia Eagles +1.5'), 'KBO');

// ── A2. reclassifySport — genuine reclassification + whole-word preserved ──
console.log('A2. reclassifySport — real signals still fire (no over-correction)');
check('reclassifySport("MLB", "Cowboys -3") → NFL (clean whole-word team, single-sport reclassify)',
  reclassifySport('MLB', 'Cowboys -3'), 'NFL');
check('reclassifySport("MLB", "Giants ML") → MLB (multi-sport tie keeps original)',
  reclassifySport('MLB', 'Giants ML'), 'MLB');
check('reclassifySport("MLB", "Cardinals -1.5") → MLB (multi-sport tie keeps original)',
  reclassifySport('MLB', 'Cardinals -1.5'), 'MLB');
// A real NFL "Philadelphia Eagles" (no KBO sponsor) is NOT a KBO match, so the
// carve-out does not swallow it — a genuinely mis-declared bet still reclassifies.
check('reclassifySport("MLB", "Philadelphia Eagles -3") → NFL (real NFL, no KBO sponsor)',
  reclassifySport('MLB', 'Philadelphia Eagles -3'), 'NFL');

// ── B. inferLegSport — per-leg signal (gradeParlay:2599) ──
console.log('B. inferLegSport — prop legs no longer mis-fire NFL; inherit-the-parlay floor');
// MLB prop legs: no real team token → null → caller inherits the parlay sport.
for (const leg of MLB_LEGS) {
  check(`inferLegSport("${leg}") → null (no NFL substring leak)`, inferLegSport(leg), null);
}
// KBO legs: matchesKboTeam carve-out → null → inherit the (KBO) parlay sport.
for (const leg of KBO_LEGS) {
  check(`inferLegSport("${leg}") → null (KBO club, not the colliding US team)`, inferLegSport(leg), null);
}
// NBA legs: already null (player names, no nickname) → inherit NBA. No regression.
for (const leg of NBA_LEGS) {
  check(`inferLegSport("${leg}") → null (inherits NBA)`, inferLegSport(leg), null);
}

// ── B2. inferLegSport — genuine per-leg sport still honored ──
console.log('B2. inferLegSport — a leg that genuinely names a team is still classified');
check('inferLegSport("Dallas Cowboys -3") → NFL (clean whole-word franchise)', inferLegSport('Dallas Cowboys -3'), 'NFL');
check('inferLegSport("rams ML") → NFL (bare lowercase nickname is a whole word)', inferLegSport('rams ML'), 'NFL');
check('inferLegSport("Boston Celtics -5.5") → NBA (whole-word match preserved)', inferLegSport('Boston Celtics -5.5'), 'NBA');
check('inferLegSport("Shohei Ohtani 2+ Total Bases") → MLB (action-keyword signal preserved)', inferLegSport('Shohei Ohtani 2+ Total Bases'), 'MLB');
// Real NFL Eagles (no sponsor) is NOT a KBO match → still classifies NFL.
check('inferLegSport("Philadelphia Eagles -3") → NFL (real NFL, KBO carve-out does not swallow it)', inferLegSport('Philadelphia Eagles -3'), 'NFL');

// ── C. Effective per-leg legSport (what becomes grading_audit.sport_in) ──
console.log('C. effective legSport — MLB legs grade as MLB, KBO legs carry KBO, NBA unchanged');
{
  const mlbParlay = reclassifySport('MLB', MLB_LEGS.join(' / '));   // 'MLB' post-fix
  for (const leg of MLB_LEGS) check(`MLB leg "${leg}" → sport_in MLB`, legSportFor(leg, mlbParlay), 'MLB');
  const kboParlay = reclassifySport('KBO', KBO_LEGS.join(' / '));   // 'KBO' post-fix
  for (const leg of KBO_LEGS) check(`KBO leg "${leg}" → sport_in KBO`, legSportFor(leg, kboParlay), 'KBO');
  const nbaParlay = reclassifySport('NBA', NBA_LEGS.join(' / '));   // 'NBA'
  for (const leg of NBA_LEGS) check(`NBA leg "${leg}" → sport_in NBA`, legSportFor(leg, nbaParlay), 'NBA');
}

// ── D. Search query — an MLB leg builds an MLB query, never an NFL one ──
console.log('D. buildGraderSearchQuery — MLB leg searches MLB, not NFL');
{
  const q = buildGraderSearchQuery({ sport: 'MLB', description: 'CJ Abrams O0.5 Hits', created_at: '2026-06-14' });
  ok(`query contains "MLB" (was "${q}")`, /\bMLB\b/.test(q));
  ok('query does NOT contain "NFL"', !/\bNFL\b/.test(q));
}

// ── E. matchesKboTeam guard is precise (no false positives) ──
console.log('E. matchesKboTeam — sponsor pairing required, real US teams unaffected');
check('matchesKboTeam("Hanwha Eagles +1.5") → true', matchesKboTeam('Hanwha Eagles +1.5'), true);
check('matchesKboTeam("Philadelphia Eagles -3") → false (no KBO sponsor)', matchesKboTeam('Philadelphia Eagles -3'), false);
check('matchesKboTeam("NC State Wolfpack -7") → false (NC sponsor needs "Dinos")', matchesKboTeam('NC State Wolfpack -7'), false);

// ── F. Integration — the KBO-nickname parlay diverts (no longer loops) ──
database.db.pragma('foreign_keys = OFF');

async function gradeRow(betRow) {
  try { await gradePropWithAI({ ...betRow }); } catch (_) { /* offline downstream */ }
  return database.db.prepare(
    'SELECT result, review_status, grading_state, grade, drop_reason FROM bets WHERE id = ?',
  ).get(betRow.id);
}

(async () => {
  console.log('F. integration — KBO parlay with US-colliding nicknames diverts to manual review');

  // The live 38ab5396 shape: a KBO parlay whose every leg names a KBO club that
  // shares a US nickname. PRE-FIX reclassifySport flipped this to NFL (supported)
  // so the #113 divert never fired and the bet looped; POST-FIX it stays KBO and
  // diverts. (The divert at the supported-sport gate returns BEFORE parlay-leg
  // loading, so no parlay_legs rows are needed to exercise it.)
  const kbo = database.createBet({
    capper_id: 'test-capper', sport: 'KBO',
    description: KBO_LEGS.join(' • '),
    bet_type: 'parlay', odds: '+150', units: 1, source: 'test',
  });
  const after = await gradeRow(kbo);
  ok('KBO-nickname parlay → manual_review_unmodeled_sport (NOT NFL-graded / looped)',
    after.review_status === 'manual_review_unmodeled_sport');
  ok('KBO-nickname parlay NOT voided (result stays pending for a human)', after.result === 'pending');
  ok('KBO-nickname parlay grading_state=done (grader won\'t re-pick → no backoff loop)', after.grading_state === 'done');
  ok('KBO-nickname parlay no grade written', after.grade === null);
  ok('KBO-nickname parlay drop_reason = GRADE_MANUAL_REVIEW_UNMODELED', after.drop_reason === 'GRADE_MANUAL_REVIEW_UNMODELED');

  // Control: an NBA parlay with the same shape is supported → NOT diverted (the
  // divert is specific to the unmodeled sport, not a blanket parlay behaviour).
  const nba = database.createBet({
    capper_id: 'test-capper', sport: 'NBA',
    description: NBA_LEGS.join(' • '),
    bet_type: 'parlay', odds: '+200', units: 1, source: 'test',
  });
  const nbaAfter = await gradeRow(nba);
  ok('NBA parlay NOT diverted to manual review (supported sport)',
    nbaAfter.review_status !== 'manual_review_unmodeled_sport');

  console.log(`\nleg-sport-resolution: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
