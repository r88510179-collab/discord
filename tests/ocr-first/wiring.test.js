// ═══════════════════════════════════════════════════════════
// OCR-first WIRING tests — services/ocrFirstWiring.js
//
// Exercises the slip-path seam dispatch (applyOcrFirst) in all three modes with
// the seam + ocrFirst mocked (deps.{fetchImageBytes, extractViaOcr}) and the
// recordStage sink spied (recordStageFn) — NO network, NO DB. Mirrors the
// lightweight harness in ocr-first.test.js.
//
//   off     → ocrFirst NOT called; staged bet identical to baseline; no event.
//   shadow  → ocrFirst IS called; staged bet identical to baseline; one
//             ocr_shadow_decision emitted; an ocrFirst rejection does NOT throw.
//   cutover → USE_OCR: staged bet = ocr parsedBet (emits ocr_used);
//             FALLBACK / timeout: staged bet = live result (emits ocr_fallback).
//
// Run:  node tests/ocr-first/wiring.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const wiring = require('../../services/ocrFirstWiring');
const {
  applyOcrFirst, resolveMode, ocrBetToInternalBets, compareToLive,
  parseAmericanOdds, parseMoney,
} = wiring;

const FX = path.join(__dirname, 'fixtures');
const slip1Groq = JSON.parse(fs.readFileSync(path.join(FX, 'slip1.groq.json'), 'utf8')); // 3 legs, parlay

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

// A baseline live vision parse: NBA parlay, 3 legs. Frozen-ish snapshot so we can
// prove the staged bet is byte-identical to baseline in off/shadow.
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

