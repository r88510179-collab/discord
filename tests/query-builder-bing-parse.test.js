// ═══════════════════════════════════════════════════════════
// query-builder-bing-parse — fix/query-builder-bing-parse
//
// Part 1 (query artifacts in extractSubject / buildGraderSearchQuery):
//   (a) Slash fusion — slashes JOIN tokens and must become a SPACE, never
//       be deleted. Live specimen: "McGhee/Yannis ITD" produced the query
//       "McGheeYannis ITD"; DubClub "CHC/PHI" → "CHCPHI". Must survive as
//       "McGhee Yannis" / "CHC PHI".
//   (b) Stray dash — odds stripping leaves orphan dashes/parens. Live
//       specimen: "Joanderson Brito ML (-165)" produced "Joanderson Brito -
//       UFC final score...". Orphan dash-runs (isolated by whitespace) are
//       dropped; intra-word hyphens ("Saint-Denis") survive.
//   Regression: the #74 ordinal/period protections (1st-4th, 1H/2H,
//   1Q-4Q, F5) must still pass.
//
// Part 2 (defensive Bing parse): parseBingHtml is fixture-driven over known
// markup variants (classic b_caption>p, newer b_lineclamp, anchor-only
// title). A rotted-markup fixture (no recognized organic wrapper) must
// return [] so assessSearchResults flags parse_empty — the S2 honesty gate
// then falls the chain through to Brave. Full searchWeb chain fall-through
// is covered end-to-end in search-backend-honesty.test.js; here we lock the
// pure parse → parse_empty contract.
//
// Live-capture note: a curl of bing.com/search from this environment returns
// only the search-box shell (no organic results), so fixtures are built from
// known Bing markup variants rather than a captured live response.
// ═══════════════════════════════════════════════════════════

const grading = require('../services/grading');
const { buildGraderSearchQuery } = grading;
const { extractSubject, parseBingHtml, assessSearchResults } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

const DATE = '2026-06-08';

console.log('query-builder-bing-parse:');

// ── Part 1a — slash fusion → space (never deleted) ──
{
  const subj = extractSubject('McGhee/Yannis ITD');
  check('slash: "McGhee/Yannis" → "McGhee Yannis" (space, not fused)', /McGhee Yannis/.test(subj), `subject="${subj}"`);
  check('slash: NOT fused into "McGheeYannis"', !/McGheeYannis/.test(subj), `subject="${subj}"`);

  const q = buildGraderSearchQuery({ description: 'McGhee/Yannis ITD', sport: 'UFC', event_date: DATE });
  check('slash: query keeps "McGhee Yannis"', /McGhee Yannis/.test(q) && !/McGheeYannis/.test(q), `q="${q}"`);

  // DubClub/total abbreviation format must survive the same way.
  const chc = extractSubject('CHC/PHI');
  check('slash: "CHC/PHI" → "CHC PHI"', chc === 'CHC PHI', `subject="${chc}"`);
}

// ── Part 1b — stray dash from stripped odds ──
{
  const subj = extractSubject('Joanderson Brito ML (-165)');
  check('dash: "Joanderson Brito ML (-165)" → "Joanderson Brito" (no orphan dash)', subj === 'Joanderson Brito', `subject="${subj}"`);

  const q = buildGraderSearchQuery({ description: 'Joanderson Brito ML (-165)', sport: 'UFC', event_date: DATE });
  check('dash: query has no orphan " - "', !/\s-\s/.test(q) && !/\s-$/.test(q), `q="${q}"`);
  check('dash: subject "Joanderson Brito" preserved', /Joanderson Brito/.test(q), `q="${q}"`);
  check('dash: no leftover empty parens', !/[()]/.test(q), `q="${q}"`);

  // Intra-word hyphens (real fighter/player names) must NOT be eaten.
  const hyphen = extractSubject('Benoit Saint-Denis ML');
  check('dash: intra-word hyphen "Saint-Denis" survives', /Saint-Denis/.test(hyphen), `subject="${hyphen}"`);

  // "-110 ML" must strip the odds digits AND drop the orphan dash.
  const odds = extractSubject('Team Name -110 ML');
  check('dash: "-110" odds digits stripped, no orphan dash', !/110/.test(odds) && !/-/.test(odds), `subject="${odds}"`);
}

// ── Part 1c — #74 ordinal/period protections still pass ──
{
  check('ordinal: "1st" survives', /\b1st\b/.test(extractSubject('Stephon Castle O 1.5 1st Quarter Points')));
  check('ordinal: "2nd" survives', /\b2nd\b/.test(extractSubject('Luka Doncic 2nd Half Assists')));
  check('ordinal: "3rd" survives', /\b3rd\b/.test(extractSubject('Player Name 3rd Quarter Points')));
  check('ordinal: "4th" survives', /\b4th\b/.test(extractSubject('Player Name 4th Quarter Rebounds')));
  check('ordinal: "1H" survives', /\b1H\b/i.test(extractSubject('Patrick Mahomes 1H Passing Yards')));
  check('ordinal: "2H" survives', /\b2H\b/i.test(extractSubject('Team Total 2H Points')));
  check('ordinal: "1Q" survives', /\b1Q\b/i.test(extractSubject('Player Name 1Q Points')));
  check('ordinal: "4Q" survives', /\b4Q\b/i.test(extractSubject('Player Name 4Q Rebounds')));
  check('ordinal: "F5" survives', /\bF5\b/i.test(extractSubject('Gerrit Cole Over 4.5 Ks F5')));
  const castle = extractSubject('Stephon Castle O 1.5 1st Quarter Points');
  check('ordinal: specimen not mangled to bare "st"', !/(^|\s)st(\s|$)/.test(castle), `subject="${castle}"`);
  check('ordinal: specimen line "1.5" stripped', !castle.includes('1.5'), `subject="${castle}"`);
}

