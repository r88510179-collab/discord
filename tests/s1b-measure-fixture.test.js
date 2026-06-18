// ═══════════════════════════════════════════════════════════
// S1b measurement — in-memory fixture validation (READ-ONLY script).
//
// Validates scripts/s1b-measure.js `measure(db, deps)` against a hand-built
// in-memory SQLite DB that uses the REAL column names (bets + parlay_legs).
// Uses the REAL grader helpers (via the script's loadDeps()) so the cut is
// validated against the exact functions the grader routes on — not a re-impl.
//
// loadDeps() forces DB_PATH=':memory:' before requiring services/grading.js
// (which migrates a DB at module load), so this test performs ZERO writes to
// any real DB. The fixture DB below is a SEPARATE in-memory handle we own.
//
// Run (worktrees lack node_modules — borrow the main checkout's):
//   NODE_PATH=/Users/smokke/Documents/discord/node_modules node tests/s1b-measure-fixture.test.js
//
// Fixture map (all rows in the pool: grading_state ∈ {backoff,quarantined}):
//   id            sport     bet_type  prop?  legs                          → buckets
//   1 mlb-prop    MLB       parlay    yes    Judge(Hits), Ohtani(TB)       adapter_prop / all-prop
//   2 tennis      Tennis    straight  —      —                             search_only
//   3 soccer      Serie A   parlay    —      Inter ML, Juventus O2.5       search_only / Soccer(grouped) / NOT in leg-cut
//   4 nba-game    NBA       straight  no     —                             adapter_gamelevel
//   5 mlb-mixed   MLB       parlay    yes    Betts(Hits)=prop, Dodgers ML  adapter_prop / mixed
//   6 nba-noprop  NBA       parlay    no     Celtics -3.5, Lakers ML       adapter_gamelevel / no-prop
//   7 nhl-nolegs  NHL       parlay    no     (none)                        adapter_gamelevel / no-legs
//   8 nba-prop    NBA       straight  yes    LeBron Over 25.5 Points       adapter_prop (detector now covers NBA "Points")
//   9 baseball    Baseball  straight  no     —                             adapter_gamelevel (normalizeSport folds → non-canonical label)
//   #8: post fix/grader-prop-gate-nba-nhl, looksLikePlayerProp covers NBA/NHL stats →
//       the former MLB-bias gap (§D diagnostic) is closed; #8 now classifies adapter_prop.
// ═══════════════════════════════════════════════════════════

const path = require('path');

// Must be set BEFORE requiring the script (it reads APP_ROOT at module load to
// resolve services/*). Point it at this repo root so the worktree's own
// services/ are exercised; node_modules comes from NODE_PATH.
process.env.APP_ROOT = path.join(__dirname, '..');

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require(path.join(process.env.APP_ROOT, 'node_modules', 'better-sqlite3')); }

const s1b = require('../scripts/s1b-measure');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`); fail++; }
}
const findRow = (arr, sport) => arr.find(e => e.sport === sport);

console.log('s1b-measure fixture validation:');

// ── Build the in-memory fixture using the REAL column names ──
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE bets (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    bet_type TEXT NOT NULL,
    description TEXT NOT NULL,
    grading_state TEXT,
    grading_attempts INTEGER DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE parlay_legs (
    id TEXT PRIMARY KEY,
    bet_id TEXT,
    description TEXT NOT NULL
  );
`);

