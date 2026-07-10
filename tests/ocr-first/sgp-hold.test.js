// ═══════════════════════════════════════════════════════════
// SGP 2b drop→hold tests (design D2, #41 Option A) — SGP_HOLD_MODE.
//
// Three layers, all network-free and DB-free:
//   A. services/ocrFirstWiring.runSgpDropToHold — the mode-gated chain
//      (fetch → extractViaOcr SGP bail → Groq parse → evaluateSgpGate) with
//      deps injected and the recordStage sink spied:
//        off      → no-op: zero calls, zero events, { hold:false }.
//        shadow   → { hold:false } immediately; ONE ocr_sgp_hold_shadow off the
//                   request path (would_hold | would_skip | not_applicable).
//        enforce  → gate PASS → { hold:true, sgp } + ONE ocr_sgp_hold; every
//                   FAIL / non-SGP / fetch-fail / throw → { hold:false } with
//                   ZERO events (fail-safe = today's behavior).
//   B. services/holdReview sgpHoldPrefill / sgpReleasePlan — pure modal
//      helpers (database/dashboard/pipeline-events stubbed via require.cache).
//   C. handlers/messageHandler — the vision-failure seam driven through the
//      real buffer path (message-handler.integration.js harness pattern) with
//      ocrFirstWiring mocked: enforce+PASS stages MANUAL_REVIEW_HOLD carrying
//      payload.ocrSgp (and skips PURE_SLIP_SKIP_HOLD + the drop); FAIL / off /
//      thrown wiring / non-human channel keep today's routing byte-identically.
//
// Fixtures mirror reports/sgp-content-spotcheck.json slip-10 (PASS) and
// slip-12 (phantom-leg SGP_COUNT_MISMATCH FAIL), same as wiring.test.js.
//
// Run:  node tests/ocr-first/sgp-hold.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.stack || e.message}`);
    failed++;
  }
}

function spyStage() {
  const events = [];
  return { fn: (e) => events.push(e), events };
}

const IMG = 'https://cdn.discordapp.com/attachments/1/2/slip.webp';

// ── Fixtures (verbatim from wiring.test.js / sgp-gate.test.js) ──
const SGP_SLIP10_OCR = 'Hard Rock\nBET\nSGPMAX\n2-Bet Parlay\n+1435\nSGP\nAngels vs Athletics\nO0ver0.5\nLAWRENCE BUTLER -TO RECORD 1+HITS\nO0ver0.5\nZACH NETO -HITS';
const SGP_SLIP10_GROQ = { bet_type: 'sgpmax', total_odds: '+1435', stake: '$5.00', legs: [
  { matchup: 'Angels vs Athletics', player: 'Lawrence Butler', market: '', selection: 'TO RECORD 1+ HITS', odds: '+110' },
  { matchup: 'Angels vs Athletics', player: 'Zach Neto', market: '', selection: 'HITS', odds: null },
] };
const SGP_SLIP12_OCR = 'Hard Rock\nBET\nSGPMAX\n3-Bet Parlay\n+162\n-118\nSGP\nPirates vs Cubs\nOver 0.5\nBRYAN REYNOLDS - HITS\nOver 0.5\nNICK GONZALES - HITS\nOver 0.5\n-240\nTAYLOR WARD -HITS\nOrioles vs Blue Jays';
const SGP_SLIP12_GROQ = { bet_type: 'sgpmax', legs: [
  { matchup: 'Pirates vs Cubs', player: 'Bryan Reynolds', market: 'HITS', selection: 'Over 0.5', odds: null },
  { matchup: 'Pirates vs Cubs', player: 'Nick Gonzales', market: 'HITS', selection: 'Over 0.5', odds: null },
  { matchup: 'Pirates vs Cubs', player: 'Taylor Ward', market: 'HITS', selection: 'Over 0.5', odds: '-240' },
  { matchup: 'Orioles vs Blue Jays', player: null, market: '', selection: '', odds: '-118' }, // phantom game-odds leg
] };

