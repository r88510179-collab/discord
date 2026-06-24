// ═══════════════════════════════════════════════════════════
// ESPN soccer adapter — match-level grading + shadow gating.
//
// Validates services/sportsdata/soccer.js (gradeSoccerBet) against mocked ESPN
// scoreboard JSON, and the SOCCER_GRADER_MODE dispatch (off/shadow/enforce) via
// services/sportsdata/index.js tryStructured.
//
// Covers (prompts/build1-soccer-adapter.md §12):
//   ML win/loss, 3-way draw, double chance, FT total O/U, team total,
//   spread/handicap, BTTS yes/no, GOTCHA #1 (penalty match graded by winner not
//   score), not-final fall-through, no-match / ambiguous fall-through,
//   player-prop fall-through, and mode gating (off no-op / shadow emits +
//   falls through with NO grade / enforce returns the resolved status).
//
// Run:  node tests/soccer-grader.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

// ── Stub services/bets BEFORE requiring sportsdata, so the shadow emit
//    (emitSoccerShadow → require('../bets').transitionTo) is captured without a
//    real DB. index.js lazy-requires bets only at emit time, so this is in place. ──
const betsPath = require.resolve('../services/bets');
let transitionCalls = [];
require.cache[betsPath] = {
  id: betsPath, filename: betsPath, loaded: true, children: [], exports: {
    transitionTo: (a) => { transitionCalls.push(a); return true; },
  },
};

const soccer = require('../services/sportsdata/soccer');
const sportsdata = require('../services/sportsdata');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`); fail++; }
}

// ── Fixture builders (real ESPN field shape) ─────────────────────────────────
function team(displayName, abbreviation, extra = {}) {
  return {
    displayName,
    shortDisplayName: extra.short || displayName,
    abbreviation,
    name: extra.name || displayName,
    location: extra.location || displayName,
  };
}
// competitor with optional per-half linescores [h1, h2]
function comp(homeAway, t, score, winner, linescores) {
  const c = { homeAway, winner, score: String(score), team: t };
  if (linescores) c.linescores = linescores.map(v => ({ value: v }));
  return c;
}
function event(id, home, away, opts = {}) {
  const statusName = opts.statusName || 'STATUS_FULL_TIME';
  const completed = opts.completed !== false;
  const type = { name: statusName, completed };
  return {
    id,
    status: { type },
    competitions: [{ status: { type }, competitors: [home, away] }],
  };
}

const T = {
  usa: team('United States', 'USA', { short: 'USA' }),
  par: team('Paraguay', 'PAR'),
  den: team('Denmark', 'DEN'),
  tun: team('Tunisia', 'TUN'),
  arg: team('Argentina', 'ARG'),
  fra: team('France', 'FRA'),
  esp: team('Spain', 'ESP'),
  ger: team('Germany', 'GER'),
  bih: team('Bosnia-Herzegovina', 'BIH', { short: 'Bosnia-Herz' }),
  can: team('Canada', 'CAN'),
  mex: team('Mexico', 'MEX'),
  bra: team('Brazil', 'BRA'),
  jpn: team('Japan', 'JPN'),
};

// All fixtures live on 2026-06-12 (ESPN date 20260612) unless noted.
const MAIN = '20260612';
const SCOREBOARDS = {
  [MAIN]: [
    // United States 4-1 Paraguay (home win), with 1H linescores 1-0 → 1H total 1
    event('m-usa',
      comp('home', T.usa, 4, true, [1, 3]),
      comp('away', T.par, 1, false, [0, 1])),
    // Denmark 0-0 Tunisia (draw)
    event('m-draw', comp('home', T.den, 0, false), comp('away', T.tun, 0, false)),
    // Argentina 3-3 France, ARG win on penalties (GOTCHA #1)
    event('m-pen',
      comp('home', T.arg, 3, true),
      comp('away', T.fra, 3, false),
      { statusName: 'STATUS_FINAL_PEN' }),
    // Bosnia-Herzegovina 1-1 Canada (draw) — alias + hyphen-name matching
    event('m-bih', comp('home', T.bih, 1, false), comp('away', T.can, 1, false)),
    // Spain vs Germany — NOT final
    event('m-live', comp('home', T.esp, 1, false), comp('away', T.ger, 0, false),
      { statusName: 'STATUS_FIRST_HALF', completed: false }),
    // Two events both featuring Mexico → ambiguous resolution
    event('m-amb1', comp('home', T.mex, 2, true), comp('away', T.jpn, 0, false)),
    event('m-amb2', comp('home', T.bra, 1, false), comp('away', T.mex, 1, false)),
  ],
};

// ── Player-prop SUMMARY fixtures (Build 1b) ──────────────────────────────────
// Real ESPN summary shape: rosters[].roster[].{athlete,position,starter,subbedIn,
// stats[name/value]} + keyEvents[] (scoringPlay/type/clock/participants) +
// header.competitions[0].{status,competitors[score]}.
function pstat(obj) { return Object.entries(obj).map(([name, value]) => ({ name, value })); }
function pl(id, displayName, opts = {}) {
  const last = opts.lastName || displayName.split(' ').slice(-1)[0];
  return {
    athlete: { id, displayName, fullName: opts.fullName || displayName, lastName: last, shortName: opts.shortName || displayName },
    position: { abbreviation: opts.gk ? 'G' : (opts.pos || 'F'), name: opts.gk ? 'Goalkeeper' : 'Forward' },
    starter: opts.starter !== undefined ? opts.starter : !opts.dnp,
    subbedIn: !!opts.subbedIn,
    stats: pstat(Object.assign(
      { appearances: opts.dnp ? 0 : 1, totalShots: 0, shotsOnTarget: 0, totalGoals: 0, goalAssists: 0 },
      opts.gk ? { saves: opts.saves != null ? opts.saves : 0 } : {},
      opts.stats || {},
    )),
  };
}
function ros(team, abbr, homeAway, players) {
  return { homeAway, team: { displayName: team, shortDisplayName: team, name: team, abbreviation: abbr }, roster: players };
}
// scorer/assist keyEvent. type: 'goal'(70) | 'penalty'(98) | 'own'(97).
function goal(scorerId, assistId, clockVal, type = 'goal') {
  const T = { goal: { id: '70', text: 'Goal', type: 'goal' }, penalty: { id: '98', text: 'Penalty - Scored', type: 'penalty---scored' }, own: { id: '97', text: 'Own Goal', type: 'own-goal' } }[type];
  const participants = [{ athlete: { id: scorerId } }];
  if (assistId) participants.push({ athlete: { id: assistId } });
  return { type: T, clock: { value: clockVal, displayValue: `${Math.round(clockVal / 60)}'` }, scoringPlay: true, participants };
}
function summary(homeRos, awayRos, keyEvents, homeScore, awayScore, completed = true) {
  const type = completed ? { name: 'STATUS_FULL_TIME', state: 'post', completed: true } : { name: 'STATUS_FIRST_HALF', state: 'in', completed: false };
  return {
    rosters: [homeRos, awayRos],
    keyEvents,
    header: {
      competitions: [{
        status: { type },
        competitors: [
          { homeAway: 'home', score: String(homeScore), team: homeRos.team },
          { homeAway: 'away', score: String(awayScore), team: awayRos.team },
        ],
      }],
    },
  };
}

