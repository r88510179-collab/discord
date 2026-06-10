// ═══════════════════════════════════════════════════════════
// search-backend-honesty — COA audit M-3 + query ordinal fix (S2).
//
// Part 1 (backend honesty): an HTTP 200 with zero usable hits, or
// (Bing only) parsed-but-irrelevant homepage/news HTML, must NOT
// record a false `ok`. Instead:
//   - parse_empty  → registers as a CIRCUIT failure (same as a
//                    timeout/4xx) and the chain falls through.
//   - generic_news → falls through WITHOUT tripping the breaker.
// The /admin snapshot (getBackendSnapshot) must then show real
// per-backend state with last-success timestamps.
//
// Part 2 (query builder): ordinals/period qualifiers (1st/2nd/3rd/
// 4th, 1H/2H, F5) survive the strip; odds (-110) and lines (O 1.5)
// are still stripped. Live specimen: "Stephon Castle O 1.5 1st
// Quarter Points" was mangled to "...st Quarter..." (the 1 dropped).
//
// Strategy mirrors search-chain-order.test.js: mock globalThis.fetch
// BEFORE requiring grading.js; reach internals via grading._internal.
// Searches are never executed for real — responses are mocked,
// including a rotted-Bing 200 fixture.
// ═══════════════════════════════════════════════════════════

// Collapse searchWeb's inter-backend `await delay(1000)` (leave the
// 15s AbortSignal.timeout used inside fetches untouched).
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, ms <= 1000 ? 0 : ms, ...args);

process.env.BRAVE_API_KEY = process.env.BRAVE_API_KEY || 'test-brave-key';
process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || 'test-serper-key';

const callOrder = [];
// Per-backend response descriptors set by each scenario.
//   { kind: 'empty' }                 → HTTP 200, no parseable hits
//   { kind: 'rotted200' }             → HTTP 200 with drifted/garbage HTML (Bing)
//   { kind: 'genericNews' }           → HTTP 200, parsed hits unrelated to query (Bing)
//   { kind: 'relevantHit', token }    → HTTP 200, a hit whose title contains `token`
//   { kind: 'http', status }          → HTTP error (4xx/5xx)
const backendResponses = {
  bing: { kind: 'empty' },
  brave: { kind: 'empty' },
  ddg: { kind: 'empty' },
  serper: { kind: 'empty' },
};

function classifyUrl(url) {
  const u = String(url);
  if (u.includes('bing.com/search')) return 'bing';
  if (u.includes('api.search.brave.com')) return 'brave';
  if (u.includes('lite.duckduckgo.com')) return 'ddg';
  if (u.includes('google.serper.dev')) return 'serper';
  return null;
}

function htmlBingHit(title, snippet) {
  return `<div class="b_algo"><a href="x">${title}</a><div class="b_caption"><p>${snippet}</p></div></div>`;
}

