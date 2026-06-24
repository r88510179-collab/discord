// ═══════════════════════════════════════════════════════════
// MLB canonicalize() word-boundary + findPlayerInBoxscore surname-collision guard.
//
// Two related defects in services/sportsdata/mlb.js, both diagnosed live:
//
// Defect 1 (ROOT CAUSE) — canonicalize(teamText) resolved a team by `lower.includes(alias)`.
// Short aliases are substrings of common surnames, so valid player names resolved to teams:
//   canonicalize("Mike Yastrzemski") → "Athletics"  ('as' ⊂ "y-AS-trzemski")
//   canonicalize("Masyn Winn")       → "Athletics"  ('as' ⊂ "m-AS-yn")
// That broke two things: (a) looksLikePlayerProp saw a "team" and refused clean player
// props, and (b) it was the route by which "Masyn Winn" mis-fed the GAME-total grader
// (the #130 −74.42u false-WIN). Fix: match an alias only as a WHOLE WORD (\b-anchored,
// regex-escaped), keeping the exact-hit fast path. "Atlanta Braves ML" still resolves
// (alias is a word); a surname containing a short alias no longer does.
//
// Defect 2 — findPlayerInBoxscore(bs, lastName, firstName=null) returned the FIRST
// surname match. First-name disambiguation already protects multi-token legs, but a
// single-token leg (firstName=null) silently took the first same-surname player. Fix:
// with no first name AND 2+ same-surname players on the slate, return null (→
// player_not_found_in_games_on_date → safe fall-through/refuse) instead of guessing.
//
// This whole file is pure/offline EXCEPT step 3, which mocks fetch to prove the #130
// game-total path stays unreachable for the matchup string.
// ═══════════════════════════════════════════════════════════

const path = require('path');
const os = require('os');

// Requiring grading.js (for the structured router + reducer) loads database.js
// transitively — point DB_PATH at a throwaway file so nothing touches a real DB.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-canon-surname-${Date.now()}.db`);

const mlb = require('../services/sportsdata/mlb');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

console.log('mlb-canonicalize-substring-surname:');