const BETS = [
  ['mlb-prop',   'MLB',      'parlay',   '• Aaron Judge Over 1.5 Hits\n• Shohei Ohtani 2+ Total Bases', 'backoff',     0,  '2026-05-01 10:00:00'],
  ['tennis',     'Tennis',   'straight', 'Carlos Alcaraz ML',                                                    'backoff',     2,  '2026-05-10 10:00:00'],
  ['soccer',     'Serie A',  'parlay',   '• Inter Milan ML\n• Juventus Over 2.5 Goals',                'quarantined', 10, '2026-05-02 10:00:00'],
  ['nba-game',   'NBA',      'straight', 'Lakers -5.5',                                                          'backoff',     1,  '2026-05-11 10:00:00'],
  ['mlb-mixed',  'MLB',      'parlay',   '• Mookie Betts 2+ Hits\n• Dodgers ML',                       'backoff',     5,  '2026-05-03 10:00:00'],
  ['nba-noprop', 'NBA',      'parlay',   '• Celtics -3.5\n• Lakers ML',                                'backoff',     20, '2026-05-04 10:00:00'],
  ['nhl-nolegs', 'NHL',      'parlay',   '• Bruins ML\n• Oilers ML',                                   'backoff',     3,  '2026-05-12 10:00:00'],
  ['nba-prop',   'NBA',      'straight', 'LeBron James Over 25.5 Points',                                        'backoff',     4,  '2026-05-05 10:00:00'],
  ['baseball',   'Baseball', 'straight', 'Yankees ML',                                                           'backoff',     1,  '2026-05-06 10:00:00'],
];
const LEGS = [
  ['l1a', 'mlb-prop',   'Aaron Judge Over 1.5 Hits'],
  ['l1b', 'mlb-prop',   'Shohei Ohtani 2+ Total Bases'],
  ['l3a', 'soccer',     'Inter Milan ML'],
  ['l3b', 'soccer',     'Juventus Over 2.5 Goals'],
  ['l5a', 'mlb-mixed',  'Mookie Betts 2+ Hits'],
  ['l5b', 'mlb-mixed',  'Dodgers ML'],
  ['l6a', 'nba-noprop', 'Celtics -3.5'],
  ['l6b', 'nba-noprop', 'Lakers ML'],
  // nhl-nolegs deliberately has NO leg rows.
];
const insB = db.prepare('INSERT INTO bets (id,sport,bet_type,description,grading_state,grading_attempts,created_at) VALUES (?,?,?,?,?,?,?)');
const insL = db.prepare('INSERT INTO parlay_legs (id,bet_id,description) VALUES (?,?,?)');
for (const r of BETS) insB.run(...r);
for (const r of LEGS) insL.run(...r);

// ── Load the REAL grader helpers and run the core ──
const deps = s1b.loadDeps();
check('loadDeps returns the real chosen detector + leg router', typeof deps.looksLikePlayerProp === 'function' && typeof deps.normalizeSport === 'function' && typeof deps.isPlayerPropDescription === 'function' && typeof deps.inferLegSport === 'function');

const r = s1b.measure(db, deps);

// ── §1 Pool totals ──
check('§1 backoff count', r.pool.backoff === 8, r.pool.backoff);
check('§1 quarantined count', r.pool.quarantined === 1, r.pool.quarantined);
check('§1 total', r.pool.total === 9, r.pool.total);

// ── §2 Per-sport grouped + raw ──
const gMLB = findRow(r.perSportGrouped, 'MLB');
const gNBA = findRow(r.perSportGrouped, 'NBA');
const gSoccer = findRow(r.perSportGrouped, 'Soccer');
const gTennis = findRow(r.perSportGrouped, 'Tennis');
const gNHL = findRow(r.perSportGrouped, 'NHL');
check('§2 grouped MLB = 2 (2P/0S)', gMLB && gMLB.total === 2 && gMLB.parlay === 2 && gMLB.straight === 0, gMLB);
check('§2 grouped NBA = 3 (1P/2S)', gNBA && gNBA.total === 3 && gNBA.parlay === 1 && gNBA.straight === 2, gNBA);
check('§2 grouped Soccer = 1 (1P) [Serie A folded in]', gSoccer && gSoccer.total === 1 && gSoccer.parlay === 1, gSoccer);
check('§2 grouped Tennis = 1 (1S)', gTennis && gTennis.total === 1 && gTennis.straight === 1, gTennis);
check('§2 grouped NHL = 1 (1P)', gNHL && gNHL.total === 1 && gNHL.parlay === 1, gNHL);
check('§2 grouped has NO "Serie A" row (folded)', !findRow(r.perSportGrouped, 'Serie A'));
check('§2 raw HAS "Serie A" row (ungrouped)', !!findRow(r.perSportRaw, 'Serie A'));
check('§2 raw has NO "Soccer" row', !findRow(r.perSportRaw, 'Soccer'));
check('§2 raw "Baseball" distinct from MLB', !!findRow(r.perSportRaw, 'Baseball') && !!findRow(r.perSportRaw, 'MLB'));

