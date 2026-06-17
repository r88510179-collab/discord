// ═══════════════════════════════════════════════════════════
// Prop-vs-team routing: the structured layer must send "O/U N <stat>"
// player props to the PROP grader, not the team grader.
//
// Bug (verified live @ 9cb28aa): the router predicate isPlayerProp
// (services/sportsdata/index.js) recognized neither a bare stat keyword
// like "hits" nor an "O N" numeric shape — its only numeric pattern,
// /\s\d+\+\s+/, needs a literal "+". So "Aaron Judge O 0.5 Hits" →
// isPlayerProp=false → dispatch sent it to mlb.gradeMlbBet (the TEAM
// grader) → no_team_found → fall-through to search+LLM → Gate 3 enforce
// forced PENDING. Single bets and parlay legs hit the same path.
// Meanwhile mlb.parsePlayerProp parsed "O 0.5 Hits" fine — the router and
// parser had diverged.
//
// Fix: isPropBet = isPlayerProp(desc) || adapter.looksLikePlayerProp(desc),
// where looksLikePlayerProp delegates to the per-sport parser (so router and
// parser can't disagree) and guards the team-total case. The guard is the
// SUBJECT, not the stat: parsePlayerProp matches a team total greedily
// ("Los Angeles Dodgers Over 8.5 Runs" → {player:"Los Angeles Dodgers",
// stat:"runs"} — empirically NON-null, contra the prior investigation), so
// if the subject before the O/U canonicalizes to a known team it is a team
// total. Keying on the subject (not a "runs"/"goals" blacklist) keeps a real
// player-runs prop ("Aaron Judge O 1.5 Runs") routed to the prop grader.
// ═══════════════════════════════════════════════════════════

const { isPropBet, isPlayerProp } = require('../services/sportsdata');
const mlb = require('../services/sportsdata/mlb');
const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');

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

// prop(desc, sport)  → expect isPropBet true
// team(desc, sport)  → expect isPropBet false
function prop(desc, sport) {
  check(`PROP: [${sport}] ${desc}`, isPropBet(desc, sport) === true, `isPropBet returned ${isPropBet(desc, sport)}`);
}
function team(desc, sport) {
  check(`TEAM: [${sport}] ${desc}`, isPropBet(desc, sport) === false, `isPropBet returned ${isPropBet(desc, sport)}`);
}

console.log('sportsdata-prop-routing:');

// ── MLB ───────────────────────────────────────────────────
console.log(' MLB:');
// The bug — O/U player props the old predicate missed:
prop('Aaron Judge O 0.5 Hits', 'MLB');
prop('Juan Soto O 1.5 Total Bases', 'MLB');
prop('Aaron Judge Over 1.5 Runs', 'MLB');           // player "runs" prop — guard must NOT blacklist the stat
prop('Tarik Skubal U 5.5 Hits', 'MLB');
// Already-working paths (regression guards — must still be prop):
prop('Mookie Betts 2+ Hits', 'MLB');                // "N+" shape
prop('Shohei Ohtani O 1.5 Hits+Runs+RBIs', 'MLB');  // compound, keyword-detected
// The risk case — team totals must route to the TEAM grader, NOT props:
team('Los Angeles Dodgers Over 8.5 Runs', 'MLB');
team('Yankees Over 8.5 Runs', 'MLB');
// Plain team bets stay team:
team('Atlanta Braves ML', 'MLB');
team('New York Yankees -1.5', 'MLB');
// Unknown stat in O/U shape → not claimed as a (gradeable) prop:
team('Aaron Judge O 1.5 Doubles', 'MLB');           // "doubles" ∉ STAT_MAP

// ── NBA ───────────────────────────────────────────────────
console.log(' NBA:');
prop('Stephen Curry O 25.5 Points', 'NBA');
prop('Nikola Jokic O 10.5 Rebounds', 'NBA');
prop('Luka Doncic O 39.5 PRA', 'NBA');              // compound keyword
team('Los Angeles Lakers Over 220.5 Points', 'NBA');
team('Lakers Over 220.5 Points', 'NBA');
team('Lakers -5.5', 'NBA');