// SGP-bail decision (extractViaOcr's pre-Groq short-circuit) carrying ocrText.
function sgpBailDecision(ocrText) {
  return {
    action: 'FALLBACK_GEMINI', reason: 'OCR_SGP_GATE', parsedBet: null,
    ocrText, validationErrors: [],
    evidence: { sgpToken: 'SGPMAX', headerLegCount: null, parsedLegCount: null, ocrChars: ocrText.length },
    timingsMs: { ocr: 60, parse: 0, validate: 0, total: 61 }, imageHash: null,
  };
}
// A non-SGP decision — the rescue must exit before Groq.
const NON_SGP_DECISION = {
  action: 'USE_OCR', reason: 'OCR_PARSE_OK', parsedBet: { bet_type: 'parlay', legs: [] },
  ocrText: 'Hard Rock 3-Bet Parlay', validationErrors: [],
  evidence: { sgpToken: null, headerLegCount: 3, parsedLegCount: 3, ocrChars: 22 },
  timingsMs: { ocr: 60, parse: 100, validate: 1, total: 161 }, imageHash: null,
};

function makeDeps({ decision, groqParsed, fetchOk = true, throwExtract = false, throwGroq = false, groqOk = true } = {}) {
  const calls = { fetch: 0, extract: 0, groq: 0 };
  return {
    calls,
    fetchImageBytes: async () => {
      calls.fetch++;
      return fetchOk ? { ok: true, base64: 'b64', mediaType: 'image/webp' } : { ok: false, reason: 'OCR_IMAGE_HOST_BLOCKED' };
    },
    extractViaOcr: async () => {
      calls.extract++;
      if (throwExtract) throw new Error('boom-extract');
      return decision;
    },
    callGroqParse: async () => {
      calls.groq++;
      if (throwGroq) throw new Error('boom-groq');
      return groqOk ? { ok: true, parsed: groqParsed, raw: JSON.stringify(groqParsed) } : { ok: false, parsed: null, raw: null };
    },
  };
}

// ═══ Section A — wiring: runSgpDropToHold ═══════════════════════════════════

