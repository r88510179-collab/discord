// ═══════════════════════════════════════════════════════════
// ESPN team-matching + team-total grading.
//
// Regression coverage for two bugs surfaced by the Build 2 canary:
//   DEFECT A — "sox" nickname collision: a bare last-word endsWith()
//     match made any Red Sox / White Sox bet match BOTH Sox games on a
//     slate → matchTeamsToEvent saw 2 matches → ambiguity refusal → no grade.
//   DEFECT B — team totals ("Mariners under 4.5 runs") were treated as
//     player props (PROP_KEYWORDS hit "runs") and, if they slipped past,
//     would have been graded as GAME totals (sum of both teams) — wrong.
//
// Uses REALISTIC ESPN shapes: shortDisplayName is the true nickname
// ("Red Sox", "White Sox"), not a naive last word.
// No network. No real ESPN hits.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const {
  parseBetDescription,
  matchTeamsToEvent,
  gradeFromScore,
  teamMatches,
} = require('../services/espn');

// ── Realistic team / event builders ──
const T = {
  BOS: { name: 'Boston Red Sox', short: 'Red Sox', abbr: 'BOS' },
  CHW: { name: 'Chicago White Sox', short: 'White Sox', abbr: 'CHW' },
  ATL: { name: 'Atlanta Braves', short: 'Braves', abbr: 'ATL' },
  MIN: { name: 'Minnesota Twins', short: 'Twins', abbr: 'MIN' },
  CHC: { name: 'Chicago Cubs', short: 'Cubs', abbr: 'CHC' },
  SEA: { name: 'Seattle Mariners', short: 'Mariners', abbr: 'SEA' },
  BAL: { name: 'Baltimore Orioles', short: 'Orioles', abbr: 'BAL' },
  NYY: { name: 'New York Yankees', short: 'Yankees', abbr: 'NYY' },
  LAL: { name: 'Los Angeles Lakers', short: 'Lakers', abbr: 'LAL' },
  BOSC: { name: 'Boston Celtics', short: 'Celtics', abbr: 'BOS' },
  NYR: { name: 'New York Rangers', short: 'Rangers', abbr: 'NYR' },
  NJD: { name: 'New Jersey Devils', short: 'Devils', abbr: 'NJD' },
  // Names where ESPN's displayName differs from the canonical bet string:
  ATH: { name: 'Athletics', short: 'Athletics', abbr: 'ATH' },          // city dropped (post-relocation)
  STLC: { name: 'St. Louis Cardinals', short: 'Cardinals', abbr: 'STL' }, // period in city
  LAC: { name: 'LA Clippers', short: 'Clippers', abbr: 'LAC' },          // city abbreviated
  KC: { name: 'Kansas City Chiefs', short: 'Chiefs', abbr: 'KC' },       // NFL
};

// home/away = a T entry; hs/as = scores
function mkEvent(home, hs, away, as, completed = true) {
  const mkTeam = (t) => ({
    displayName: t.name,
    shortDisplayName: t.short,
    abbreviation: t.abbr,
  });
  return {
    competitions: [{
      competitors: [
        { team: mkTeam(home), score: String(hs), homeAway: 'home', winner: hs > as },
        { team: mkTeam(away), score: String(as), homeAway: 'away', winner: as > hs },
      ],
      status: { type: { completed, description: completed ? 'Final' : 'In Progress' } },
    }],
  };
}

// lowercased ESPN-team shape (what buildTeamInfo produces) for direct teamMatches tests
function info(t) {
  return { displayName: t.name.toLowerCase(), shortName: t.short.toLowerCase(), abbrev: t.abbr.toLowerCase() };
}

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); pass++; };

// ════════════════ DEFECT A — teamMatches precision ════════════════

// Full-name matches.
ok(teamMatches('boston red sox', info(T.BOS)), 'full Boston Red Sox');
eq(teamMatches('boston red sox', info(T.CHW)), false, 'Boston Red Sox must NOT match White Sox');
ok(teamMatches('chicago white sox', info(T.CHW)), 'full Chicago White Sox');
eq(teamMatches('chicago white sox', info(T.BOS)), false, 'White Sox must NOT match Red Sox');

// Nickname-only (city dropped) — still disambiguates.
ok(teamMatches('red sox', info(T.BOS)), 'nickname red sox → Boston');
eq(teamMatches('red sox', info(T.CHW)), false, 'nickname red sox must NOT match White Sox');
ok(teamMatches('white sox', info(T.CHW)), 'nickname white sox → Chicago');

// shortName / abbrev paths preserved.
ok(teamMatches('yankees', info(T.NYY)), 'nickname yankees');
ok(teamMatches('bos', info(T.BOS)), 'abbrev bos');