// pe-1: Netherlands 3-1 Sweden (completed). Brobbey 2 goals (one a penalty) + 1
// assisted-by; Gakpo 1 goal + 1 assist. Verbruggen GK 5 saves, Nordfeldt GK 2.
// 'Wesley Bench' is an unused sub (DNP). 'Karl Garcia' shares the Garcia surname
// with pe-2's 'Luis Garcia' (cross-match collision).
const NED = ros('Netherlands', 'NED', 'home', [
  pl('v1', 'Bart Verbruggen', { gk: true, saves: 5 }),
  pl('b1', 'Brian Brobbey', { stats: { totalShots: 4, shotsOnTarget: 3, totalGoals: 2, goalAssists: 1 } }),
  pl('g1', 'Cody Gakpo', { stats: { totalShots: 2, shotsOnTarget: 1, totalGoals: 1, goalAssists: 1 } }),
  pl('z1', 'Wesley Bench', { dnp: true }),
]);
const SWE = ros('Sweden', 'SWE', 'away', [
  pl('n1', 'Kristoffer Nordfeldt', { gk: true, saves: 2 }),
  pl('i1', 'Alexander Isak', { stats: { totalShots: 2, shotsOnTarget: 1, totalGoals: 1 } }),
  pl('s1', 'Karl Garcia', { lastName: 'Garcia', stats: { totalShots: 1 } }),
]);
const PE1 = summary(NED, SWE, [
  goal('b1', 'g1', 300),   // 5'  Brobbey (assist Gakpo)
  goal('b1', null, 1020, 'penalty'), // 17' Brobbey penalty (counts)
  goal('g1', 'b1', 1800),  // 30' Gakpo (assist Brobbey)
  goal('i1', null, 4200),  // 70' Isak (SWE)
], 3, 1);

