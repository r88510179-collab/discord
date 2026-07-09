// ═══════════════════════════════════════════════════════════
// Slate re-split — stats-footer filter (cutover precondition 1).
//
// Spec: docs/BACKLOG.md "SLATE_RESPLIT cutover verdict: STAY SHADOW"
// (2026-07-09 spot-check). Worst FP class: capper ROI/recap footers parsed as
// picks — "Total: +48.7u", "Since Jun 11: -2.87u", "SGP Parlay: -1.6u",
// "Grass Record 72-32 (69%)" — the signed running P&L landing in units
// (u=1.6, 2.87, even 48.7), inflating pickCount into a false wouldSplit.
// Evidence events: twit_2074867391738105896, twit_2074483275452633352,
// twit_2073780065347747969, twit_2074119944707391954, twit_2073408453779812573.
//
// FIXTURES ARE RECONSTRUCTIONS: this test was written with NO DB or fly access,
// so the slate texts below are rebuilt from the footer shapes the BACKLOG entry
// documents verbatim, not pulled from the live pipeline_events payloads.
//
// stripStatsFooter is applied in the SHADOW path ONLY (services/slateResplit.js
// applySlateResplit): it refines what shadow WOULD decide; cutover still
// detects on the raw text, byte-identical to before (asserted below).
//
// Covers:
//   A. isStatsFooterSegment — the documented footer shapes strip (label+signed
//      P&L whole-line, record lines via isNonPickSegment, stake-less link
//      blocks).
//   B. SHOULD_STAY — real pick lines are NEVER classified footer (tightness
//      proof: label-prefixed picks, signed spreads, u-stakes, near-misses).
//   C. stripStatsFooter — pure-function contract: kept text, removedCount,
//      removed lines; splitSegments equivalence.
//   D. Shadow end-to-end on a footer-contaminated slate — pickCount no longer
//      inflated, wouldSplit flips to false, payload records footerStripped /
//      footerRemovedCount / footerRemovedSample.
//   E. SHOULD_STAY end-to-end — a real multi-pick slate (mixed soccer/MMA
//      TWEET_A shape) survives the filter unchanged: same pickCount, same
//      per-pick units/sports, wouldSplit stays true, footerStripped false.
//   F. Shadow-only guarantee — cutover on the SAME contaminated text still
//      sees the footer picks (deliberately unchanged; preconditions are about
//      refining shadow measurement, not touching cutover semantics), and
//      off stays a no-op.
//
// Run:  node tests/slate-resplit-footer-filter.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Throwaway DB — set BEFORE requiring ai.js (which pulls in database.js/migrator)
// so the real prod DB is never opened. slateResplit itself is DB-free; ai.js is
// required only for the REAL inferLegSport / descNamesNationalTeam integration.
const dbFile = path.join(os.tmpdir(), `bettracker-slate-footer-${Date.now()}.db`);
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

// ── Fixtures (reconstructed from the BACKLOG-documented footer shapes) ────────
// The documented FP class: a slate whose FOOTER block carries signed P&L lines.
// One real pick + footer → pre-filter the footer minted 3 phantom picks
// (pickCount 4, wouldSplit true, one at 48.7u); post-filter pickCount 1,
// wouldSplit false.
const FOOTER_BLOCK =
  'Grass Record 72-32 (69%)\n' +
  'Total: +48.7u\n' +
  'Since Jun 11: -2.87u\n' +
  'SGP Parlay: -1.6u';
const FP_SLATE_ONE_PICK =
  'Nuggets/Thunder O 224.5 (-110) 2u\n' + FOOTER_BLOCK;
// Footer under a REAL two-pick slate: wouldSplit stays true either way, but
// pickCount must drop from 5 to 2 and no 48.7u phantom may survive.
const FP_SLATE_TWO_PICKS =
  'Argentina ML (-185) 5u | Spain -2.5 (-110) 5u\n' + FOOTER_BLOCK;