// ── §3 Source classification ──
// Post fix/grader-prop-gate-nba-nhl: looksLikePlayerProp now covers NBA/NHL stat
// words, so the NBA "Points" prop (nba-prop) classifies adapter_prop, not gamelevel.
check('§3 adapter_prop = 3 (mlb-prop, mlb-mixed, nba-prop)', r.source.adapter_prop === 3, r.source.adapter_prop);
check('§3 adapter_gamelevel = 4 (nba-game, nba-noprop, nhl-nolegs, baseball)', r.source.adapter_gamelevel === 4, r.source.adapter_gamelevel);
check('§3 search_only = 2 (tennis, soccer)', r.source.search_only === 2, r.source.search_only);
check('§3 source total = 9', r.source.total === 9, r.source.total);
// NBA "Points" prop now correctly classified adapter_prop (the detector covers it):
const smNBA = findRow(r.sourceMatrix, 'NBA');
check('§3 matrix NBA = 2G/1P/0S (detector now catches NBA Points prop)', smNBA && smNBA.adapter_gamelevel === 2 && smNBA.adapter_prop === 1, smNBA);
const smMLB = findRow(r.sourceMatrix, 'MLB');
check('§3 matrix MLB = 0G/2P/0S', smMLB && smMLB.adapter_prop === 2 && smMLB.adapter_gamelevel === 0, smMLB);

// ── §4 parlay_legs prop cut ──
const c = r.legCut;
check('§4 parlaysConsidered = 4 (Serie A excluded; not covered)', c.parlaysConsidered === 4, c.parlaysConsidered);
check('§4 all-prop = 1 (mlb-prop)', c.allProp === 1, c.allProp);
check('§4 mixed = 1 (mlb-mixed)', c.mixed === 1, c.mixed);
check('§4 no-prop = 1 (nba-noprop)', c.noProp === 1, c.noProp);
check('§4 no-legs = 1 (nhl-nolegs)', c.noLegs === 1, c.noLegs);
check('§4 prop legs = 3', c.propLegs === 3, c.propLegs);
check('§4 non-prop legs = 3', c.nonPropLegs === 3, c.nonPropLegs);
check('§4 total legs = 6', c.totalLegs === 6, c.totalLegs);
check('§4 bySport MLB 3 prop / 1 non-prop legs', c.bySport.MLB && c.bySport.MLB.propLegs === 3 && c.bySport.MLB.nonPropLegs === 1, c.bySport.MLB);
check('§4 bySport NBA no-prop=1, 2 non-prop legs', c.bySport.NBA && c.bySport.NBA.noProp === 1 && c.bySport.NBA.nonPropLegs === 2, c.bySport.NBA);
check('§4 bySport NHL no-legs=1', c.bySport.NHL && c.bySport.NHL.noLegs === 1, c.bySport.NHL);