async function sectionA() {
  const wiring = require('../../services/ocrFirstWiring');
  const { runSgpDropToHold, resolveSgpHoldMode, sgpHoldLegLine } = wiring;

  await run('resolveSgpHoldMode: off default, tolerant parse, unknown → off', () => {
    assert.strictEqual(resolveSgpHoldMode(undefined), 'off');
    assert.strictEqual(resolveSgpHoldMode(''), 'off');
    assert.strictEqual(resolveSgpHoldMode('bogus'), 'off');
    assert.strictEqual(resolveSgpHoldMode('enforce'), 'enforce');
    assert.strictEqual(resolveSgpHoldMode(' SHADOW '), 'shadow');
    assert.strictEqual(resolveSgpHoldMode('cutover'), 'off'); // not a valid SGP_HOLD_MODE value
  });

  await run('sgpHoldLegLine: entity+line, promoted market deduped, junk → empty', () => {
    assert.strictEqual(
      sgpHoldLegLine({ entity: 'Lawrence Butler', market: 'TO RECORD 1+ HITS', line: 'TO RECORD 1+ HITS' }),
      'Lawrence Butler TO RECORD 1+ HITS',
    );
    assert.strictEqual(
      sgpHoldLegLine({ entity: 'Bryan Reynolds', market: 'HITS', line: 'Over 0.5' }),
      'Bryan Reynolds Over 0.5 HITS',
    );
    assert.strictEqual(sgpHoldLegLine(null), '');
    assert.strictEqual(sgpHoldLegLine({}), '');
  });

  await run('off mode → no-op: zero calls, zero events, hold:false', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r1', mode: 'off', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.deepStrictEqual(deps.calls, { fetch: 0, extract: 0, groq: 0 });
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + gate PASS (slip-10) → hold:true, sgp legs+description, ONE ocr_sgp_hold', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r2', sourceRef: 'sr2', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, true);
    assert.ok(res.sgp, 'sgp payload fragment present');
    assert.strictEqual(res.sgp.gate, 'SGP_PASS');
    assert.strictEqual(res.sgp.declaredLegCount, 2);
    assert.strictEqual(res.sgp.parsedLegCount, 2);
    assert.strictEqual(res.sgp.legs.length, 2);
    // normalizedBet leg shape carried verbatim for the modal/release path
    assert.deepStrictEqual(res.sgp.legs[0], { entity: 'Lawrence Butler', market: 'TO RECORD 1+ HITS', line: 'TO RECORD 1+ HITS', odds: '+110' });
    assert.strictEqual(res.sgp.description, 'Lawrence Butler TO RECORD 1+ HITS\nZach Neto HITS');
    assert.strictEqual(res.sgp.total_odds, '+1435');
    assert.strictEqual(res.sgp.stake, '$5.00');
    assert.deepStrictEqual(deps.calls, { fetch: 1, extract: 1, groq: 1 });
    assert.strictEqual(spy.events.length, 1);
    assert.strictEqual(spy.events[0].eventType, 'ocr_sgp_hold');
    assert.strictEqual(spy.events[0].stage, 'OCR_FIRST');
    assert.strictEqual(spy.events[0].payload.legCount, 2);
    assert.strictEqual(spy.events[0].payload.reason, 'SGP_PASS');
  });

  await run('enforce + gate FAIL (slip-12 phantom leg) → hold:false, ZERO events (byte-identical)', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP12_OCR), groqParsed: SGP_SLIP12_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r3', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.strictEqual(res.sgp, undefined);
    assert.strictEqual(spy.events.length, 0, 'enforce FAIL must not emit — routing must stay indistinguishable from today');
    assert.deepStrictEqual(deps.calls, { fetch: 1, extract: 1, groq: 1 });
  });

  await run('enforce + non-SGP decision → hold:false, Groq never called, zero events', async () => {
    const deps = makeDeps({ decision: NON_SGP_DECISION, groqParsed: SGP_SLIP10_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r4', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.strictEqual(deps.calls.groq, 0, 'rescue is scoped to SGP bails — no Groq spend on non-SGP');
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + image fetch fail → hold:false, extract never called, zero events', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ, fetchOk: false });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r5', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.deepStrictEqual(deps.calls, { fetch: 1, extract: 0, groq: 0 });
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + thrown extract → swallowed, hold:false, no rejection', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ, throwExtract: true });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r6', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + thrown Groq → swallowed, hold:false', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ, throwGroq: true });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r7', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + Groq soft-fail (ok:false) → gate FAIL SGP_NO_LEGS path, hold:false, zero events', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: null, groqOk: false });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r8', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.strictEqual(spy.events.length, 0);
  });

  await run('enforce + oversized PASS (30 long legs) → legs array dropped, block stays under the payload slice', async () => {
    // 30 legs with long entities that all appear verbatim in the OCR text so the
    // real evaluateSgpGate PASSes — the serialized sgp block would blow the
    // pipeline_events 4000-char safeJson slice without the cap.
    const entities = Array.from({ length: 30 }, (_, i) => `Playerfirstname Playersurname Number${i} Longsuffix`);
    const ocrText = `Hard Rock\nBET\nSGPMAX\n30-Bet Parlay\n+9999\n${entities.join('\n')}`;
    const groqParsed = {
      bet_type: 'sgpmax', total_odds: '+9999',
      legs: entities.map((e) => ({ matchup: null, player: e, market: 'HITS', selection: 'Over 0.5', odds: null })),
    };
    const deps = makeDeps({ decision: sgpBailDecision(ocrText), groqParsed });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r-big', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, true, 'a clean 30-leg PASS still holds');
    assert.strictEqual(res.sgp.legCount, 30, 'legCount survives the cap');
    assert.deepStrictEqual(res.sgp.legs, [], 'structured legs dropped past the budget');
    assert.strictEqual(res.sgp.legsOmitted, 30);
    assert.ok(res.sgp.description.length > 0 && res.sgp.description.length <= 1800, 'description capped');
    assert.ok(JSON.stringify(res.sgp).length <= 2800, 'sgp block stays under the safeJson slice budget');
  });

  await run('shadow + PASS → hold:false immediately; bg emits ocr_sgp_hold_shadow would_hold', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r9', mode: 'shadow', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.ok(res.shadowPromise, 'shadow returns the bg promise for tests');
    await res.shadowPromise;
    assert.strictEqual(spy.events.length, 1);
    assert.strictEqual(spy.events[0].eventType, 'ocr_sgp_hold_shadow');
    assert.strictEqual(spy.events[0].payload.kind, 'would_hold');
    assert.strictEqual(spy.events[0].payload.pass, true);
    assert.strictEqual(spy.events[0].payload.reason, 'SGP_PASS');
    assert.strictEqual(spy.events[0].payload.declaredLegCount, 2);
  });

  await run('shadow + FAIL → would_skip with the gate reason', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP12_OCR), groqParsed: SGP_SLIP12_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r10', mode: 'shadow', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    await res.shadowPromise;
    assert.strictEqual(spy.events.length, 1);
    assert.strictEqual(spy.events[0].payload.kind, 'would_skip');
    assert.strictEqual(spy.events[0].payload.pass, false);
    assert.strictEqual(spy.events[0].payload.reason, 'SGP_COUNT_MISMATCH');
  });

  await run('shadow + fetch fail → not_applicable with the wiring reason', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ, fetchOk: false });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r11', mode: 'shadow', deps, recordStageFn: spy.fn });
    await res.shadowPromise;
    assert.strictEqual(spy.events.length, 1);
    assert.strictEqual(spy.events[0].payload.kind, 'not_applicable');
    assert.strictEqual(spy.events[0].payload.reason, 'OCR_IMAGE_HOST_BLOCKED');
  });

  await run('shadow + thrown chain → swallowed; bg promise resolves; zero events ok', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ, throwExtract: true });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 1, requestId: 'r12', mode: 'shadow', deps, recordStageFn: spy.fn });
    await res.shadowPromise; // must not reject
    // extract threw INSIDE evaluateSgpHold → the .catch swallows before the emit
    assert.strictEqual(res.hold, false);
  });

  await run('multi-image (imageCount>1) → skip in BOTH live modes: zero calls, zero events', async () => {
    for (const mode of ['shadow', 'enforce']) {
      const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ });
      const spy = spyStage();
      const res = await runSgpDropToHold({ imageUrl: IMG, imageCount: 2, requestId: 'r13', mode, deps, recordStageFn: spy.fn });
      assert.strictEqual(res.hold, false, mode);
      assert.deepStrictEqual(deps.calls, { fetch: 0, extract: 0, groq: 0 }, mode);
      assert.strictEqual(spy.events.length, 0, mode);
    }
  });

  await run('no imageUrl → skip: zero calls, zero events', async () => {
    const deps = makeDeps({ decision: sgpBailDecision(SGP_SLIP10_OCR), groqParsed: SGP_SLIP10_GROQ });
    const spy = spyStage();
    const res = await runSgpDropToHold({ imageUrl: null, imageCount: 1, requestId: 'r14', mode: 'enforce', deps, recordStageFn: spy.fn });
    assert.strictEqual(res.hold, false);
    assert.deepStrictEqual(deps.calls, { fetch: 0, extract: 0, groq: 0 });
    assert.strictEqual(spy.events.length, 0);
  });
}