// Footer with a capper-page link block (stake-less → safe to strip).
const LINK_BLOCK = 'Full card 🔒 https://dubclub.win/r/capper\nt.me/capperplays';
// The mixed soccer/MMA slate from tests/slate-resplit.test.js (TWEET_A shape) —
// the module's headline SHOULD_SPLIT case; the filter must not touch it.
const TWEET_A = 'Argentina ML (-185) 5u | Spain -2.5 (-110) 5u | Iran/Belgium 1H "U" 1.5 (-205) 5u | Uruguay/Verde 1H "O" 0.5 (-205) 5u | Egypt/NZ 1H "O" 0.5 (-225) 5u | Japan ML (-165) 5u | Japan/Tunisia 1H "O" 0.5 (-225) 3u | Manel Kape ML (-155) 10u | Navajo Stirling ITD (-105) 5u | Christian Rodriguez ML (-215) 10u | Murtalazi Magomedov ITD (-115) 3u | Vinicius Oliveira ML live (-145) 5u';

function parlay(sport, legCount) {
  return { type: 'parlay', bet_type: 'parlay', sport, legs: Array.from({ length: legCount }, (_, i) => ({ description: `leg ${i}` })) };
}

// ── A. isStatsFooterSegment — documented footer shapes strip ─────────────────
console.log('A. isStatsFooterSegment — footer shapes');
ok('"Total: +48.7u" → footer', slate.isStatsFooterSegment('Total: +48.7u') === true);
ok('"Since Jun 11: -2.87u" → footer', slate.isStatsFooterSegment('Since Jun 11: -2.87u') === true);
ok('"SGP Parlay: -1.6u" → footer', slate.isStatsFooterSegment('SGP Parlay: -1.6u') === true);
ok('"Grass Record 72-32 (69%)" → footer (record shape)', slate.isStatsFooterSegment('Grass Record 72-32 (69%)') === true);
ok('"Last 52 Free Plays 38-14 (73%) +41.4u" → footer', slate.isStatsFooterSegment('Last 52 Free Plays 38-14 (73%) +41.4u') === true);
ok('"Last 30 days: +12.4u" → footer', slate.isStatsFooterSegment('Last 30 days: +12.4u') === true);
ok('"ROI: +8.2u" → footer', slate.isStatsFooterSegment('ROI: +8.2u') === true);
ok('lowercase "total: -3u" → footer', slate.isStatsFooterSegment('total: -3u') === true);
ok('"Total: + 48.7u" (spaced sign) → footer', slate.isStatsFooterSegment('Total: + 48.7u') === true);
ok('"Total: +48.7 units" → footer', slate.isStatsFooterSegment('Total: +48.7 units') === true);
ok('trailing emoji "Total: +48.7u 🔥" → footer', slate.isStatsFooterSegment('Total: +48.7u 🔥') === true);
ok('leading bullet "📊 Total: +48.7u" → footer', slate.isStatsFooterSegment('📊 Total: +48.7u') === true);
ok('"June: +5u" (month label) → footer', slate.isStatsFooterSegment('June: +5u') === true);
ok('stake-less capper link → footer', slate.isStatsFooterSegment('Full card 🔒 https://dubclub.win/r/capper') === true);
ok('stake-less t.me link → footer', slate.isStatsFooterSegment('t.me/capperplays') === true);
ok('empty/nullish → not footer', slate.isStatsFooterSegment('') === false && slate.isStatsFooterSegment(null) === false);