// ── §4b leg-routed view (clean baseline: no divergence in this fixture) ──
// Every covered parlay's legs route to its parent sport; the soccer parlay's
// legs route SOCCER (not covered). So §4b should MATCH §4 and show 0 divergence.
const lr = r.legRouting;
check('§4b parlaysScanned = 4 (nhl-nolegs has no legs → skipped)', lr.parlaysScanned === 4, lr.parlaysScanned);
check('§4b legsScanned = 8', lr.legsScanned === 8, lr.legsScanned);
check('§4b routedCoveredTotal = 3 prop / 3 non-prop (matches §4)', lr.routedCoveredTotal.prop === 3 && lr.routedCoveredTotal.nonProp === 3, lr.routedCoveredTotal);
check('§4b routed MLB = 3P/1N', lr.routedCovered.MLB.prop === 3 && lr.routedCovered.MLB.nonProp === 1, lr.routedCovered.MLB);
check('§4b routed NBA = 0P/2N', lr.routedCovered.NBA.prop === 0 && lr.routedCovered.NBA.nonProp === 2, lr.routedCovered.NBA);
check('§4b clean fixture → 0 covered prop legs in non-covered parent', lr.coveredPropLegsInNonCoveredParent === 0, lr.coveredPropLegsInNonCoveredParent);
check('§4b clean fixture → 0 cross-sport legs', lr.crossSportLegs === 0, lr.crossSportLegs);
check('§4b consistency: leg-routed totals == parent-keyed §4 when no divergence', lr.routedCoveredTotal.prop === c.propLegs && lr.routedCoveredTotal.nonProp === c.nonPropLegs);

// ── §5 Honesty check ──
const a = r.honesty.attempts;
check('§5 attempts bucket 0 → 1', a.zero === 1, a.zero);
check('§5 attempts bucket 1–3 → 4', a.oneToThree === 4, a.oneToThree);  // tennis(2), nba-game(1), nhl(3), baseball(1)
check('§5 attempts bucket 4+ → 4', a.fourPlus === 4, a.fourPlus);       // soccer(10), mlb-mixed(5), nba-noprop(20), nba-prop(4)
check('§5 attempts min/max', a.min === 0 && a.max === 20, { min: a.min, max: a.max });
check('§5 attempts avg = 46/9', Math.abs(a.avg - 46 / 9) < 1e-9, a.avg);
check('§5 attempts count = 9', a.count === 9, a.count);
check('§5 created_at oldest', r.honesty.createdAt.oldest === '2026-05-01 10:00:00', r.honesty.createdAt.oldest);
check('§5 created_at newest', r.honesty.createdAt.newest === '2026-05-12 10:00:00', r.honesty.createdAt.newest);

// ── §D Diagnostics (grader-fidelity caveats) ──
const d = r.diagnostics;
// MLB-bias gap now closed: looksLikePlayerProp covers NBA/NHL stats, so the NBA
// "Points" prop is no longer missed by the chosen detector.
check('§D covered props missed by chosen detector = 0 (MLB-bias gap closed)', d.coveredPropsMissedByChosenDetector === 0, d.coveredPropsMissedByChosenDetector);
check('§D non-canonical covered label "Baseball" surfaced', d.nonCanonicalCoveredLabels.some(x => x.label === 'Baseball' && x.count === 1), d.nonCanonicalCoveredLabels);

// ── Helper-level sanity (pure functions) ──
check('isParlayBet sgp → true', s1b.isParlayBet({ bet_type: 'SGP' }) === true);
check('isParlayBet straight → false', s1b.isParlayBet({ bet_type: 'straight' }) === false);
check('groupSport EPL → Soccer', s1b.groupSport('EPL') === 'Soccer');
check('groupSport UFC → Combat', s1b.groupSport('UFC') === 'Combat');
check('groupSport MLB → MLB (passthrough)', s1b.groupSport('MLB') === 'MLB');
check('formatReport produces a string', typeof s1b.formatReport(r) === 'string' && s1b.formatReport(r).includes('§4b LEG-ROUTED VIEW'));

db.close();

