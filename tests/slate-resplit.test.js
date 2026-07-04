// ═══════════════════════════════════════════════════════════
// Slate re-split — mixed-sport recap SHEET recovery (services/slateResplit.js).
//
// Background (bet 8436c0c7, @Bobby_tracker): a recap slate is a LIST of
// INDEPENDENT picks, each with its OWN stake ("... 5u | ... 10u"). Vision is
// told to split a multi-sport sheet into per-pick straights, but on a genuinely
// mixed soccer+MMA slate it returned ONE bet_type:parlay, N legs, the SLATE's
// DOMINANT sport (Soccer) — verified via pipeline_events ingest_id
// twit_2068786490960945493 (PARSED legCount:8 betType:parlay sport:Soccer). So
// every leg (incl. the MMA fighters) inherited Soccer and the per-pick stakes
// were lost. The all-MMA sibling tweet parsed as a UFC parlay — same picks,
// correct sport — proving the sport is decided ONCE per slate, never per leg.
//
// slateResplit re-parses the RAW tweet text into per-pick straights: units from
// the per-pick stake token; sport = ITD/finish-method → MMA, national team →
// Soccer, modeled team → its league (inferLegSport), else INHERIT the vision
// sport flagged low-confidence.
//
// DOCUMENTED LIMITATION (ratified with the owner): a bare "<fighter> ML"
// (Christian Rodriguez / Manel Kape / Vinicius Oliveira) carries NO deterministic
// signal — "Christian Rodriguez" is also a real Uruguay/Peñarol footballer — so
// it KEEPS the vision sport (Soccer here), flagged low-confidence, rather than
// being force-guessed to MMA. A data-driven fighter roster is a separate
// follow-up. These tests therefore assert bare fighters → Soccer/low-conf (NOT
// MMA), while the deterministic wins (ITD→MMA, nations→Soccer, per-pick units)
// are asserted exactly.
//
// Covers:
//   A. Pure helpers — parseUnits (multi-digit 10u→10, 5u/3u, clamp, none→null),
//      parseOdds, stripStake, splitSegments.
//   B. inferPickSport (injected stubs, DB-free) — MMA marker / team / national /
//      fallback-low-confidence ordering.
//   C. inferPickSport (real ai.js) — the fixture picks classify as expected.
//   D. detectSheet on Tweet A (12 picks) — isSheet, per-pick sport + units incl.
//      the headline assertions (Christian Rodriguez units 10; ITD→MMA;
//      soccer legs stay Soccer with correct stakes; Manel Kape 10u).
//   E. detectSheet on Tweet B (4 soccer picks) — all Soccer, correct stakes.
//   F. Mode gating — off no-op; shadow emits one slate_resplit_shadow and NEVER
//      acts (isSheet:false); cutover emits slate_resplit_used and returns
//      isSheet:true + the straights.
//   G. Negatives — a single straight is never a sheet; a real parlay with ONE
//      ticket stake (only one segment carries a "Nu" token) is never re-split.
//
// Run:  node tests/slate-resplit.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Throwaway DB — set BEFORE requiring ai.js (which pulls in database.js/migrator)
// so the real prod DB is never opened. slateResplit itself is DB-free; ai.js is
// required only for the REAL inferLegSport / descNamesNationalTeam integration.
const dbFile = path.join(os.tmpdir(), `bettracker-slate-resplit-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.SLATE_RESPLIT_MODE;
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

const slate = require('../services/slateResplit');
const ai = require('../services/ai');
const realDeps = { inferLegSport: ai.inferLegSport, descNamesNationalTeam: ai.descNamesNationalTeam };

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; } else { console.log(`  FAIL: ${label}`); fail++; }
}
function eq(label, expected, actual) {
  if (expected === actual) { pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`); fail++; }
}

// ── Fixtures (the two source tweets, verbatim from prompts/fix-mixed-slate-ingest.md) ──
const TWEET_A = 'Argentina ML (-185) 5u | Spain -2.5 (-110) 5u | Iran/Belgium 1H "U" 1.5 (-205) 5u | Uruguay/Verde 1H "O" 0.5 (-205) 5u | Egypt/NZ 1H "O" 0.5 (-225) 5u | Japan ML (-165) 5u | Japan/Tunisia 1H "O" 0.5 (-225) 3u | Manel Kape ML (-155) 10u | Navajo Stirling ITD (-105) 5u | Christian Rodriguez ML (-215) 10u | Murtalazi Magomedov ITD (-115) 3u | Vinicius Oliveira ML live (-145) 5u';
const TWEET_B = 'Spain -2.5 (-110) 5u | Iran/Belgium 1H "U" 1.5 (-205) 5u | Uruguay/Verde 1H "O" 0.5 (-205) 5u | Egypt/NZ 1H "O" 0.5 (-225) 5u';

