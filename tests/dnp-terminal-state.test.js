// ═══════════════════════════════════════════════════════════
// Structured prop grader: a player who PROVABLY did not play VOIDs — it must
// NOT fall through to web search (which is guaranteed to find nothing and loops
// forever, burning a search + LLM call every cycle).
//
// Bug (verified live): gradeMlbPlayerProp returned
// { resolved:false, reason:'player_not_found_in_games_on_date' } when a player
// did not appear in any game on the bet's date. Live: bet 0f50c2bf's leg
// "Ramon Laureano O 0.5 Hits" on 2026-05-31 — statsapi shows NO game-log entry
// that date (DNP); 15 MLB games were played and his team (Padres) played, but he
// did not appear. The reason fell through to ESPN→AI→searchWeb, which provably
// can't resolve it, so it returned empty-PENDING forever.
//
// Resolution rule (Smokke): a player who did not play had NO ACTION → the prop
// VOIDs (stake returned, no W/L, no capper effect), regardless of market or
// direction. VOID, never LOSS, never search. In a parlay a VOID leg REDUCES the
// parlay (drops out; remaining legs decide).
//
// Conservatism (HARD RULE): an indeterminate / error outcome must NEVER hard-
// settle a bet. VOID fires ONLY on PROVABLE absence — a full final slate, every
// box score fetched, player in none. No games / a live game / a skipped fetch
// (API error) / a misparsed name all stay fall-throughs.
//
// Pure functions + adapters with a stubbed global.fetch — NO live HTTP.
// ═══════════════════════════════════════════════════════════

const path = require('path');
const os = require('os');
// grading.js (required at the bottom for the parlay reducer) loads database.js
// transitively, so point DB_PATH at a throwaway file.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-dnp-${process.pid}.db`);

const mlb = require('../services/sportsdata/mlb');
const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');
const { tryStructured } = require('../services/sportsdata');
const { isProvableAbsence, voidPlayerDidNotPlay } = require('../services/sportsdata/terminalState');
const database = require('../services/database');     // loads + migrates the throwaway DB
const grading = require('../services/grading');
const { reduceParlayResult } = grading._internal;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// ── fetch stub ───────────────────────────────────────────────
// router(url) → JSON object to return, or the sentinel THROW to simulate a
// network/API failure (fetch rejects). Any unrouted URL fails loudly.
const THROW = Symbol('throw');
let networkAttempted = false;
function installFetch(router) {
  networkAttempted = false;
  global.fetch = async (url) => {
    networkAttempted = true;
    const r = router(String(url));
    if (r === THROW) throw new Error('mock network error');
    if (r === undefined) throw new Error(`unrouted URL in test: ${url}`);
    return { ok: true, status: 200, json: async () => r };
  };
}

// ── MLB builders ─────────────────────────────────────────────
const mlbGame = (pk, final) => ({
  gamePk: pk,
  status: { abstractGameState: final ? 'Final' : 'Live', detailedState: final ? 'Final' : 'In Progress' },
  teams: {
    away: { team: { name: 'San Diego Padres' }, score: 3, isWinner: false },
    home: { team: { name: 'Los Angeles Dodgers' }, score: 5, isWinner: true },
  },
});
const mlbSchedule = (games) => ({ dates: [{ games }] });
const mlbBoxscore = (awayPlayers) => ({
  liveData: { boxscore: { teams: {
    away: { team: { name: 'San Diego Padres' }, players: awayPlayers },
    home: { team: { name: 'Los Angeles Dodgers' }, players: {} },
  } } },
});
const laureano = (hits) => ({ ID1: { person: { fullName: 'Ramon Laureano', boxscoreName: 'Laureano' }, stats: { batting: { hits }, pitching: {} } } });
const someoneElse = { ID9: { person: { fullName: 'Manny Machado', boxscoreName: 'Machado' }, stats: { batting: { hits: 1 }, pitching: {} } } };

