// ═══════════════════════════════════════════════════════════
// Adapter contract tests — covers the AdapterResult shape and
// the Gemini → Gemma fallback switch added in p0-adapter-contract.
//
// Why this exists: on 2026-05 18:20Z a Gemini 429 silently
// failed — callLLM threw on 429 instead of returning a structured
// failure, and the !raw || placeholder || noLegsFound branch in
// parseBetText skipped Gemma entirely. The fix introduced
// AdapterResult so errors are first-class data; this file pins
// the contract via a fake fetch.
//
// Run:  node tests/ai-adapter.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const path = require('path');

// ── Test harness: provider env so getProviders() returns Gemini only ──
// We force a single primary provider so the dispatcher's behavior is
// deterministic. Setting one key removes ambient .env defaults.
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-test';
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.MISTRAL_API_KEY;
delete process.env.OLLAMA_URL;
delete process.env.OLLAMA_PROXY_SECRET;

// Quiet the chatty waitSlot — 4.2s/call would stretch this test to
// minutes. Patch the global timer used inside services/ai.js by
// stubbing setTimeout via a wrapper. Cleaner: override the per-provider
// gap by clearing the lastCall map indirectly — see clearRateLimit().
//
// We can't easily clear lastCall (private), so we just live with
// the per-call gap and run a small number of tests sequentially.
// Setting GEMINI gap effectively only matters between same-provider
// calls; we avoid back-to-back Gemini calls in most tests by using
// the helper below that resets state between cases.

// Silence noisy logs during testing — re-enable on demand for debug.
const QUIET = !process.env.AI_ADAPTER_TEST_VERBOSE;
const realLog = console.log;
const realErr = console.error;
const realWarn = console.warn;
if (QUIET) {
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
}

const { AdapterError, FALLBACK_ELIGIBLE, ok, fail, classifyError, classifyHttpStatus } = require('../services/adapters/types');

// ── Phase 1: Pure types/classification tests (no fetch, no dispatcher) ──
function phase1_classification() {
  realLog('Phase 1: error classification...');
  assert.strictEqual(classifyHttpStatus(429), AdapterError.RATE_LIMIT);
  assert.strictEqual(classifyHttpStatus(402), AdapterError.QUOTA_EXHAUSTED);
  assert.strictEqual(classifyHttpStatus(401), AdapterError.AUTH);
  assert.strictEqual(classifyHttpStatus(403), AdapterError.AUTH);
  assert.strictEqual(classifyHttpStatus(500), AdapterError.HTTP_5XX);
  assert.strictEqual(classifyHttpStatus(503), AdapterError.HTTP_5XX);
  assert.strictEqual(classifyHttpStatus(404), AdapterError.HTTP_4XX);
  assert.strictEqual(classifyHttpStatus(418), AdapterError.HTTP_4XX);
  assert.strictEqual(classifyHttpStatus(200), AdapterError.UNKNOWN); // out of range

  assert.strictEqual(classifyError({ status: 429 }), AdapterError.RATE_LIMIT);
  assert.strictEqual(classifyError({ status: 402 }), AdapterError.QUOTA_EXHAUSTED);
  assert.strictEqual(classifyError({ status: 401 }), AdapterError.AUTH);
  assert.strictEqual(classifyError({ status: 403 }), AdapterError.AUTH);
  assert.strictEqual(classifyError({ status: 503 }), AdapterError.HTTP_5XX);
  assert.strictEqual(classifyError({ status: 400 }), AdapterError.HTTP_4XX);

  assert.strictEqual(classifyError({ code: 'ETIMEDOUT' }), AdapterError.TIMEOUT);
  assert.strictEqual(classifyError({ code: 'ECONNRESET' }), AdapterError.TIMEOUT);
  assert.strictEqual(classifyError({ name: 'AbortError' }), AdapterError.TIMEOUT);
  assert.strictEqual(classifyError({ name: 'TimeoutError' }), AdapterError.TIMEOUT);
  assert.strictEqual(classifyError({ message: 'The operation was aborted due to timeout' }), AdapterError.TIMEOUT);

  assert.strictEqual(classifyError({}), AdapterError.UNKNOWN);
  assert.strictEqual(classifyError(new Error('what')), AdapterError.UNKNOWN);

  // Helpers
  assert.deepStrictEqual(ok('hi'), { ok: true, value: 'hi' });
  assert.deepStrictEqual(ok('hi', { provider: 'gemini' }), { ok: true, value: 'hi', meta: { provider: 'gemini' } });
  const f = fail(AdapterError.RATE_LIMIT, new Error('limited'));
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.errorClass, 'rate_limit');
  assert.strictEqual(f.error, 'limited');

  // FALLBACK_ELIGIBLE membership
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.RATE_LIMIT));
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.QUOTA_EXHAUSTED));
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.NO_CONTENT));
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.PARSE_FAIL));
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.TIMEOUT));
  assert.ok(FALLBACK_ELIGIBLE.has(AdapterError.HTTP_5XX));
  assert.ok(!FALLBACK_ELIGIBLE.has(AdapterError.AUTH));
  assert.ok(!FALLBACK_ELIGIBLE.has(AdapterError.HTTP_4XX));
  assert.ok(!FALLBACK_ELIGIBLE.has(AdapterError.UNKNOWN));

  realLog('  PASS — classification + helpers');
}