// A vision "parlay" carrying the slate's dominant sport (Soccer), N legs.
function parlay(sport, legCount) {
  return { type: 'parlay', bet_type: 'parlay', sport, legs: Array.from({ length: legCount }, (_, i) => ({ description: `leg ${i}` })) };
}
// Look a pick up by a substring of its description.
function pickBy(picks, needle) {
  return picks.find((p) => (p.description || '').toLowerCase().includes(needle.toLowerCase()));
}

// ── A. Pure helpers ─────────────────────────────────────────────────────────
console.log('A. pure helpers — units / odds / strip / split');
eq('parseUnits 10u → 10', 10, slate.parseUnits('Christian Rodriguez ML (-215) 10u'));
eq('parseUnits 5u → 5', 5, slate.parseUnits('Spain -2.5 (-110) 5u'));
eq('parseUnits 3u → 3', 3, slate.parseUnits('Murtalazi Magomedov ITD (-115) 3u'));
eq('parseUnits "3 units" → 3', 3, slate.parseUnits('Some pick 3 units'));
eq('parseUnits 2.5u → 2.5', 2.5, slate.parseUnits('Half unit 2.5u'));
eq('parseUnits none → null', null, slate.parseUnits('Lakers -3.5 (-110)'));
eq('parseUnits clamp >100 → 100', 100, slate.parseUnits('bogus 250u'));
eq('parseOdds (-215) → -215', -215, slate.parseOdds('Christian Rodriguez ML (-215) 10u'));
eq('parseOdds none → null', null, slate.parseOdds('Some team ML 5u'));
eq('stripStake removes trailing stake', 'Christian Rodriguez ML (-215)', slate.stripStake('Christian Rodriguez ML (-215) 10u'));
eq('stripStake keeps a stake-free desc', 'Lakers -3.5 (-110)', slate.stripStake('Lakers -3.5 (-110)'));
eq('splitSegments pipe count', 12, slate.splitSegments(TWEET_A).length);
eq('splitSegments newline', 2, slate.splitSegments('Lakers ML 5u\nCeltics ML 3u').length);

// ── B. inferPickSport (injected stubs — DB-free branch coverage) ─────────────
console.log('B. inferPickSport — signal ordering (stubbed deps)');
const noDeps = { inferLegSport: () => null, descNamesNationalTeam: () => false };
eq('ITD → MMA (high)', 'MMA', slate.inferPickSport('Navajo Stirling ITD (-105)', 'Soccer', noDeps).sport);
eq('"by decision" → MMA', 'MMA', slate.inferPickSport('Fighter wins by decision', 'Soccer', noDeps).sport);
ok('MMA marker is high confidence', slate.inferPickSport('X ITD', 'Soccer', noDeps).confidence === 'high');
eq('injected team → its league', 'NBA', slate.inferPickSport('Lakers -3.5', 'Soccer', { inferLegSport: () => 'NBA', descNamesNationalTeam: () => false }).sport);
eq('injected national → Soccer', 'Soccer', slate.inferPickSport('Spain -2.5', 'MMA', { inferLegSport: () => null, descNamesNationalTeam: () => true }).sport);
{
  const r = slate.inferPickSport('Christian Rodriguez ML', 'Soccer', noDeps);
  eq('no signal → inherits fallback sport', 'Soccer', r.sport);
  eq('no signal → low confidence', 'low', r.confidence);
}
// MMA marker WINS even when a (false) national/team signal is also injected.
eq('MMA marker precedes national', 'MMA', slate.inferPickSport('Ivory Coast fighter ITD', 'Soccer', { inferLegSport: () => null, descNamesNationalTeam: () => true }).sport);
// MMA markers are hardened — near-miss / cross-domain phrases do NOT fire MMA
// (adversarial review). A soccer/golf pick keeps its (fallback) sport.
eq('golf "Round Over 68.5" is NOT MMA', 'Golf', slate.inferPickSport('Rahm Round 1 Over 68.5', 'Golf', noDeps).sport);
eq('prose "split decision" (no "by") is NOT MMA', 'Soccer', slate.inferPickSport('needs a split decision from VAR', 'Soccer', noDeps).sport);
eq('"goes the distance" (no "fight") is NOT MMA', 'Soccer', slate.inferPickSport('Spain goes the distance', 'Soccer', noDeps).sport);
eq('real "by decision" IS MMA', 'MMA', slate.inferPickSport('Jones ML by decision', 'Soccer', noDeps).sport);
eq('real "by split decision" IS MMA', 'MMA', slate.inferPickSport('Fighter by split decision', 'Soccer', noDeps).sport);

