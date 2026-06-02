// ═══════════════════════════════════════════════════════════
// OCR-first unit tests — services/ocrFirst.js + services/localOcr.js
//
// NO live network. Orchestration cases inject deps.{callOcrService,
// callGroqParse}; the circuit-breaker case mocks global.fetch. Fixtures are
// real captured RapidOCR dumps (fixtures/slip*.ocr.txt, extracted verbatim
// from prompts/groq-parse-test.md) and the correct structured bets per that
// file's Step 4 ground truth (fixtures/slip*.groq.json).
//
// Every case asserts a well-formed decision object (action + reason present) —
// extractViaOcr must NEVER return null.
//
// Run:  node tests/ocr-first/ocr-first.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ocrFirst = require('../../services/ocrFirst');
const localOcr = require('../../services/localOcr');
const { extractViaOcr } = ocrFirst;

const FX = path.join(__dirname, 'fixtures');
const readText = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const readJSON = (f) => JSON.parse(readText(f));

const slip1Dump = readText('slip1.ocr.txt');
const slip2Dump = readText('slip2.ocr.txt');
const slip3Dump = readText('slip3.ocr.txt');
const slip1Groq = readJSON('slip1.groq.json');
const slip2Groq = readJSON('slip2.groq.json');
const slip3Groq = readJSON('slip3.groq.json');

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

// A well-formed decision object — asserted on EVERY case (never null).
function assertWellFormed(d, label) {
  assert.ok(d && typeof d === 'object', `${label}: decision must be a non-null object`);
  assert.ok(d.action === 'USE_OCR' || d.action === 'FALLBACK_GEMINI', `${label}: bad action "${d.action}"`);
  assert.ok(typeof d.reason === 'string' && d.reason.length > 0, `${label}: reason must be a non-empty string`);
  assert.ok('parsedBet' in d, `${label}: parsedBet key must be present`);
  assert.ok(typeof d.ocrText === 'string', `${label}: ocrText must be a string`);
  assert.ok(Array.isArray(d.validationErrors), `${label}: validationErrors must be an array`);
  assert.ok(d.evidence && typeof d.evidence === 'object', `${label}: evidence must be an object`);
  assert.ok(typeof d.evidence.ocrChars === 'number', `${label}: evidence.ocrChars must be a number`);
  assert.ok(d.timingsMs && typeof d.timingsMs.total === 'number', `${label}: timingsMs.total must be a number`);
  assert.ok('imageHash' in d, `${label}: imageHash key must be present`);
}

// Build deps that return a fixed OCR result and a fixed Groq parse, counting calls.
function deps({ ocr, groq }) {
  const calls = { ocr: 0, groq: 0 };
  return {
    calls,
    callOcrService: async () => { calls.ocr++; return ocr; },
    callGroqParse: async () => { calls.groq++; return groq; },
  };
}
function ocrSuccess(text, over = {}) {
  return { ok: true, text, lines: [], confidence: 0.95, latencyMs: 800, imageHash: 'sha256:test', width: 1080, height: 2400, ...over };
}