// ── B. SHOULD_STAY — real pick lines are NEVER footer (tightness proof) ──────
console.log('B. isStatsFooterSegment — real picks KEEP');
// Label-prefixed REAL picks: content after the colon is a selection, not a lone
// signed units token.
ok('"Total goals: Over 2.5 (-110) 2u" → pick', slate.isStatsFooterSegment('Total goals: Over 2.5 (-110) 2u') === false);
ok('"Parlay: Lakers ML + Celtics ML (+264) 2u" → pick', slate.isStatsFooterSegment('Parlay: Lakers ML + Celtics ML (+264) 2u') === false);
ok('"Last goalscorer: Haaland +250 2u" → pick', slate.isStatsFooterSegment('Last goalscorer: Haaland +250 2u') === false);
ok('"Record scratch pick: Duke +500 1u" → pick', slate.isStatsFooterSegment('Record scratch pick: Duke +500 1u') === false);
ok('"Free Play: Lakers -3.5 (-110) 5u" → pick', slate.isStatsFooterSegment('Free Play: Lakers -3.5 (-110) 5u') === false);
// Plain pick shapes — unsigned stakes, signed SPREADS, signed odds.
ok('"Nuggets/Thunder O 224.5 (-110) 2u" → pick', slate.isStatsFooterSegment('Nuggets/Thunder O 224.5 (-110) 2u') === false);
ok('"Padres +1.5 (-140) 3u" → pick (signed spread + stake)', slate.isStatsFooterSegment('Padres +1.5 (-140) 3u') === false);
ok('"Switzerland ML (+100) 5u" → pick (signed odds)', slate.isStatsFooterSegment('Switzerland ML (+100) 5u') === false);
ok('"Christian Rodriguez ML (-215) 10u" → pick', slate.isStatsFooterSegment('Christian Rodriguez ML (-215) 10u') === false);
// Near-misses that must KEEP: team labels are NOT in the recap vocab; a bare
// signed u-token with other real content is not whole-line; "totally" ≠ "total".
ok('"Lakers: +6.5u" → KEEP (team label not in vocab)', slate.isStatsFooterSegment('Lakers: +6.5u') === false);
ok('"Totally different: +5u" → KEEP (word-boundary)', slate.isStatsFooterSegment('Totally different: +5u') === false);
ok('"Mayweather: -2.5u" → KEEP ("may" boundary)', slate.isStatsFooterSegment('Mayweather: -2.5u') === false);
ok('"Parlay: +450 2u" → KEEP (odds then unsigned stake)', slate.isStatsFooterSegment('Parlay: +450 2u') === false);
// A pick that embeds a URL AND carries a stake token keeps (unsure → keep).
ok('URL + stake → KEEP', slate.isStatsFooterSegment('Lakers ML 5u write-up: https://example.com/x') === false);

// ── C. stripStatsFooter — pure-function contract ─────────────────────────────
console.log('C. stripStatsFooter — contract');
{
  const r = slate.stripStatsFooter(FP_SLATE_ONE_PICK);
  eq('removes the 4 footer lines', 4, r.removedCount);
  eq('removed[] carries the lines', 4, r.removed.length);
  ok('kept text has the real pick', /Nuggets\/Thunder/.test(r.text));
  ok('kept text has no footer', !/Total:|Since Jun|SGP Parlay|Grass Record/.test(r.text));
  eq('kept text splits to 1 segment', 1, slate.splitSegments(r.text).length);
}
{
  const clean = slate.stripStatsFooter(TWEET_A);
  eq('clean slate: nothing removed', 0, clean.removedCount);
  eq('clean slate: text intact (segments)', 12, slate.splitSegments(clean.text).length);
}
{
  const links = slate.stripStatsFooter('Lakers ML (-110) 5u\n' + LINK_BLOCK);
  eq('link block stripped', 2, links.removedCount);
  ok('pick kept', /Lakers ML/.test(links.text));
}
{
  const empty = slate.stripStatsFooter(null);
  eq('nullish → empty text', '', empty.text);
  eq('nullish → 0 removed', 0, empty.removedCount);
}