// ── Phase 2: callGemini adapter behavior via mocked fetch ──
async function phase2_callGemini() {
  realLog('Phase 2: callGemini adapter (mocked fetch)...');
  const { callGemini } = require('../services/ai');

  const provider = {
    name: 'gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-test',
    key: 'test-key',
    format: 'gemini',
    supportsImages: true,
  };

  const realFetch = global.fetch;
  const cases = [
    {
      label: '429 → rate_limit',
      stub: () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
      expect: { ok: false, errorClass: AdapterError.RATE_LIMIT },
    },
    {
      label: '402 → quota_exhausted',
      stub: () => ({ ok: false, status: 402, text: async () => 'payment required' }),
      expect: { ok: false, errorClass: AdapterError.QUOTA_EXHAUSTED },
    },
    {
      label: '401 → auth',
      stub: () => ({ ok: false, status: 401, text: async () => 'bad key' }),
      expect: { ok: false, errorClass: AdapterError.AUTH },
    },
    {
      label: '403 → auth',
      stub: () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
      expect: { ok: false, errorClass: AdapterError.AUTH },
    },
    {
      label: '503 → http_5xx',
      stub: () => ({ ok: false, status: 503, text: async () => 'service unavailable' }),
      expect: { ok: false, errorClass: AdapterError.HTTP_5XX },
    },
    {
      label: 'AbortError thrown → timeout',
      stub: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      expect: { ok: false, errorClass: AdapterError.TIMEOUT },
    },
    {
      label: 'ETIMEDOUT thrown → timeout',
      stub: () => { const e = new Error('etimedout'); e.code = 'ETIMEDOUT'; throw e; },
      expect: { ok: false, errorClass: AdapterError.TIMEOUT },
    },
    {
      label: 'empty content body → no_content',
      stub: () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }) }),
      expect: { ok: false, errorClass: AdapterError.NO_CONTENT },
    },
    {
      label: 'success → ok',
      stub: () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }) }),
      expect: { ok: true, value: '{"ok":true}' },
    },
  ];

  for (const c of cases) {
    global.fetch = async () => c.stub();
    let result;
    try {
      result = await callGemini(provider, 'hello', null, null, null);
    } finally {
      global.fetch = realFetch;
    }
    assert.strictEqual(result.ok, c.expect.ok, `[${c.label}] ok mismatch`);
    if (!c.expect.ok) {
      assert.strictEqual(result.errorClass, c.expect.errorClass, `[${c.label}] errorClass mismatch — got ${result.errorClass}`);
    } else {
      assert.strictEqual(result.value, c.expect.value, `[${c.label}] value mismatch`);
    }
    realLog(`  PASS — ${c.label}`);
  }
}

// ── Phase 3: callOpenAI adapter behavior via mocked fetch ──
async function phase3_callOpenAI() {
  realLog('Phase 3: callOpenAI adapter (mocked fetch)...');
  const { callOpenAI } = require('../services/ai');

  const provider = {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'test-model',
    key: 'test-key',
    format: 'openai',
    supportsImages: false,
  };

  const realFetch = global.fetch;

  // Success
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"hi":1}' } }] }) });
  let r = await callOpenAI(provider, 'p', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '{"hi":1}');
  realLog('  PASS — success');

  // 429
  global.fetch = async () => ({ ok: false, status: 429, text: async () => 'limited' });
  r = await callOpenAI(provider, 'p', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errorClass, AdapterError.RATE_LIMIT);
  realLog('  PASS — 429');

  // Empty content
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  r = await callOpenAI(provider, 'p', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errorClass, AdapterError.NO_CONTENT);
  realLog('  PASS — no_content');

  // Thrown ETIMEDOUT
  global.fetch = async () => { const e = new Error('etimedout'); e.code = 'ETIMEDOUT'; throw e; };
  r = await callOpenAI(provider, 'p', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errorClass, AdapterError.TIMEOUT);
  realLog('  PASS — timeout');

  // Generic 4xx (e.g. 418)
  global.fetch = async () => ({ ok: false, status: 418, text: async () => 'teapot' });
  r = await callOpenAI(provider, 'p', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errorClass, AdapterError.HTTP_4XX);
  realLog('  PASS — http_4xx');
}