// pe-2: Argentina 2-0 Mexico (completed). First goal is an OWN GOAL by Mexico's
// 'Hugo Vargas'; Messi scores the 2nd (regular). Two 'Lopez' players in Mexico
// (within-match collision). 'Luis Garcia' (ARG) collides with pe-1's Garcia.
const ARG = ros('Argentina', 'ARG', 'home', [
  pl('k1', 'Damian Keeper', { gk: true, saves: 1 }),
  pl('m1', 'Lionel Messi', { stats: { totalShots: 5, shotsOnTarget: 3, totalGoals: 1, goalAssists: 0 } }),
  pl('ga', 'Luis Garcia', { lastName: 'Garcia', stats: { totalShots: 2 } }),
]);
const MEX = ros('Mexico', 'MEX', 'away', [
  pl('k2', 'Memo Ochoa', { gk: true, saves: 4 }),
  pl('vg', 'Hugo Vargas', { stats: { totalShots: 1 } }),       // scored the own goal
  pl('l1', 'Hirving Lopez', { lastName: 'Lopez', stats: { totalShots: 1 } }),
  pl('l2', 'Andres Lopez', { lastName: 'Lopez', stats: { totalShots: 0 } }),
]);
const PE2 = summary(ARG, MEX, [
  goal('vg', null, 1200, 'own'),  // 20' OWN GOAL (excluded from goalscorer)
  goal('m1', null, 3000),         // 50' Messi (first REGULAR scorer)
], 2, 0);

// pe-3: Spain vs Germany — NOT final. 'Pedri' is only on this card.
const ESP = ros('Spain', 'ESP', 'home', [
  pl('kp', 'Unai Keeper', { gk: true, saves: 0 }),
  pl('pd', 'Pedri Gonzalez', { lastName: 'Pedri', shortName: 'Pedri', stats: { totalShots: 1 } }),
]);
const GER = ros('Germany', 'GER', 'away', [pl('kg', 'Marc Keeper', { gk: true, saves: 0 })]);
const PE3 = summary(ESP, GER, [], 0, 0, false);

// pe-4: completed 2-0 but only ONE scoring keyEvent recorded (data gap) → the
// keyEvents-completeness guard must refuse goalscorer markets here.
const GAP_A = ros('Gapland', 'GAP', 'home', [pl('ss', 'Solo Striker', { stats: { totalGoals: 2, totalShots: 3 } })]);
const GAP_B = ros('Holeton', 'HOL', 'away', [pl('hk', 'Hole Keeper', { gk: true, saves: 3 })]);
const PE4 = summary(GAP_A, GAP_B, [goal('ss', null, 1500)], 2, 0); // 1 event vs scoreline 2

// pe-5: completed 0-0 (no scoring events) → a First Goalscorer prop has no regular
// scorer to settle against → refuse (don't guess LOSS/void on an all-blank match).
const NIL_A = ros('Nilville', 'NIL', 'home', [pl('zh', 'Zero Hero', { stats: { totalShots: 2 } })]);
const NIL_B = ros('Blankton', 'BLK', 'away', [pl('bk', 'Blank Keeper', { gk: true, saves: 6 })]);
const PE5 = summary(NIL_A, NIL_B, [], 0, 0, true);

const SUMMARIES = {
  'pe-1': PE1, 'pe-2': PE2, 'pe-3': PE3, 'pe-4': PE4, 'pe-5': PE5,
};
// Add the prop slate (ESPN date 20260620) to the scoreboard map. Match-level
// fields (competitors/status) let resolveMatch + the team filter narrow events;
// the prop path fetches the summaries above by event id.
function sbEvent(id, home, hAbbr, away, aAbbr, completed) {
  const type = { name: completed ? 'STATUS_FULL_TIME' : 'STATUS_FIRST_HALF', completed: !!completed };
  return {
    id,
    status: { type },
    competitions: [{ status: { type }, competitors: [
      comp('home', team(home, hAbbr), 0, false), comp('away', team(away, aAbbr), 0, false),
    ] }],
  };
}
SCOREBOARDS['20260620'] = [
  sbEvent('pe-1', 'Netherlands', 'NED', 'Sweden', 'SWE', true),
  sbEvent('pe-2', 'Argentina', 'ARG', 'Mexico', 'MEX', true),
  sbEvent('pe-3', 'Spain', 'ESP', 'Germany', 'GER', false),
  sbEvent('pe-4', 'Gapland', 'GAP', 'Holeton', 'HOL', true),
  sbEvent('pe-5', 'Nilville', 'NIL', 'Blankton', 'BLK', true),
];
// Isolated slate to exercise the summary-fetch-error → fetch_error branch.
SCOREBOARDS['20260701'] = [sbEvent('pe-err', 'Chile', 'CHI', 'Peru', 'PER', true)];

