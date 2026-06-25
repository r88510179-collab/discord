// ═══════════════════════════════════════════════════════════
// Stop-word alias phantom-team injection — CONTEXTUAL skip.
//
// findMentionedTeams (services/grading.js) extracts teams by word-boundary
// match over ALIAS_TO_TEAMS. Four single-team aliases double as ordinary
// bet-slip vocabulary AND as legitimate scoreboard abbreviations:
//   'no'   → New Orleans Saints   ("Draw No Bet", "BTTS No" │ "NO 24, NYJ 17")
//   'as'   → Oakland Athletics    ("... win as favorites"   │ "AS 5, NYY 3")
//   'wild' → Minnesota Wild       ("Wild Card")
//   'sac'  → Sacramento Kings     ("sac fly", "sac bunt")
//
// The same token needs OPPOSITE handling depending on context, so the skip is
// gated on findMentionedTeams' opts.isEvidence flag:
//
//   BET-TEXT (isEvidence:false / default) — stop-list ACTIVE. Matched as bare
//     tokens these inject a team the bettor never named, which (a) poisons the
//     soccer search query and trips GUARD 7 into a false-PENDING, and (b) can
//     flip an NFL/MLB ML/spread grade when the phantom is the bettor's opponent
//     ("Jets No Moneyline" → ['saints','jets'] → ESPN keyed on Saints, Jets WIN
//     flipped to LOSS). The bare token must be DROPPED here.
//
//   EVIDENCE / scoreboard (isEvidence:true) — stop-list INACTIVE. Here "NO 24"
//     is a real abbreviation for the Saints. GUARD 7 verifies the bet's own team
//     appears in its evidence; dropping the abbreviation makes the bet team go
//     missing from its own scoreboard → false-PENDING. The bare token must be
//     KEPT here.
//
// An unconditional stop-list fixes (1) but reintroduces the evidence regression;
// no stop-list fixes the evidence side but reintroduces the phantom. The
// contextual gate satisfies both. This test proves BOTH directions.
//
// Pure in-memory lookups. No network.
//
// NOTE on signature: findMentionedTeams(description, sportContext, opts) — the
// sportContext positional param is preserved, opts (with isEvidence) is the
// third arg. Evidence callers pass (text, ctx, { isEvidence: true }).
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const { findMentionedTeams, normalizeSportContext } = require('../services/grading');

let pass = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); pass++; };

// Bet-text extraction (stop-list ACTIVE): sport run through the real
// normalizeSportContext so the test exercises the exact null-vs-league path
// production uses; opts omitted → isEvidence defaults to false.
function betTeamsFor(description, sport) {
  const { matchedTeams } = findMentionedTeams(description, normalizeSportContext(sport));
  return [...matchedTeams].sort();
}
function expectBetTeams(description, sport, expected, label) {
  const got = betTeamsFor(description, sport);
  const want = [...expected].sort();
  eq(JSON.stringify(got), JSON.stringify(want), `[bet-text] ${label}: "${description}" (${sport}) → [${got.join(', ')}]`);
}

// Evidence / scoreboard text (stop-list INACTIVE): isEvidence:true.
function evidenceTeamsFor(text, sport) {
  const { matchedTeams } = findMentionedTeams(text, normalizeSportContext(sport), { isEvidence: true });
  return [...matchedTeams].sort();
}
function expectEvidenceTeams(text, sport, expected, label) {
  const got = evidenceTeamsFor(text, sport);
  const want = [...expected].sort();
  eq(JSON.stringify(got), JSON.stringify(want), `[evidence] ${label}: "${text}" (${sport}) → [${got.join(', ')}]`);
}

// ═══════════════ DIRECTION 1 — BET-TEXT (stop-list ACTIVE) ═══════════════
// RED-proof: every assertion in this block FAILS if the bet-text skip is
// removed (the phantom team reappears).

// SOCCER: normalizeSportContext('Soccer') is null → no sport scoping. The
// observed live bets, plus the other stop-word markets, must extract NOTHING.
expectBetTeams('Canada Draw No Bet', 'Soccer', [], 'soccer DNB');
expectBetTeams('Ecuador vs Germany - No Both Teams to Score', 'Soccer', [], 'soccer BTTS-No parlay leg');
expectBetTeams('No Both Teams To Score', 'Soccer', [], 'soccer BTTS-No');
expectBetTeams('First Half No Goal', 'Soccer', [], 'soccer no first-half goal');
expectBetTeams('Spain win as favorites', 'Soccer', [], "soccer 'as' (Athletics) phantom");

// NON-SOCCER bare-token collisions in real bet vocabulary.
expectBetTeams('Vikings Wild Card over 45.5', 'NFL', ['minnesota vikings'], "NFL 'wild card' keeps only Vikings (no NHL Wild)");
expectBetTeams('Player over 0.5 sac flies', 'MLB', [], "MLB 'sac fly' (Kings) phantom gone");