(async () => {
  console.log('dnp-terminal-state:');

  // ── Pure predicate: isProvableAbsence ──
  console.log(' isProvableAbsence (the conservative bucketing decision):');
  check('full final slate, clean fetches, gamesOnDate>0 → provable',
    isProvableAbsence({ gamesOnDate: 15, allFinal: true, anyFetchError: false }) === true);
  check('no games on date → NOT provable (date suspect)',
    isProvableAbsence({ gamesOnDate: 0, allFinal: true, anyFetchError: false }) === false);
  check('a game not yet final → NOT provable (player may still appear)',
    isProvableAbsence({ gamesOnDate: 15, allFinal: false, anyFetchError: false }) === false);
  check('a box-score fetch failed → NOT provable (player may be hidden)',
    isProvableAbsence({ gamesOnDate: 15, allFinal: true, anyFetchError: true }) === false);
  check('empty/undefined scan → NOT provable, no throw',
    (() => { try { return isProvableAbsence() === false; } catch (_) { return false; } })());

  // ── Pure builder: voidPlayerDidNotPlay ──
  console.log(' voidPlayerDidNotPlay (VOID contract shape):');
  const v = voidPlayerDidNotPlay('Ramon Laureano', '2026-05-31', 15, 'MLB', 'mlb_statsapi');
  check('resolved:true', v.resolved === true);
  check('status VOID', v.status === 'VOID');
  check('source preserved', v.source === 'mlb_statsapi');
  check('evidence names player + date + no-action', /Ramon Laureano/.test(v.evidence) && /2026-05-31/.test(v.evidence) && /no action, void/.test(v.evidence), v.evidence);

  // ── MLB: the exact live Laureano DNP → VOID (provable absence) ──
  console.log(' MLB DNP (the Laureano case) → VOID, not fall-through:');
  installFetch((url) => {
    if (url.includes('/schedule')) return mlbSchedule([mlbGame(101, true), mlbGame(102, true)]);
    if (url.includes('/feed/live')) return mlbBoxscore(someoneElse); // Laureano in NEITHER box score
    return undefined;
  });
  let r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-31');
  check('resolved:true (NOT a fall-through)', r.resolved === true, JSON.stringify(r));
  check('status VOID', r.status === 'VOID', JSON.stringify(r));
  check('evidence = absence on the bet date', /Ramon Laureano/.test(r.evidence) && /2026-05-31/.test(r.evidence), r.evidence);
  check('NOT resolved:false player_not_found', r.reason === undefined);

  // ── MLB: indeterminate — a game is still live → fall through (no false VOID) ──
  console.log(' MLB indeterminate guards (must keep falling through):');
  installFetch((url) => {
    if (url.includes('/schedule')) return mlbSchedule([mlbGame(201, true), mlbGame(202, false)]); // one not final
    if (url.includes('/feed/live')) return mlbBoxscore(someoneElse);
    return undefined;
  });
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-31');
  check('live game in slate → resolved:false player_not_found (fall-through)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── MLB: indeterminate — a box-score fetch FAILS (API error) → fall through ──
  installFetch((url) => {
    if (url.includes('/schedule')) return mlbSchedule([mlbGame(301, true)]);
    if (url.includes('/feed/live')) return THROW; // the one box score we needed failed
    return undefined;
  });
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-31');
  check('box-score fetch error → resolved:false (NO false VOID on API failure)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── MLB: indeterminate — NO games on the date → fall through ──
  installFetch((url) => {
    if (url.includes('/schedule')) return mlbSchedule([]);
    return undefined;
  });
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-31');
  check('no games on date → resolved:false (fall-through, date suspect)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── MLB: indeterminate — schedule fetch throws → adapter_error via tryStructured ──
  installFetch(() => THROW);
  const tr = await tryStructured({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB', created_at: '2026-05-31 18:00:00' });
  check('schedule fetch error → tryStructured resolved:false adapter_error (no hard settle)',
    tr.resolved === false && /^adapter_error/.test(tr.reason || ''), JSON.stringify(tr));

  // ── MLB: indeterminate — unknown stat (no network, no hard settle) ──
  installFetch(() => undefined);
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Doubles', '2026-05-31'); // "doubles" ∉ STAT_MAP
  check('unknown stat → resolved:false unknown_stat (no network, no settle)',
    r.resolved === false && r.reason === 'unknown_stat' && networkAttempted === false, JSON.stringify(r));

  // ── MLB: regression — player FOUND in a final game still grades normally ──
  console.log(' MLB found-path regression (the refactor must not break grading):');
  installFetch((url) => {
    if (url.includes('/schedule')) return mlbSchedule([mlbGame(401, true)]);
    if (url.includes('/feed/live')) return mlbBoxscore(laureano(2)); // 2 hits
    return undefined;
  });
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-31');
  check('found, 2 hits, O 0.5 → WIN (not VOID)', r.resolved === true && r.status === 'WIN', JSON.stringify(r));

  // ── NBA DNP → VOID ──
  console.log(' NBA DNP → VOID:');
  const nbaEvent = (id, final) => ({
    id,
    competitions: [{
      status: { type: { name: final ? 'STATUS_FINAL' : 'STATUS_IN_PROGRESS' } },
      competitors: [
        { homeAway: 'home', team: { displayName: 'Boston Celtics' }, score: '110', winner: true },
        { homeAway: 'away', team: { displayName: 'Miami Heat' }, score: '100', winner: false },
      ],
    }],
  });
  const nbaSummary = (lastName) => ({ boxscore: { players: [{
    team: { displayName: 'Boston Celtics' },
    statistics: [{ keys: ['points', 'rebounds', 'assists'], athletes: [
      { athlete: { displayName: `Jrue ${lastName}` }, stats: ['20', '5', '7'], didNotPlay: false },
    ] }],
  }] } });
  installFetch((url) => {
    if (url.includes('/scoreboard')) return { events: [nbaEvent('g1', true), nbaEvent('g2', true)] };
    if (url.includes('/summary')) return nbaSummary('Holiday'); // queried player absent
    return undefined;
  });
  r = await nba.gradeNbaPlayerProp('Jayson Tatum O 25.5 Points', '2026-05-31');
  check('NBA provable absence → VOID', r.resolved === true && r.status === 'VOID', JSON.stringify(r));
  installFetch((url) => {
    if (url.includes('/scoreboard')) return { events: [nbaEvent('g1', true), nbaEvent('g2', false)] }; // one live
    if (url.includes('/summary')) return nbaSummary('Holiday');
    return undefined;
  });
  r = await nba.gradeNbaPlayerProp('Jayson Tatum O 25.5 Points', '2026-05-31');
  check('NBA live game in slate → fall-through', r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── NHL DNP → VOID ──
  console.log(' NHL DNP → VOID:');
  const nhlGame = (id, final) => ({ id, gameState: final ? 'OFF' : 'LIVE', homeTeam: { name: { default: 'Oilers' }, score: 4 }, awayTeam: { name: { default: 'Flames' }, score: 2 } });
  const nhlBox = (boxName) => ({ playerByGameStats: {
    homeTeam: { forwards: [{ name: { default: boxName }, position: 'C', goals: 1 }], defense: [], goalies: [] },
    awayTeam: { forwards: [], defense: [], goalies: [] },
  } });
  installFetch((url) => {
    if (url.includes('/score/')) return { games: [nhlGame('n1', true)] };
    if (url.includes('/gamecenter/')) return nhlBox('L. Draisaitl'); // McDavid absent
    return undefined;
  });
  r = await nhl.gradeNhlPlayerProp('Connor McDavid O 0.5 Goals', '2026-05-31');
  check('NHL provable absence → VOID', r.resolved === true && r.status === 'VOID', JSON.stringify(r));
  installFetch((url) => {
    if (url.includes('/score/')) return { games: [nhlGame('n1', true)] };
    if (url.includes('/gamecenter/')) return THROW; // box-score fetch fails
    return undefined;
  });
  r = await nhl.gradeNhlPlayerProp('Connor McDavid O 0.5 Goals', '2026-05-31');
  check('NHL box-score fetch error → fall-through (no false VOID)', r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── Absence-VOID date gate: created_at vs event_date disagreement ──
  // The structured layer keys the slate off created_at (getBetDate); grading.js's
  // future/too-recent GUARDs key off event_date. A night-before pick (created_at
  // = day N, event_date = N+1) would otherwise VOID against day N's wrong-but-
  // final slate — a false VOID. tryStructured forbids the VOID when the two dates
  // land on different days.
  console.log(' absence-VOID date gate (created_at vs event_date):');
  const provableSlate = (url) => {
    if (url.includes('/schedule')) return mlbSchedule([mlbGame(501, true)]);
    if (url.includes('/feed/live')) return mlbBoxscore(someoneElse); // player absent, slate final
    return undefined;
  };
  installFetch(provableSlate);
  let g = await tryStructured({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB', created_at: '2026-05-30 18:00:00', event_date: '2026-05-31 19:00' });
  check('dates DISAGREE → VOID suppressed, falls through (no false VOID on wrong-day slate)',
    g.resolved === false && g.reason === 'player_not_found_in_games_on_date', JSON.stringify(g));
  installFetch(provableSlate);
  g = await tryStructured({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB', created_at: '2026-05-31 09:00:00', event_date: '2026-05-31 19:00' });
  check('dates AGREE → VOID fires', g.resolved === true && g.status === 'VOID', JSON.stringify(g));
  installFetch(provableSlate);
  g = await tryStructured({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB', created_at: '2026-05-31 09:00:00' }); // no event_date
  check('only one date present → VOID fires (no disagreement)', g.resolved === true && g.status === 'VOID', JSON.stringify(g));
  // Grader-level gate, independent of tryStructured: opts.absenceVoidAllowed===false suppresses.
  installFetch(provableSlate);
  r = await mlb.gradeMlbPlayerProp('Ramon Laureano O 0.5 Hits', '2026-05-30', { absenceVoidAllowed: false });
  check('grader opts.absenceVoidAllowed=false → provable absence falls through (not VOID)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ── Straight DNP prop settles as result=void via finalizeBetGrading ──
  // Confirms the VOID terminal status flows all the way through the settle path:
  // result='void', grade='N/A', profit 0, no capper bankroll effect.
  console.log(' straight DNP VOID settles via finalizeBetGrading:');
  const capper = database.getOrCreateCapper('dnp_user', 'DNP User', null);
  const voidBet = database.createBet({ capper_id: capper.id, sport: 'MLB', bet_type: 'straight', description: 'Ramon Laureano O 0.5 Hits', odds: -110, units: 1, source: 'manual' });
  const fin = await grading.finalizeBetGrading(null, voidBet, 'VOID', 'Ramon Laureano did not appear in any of the 15 MLB games on 2026-05-31 (all final) — no action, void.');
  check('finalize graded the VOID (not a race-loss skip)', fin.graded !== false, JSON.stringify(fin));
  check('finalize profitUnits 0 (void = no action)', fin.profitUnits === 0, JSON.stringify(fin));
  const row = database.db.prepare('SELECT result, grade FROM bets WHERE id = ?').get(voidBet.id);
  check('bets.result = void', row.result === 'void', JSON.stringify(row));
  check('bets.grade = N/A', row.grade === 'N/A', JSON.stringify(row));

  // ── Parlay aggregation: a VOID leg REDUCES, never kills (match aggregator) ──
  console.log(' parlay VOID-reduction semantics (reduceParlayResult):');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('4-leg [WIN,WIN,WIN,VOID] → WIN reduced (Laureano leg drops, 3 decide)',
    eq(reduceParlayResult(['WIN', 'WIN', 'WIN', 'VOID']), { status: 'WIN', reduced: true }));
  check('[VOID,LOSS] → LOSS (a confirmed loss still settles)',
    eq(reduceParlayResult(['VOID', 'LOSS']), { status: 'LOSS', reduced: false }));
  check('[VOID,VOID] → VOID (all legs void)',
    eq(reduceParlayResult(['VOID', 'VOID']), { status: 'VOID', reduced: false }));
  check('[WIN,VOID,PENDING] → PENDING (VOID drops but a pending leg blocks)',
    eq(reduceParlayResult(['WIN', 'VOID', 'PENDING']), { status: 'PENDING', reduced: false }));

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