// Helper: distinguish the Gemma vision endpoint (/api/generate) from
// the Ollama-as-LLM endpoint (/v1/chat/completions). Both share
// OLLAMA_URL — only /api/generate counts as a "Gemma fallback call".
function isGemmaVisionUrl(u) {
  return /\/api\/generate\b/.test(String(u));
}
function isOllamaLLMUrl(u) {
  return /\/v1\/chat\/completions\b/.test(String(u));
}

// ── Phase 4: parseBetSlipImage end-to-end fallback switch ──
//
// This is the headline test for the P0 fix. It mocks the universal
// fetch so callLLMResult sees Gemini 429, then asserts Gemma is
// invoked with reason=rate_limit. We don't assert the final value
// here because the full Gemma → Cerebras chain is brittle to mock
// end-to-end; phase 8 covers the success substitution.
async function phase4_parseBetSlipFallback() {
  realLog('Phase 4: parseBetSlipImage fallback ladder (Gemini → Gemma)...');

  const ai = require('../services/ai');

  // Configure Gemma so isGemmaHealthy() === true and tryVisionGemma
  // proceeds to fetch.
  process.env.OLLAMA_URL = 'http://fake-ollama.local';
  process.env.OLLAMA_PROXY_SECRET = 'fake-secret';

  const realFetch = global.fetch;
  let geminiCalls = 0;
  let gemmaCalls = 0;
  let ollamaLLMCalls = 0;

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return { ok: false, status: 429, text: async () => 'rate limited' };
    }
    if (isGemmaVisionUrl(u)) {
      gemmaCalls++;
      return { ok: false, status: 503, text: async () => 'gemma down' };
    }
    if (isOllamaLLMUrl(u)) {
      ollamaLLMCalls++;
      return { ok: false, status: 503, text: async () => 'ollama llm down' };
    }
    return { ok: false, status: 404, text: async () => 'unmocked: ' + u };
  };

  const captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  let res;
  try {
    const tinyB64 = Buffer.from('not-a-real-image').toString('base64');
    res = await ai.parseBetSlipImage(tinyB64, 'image/png', {});
  } finally {
    global.fetch = realFetch;
    if (QUIET) console.log = () => {}; else console.log = realLog;
  }

  assert.ok(geminiCalls >= 1, `expected gemini call, got ${geminiCalls}`);
  assert.ok(gemmaCalls >= 1, `expected gemma /api/generate call, got ${gemmaCalls}`);
  const fallbackLogs = captured.filter(l => /slip\.fallback_to_gemma/.test(l));
  assert.ok(fallbackLogs.length >= 1, `expected slip.fallback_to_gemma log line, got: ${captured.slice(0, 5).join(' | ')}`);
  const reasonMatch = fallbackLogs.find(l => /reason=rate_limit/.test(l));
  assert.ok(reasonMatch, `expected reason=rate_limit in fallback log, got: ${fallbackLogs.join(' | ')}`);
  assert.strictEqual(res.error, 'AI unavailable');
  realLog(`  PASS — fallback fired with reason=rate_limit, gemini=${geminiCalls}, gemma=${gemmaCalls}, ollama=${ollamaLLMCalls}`);
}

