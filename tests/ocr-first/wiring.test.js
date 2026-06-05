// ═══════════════════════════════════════════════════════════
// OCR-first WIRING tests — services/ocrFirstWiring.js
//
// Exercises the slip-path seam dispatch (applyOcrFirst) in all three modes with
// the seam + ocrFirst mocked (deps.{fetchImageBytes, extractViaOcr, inferSport})
// and the recordStage sink spied (recordStageFn) — NO network, NO DB. The Fix 1
// fetch-hardening cases drive the REAL fetchImageBytes with a mocked global.fetch
// (mirrors the circuit-breaker test in ocr-first.test.js).
//
//   off     → ocrFirst NOT called; staged bet identical to baseline; no event.
//   shadow  → ocrFirst IS called; staged bet identical to baseline; one
//             ocr_shadow_decision emitted; an ocrFirst rejection does NOT throw;
//             multi-image is labelled so the comparison isn't misread (Fix 3).
//   cutover → replaces ONLY when new-bet + single-image + supported sport;
//             else falls back to live with a distinct reason (Fix 2/3/4).
//   fetch   → https + Discord-CDN allowlist, abort-on-timeout, byte cap (Fix 1).
//
// Run:  node tests/ocr-first/wiring.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const wiring = require('../../services/ocrFirstWiring');
const {
  applyOcrFirst, resolveMode, ocrBetToInternalBets, compareToLive, fetchImageBytes,
  isNonNewBet, isSupportedSport, eligibleImageCount, parseAmericanOdds, parseMoney, WiringReason,
} = wiring;

const FX = path.join(__dirname, 'fixtures');
const slip1Groq = JSON.parse(fs.readFileSync(path.join(FX, 'slip1.groq.json'), 'utf8')); // 3 legs, parlay, MLB teams

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

function makeLiveParsed() {
  return {
    type: 'bet', is_bet: true, ticket_status: 'new',
    bets: [{
      sport: 'NBA', league: 'NBA', bet_type: 'parlay', description: 'LIVE-PARSE',
      odds: 999, units: 1, legs: [{ description: 'live-a' }, { description: 'live-b' }, { description: 'live-c' }],
    }],
  };
}

const useOcrDecision = {
  action: 'USE_OCR', reason: 'OCR_PARSE_OK', parsedBet: slip1Groq,
  ocrText: 'Hard Rock Bet 3-Bet Parlay ...', validationErrors: [],
  evidence: { sgpToken: null, headerLegCount: 3, parsedLegCount: 3, ocrChars: 200 },
  timingsMs: { ocr: 700, parse: 200, validate: 1, total: 901 }, imageHash: 'sha256:test',
};
const fallbackDecision = {
  action: 'FALLBACK_GEMINI', reason: 'OCR_SGP_GATE', parsedBet: null,
  ocrText: 'SGPMAX ...', validationErrors: [],
  evidence: { sgpToken: 'SGPMAX', headerLegCount: null, parsedLegCount: null, ocrChars: 120 },
  timingsMs: { ocr: 50, parse: 0, validate: 0, total: 51 }, imageHash: null,
};

// inferSport is injected so the converter/cutover tests stay DB-free (production
// uses ai.js inferLegSport lazily). MLB = supported; null = unresolved.
function makeDeps({ decision, fetchOk = true, throwOcr = false, hangOcr = false, inferSport } = {}) {
  const calls = { fetch: 0, extract: 0 };
  const d = {
    calls,
    fetchImageBytes: async () => { calls.fetch++; return fetchOk ? { ok: true, base64: 'b64', mediaType: 'image/webp' } : { ok: false, reason: WiringReason.NO_IMAGE_BYTES }; },
    extractViaOcr: async () => {
      calls.extract++;
      if (throwOcr) throw new Error('boom-extract');
      if (hangOcr) return new Promise(() => {}); // never resolves → exercises the cutover timeout
      return decision;
    },
  };
  if (inferSport) d.inferSport = inferSport;
  return d;
}
function spyStage() {
  const events = [];
  return { fn: (e) => events.push(e), events };
}
const IMG = 'https://cdn.discordapp.com/attachments/1/2/slip.webp';