// ── C. inferPickSport (REAL ai.js) ──────────────────────────────────────────
console.log('C. inferPickSport — real ai.js integration');
eq('real: Argentina ML → Soccer', 'Soccer', slate.inferPickSport('Argentina ML (-185)', 'Soccer', realDeps).sport);
eq('real: Spain -2.5 → Soccer', 'Soccer', slate.inferPickSport('Spain -2.5 (-110)', 'Soccer', realDeps).sport);
eq('real: Navajo Stirling ITD → MMA', 'MMA', slate.inferPickSport('Navajo Stirling ITD (-105)', 'Soccer', realDeps).sport);
{
  const cr = slate.inferPickSport('Christian Rodriguez ML (-215)', 'Soccer', realDeps);
  eq('real: bare fighter keeps vision sport (documented limitation)', 'Soccer', cr.sport);
  eq('real: bare fighter flagged low-confidence', 'low', cr.confidence);
}

// ── D. detectSheet on Tweet A (the mixed soccer+MMA slate) ───────────────────
console.log('D. detectSheet — Tweet A (12-pick mixed slate)');
{
  const det = slate.detectSheet({ pick: parlay('Soccer', 12), rawText: TWEET_A, deps: realDeps });
  ok('Tweet A is a sheet', det.isSheet === true);
  eq('Tweet A pick count', 12, det.picks.length);
  ok('Tweet A spans ≥2 sports', det.distinctSports >= 2);

  // Headline: the mislabeled straight — units recovered, sport documented.
  const cr = pickBy(det.picks, 'Christian Rodriguez');
  eq('Christian Rodriguez units → 10', 10, cr.units);
  eq('Christian Rodriguez odds → -215', -215, cr.odds);
  eq('Christian Rodriguez description stripped of stake', 'Christian Rodriguez ML (-215)', cr.description);
  eq('Christian Rodriguez sport (documented: keeps vision Soccer, not MMA)', 'Soccer', cr.sport);
  eq('Christian Rodriguez low-confidence', 'low', cr.sportConfidence);

  // Deterministic MMA wins — ITD legs.
  const navajo = pickBy(det.picks, 'Navajo Stirling');
  eq('Navajo Stirling ITD → MMA', 'MMA', navajo.sport);
  eq('Navajo Stirling units → 5', 5, navajo.units);
  const murt = pickBy(det.picks, 'Murtalazi');
  eq('Murtalazi Magomedov ITD → MMA', 'MMA', murt.sport);
  eq('Murtalazi Magomedov units → 3', 3, murt.units);

  // Soccer legs stay soccer with correct stakes.
  const spain = pickBy(det.picks, 'Spain -2.5');
  eq('Spain -2.5 → Soccer', 'Soccer', spain.sport);
  eq('Spain -2.5 units → 5', 5, spain.units);
  const japan = pickBy(det.picks, 'Japan ML');
  eq('Japan ML → Soccer', 'Soccer', japan.sport);
  eq('Japan ML units → 5', 5, japan.units);
  const arg = pickBy(det.picks, 'Argentina');
  eq('Argentina ML → Soccer', 'Soccer', arg.sport);
  eq('Argentina ML units → 5', 5, arg.units);

  // Multi-digit stakes elsewhere parse.
  const kape = pickBy(det.picks, 'Manel Kape');
  eq('Manel Kape units → 10', 10, kape.units);
  eq('Manel Kape sport (bare fighter → vision sport)', 'Soccer', kape.sport);
  const jt = pickBy(det.picks, 'Japan/Tunisia');
  eq('Japan/Tunisia 3u → 3', 3, jt.units);
  eq('Japan/Tunisia → Soccer', 'Soccer', jt.sport);
}