// THE GRADE-FLIP CASE: phantom Saints removed, real team retained, so the ESPN
// grader now keys on the Jets — converting the confident wrong LOSS back to WIN.
expectBetTeams('Jets No Moneyline', 'NFL', ['new york jets'], 'NFL flip case — only Jets, no Saints');

// ── Legitimate resolutions must SURVIVE the bet-text skip ──
// Distinct nickname alias (not stop-listed) still resolves.
expectBetTeams('Saints -3', 'NFL', ['new orleans saints'], "'saints' nickname still resolves");
expectBetTeams('Athletics over 4.5 runs', 'MLB', ['oakland athletics'], "'athletics' nickname still resolves");
expectBetTeams('Sacramento Kings -5', 'NBA', ['sacramento kings'], "'kings'/canonical still resolves");
// Full canonical name always resolves — including the Wild, whose only
// non-stopword identifier is the canonical.
expectBetTeams('New Orleans Saints ML', 'NFL', ['new orleans saints'], 'Saints canonical');
expectBetTeams('Oakland Athletics -1.5', 'MLB', ['oakland athletics'], 'Athletics canonical');
expectBetTeams('Minnesota Wild ML', 'NHL', ['minnesota wild'], 'Wild canonical (no nickname alias survives)');
// Unrelated multi-team descriptions are untouched by the fix.
expectBetTeams('Lakers vs Celtics over 220', 'NBA', ['boston celtics', 'los angeles lakers'], 'unaffected two-team NBA');

// ── Acceptable losses — safe fall-through (a missing grade, never a wrong one) ──
expectBetTeams('NO -3', 'NFL', [], "bare 'NO' in bet-text → safe fall-through");
expectBetTeams('Wild ML', 'NHL', [], "bare 'Wild' nickname in bet-text → safe fall-through");

// ═══════════════ DIRECTION 2 — EVIDENCE (stop-list INACTIVE) ═══════════════
// RED-proof: every assertion in this block FAILS under an UNCONDITIONAL
// stop-list (the scoreboard abbreviation gets dropped and the Saints vanish).

// Bare scoreboard abbreviation resolves the Saints in evidence text.
expectEvidenceTeams('NO 24, NYJ 17', 'NFL', ['new orleans saints', 'new york jets'], "'NO' abbreviation preserved");
expectEvidenceTeams('Final: AS 5, NYY 3', 'MLB', ['new york yankees', 'oakland athletics'], "'AS' abbreviation preserved");

// Same input, opposite flag → opposite result. This IS the contextual split.
eq(
  JSON.stringify(betTeamsFor('NO 24, NYJ 17', 'NFL')),
  JSON.stringify(['new york jets']),
  '[contrast] bet-text drops bare NO → only Jets',
);
eq(
  JSON.stringify(evidenceTeamsFor('NO 24, NYJ 17', 'NFL')),
  JSON.stringify(['new orleans saints', 'new york jets']),
  '[contrast] evidence keeps bare NO → Saints + Jets',
);

// ── GUARD-7 scenario: "Saints -3" graded against an abbreviated scoreboard must
//    NOT force a false PENDING. Mirrors the GUARD 7 logic in gradePropWithAI:
//    bet teams from bet-text (active), evidence teams from evidence (inactive),
//    and the bet team must be found in its own evidence (missing == none). ──
function guard7Missing(betDesc, evidenceText, sport) {
  const ctx = normalizeSportContext(sport);
  const betTeams = [...findMentionedTeams(betDesc, ctx).matchedTeams];                       // bet-text
  const evTeams = [...findMentionedTeams(evidenceText, ctx, { isEvidence: true }).matchedTeams]; // evidence
  return betTeams.filter(bt => !evTeams.includes(bt));
}
eq(
  JSON.stringify(guard7Missing('Saints -3', 'Final score — NO 24, NYJ 17', 'NFL')),
  JSON.stringify([]),
  "GUARD-7: 'Saints -3' found in abbreviated scoreboard evidence → no false PENDING",
);
// Sanity: the bet team really was extracted (so the empty-missing above is a
// genuine match, not an empty-vs-empty fluke).
eq(
  JSON.stringify([...findMentionedTeams('Saints -3', normalizeSportContext('NFL')).matchedTeams]),
  JSON.stringify(['new orleans saints']),
  "GUARD-7 precondition: 'Saints -3' bet team is the Saints",
);