// ── NHL ───────────────────────────────────────────────────
console.log(' NHL:');
prop('Connor McDavid O 0.5 Goals', 'NHL');
prop('Nathan MacKinnon O 1.5 Points', 'NHL');
prop('Connor McDavid Anytime Goal Scorer', 'NHL');  // keyword path, already worked
team('Edmonton Oilers Over 6.5 Goals', 'NHL');
team('Oilers Over 6.5 Goals', 'NHL');

// ── Sport spelling variants normalize, and unsupported sports don't throw ──
console.log(' routing plumbing:');
check('Baseball spelling routes the prop', isPropBet('Aaron Judge O 0.5 Hits', 'Baseball') === true);
check('unsupported sport → not prop, no throw',
  (() => { try { return isPropBet('Lionel Messi O 0.5 Goals', 'Soccer') === false; } catch (e) { return false; } })());

// ── Direct adapter-level guard checks (lock the subject-is-team guard) ──
// These call looksLikePlayerProp directly so they exercise the NEW branch even
// where isPlayerProp's keyword path would also fire through isPropBet.
console.log(' adapter looksLikePlayerProp guard:');
check('mlb player prop → true', mlb.looksLikePlayerProp('Aaron Judge O 0.5 Hits') === true);
check('mlb O/U single-stat (Total Bases) → true', mlb.looksLikePlayerProp('Juan Soto O 1.5 Total Bases') === true);
check('mlb compound branch (parsed.fields) → true', mlb.looksLikePlayerProp('Shohei Ohtani O 1.5 Hits+Runs+RBIs') === true);
check('mlb team total → false', mlb.looksLikePlayerProp('Los Angeles Dodgers Over 8.5 Runs') === false);
check('mlb unknown stat → false', mlb.looksLikePlayerProp('Aaron Judge O 1.5 Doubles') === false);
check('nba player prop → true', nba.looksLikePlayerProp('Stephen Curry O 25.5 Points') === true);
check('nba team total → false', nba.looksLikePlayerProp('Los Angeles Lakers Over 220.5 Points') === false);
check('nhl player prop → true', nhl.looksLikePlayerProp('Connor McDavid O 0.5 Goals') === true);
check('nhl team total → false', nhl.looksLikePlayerProp('Edmonton Oilers Over 6.5 Goals') === false);

// The guard keys on the SUBJECT, not the stat: same stat "runs", player vs team.
// If the canonicalize() guard were removed, the team line below would flip to true
// and this test would fail — so it proves the guard is load-bearing.
console.log(' guard keys on subject, not stat ("runs"):');
check('mlb "Aaron Judge Over 1.5 Runs" (player) → prop', mlb.looksLikePlayerProp('Aaron Judge Over 1.5 Runs') === true);
check('mlb "Yankees Over 1.5 Runs" (team) → NOT prop', mlb.looksLikePlayerProp('Yankees Over 1.5 Runs') === false);

// ── Null / empty safety on the new exported helper ──
console.log(' null/empty safety:');
check('isPropBet(null) → false, no throw',
  (() => { try { return isPropBet(null, 'MLB') === false; } catch (e) { return false; } })());
check('isPropBet(undefined) → false, no throw',
  (() => { try { return isPropBet(undefined, 'MLB') === false; } catch (e) { return false; } })());
check('isPropBet("") → false, no throw',
  (() => { try { return isPropBet('', 'MLB') === false; } catch (e) { return false; } })());

// ── Proof the OLD predicate alone could not do this (the bug is real) ──
console.log(' bug-presence assertions (isPlayerProp alone):');
check('isPlayerProp MISSES "Aaron Judge O 0.5 Hits"', isPlayerProp('Aaron Judge O 0.5 Hits') === false);
check('isPlayerProp keeps "Mookie Betts 2+ Hits"', isPlayerProp('Mookie Betts 2+ Hits') === true);

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