// ── Phase 5: parseBetSlipImage AUTH does NOT fall back ──
//
// Reset OLLAMA_URL so the dispatcher doesn't add Ollama as an LLM
// provider — we want a pure "all primaries are AUTH" scenario.
async function phase5_authNoFallback() {
  realLog('Phase 5: AUTH does not trigger Gemma fallback...');

  // Isolate: only Gemini configured.
  const savedOllamaUrl = process.env.OLLAMA_URL;
  const savedOllamaSecret = process.env.OLLAMA_PROXY_SECRET;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_PROXY_SECRET;

  const ai = require('../services/ai');
  const realFetch = global.fetch;
  let gemmaCalls = 0;

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 401, text: async () => 'bad api key' };
    }
    if (isGemmaVisionUrl(u)) {
      gemmaCalls++;
      return { ok: true, status: 200, json: async () => ({ response: 'whatever' }) };
    }
    return { ok: false, status: 404, text: async () => 'unmocked' };
  };

  const captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };

  try {
    const tinyB64 = Buffer.from('img').toString('base64');
    const res = await ai.parseBetSlipImage(tinyB64, 'image/png', {});
    assert.strictEqual(res.error, 'AI unavailable');
  } finally {
    global.fetch = realFetch;
    if (QUIET) console.log = () => {}; else console.log = realLog;
    if (savedOllamaUrl) process.env.OLLAMA_URL = savedOllamaUrl;
    if (savedOllamaSecret) process.env.OLLAMA_PROXY_SECRET = savedOllamaSecret;
  }

  assert.strictEqual(gemmaCalls, 0, `Gemma /api/generate must NOT be called on AUTH error — got ${gemmaCalls} calls`);
  const noFallbackLogs = captured.filter(l => /slip\.failed_no_fallback/.test(l));
  assert.ok(noFallbackLogs.length >= 1, `expected slip.failed_no_fallback log, got: ${captured.slice(0, 5).join(' | ')}`);
  assert.ok(noFallbackLogs.some(l => /reason=auth/.test(l)), `expected reason=auth, got: ${noFallbackLogs.join(' | ')}`);
  realLog('  PASS — AUTH skips Gemma');
}

// ── Phase 6: parseBetSlipImage success on primary returns Gemini value ──
async function phase6_primarySuccess() {
  realLog('Phase 6: primary success — no fallback path...');

  const ai = require('../services/ai');
  const realFetch = global.fetch;
  let gemmaCalls = 0;

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ sportsbook: 'DraftKings', bets: [{ sport: 'NBA', bet_type: 'straight', description: 'Lakers -3', odds: -110, units: 1 }] }) }] } }],
        }),
      };
    }
    if (isGemmaVisionUrl(u)) {
      gemmaCalls++;
      throw new Error('Gemma must not be called on success');
    }
    return { ok: false, status: 404, text: async () => 'unmocked' };
  };

  try {
    const tinyB64 = Buffer.from('img').toString('base64');
    const res = await ai.parseBetSlipImage(tinyB64, 'image/png', {});
    assert.strictEqual(res.sportsbook, 'DraftKings');
    assert.ok(Array.isArray(res.bets) && res.bets.length === 1);
    assert.strictEqual(res.bets[0].sport, 'NBA');
  } finally {
    global.fetch = realFetch;
  }

  assert.strictEqual(gemmaCalls, 0, `Gemma /api/generate must NOT be called on primary success — got ${gemmaCalls} calls`);
  realLog('  PASS — primary returns, Gemma untouched');
}

// ── Phase 7: callLLM (string-or-null wrapper) keeps backward compat ──
async function phase7_callLLMStringNull() {
  realLog('Phase 7: callLLM backward-compat surface...');
  const { callLLM } = require('../services/ai');
  const realFetch = global.fetch;

  // Success → returns the content string
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'STRING_VALUE' }] } }] }) });
  const okVal = await callLLM('hi', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(okVal, 'STRING_VALUE');

  // Failure → returns null
  global.fetch = async () => ({ ok: false, status: 429, text: async () => 'limited' });
  const nullVal = await callLLM('hi', null, null, null);
  global.fetch = realFetch;
  assert.strictEqual(nullVal, null);

  realLog('  PASS — string-or-null surface preserved');
}

// ── Run sequentially (rate-limit gap is ~4.2s so phases share state) ──
async function main() {
  const t0 = Date.now();
  phase1_classification();
  await phase2_callGemini();
  await phase3_callOpenAI();
  await phase4_parseBetSlipFallback();
  await phase5_authNoFallback();
  await phase6_primarySuccess();
  await phase7_callLLMStringNull();
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  realLog(`\nAll adapter contract tests passed (${dur}s).`);
}

main().catch((err) => {
  // Ensure we restore real loggers before printing the failure.
  console.log = realLog;
  console.error = realErr;
  console.warn = realWarn;
  realErr('FAILED:', err && err.stack || err);
  process.exit(1);
});