// Bare ambiguous "sox" genuinely matches BOTH (correctly ambiguous downstream).
ok(teamMatches('sox', info(T.BOS)) && teamMatches('sox', info(T.CHW)), 'bare "sox" is ambiguous by design');

// Bet string longer than / punctuated differently from ESPN displayName
// (regression guard — these must NOT drop out of the fast path).
ok(teamMatches('oakland athletics', info(T.ATH)), 'bet "oakland athletics" → ESPN "Athletics" (city dropped)');
ok(teamMatches('st louis cardinals', info(T.STLC)), 'bet "st louis cardinals" → ESPN "St. Louis Cardinals" (period)');
ok(teamMatches('los angeles clippers', info(T.LAC)), 'bet "los angeles clippers" → ESPN "LA Clippers" (city abbrev)');
eq(teamMatches('los angeles clippers', info(T.LAL)), false, 'Clippers must NOT match Lakers');
eq(teamMatches('los angeles lakers', info(T.LAC)), false, 'Lakers must NOT match Clippers');

// ════════════════ DEFECT A — matchTeamsToEvent on a both-Sox slate ════════════════

// Slate with BOTH a Red Sox game and a White Sox game (the canary's failure shape).
const SLATE_BOTH_SOX = [
  mkEvent(T.ATL, 0, T.BOS, 8),   // Boston Red Sox 8 @ Atlanta Braves 0
  mkEvent(T.MIN, 2, T.CHW, 15),  // Chicago White Sox 15 @ Minnesota Twins 2
];

const mRed = matchTeamsToEvent(SLATE_BOTH_SOX, ['boston red sox']);
ok(mRed, 'Red Sox matches its game uniquely (no false ambiguity)');
const gRed = gradeFromScore({ type: 'ml', team: 'boston red sox' }, mRed, ['boston red sox']);
eq(gRed && gRed.result, 'WIN', 'Red Sox ML WIN (8 > 0)');

const mWhite = matchTeamsToEvent(SLATE_BOTH_SOX, ['chicago white sox']);
ok(mWhite, 'White Sox matches its game uniquely');
const gWhite = gradeFromScore({ type: 'ml', team: 'chicago white sox' }, mWhite, ['chicago white sox']);
eq(gWhite && gWhite.result, 'WIN', 'White Sox ML WIN (15 > 2)');

// Nickname-only bet on the both-Sox slate.
ok(matchTeamsToEvent(SLATE_BOTH_SOX, ['red sox']), 'nickname "red sox" resolves uniquely on both-Sox slate');

// Bare "sox" stays ambiguous → refuse (guard still correct).
eq(matchTeamsToEvent(SLATE_BOTH_SOX, ['sox']), null, 'bare "sox" → ambiguous → null');

// Two-team GAME total on a slate that also has a White Sox game (65302cf8 shape).
const SLATE_BRAVES_REDSOX = [
  mkEvent(T.BOS, 1, T.ATL, 8),   // Atlanta Braves 8 @ Boston Red Sox 1  (total 9)
  mkEvent(T.CHC, 8, T.CHW, 9),   // Chicago White Sox 9 @ Chicago Cubs 8
];
const mTot = matchTeamsToEvent(SLATE_BRAVES_REDSOX, ['atlanta braves', 'boston red sox']);
ok(mTot, 'Braves/Red Sox game resolves uniquely despite a White Sox game on slate');
const pTot = parseBetDescription('Braves / Red Sox OVER 8.5', ['atlanta braves', 'boston red sox'], 'MLB');
eq(pTot.type, 'total', 'two-team OVER 8.5 stays a GAME total (not team_total)');
const gTot = gradeFromScore(pTot, mTot, ['atlanta braves', 'boston red sox']);
eq(gTot && gTot.result, 'WIN', 'game total 9 > 8.5 → WIN');

// ════════════════ DEFECT B — team totals ════════════════

// Mariners game where team-total and game-total DIVERGE (the correctness proof):
//   Mariners (away) 3, Orioles (home) 6 → team total 3, game total 9.
const MARINERS_DIVERGE = [mkEvent(T.BAL, 6, T.SEA, 3)];
const MARINERS_REAL = [mkEvent(T.BAL, 7, T.SEA, 5)]; // the canary's real 06-11 game

// Implicit team total via unit word.
const pTT = parseBetDescription('Mariners under 4.5 runs', ['seattle mariners'], 'MLB');
eq(pTT.type, 'team_total', '"Mariners under 4.5 runs" → team_total');
eq(pTT.line, 4.5, 'team_total line');
eq(pTT.direction, 'under', 'team_total direction');

