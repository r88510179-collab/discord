// ═══════════════════════════════════════════════════════════
// search-chain-order — verifies searchWeb() cascade order.
//
// After P3 (Brave 2K/mo free tier exhausted in 6 days), the
// chain reorders to: Bing → Brave → DDG → Serper. This protects
// the quota-limited Brave key by hitting the free Bing scrape
// first; only fall through to Brave when Bing returns empty.
//
// Strategy: mock globalThis.fetch BEFORE requiring grading.js
// so each backend hits the mock instead of the real services.
// The mock returns minimal-but-parseable response shapes per
// backend (HTML for Bing/DDG, JSON for Brave/Serper) and pushes
// the backend name onto a callOrder array for assertion.
//
// searchWeb is reached via grading._internal — same test-only
// export pattern already used for looksLikePlayerProp et al.
// ═══════════════════════════════════════════════════════════

// Speed up searchWeb's `await delay(1000)` without affecting
// AbortSignal.timeout(15000) used inside the per-backend fetches.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, ms <= 1000 ? 0 : ms, ...args);

// searchBrave / searchSerper return [] early when their API key
// env var is unset. Set them so the chain runs all 4 backends.
process.env.BRAVE_API_KEY = process.env.BRAVE_API_KEY || 'test-brave-key';
process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || 'test-serper-key';

const callOrder = [];
const backendResponses = {
  bing: { type: 'empty' },
  brave: { type: 'empty' },
  ddg: { type: 'empty' },
  serper: { type: 'empty' },
};

function classifyUrl(url) {
  const u = String(url);
  if (u.includes('bing.com/search')) return 'bing';
  if (u.includes('api.search.brave.com')) return 'brave';
  if (u.includes('lite.duckduckgo.com')) return 'ddg';
  if (u.includes('google.serper.dev')) return 'serper';
  return null;
}

function mockResponse(backend) {
  const r = backendResponses[backend];
  if (backend === 'brave') {
    const body = {
      web: {
        results: r.type === 'hit'
          ? [{ title: 'Brave T', description: 'Brave S' }]
          : [],
      },
    };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  if (backend === 'serper') {
    const body = {
      organic: r.type === 'hit'
        ? [{ title: 'Serper T', snippet: 'Serper S' }]
        : [],
    };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  if (backend === 'bing') {
    // Bing parser splits on class="b_algo" and matches <a>title</a>
    // plus class="b_caption"...<p>snippet</p> inside the resulting block.
    // The title embeds the query token "test" so the M-3 generic-news
    // relevance gate (Bing-only) treats this hit as relevant rather than
    // homepage HTML — otherwise the chain would (correctly) fall through.
    const html = r.type === 'hit'
      ? '<div class="b_algo"><a href="x">Bing Title test</a><div class="b_caption"><p>Bing Snippet</p></div></div>'
      : '<html></html>';
    return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
  }
  if (backend === 'ddg') {
    // DDG parser splits on <tr> and matches class="result-link" + class="result-snippet".
    const html = r.type === 'hit'
      ? '<tr><a class="result-link" href="x">DDG Title</a><td class="result-snippet">DDG Snippet</td></tr>'
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

const { _internal, backendHealth } = require('../services/grading');
const { searchWeb } = _internal;

if (typeof searchWeb !== 'function') {
  console.error('FAIL: grading._internal.searchWeb is not exported (required for this test)');
  process.exit(1);
}

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

function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function runScenario(label, responses, expectedOrder) {
  callOrder.length = 0;
  // Reset in-memory breaker state so this ORDER test is independent of the
  // failure accumulation introduced by M-3 (parse_empty now records a circuit
  // failure; a gated backend could otherwise open mid-run and skip a call).
  for (const k of Object.keys(backendHealth)) {
    Object.assign(backendHealth[k], { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null });
  }
  for (const k of Object.keys(backendResponses)) backendResponses[k] = { type: 'empty' };
  for (const [k, v] of Object.entries(responses)) backendResponses[k] = v;

  await searchWeb('test query');

  check(
    `${label}: call order is [${expectedOrder.join(', ')}]`,
    eqArr(callOrder, expectedOrder),
    `actual: [${callOrder.join(', ')}]`
  );
  check(
    `${label}: exactly ${expectedOrder.length} backend(s) called`,
    callOrder.length === expectedOrder.length,
    `actual: ${callOrder.length}`
  );
}

(async () => {
  console.log('search-chain-order:');

  // Case 1 — Bing returns hits → no other backend is called
  await runScenario(
    'Bing hits',
    { bing: { type: 'hit' } },
    ['bing']
  );

  // Case 2 — Bing empty, Brave hits → Bing then Brave, nothing after
  await runScenario(
    'Bing empty, Brave hits',
    { brave: { type: 'hit' } },
    ['bing', 'brave']
  );

  // Case 3 — Bing+Brave empty, DDG hits → first three only
  await runScenario(
    'Bing+Brave empty, DDG hits',
    { ddg: { type: 'hit' } },
    ['bing', 'brave', 'ddg']
  );

  // Case 4 — full 4-deep cascade: every backend returns empty
  // → Bing → Brave → DDG → Serper (Serper as final).
  await runScenario(
    'All empty, full cascade',
    {},
    ['bing', 'brave', 'ddg', 'serper']
  );

  console.log(`\nsearch-chain-order: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