// ── E. detectSheet on Tweet B (4 soccer picks) ───────────────────────────────
console.log('E. detectSheet — Tweet B (4 soccer picks)');
{
  const det = slate.detectSheet({ pick: parlay('Soccer', 4), rawText: TWEET_B, deps: realDeps });
  ok('Tweet B is a sheet', det.isSheet === true);
  eq('Tweet B pick count', 4, det.picks.length);
  ok('Tweet B all Soccer', det.picks.every((p) => p.sport === 'Soccer'));
  ok('Tweet B all 5u', det.picks.every((p) => p.units === 5));
}

// ── F. Mode gating ───────────────────────────────────────────────────────────
console.log('F. mode gating — off / shadow / cutover');
{
  const off = slate.applySlateResplit({ pick: parlay('Soccer', 12), rawText: TWEET_A, mode: 'off', deps: realDeps });
  ok('off → ran:false', off.ran === false);
  ok('off → isSheet:false', off.isSheet === false);

  const events = [];
  const sink = (e) => events.push(e);
  const sh = slate.applySlateResplit({ pick: parlay('Soccer', 12), rawText: TWEET_A, mode: 'shadow', deps: realDeps, recordStageFn: sink, ingestId: 'twit_x', sourceRef: 'x' });
  ok('shadow → NEVER acts (isSheet:false)', sh.isSheet === false);
  eq('shadow → exactly one event', 1, events.length);
  eq('shadow → slate_resplit_shadow', 'slate_resplit_shadow', events[0].eventType);
  eq('shadow → stage SLATE_RESPLIT', 'SLATE_RESPLIT', events[0].stage);
  ok('shadow → wouldSplit true', events[0].payload.wouldSplit === true);
  eq('shadow → pickCount 12', 12, events[0].payload.pickCount);

  // Shadow only measures the candidate population — a single-bet tweet emits nothing.
  const noiseEvents = [];
  slate.applySlateResplit({ pick: { type: 'straight', sport: 'NBA', legs: [{ description: 'Lakers -3.5' }] }, rawText: 'Lakers -3.5 (-110) 5u', mode: 'shadow', deps: realDeps, recordStageFn: (e) => noiseEvents.push(e), ingestId: 'twit_y', sourceRef: 'y' });
  eq('shadow → single bet emits no event', 0, noiseEvents.length);

  const events2 = [];
  const cut = slate.applySlateResplit({ pick: parlay('Soccer', 12), rawText: TWEET_A, mode: 'cutover', deps: realDeps, recordStageFn: (e) => events2.push(e), ingestId: 'twit_x', sourceRef: 'x' });
  ok('cutover → acts (isSheet:true)', cut.isSheet === true);
  eq('cutover → picks 12', 12, cut.picks.length);
  eq('cutover → exactly one event', 1, events2.length);
  eq('cutover → slate_resplit_used', 'slate_resplit_used', events2[0].eventType);
}

// ── G. Negatives — never re-split a genuine straight / single-stake parlay ────
console.log('G. negatives — precision guards');
{
  // A single straight is never a sheet (multiLeg false).
  const single = slate.detectSheet({ pick: { type: 'straight', sport: 'NBA', legs: [{ description: 'Lakers -3.5' }] }, rawText: 'Lakers -3.5 (-110) 5u', deps: realDeps });
  ok('single straight → not a sheet', single.isSheet === false);

  // A real parlay written with ONE ticket stake (only the last segment carries a
  // "Nu" token) is NOT re-split — the per-pick-stake discriminator requires ≥2.
  const realParlay = slate.detectSheet({ pick: parlay('NBA', 3), rawText: 'Lakers -3.5 | Celtics ML | Bucks ML 5u', deps: realDeps });
  ok('single-stake parlay → not a sheet', realParlay.isSheet === false);
  eq('single-stake parlay → only 1 unit-bearing pick', 1, realParlay.unitBearing);

  // A "+"-joined parlay at one stake stays one segment (we split on | / newline).
  const plusParlay = slate.detectSheet({ pick: parlay('NBA', 2), rawText: 'Lakers -3.5 + Celtics ML 5u', deps: realDeps });
  ok('plus-joined parlay → not a sheet', plusParlay.isSheet === false);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nslate-resplit: ${pass} passed, ${fail} failed`);
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) { /* noop */ }
try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) { /* noop */ }
try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) { /* noop */ }
assert.strictEqual(fail, 0, `${fail} assertion(s) failed`);
process.exit(fail === 0 ? 0 : 1);