// Correctness: grade the TEAM score, not the game total.
const mDiv = matchTeamsToEvent(MARINERS_DIVERGE, ['seattle mariners']);
const gDiv = gradeFromScore(pTT, mDiv, ['seattle mariners']);
eq(gDiv && gDiv.result, 'WIN', 'team total: Mariners 3 < 4.5 → WIN (game total 9 would be LOSS)');

// Canary real game: Mariners 5 under 4.5 → LOSS.
const mReal = matchTeamsToEvent(MARINERS_REAL, ['seattle mariners']);
const gReal = gradeFromScore(pTT, mReal, ['seattle mariners']);
eq(gReal && gReal.result, 'LOSS', 'team total: Mariners 5 not < 4.5 → LOSS (canary 12ac4b83)');

// over + push.
const gOver = gradeFromScore(
  parseBetDescription('Mariners over 4.5 runs', ['seattle mariners'], 'MLB'), mReal, ['seattle mariners']);
eq(gOver && gOver.result, 'WIN', 'team total: Mariners 5 > 4.5 over → WIN');
const MARINERS_PUSH = [mkEvent(T.BAL, 6, T.SEA, 4)];
const gPush = gradeFromScore(
  parseBetDescription('Mariners under 4.5 runs', ['seattle mariners'], 'MLB'),
  matchTeamsToEvent(MARINERS_PUSH, ['seattle mariners']), ['seattle mariners']);
// 4 < 4.5 → WIN (not a push; push only on exact line). Sanity it's not graded off game total (10).
eq(gPush && gPush.result, 'WIN', 'team total: Mariners 4 < 4.5 → WIN');
const MARINERS_EXACT = [mkEvent(T.BAL, 6, T.SEA, 5)];
const gExact = gradeFromScore(
  parseBetDescription('Mariners under 5 runs', ['seattle mariners'], 'MLB'),
  matchTeamsToEvent(MARINERS_EXACT, ['seattle mariners']), ['seattle mariners']);
eq(gExact && gExact.result, 'PUSH', 'team total: Mariners 5 = line 5 → PUSH');

// Explicit "Team Total" phrasing WITHOUT a unit word → still team_total (not game total).
const pExplicit = parseBetDescription('Mariners Team Total Under 4.5', ['seattle mariners'], 'MLB');
eq(pExplicit.type, 'team_total', '"Mariners Team Total Under 4.5" → team_total');
const gExplicit = gradeFromScore(pExplicit, mDiv, ['seattle mariners']);
eq(gExplicit && gExplicit.result, 'WIN', 'explicit team total graded on team score (3<4.5 WIN, not game 9)');

// NBA + NHL team totals.
const NBA_GAME = [mkEvent(T.BOSC, 110, T.LAL, 118)]; // Lakers (away) 118
const pNba = parseBetDescription('Lakers over 112.5 points', ['los angeles lakers'], 'NBA');
eq(pNba.type, 'team_total', 'NBA "Lakers over 112.5 points" → team_total');
const gNba = gradeFromScore(pNba, matchTeamsToEvent(NBA_GAME, ['los angeles lakers']), ['los angeles lakers']);
eq(gNba && gNba.result, 'WIN', 'Lakers 118 > 112.5 → WIN');
const NHL_GAME = [mkEvent(T.NJD, 4, T.NYR, 1)]; // Rangers (away) 1
const pNhl = parseBetDescription('Rangers under 2.5 goals', ['new york rangers'], 'NHL');
eq(pNhl.type, 'team_total', 'NHL "Rangers under 2.5 goals" → team_total');
const gNhl = gradeFromScore(pNhl, matchTeamsToEvent(NHL_GAME, ['new york rangers']), ['new york rangers']);
eq(gNhl && gNhl.result, 'WIN', 'Rangers 1 < 2.5 → WIN');

// ════════════════ DEFECT B — guards (must NOT become team totals) ════════════════

// Player prop: team in betTeams but the SUBJECT (team nickname) is absent → stays player_prop.
const pProp = parseBetDescription('Cal Raleigh over 0.5 runs', ['seattle mariners'], 'MLB');
eq(pProp.type, null, 'player prop "Cal Raleigh over 0.5 runs" NOT team_total');
eq(pProp.reason, 'player_prop', '...stays player_prop');

// Inning / segment market → not a full-game team total.
const pSeg = parseBetDescription('Mariners over 0.5 runs 1st inning', ['seattle mariners'], 'MLB');
eq(pSeg.type, null, 'segment "1st inning" → not team_total');

// Non-score stat word (team hits not on the scoreboard) → refuse.
const pHits = parseBetDescription('Mariners over 8.5 hits', ['seattle mariners'], 'MLB');
eq(pHits.type, null, '"Mariners over 8.5 hits" (hits ≠ score unit) → not team_total');