// ═══ Section B — holdReview pure helpers ═════════════════════════════════════

function loadHoldReviewWithStubs() {
  const dbPath = path.resolve(__dirname, '../../services/database.js');
  const dashboardPath = path.resolve(__dirname, '../../services/dashboard.js');
  const pePath = path.resolve(__dirname, '../../services/pipeline-events.js');
  const holdPath = path.resolve(__dirname, '../../services/holdReview.js');
  delete require.cache[holdPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { db: {}, createBetWithLegs: () => ({ id: 'bet_stub' }), getOrCreateCapper: async () => ({ id: 'capper_stub' }) },
  };
  require.cache[dashboardPath] = { id: dashboardPath, filename: dashboardPath, loaded: true, exports: { postNewPick: async () => {} } };
  require.cache[pePath] = { id: pePath, filename: pePath, loaded: true, exports: { recordStage: () => {} } };
  return require(holdPath);
}

async function sectionB() {
  const { sgpHoldPrefill, sgpReleasePlan } = loadHoldReviewWithStubs();

  const SGP_PAYLOAD = {
    reason: 'ai_is_bet_false',
    sample: 'text sample',
    ocrSgp: {
      gate: 'SGP_PASS',
      total_odds: '+1435',
      legs: [
        { entity: 'Lawrence Butler', market: 'TO RECORD 1+ HITS', line: 'TO RECORD 1+ HITS', odds: '+110' },
        { entity: 'Zach Neto', market: 'HITS', line: 'HITS', odds: null },
      ],
      description: 'Lawrence Butler TO RECORD 1+ HITS\nZach Neto HITS',
    },
  };

  await run('sgpHoldPrefill: ocrSgp hold → legs description + total_odds', () => {
    const p = sgpHoldPrefill(SGP_PAYLOAD);
    assert.strictEqual(p.description, 'Lawrence Butler TO RECORD 1+ HITS\nZach Neto HITS');
    assert.strictEqual(p.odds, '+1435');
  });

  await run('sgpHoldPrefill: plain hold → sample, odds null (byte-identical prefill)', () => {
    const p = sgpHoldPrefill({ sample: 'plain sample' });
    assert.strictEqual(p.description, 'plain sample');
    assert.strictEqual(p.odds, null);
    const empty = sgpHoldPrefill(null);
    assert.strictEqual(empty.description, '');
    assert.strictEqual(empty.odds, null);
  });

  await run('sgpHoldPrefill: empty ocrSgp.description falls back to sample; missing odds → null', () => {
    const p = sgpHoldPrefill({ sample: 's', ocrSgp: { legs: [{}], description: '  ' } });
    assert.strictEqual(p.description, 's');
    assert.strictEqual(p.odds, null);
  });

  await run('sgpReleasePlan: ocrSgp + multi-line description → parlay with one leg per line', () => {
    const plan = sgpReleasePlan(SGP_PAYLOAD, 'Lawrence Butler TO RECORD 1+ HITS\n\n  Zach Neto HITS  ');
    assert.strictEqual(plan.betType, 'parlay');
    assert.deepStrictEqual(plan.legs, [
      { description: 'Lawrence Butler TO RECORD 1+ HITS', odds: null },
      { description: 'Zach Neto HITS', odds: null },
    ]);
  });

  await run('sgpReleasePlan: plain hold → straight/no-legs even with a multi-line description', () => {
    const plan = sgpReleasePlan({ sample: 'x' }, 'line one\nline two');
    assert.deepStrictEqual(plan, { betType: 'straight', legs: [] });
  });

  await run('sgpReleasePlan: ocrSgp but operator collapsed to one line → straight/no-legs', () => {
    const plan = sgpReleasePlan(SGP_PAYLOAD, 'One single leg edited by hand');
    assert.deepStrictEqual(plan, { betType: 'straight', legs: [] });
  });

  await run('sgpReleasePlan: legs array dropped by the size cap → still a parlay (keys on gate stamp)', () => {
    const capped = { ...SGP_PAYLOAD, ocrSgp: { ...SGP_PAYLOAD.ocrSgp, legs: [], legsOmitted: 30 } };
    const plan = sgpReleasePlan(capped, 'Leg one\nLeg two\nLeg three');
    assert.strictEqual(plan.betType, 'parlay');
    assert.strictEqual(plan.legs.length, 3);
  });
}

