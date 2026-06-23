// ═══════════════════════════════════════════════════════════
// EVENT_DATE_SLATE — root-cause fix for the structured-grading slate date.
//
// tryStructured (services/sportsdata/index.js) historically keyed the slate date
// off getBetDate() (created_at-first). grading.js's future/too-recent GUARDs key
// off event_date — so a pick posted the night before / on a back-to-back
// (created_at = day N, event_date = N+1) made the structured layer query the WRONG
// day. The player's game is on N+1, so they read as "absent" from N's slate; the
// DNP band-aids (#128/#129) forbid the VOID and fall through (loop / mis-sweep),
// and a normal prop for a player who played on N+1 isn't found in N's games.
//
// EVENT_DATE_SLATE = off (default) | shadow | enforce:
//   off     — slate = getBetDate() (created_at-first). absenceVoidAllowed =
//             Boolean(eventYMD && createdYMD === eventYMD). Current behavior exactly.
//   shadow  — real result = off behavior; additionally emit one 'slate_shadow'
//             pipeline_events row on the divergent population (the bet's ET GAME
//             date is present and differs from created_at's day). No result change.
//   enforce — slate = eventEtYMD || createdYMD; absenceVoidAllowed = Boolean(eventEtYMD).
//
// CRITICAL: event_date is stored in UTC (.toISOString). The sports-data slates are
// keyed by the GAME's ET date. A ≥8 PM ET game rolls FORWARD a UTC day, so slicing
// the UTC ISO (toYMD) queries the wrong slate. enforce/shadow derive the ET date via
// etParts. The night-before fixtures below use the real prod ISO-Z format with a LATE
// (9:10 PM ET) game so they exercise that roll — toYMD would give the next day, the
// ET derivation gives the real game day.
//
// UNIT test of tryStructured with a DATE-AWARE fetch stub: the router returns
// DIFFERENT final slates for the created_at day vs the event_date (ET) day, so the
// slate the layer actually queries is observable through the graded result. No live
// HTTP. Mirrors the fetch-stub conventions of dnp-terminal-state.test.js.
// ═══════════════════════════════════════════════════════════

const path = require('path');
const os = require('os');
// require('../bets') (the shadow-emit hook, lazy-required inside tryStructured)
// loads database.js, which migrates a DB. Point DB_PATH at a throwaway file so the
// shadow row lands in an isolated SQLite, queryable below.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-slate-${process.pid}.db`);

const { tryStructured } = require('../services/sportsdata');
const database = require('../services/database');   // loads + migrates the throwaway DB

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// ── fetch stub ───────────────────────────────────────────────
const THROW = Symbol('throw');
function installFetch(router) {
  global.fetch = async (url) => {
    const r = router(String(url));
    if (r === THROW) throw new Error('mock network error');
    if (r === undefined) throw new Error(`unrouted URL in test: ${url}`);
    return { ok: true, status: 200, json: async () => r };
  };
}

// ── MLB builders (mirror dnp-terminal-state.test.js) ─────────
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

// Date-aware MLB router. perDay maps 'YYYY-MM-DD' → { games: [pk...], boxes: {pk: players} }.
// Schedule fetch picks the day from the ?date= param; feed/live fetch picks the box
// from the /game/{pk}/ param. A day not in the map returns an EMPTY slate.
function mlbRouter(perDay) {
  return (url) => {
    const dm = url.match(/date=(\d{4}-\d{2}-\d{2})/);
    if (url.includes('/schedule')) {
      const day = dm ? perDay[dm[1]] : null;
      return mlbSchedule((day ? day.games : []).map((pk) => mlbGame(pk, true)));
    }
    const pm = url.match(/\/game\/(\d+)\/feed\/live/);
    if (pm) {
      for (const day of Object.values(perDay)) {
        if (day.boxes && Object.prototype.hasOwnProperty.call(day.boxes, pm[1])) {
          return mlbBoxscore(day.boxes[pm[1]]);
        }
      }
      return mlbBoxscore({}); // empty box for an unknown game
    }
    return undefined;
  };
}