// Sport/unit mismatch → refuse.
const pMismatch = parseBetDescription('Lakers over 4.5 runs', ['los angeles lakers'], 'NBA');
eq(pMismatch.type, null, 'NBA + "runs" mismatch → not team_total');

// Player prop with the TEAM in betTeams but a PLAYER in the text → not team_total.
// The worst false-grade case. BOTH two-token AND single-surname forms must refuse
// (any leftover non-vocabulary token disqualifies).
eq(parseBetDescription('Chiefs Patrick Mahomes over 2.5 points', ['kansas city chiefs'], 'NFL').type === 'team_total', false, 'team+player (two-token name) NOT team_total');
eq(parseBetDescription('Chiefs Mahomes over 1.5 points', ['kansas city chiefs'], 'NFL').type === 'team_total', false, 'team+SURNAME-only ("Chiefs Mahomes over 1.5 points") NOT team_total');
eq(parseBetDescription('Cubs over 0.5 runs Happ', ['chicago cubs'], 'MLB').type === 'team_total', false, 'MLB surname-only ("Cubs over 0.5 runs Happ") NOT team_total');
eq(parseBetDescription('Lakers over 9.5 points James', ['los angeles lakers'], 'NBA').type === 'team_total', false, 'NBA surname-only ("Lakers over 9.5 points James") NOT team_total');
eq(parseBetDescription('Rangers under 2.5 goals McDavid', ['new york rangers'], 'NHL').type === 'team_total', false, 'NHL surname-only ("Rangers under 2.5 goals McDavid") NOT team_total');
// Surname that collides with a broad English word must NOT be absorbed (allow-list, not blacklist).
eq(parseBetDescription('Mariners over 0.5 runs Reg', ['seattle mariners'], 'MLB').type === 'team_total', false, 'surname "Reg" not absorbed as filler → NOT team_total');

// Game-total-magnitude line with a single team → falls through (not team_total).
eq(parseBetDescription('Mariners over 8.5 runs', ['seattle mariners'], 'MLB').type === 'team_total', false, 'game-total magnitude "Mariners over 8.5 runs" NOT team_total');
eq(parseBetDescription('Mariners over 6.5 runs', ['seattle mariners'], 'MLB').type === 'team_total', false, 'overlap-band "Mariners over 6.5 runs" NOT team_total (MLB ceiling 5.5)');

// Segment markets → not a full-game team total.
eq(parseBetDescription('Mariners over 2.5 runs in the 5th', ['seattle mariners'], 'MLB').type === 'team_total', false, 'segment "5th" not team_total');
eq(parseBetDescription('Mariners over 2.5 runs thru 5', ['seattle mariners'], 'MLB').type === 'team_total', false, 'segment "thru 5" not team_total');

// Nickname-only subject must STILL grade: stripping all team tokens (boston/red/sox)
// leaves an empty residual → bare team total. Guards the over-correction.
const pNickOnly = parseBetDescription('Red Sox under 3.5 runs', ['boston red sox'], 'MLB');
eq(pNickOnly.type, 'team_total', 'nickname-only "Red Sox under 3.5 runs" → team_total');

// Legit NFL team total within range.
eq(parseBetDescription('Chiefs over 27.5 points', ['kansas city chiefs'], 'NFL').type, 'team_total', 'NFL "Chiefs over 27.5 points" → team_total (≤ 34)');

// Two named teams must NEVER become a team_total (a team total is one team).
// (With a unit word present this currently falls to player_prop — a pre-existing
// limitation for game totals phrased with a stat word; the real canary bet
// "Braves / Red Sox OVER 8.5" has no unit word and grades as a game total above.)
const pTwoTeamUnit = parseBetDescription('Braves Red Sox over 8.5 runs', ['atlanta braves', 'boston red sox'], 'MLB');
eq(pTwoTeamUnit.type === 'team_total', false, 'two named teams never become a team_total');

// ════════════════ Regression — existing forms unaffected ════════════════
eq(parseBetDescription('Marlins ML +130', ['miami marlins'], 'MLB').type, 'ml', 'reg: ML');
eq(parseBetDescription('Yankees -1.5 +110', ['new york yankees'], 'MLB').type, 'spread', 'reg: spread');
eq(parseBetDescription('Under 7.5', [], 'MLB').type, 'total', 'reg: bare game total');
eq(parseBetDescription('Mashack 7+ Assists (+125)', [], 'NBA').type, null, 'reg: player prop');
eq(parseBetDescription('Atlanta Braves -115', ['atlanta braves'], 'MLB').type, 'ml', 'reg: implied ML');

console.log(`\n✅ espn-team-matching: all ${pass} assertions passed.`);