// Mock global fetch: dispatch SUMMARY (event=) vs scoreboard (dates=). The
// 'pe-err' summary throws (HTTP 500) to drive the fetch_error path.
let fetchCount = 0;
function installFetch() {
  fetchCount = 0;
  global.fetch = async (url) => {
    fetchCount++;
    const s = String(url);
    const sm = s.match(/summary\?event=([\w-]+)/);
    if (sm) {
      const id = sm[1];
      if (id === 'pe-err') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => (SUMMARIES[id] || {}) };
    }
    const m = s.match(/dates=(\d{8})/);
    const ymd = m ? m[1] : null;
    const events = (ymd && SCOREBOARDS[ymd]) || [];
    return { ok: true, json: async () => ({ events }) };
  };
}

const D = '2026-06-12';
async function grade(desc) { return soccer.gradeSoccerBet(desc, D); }

(async () => {
  installFetch();

  // ── Moneyline (3-way win; draw loses) ──
  check('ML win', (await grade('USA ML')).status === 'WIN');
  check('ML loss (opponent)', (await grade('Paraguay ML')).status === 'LOSS');
  check('ML via full name', (await grade('United States ML')).status === 'WIN');
  // ML on a draw → LOSS (3-way: draw is not a win)
  check('ML on draw → LOSS', (await grade('Denmark ML')).status === 'LOSS');

  // ── GOTCHA #1: penalty-decided match graded by winner, not equal score ──
  {
    const r = await grade('Argentina ML');
    check('penalty: ML winner=WIN (not draw)', r.resolved && r.status === 'WIN', r);
  }
  check('penalty: losing side ML=LOSS', (await grade('France ML')).status === 'LOSS');
  check('penalty: Draw pick=LOSS (there is a winner)',
    (await grade('Argentina vs France Draw')).status === 'LOSS');

  // ── 3-way draw ──
  check('draw pick WIN (0-0)', (await grade('Denmark vs Tunisia Draw')).status === 'WIN');
  check('draw pick LOSS (decisive)', (await grade('USA vs Paraguay Draw')).status === 'LOSS');

  // ── Double chance ──
  check('DC "Team or Draw" WIN', (await grade('USA or Draw')).status === 'WIN');
  check('DC "Team or Draw" LOSS', (await grade('Paraguay or Draw')).status === 'LOSS');
  check('DC code 1X WIN (home or draw)', (await grade('USA vs Paraguay 1X')).status === 'WIN');
  check('DC code X2 on home win → LOSS', (await grade('USA vs Paraguay X2')).status === 'LOSS');
  check('DC "or Draw" on actual draw → WIN', (await grade('Denmark or Draw')).status === 'WIN');

  // ── FT total over / under ──
  check('FT total over WIN (4+1=5 > 2.5)', (await grade('USA vs Paraguay Over 2.5')).status === 'WIN');
  check('FT total under LOSS', (await grade('United States vs Paraguay Under 2.5')).status === 'LOSS');
  check('FT total under WIN (1+1=2 < 2.5)', (await grade('Bosnia-Herzegovina vs Canada Under 2.5')).status === 'WIN');
  check('FT total PUSH', (await grade('Bosnia-Herzegovina vs Canada Over 2')).status === 'PUSH');

  // ── Team total ──
  check('team total over WIN', (await grade('USA Team Total Over 1.5')).status === 'WIN');
  check('team total under WIN', (await grade('Paraguay Team Goals Under 1.5')).status === 'WIN');
  check('team total under LOSS', (await grade('USA Team Total Under 3.5')).status === 'LOSS');

  // ── Spread / handicap ──
  check('spread cover WIN', (await grade('Bosnia +0.5')).status === 'WIN'); // 1-1, +0.5 → +0.5
  check('spread no-cover LOSS', (await grade('Canada -1.5')).status === 'LOSS');
  check('spread favorite cover WIN', (await grade('USA -1.5')).status === 'WIN'); // +3 -1.5 = +1.5
  check('spread PUSH (whole line)', (await grade('Bosnia-Herzegovina +0')).status === 'PUSH'); // 1-1, +0 → 0
  check('quarter (Asian split) line → fall through',
    !(await grade('USA -0.25')).resolved && (await grade('USA -0.25')).reason === 'unsupported_line');

  // ── BTTS ──
  check('BTTS Yes WIN', (await grade('USA vs Paraguay Both teams to score - Yes')).status === 'WIN');
  check('BTTS Yes LOSS (0-0)', (await grade('Denmark vs Tunisia Both teams to score Yes')).status === 'LOSS');
  check('BTTS No WIN (0-0)', (await grade('Denmark vs Tunisia BTTS No')).status === 'WIN');
  check('BTTS No LOSS (both scored)', (await grade('USA vs Paraguay BTTS No')).status === 'LOSS');

  // ── Half totals (linescores present in fixture) ──
  check('1H total under WIN (1H goals=1 < 1.5)', (await grade('USA vs Paraguay 1H Under 1.5')).status === 'WIN');
  check('1H total over LOSS', (await grade('USA vs Paraguay 1H Over 1.5')).status === 'LOSS');
  // The fixture's draw match has no linescores → half market falls through.
  check('half total without linescores → fall through',
    (await grade('Denmark vs Tunisia 1H Over 0.5')).reason === 'no_linescores');

  // ── Not final → match_not_final (bet stays pending) ──
  {
    const r = await grade('Spain ML');
    check('not final → match_not_final fall-through', !r.resolved && r.reason === 'match_not_final', r);
    check('not final carries match_id', r.match_id === 'm-live', r.match_id);
  }

  // ── No match / ambiguous ──
  // Brazil is on the slate (vs Mexico) but the named opponent "Italy" is not —
  // the matchup-integrity guard must refuse rather than grade Brazil's real game.
  check('named matchup with wrong opponent → no_match_found',
    (await grade('Brazil vs Italy ML')).reason === 'no_match_found');
  check('unknown team → no_match_found', (await grade('Italy ML')).reason === 'no_match_found');
  check('ambiguous (Mexico in two events) → no_match_found',
    (await grade('Mexico ML')).reason === 'no_match_found');

  // ── Unsupported overlays / non-confirmed player markets → fall through ──
  // (CONFIRMED props — shots/SoT/saves/goalscorer/score-or-assist — are now
  //  graded; see the player-prop section below. These remain unsupported.)
  check('bare "to score" (not anytime/score-or-assist) → unsupported',
    (await grade('Lionel Messi to score')).reason === 'unsupported_market_soccer');
  check('player cards prop → unsupported',
    (await grade('Christian Pulisic 1+ Cards')).reason === 'unsupported_market_soccer');
  check('last goalscorer (excluded market) → unsupported',
    (await grade('Harry Kane Last Goalscorer')).reason === 'unsupported_market_soccer');
  check('2-Up overlay → unsupported',
    (await grade('USA 2-Up early payout')).reason === 'unsupported_market_soccer');
  check('draw no bet (out of scope) → unsupported',
    (await grade('USA Draw No Bet')).reason === 'unsupported_market_soccer');
  check('corners (unsupported side market) → unsupported',
    (await grade('USA vs Paraguay Over 9.5 Corners')).reason === 'unsupported_market_soccer');
  // A confirmed-market phrasing with NO threshold still won't false-grade — it
  // routes to the prop path and falls through (here: no team/player on the MAIN
  // slate → player_not_found), NEVER a guess.
  check('shots-on-target w/o threshold does not error',
    !(await grade('Vinicius Junior Shots on Target')).resolved);

  // ── Odds-carrying picks must NOT be parsed as a goal line (review blocker #2) ──
  check('ML with parenthesized odds → WIN (not a -150 handicap)', (await grade('USA ML (-150)')).status === 'WIN');
  check('ML with bare odds → WIN', (await grade('USA ML -150')).status === 'WIN');
  check('to-win with bare odds → WIN', (await grade('United States to win -200')).status === 'WIN');
  check('losing ML with +odds → LOSS', (await grade('Paraguay ML +200')).status === 'LOSS');
  check('real handicap survives trailing odds', (await grade('USA -1.5 (-150)')).status === 'WIN'); // +3 -1.5 = +1.5
  check('opponent handicap + odds → LOSS', (await grade('Paraguay +0.5 (-115)')).status === 'LOSS'); // -3 +0.5 < 0

  // ── Stray "12" (dates / numbers) must NOT hijack double chance (review blocker #1) ──
  check('"ML 12" does NOT become double chance → real ML grades', (await grade('Paraguay ML 12')).status === 'LOSS');
  check('date token "Jun 12" does not hijack ML', (await grade('USA ML Jun 12')).status === 'WIN');
  check('date token does not hijack a total', (await grade('USA vs Paraguay Under 0.5 Jun 12')).status === 'LOSS');
  // Explicit double-chance "12" code still works WITH the phrase:
  check('explicit "Double Chance 12" → home/away WIN', (await grade('USA vs Paraguay Double Chance 12')).status === 'WIN');

  // ── Two-team asymmetric subject (review minor #3): opponent named first ──
  check('repeated pick team is the subject ("Paraguay vs USA USA -1.5")', (await grade('Paraguay vs USA USA -1.5')).status === 'WIN');
  check('repeated pick team ML', (await grade('Paraguay vs USA USA ML')).status === 'WIN');
  check('single-mention each + asymmetric line → ambiguous fall-through',
    (await grade('USA vs Paraguay -1.5')).reason === 'no_subject_team');

  // ── Result shape contract ──
  {
    const r = await grade('USA ML');
    check('win result shape', r.resolved === true && r.source === 'espn_soccer' && r.match_id === 'm-usa' && typeof r.evidence === 'string', r);
  }
  check('bad input → fall through, no throw',
    (await soccer.gradeSoccerBet('', D)).reason === 'bad_input'
    && (await soccer.gradeSoccerBet('USA ML', '')).reason === 'bad_input');

  // ═══════════════ PLAYER PROPS (Build 1b) — mocked SUMMARY ═══════════════
  // Prop slate is 20260620 (pe-1 NED 3-1 SWE, pe-2 ARG 2-0 MEX, pe-3 ESP-GER live).
  const PD = '2026-06-20';
  async function gradeP(desc) { return soccer.gradeSoccerBet(desc, PD, { slug: 'fifa.world' }); }

  // ── Shots / Shots on Target (totalShots / shotsOnTarget) ──
  check('shots N+ WIN (Brobbey totalShots 4 ≥ 3)', (await gradeP('Brian Brobbey 3+ Shots')).status === 'WIN');
  check('shots N+ LOSS (Isak totalShots 2 < 3)', (await gradeP('Alexander Isak 3+ Shots')).status === 'LOSS');
  check('shots "N or more" form', (await gradeP('Brian Brobbey 1 or more shots')).status === 'WIN');
  check('SoT over WIN (Brobbey SoT 3 > 2.5)', (await gradeP('Brian Brobbey Over 2.5 Shots on Target')).status === 'WIN');
  check('SoT over LOSS (3 < 3.5)', (await gradeP('Brian Brobbey Over 3.5 Shots on Target')).status === 'LOSS');
  check('SoT over PUSH-impossible .5 / under WIN', (await gradeP('Alexander Isak Under 1.5 Shots on Target')).status === 'WIN');
  check('SoT "Player To Have 1 Or More" → WIN', (await gradeP('Cody Gakpo Player To Have 1 Or More Shots On Target')).status === 'WIN');

  // ── Goalkeeper saves (saves) — named keeper AND team-keeper ──
  check('named keeper saves N+ WIN (Verbruggen 5 ≥ 3)', (await gradeP('Bart Verbruggen 3+ Saves')).status === 'WIN');
  check('saves over LOSS (5 < 6.5)', (await gradeP('Bart Verbruggen Over 6.5 Saves')).status === 'LOSS');
  check('team-keeper WIN (Netherlands GK 5 ≥ 3)', (await gradeP('Netherlands Goalkeeper 3+ Saves')).status === 'WIN');
  check('team-keeper LOSS (Sweden GK 2 < 3)', (await gradeP('Sweden Goalkeeper to make 3 or more saves')).status === 'LOSS');
  check('saves prop on an OUTFIELDER → player_stat_missing (no false LOSS)',
    (await gradeP('Brian Brobbey 2+ Saves')).reason === 'player_stat_missing');

  // ── Anytime / First goalscorer (keyEvents; penalty counts, own goal excluded) ──
  check('anytime WIN (Brobbey scored)', (await gradeP('Brian Brobbey Anytime Goalscorer')).status === 'WIN');
  check('anytime LOSS (keeper played, 0 goals)', (await gradeP('Bart Verbruggen Anytime Goalscorer')).status === 'LOSS');
  check('penalty counts (Brobbey 2 incl. penalty) — anytime WIN', (await gradeP('Brian Brobbey ANYTIME GOALSCORER')).status === 'WIN');
  check('first goalscorer WIN (Brobbey first at 5\')', (await gradeP('Brian Brobbey First Goalscorer')).status === 'WIN');
  check('first goalscorer LOSS (Gakpo not first)', (await gradeP('Cody Gakpo First Goalscorer')).status === 'LOSS');
  // OWN GOAL excluded: Messi's regular 50' goal is the first REGULAR scorer; the
  // 20' own goal (by Vargas) is skipped for both anytime & first.
  check('anytime via penalty/regular, own goal skipped — Messi WIN', (await gradeP('Lionel Messi Anytime Goalscorer')).status === 'WIN');
  check('own-goal scorer is NOT credited → anytime LOSS', (await gradeP('Hugo Vargas Anytime Goalscorer')).status === 'LOSS');
  check('first goalscorer skips own goal → Messi WIN', (await gradeP('Lionel Messi First Goalscorer')).status === 'WIN');

  // ── To score or assist (scorer OR assister; N+ combined) ──
  check('to score or assist WIN (Gakpo 1g+1a)', (await gradeP('Cody Gakpo to score or assist')).status === 'WIN');
  check('to score or give assist WIN', (await gradeP('Cody Gakpo to Score or Give Assist')).status === 'WIN');
  check('2+ score or assist WIN (Brobbey 2g+1a=3)', (await gradeP('Brian Brobbey 2+ Score or Assist')).status === 'WIN');
  check('2+ score or assist LOSS (Isak 1g+0a=1)', (await gradeP('Alexander Isak 2+ Score or Assist')).status === 'LOSS');

  // ── DNP → VOID (Smokke rule #128/#129: never LOSS) ──
  {
    const r = await gradeP('Wesley Bench 1+ Shots');
    check('DNP unused sub → VOID (not LOSS)', r.resolved && r.status === 'VOID', r);
    check('DNP VOID applies to goalscorer too', (await gradeP('Wesley Bench Anytime Goalscorer')).status === 'VOID');
  }

  // ── Wrong-PLAYER guards (the headline risk) → fall through, NEVER a false grade ──
  check('cross-match surname collision → no_unique_player (Garcia: NED & ARG)',
    (await gradeP('Garcia Anytime Goalscorer')).reason === 'no_unique_player');
  check('within-match surname collision → no_unique_player (two Lopez in MEX)',
    (await gradeP('Lopez 1+ Shots')).reason === 'no_unique_player');
  check('full name disambiguates a colliding surname (Hirving Lopez resolves)',
    (await gradeP('Hirving Lopez 1+ Shots')).resolved === true);
  check('player not on any roster → player_not_found',
    (await gradeP('Cristiano Ronaldo Anytime Goalscorer')).reason === 'player_not_found');
  check('accent-folded + suffix match (Pedri found on live card)',
    (await gradeP('Pedri 1+ Shots')).reason === 'match_not_final');
  // Team-narrowing MISFIRE recovery: a wrong opponent tag ("(vs Germany)" — Ochoa
  // plays Mexico, not Germany) narrows to the Germany card where Ochoa is absent;
  // the full-slate fall-back still finds him (NO false player_not_found).
  check('team-narrow zero-match falls back to full slate',
    (await gradeP('Memo Ochoa 1+ Saves (vs Germany)')).status === 'WIN');
  // Empty subject (a team/match SoT total, not a player prop) → unsupported.
  check('no-subject "Over 9.5 Shots on Target" → unsupported (not player_not_found)',
    (await gradeP('Over 9.5 Shots on Target')).reason === 'unsupported_market_soccer');

  // ── Match not final → match_not_final (carries match_id) ──
  {
    const r = await gradeP('Pedri Gonzalez Anytime Goalscorer');
    check('not-final prop → match_not_final', !r.resolved && r.reason === 'match_not_final', r);
    check('not-final carries match_id', r.match_id === 'pe-3', r.match_id);
  }

  // ── Defensive refuse-to-grade branches (resolved player, but won't guess) ──
  check('resolved player, no threshold on a stat prop → no_threshold',
    (await gradeP('Brian Brobbey Shots')).reason === 'no_threshold');
  check('keyEvents incomplete vs scoreline → keyevents_incomplete (data gap, no guess)',
    (await gradeP('Solo Striker Anytime Goalscorer')).reason === 'keyevents_incomplete');
  check('completed 0-0, first goalscorer → no_regular_scorer (no guess)',
    (await gradeP('Zero Hero First Goalscorer')).reason === 'no_regular_scorer');
  // sibling sanity: anytime on the same 0-0 settles LOSS (player appeared, 0 goals)
  check('completed 0-0, anytime goalscorer → LOSS (appeared, scored 0)',
    (await gradeP('Zero Hero Anytime Goalscorer')).status === 'LOSS');

  // ── Summary fetch error must not be read as absence → fetch_error ──
  check('summary fetch error → fetch_error (not player_not_found)',
    (await soccer.gradeSoccerBet('Some Striker Anytime Goalscorer', '2026-07-01', { slug: 'fifa.world' })).reason === 'fetch_error');

  // ── Result-shape + match_id on a prop WIN ──
  {
    const r = await gradeP('Bart Verbruggen 3+ Saves');
    check('prop win shape', r.resolved === true && r.source === 'espn_soccer' && r.match_id === 'pe-1' && typeof r.evidence === 'string', r);
  }

  // ═══════════════ Mode gating via tryStructured ═══════════════
  const baseBet = { id: 'bet-soccer-1', sport: 'Soccer', description: 'USA ML', created_at: '2026-06-12 12:00:00', event_date: null };

  // off → adapter NOT reached (no fetch), fall-through, no shadow row
  delete process.env.SOCCER_GRADER_MODE;
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(baseBet);
    check('off: tryStructured falls through', r.resolved === false, r);
    check('off: adapter not reached (zero fetches)', fetchCount === 0, fetchCount);
    check('off: no shadow row', transitionCalls.length === 0, transitionCalls.length);
    check('off: soccerStructuredEligible=false', sportsdata.soccerStructuredEligible(baseBet) === false);
  }

  // shadow → adapter runs, emits ONE shadow row, returns fall-through, NO grade
  process.env.SOCCER_GRADER_MODE = 'shadow';
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(baseBet);
    check('shadow: returns fall-through (NO grade write)', r.resolved === false && r.reason === 'soccer_shadow', r);
    check('shadow: emitted exactly one row', transitionCalls.length === 1, transitionCalls.length);
    const row = transitionCalls[0] || {};
    check('shadow: row event_type', row.eventType === 'soccer_grade_shadow', row.eventType);
    check('shadow: row stage GRADING_ENTER', row.toStage === 'GRADING_ENTER', row.toStage);
    check('shadow: row betId', row.betId === 'bet-soccer-1', row.betId);
    const p = row.payload || {};
    check('shadow: payload would_status=WIN', p.would_status === 'WIN', p);
    check('shadow: payload source/slug/match_id/desc', p.source === 'espn_soccer' && p.slug === 'fifa.world' && p.match_id === 'm-usa' && p.desc_or_leg === 'USA ML', p);
    check('shadow: soccerStructuredEligible=true', sportsdata.soccerStructuredEligible(baseBet) === true);
  }

  // shadow audit emit on no_match_found, and NO emit for unsupported player prop
  process.env.SOCCER_GRADER_MODE = 'shadow';
  installFetch();
  transitionCalls = [];
  {
    await sportsdata.tryStructured({ ...baseBet, description: 'Italy ML' });
    check('shadow: no_match_found emits audit row', transitionCalls.length === 1 && transitionCalls[0].payload.reason === 'no_match_found', transitionCalls);
  }
  installFetch();
  transitionCalls = [];
  {
    await sportsdata.tryStructured({ ...baseBet, description: 'Pulisic Anytime Goal Scorer' });
    check('shadow: unresolved player prop (player_not_found) emits NO row', transitionCalls.length === 0, transitionCalls.length);
  }

  // enforce → returns the adapter's real resolved status
  process.env.SOCCER_GRADER_MODE = 'enforce';
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(baseBet);
    check('enforce: returns resolved status', r.resolved === true && r.status === 'WIN' && r.source === 'espn_soccer', r);
    check('enforce: no shadow row', transitionCalls.length === 0, transitionCalls.length);
  }
  delete process.env.SOCCER_GRADER_MODE;

  // ── PLAYER PROP obeys the SAME mode wiring (inherited via routeSoccer) ──
  const propBet = { id: 'bet-prop-1', sport: 'World Cup', description: 'Brian Brobbey Anytime Goalscorer', created_at: '2026-06-20 12:00:00', event_date: null };

  // off → prop adapter not reached
  delete process.env.SOCCER_GRADER_MODE;
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(propBet);
    check('prop off: falls through, zero fetches', r.resolved === false && fetchCount === 0, { r, fetchCount });
    check('prop off: no shadow row', transitionCalls.length === 0, transitionCalls.length);
  }

  // shadow → prop WIN would-verdict emitted, returns fall-through (NO grade write)
  process.env.SOCCER_GRADER_MODE = 'shadow';
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(propBet);
    check('prop shadow: fall-through, no grade', r.resolved === false && r.reason === 'soccer_shadow', r);
    check('prop shadow: emitted exactly one row', transitionCalls.length === 1, transitionCalls.length);
    const p = (transitionCalls[0] || {}).payload || {};
    check('prop shadow: would_status=WIN, match_id=pe-1', p.would_status === 'WIN' && p.match_id === 'pe-1', p);
  }

  // shadow → DNP would-VOID also emits (VOID is a settleable would-verdict)
  installFetch();
  transitionCalls = [];
  {
    await sportsdata.tryStructured({ ...propBet, id: 'bet-prop-void', description: 'Wesley Bench Anytime Goalscorer' });
    check('prop shadow: DNP would-VOID emits a row', transitionCalls.length === 1 && transitionCalls[0].payload.would_status === 'VOID', transitionCalls);
  }

  // shadow → unresolved prop (no_unique_player) is SILENT (no row)
  installFetch();
  transitionCalls = [];
  {
    await sportsdata.tryStructured({ ...propBet, id: 'bet-prop-amb', description: 'Garcia Anytime Goalscorer' });
    check('prop shadow: ambiguous player emits NO row', transitionCalls.length === 0, transitionCalls.length);
  }

  // enforce → prop returns the real resolved WIN
  process.env.SOCCER_GRADER_MODE = 'enforce';
  installFetch();
  transitionCalls = [];
  {
    const r = await sportsdata.tryStructured(propBet);
    check('prop enforce: resolved WIN', r.resolved === true && r.status === 'WIN' && r.source === 'espn_soccer' && r.match_id === 'pe-1', r);
    check('prop enforce: no shadow row', transitionCalls.length === 0, transitionCalls.length);
  }
  delete process.env.SOCCER_GRADER_MODE;

  console.log(`\nsoccer-grader: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