function makeDeps({ decision, fetchOk = true, throwOcr = false, hangOcr = false } = {}) {
  const calls = { fetch: 0, extract: 0 };
  return {
    calls,
    fetchImageBytes: async () => { calls.fetch++; return fetchOk ? { base64: 'b64', mediaType: 'image/webp' } : null; },
    extractViaOcr: async () => {
      calls.extract++;
      if (throwOcr) throw new Error('boom-extract');
      if (hangOcr) return new Promise(() => {}); // never resolves → exercises the cutover timeout
      return decision;
    },
  };
}
function spyStage() {
  const events = [];
  return { fn: (e) => events.push(e), events };
}
const IMG = 'https://cdn.discord/x/slip.webp';

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
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', requestId: 'req-off', sourceRef: 'm-off', mode: 'off', deps: d, recordStageFn: rec.fn });
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
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', requestId: 'req-shadow', sourceRef: 'm-shadow', mode: 'shadow', deps: d, recordStageFn: rec.fn });

    // Request path: parsed untouched, returns immediately (fire-and-forget).
    assert.strictEqual(res.ranOcr, true);
    assert.strictEqual(res.parsed, live, 'shadow must NOT replace the parsed ref');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical to baseline in shadow');
    assert.ok(res.shadowPromise && typeof res.shadowPromise.then === 'function', 'shadowPromise must be a promise');

    await res.shadowPromise; // let the background task finish so we can inspect the emit
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
  });

  await run('mode=shadow → leg-count disagreement surfaces mismatchFields, agreement=false', async () => {
    const live = makeLiveParsed();
    live.bets[0].legs = [{ description: 'a' }, { description: 'b' }]; // 2 legs vs OCR 3
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-shadow-mm', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    const ev = rec.events[0];
    assert.strictEqual(ev.payload.ocrLegCount, 3);
    assert.strictEqual(ev.payload.liveLegCount, 2);
    assert.strictEqual(ev.payload.agreement, false);
    assert.ok(ev.payload.mismatchFields.includes('legCount'), 'legCount must be flagged');
  });

  await run('mode=shadow → ocrFirst rejection does NOT throw on the request path (bg swallows it)', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: useOcrDecision, throwOcr: true });
    const rec = spyStage();
    let threw = false;
    let res;
    try {
      res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-shadow-throw', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'applyOcrFirst must not throw when ocrFirst rejects');
    assert.strictEqual(res.parsed, live, 'parsed unchanged after a shadow rejection');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet identical despite shadow rejection');
    // The background promise must RESOLVE (never reject) — shadow swallows everything.
    let bgRejected = false;
    await res.shadowPromise.catch(() => { bgRejected = true; });
    assert.strictEqual(bgRejected, false, 'shadow background promise must not reject');
  });

  await run('mode=shadow → unfetchable image still emits one event (OCR_NO_IMAGE_BYTES)', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision, fetchOk: false });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-shadow-nobytes', mode: 'shadow', deps: d, recordStageFn: rec.fn });
    await res.shadowPromise;
    assert.strictEqual(d.calls.extract, 0, 'no extract without bytes');
    assert.strictEqual(rec.events.length, 1);
    assert.strictEqual(rec.events[0].payload.reason, 'OCR_NO_IMAGE_BYTES');
    assert.strictEqual(rec.events[0].payload.agreement, false);
  });

  // ── mode = cutover (dormant; built + tested) ─────────────
  await run('mode=cutover + USE_OCR → staged bet = ocr parsedBet (emits ocr_used)', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ decision: useOcrDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, mediaType: 'image/webp', requestId: 'req-cut-use', sourceRef: 'm-cut', mode: 'cutover', deps: d, recordStageFn: rec.fn });

    assert.strictEqual(res.ranOcr, true);
    assert.notStrictEqual(res.parsed, live, 'cutover USE_OCR must REPLACE parsed');
    assert.strictEqual(res.parsed.type, 'bet');
    assert.strictEqual(res.parsed.is_bet, true);
    assert.strictEqual(res.parsed.bets.length, 1, 'one slip → one bet');
    const bet = res.parsed.bets[0];
    assert.strictEqual(bet.legs.length, 3, 'staged leg count = OCR parsedBet leg count');
    // The staged bet is derived from the OCR parse, NOT the live parse.
    assert.ok(/Over 7\.5/.test(bet.description), 'description carries OCR selection, not live-a/b/c');
    assert.ok(!/LIVE-PARSE/.test(bet.description), 'live description must be gone');
    assert.strictEqual(bet.odds, 143, 'total_odds "+143" → 143');
    assert.strictEqual(bet.wager, 20);
    assert.strictEqual(bet.payout, 48.63);
    assert.strictEqual(d.calls.extract, 1);
    const ev = rec.events.find((e) => e.eventType === 'ocr_used');
    assert.ok(ev, 'ocr_used must be emitted');
    assert.strictEqual(ev.stage, 'OCR_FIRST');
    assert.strictEqual(ev.payload.legCount, 3);
  });

  await run('mode=cutover + FALLBACK → staged bet = live result (emits ocr_fallback)', async () => {
    const live = makeLiveParsed();
    const baseline = JSON.parse(JSON.stringify(live));
    const d = makeDeps({ decision: fallbackDecision });
    const rec = spyStage();
    const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-cut-fb', sourceRef: 'm-fb', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    assert.strictEqual(res.parsed, live, 'FALLBACK must keep the live parsed ref');
    assert.deepStrictEqual(res.parsed, baseline, 'staged bet = live path result');
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev, 'ocr_fallback must be emitted');
    assert.strictEqual(ev.payload.reason, 'OCR_SGP_GATE');
  });

  await run('mode=cutover + timeout → staged bet = live result (emits ocr_fallback OCR_TIMEOUT)', async () => {
    const saved = process.env.OCR_TIMEOUT_MS;
    process.env.OCR_TIMEOUT_MS = '40'; // tiny budget so the hanging extract trips the timeout
    try {
      const live = makeLiveParsed();
      const baseline = JSON.parse(JSON.stringify(live));
      const d = makeDeps({ hangOcr: true });
      const rec = spyStage();
      const res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-cut-to', sourceRef: 'm-to', mode: 'cutover', deps: d, recordStageFn: rec.fn });
      assert.strictEqual(res.parsed, live, 'timeout must keep the live parsed ref');
      assert.deepStrictEqual(res.parsed, baseline, 'staged bet = live path result on timeout');
      const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
      assert.ok(ev, 'ocr_fallback must be emitted on timeout');
      assert.strictEqual(ev.payload.reason, 'OCR_TIMEOUT');
    } finally {
      if (saved === undefined) delete process.env.OCR_TIMEOUT_MS; else process.env.OCR_TIMEOUT_MS = saved;
    }
  });

  await run('mode=cutover guards against a thrown ocrFirst → live path, ocr_fallback', async () => {
    const live = makeLiveParsed();
    const d = makeDeps({ throwOcr: true });
    const rec = spyStage();
    let threw = false;
    let res;
    try {
      res = await applyOcrFirst({ parsed: live, imageUrl: IMG, requestId: 'req-cut-throw', mode: 'cutover', deps: d, recordStageFn: rec.fn });
    } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'cutover must not throw when ocrFirst rejects');
    assert.strictEqual(res.parsed, live, 'thrown ocrFirst → live path unchanged');
    const ev = rec.events.find((e) => e.eventType === 'ocr_fallback');
    assert.ok(ev, 'ocr_fallback emitted on cutover exception');
  });

  // ── converter + small parsers ────────────────────────────
  await run('ocrBetToInternalBets: slip1 → one parlay, 3 legs, parsed odds/money, sport=Unknown', async () => {
    const bets = ocrBetToInternalBets(slip1Groq);
    assert.strictEqual(bets.length, 1);
    const b = bets[0];
    assert.strictEqual(b.bet_type, 'parlay');
    assert.strictEqual(b.legs.length, 3);
    assert.strictEqual(b.sport, 'Unknown', 'documented cutover gap: no sport in OCR schema');
    assert.strictEqual(b.odds, 143);
    assert.strictEqual(b.wager, 20);
    assert.strictEqual(b.payout, 48.63);
    assert.strictEqual(b.legs[0].odds, -275);
    assert.ok(b.description.includes('Over 7.5') && b.description.includes('Under 9.5'));
  });

  await run('ocrBetToInternalBets: unusable input → []', async () => {
    assert.deepStrictEqual(ocrBetToInternalBets(null), []);
    assert.deepStrictEqual(ocrBetToInternalBets({}), []);
    assert.deepStrictEqual(ocrBetToInternalBets({ legs: [] }), []);
    assert.deepStrictEqual(ocrBetToInternalBets({ legs: [{}] }), [], 'legs with no description drop out');
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