// ═══════════════════════════════════════════════════════════
// Focused fixture 2 — the cross-sport routing DIVERGENCE that the parent-keyed
// §4 hides and §4b sizes. Two parlays:
//   P1 parent=Tennis (NOT covered): legs [Shohei Ohtani 2+ Total Bases → MLB & prop,
//      Carlos Alcaraz ML → null→Tennis (not covered)]
//   P2 parent=MLB (covered):        legs [Boston Celtics -5.5 → NBA & non-prop,
//      Shohei Ohtani 2+ Total Bases → MLB & prop]
// inferLegSport outputs verified empirically: Boston Celtics -5.5→NBA,
// Shohei Ohtani 2+ Total Bases→MLB, Carlos Alcaraz ML→null (parent fallback).
// ═══════════════════════════════════════════════════════════
console.log('\ns1b-measure leg-routing divergence fixture:');
const db2 = new Database(':memory:');
db2.exec(`
  CREATE TABLE bets (id TEXT PRIMARY KEY, sport TEXT NOT NULL, bet_type TEXT NOT NULL, description TEXT NOT NULL, grading_state TEXT, grading_attempts INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE parlay_legs (id TEXT PRIMARY KEY, bet_id TEXT, description TEXT NOT NULL);
`);
const insB2 = db2.prepare('INSERT INTO bets (id,sport,bet_type,description,grading_state,grading_attempts,created_at) VALUES (?,?,?,?,?,?,?)');
const insL2 = db2.prepare('INSERT INTO parlay_legs (id,bet_id,description) VALUES (?,?,?)');
insB2.run('tennis-mlb', 'Tennis', 'parlay', '• Shohei Ohtani 2+ Total Bases\n• Carlos Alcaraz ML', 'backoff', 1, '2026-05-01 10:00:00');
insB2.run('mlb-nba',    'MLB',    'parlay', '• Boston Celtics -5.5\n• Shohei Ohtani 2+ Total Bases', 'backoff', 1, '2026-05-02 10:00:00');
insL2.run('p1a', 'tennis-mlb', 'Shohei Ohtani 2+ Total Bases');
insL2.run('p1b', 'tennis-mlb', 'Carlos Alcaraz ML');
insL2.run('p2a', 'mlb-nba',    'Boston Celtics -5.5');
insL2.run('p2b', 'mlb-nba',    'Shohei Ohtani 2+ Total Bases');

const r2 = s1b.measure(db2, deps);
const c2 = r2.legCut, lr2 = r2.legRouting;

// §4 PRIMARY (parent-keyed): only the MLB-parent parlay counts; Celtics leg is
// attributed to MLB even though it routes NBA; the Tennis parlay is excluded.
check('§4(div) parent-keyed considers only the MLB-parent parlay', c2.parlaysConsidered === 1, c2.parlaysConsidered);
check('§4(div) that parlay is mixed', c2.mixed === 1, c2.mixed);
check('§4(div) parent-keyed buckets the NBA leg under MLB (parent)', c2.bySport.MLB && c2.bySport.MLB.propLegs === 1 && c2.bySport.MLB.nonPropLegs === 1, c2.bySport.MLB);

// §4b LEG-ROUTED: faithful to the grader's per-leg dispatch.
check('§4b(div) parlaysScanned = 2', lr2.parlaysScanned === 2, lr2.parlaysScanned);
check('§4b(div) legsScanned = 4', lr2.legsScanned === 4, lr2.legsScanned);
check('§4b(div) routed MLB = 2P/0N (both Ohtani legs)', lr2.routedCovered.MLB.prop === 2 && lr2.routedCovered.MLB.nonProp === 0, lr2.routedCovered.MLB);
check('§4b(div) routed NBA = 0P/1N (Celtics leg)', lr2.routedCovered.NBA.prop === 0 && lr2.routedCovered.NBA.nonProp === 1, lr2.routedCovered.NBA);
check('§4b(div) covered PROP leg hiding in non-covered (Tennis) parent = 1', lr2.coveredPropLegsInNonCoveredParent === 1, lr2.coveredPropLegsInNonCoveredParent);
check('§4b(div) cross-sport legs = 2 (Ohtani@Tennis, Celtics@MLB)', lr2.crossSportLegs === 2, lr2.crossSportLegs);
// The load-bearing point: parent-keyed §4 UNDER-sizes the covered-prop slice.
check('§4b(div) leg-routed prop count (2) > parent-keyed §4 prop count (1) — §4 undercounts', lr2.routedCoveredTotal.prop > c2.propLegs, { routed: lr2.routedCoveredTotal.prop, parent: c2.propLegs });

db2.close();

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('S1b measurement fixture validation passed.');