// ═══════════════ DIRECTION 3 — EMPTY-TEAM GAME GUARD (GUARD 7b) ═══════════════
// The contextual stop-list drops bare aliases in bet-text, so a bet named ONLY
// by one ("Wild ML") resolves to NO team. On the live AI path the ESPN fast-path
// can't match it and GUARD 7 is skipped, so a wrong same-sport game could be
// graded WIN/LOSS. isUnresolvableTeamGameBet flags exactly that case so the
// caller forces PENDING (never a wrong AI grade). Resolvable teams, player props,
// individual sports, soccer, and NCAAF must be UNAFFECTED.
//
// betTeamList is computed the production way (findMentionedTeams over the
// description in bet-text mode) so this chains the real stop-list to the guard.
const { isUnresolvableTeamGameBet } = require('../services/grading');
function wouldHold(description, sport) {
  const betTeamList = [...findMentionedTeams(description, normalizeSportContext(sport)).matchedTeams];
  return isUnresolvableTeamGameBet({ sport, description }, betTeamList);
}
function expectHold(description, sport, want, label) {
  eq(wouldHold(description, sport), want, `[guard7b] ${label}: "${description}" (${sport}) → ${want ? 'PENDING' : 'grades'}`);
}

// The wild vector and its siblings: named ONLY by a bare stop-listed alias → no
// team resolves → guard forces PENDING (not a wrong WIN/LOSS).
expectHold('Wild ML', 'NHL', true, 'bare "Wild ML" → PENDING (the closed vector)');
expectHold('Wild -1.5', 'NHL', true, 'bare "Wild -1.5" → PENDING');
expectHold('NO ML', 'NFL', true, 'bare "NO ML" → PENDING');
expectHold('Sac ML', 'NBA', true, 'bare "Sac ML" → PENDING');
expectHold('AS ML', 'MLB', true, 'bare "AS ML" → PENDING');

// Resolvable team bets STILL grade (team present → ESPN/GUARD 7 own them).
expectHold('Minnesota Wild ML', 'NHL', false, 'canonical "Minnesota Wild ML" still grades');
expectHold('Saints -3', 'NFL', false, '"Saints -3" (nickname) still grades');
expectHold('Lakers vs Celtics over 220', 'NBA', false, 'two-team game bet still grades');

// Scoped OUT — player props of ANY sport must keep grading. The guard exempts a
// recognized prop SHAPE (isPlayerPropDescription) OR any named multi-token player,
// so the narrow NFL-stat gaps in isPlayerPropDescription do NOT over-PENDING props.
expectHold('LeBron James Over 25.5 Points', 'NBA', false, 'NBA player prop unaffected');
expectHold('Patrick Mahomes Over 250.5 Passing Yards', 'NFL', false, 'recognized NFL prop shape unaffected');
// NFL props that isPlayerPropDescription does NOT recognize (singular "TD",
// "Sacks", "Tackles", "Interceptions", "Alt … Yards N+", composite/segment) —
// exempted via the named-player path; would have been wrongly held without it.
expectHold('Bijan Robinson 1+ TD', 'NFL', false, 'NFL "1+ TD" prop grades (named-player exemption)');
expectHold('Micah Parsons 1+ Sacks', 'NFL', false, 'NFL "Sacks" prop grades (named-player exemption)');
expectHold('Roquan Smith Over 9.5 Tackles', 'NFL', false, 'NFL "Tackles" prop grades (named-player exemption)');
expectHold('Patrick Mahomes Under 0.5 Interceptions', 'NFL', false, 'NFL "Interceptions" prop grades (named-player exemption)');
expectHold('Patrick Mahomes Alt Passing Yards 250+', 'NFL', false, 'NFL "Alt … Yards N+" prop grades (named-player exemption)');
expectHold('Jalen Hurts Passing + Rushing Yards Over 300.5', 'NFL', false, 'NFL composite prop grades (named-player exemption)');
expectHold('Alcaraz ML', 'TENNIS', false, 'individual sport unaffected (GUARD 8 owns it)');
expectHold('Brazil ML', 'Soccer', false, 'soccer unaffected (own adapter)');
expectHold('Texas Longhorns ML', 'NCAAF', false, 'NCAAF unaffected (bet.sport stays NCAAF)');

// Team totals: a NAMED-team total resolves its team and grades; a teamless total
// has no team to verify and is held (accepted PENDING-over-coverage).
expectHold('Mariners Team Total Over 4.5', 'MLB', false, 'named team-total resolves the team → grades');
expectHold('Team Total Over 4.5', 'MLB', true, 'teamless team-total → PENDING');

// Bare game totals naming no team are held too (the accepted in-scope behavior).
// Note the prop-shaped boundary: a total carrying a stat word ("Over 6.5 goals")
// is treated as a prop shape and grades, while a bare number ("Over 47.5") holds.
expectHold('Over 47.5', 'NFL', true, 'bare game total (no team, no stat word) → PENDING');
expectHold('Under 220.5', 'NBA', true, 'bare game total → PENDING');
expectHold('Over 6.5 goals', 'NHL', false, 'prop-shaped total (stat word) grades — documents the boundary');

console.log(`\n✅ stopword-alias-phantom (contextual): all ${pass} assertions passed.`);