// ── NBA builders ─────────────────────────────────────────────
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
const nbaSummaryFor = (displayName, stats, didNotPlay) => ({ boxscore: { players: [{
  team: { displayName: 'Boston Celtics' },
  statistics: [{ keys: ['points', 'rebounds', 'assists'], athletes: [
    { athlete: { displayName }, stats, didNotPlay, reason: "COACH'S DECISION", active: false },
  ] }],
}] } });

// Date-aware NBA router. perDay maps 'YYYY-MM-DD' → { events: [eventObj...], summaries: {eventId: summaryObj} }.
function nbaRouter(perDay) {
  const byYmd = {};
  for (const [ymd, v] of Object.entries(perDay)) byYmd[ymd.replace(/-/g, '')] = v;
  return (url) => {
    const dm = url.match(/dates=(\d{8})/);
    if (url.includes('/scoreboard')) {
      const day = dm ? byYmd[dm[1]] : null;
      return { events: day ? day.events : [] };
    }
    const em = url.match(/summary\?event=([A-Za-z0-9_]+)/);
    if (em) {
      for (const day of Object.values(perDay)) {
        if (day.summaries && day.summaries[em[1]]) return day.summaries[em[1]];
      }
      return undefined;
    }
    return undefined;
  };
}

// ── NHL builders ─────────────────────────────────────────────
const nhlGame = (id, final) => ({ id, gameState: final ? 'OFF' : 'LIVE', homeTeam: { name: { default: 'Oilers' }, score: 4 }, awayTeam: { name: { default: 'Flames' }, score: 2 } });
const nhlBox = (boxName, goals) => ({ playerByGameStats: {
  homeTeam: { forwards: [{ name: { default: boxName }, position: 'C', goals }], defense: [], goalies: [] },
  awayTeam: { forwards: [], defense: [], goalies: [] },
} });

// Date-aware NHL router. perDay maps 'YYYY-MM-DD' → { games: [id...], boxes: {id: boxscore} }.
function nhlRouter(perDay) {
  return (url) => {
    const dm = url.match(/\/score\/(\d{4}-\d{2}-\d{2})/);
    if (dm) {
      const day = perDay[dm[1]];
      return { games: (day ? day.games : []).map((id) => nhlGame(id, true)) };
    }
    const gm = url.match(/\/gamecenter\/([^/]+)\/boxscore/);
    if (gm) {
      for (const day of Object.values(perDay)) {
        if (day.boxes && Object.prototype.hasOwnProperty.call(day.boxes, gm[1])) return day.boxes[gm[1]];
      }
      return nhlBox('Nobody Here', 0);
    }
    return undefined;
  };
}

// Query slate_shadow rows for a bet id.
function shadowRows(betId) {
  return database.db.prepare(
    `SELECT payload FROM pipeline_events WHERE bet_id = ? AND event_type = 'slate_shadow'`
  ).all(betId);
}
function totalPipelineRows() {
  return database.db.prepare(`SELECT COUNT(*) AS c FROM pipeline_events`).get().c;
}
function setMode(m) {
  if (m == null) delete process.env.EVENT_DATE_SLATE;
  else process.env.EVENT_DATE_SLATE = m;
}

