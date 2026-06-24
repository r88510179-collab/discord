// ═══════════════════════════════════════════════════════════
// Matchup-prefixed player props REROUTE to the player-prop grader.
//
// Follow-up to PR #130. #130 added a GUARD: a leg shaped
// "Team vs Team Over 0.5 PLAYER - HITS" fails player-prop routing (its
// subject canonicalizes to a team, e.g. "Masyn Winn" → 'as' → Athletics, or
// the name isn't recognized) and falls through to mlb.gradeMlbBet, the GAME-
// total grader, which read "Over 0.5" as a run line and minted a FALSE WIN.
// #130 made gradeMlbBet REFUSE those ({resolved:false,
// player_prop_misrouted_to_total}) — correct, but refused legs then pile up in
// manual review because nothing grades them.
//
// This PR reroutes the RECOGNIZED ones. mlb.rewriteMatchupPrefixedProp strips
// the matchup prefix and rewrites to the canonical "<PLAYER> Over/Under <N>
// <stat>" form; the router (services/sportsdata/index.js tryStructured) grades
// that through mlb.gradeMlbPlayerProp. Key safety invariant: the player-prop
// grader can ONLY ever return a player result, a DNP VOID, or {resolved:false}
// — NEVER a game total. So a wrong extraction or an unresolvable name degrades
// to a SAFE refuse, never a false WIN (the exact property #130 protects).
// gradeMlbBet is UNCHANGED — it remains the last-line refusal for anything that
// still reaches it.
//
// Coverage (mirrors tests/mlb-prop-total-guard.test.js):
//   1. Recognized malformed legs grade as player props (evidence cites the
//      PLAYER, not a game total).
//   2. Real game totals still grade as totals (not stolen by the reroute).
//   3. Unrecognized-name legs still safely refuse (no false WIN, no game total).
//   4. Parlay regression: a rerouted WIN leg + a confirmed 0-for LOSS leg still
//      reduces to LOSS (failed-leg-kills-parlay) — the routing must never flip a
//      #130-victim parlay to WIN.
// Plus: the structured pre-check gate admits these legs (so the reroute is
// reachable in prod), provable-absence still VOIDs (never a game total), and
// #130's gradeMlbBet guard is still intact.
// ═══════════════════════════════════════════════════════════

const path = require('path');
const os = require('os');

// Pure functions + router need no DB, but requiring grading.js (for the Gate-1
// reducer + the structured-pre-check gate) loads database.js transitively —
// point DB_PATH at a throwaway file so nothing touches a real DB.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-matchup-reroute-${Date.now()}.db`);