// ═══ Section C — messageHandler seam (buffer → processAggregatedMessage) ═════

function loadHandlerWithMocks({ parseBetText, events, sgpMode, sgpResult, sgpCalls }) {
  const aiPath = path.resolve(__dirname, '../../services/ai.js');
  const dbPath = path.resolve(__dirname, '../../services/database.js');
  const embedsPath = path.resolve(__dirname, '../../utils/embeds.js');
  const dashboardPath = path.resolve(__dirname, '../../services/dashboard.js');
  const warRoomPath = path.resolve(__dirname, '../../services/warRoom.js');
  const wiringPath = path.resolve(__dirname, '../../services/ocrFirstWiring.js');
  const handlerPath = path.resolve(__dirname, '../../handlers/messageHandler.js');
  const pePath = path.resolve(__dirname, '../../services/pipeline-events.js');

  delete require.cache[handlerPath];
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      parseBetText,
      parseBetSlipImage: async () => ({ bets: [] }),
      processImageForAI: async () => ({ base64: 'ZmFrZQ==', mediaType: 'image/png' }),
      evaluateTweet: () => 'valid',
      validateParsedBet: () => ({ valid: true, issues: [] }),
    },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getOrCreateCapper: async () => ({ id: 'capper_1' }),
      createBetWithLegs: async () => ({ id: 'bet_x', _deduped: false }),
      isDuplicateBet: () => false,
      isAuditMode: () => false,
    },
  };
  require.cache[embedsPath] = { id: embedsPath, filename: embedsPath, loaded: true, exports: { betEmbed: (b) => ({ title: b.description }) } };
  require.cache[dashboardPath] = { id: dashboardPath, filename: dashboardPath, loaded: true, exports: { postPickTracked: async () => {}, postNewPick: async () => {} } };
  require.cache[warRoomPath] = { id: warRoomPath, filename: warRoomPath, loaded: true, exports: { sendStagingEmbed: async () => {}, sendUntrackedWinEmbed: async () => {} } };

  // ocrFirstWiring mock: MODE 'off' keeps the applyOcrFirst seam inert; the SGP
  // drop→hold entry points are test-controlled. eligibleImageCount mirrors the
  // real attachment-count contract closely enough for a 1-attachment message.
  require.cache[wiringPath] = {
    id: wiringPath, filename: wiringPath, loaded: true,
    exports: {
      MODE: 'off',
      resolveMode: () => 'off',
      resolveSgpHoldMode: () => sgpMode,
      eligibleImageCount: (imgs) => (Array.isArray(imgs) ? imgs.length : 0) || 1,
      applyOcrFirst: async ({ parsed }) => ({ parsed, ranOcr: false, shadowPromise: null }),
      runSgpDropToHold: async (args) => {
        if (sgpCalls) sgpCalls.push(args);
        if (sgpResult instanceof Error) throw sgpResult;
        return sgpResult;
      },
    },
  };

  // Capture pipeline_events emissions — same technique as
  // tests/message-handler.integration.js (real module, write helpers swapped).
  // Section B stubbed this module wholesale for holdReview; evict that stub so
  // the handler gets the REAL module (makeIngestId etc.) with spies patched in.
  delete require.cache[pePath];
  // eslint-disable-next-line global-require
  const pe = require(pePath);
  pe.recordStage = ({ stage, eventType, dropReason, payload } = {}) =>
    events.push({ fn: 'stage', stage, eventType: eventType || 'STAGE_ENTER', dropReason: dropReason || null, payload });
  pe.recordDrop = ({ stage, dropReason, payload } = {}) =>
    events.push({ fn: 'drop', stage: stage || 'DROPPED', eventType: 'DROP', dropReason: dropReason || 'BOUNCER_REJECTED', payload });
  pe.recordError = ({ stage, error, payload } = {}) =>
    events.push({ fn: 'error', stage: stage || 'ERROR', eventType: 'ERROR', dropReason: 'EXCEPTION_THROWN', payload, error });

  // eslint-disable-next-line global-require
  return require(handlerPath);
}

