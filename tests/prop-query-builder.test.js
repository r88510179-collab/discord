// ═══════════════════════════════════════════════════════════
// buildGraderSearchQuery must build a STAT-SEEKING query for player
// props, not a game "final score" query.
//
// Bug (verified live against real bet objects): the builder had no
// player-prop branch. Its logic is team-only — 2 teams → "X vs Y final
// score", 1 team → "team game final score", else → extractSubject +
// "final score". A player prop matches 0 teams, so it fell to the else
// and built "<player> <sport> final score <date>". A game final score
// never contains an individual player's stat line, so the LLM got recaps
// without the data, returned PENDING{evidence:""}, and the bet looped
// forever (live: NBA 52937045 → 30 grading cycles; MLB 0f50c2bf).
//
// Fix: a player-prop branch at the TOP of the query construction builds
// "<subject> <statKeyword> <date> box score", targeting box-score /
// game-log pages. Team and game-total queries MUST remain byte-identical.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { buildGraderSearchQuery } = require('../services/grading');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

console.log('prop-query-builder:');

const DATE = '2026-05-31';
// Render the date exactly as the builder does so byte-identity assertions
// are timezone-independent (both sides resolve in the same runtime TZ).
const DATE_STR = new Date(DATE).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// ── 1. Player props get a stat/box-score query, NOT "final score" ──
{
  const q = buildGraderSearchQuery({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB', event_date: DATE });
  check('MLB prop: query names the player "Ramon Laureano"', /Ramon Laureano/.test(q), `q="${q}"`);
  check('MLB prop: query carries a stat / box-score term', /\bhits\b/i.test(q) && /box score/i.test(q), `q="${q}"`);
  check('MLB prop: query is NOT a "final score" game query', !/final score/i.test(q), `q="${q}"`);
}

{
  const q = buildGraderSearchQuery({ description: 'Naz Reid 15+ PTS + REB', sport: 'NBA', event_date: DATE });
  check('NBA prop: query names the player "Naz Reid"', /Naz Reid/.test(q), `q="${q}"`);
  check('NBA prop: query carries a stat / box-score term', /\bpts\b/i.test(q) && /box score/i.test(q), `q="${q}"`);
  check('NBA prop: query is NOT a "final score" game query', !/final score/i.test(q), `q="${q}"`);
}

{
  const q = buildGraderSearchQuery({ description: 'Stephen Curry Over 25.5 Points', sport: 'NBA', event_date: DATE });
  check('NBA prop: query names the player "Stephen Curry"', /Stephen Curry/.test(q), `q="${q}"`);
  check('NBA prop: query carries the "points" stat term', /\bpoints\b/i.test(q), `q="${q}"`);
  check('NBA prop: query is NOT a "final score" game query', !/final score/i.test(q), `q="${q}"`);
}

// ── 2. Segment-scoped prop keeps its period qualifier (box-score, not final) ──
// The "1st Quarter" qualifier scopes the prop to a game segment; dropping it
// would make the search return whole-game data. (Also guards the existing
// search-backend-honesty / query-builder-bing-parse ordinal expectations.)
{
  const q = buildGraderSearchQuery({ description: 'Stephon Castle O 1.5 1st Quarter Points', sport: 'NBA', event_date: '2026-06-08' });
  check('segment prop: "1st" qualifier survives', /\b1st\b/.test(q), `q="${q}"`);
  check('segment prop: "Quarter" segment survives', /quarter/i.test(q), `q="${q}"`);
  check('segment prop: line "1.5" stripped', !q.includes('1.5'), `q="${q}"`);
  check('segment prop: not a "final score" query', !/final score/i.test(q) && /box score/i.test(q), `q="${q}"`);
}

// ── 3. Odds-bearing prop strips odds, still box-score ──
{
  const q = buildGraderSearchQuery({ description: 'Jordan Love OVER 1.5 Passing TDs -110', sport: 'NFL', event_date: '2026-06-08' });
  check('odds prop: names "Jordan Love"', /jordan/i.test(q) && /love/i.test(q), `q="${q}"`);
  check('odds prop: line "1.5" and odds "110" stripped', !q.includes('1.5') && !/110/.test(q), `q="${q}"`);
  check('odds prop: stat-seeking, not "final score"', !/final score/i.test(q) && /box score/i.test(q), `q="${q}"`);
}

// ── 4. Prop with an UNEXTRACTABLE name still avoids the bare game query ──
// "over 1.5 goals" — all lowercase, no recoverable player name — is still a
// prop (OVER + number + GOALS). It must NOT degrade to a "final score" query.
{
  const q = buildGraderSearchQuery({ description: 'over 1.5 goals', sport: 'Soccer', event_date: DATE });
  check('nameless prop: NOT a "final score" game query', !/final score/i.test(q), `q="${q}"`);
  check('nameless prop: still stat-seeking ("box score")', /box score/i.test(q), `q="${q}"`);
}

// Pattern-3 prop ("Anytime Goal") has no PLAYER_PROP_STAT_RX keyword — must
// still box-score on the player, never "final score".
{
  const q = buildGraderSearchQuery({ description: 'Connor McDavid Anytime Goal', sport: 'NHL', event_date: DATE });
  check('anytime prop: names "Connor McDavid"', /Connor McDavid/.test(q), `q="${q}"`);
  check('anytime prop: NOT a "final score" game query', !/final score/i.test(q) && /box score/i.test(q), `q="${q}"`);
}

// ── 4b. Stats NOT in extractSubject's strip list are not DUPLICATED ──
// extractSubject strips most stat tokens, but its strip-list is a subset of
// PLAYER_PROP_GUARD_STATS — "Total Bases" / "PRA" / "Threes" survive in the
// subject. The branch must surface the stat WITHOUT repeating it.
function countOccurrences(haystack, needle) {
  return haystack.toLowerCase().split(needle.toLowerCase()).length - 1;
}
{
  const q = buildGraderSearchQuery({ description: 'Mike Trout Over 1.5 Total Bases', sport: 'MLB', event_date: DATE });
  check('exotic stat: "Total Bases" present', /total bases/i.test(q), `q="${q}"`);
  check('exotic stat: "Total Bases" appears exactly once (no dup)', countOccurrences(q, 'total bases') === 1, `q="${q}"`);
  check('exotic stat: not a "final score" query', !/final score/i.test(q) && /box score/i.test(q), `q="${q}"`);
}
{
  const q = buildGraderSearchQuery({ description: 'Luka Doncic Over 40.5 PRA', sport: 'NBA', event_date: DATE });
  check('exotic stat: "PRA" present and appears exactly once', /\bpra\b/i.test(q) && countOccurrences(q, 'pra') === 1, `q="${q}"`);
  check('exotic stat: names "Luka Doncic"', /Luka Doncic/.test(q), `q="${q}"`);
}

// ── 5. REGRESSION — team / game-total queries are BYTE-IDENTICAL ──
// A pure team bet must produce exactly the team-branch query, unchanged.
{
  const q = buildGraderSearchQuery({ description: 'New York Yankees ML', sport: 'MLB', event_date: DATE });
  const expected = `yankees MLB game ${DATE_STR} final score`;
  check('team bet: byte-identical "team game final score" query', q === expected, `got "${q}", expected "${expected}"`);
  check('team bet: NOT rerouted to a "box score" query', !/box score/i.test(q), `q="${q}"`);
}

{
  const q = buildGraderSearchQuery({ description: 'Yankees Red Sox Over 8.5', sport: 'MLB', event_date: DATE });
  const expected = `sox vs yankees MLB final score ${DATE_STR}`;
  check('game total: byte-identical "X vs Y final score" query', q === expected, `got "${q}", expected "${expected}"`);
  check('game total: NOT rerouted to a "box score" query', !/box score/i.test(q), `q="${q}"`);
}

// A semantically-prop string that isPlayerPropDescription does NOT classify
// (no space in "O0.5") stays in the team/else path — proves the fix reuses
// the existing detector verbatim and does not silently broaden it.
{
  const q = buildGraderSearchQuery({ sport: 'MLB', description: 'CJ Abrams O0.5 Hits', created_at: '2026-06-14' });
  check('undetected "O0.5" prop: stays final-score (detector unchanged)', /final score/i.test(q) && !/box score/i.test(q), `q="${q}"`);
}

// ── 6. No event_date must not throw (falls back to created_at → "") ──
{
  let q;
  try {
    q = buildGraderSearchQuery({ description: 'Ramon Laureano O 0.5 Hits', sport: 'MLB' });
    check('prop without event_date: no throw, still box-score', /Ramon Laureano/.test(q) && /box score/i.test(q) && !/final score/i.test(q), `q="${q}"`);
  } catch (err) {
    check('prop without event_date: no throw, still box-score', false, err.message);
  }
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