const mlb = require('../services/sportsdata/mlb');
const { tryStructured } = require('../services/sportsdata');
const grading = require('../services/grading');
const { reduceParlayResult, looksLikePlayerProp } = grading._internal;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// ── Mock helpers ───────────────────────────────────────────────────────────
function batter(fullName, hits) {
  return { person: { fullName }, stats: { batting: { hits }, pitching: {} } };
}
function scheduleWith(games) { return { dates: [{ games }] }; }
// Route a fetch URL to a schedule or a per-game live feed.
function makeFetch({ schedule, feeds }) {
  return async (url) => {
    if (url.includes('/schedule')) return { ok: true, json: async () => schedule };
    const m = url.match(/\/game\/(\d+)\//);
    if (m && feeds[m[1]]) return { ok: true, json: async () => ({ liveData: { boxscore: feeds[m[1]] } }) };
    throw new Error(`unexpected fetch url: ${url}`);
  };
}
// off-mode slate keys off created_at; same-day event_date allows the absence VOID.
const bet = (description) => ({ id: 't', description, sport: 'MLB', created_at: '2026-05-01 18:00:00', event_date: '2026-05-01' });

console.log('mlb-matchup-prop-reroute:');

(async () => {
  // ── 1. Pure normalizer: rewrites (positives) ──────────────────────────────
  console.log(' rewriteMatchupPrefixedProp → canonical "<PLAYER> Over/Under N <stat>":');
  const rewrites = [
    ['St. Louis Cardinals vs Pirates Over 0.5 NOLAN GORMAN - HITS', 'NOLAN GORMAN Over 0.5 HITS'],
    ['Tigers vs Guardians Over 0.5 Riley Greene - HITS', 'Riley Greene Over 0.5 HITS'],
    ['St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS', 'MASYN WINN Over 0.5 HITS'], // extraction OK; lookup decides downstream (mocked absent below)
    ['Yankees @ Red Sox Over 0.5 Aaron Judge - RBI', 'Aaron Judge Over 0.5 RBI'],            // "@" separator
    ['Reds vs Cubs Over 0.5 Elly De La Cruz - Stolen Base', 'Elly De La Cruz Over 0.5 Stolen Base'],
    // No-dash forms: the stat is the trailing recognized stat phrase.
    ['Tigers vs Guardians Over 0.5 Tarik Skubal Ks', 'Tarik Skubal Over 0.5 Ks'],
    ['Mets vs Braves Over 0.5 Pete Alonso Home Run', 'Pete Alonso Over 0.5 Home Run'],
  ];
  for (const [input, expected] of rewrites) {
    check(`rewrite: "${input}"`, mlb.rewriteMatchupPrefixedProp(input) === expected, JSON.stringify(mlb.rewriteMatchupPrefixedProp(input)));
  }

  // ── 1b. Pure normalizer: null (real totals / bare markets / non-matchup) ──
  console.log(' rewriteMatchupPrefixedProp → null (no reroute):');
  const nulls = [
    'New York Mets vs St. Louis Cardinals Under 8.5 Total Runs', // run total → not rerouted
    'Astros vs Mariners Over 6.5 Total Runs',                    // run total
    'Yankees vs Red Sox 1st Inning Under 0.5 Runs',             // inning/NRFI run total
    'Yankees vs Red Sox Over 8.5',                             // bare total, no stat
    'Padres vs Dodgers Over 7.5 Total',                        // "Total" alone, no stat
    'Yankees vs Red Sox Over 8.5 Total Bases',                 // game-stat market, NO player → stays #130-refused
    'Yankees vs Red Sox Over 8.5 Total Hits',                  // game market, 1-token "Total" → NOT a player → null
    'Yankees vs Red Sox Over 8.5 Team Total Bases',            // game market, 1-token "Team" → NOT a player → null
    'Aaron Judge Over 1.5 Hits',                              // canonical prop, no matchup → normal path
    'Masyn Winn Over 0.5 Hits',                              // no matchup → #130-refused (backlog residual)
  ];
  for (const input of nulls) {
    check(`null: "${input}"`, mlb.rewriteMatchupPrefixedProp(input) === null, JSON.stringify(mlb.rewriteMatchupPrefixedProp(input)));
  }
  check('null → null, no throw', (() => { try { return mlb.rewriteMatchupPrefixedProp(null) === null; } catch (_) { return false; } })());
  check('"" → null, no throw', (() => { try { return mlb.rewriteMatchupPrefixedProp('') === null; } catch (_) { return false; } })());

  // ── 2. Structured pre-check gate admits these legs (reroute is reachable) ──
  // grading.js's looksLikePlayerProp is the sole gate before tryStructured. If it
  // rejected the matchup-prefixed shape, the reroute would never run in prod.
  console.log(' grading.js structured-gate admits matchup-prefixed legs:');
  for (const [input] of rewrites) {
    check(`gate admits: "${input}"`, looksLikePlayerProp({ description: input, sport: 'MLB' }) === true);
  }

  // ── 3. End-to-end via tryStructured (mocked Cardinals/Pirates slate) ───────
  // Game 1 FINAL: Gorman 2H (WIN), Greene 1H (WIN), McCutchen 0H (LOSS). Game 2
  // LIVE so an unseen player's absence is NON-provable → {resolved:false}, not VOID.
  console.log(' tryStructured reroutes recognized legs to the player-prop grader:');
  global.fetch = makeFetch({
    schedule: scheduleWith([
      { gamePk: 1, status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: { away: { team: { name: 'Pittsburgh Pirates' }, score: 2 }, home: { team: { name: 'St. Louis Cardinals' }, score: 5 } } },
      { gamePk: 2, status: { abstractGameState: 'Live', detailedState: 'In Progress' },
        teams: { away: { team: { name: 'Cincinnati Reds' }, score: 1 }, home: { team: { name: 'Chicago Cubs' }, score: 0 } } },
    ]),
    feeds: {
      '1': { teams: {
        home: { team: { name: 'St. Louis Cardinals' }, players: { id1: batter('Nolan Gorman', 2), id3: batter('Andrew McCutchen', 0) } },
        away: { team: { name: 'Pittsburgh Pirates' }, players: { id2: batter('Riley Greene', 1) } },
      } },
      '2': { teams: { home: { team: { name: 'Chicago Cubs' }, players: {} }, away: { team: { name: 'Cincinnati Reds' }, players: {} } } },
    },
  });

  const gorman = await tryStructured(bet('St. Louis Cardinals vs Pirates Over 0.5 NOLAN GORMAN - HITS'));
  check('case1: Gorman grades WIN as a player prop', gorman.resolved === true && gorman.status === 'WIN', JSON.stringify(gorman));
  check('case1: Gorman evidence cites the player, not a game total', /gorman/i.test(gorman.evidence || '') && !/total/i.test(gorman.evidence || ''), JSON.stringify(gorman));

  const greene = await tryStructured(bet('Tigers vs Guardians Over 0.5 Riley Greene - HITS'));
  check('case1: Greene grades WIN as a player prop', greene.resolved === true && greene.status === 'WIN', JSON.stringify(greene));
  check('case1: Greene evidence cites the player', /greene/i.test(greene.evidence || ''), JSON.stringify(greene));

  const zerofor = await tryStructured(bet('Pirates vs Cardinals Over 0.5 Andrew McCutchen - HITS'));
  check('0-for leg grades LOSS (not WIN, not refused)', zerofor.resolved === true && zerofor.status === 'LOSS', JSON.stringify(zerofor));

  const winn = await tryStructured(bet('St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS'));
  check('case3: unrecognized/absent name safely refuses (NOT a game-total WIN)',
    winn.resolved === false && winn.status !== 'WIN', JSON.stringify(winn));

  // ── 4. Provable absence still VOIDs through the reroute (never a game total) ─
  // Fully-final slate, player in no box score → provable absence → VOID.
  console.log(' provable absence → VOID (never a false game-total WIN):');
  global.fetch = makeFetch({
    schedule: scheduleWith([
      { gamePk: 1, status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: { away: { team: { name: 'Pittsburgh Pirates' }, score: 2 }, home: { team: { name: 'St. Louis Cardinals' }, score: 5 } } },
    ]),
    feeds: { '1': { teams: {
      home: { team: { name: 'St. Louis Cardinals' }, players: { id1: batter('Nolan Gorman', 2) } },
      away: { team: { name: 'Pittsburgh Pirates' }, players: {} },
    } } },
  });
  const absent = await tryStructured(bet('St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS'));
  check('provably-absent player VOIDs (not WIN/LOSS from a game total)',
    absent.resolved === true && absent.status === 'VOID', JSON.stringify(absent));

  // ── 5. Real game totals still grade as totals (not stolen by the reroute) ──
  console.log(' real game totals still resolve as totals:');
  global.fetch = makeFetch({
    schedule: scheduleWith([
      { gamePk: 9, status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: { away: { team: { name: 'New York Mets' }, score: 3, isWinner: false }, home: { team: { name: 'St. Louis Cardinals' }, score: 5, isWinner: true } } },
    ]),
    feeds: {},
  });
  const total = await tryStructured(bet('New York Mets vs St. Louis Cardinals Under 8.5 Total Runs'));
  // Total runs = 3 + 5 = 8. Under 8.5 → WIN, graded as a GAME total.
  check('case2: "...Under 8.5 Total Runs" grades as a total (not refused, not a prop)',
    total.resolved === true && total.status === 'WIN' && /total/i.test(total.evidence || ''), JSON.stringify(total));

  // ── 6. Parlay regression: failed-leg-kills-parlay still yields LOSS ────────
  // Even though some legs now correctly grade WIN, a parlay containing a
  // confirmed 0-for leg must still resolve LOSS. The routing must never flip a
  // #130-victim parlay to WIN. Uses the live Gate-1 reducer over the per-leg
  // statuses the reroute produced above.
  console.log(' parlay verdict (failed-leg-kills-parlay) stays LOSS:');
  const p1 = reduceParlayResult([gorman.status, zerofor.status]);
  check('reduce([WIN rerouted, LOSS 0-for]) → LOSS', p1.status === 'LOSS', JSON.stringify(p1));
  const p2 = reduceParlayResult([gorman.status, greene.status, zerofor.status]);
  check('reduce([WIN, WIN, LOSS]) → LOSS (one 0-for leg kills it)', p2.status === 'LOSS', JSON.stringify(p2));
  // Sanity: without the 0-for leg the reducer WOULD allow WIN — proving the LOSS
  // above comes from the failed leg, not from the reroute suppressing the WINs.
  const p3 = reduceParlayResult([gorman.status, greene.status]);
  check('reduce([WIN, WIN]) → WIN (control: rerouted legs do grade WIN)', p3.status === 'WIN', JSON.stringify(p3));

  // ── 7. #130 guard is still intact (gradeMlbBet unchanged) ─────────────────
  // gradeMlbBet remains the last-line refusal: anything that reaches it must
  // still refuse a mis-routed prop BEFORE any network fetch. The reroute lives
  // in the router, NOT here.
  console.log(' #130 gradeMlbBet guard still refuses before fetch:');
  check('looksLikeMisroutedPlayerProp still true for non-matchup "Masyn Winn Over 0.5 Hits"',
    mlb.looksLikeMisroutedPlayerProp('Masyn Winn Over 0.5 Hits') === true);
  let networkAttempted = false;
  global.fetch = async () => { networkAttempted = true; throw new Error('network must not be called for a refused prop'); };
  const refused = await mlb.gradeMlbBet('St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS', '2026-05-01');
  check('gradeMlbBet still refuses (player_prop_misrouted_to_total)',
    refused.resolved === false && refused.reason === 'player_prop_misrouted_to_total', JSON.stringify(refused));
  check('no network attempted for the refused prop', networkAttempted === false);

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