(async () => {
  // ── 1. canonicalize: colliding surnames → null; teams still resolve ─────────
  console.log(' 1. canonicalize word-boundary:');
  // (a) Real surnames that contain a SHORT alias as a substring (mostly 'as') must NOT
  //     resolve to a team — old `includes('as')` matched every one of these to Athletics.
  const shouldBeNull = [
    'Mike Yastrzemski',    // 'as' ⊂ yAStrzemski
    'Masyn Winn',          // 'as' ⊂ mASyn (the #130 false-WIN name)
    'Masataka Yoshida',    // 'as' ⊂ mASataka
    'Vinnie Pasquantino',  // 'as' ⊂ pASquantino
    'Triston Casas',       // 'as' ⊂ cASas
    'Aaron Judge',         // control: no alias substring
    'Jose Ramirez',        // control
    'Shohei Ohtani',       // control
    'Bobby Witt Jr',       // control
  ];
  for (const n of shouldBeNull) {
    check(`canonicalize("${n}") → null`, mlb.canonicalize(n) === null, JSON.stringify(mlb.canonicalize(n)));
  }
  // (b) Teams still resolve (whole-word alias, incl. the exact-hit fast path,
  //     multi-word aliases, punctuation-adjacent aliases, and a "Team vs Team" string).
  const shouldResolve = [
    ['Atlanta Braves ML', 'Atlanta Braves'],
    ['As', 'Athletics'],
    ['Athletics', 'Athletics'],
    ["A's", 'Athletics'],
    ["Oakland A's -1.5", 'Athletics'],          // punctuation-adjacent alias inside a description
    ['New York Mets', 'New York Mets'],
    ['Boston Red Sox', 'Boston Red Sox'],       // multi-word alias "red sox"
    ['Toronto Blue Jays ML', 'Toronto Blue Jays'], // multi-word alias "blue jays"
    ['Chicago White Sox', 'Chicago White Sox'], // multi-word alias "white sox"
    ['Arizona Diamondbacks', 'Arizona Diamondbacks'],
    ['d-backs', 'Arizona Diamondbacks'],        // hyphenated alias
    ['Dodgers Over 8.5 Runs', 'Los Angeles Dodgers'],
  ];
  for (const [s, exp] of shouldResolve) {
    check(`canonicalize("${s}") → ${exp}`, mlb.canonicalize(s) === exp, JSON.stringify(mlb.canonicalize(s)));
  }
  // "Team vs Team" resolves to (one of the) teams (truthy is what callers need).
  check('canonicalize("Reds vs Cubs") resolves (truthy)', !!mlb.canonicalize('Reds vs Cubs'), JSON.stringify(mlb.canonicalize('Reds vs Cubs')));
  // Every alias self-resolves as a whole word.
  const { TEAM_ALIASES } = mlb._internal;
  const badAliases = Object.keys(TEAM_ALIASES).filter(a => mlb.canonicalize(a) !== TEAM_ALIASES[a]);
  check(`all ${Object.keys(TEAM_ALIASES).length} aliases self-resolve`, badAliases.length === 0, `bad=[${badAliases}]`);
  // null/empty safety.
  check('canonicalize(null) → null, no throw', (() => { try { return mlb.canonicalize(null) === null; } catch (_) { return false; } })());
  check('canonicalize("") → null, no throw', (() => { try { return mlb.canonicalize('') === null; } catch (_) { return false; } })());

  // ── 2. looksLikePlayerProp now admits the clean colliding-name props ────────
  console.log(' 2. looksLikePlayerProp admits colliding-name props; totals stay totals:');
  const nowProps = [
    'Mike Yastrzemski Over 0.5 Hits',
    'Masyn Winn Over 0.5 Hits',
    'Aaron Judge Over 0.5 Hits',       // non-colliding control (always worked)
    'Jose Ramirez Over 1.5 Total Bases',
    'Shohei Ohtani O 1.5 Hits+Runs+RBIs',
  ];
  for (const d of nowProps) {
    check(`looksLikePlayerProp("${d}") → true`, mlb.looksLikePlayerProp(d) === true, JSON.stringify(mlb.looksLikePlayerProp(d)));
  }
  // A real game total must still route as a TOTAL (subject is a team) → NOT a prop.
  const totals = [
    'New York Mets vs St. Louis Cardinals Under 8.5 Total Runs',
    'Los Angeles Dodgers Over 8.5 Runs',
    'Yankees Over 8.5 Runs',
  ];
  for (const d of totals) {
    check(`looksLikePlayerProp("${d}") → false (still a total)`, mlb.looksLikePlayerProp(d) === false, JSON.stringify(mlb.looksLikePlayerProp(d)));
  }

  // ── 3. #130 regression: matchup string must NEVER grade as a game-total WIN ─
  console.log(' 3. #130 regression — game-total path stays unreachable for the matchup string:');
  const MATCHUP = 'St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS';
  // gradeMlbBet (the GAME-total grader) must REFUSE it before any network fetch.
  let networkAttempted = false;
  global.fetch = async () => { networkAttempted = true; throw new Error('network must not be called for a mis-routed player prop'); };
  const refused = await mlb.gradeMlbBet(MATCHUP, '2026-05-01');
  check('gradeMlbBet refuses the matchup string (player_prop_misrouted_to_total)',
    refused && refused.resolved === false && refused.reason === 'player_prop_misrouted_to_total', JSON.stringify(refused));
  check('no network attempted (guard short-circuits before fetch)', networkAttempted === false);
  // looksLikePlayerProp is false for it (subject canonicalizes to a team), so the router
  // sends it through the matchup reroute / team grader — never a naked game total.
  check('matchup string is NOT a plain player prop (subject is a team)', mlb.looksLikePlayerProp(MATCHUP) === false);
  // The rewrite produces a PLAYER prop string, which the prop grader handles (never a game total).
  check('rewriteMatchupPrefixedProp(matchup) → "MASYN WINN Over 0.5 HITS"',
    mlb.rewriteMatchupPrefixedProp(MATCHUP) === 'MASYN WINN Over 0.5 HITS', JSON.stringify(mlb.rewriteMatchupPrefixedProp(MATCHUP)));

  // ── 4. Surname-collision guard in findPlayerInBoxscore ──────────────────────
  console.log(' 4. findPlayerInBoxscore surname-collision guard:');
  // Two same-surname players active the same day (Will Smith C / Will Smith RP is a real
  // 2022–23 Astros↔Dodgers situation; here one per side).
  function batter(fullName, hits) {
    return { person: { fullName }, stats: { batting: { hits }, pitching: {} } };
  }
  const bs = {
    teams: {
      home: { team: { name: 'Los Angeles Dodgers' }, players: { id1: batter('Will Smith', 2) } },
      away: { team: { name: 'Texas Rangers' }, players: { id2: batter('Josh Smith', 0), id3: batter('Marcus Semien', 1) } },
    },
  };
  // No first name + 2 "Smith" → ambiguous → null (refuse, don't guess).
  check('findPlayerInBoxscore(bs, "smith", null) → null (collision, no first name)',
    mlb.findPlayerInBoxscore(bs, 'smith', null) === null, JSON.stringify(mlb.findPlayerInBoxscore(bs, 'smith', null)));
  // First name disambiguates → the right player.
  const will = mlb.findPlayerInBoxscore(bs, 'smith', 'will');
  check('findPlayerInBoxscore(bs, "smith", "will") → Will Smith',
    will && will.player === 'Will Smith' && will.batting.hits === 2, JSON.stringify(will));
  const josh = mlb.findPlayerInBoxscore(bs, 'smith', 'josh');
  check('findPlayerInBoxscore(bs, "smith", "josh") → Josh Smith',
    josh && josh.player === 'Josh Smith' && josh.batting.hits === 0, JSON.stringify(josh));
  // Unique surname + no first name → still resolves (no false null).
  const semien = mlb.findPlayerInBoxscore(bs, 'semien', null);
  check('findPlayerInBoxscore(bs, "semien", null) → Marcus Semien (unique surname, no false null)',
    semien && semien.player === 'Marcus Semien', JSON.stringify(semien));
  // Surname absent → null.
  check('findPlayerInBoxscore(bs, "trout", null) → null (absent)',
    mlb.findPlayerInBoxscore(bs, 'trout', null) === null);
  // Single same-surname player + no first name → resolves (the common case, unchanged).
  const bsSingle = {
    teams: {
      home: { team: { name: 'Los Angeles Dodgers' }, players: { id1: batter('Will Smith', 2) } },
      away: { team: { name: 'Texas Rangers' }, players: { id2: batter('Marcus Semien', 1) } },
    },
  };
  const lone = mlb.findPlayerInBoxscore(bsSingle, 'smith', null);
  check('findPlayerInBoxscore(single "smith", null) → Will Smith (lone surname, no first name)',
    lone && lone.player === 'Will Smith', JSON.stringify(lone));

  // ── 5. End-to-end: a collision must FALL THROUGH, never a fabricated DNP VOID ───────
  // A surname-only leg colliding with 2 same-surname players on a FULLY FINAL slate would
  // (pre-guard) hit gradeMlbPlayerProp's provable-absence branch and VOID with the false
  // evidence "did not appear in any games" — even though the player played. The ambiguity
  // flag from findPlayerGame must suppress that VOID → resolved:false fall-through.
  console.log(' 5. surname collision falls through (no false provable-absence VOID):');
  function scheduleWith(games) { return { dates: [{ games }] }; }
  function makeFetch({ schedule, feeds }) {
    return async (url) => {
      if (url.includes('/schedule')) return { ok: true, json: async () => schedule };
      const m = url.match(/\/game\/(\d+)\//);
      if (m && feeds[m[1]]) return { ok: true, json: async () => ({ liveData: { boxscore: feeds[m[1]] } }) };
      throw new Error(`unexpected fetch url: ${url}`);
    };
  }
  // Single FINAL game with TWO Smiths (Will 2H, Josh 0H) — a same-surname pair on one slate.
  const collideFeed = { teams: {
    home: { team: { name: 'Los Angeles Dodgers' }, players: { id1: batter('Will Smith', 2), id2: batter('Josh Smith', 0) } },
    away: { team: { name: 'Texas Rangers' }, players: { id3: batter('Marcus Semien', 1) } },
  } };
  global.fetch = makeFetch({
    schedule: scheduleWith([{ gamePk: 77, status: { abstractGameState: 'Final', detailedState: 'Final' },
      teams: { away: { team: { name: 'Texas Rangers' }, score: 1 }, home: { team: { name: 'Los Angeles Dodgers' }, score: 4 } } }]),
    feeds: { '77': collideFeed },
  });
  // Surname-only leg + 2 Smiths + fully-final slate + VOID allowed → MUST fall through, not VOID.
  const collide = await mlb.gradeMlbPlayerProp('Smith O 1.5 Hits', '2026-05-01', { absenceVoidAllowed: true });
  check('collision → resolved:false fall-through (NOT a DNP VOID, NOT WIN/LOSS)',
    collide && collide.resolved === false && collide.reason === 'player_not_found_in_games_on_date',
    JSON.stringify(collide));
  check('collision did NOT resolve to VOID/WIN/LOSS', collide && collide.status === undefined, JSON.stringify(collide));
  // First name disambiguates → the right Smith grades (proves the guard does not block resolvable legs).
  const willE2E = await mlb.gradeMlbPlayerProp('Will Smith O 1.5 Hits', '2026-05-01', { absenceVoidAllowed: true });
  check('disambiguated "Will Smith O 1.5 Hits" grades WIN (2H > 1.5)',
    willE2E && willE2E.resolved === true && willE2E.status === 'WIN', JSON.stringify(willE2E));
  // Control: a UNIQUE surname genuinely absent on a fully-final slate STILL provable-VOIDs
  // (proves the ambiguity flag did not disable real provable-absence detection).
  global.fetch = makeFetch({
    schedule: scheduleWith([{ gamePk: 88, status: { abstractGameState: 'Final', detailedState: 'Final' },
      teams: { away: { team: { name: 'Detroit Tigers' }, score: 1 }, home: { team: { name: 'Kansas City Royals' }, score: 4 } } }]),
    feeds: { '88': { teams: {
      home: { team: { name: 'Kansas City Royals' }, players: { id1: batter('Bobby Witt Jr.', 2) } },
      away: { team: { name: 'Detroit Tigers' }, players: { id2: batter('Riley Greene', 1) } },
    } } },
  });
  const absentVoid = await mlb.gradeMlbPlayerProp('Trout O 1.5 Hits', '2026-05-01', { absenceVoidAllowed: true });
  check('unique absent surname on final slate STILL VOIDs (provable absence intact)',
    absentVoid && absentVoid.resolved === true && absentVoid.status === 'VOID', JSON.stringify(absentVoid));

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