// ── D. Shadow end-to-end — the FP class no longer would-split ────────────────
console.log('D. shadow — footer-contaminated slate');
{
  const events = [];
  const sh = slate.applySlateResplit({ pick: parlay('NBA', 4), rawText: FP_SLATE_ONE_PICK, mode: 'shadow', deps: realDeps, recordStageFn: (e) => events.push(e), ingestId: 'twit_fp1', sourceRef: 'fp1' });
  ok('shadow NEVER acts (isSheet:false)', sh.isSheet === false);
  eq('one shadow event', 1, events.length);
  const p = events[0].payload;
  eq('pickCount excludes footer lines', 1, p.pickCount);
  ok('wouldSplit false (1 real pick)', p.wouldSplit === false);
  ok('no 48.7u phantom in sample', !p.sample.some((s) => s.u === 48.7));
  ok('footerStripped recorded', p.footerStripped === true);
  eq('footerRemovedCount 4', 4, p.footerRemovedCount);
  ok('footerRemovedSample carries footer lines', p.footerRemovedSample.some((s) => /Total: \+48\.7u/.test(s)));
  ok('sample has no footer line', !p.sample.some((s) => /Total:|Since Jun|SGP/.test(s.d || '')));
}
{
  // Footer under a REAL two-pick slate: still a would-split, but the counts are
  // no longer contaminated.
  const events = [];
  slate.applySlateResplit({ pick: parlay('Soccer', 5), rawText: FP_SLATE_TWO_PICKS, mode: 'shadow', deps: realDeps, recordStageFn: (e) => events.push(e), ingestId: 'twit_fp2', sourceRef: 'fp2' });
  const p = events[0].payload;
  eq('pickCount = 2 real picks', 2, p.pickCount);
  ok('wouldSplit true (2 real picks)', p.wouldSplit === true);
  ok('no phantom units survive', !p.sample.some((s) => s.u === 48.7 || s.u === 2.87 || s.u === 1.6));
  eq('footerRemovedCount 4', 4, p.footerRemovedCount);
}

// ── E. SHOULD_STAY end-to-end — real multi-pick slate unchanged ──────────────
console.log('E. shadow — real slate survives the filter unchanged');
{
  const events = [];
  slate.applySlateResplit({ pick: parlay('Soccer', 12), rawText: TWEET_A, mode: 'shadow', deps: realDeps, recordStageFn: (e) => events.push(e), ingestId: 'twit_a', sourceRef: 'a' });
  const p = events[0].payload;
  eq('pickCount still 12', 12, p.pickCount);
  ok('wouldSplit still true', p.wouldSplit === true);
  ok('footerStripped false', p.footerStripped === false);
  eq('footerRemovedCount 0', 0, p.footerRemovedCount);
  // Per-pick recovery identical to the unfiltered detection.
  const det = slate.detectSheet({ pick: parlay('Soccer', 12), rawText: TWEET_A, deps: realDeps });
  eq('detection over raw text agrees (12 picks)', 12, det.picks.length);
  ok('Christian Rodriguez 10u survives', det.picks.some((x) => /Christian Rodriguez/.test(x.description) && x.units === 10));
  ok('ITD → MMA survives', det.picks.some((x) => /Navajo Stirling/.test(x.description) && x.sport === 'MMA'));
}

// ── F. Shadow-only guarantee — cutover and off are byte-identical ────────────
console.log('F. shadow-only — cutover/off untouched');
{
  // Cutover on the SAME contaminated text still counts the footer picks — the
  // pre-existing (documented) FP behavior, DELIBERATELY unchanged: precondition
  // 1 refines shadow measurement only; cutover semantics are out of scope, and
  // SLATE_RESPLIT_MODE stays shadow in prod until all preconditions pass.
  const events = [];
  const cut = slate.applySlateResplit({ pick: parlay('NBA', 4), rawText: FP_SLATE_ONE_PICK, mode: 'cutover', deps: realDeps, recordStageFn: (e) => events.push(e), ingestId: 'twit_fp1', sourceRef: 'fp1' });
  ok('cutover still sees footer picks (unchanged)', cut.picks.length === 4);
  ok('cutover still would act (isSheet:true, unchanged)', cut.isSheet === true);
  eq('cutover event type unchanged', 'slate_resplit_used', events[0].eventType);

  const off = slate.applySlateResplit({ pick: parlay('NBA', 4), rawText: FP_SLATE_ONE_PICK, mode: 'off', deps: realDeps });
  ok('off → no-op', off.ran === false && off.isSheet === false);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nslate-resplit-footer-filter: ${pass} passed, ${fail} failed`);
try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) { /* noop */ }
try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) { /* noop */ }
try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) { /* noop */ }
assert.strictEqual(fail, 0, `${fail} assertion(s) failed`);
process.exit(fail === 0 ? 0 : 1);