// ── PR 2a SGP would-hold fixtures ─────────────────────────────────────────────
// Verbatim OCR + the Groq parses Groq actually returns, mirroring the real
// spot-check slips inlined in sgp-gate.test.js (reports/sgp-content-spotcheck.json
// slip-10 PASS / slip-12 phantom FAIL). The shadow seam injects a FALLBACK_GEMINI/
// OCR_SGP_GATE decision (extractViaOcr's pre-Groq SGP bail) carrying this ocrText,
// plus a deps.callGroqParse that returns the parse the live path never runs.
const SGP_SLIP10_OCR = 'Hard Rock\nBET\nSGPMAX\n2-Bet Parlay\n+1435\nSGP\nAngels vs Athletics\nO0ver0.5\nLAWRENCE BUTLER -TO RECORD 1+HITS\nO0ver0.5\nZACH NETO -HITS';
const SGP_SLIP10_GROQ = { bet_type: 'sgpmax', total_odds: '+1435', legs: [
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

// deps whose extractViaOcr returns the pre-Groq SGP bail decision (carrying ocrText)
// and whose callGroqParse returns the would-hold parse. `throwGroq` exercises the swallow.
function makeSgpDeps({ ocrText, groqParsed, throwGroq = false, groqOk = true }) {
  const calls = { fetch: 0, extract: 0, groq: 0 };
  return {
    calls,
    fetchImageBytes: async () => { calls.fetch++; return { ok: true, base64: 'b64', mediaType: 'image/webp' }; },
    extractViaOcr: async () => {
      calls.extract++;
      return {
        action: 'FALLBACK_GEMINI', reason: 'OCR_SGP_GATE', parsedBet: null,
        ocrText, validationErrors: [],
        evidence: { sgpToken: 'SGPMAX', headerLegCount: null, parsedLegCount: null, ocrChars: ocrText.length },
        timingsMs: { ocr: 60, parse: 0, validate: 0, total: 61 }, imageHash: null,
      };
    },
    callGroqParse: async () => {
      calls.groq++;
      if (throwGroq) throw new Error('boom-groq');
      return groqOk ? { ok: true, parsed: groqParsed, raw: JSON.stringify(groqParsed) } : { ok: false, parsed: null, raw: null };
    },
  };
}

async function main() {
  console.log('OCR-first wiring (services/ocrFirstWiring.js):');

  // ── resolveMode ──────────────────────────────────────────
  await run('resolveMode: valid passthrough + case-insensitive + invalid→off', async () => {
    assert.strictEqual(resolveMode('off'), 'off');
    assert.strictEqual(resolveMode('shadow'), 'shadow');
    assert.strictEqual(resolveMode('cutover'), 'cutover');
    assert.strictEqual(resolveMode('CUTOVER'), 'cutover');
    assert.strictEqual(resolveMode(' Shadow '), 'shadow');
    assert.strictEqual(resolveMode('garbage'), 'off');
    assert.strictEqual(resolveMode(''), 'off');
    assert.strictEqual(resolveMode(undefined), 'off');
    assert.strictEqual(resolveMode(null), 'off');
    assert.strictEqual(typeof wiring.MODE, 'string');
  });

  // ── mode = off ───────────────────────────────────────────
  await run('mode=off → ocrFirst NOT called; staged bet identical to baseline; no event', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', imageCount: 1, requestId: 'req-off', sourceRef: 'm-off', mode: 'off', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.ranOcr, false, 'off must not run ocr');
    assert.strictEqual(res.parsed, live, 'off must return the same parsed ref');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical to baseline');
    assert.strictEqual(d.calls.fetch, 0, 'no image fetch in off');
    assert.strictEqual(d.calls.extract, 0, 'extractViaOcr NOT called in off');
    assert.strictEqual(rec.events.length, 0, 'no event in off');
  });

  await run('no image → no-op even when mode=shadow', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: null, mode: 'shadow', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.ranOcr, false);
    assert.strictEqual(res.parsed, live);
    assert.strictEqual(d.calls.extract, 0);
    assert.strictEqual(rec.events.length, 0);
  });

  // ── mode = shadow ────────────────────────────────────────
  await run('mode=shadow → ocrFirst IS called; staged bet identical; one ocr_shadow_decision (agreement)', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', imageCount: 1, requestId: 'req-shadow', sourceRef: 'm-shadow', mode: 'shadow', deps: d, recordStageFn: rec.fn });

    assert.strictEqual(res.ranOcr, true);
    assert.strictEqual(res.parsed, live, 'shadow must NOT replace the parsed ref');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical to baseline in shadow');
    assert.ok(res.shadowPromise && typeof res.shadowPromise.then === 'function', 'shadowPromise must be a promise');

    await res.shadowPromise; // let the background task finish
    assert.strictEqual(d.calls.extract, 1, 'extractViaOcr IS called once in shadow');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet STILL identical after shadow resolves');

    assert.strictEqual(rec.events.length, 1, 'exactly one shadow event');
    const ev = rec.events[0];
    assert.strictEqual(ev.stage, 'OCR_FIRST');
    assert.strictEqual(ev.eventType, 'ocr_shadow_decision');
    assert.strictEqual(ev.ingestId, 'req-shadow');
    assert.strictEqual(ev.payload.action, 'USE_OCR');
    assert.strictEqual(ev.payload.reason, 'OCR_PARSE_OK');
    assert.strictEqual(ev.payload.ocrLegCount, 3);
    assert.strictEqual(ev.payload.liveLegCount, 3);
    assert.strictEqual(ev.payload.agreement, true);
    assert.deepStrictEqual(ev.payload.mismatchFields, []);
    assert.strictEqual(ev.payload.ocrMs, 901);
    assert.strictEqual(ev.payload.scope, 'single');
    assert.strictEqual(ev.payload.imageCount, 1);
  });

  await run('mode=shadow → leg-count disagreement surfaces mismatchFields, agreement=false', async () => {
    const live = makeLiveParsed();
    live.bets[0].legs = [{ description: 'a' }, { description: 'b' }]; // 2 legs vs OCR 3
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-shadow-mm', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const ev = rec.events[0];
    assert.strictEqual(ev.payload.ocrLegCount, 3);
    assert.strictEqual(ev.payload.liveLegCount, 2);
    assert.strictEqual(ev.payload.agreement, false);
    assert.ok(ev.payload.mismatchFields.includes('legCount'), 'legCount must be flagged');
  });

  await run('Fix 3 (shadow) → multi-image labelled scope=image[0]_of_multi, agreement forced false', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision }); // OCR 3 legs == live 3 legs (would agree if single)
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 3, requestId: 'req-shadow-multi', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const ev = rec.events[0];
    assert.strictEqual(ev.payload.scope, 'image[0]_of_multi', 'multi-image must be labelled');
    assert.strictEqual(ev.payload.imageCount, 3);
    assert.strictEqual(ev.payload.agreement, false, 'agreement forced false for multi-image so it is not misread');
    assert.ok(ev.payload.mismatchFields.includes('multiImage'), 'multiImage must be flagged');
  });

  await run('mode=shadow → ocrFirst rejection does NOT throw on the request path (bg swallows it)', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: useOcrDecision, throwOcr: true });
    const rec = spyStage();
    let threw = false;
    let res;
    try {
      res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-shadow-throw', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'applyOcrFirst must not throw when ocrFirst rejects');
    assert.strictEqual(res.parsed, live, 'parsed unchanged after a shadow rejection');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical despite shadow rejection');
    let bgRejected = false;
    await res.shadowPromise.catch(() => { bgRejected = true; });
    assert.strictEqual(bgRejected, false, 'shadow background promise must not reject');
  });

  await run('mode=shadow → unfetchable image still emits one event (reason from fetch result)', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision, fetchOk: false });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-shadow-nobytes', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    assert.strictEqual(d.calls.extract, 0, 'no extract without bytes');
    assert.strictEqual(rec.events.length, 1);
    assert.strictEqual(rec.events[0].payload.reason, WiringReason.NO_IMAGE_BYTES);
    assert.strictEqual(rec.events[0].payload.agreement, false);
  });

  // ── PR 2a: SGP would-hold measurement (shadow-only; additive) ─────────────
  await run('shadow + SGP slip-10 (market-in-selection) → ocr_sgp_would_hold PASS; staged bet untouched', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeSgpDeps({ ocrText: SGP_SLIP10_OCR, groqParsed: SGP_SLIP10_GROQ });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-sgp-pass', sourceRef: 'm-sgp', mode: 'shadow', deps: d, recordStageFn: rec.fn });

    assert.strictEqual(res.parsed, live, 'shadow must NOT replace the staged bet for an SGP slip');
    await res.shadowPromise;
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical after the SGP would-hold runs');

    // The pre-Groq SGP bail still emits its FALLBACK_GEMINI shadow_decision …
    const sd = rec.events.find((e) => e.eventType === 'ocr_shadow_decision');
    assert.ok(sd && sd.payload.action === 'FALLBACK_GEMINI' && sd.payload.reason === 'OCR_SGP_GATE');
    // … and the would-hold rides alongside it.
    const wh = rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold');
    assert.ok(wh, 'ocr_sgp_would_hold must be emitted for an SGP slip');
    assert.strictEqual(wh.stage, 'OCR_FIRST');
    assert.strictEqual(wh.ingestId, 'req-sgp-pass');
    assert.strictEqual(wh.payload.pass, true, `expected PASS, got ${wh.payload.reason}`);
    assert.strictEqual(wh.payload.reason, 'SGP_PASS');
    assert.strictEqual(wh.payload.declaredLegCount, 2, 'declared from the 2-Bet header');
    assert.strictEqual(wh.payload.parsedLegCount, 2);
    assert.strictEqual(wh.payload.scope, 'single');
    assert.strictEqual(wh.payload.ocrMs, 61, 'ocrMs mirrors decision.timingsMs.total');
    assert.strictEqual(d.calls.groq, 1, 'exactly one shadow-only Groq parse');
  });

  await run('shadow + SGP slip-12 (phantom leg) → ocr_sgp_would_hold FAIL count mismatch', async () => {
    const live = makeLiveParsed();
    const d = makeSgpDeps({ ocrText: SGP_SLIP12_OCR, groqParsed: SGP_SLIP12_GROQ });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-sgp-fail', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const wh = rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold');
    assert.ok(wh, 'ocr_sgp_would_hold emitted');
    assert.strictEqual(wh.payload.pass, false);
    assert.strictEqual(wh.payload.reason, 'SGP_COUNT_MISMATCH');
    assert.strictEqual(wh.payload.declaredLegCount, 3, 'declared from the 3-Bet header');
    assert.strictEqual(wh.payload.parsedLegCount, 4, 'phantom game-odds leg inflates the raw parse count');
  });

  await run('shadow + SGP slip with NO N-Bet header → would-hold pass:false SGP_NO_DECLARED_COUNT (parse still recorded)', async () => {
    const live = makeLiveParsed();
    const ocrText = 'Hard Rock\nBET\nSGPMAX\nAngels vs Athletics\nLAWRENCE BUTLER -HITS\nOver 0.5'; // no "N-Bet" header
    const groqParsed = { bet_type: 'sgpmax', legs: [{ matchup: 'Angels vs Athletics', player: 'Lawrence Butler', market: 'HITS', selection: 'Over 0.5', odds: null }] };
    const d = makeSgpDeps({ ocrText, groqParsed });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-sgp-nohdr', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const wh = rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold');
    assert.ok(wh);
    assert.strictEqual(wh.payload.pass, false);
    assert.strictEqual(wh.payload.reason, 'SGP_NO_DECLARED_COUNT');
    assert.strictEqual(wh.payload.declaredLegCount, null);
    assert.strictEqual(wh.payload.parsedLegCount, 1, 'parse recorded even without a declared count');
  });

  await run('shadow + SGP slip, Groq soft-fail (ok:false) → would-hold pass:false SGP_NO_LEGS', async () => {
    const live = makeLiveParsed();
    const d = makeSgpDeps({ ocrText: SGP_SLIP10_OCR, groqParsed: null, groqOk: false });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-sgp-softfail', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const wh = rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold');
    assert.ok(wh, 'a Groq soft-fail is data, not an error — still emits');
    assert.strictEqual(wh.payload.pass, false);
    assert.strictEqual(wh.payload.reason, 'SGP_NO_LEGS');
    assert.strictEqual(wh.payload.parsedLegCount, null);
  });

  await run('shadow + non-SGP decision → NO ocr_sgp_would_hold (only the shadow_decision)', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision }); // reason OCR_PARSE_OK, not SGP
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-nonsgp', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    assert.strictEqual(rec.events.length, 1, 'exactly one event for a non-SGP slip');
    assert.ok(!rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold'), 'no would-hold for a non-SGP decision');
  });

  await run('shadow + SGP slip, would-hold Groq throws → swallowed; live path intact, shadow_decision still emitted', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeSgpDeps({ ocrText: SGP_SLIP10_OCR, groqParsed: SGP_SLIP10_GROQ, throwGroq: true });
    const rec = spyStage();
    let threw = false; let res;
    try {
      res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-sgp-throw', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'applyOcrFirst must not throw when the would-hold chain throws');
    assert.strictEqual(res.parsed, live);
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical despite the swallowed would-hold error');
    let bgRejected = false;
    await res.shadowPromise.catch(() => { bgRejected = true; });
    assert.strictEqual(bgRejected, false, 'shadow bg promise must not reject on a would-hold error');
    assert.ok(rec.events.find((e) => e.eventType === 'ocr_shadow_decision'), 'shadow_decision still emitted (it precedes the would-hold)');
    assert.ok(!rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold'), 'no would-hold event when the chain throws (swallowed)');
  });

  await run('cutover + SGP decision → NO ocr_sgp_would_hold (measurement is shadow-only)', async () => {
    const live = makeLiveParsed();
    const d = makeSgpDeps({ ocrText: SGP_SLIP10_OCR, groqParsed: SGP_SLIP10_GROQ });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-sgp', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.parsed, live, 'cutover SGP fallback keeps the live parse');
    assert.strictEqual(d.calls.groq, 0, 'cutover must NOT run the shadow-only would-hold Groq parse');
    assert.ok(!rec.events.find((e) => e.eventType === 'ocr_sgp_would_hold'), 'would-hold is shadow-only');
    const fb = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(fb && fb.payload.reason === 'OCR_SGP_GATE', 'cutover still emits its ocr_fallback unchanged');
  });

  // ── mode = cutover (dormant; eligibility-guarded) ────────
  await run('mode=cutover ELIGIBLE (new-bet + single-image + supported sport) → staged = ocr bet (ocr_used)', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision, inferSport: () => 'MLB' });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', imageCount: 1, requestId: 'req-cut-use', sourceRef: 'm-cut', mode: 'cutover', deps: d, recordStageFn: rec.fn });

    assert.strictEqual(res.ranOcr, true);
    assert.notStrictEqual(res.parsed, live, 'eligible cutover must REPLACE parsed');
    assert.strictEqual(res.parsed.bets.length, 1, 'one slip → one bet');
    const bet = res.parsed.bets[0];
    assert.strictEqual(bet.legs.length, 3, 'staged leg count = OCR parsedBet leg count');
    assert.strictEqual(bet.sport, 'MLB', 'sport resolved + supported');
    assert.ok(/Over 7\.5/.test(bet.description), 'description carries OCR selection, not live-a/b/c');
    assert.ok(!/LIVE-PARSE/.test(bet.description), 'live description must be gone');
    assert.strictEqual(bet.odds, 143);
    assert.strictEqual(d.calls.extract, 1);
    const ev = rec.events.find((e) => e.eventType === 'ocr_used');
    assert.ok(ev, 'ocr_used must be emitted');
    assert.strictEqual(ev.payload.sport, 'MLB');
    assert.strictEqual(ev.payload.legCount, 3);
  });

  await run('Fix 2 (cutover) → live result/recap NOT restaged; staged==live, OCR_CUTOVER_SKIP_NONBET, no OCR call', async () => {
    for (const live of [
      { type: 'result', outcome: 'win', bets: [] },
      { type: 'untracked_win', description: 'x', bets: [] },
      { type: 'bet', is_bet: true, ticket_status: 'winner', bets: [{ legs: [{ description: 'a' }] }] },
      { type: 'bet', is_bet: true, ticket_status: 'loser', bets: [{ legs: [{ description: 'a' }] }] },
    ]) {
      const d = makeDeps({ decision: useOcrDecision, inferSport: () => 'MLB' });
      const rec = spyStage();
      const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-nonbet', mode: 'cutover', deps: d, recordStageFn: rec.fn });
      assert.strictEqual(res.parsed, live, `non-new-bet (${live.type}/${live.ticket_status}) must keep live parse`);
      assert.strictEqual(d.calls.extract, 0, 'must skip the OCR call entirely (guard before fetch)');
      assert.strictEqual(d.calls.fetch, 0, 'must not even fetch the image');
      const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
      assert.ok(ev && ev.payload.reason === WiringReason.CUTOVER_SKIP_NONBET, 'OCR_CUTOVER_SKIP_NONBET expected');
    }
  });

  await run('Fix 3 (cutover) → multi-image NOT replaced; staged==live, OCR_CUTOVER_SKIP_MULTI_IMAGE, no OCR call', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision, inferSport: () => 'MLB' });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 2, requestId: 'req-cut-multi', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.parsed, live, 'multi-image must keep the live merged parse');
    assert.strictEqual(d.calls.extract, 0, 'must skip the OCR call (guard before fetch)');
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev && ev.payload.reason === WiringReason.CUTOVER_SKIP_MULTI_IMAGE, 'OCR_CUTOVER_SKIP_MULTI_IMAGE expected');
    assert.strictEqual(ev.payload.imageCount, 2);
  });

  await run('Fix 4 (cutover) → Unknown/unsupported sport NOT replaced; staged==live, OCR_CUTOVER_SKIP_SPORT', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: useOcrDecision, inferSport: () => null }); // sport unresolved → Unknown
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-sport', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.parsed, live, 'unsupported-sport must keep the live parse');
    assert.deepStrictEqual(res.parsed, baseline);
    assert.strictEqual(d.calls.extract, 1, 'OCR ran (sport guard is post-convert)');
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev && ev.payload.reason === WiringReason.CUTOVER_SKIP_SPORT, 'OCR_CUTOVER_SKIP_SPORT expected');
  });

  await run('mode=cutover + FALLBACK decision → staged==live, ocr_fallback (decision reason)', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: fallbackDecision, inferSport: () => 'MLB' });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-fb', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.parsed, live, 'FALLBACK must keep the live parsed ref');
    assert.deepStrictEqual(res.parsed, baseline);
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev && ev.payload.reason === 'OCR_SGP_GATE');
  });

  await run('mode=cutover + timeout → staged==live, ocr_fallback OCR_TIMEOUT', async () => {
    const saved = process.env.OCR_TIMEOUT_MS;
    process.env.OCR_TIMEOUT_MS = '40';
    try {
      const live = makeLiveParsed();
      const baseline = JSON.parse(JSON.stringify(live));
      const d = makeDeps({ hangOcr: true, inferSport: () => 'MLB' });
      const rec = spyStage();
      const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-to', mode: 'cutover', deps: d, recordStageFn: rec.fn });
      assert.strictEqual(res.parsed, live, 'timeout must keep the live parsed ref');
      assert.deepStrictEqual(res.parsed, baseline);
      const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
      assert.ok(ev && ev.payload.reason === 'OCR_TIMEOUT', 'OCR_TIMEOUT expected');
    } finally {
      if (saved === undefined) delete process.env.OCR_TIMEOUT_MS; else process.env.OCR_TIMEOUT_MS = saved;
    }
  });

  await run('mode=cutover guards against a thrown ocrFirst → live path, ocr_fallback', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ throwOcr: true, inferSport: () => 'MLB' });
    const rec = spyStage();
    let threw = false;
    let res;
    try {
      res = await applyOcrFirst({ parsed: live, imageUrl: IMG, imageCount: 1, requestId: 'req-cut-throw', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'cutover must not throw when ocrFirst rejects');
    assert.strictEqual(res.parsed, live, 'thrown ocrFirst → live path unchanged');
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev, 'ocr_fallback emitted on cutover exception');
  });

  // ── Fix 1: fetchImageBytes hardening (real fn, mocked global.fetch) ──
  await run('Fix 1 → disallowed host: IMAGE_HOST_BLOCKED with NO network attempt', async () => {
    const savedFetch = global.fetch;
    let fetchCalled = 0;
    global.fetch = async () => { fetchCalled++; return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }; };
    try {
      const r = await fetchImageBytes('https://evil.example.com/x.png', 'image/png', 5000);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, WiringReason.IMAGE_HOST_BLOCKED);
      assert.strictEqual(fetchCalled, 0, 'disallowed host must NOT be fetched');
      // non-https on an allowed host is also blocked
      const r2 = await fetchImageBytes('http://cdn.discordapp.com/x.png', 'image/png', 5000);
      assert.strictEqual(r2.reason, WiringReason.IMAGE_HOST_BLOCKED);
      assert.strictEqual(fetchCalled, 0, 'non-https must NOT be fetched');
    } finally { global.fetch = savedFetch; }
  });

  await run('Fix 1 → allowed Discord-CDN host happy path: ok + base64 + mediaType from content-type', async () => {
    const savedFetch = global.fetch;
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-type' ? 'image/webp' : null) },
      body: null, // force arrayBuffer path
      arrayBuffer: async () => new TextEncoder().encode('SLIPBYTES').buffer,
    });
    try {
      const r = await fetchImageBytes('https://media.discordapp.net/a/b/slip.webp', 'image/png', 5000);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.mediaType, 'image/webp');
      assert.ok(typeof r.base64 === 'string' && r.base64.length > 0);
    } finally { global.fetch = savedFetch; }
  });

  await run('Fix 1 → content-length over cap: IMAGE_TOO_LARGE + fetch aborted', async () => {
    const savedFetch = global.fetch; const savedMax = process.env.OCR_IMAGE_MAX_BYTES;
    process.env.OCR_IMAGE_MAX_BYTES = '1000';
    let capturedSignal = null;
    global.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'content-length' ? '99999999' : (h === 'content-type' ? 'image/png' : null)) },
        body: null, arrayBuffer: async () => new ArrayBuffer(99999999),
      };
    };
    try {
      const r = await fetchImageBytes('https://cdn.discordapp.com/x.png', 'image/png', 5000);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, WiringReason.IMAGE_TOO_LARGE);
      assert.ok(capturedSignal && capturedSignal.aborted === true, 'oversized content-length must abort the fetch');
    } finally { global.fetch = savedFetch; if (savedMax === undefined) delete process.env.OCR_IMAGE_MAX_BYTES; else process.env.OCR_IMAGE_MAX_BYTES = savedMax; }
  });

  await run('Fix 1 → streamed bytes over cap: IMAGE_TOO_LARGE + fetch aborted mid-download', async () => {
    const savedFetch = global.fetch; const savedMax = process.env.OCR_IMAGE_MAX_BYTES;
    process.env.OCR_IMAGE_MAX_BYTES = '1000';
    let capturedSignal = null;
    global.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'content-type' ? 'image/webp' : null) }, // no content-length → streaming path
        body: { getReader: () => { let sent = false; return { read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(5000) }; }, cancel: async () => {} }; } },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    try {
      const r = await fetchImageBytes('https://cdn.discordapp.com/x.webp', 'image/webp', 5000);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, WiringReason.IMAGE_TOO_LARGE);
      assert.ok(capturedSignal && capturedSignal.aborted === true, 'streaming overflow must abort the fetch');
    } finally { global.fetch = savedFetch; if (savedMax === undefined) delete process.env.OCR_IMAGE_MAX_BYTES; else process.env.OCR_IMAGE_MAX_BYTES = savedMax; }
  });

  await run('Fix 1 → fetch timeout fires ABORT (not just the wait) → IMAGE_TIMEOUT', async () => {
    const savedFetch = global.fetch;
    let aborted = false;
    global.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      // otherwise never resolves
    });
    try {
      const r = await fetchImageBytes('https://cdn.discordapp.com/slow.png', 'image/png', 30);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, WiringReason.IMAGE_TIMEOUT);
      assert.strictEqual(aborted, true, 'the underlying fetch must be ABORTED, not just abandoned');
    } finally { global.fetch = savedFetch; }
  });

  // ── converter + helpers ──────────────────────────────────
  await run('ocrBetToInternalBets: slip1 + supported inferSport → MLB parlay, 3 legs, parsed odds/money', async () => {
    const bets = ocrBetToInternalBets(slip1Groq, { inferSport: () => 'MLB' });
    assert.strictEqual(bets.length, 1);
    const b = bets[0];
    assert.strictEqual(b.bet_type, 'parlay');
    assert.strictEqual(b.legs.length, 3);
    assert.strictEqual(b.sport, 'MLB');
    assert.strictEqual(b.odds, 143);
    assert.strictEqual(b.wager, 20);
    assert.strictEqual(b.payout, 48.63);
    assert.strictEqual(b.legs[0].odds, -275);
    assert.ok(b.description.includes('Over 7.5') && b.description.includes('Under 9.5'));
  });

  await run('ocrBetToInternalBets: unresolved sport → Unknown (cutover guard then falls back)', async () => {
    const bets = ocrBetToInternalBets(slip1Groq, { inferSport: () => null });
    assert.strictEqual(bets[0].sport, 'Unknown');
    assert.strictEqual(isSupportedSport(bets[0].sport), false);
  });

  await run('ocrBetToInternalBets: unusable input → []', async () => {
    assert.deepStrictEqual(ocrBetToInternalBets(null), []);
    assert.deepStrictEqual(ocrBetToInternalBets({}), []);
    assert.deepStrictEqual(ocrBetToInternalBets({ legs: [] }), []);
    assert.deepStrictEqual(ocrBetToInternalBets({ legs: [{}] }, { inferSport: () => 'MLB' }), [], 'legs with no description drop out');
  });

  await run('isNonNewBet / isSupportedSport', async () => {
    assert.strictEqual(isNonNewBet({ type: 'result' }), true);
    assert.strictEqual(isNonNewBet({ type: 'untracked_win' }), true);
    assert.strictEqual(isNonNewBet({ type: 'bet', ticket_status: 'winner' }), true);
    assert.strictEqual(isNonNewBet({ type: 'bet', ticket_status: 'loser' }), true);
    assert.strictEqual(isNonNewBet({ type: 'bet', is_bet: true, ticket_status: 'new' }), false);
    assert.strictEqual(isNonNewBet(null), false);
    assert.strictEqual(isSupportedSport('MLB'), true);
    assert.strictEqual(isSupportedSport('nba'), true);
    assert.strictEqual(isSupportedSport('Unknown'), false);
    assert.strictEqual(isSupportedSport(''), false);
    assert.strictEqual(isSupportedSport(null), false);
  });

  await run('eligibleImageCount: slip+embed → 1 (single); true 2-attachment → 2 (multi)', async () => {
    const ATT = { url: 'a', type: 'image/webp', origin: 'attachment' };
    const EMBED = { url: 'e', type: 'image/png', origin: 'embed' };
    // The HRB artifact: 1 real slip attachment + 1 share-embed thumbnail → single.
    assert.strictEqual(eligibleImageCount([ATT, EMBED]), 1, 'slip+embed must collapse to 1');
    assert.strictEqual(eligibleImageCount([EMBED, ATT]), 1, 'order-independent — still 1 real attachment');
    // A genuine multi-image slip (2 real attachments) must stay multi.
    assert.strictEqual(eligibleImageCount([ATT, ATT]), 2, 'two real attachments → 2 (multi)');
    assert.strictEqual(eligibleImageCount([ATT]), 1, 'one attachment → 1');
    // Fail-safe: no real attachment tagged → fall back to total length (never
    // wrongly collapse). Untagged/legacy lists behave exactly as before.
    assert.strictEqual(eligibleImageCount([EMBED, EMBED]), 2, 'pure-embed slip → total (multi), not collapsed');
    assert.strictEqual(eligibleImageCount([{ url: 'x' }, { url: 'y' }]), 2, 'untagged/legacy → total length');
    assert.strictEqual(eligibleImageCount([]), 0);
    assert.strictEqual(eligibleImageCount(null), 0, 'non-array → 0');
    assert.strictEqual(eligibleImageCount(undefined), 0);
  });

  await run('mapBetType: single→straight, single(multi-leg)→parlay, sgp→parlay', async () => {
    assert.strictEqual(wiring.mapBetType('single', 1), 'straight');
    assert.strictEqual(wiring.mapBetType('single', 3), 'parlay');
    assert.strictEqual(wiring.mapBetType('parlay', 3), 'parlay');
    assert.strictEqual(wiring.mapBetType('sgpmax', 4), 'parlay');
    assert.strictEqual(wiring.mapBetType('', 1), 'straight');
    assert.strictEqual(wiring.mapBetType('', 2), 'parlay');
  });

  await run('parseAmericanOdds / parseMoney edge cases', async () => {
    assert.strictEqual(parseAmericanOdds('+143'), 143);
    assert.strictEqual(parseAmericanOdds('-275'), -275);
    assert.strictEqual(parseAmericanOdds('450'), 450);
    assert.strictEqual(parseAmericanOdds(null), null);
    assert.strictEqual(parseAmericanOdds('n/a'), null);
    assert.strictEqual(parseMoney('$48.63'), 48.63);
    assert.strictEqual(parseMoney('$1,250'), 1250);
    assert.strictEqual(parseMoney(null), null);
  });

  await run('compareToLive: FALLBACK decision never claims agreement', async () => {
    const cmp = compareToLive(fallbackDecision, makeLiveParsed());
    assert.strictEqual(cmp.agreement, false);
    assert.deepStrictEqual(cmp.mismatchFields, []);
    assert.strictEqual(cmp.liveLegCount, 3);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', (err && err.stack) || err);
  process.exit(1);
});
