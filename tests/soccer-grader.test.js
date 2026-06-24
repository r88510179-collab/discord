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

// Mock global fetch: return the scoreboard for the requested ESPN date, else [].
let fetchCount = 0;
function installFetch() {
  fetchCount = 0;
  global.fetch = async (url) => {
    fetchCount++;
    const m = String(url).match(/dates=(\d{8})/);
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

  // ── Player prop / unsupported overlays → fall through (never error) ──
  check('player goalscorer → unsupported_market_soccer',
    (await grade('Christian Pulisic Anytime Goal Scorer')).reason === 'unsupported_market_soccer');
  check('"to score" player prop → unsupported_market_soccer',
    (await grade('Lionel Messi to score')).reason === 'unsupported_market_soccer');
  check('shots on target prop → unsupported',
    (await grade('Vinicius Junior Over 1.5 Shots on Target')).reason === 'unsupported_market_soccer');
  check('2-Up overlay → unsupported',
    (await grade('USA 2-Up early payout')).reason === 'unsupported_market_soccer');
  check('draw no bet (out of scope) → unsupported',
    (await grade('USA Draw No Bet')).reason === 'unsupported_market_soccer');
  check('corners (unsupported side market) → unsupported',
    (await grade('USA vs Paraguay Over 9.5 Corners')).reason === 'unsupported_market_soccer');

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
    check('shadow: unsupported player prop emits NO row', transitionCalls.length === 0, transitionCalls.length);
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

  console.log(`\nsoccer-grader: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