// ── Part 2 — defensive Bing parse over markup variants ──

// Variant A — classic organic block: <h2> title + b_caption>p snippet.
const CLASSIC = `<ol id="b_results">
  <li class="b_algo"><div class="b_tpcn"><a href="https://espn.com"><h2>Lakers 110, Celtics 102: Final score recap</h2></a></div>
    <div class="b_caption"><p>The Los Angeles Lakers beat the Boston Celtics 110-102 on June 8.</p></div></li>
  <li class="b_algo"><h2><a href="https://nba.com">Celtics vs Lakers box score</a></h2>
    <div class="b_caption"><p>Full box score and player stats for the game.</p></div></li>
</ol>`;

// Variant B — newer markup: snippet in <p class="b_lineclamp2">, no b_caption.
const LINECLAMP = `<li class="b_algo"><h2><a href="https://cbssports.com">Lakers vs Celtics result</a></h2>
  <p class="b_lineclamp2 b_paractl">Lakers won 110-102. Recap and highlights.</p></li>`;

// Variant C — title only in a bare <a> (old style, no <h2>); anchor fallback.
const ANCHOR_ONLY = `<div class="b_algo"><a href="https://x">Lakers Celtics final score</a><div class="b_caption"><p>Final: Lakers 110, Celtics 102.</p></div></div>`;

// Rotted — Microsoft renamed the organic wrapper; NONE of our delimiters
// match → zero hits → honest parse_empty fall-through (S2 backstop).
const ROTTED = `<html><body><ol id="b_results"><li class="b_no">No results found</li></ol>
  <div class="b_news"><a>MLB.com Scores</a></div></body></html>`;

{
  const a = parseBingHtml(CLASSIC);
  check('parse A: classic markup → 2 hits', a.length === 2, JSON.stringify(a));
  check('parse A: title from <h2>', a[0] && /Lakers 110, Celtics 102/.test(a[0].title), JSON.stringify(a[0]));
  check('parse A: title strips nested <a> (h2>a variant)', a[1] && a[1].title === 'Celtics vs Lakers box score', JSON.stringify(a[1]));
  check('parse A: snippet from b_caption>p', a[0] && /beat the Boston Celtics/.test(a[0].snippet), JSON.stringify(a[0]));

  const b = parseBingHtml(LINECLAMP);
  check('parse B: lineclamp snippet → 1 hit', b.length === 1, JSON.stringify(b));
  check('parse B: title parsed', b[0] && b[0].title === 'Lakers vs Celtics result', JSON.stringify(b[0]));
  check('parse B: snippet from b_lineclamp', b[0] && /Lakers won 110-102/.test(b[0].snippet), JSON.stringify(b[0]));

  const c = parseBingHtml(ANCHOR_ONLY);
  check('parse C: anchor-only title fallback → 1 hit with title+snippet', c.length === 1 && c[0].title === 'Lakers Celtics final score' && /Final: Lakers/.test(c[0].snippet), JSON.stringify(c));

  // Rotted markup → honest fall-through.
  const r = parseBingHtml(ROTTED);
  check('parse rotted: zero hits (no recognized wrapper)', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  const assessed = assessSearchResults(r, 'Lakers Celtics final score June', { checkRelevance: true });
  check('parse rotted: assess → parse_empty (honest fall-through, gate not weakened)', assessed.status === 'parse_empty', JSON.stringify(assessed));

  // Empty/garbage inputs are safe.
  check('parse: null input → []', parseBingHtml(null).length === 0);
  check('parse: empty string → []', parseBingHtml('').length === 0);
  check('parse: junk HTML with no b_algo → []', parseBingHtml('<html><body>nope</body></html>').length === 0);

  // Parse still feeds the relevance gate: a parsed-but-irrelevant page is
  // generic_news (falls through WITHOUT tripping the breaker), not a false ok.
  const NEWS = `<li class="b_algo"><h2><a href="x">Breaking weather updates today</a></h2><div class="b_caption"><p>Top headlines and forecasts.</p></div></li>`;
  const newsHits = parseBingHtml(NEWS);
  check('parse: generic news parses into hits', newsHits.length === 1, JSON.stringify(newsHits));
  check('parse: irrelevant hits → generic_news (relevance gate intact)',
    assessSearchResults(newsHits, 'Lakers Celtics final score June', { checkRelevance: true }).status === 'generic_news');

  // 5-block cap (slice 1,6) preserved — feed 7 blocks, expect at most 5.
  const SEVEN = Array.from({ length: 7 }, (_, i) =>
    `<li class="b_algo"><h2><a href="x">Hit ${i}</a></h2><div class="b_caption"><p>snip ${i}</p></div></li>`).join('');
  check('parse: caps at 5 organic blocks', parseBingHtml(SEVEN).length === 5, String(parseBingHtml(SEVEN).length));
}

console.log(`\nquery-builder-bing-parse: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