async function main() {
  console.log('OCR-first orchestration (services/ocrFirst.js):');

  // ── Case 1: slip 1 → USE_OCR, 3 legs ──
  await run('slip 1 → USE_OCR, reason OCR_PARSE_OK, 3 legs', async () => {
    const d = deps({ ocr: ocrSuccess(slip1Dump), groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-slip1', d);
    assertWellFormed(r, 'slip1');
    assert.strictEqual(r.action, 'USE_OCR', `expected USE_OCR, got ${r.action}/${r.reason}`);
    assert.strictEqual(r.reason, 'OCR_PARSE_OK');
    assert.ok(r.parsedBet, 'parsedBet must be set on USE_OCR');
    assert.strictEqual(r.parsedBet.legs.length, 3, 'expected 3 legs');
    assert.strictEqual(r.evidence.parsedLegCount, 3);
    assert.strictEqual(r.evidence.headerLegCount, 3, 'header "3-Bet Parlay" → 3');
    assert.deepStrictEqual(r.validationErrors, []);
    assert.strictEqual(d.calls.groq, 1, 'Groq parse should run once');
  });

  // ── Case 2: slip 3 → USE_OCR, 4 legs ──
  await run('slip 3 → USE_OCR, reason OCR_PARSE_OK, 4 legs', async () => {
    const d = deps({ ocr: ocrSuccess(slip3Dump), groq: { ok: true, parsed: slip3Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-slip3', d);
    assertWellFormed(r, 'slip3');
    assert.strictEqual(r.action, 'USE_OCR', `expected USE_OCR, got ${r.action}/${r.reason}`);
    assert.strictEqual(r.reason, 'OCR_PARSE_OK');
    assert.strictEqual(r.parsedBet.legs.length, 4, 'expected 4 legs');
    assert.strictEqual(r.evidence.headerLegCount, 4, 'header "4-Bet Parlay" → 4');
    assert.deepStrictEqual(r.validationErrors, []);
  });

  // ── Case 3: slip 2 (SGPMAX) → FALLBACK_GEMINI, OCR_SGP_GATE, Groq NOT called ──
  await run('slip 2 (SGPMAX) → FALLBACK_GEMINI OCR_SGP_GATE, sgpToken set, Groq NOT called', async () => {
    const d = deps({ ocr: ocrSuccess(slip2Dump), groq: { ok: true, parsed: slip2Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-slip2', d);
    assertWellFormed(r, 'slip2');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_SGP_GATE');
    assert.ok(r.evidence.sgpToken, `evidence.sgpToken must be set, got ${r.evidence.sgpToken}`);
    assert.strictEqual(r.evidence.sgpToken, 'SGPMAX');
    assert.strictEqual(r.parsedBet, null, 'no parsedBet on fallback');
    assert.strictEqual(d.calls.groq, 0, 'Groq must NOT be called — SGP gate is before Groq');
  });

  // ── Case 4: OCR timeout → FALLBACK_GEMINI OCR_TIMEOUT ──
  await run('OCR timeout → FALLBACK_GEMINI OCR_TIMEOUT', async () => {
    const d = deps({ ocr: { ok: false, error: { code: 'TIMEOUT', message: 'aborted at 8000ms' } }, groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-timeout', d);
    assertWellFormed(r, 'timeout');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_TIMEOUT');
    assert.strictEqual(r.ocrText, '', 'no OCR text on transport failure');
    assert.strictEqual(d.calls.groq, 0, 'Groq must NOT run when OCR failed');
  });

  // ── Case 5: OCR empty text → FALLBACK_GEMINI OCR_EMPTY ──
  await run('OCR empty text → FALLBACK_GEMINI OCR_EMPTY', async () => {
    const d = deps({ ocr: ocrSuccess('   \n  ', { confidence: 0, lines: [] }), groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-empty', d);
    assertWellFormed(r, 'empty');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_EMPTY');
    assert.strictEqual(d.calls.groq, 0, 'Groq must NOT run on empty OCR');
  });

  // ── Case 6: parse with artifact selection "O0ver0.5" → OCR_VALIDATE_FAIL / ARTIFACT_RESIDUE ──
  await run('parse selection "O0ver0.5" → FALLBACK_GEMINI OCR_VALIDATE_FAIL / ARTIFACT_RESIDUE', async () => {
    const dirty = JSON.parse(JSON.stringify(slip1Groq));
    dirty.legs[0].selection = 'O0ver0.5'; // un-cleaned OCR artifact passed through by Groq
    const d = deps({ ocr: ocrSuccess(slip1Dump), groq: { ok: true, parsed: dirty } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-artifact', d);
    assertWellFormed(r, 'artifact');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_VALIDATE_FAIL');
    assert.ok(r.validationErrors.includes('ARTIFACT_RESIDUE'), `expected ARTIFACT_RESIDUE, got ${JSON.stringify(r.validationErrors)}`);
    assert.strictEqual(r.parsedBet, null, 'no parsedBet on validate fail');
  });

  // ── Extra coverage (distinct reason codes; strengthens the never-null guarantee) ──
  await run('[extra] Groq invalid-after-retry → FALLBACK_GEMINI OCR_PARSE_FAIL', async () => {
    const d = deps({ ocr: ocrSuccess(slip1Dump), groq: { ok: false, parsed: null } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-parsefail', d);
    assertWellFormed(r, 'parsefail');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_PARSE_FAIL');
  });

  await run('[extra] OCR garbage (short, no digits) → FALLBACK_GEMINI OCR_GARBAGE', async () => {
    const d = deps({ ocr: ocrSuccess('lol ok'), groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-garbage', d);
    assertWellFormed(r, 'garbage');
    assert.strictEqual(r.action, 'FALLBACK_GEMINI');
    assert.strictEqual(r.reason, 'OCR_GARBAGE');
    assert.strictEqual(d.calls.groq, 0, 'Groq must NOT run on garbage OCR');
  });

  await run('[extra] OCR service unreachable → FALLBACK_GEMINI OCR_UNREACHABLE', async () => {
    const d = deps({ ocr: { ok: false, error: { code: 'UNREACHABLE', message: 'ECONNREFUSED' } }, groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-unreach', d);
    assertWellFormed(r, 'unreachable');
    assert.strictEqual(r.reason, 'OCR_UNREACHABLE');
  });

  // ── Case 7: circuit breaker — N consecutive failures → CIRCUIT_OPEN, no network ──
  console.log('\nlocalOcr circuit breaker (services/localOcr.js):');
  await run('3 consecutive HTTP_5XX → 4th call returns CIRCUIT_OPEN with no fetch', async () => {
    const saved = {
      url: process.env.OCR_SERVICE_URL,
      token: process.env.OCR_SERVICE_TOKEN,
      fails: process.env.OCR_CIRCUIT_BREAKER_FAILS,
      cooldown: process.env.OCR_CIRCUIT_BREAKER_COOLDOWN_MS,
      fetch: global.fetch,
    };
    process.env.OCR_SERVICE_URL = 'http://ocr.test.local';
    process.env.OCR_SERVICE_TOKEN = 'test-token';
    process.env.OCR_CIRCUIT_BREAKER_FAILS = '3';
    process.env.OCR_CIRCUIT_BREAKER_COOLDOWN_MS = '60000';
    localOcr._resetCircuitBreaker();

    let fetchCount = 0;
    global.fetch = async () => { fetchCount++; return { status: 503, ok: false, json: async () => ({}), text: async () => 'down' }; };

    try {
      // 3 tripping failures → opens the breaker at the 3rd.
      for (let i = 1; i <= 3; i++) {
        const res = await localOcr.callOcrService('b64', 'image/webp', `cb-${i}`);
        assert.strictEqual(res.ok, false, `call ${i} should fail`);
        assert.strictEqual(res.error.code, 'HTTP_5XX', `call ${i} should be HTTP_5XX, got ${res.error.code}`);
      }
      assert.strictEqual(fetchCount, 3, `expected 3 network attempts, got ${fetchCount}`);

      // 4th call — breaker is open → CIRCUIT_OPEN, NO network attempt.
      const fourth = await localOcr.callOcrService('b64', 'image/webp', 'cb-4');
      assert.strictEqual(fourth.ok, false);
      assert.strictEqual(fourth.error.code, 'CIRCUIT_OPEN', `4th call should be CIRCUIT_OPEN, got ${fourth.error.code}`);
      assert.strictEqual(fetchCount, 3, `breaker must not hit the network — fetch count should stay 3, got ${fetchCount}`);
    } finally {
      localOcr._resetCircuitBreaker();
      global.fetch = saved.fetch;
      restoreEnv('OCR_SERVICE_URL', saved.url);
      restoreEnv('OCR_SERVICE_TOKEN', saved.token);
      restoreEnv('OCR_CIRCUIT_BREAKER_FAILS', saved.fails);
      restoreEnv('OCR_CIRCUIT_BREAKER_COOLDOWN_MS', saved.cooldown);
    }
  });

  // ── Bonus: the orchestrator surfaces OCR_CIRCUIT_OPEN as a reason too ──
  await run('[extra] orchestrator maps CIRCUIT_OPEN → reason OCR_CIRCUIT_OPEN', async () => {
    const d = deps({ ocr: { ok: false, error: { code: 'CIRCUIT_OPEN', message: 'circuit open for 60000ms' } }, groq: { ok: true, parsed: slip1Groq } });
    const r = await extractViaOcr('b64', 'image/webp', 'req-co', d);
    assertWellFormed(r, 'circuit-open');
    assert.strictEqual(r.reason, 'OCR_CIRCUIT_OPEN');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function restoreEnv(name, val) {
  if (val === undefined) delete process.env[name];
  else process.env[name] = val;
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack || err);
  process.exit(1);
});