function mockResponse(backend) {
  const r = backendResponses[backend];

  // HTTP error path (any backend).
  if (r.kind === 'http') {
    return { ok: false, status: r.status, json: async () => ({}), text: async () => '' };
  }

  if (backend === 'bing') {
    let html;
    if (r.kind === 'rotted200') {
      // Microsoft drifted the markup: HTTP 200, valid page, but no
      // class="b_algo" blocks → the parser extracts zero hits.
      html = '<html><body><div class="b_news"><a>MLB.com Scores</a></div></body></html>';
    } else if (r.kind === 'genericNews') {
      // Homepage/news HTML: parses into hits, but none mention the query.
      html = htmlBingHit('Breaking News Today', 'Top headlines and weather updates') +
             htmlBingHit('Shop the latest deals', 'Limited time offers all week');
    } else if (r.kind === 'relevantHit') {
      html = htmlBingHit(`Recap ${r.token}`, 'final score 110-102');
    } else {
      html = '<html></html>';
    }
    return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
  }

  if (backend === 'brave') {
    const results = r.kind === 'relevantHit'
      ? [{ title: `Recap ${r.token}`, description: 'final score 110-102' }]
      : [];
    const body = { web: { results } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  if (backend === 'serper') {
    const body = { organic: r.kind === 'relevantHit' ? [{ title: `Recap ${r.token}`, snippet: 'final' }] : [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  if (backend === 'ddg') {
    const html = r.kind === 'relevantHit'
      ? `<tr><a class="result-link" href="x">Recap ${r.token}</a><td class="result-snippet">final</td></tr>`
      : '<html></html>';
    return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
  }
  throw new Error(`Unknown backend: ${backend}`);
}

global.fetch = async (url) => {
  const backend = classifyUrl(url);
  if (!backend) throw new Error(`Unexpected fetch URL: ${url}`);
  callOrder.push(backend);
  return mockResponse(backend);
};

const grading = require('../services/grading');
const { backendHealth, isBackendHealthy, recordBackendResult, getBackendSnapshot, searchBrave, buildGraderSearchQuery } = grading;
const { searchWeb, assessSearchResults, extractSubject } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

function resetHealth() {
  for (const k of Object.keys(backendHealth)) {
    Object.assign(backendHealth[k], { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null });
  }
}
function setResponses(map) {
  for (const k of Object.keys(backendResponses)) backendResponses[k] = { kind: 'empty' };
  for (const [k, v] of Object.entries(map)) backendResponses[k] = v;
  callOrder.length = 0;
}

(async () => {
  console.log('search-backend-honesty:');

  // ── Part 1a — parse_empty fall-through (rotted-Bing 200 fixture) ──
  {
    resetHealth();
    setResponses({ bing: { kind: 'rotted200' }, brave: { kind: 'relevantHit', token: 'Lakers' } });
    const results = await searchWeb('Lakers Celtics final score June');
    check('rotted-Bing 200 → chain falls through to Brave (non-empty result)', results.length > 0, `len=${results.length}`);
    check('rotted-Bing recorded PARSE_EMPTY as a circuit failure', backendHealth.bing.lastError === 'PARSE_EMPTY' && backendHealth.bing.failCount === 1, JSON.stringify(backendHealth.bing));
    check('rotted-Bing did NOT record a false success', backendHealth.bing.lastSuccess === null);
    check('Brave was reached and succeeded', backendHealth.brave.lastSuccess !== null && callOrder.includes('brave'), `order=[${callOrder}]`);
  }

  // ── Part 1b — generic_news fall-through WITHOUT tripping the breaker ──
  {
    resetHealth();
    setResponses({ bing: { kind: 'genericNews' }, brave: { kind: 'relevantHit', token: 'Lakers' } });
    const results = await searchWeb('Lakers Celtics June');
    check('generic-news Bing → falls through to Brave', results.length > 0 && callOrder.includes('brave'), `order=[${callOrder}]`);
    check('generic-news did NOT record a Bing success', backendHealth.bing.lastSuccess === null);
    check('generic-news did NOT register a Bing circuit failure (failCount stays 0)', backendHealth.bing.failCount === 0 && backendHealth.bing.lastError === null, JSON.stringify(backendHealth.bing));
  }

  // ── Part 1c — a relevant Bing hit short-circuits (no fall-through) ──
  {
    resetHealth();
    setResponses({ bing: { kind: 'relevantHit', token: 'Lakers' } });
    const results = await searchWeb('Lakers Celtics June');
    check('relevant Bing hit → only Bing called', results.length > 0 && callOrder.length === 1 && callOrder[0] === 'bing', `order=[${callOrder}]`);
    check('relevant Bing hit records a real success', backendHealth.bing.lastSuccess !== null && backendHealth.bing.failCount === 0);
  }

  // ── Part 1d — HTTP 4xx/5xx register as circuit failures (same as timeouts) ──
  {
    resetHealth();
    setResponses({ brave: { kind: 'http', status: 404 } });
    await searchBrave('x'); // direct: Brave is gated, drive the 4xx branch
    check('HTTP 404 registers a circuit failure', backendHealth.brave.failCount === 1 && backendHealth.brave.lastError === 'HTTP_404', JSON.stringify(backendHealth.brave));
    check('one 4xx does not yet open the gated circuit', isBackendHealthy('brave') === true);

    resetHealth();
    setResponses({ brave: { kind: 'http', status: 500 } });
    await searchBrave('x'); await searchBrave('x'); await searchBrave('x');
    check('3 consecutive 5xx open the gated circuit', backendHealth.brave.failCount >= 3 && isBackendHealthy('brave') === false, JSON.stringify(backendHealth.brave));

    resetHealth();
    setResponses({ brave: { kind: 'http', status: 402 } });
    await searchBrave('x');
    check('HTTP 402 (quota) opens the circuit immediately', isBackendHealthy('brave') === false && backendHealth.brave.lastError === 'HTTP_402');
  }

  // ── Part 1e — parse_empty registers same as timeouts (opens gated circuit) ──
  {
    resetHealth();
    setResponses({ brave: { kind: 'empty' } });
    await searchBrave('x'); await searchBrave('x'); await searchBrave('x');
    check('3 consecutive parse_empty open the gated circuit', backendHealth.brave.failCount >= 3 && backendHealth.brave.lastError === 'PARSE_EMPTY' && isBackendHealthy('brave') === false, JSON.stringify(backendHealth.brave));
  }

  // ── Part 1f — assessSearchResults unit semantics ──
  {
    check('assess: zero results → parse_empty', assessSearchResults([], 'q').status === 'parse_empty');
    check('assess: blank title+snippet → parse_empty', assessSearchResults([{ title: '', snippet: '   ' }], 'q').status === 'parse_empty');
    check('assess: relevance off → ok regardless of query', assessSearchResults([{ title: 'unrelated', snippet: '' }], 'lakers celtics').status === 'ok');
    check('assess: relevance on, no token match → generic_news', assessSearchResults([{ title: 'weather news', snippet: 'today' }], 'lakers celtics', { checkRelevance: true }).status === 'generic_news');
    check('assess: relevance on, token match → ok', assessSearchResults([{ title: 'lakers win', snippet: '' }], 'lakers celtics', { checkRelevance: true }).status === 'ok');
    check('assess: relevance on but only short query tokens → ok (no false generic_news)', assessSearchResults([{ title: 'abc', snippet: '' }], 'a b c', { checkRelevance: true }).status === 'ok');
  }

  // ── Part 1g — snapshot state surface (getBackendSnapshot) ──
  {
    resetHealth();
    recordBackendResult('bing', true);
    let snap = getBackendSnapshot();
    const bing1 = snap.find(s => s.name === 'bing');
    check('snapshot: real success → state healthy with last-success timestamp', bing1.state === 'healthy' && typeof bing1.lastSuccessMs === 'number' && bing1.lastSuccessAgeMs !== null, JSON.stringify(bing1));

    const okStamp = backendHealth.bing.lastSuccess;
    recordBackendResult('bing', false, 'PARSE_EMPTY');
    snap = getBackendSnapshot();
    const bing2 = snap.find(s => s.name === 'bing');
    check('snapshot: a failure preserves the last-success timestamp (honest)', bing2.lastSuccessMs === okStamp);
    check('snapshot: un-gated bing with 1 fail (not open) → failing, surfaces lastError', bing2.state === 'failing' && bing2.lastError === 'PARSE_EMPTY', JSON.stringify(bing2));

    // Open both an un-gated (bing) and a gated (brave) backend.
    recordBackendResult('bing', false, 'PARSE_EMPTY'); recordBackendResult('bing', false, 'PARSE_EMPTY'); // 3 total → open
    recordBackendResult('brave', false, 'HTTP_500'); recordBackendResult('brave', false, 'HTTP_500'); recordBackendResult('brave', false, 'HTTP_500');
    snap = getBackendSnapshot();
    const bing3 = snap.find(s => s.name === 'bing');
    const brave3 = snap.find(s => s.name === 'brave');
    check('snapshot: un-gated open backend reads as DEGRADED (still attempted)', bing3.state === 'degraded' && bing3.gated === false && bing3.openRemainingMs > 0, JSON.stringify(bing3));
    check('snapshot: gated open backend reads as OPEN (skipped)', brave3.state === 'open' && brave3.gated === true && brave3.openRemainingMs > 0, JSON.stringify(brave3));
    check('snapshot: gated flags correct (brave/ddg gated; bing/serper not)',
      snap.find(s => s.name === 'ddg').gated === true && snap.find(s => s.name === 'serper').gated === false);
    check('snapshot: idle backend (never called) → idle', snap.find(s => s.name === 'serper').state === 'idle');

    // Edge: lastFailure === lastSuccess tie with a fail recorded → 'failing'.
    // Locks the `>=` tie semantics (a `>` flip would hide a still-failing backend).
    resetHealth();
    backendHealth.ddg.lastSuccess = 1000;
    backendHealth.ddg.lastFailure = 1000;
    backendHealth.ddg.failCount = 1;
    backendHealth.ddg.lastError = 'PARSE_EMPTY';
    const tie = getBackendSnapshot(2000).find(s => s.name === 'ddg');
    check('snapshot: lastFailure===lastSuccess tie → failing (locks >= semantics)', tie.state === 'failing', JSON.stringify(tie));

    // Edge: an expired openUntil must read as not-open (state reverts, openRemainingMs null).
    // Locks the `now < openUntil` bound.
    resetHealth();
    backendHealth.brave.lastFailure = 5000;
    backendHealth.brave.failCount = 3;
    backendHealth.brave.lastError = 'HTTP_500';
    backendHealth.brave.openUntil = 6000;
    const expired = getBackendSnapshot(9999).find(s => s.name === 'brave');
    check('snapshot: expired openUntil → not open (failing) + openRemainingMs null', expired.state === 'failing' && expired.openRemainingMs === null, JSON.stringify(expired));
  }

  // ── Part 2 — query builder: ordinals survive, odds/lines stripped ──
  {
    // Live specimen.
    const specimen = buildGraderSearchQuery({ description: 'Stephon Castle O 1.5 1st Quarter Points', sport: 'NBA', event_date: '2026-06-08' });
    check('specimen: ordinal "1st" survives', /\b1st\b/.test(specimen), `q="${specimen}"`);
    check('specimen: NOT mangled to bare "st"', !/(^|\s)st(\s|$)/.test(specimen), `q="${specimen}"`);
    check('specimen: line "1.5" stripped', !specimen.includes('1.5'), `q="${specimen}"`);
    check('specimen: subject "Castle" and segment "Quarter" preserved', /castle/i.test(specimen) && /quarter/i.test(specimen), `q="${specimen}"`);

    // Normal odds-bearing description.
    const normal = buildGraderSearchQuery({ description: 'Jordan Love OVER 1.5 Passing TDs -110', sport: 'NFL', event_date: '2026-06-08' });
    check('normal: line "1.5" stripped', !normal.includes('1.5'), `q="${normal}"`);
    check('normal: odds digits "110" stripped', !/110/.test(normal), `q="${normal}"`);
    check('normal: subject "Jordan Love" preserved', /jordan/i.test(normal) && /love/i.test(normal), `q="${normal}"`);

    // extractSubject unit cases for every protected shape.
    check('extractSubject: "2nd" survives', /\b2nd\b/.test(extractSubject('Luka Doncic 2nd Half Assists')));
    check('extractSubject: "3rd" survives', /\b3rd\b/.test(extractSubject('Player Name 3rd Quarter Points')));
    check('extractSubject: "4th" survives', /\b4th\b/.test(extractSubject('Player Name 4th Quarter Rebounds')));
    check('extractSubject: "1H" survives', /\b1H\b/i.test(extractSubject('Patrick Mahomes 1H Passing Yards')));
    check('extractSubject: "2H" survives', /\b2H\b/i.test(extractSubject('Team Total 2H Points')));
    check('extractSubject: "F5" survives', /\bF5\b/i.test(extractSubject('Gerrit Cole Over 4.5 Ks F5')));
    check('extractSubject: stat words + line still stripped around an ordinal',
      (() => { const s = extractSubject('Stephon Castle O 1.5 1st Quarter Points'); return /1st/.test(s) && /quarter/i.test(s) && !/points/i.test(s) && !s.includes('1.5'); })(),
      `subject="${extractSubject('Stephon Castle O 1.5 1st Quarter Points')}"`);
    // Quarter shorthand survives — these tokens are ALSO dual-listed in the market
    // strip (1q|2q|3q|4q), so this locks protect-before-strip ordering explicitly.
    check('extractSubject: "1Q" survives', /\b1Q\b/i.test(extractSubject('Player Name 1Q Points')));
    check('extractSubject: "4Q" survives', /\b4Q\b/i.test(extractSubject('Player Name 4Q Rebounds')));
    check('extractSubject: multi-digit "11th" survives', /\b11th\b/.test(extractSubject('Pete Alonso 11th Inning Hit')));
    check('extractSubject: multi-digit "21st" survives', /\b21st\b/.test(extractSubject('Player 21st Pick')));
    check('extractSubject: odds "-110" digits stripped (ordinal protection does not leak)', !/110/.test(extractSubject('Team Name -110 ML')));
  }

  console.log(`\nsearch-backend-honesty: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