function makeMessage({ messageId, channelId = 'channel_1' } = {}) {
  const imageMap = new Map();
  imageMap.set('att_1', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/slip.png' });
  return {
    guild: { id: 'guild_1' },
    id: messageId,
    webhookId: undefined,
    // Pick-looking text so the pre-buffer guards pass in NON-human channels too
    // (an image-only post from a non-capper is ignored before buffering);
    // mirrors message-handler.integration.js makeMessage's default content.
    content: 'Lakers -3.5 -110 1u lock',
    channel: { id: channelId, name: 'slips' },
    attachments: imageMap,
    embeds: [],
    reference: null,
    createdTimestamp: Date.now(),
    url: `https://discord.com/channels/guild_1/${channelId}/${messageId}`,
    author: { id: 'user_1', bot: false, displayName: 'Tester', displayAvatarURL: () => null },
    client: { user: { id: 'bot_1' }, channels: { fetch: async () => null } },
    react: async () => {},
    reply: async () => {},
  };
}

function countStage(events, stage) {
  return events.filter(e => e.stage === stage).length;
}

const PASS_SGP_RESULT = {
  hold: true,
  mode: 'enforce',
  sgp: {
    gate: 'SGP_PASS', sgpToken: 'SGPMAX', declaredLegCount: 2, parsedLegCount: 2, legCount: 2,
    bet_type: 'sgpmax', total_odds: '+1435', stake: null, payout: null,
    legs: [
      { entity: 'Lawrence Butler', market: 'TO RECORD 1+ HITS', line: 'TO RECORD 1+ HITS', odds: '+110' },
      { entity: 'Zach Neto', market: 'HITS', line: 'HITS', odds: null },
    ],
    description: 'Lawrence Butler TO RECORD 1+ HITS\nZach Neto HITS',
    ocrMs: 61,
  },
};

// Drive one image message through the real buffer into the chosen vision-failure
// branch. `parsedShape` picks the branch: {is_bet:false} or {type:'bet', bets:[]}.
async function runSeamMessage({ messageId, parsedShape, sgpMode, sgpResult, human = true, pureSlip = true }) {
  process.env.PICKS_CHANNEL_IDS = 'channel_1';
  process.env.HUMAN_SUBMISSION_CHANNEL_IDS = human ? 'channel_1' : '';
  process.env.PURE_SLIP_CHANNEL_IDS = pureSlip ? 'channel_1' : '';
  process.env.DUBCLUB_SPLIT_CHANNEL_IDS = '';
  delete process.env.ADMIN_LOG_CHANNEL_ID; // sendHoldReviewEmbed no-ops

  const events = [];
  const sgpCalls = [];
  const { handleMessage } = loadHandlerWithMocks({
    parseBetText: async () => parsedShape,
    events,
    sgpMode,
    sgpResult,
    sgpCalls,
  });
  await handleMessage(makeMessage({ messageId }));
  await new Promise((resolve) => setTimeout(resolve, 4500)); // buffer flush
  return { events, sgpCalls };
}

async function sectionC() {
  await run('seam: enforce + PASS (pure-slip, is_bet=false) → hold WITH legs, no skip-marker, no drop', async () => {
    const { events, sgpCalls } = await runSeamMessage({
      messageId: 'sgp_pass_1', parsedShape: { is_bet: false }, sgpMode: 'enforce', sgpResult: PASS_SGP_RESULT,
    });
    assert.strictEqual(sgpCalls.length, 1, 'runSgpDropToHold called once');
    assert.strictEqual(sgpCalls[0].mode, 'enforce');
    assert.ok(String(sgpCalls[0].imageUrl).startsWith('https://cdn.discordapp.com/'), 'first slip image URL passed');
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 1, 'gate PASS must stage the hold (FAILS pre-2b)');
    const hold = events.find(e => e.stage === 'MANUAL_REVIEW_HOLD');
    assert.strictEqual(hold.payload.reason, 'ai_is_bet_false');
    assert.ok(hold.payload.ocrSgp, 'hold payload carries the OCR sgp block');
    assert.strictEqual(hold.payload.ocrSgp.legs.length, 2, 'OCR-parsed legs ride the hold payload');
    assert.strictEqual(hold.payload.ocrSgp.description, PASS_SGP_RESULT.sgp.description);
    assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 0, 'skip-marker replaced by the hold');
    assert.ok(!events.some(e => e.fn === 'drop'), 'no drop — the slip was rescued');
  });

  await run('seam: enforce + gate FAIL → byte-identical routing (skip-marker + drop, no hold)', async () => {
    const { events, sgpCalls } = await runSeamMessage({
      messageId: 'sgp_fail_1', parsedShape: { is_bet: false }, sgpMode: 'enforce', sgpResult: { hold: false, mode: 'enforce' },
    });
    assert.strictEqual(sgpCalls.length, 1);
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0);
    assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 1);
    const drop = events.find(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_NO_BET_CONTENT');
    assert.ok(drop, 'existing PRE_FILTER_NO_BET_CONTENT drop preserved');
  });

  await run('seam: off mode → runSgpDropToHold never called; routing as today', async () => {
    const { events, sgpCalls } = await runSeamMessage({
      messageId: 'sgp_off_1', parsedShape: { is_bet: false }, sgpMode: 'off', sgpResult: PASS_SGP_RESULT,
    });
    assert.strictEqual(sgpCalls.length, 0, 'off-mode must not invoke the wiring at all');
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0);
    assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 1);
    assert.ok(events.some(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_NO_BET_CONTENT'));
  });

  await run('seam: wiring throws → swallowed; routing unchanged (never throws into ingest)', async () => {
    const { events } = await runSeamMessage({
      messageId: 'sgp_throw_1', parsedShape: { is_bet: false }, sgpMode: 'enforce', sgpResult: new Error('boom-wiring'),
    });
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0);
    assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 1);
    assert.ok(events.some(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_NO_BET_CONTENT'));
    assert.ok(!events.some(e => e.fn === 'error'), 'no EXCEPTION_THROWN — the helper swallows');
  });

  await run('seam: enforce + PASS on the ai_indeterminate branch → hold with legs + branch reason', async () => {
    const { events } = await runSeamMessage({
      messageId: 'sgp_indet_1', parsedShape: { type: 'bet', bets: [] }, sgpMode: 'enforce', sgpResult: PASS_SGP_RESULT,
    });
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 1, 'indeterminate branch rescued too (FAILS pre-2b)');
    const hold = events.find(e => e.stage === 'MANUAL_REVIEW_HOLD');
    assert.strictEqual(hold.payload.reason, 'ai_indeterminate_no_bets');
    assert.ok(hold.payload.ocrSgp);
    assert.strictEqual(countStage(events, 'PURE_SLIP_SKIP_HOLD'), 0);
    assert.ok(!events.some(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_AI_EMPTY_RESULT'), 'indeterminate drop replaced by the hold');
  });

  await run('seam: non-human channel + enforce → no rescue attempt; drop as today', async () => {
    const { events, sgpCalls } = await runSeamMessage({
      messageId: 'sgp_nonhuman_1', parsedShape: { is_bet: false }, sgpMode: 'enforce', sgpResult: PASS_SGP_RESULT,
      human: false, pureSlip: false,
    });
    assert.strictEqual(sgpCalls.length, 0, 'holds are curated-channel review — no rescue outside HUMAN_SUBMISSION_CHANNEL_IDS');
    assert.strictEqual(countStage(events, 'MANUAL_REVIEW_HOLD'), 0);
    assert.ok(events.some(e => e.fn === 'drop' && e.dropReason === 'PRE_FILTER_NO_BET_CONTENT'));
  });
}

async function main() {
  console.log('SGP 2b drop→hold (SGP_HOLD_MODE):');
  console.log(' Section A — ocrFirstWiring.runSgpDropToHold');
  await sectionA();
  console.log(' Section B — holdReview modal helpers');
  await sectionB();
  console.log(' Section C — messageHandler vision-failure seam');
  await sectionC();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