(async () => {
  console.log('event-date-slate:');

  // Shared night-before MLB fixture, in REAL prod format:
  //   created_at = '2026-05-30 18:00:00'  → createdYMD (toYMD) = 2026-05-30
  //   event_date = '2026-06-01T01:10:00.000Z'  (9:10 PM ET on 2026-05-31, a LATE game)
  //       → toYMD (UTC slice) = 2026-06-01  (what the OLD/buggy code would query)
  //       → ET game date       = 2026-05-31  (what enforce must query)
  // The player is ABSENT from the created_at-day slate (2026-05-30) and from the WRONG
  // UTC day (no 2026-06-01 entry), and PLAYED (2 hits) on the real ET game day (2026-05-31).
  const nightBeforeMlbFetch = () => mlbRouter({
    '2026-05-30': { games: [500], boxes: { 500: someoneElse } },   // wrong day (created): absent, final
    '2026-05-31': { games: [501], boxes: { 501: laureano(2) } },   // real ET game day: 2 hits
  });
  const mlbNightBefore = (id) => ({
    id, description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-30 18:00:00', event_date: '2026-06-01T01:10:00.000Z', bet_type: 'straight',
  });

  // ─────────────────────────────────────────────────────────
  // off (default/unset) — current behavior exactly.
  // ─────────────────────────────────────────────────────────
  console.log(' off (default) — unchanged band-aid behavior:');

  setMode('off');
  installFetch(nightBeforeMlbFetch());
  let r = await tryStructured(mlbNightBefore('b-off-nightbefore'));
  check('off: night-before MLB → fall-through (player_not_found, no VOID)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));
  const offNightBefore = r;

  // same-day bet (EARLY game, no UTC roll), true absence → VOID (present + same-day).
  installFetch(mlbRouter({ '2026-05-31': { games: [700], boxes: { 700: someoneElse } } }));
  r = await tryStructured({ id: 'b-off-sameday', description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: '2026-05-31T23:05:00.000Z', bet_type: 'straight' });
  check('off: same-day absence → VOID (unchanged)',
    r.resolved === true && r.status === 'VOID', JSON.stringify(r));

  // null event_date → fall-through (unproven slate forbids the VOID).
  installFetch(mlbRouter({ '2026-05-31': { games: [800], boxes: { 800: someoneElse } } }));
  r = await tryStructured({ id: 'b-off-nullevent', description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: null, bet_type: 'straight' });
  check('off: null event_date → fall-through (no VOID)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // DEFAULT-EQUIVALENCE: unset env === explicit 'off', byte-for-byte.
  setMode(null); // unset entirely
  installFetch(nightBeforeMlbFetch());
  const unsetNightBefore = await tryStructured(mlbNightBefore('b-unset-nightbefore'));
  check('default-equivalence: unset env === off (same result object)',
    JSON.stringify(unsetNightBefore) === JSON.stringify(offNightBefore),
    `${JSON.stringify(unsetNightBefore)} vs ${JSON.stringify(offNightBefore)}`);
  // The off/unset bets above all carry REAL ids, so an off-path emit WOULD write a row.
  // Zero rows proves the off/unset path is truly silent (load-bearing, not vacuous).
  check('default-equivalence: off/unset path wrote ZERO pipeline_events rows (real-id bets)',
    totalPipelineRows() === 0, `count=${totalPipelineRows()}`);

  // ─────────────────────────────────────────────────────────
  // enforce — slate = event_date (ET game day); the actual fix.
  // ─────────────────────────────────────────────────────────
  console.log(' enforce — slate = event_date (ET game day), the corrected behavior:');
  setMode('enforce');

  // night-before bet, player PLAYED on the ET game day → slate=ET event_date → graded.
  // RED under off (falls through above) AND under a UTC-slice slate (would query the
  // empty 2026-06-01 day) — proves BOTH the night-before fix and the UTC-roll fix.
  installFetch(nightBeforeMlbFetch());
  r = await tryStructured(mlbNightBefore('b-enf-nightbefore'));
  check('enforce: night-before MLB (LATE game), played on ET event day → graded WIN',
    r.resolved === true && r.status === 'WIN', JSON.stringify(r));

  // true absence on the ET event_date slate → VOID (event_date present ⟹ trustworthy).
  // created_at day has the player PLAYING (ignored under enforce); the ET event day is a
  // full final slate with the player absent.
  installFetch(mlbRouter({
    '2026-05-30': { games: [510], boxes: { 510: laureano(2) } },   // created day: played (ignored under enforce)
    '2026-05-31': { games: [511], boxes: { 511: someoneElse } },   // ET event day: absent, full final
  }));
  r = await tryStructured(mlbNightBefore('b-enf-absence'));
  check('enforce: true absence on ET event_date slate → VOID',
    r.resolved === true && r.status === 'VOID', JSON.stringify(r));

  // null event_date → fall-through (residual: no event_date to anchor the slate).
  installFetch(mlbRouter({ '2026-05-31': { games: [820], boxes: { 820: someoneElse } } }));
  r = await tryStructured({ id: 'b-enf-nullevent', description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: null, bet_type: 'straight' });
  check('enforce: null event_date → fall-through (residual, unchanged from off)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // same-day → VOID (unchanged: event_date present ⟹ VOID allowed).
  installFetch(mlbRouter({ '2026-05-31': { games: [830], boxes: { 830: someoneElse } } }));
  r = await tryStructured({ id: 'b-enf-sameday', description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: '2026-05-31T23:05:00.000Z', bet_type: 'straight' });
  check('enforce: same-day absence → VOID (unchanged)',
    r.resolved === true && r.status === 'VOID', JSON.stringify(r));

  // back-to-back NBA: DNP on created_at day but PLAYS the ET event_date game → graded,
  // NO wrong VOID. (RED under off: off → dnp_date_unconfirmed fall-through.)
  console.log(' enforce — NBA back-to-back DNP/plays:');
  const b2bNbaFetch = () => nbaRouter({
    '2026-05-30': { events: [nbaEvent('gA', true)], summaries: { gA: nbaSummaryFor('Jayson Tatum', [], true) } },           // DNP that day
    '2026-05-31': { events: [nbaEvent('gB', true)], summaries: { gB: nbaSummaryFor('Jayson Tatum', ['30', '5', '7'], false) } }, // played, 30 pts
  });
  const nbaBet = (id) => ({ id, description: 'Jayson Tatum O 25.5 Points', sport: 'NBA',
    created_at: '2026-05-30 22:00:00', event_date: '2026-06-01T01:30:00.000Z', bet_type: 'straight' }); // 9:30 PM ET 2026-05-31
  installFetch(b2bNbaFetch());
  r = await tryStructured(nbaBet('b-enf-nba-b2b'));
  check('enforce: NBA back-to-back, DNP on created_at but plays ET event day → graded WIN',
    r.resolved === true && r.status === 'WIN', JSON.stringify(r));

  // NHL coverage (the third structured sport): player PLAYED on the ET event day → graded.
  console.log(' enforce — NHL slate routing:');
  const nhlFetch = () => nhlRouter({
    '2026-05-30': { games: ['n0'], boxes: { n0: nhlBox('R. Laureano', 0) } },     // created day: queried player absent
    '2026-05-31': { games: ['n1'], boxes: { n1: nhlBox('C. McDavid', 1) } },      // ET event day: 1 goal
  });
  const nhlBet = (id) => ({ id, description: 'Connor McDavid O 0.5 Goals', sport: 'NHL',
    created_at: '2026-05-30 20:00:00', event_date: '2026-06-01T01:00:00.000Z', bet_type: 'straight' }); // 9 PM ET 2026-05-31
  installFetch(nhlFetch());
  r = await tryStructured(nhlBet('b-enf-nhl'));
  check('enforce: NHL, played on ET event day → graded WIN (slate reaches NHL adapter)',
    r.resolved === true && r.status === 'WIN', JSON.stringify(r));

  // ── RED proofs: same fixtures under off must NOT grade (proves the change is real) ──
  console.log(' RED proofs (same fixtures, off → fall-through):');
  setMode('off');
  installFetch(b2bNbaFetch());
  r = await tryStructured(nbaBet('b-red-nba'));
  check('RED: NBA back-to-back under off → fall-through (dnp_date_unconfirmed)',
    r.resolved === false && r.reason === 'dnp_date_unconfirmed', JSON.stringify(r));
  installFetch(nightBeforeMlbFetch());
  r = await tryStructured(mlbNightBefore('b-red-mlb'));
  check('RED: night-before MLB under off → fall-through (player_not_found)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));
  installFetch(nhlFetch());
  r = await tryStructured(nhlBet('b-red-nhl'));
  check('RED: NHL under off → fall-through (player_not_found)',
    r.resolved === false && r.reason === 'player_not_found_in_games_on_date', JSON.stringify(r));

  // ─────────────────────────────────────────────────────────
  // shadow — result unchanged + telemetry on the divergent population.
  // ─────────────────────────────────────────────────────────
  console.log(' shadow — measure-only, result == off:');
  setMode('shadow');

  // divergent bet (created day ≠ ET event day) → result unchanged (= off fall-through)
  // AND one slate_shadow row whose event_ymd is the ET game date (2026-05-31), NOT the
  // UTC-rolled 2026-06-01.
  const shadowBetId = 'b-shadow-divergent';
  installFetch(nightBeforeMlbFetch());
  r = await tryStructured(mlbNightBefore(shadowBetId));
  check('shadow: divergent bet result unchanged (= off fall-through)',
    JSON.stringify(r) === JSON.stringify(offNightBefore), JSON.stringify(r));
  const rows = shadowRows(shadowBetId);
  check('shadow: exactly one slate_shadow event emitted for the divergent bet',
    rows.length === 1, `rows=${rows.length}`);
  if (rows.length === 1) {
    let p = {};
    try { p = JSON.parse(rows[0].payload); } catch (_) { /* leave {} */ }
    check('shadow: payload uses the ET game date {created_ymd:2026-05-30, event_ymd:2026-05-31}',
      p.bet_id === shadowBetId && p.created_ymd === '2026-05-30' && p.event_ymd === '2026-05-31'
        && p.sport === 'MLB' && p.bet_type === 'straight', JSON.stringify(p));
  } else {
    check('shadow: payload check (skipped — wrong row count)', false);
  }

  // same-day bet (EARLY game) → NO event emitted (ET event day == created day).
  const sameDayId = 'b-shadow-sameday';
  installFetch(mlbRouter({ '2026-05-31': { games: [900], boxes: { 900: someoneElse } } }));
  r = await tryStructured({ id: sameDayId, description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: '2026-05-31T23:05:00.000Z', bet_type: 'straight' });
  check('shadow: same-day (early) bet still VOIDs (off behavior, result unchanged)',
    r.resolved === true && r.status === 'VOID', JSON.stringify(r));
  check('shadow: same-day (early) bet emits NO slate_shadow event',
    shadowRows(sameDayId).length === 0, `rows=${shadowRows(sameDayId).length}`);

  // OVER-COUNT REGRESSION: a LATE game on the SAME ET day as created_at. The UTC slice
  // (2026-06-01) differs from created (2026-05-31), so the buggy predicate WOULD emit;
  // the ET date (2026-05-31) equals created → it must NOT emit.
  const lateSameDayId = 'b-shadow-sameday-late';
  installFetch(mlbRouter({ '2026-05-31': { games: [905], boxes: { 905: someoneElse } } }));
  r = await tryStructured({ id: lateSameDayId, description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: '2026-06-01T01:10:00.000Z', bet_type: 'straight' }); // 9:10 PM ET 2026-05-31
  check('shadow: LATE same-ET-day bet emits NO slate_shadow event (no UTC-roll over-count)',
    shadowRows(lateSameDayId).length === 0, `rows=${shadowRows(lateSameDayId).length}`);

  // null event_date under shadow → NO event (no ET event date to diverge).
  const nullEvId = 'b-shadow-nullevent';
  installFetch(mlbRouter({ '2026-05-31': { games: [910], boxes: { 910: someoneElse } } }));
  r = await tryStructured({ id: nullEvId, description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB',
    created_at: '2026-05-31 12:00:00', event_date: null, bet_type: 'straight' });
  check('shadow: null event_date emits NO slate_shadow event',
    shadowRows(nullEvId).length === 0, `rows=${shadowRows(nullEvId).length}`);

  setMode(null);
  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
