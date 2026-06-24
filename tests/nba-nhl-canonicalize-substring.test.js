// ═══════════════════════════════════════════════════════════
// NBA + NHL canonicalize() word-boundary fix (parity with the MLB adapter).
//
// services/sportsdata/nba.js and nhl.js resolved a team via `lower.includes(alias)`
// (bare substring) — the exact bug just fixed in mlb.js. Short aliases are substrings of
// real player surnames, so a clean player prop's subject resolved to a team:
//   nba.canonicalize("Dany Heatley")  → "Miami Heat"      ('heat'  ⊂ "Heatley")
//   nba.canonicalize("Marcus Kingsley") → "Sacramento Kings" ('kings' ⊂ "Kingsley")
//   nhl.canonicalize("Marc Habscheid") → "Canadiens"      ('habs'  ⊂ "Habscheid")
//   nhl.canonicalize("Brett Wilde")    → "Wild"           ('wild'  ⊂ "Wilde")
// That (a) made looksLikePlayerProp falsely REJECT a clean NBA/NHL player prop and
// (b) could route a player prop to the game-total grader — the same class as the MLB
// #130 false-WIN. Fix: match each alias only as a WHOLE WORD (\b-anchored, regex-escaped
// via escapeRegex), keeping the exact-alias fast path and the longest-alias-first order.
//
// Pure/offline — no network. Mirrors tests/mlb-canonicalize-substring-surname.test.js.
// ═══════════════════════════════════════════════════════════

const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// Run the same battery against an adapter.
//   nullNames  — strings whose surname embeds an alias substring → must be null now
//   resolves   — [input, expectedCanonical] real team descriptions that must still resolve
//   props      — clean player props (subject embeds an alias) → looksLikePlayerProp true
//   teamTotals — real game/team totals (subject IS a team) → looksLikePlayerProp false
function runSuite(name, adapter, { nullNames, resolves, props, teamTotals }) {
  console.log(` ${name} canonicalize:`);
  for (const n of nullNames) {
    check(`${name} canonicalize("${n}") → null`, adapter.canonicalize(n) === null, JSON.stringify(adapter.canonicalize(n)));
  }
  for (const [s, exp] of resolves) {
    check(`${name} canonicalize("${s}") → ${exp}`, adapter.canonicalize(s) === exp, JSON.stringify(adapter.canonicalize(s)));
  }
  // Every alias self-resolves as a whole word (incl. multi-word + abbrev + digit-prefix).
  const { TEAM_ALIASES } = adapter._internal;
  const badAliases = Object.keys(TEAM_ALIASES).filter(a => adapter.canonicalize(a) !== TEAM_ALIASES[a]);
  check(`${name} all ${Object.keys(TEAM_ALIASES).length} aliases self-resolve`, badAliases.length === 0, `bad=[${badAliases}]`);
  // null/empty safety.
  check(`${name} canonicalize(null) → null, no throw`, (() => { try { return adapter.canonicalize(null) === null; } catch (_) { return false; } })());
  check(`${name} canonicalize("") → null, no throw`, (() => { try { return adapter.canonicalize('') === null; } catch (_) { return false; } })());

  console.log(` ${name} looksLikePlayerProp (subject no longer mis-reads as a team):`);
  for (const d of props) {
    check(`${name} looksLikePlayerProp("${d}") → true`, adapter.looksLikePlayerProp(d) === true, JSON.stringify(adapter.looksLikePlayerProp(d)));
  }
  for (const d of teamTotals) {
    check(`${name} looksLikePlayerProp("${d}") → false (still a team total)`, adapter.looksLikePlayerProp(d) === false, JSON.stringify(adapter.looksLikePlayerProp(d)));
  }
}

console.log('nba-nhl-canonicalize-substring:');

runSuite('NBA', nba, {
  nullNames: [
    'Dany Heatley',      // 'heat' ⊂ heatley (real hockey player; demonstrates a NAME → NBA team)
    'Marcus Kingsley',   // 'kings' ⊂ kingsley
    'Spencer Heathcote', // 'heat' ⊂ heathcote
    'Jordan Heath',      // 'heat' ⊂ heath
    'Jayson Tatum',      // control — no alias substring
    'Nikola Jokic',      // control
  ],
  resolves: [
    ['Boston Celtics', 'Boston Celtics'],
    ['Lakers Over 220.5 Points', 'Los Angeles Lakers'],
    ['Portland Trail Blazers', 'Portland Trail Blazers'],   // multi-word alias "trail blazers"
    ['Trail Blazers ML', 'Portland Trail Blazers'],
    ['Philadelphia 76ers', 'Philadelphia 76ers'],           // digit-prefixed alias "76ers"
    ['76ers -5.5', 'Philadelphia 76ers'],
    ['OKC Thunder', 'Oklahoma City Thunder'],               // abbrev alias "okc"
    ['LA Clippers', 'LA Clippers'],
    ['Clippers vs Lakers', 'LA Clippers'],                  // "Team vs Team"
  ],
  props: [
    'Dany Heatley O 1.5 Points',     // pre-fix: subject → Miami Heat → rejected as a prop
    'Marcus Kingsley O 0.5 Assists', // pre-fix: subject → Sacramento Kings → rejected
    'Stephen Curry O 25.5 Points',   // non-colliding control (always worked)
  ],
  teamTotals: [
    'Los Angeles Lakers Over 220.5 Points',
    'Lakers Over 220.5 Points',
  ],
});

runSuite('NHL', nhl, {
  nullNames: [
    'Marc Habscheid',  // 'habs' ⊂ habscheid (real former NHL player → Canadiens pre-fix)
    'Brett Wilde',     // 'wild' ⊂ wilde
    'Adam Kingsley',   // 'kings' ⊂ kingsley
    'Connor McDavid',  // control
    'Cale Makar',      // control
  ],
  resolves: [
    ['Maple Leafs', 'Maple Leafs'],                 // multi-word alias "maple leafs"
    ['Leafs ML', 'Maple Leafs'],
    ['Blue Jackets Over 5.5', 'Blue Jackets'],      // multi-word alias "blue jackets"
    ['Edmonton Oilers', 'Oilers'],
    ['Oilers Over 6.5 Goals', 'Oilers'],
    ['Golden Knights -1.5', 'Golden Knights'],      // multi-word alias "golden knights"
    ['VGK ML', 'Golden Knights'],                   // abbrev alias "vgk"
    ['Red Wings', 'Red Wings'],
    ['Utah Mammoth', 'Mammoth'],
    ['Avalanche vs Stars', 'Avalanche'],            // "Team vs Team"
  ],
  props: [
    'Brett Wilde O 0.5 Goals',       // pre-fix: subject → Wild → rejected as a prop
    'Marc Habscheid O 1.5 Points',   // pre-fix: subject → Canadiens → rejected
    'Connor McDavid O 0.5 Goals',    // non-colliding control (always worked)
  ],
  teamTotals: [
    'Edmonton Oilers Over 6.5 Goals',
    'Oilers Over 6.5 Goals',
  ],
});

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
