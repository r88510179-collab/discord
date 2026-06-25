// ═══════════════════════════════════════════════════════════
// Stop-word alias phantom-team injection.
//
// Regression coverage for a phantom-team bug in findMentionedTeams
// (services/grading.js). A handful of team aliases double as ordinary
// bet-slip vocabulary:
//   'no'   → New Orleans Saints   ("Draw No Bet", "BTTS No", "No Goal")
//   'as'   → Oakland Athletics    ("... win as favorites")
//   'wild' → Minnesota Wild       ("Wild Card")
//   'sac'  → Sacramento Kings     ("sac fly", "sac bunt")
// Matched as bare tokens these injected a team the bettor never named.
//
// Two confirmed impacts the fix closes:
//   SOCCER false-PENDING — normalizeSportContext('Soccer') is null, so
//     filterTeamsBySport does no scoping and "Canada Draw No Bet" extracted
//     ['new orleans saints']. That phantom poisoned the search query AND
//     tripped GUARD 7 (team not in evidence) → forced PENDING on the AI path.
//   NON-SOCCER grade-flip — the filterTeamsBySport fallback keeps a
//     single-team alias even under a mismatched sport, and even when the
//     phantom's league DOES match (NFL "no"→Saints), so "Jets No Moneyline"
//     extracted ['new orleans saints','new york jets']. On a Jets@Saints slate
//     the ESPN grader used betTeams[0] (Saints) and flipped a Jets WIN to LOSS.
//
// Fix: findMentionedTeams skips STOPWORD_ALIASES as bare matches. Every
// affected team still resolves via its full canonical name (and, except the
// Wild, a distinct nickname), so only the bare-token form is dropped — and
// that safely falls through to search/AI instead of risking a wrong grade.
//
// Pure in-memory lookups. No network.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { findMentionedTeams, normalizeSportContext } = require('../services/grading');

let pass = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); pass++; };

// Extract the matched-team set for a (description, sport) and compare to an
// expected sorted list. sport is run through the real normalizeSportContext so
// the test exercises the exact null-vs-league path production uses.
function teamsFor(description, sport) {
  const { matchedTeams } = findMentionedTeams(description, normalizeSportContext(sport));
  return [...matchedTeams].sort();
}
function expectTeams(description, sport, expected, label) {
  const got = teamsFor(description, sport);
  const want = [...expected].sort();
  eq(JSON.stringify(got), JSON.stringify(want), `${label}: "${description}" (${sport}) → [${got.join(', ')}]`);
}

// ════════════════ Bug cases — phantom must be gone ════════════════

// SOCCER: normalizeSportContext('Soccer') is null → no sport scoping. The
// observed live bets, plus the other stop-word markets, must extract NOTHING.
expectTeams('Canada Draw No Bet', 'Soccer', [], 'soccer DNB');
expectTeams('Ecuador vs Germany - No Both Teams to Score', 'Soccer', [], 'soccer BTTS-No parlay leg');
expectTeams('No Both Teams To Score', 'Soccer', [], 'soccer BTTS-No');
expectTeams('First Half No Goal', 'Soccer', [], 'soccer no first-half goal');
expectTeams('Spain win as favorites', 'Soccer', [], "soccer 'as' (Athletics) phantom");

// NON-SOCCER bare-token collisions in real bet vocabulary.
expectTeams('Vikings Wild Card over 45.5', 'NFL', ['minnesota vikings'], "NFL 'wild card' keeps only Vikings (no NHL Wild)");
expectTeams('Player over 0.5 sac flies', 'MLB', [], "MLB 'sac fly' (Kings) phantom gone");

// THE GRADE-FLIP CASE: phantom Saints removed, real team retained, so the ESPN
// grader now keys on the Jets — converting the confident wrong LOSS back to WIN.
expectTeams('Jets No Moneyline', 'NFL', ['new york jets'], "NFL flip case — only Jets, no Saints");

// ════════════════ Legitimate resolutions must SURVIVE ════════════════

// Distinct nickname alias (not stop-listed) still resolves.
expectTeams('Saints -3', 'NFL', ['new orleans saints'], "'saints' nickname still resolves");
expectTeams('Athletics over 4.5 runs', 'MLB', ['oakland athletics'], "'athletics' nickname still resolves");
expectTeams('Sacramento Kings -5', 'NBA', ['sacramento kings'], "'kings'/canonical still resolves");

// Full canonical name always resolves — including the Wild, whose only
// non-stopword identifier is the canonical.
expectTeams('New Orleans Saints ML', 'NFL', ['new orleans saints'], 'Saints canonical');
expectTeams('Oakland Athletics -1.5', 'MLB', ['oakland athletics'], 'Athletics canonical');
expectTeams('Minnesota Wild ML', 'NHL', ['minnesota wild'], 'Wild canonical (no nickname alias survives)');

// Unrelated multi-team descriptions are untouched by the fix.
expectTeams('Lakers vs Celtics over 220', 'NBA', ['boston celtics', 'los angeles lakers'], 'unaffected two-team NBA');

// ════════════════ Acceptable losses — safe fall-through ════════════════
// Bare stop-word token with no corroborating name resolves to nothing, which
// degrades to the search/AI path (a missing grade, never a wrong one).
expectTeams('NO -3', 'NFL', [], "bare 'NO' abbreviation → safe fall-through");
expectTeams('Wild ML', 'NHL', [], "bare 'Wild' nickname → safe fall-through");

console.log(`\n✅ stopword-alias-phantom: all ${pass} assertions passed.`);
