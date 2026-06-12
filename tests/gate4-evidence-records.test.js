// ═══════════════════════════════════════════════════════════
// Gate 4 precondition — the dated evidence-record layer
// (services/evidenceRecords.js).
//
// Pure module: NO DB, NO env. Asserts:
//   - extractDates over every supported format, HTML noise, year-less
//     resolution (anchor year + the >300d-future wrap), and garbage → empty.
//   - buildEvidenceRecords char spans + per-record dates, including the
//     1500-char truncation boundary.
//   - BYTE-IDENTITY: the record layer's view of the assembled evidence string
//     is byte-for-byte the string services/grading.js hands the model, and
//     consuming the layer never mutates it. (rule 4 — the Gate 3 quote contract
//     depends on that string being unchanged.)
// ═══════════════════════════════════════════════════════════

const assert = require('assert');
const {
  extractDates,
  assembleEvidenceText,
  buildEvidenceRecords,
  isWithinWindow,
  evaluateOffDate,
} = require('../services/evidenceRecords');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}
function eq(label, got, exp) {
  check(label, JSON.stringify(got) === JSON.stringify(exp), `got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`);
}

console.log('gate4-evidence-records (Gate 4 precondition):');

const A = '2026-06-11'; // incident anchor

// ── extractDates: formats ──
eq('ISO YYYY-MM-DD', extractDates('final 2026-06-06 per box', A), ['2026-06-06']);
eq('Month D, YYYY (full)', extractDates('Played June 6, 2026 in Philly', A), ['2026-06-06']);
eq('Mon D, YYYY (3-letter)', extractDates('Jun 6, 2026 FT', A), ['2026-06-06']);
eq('Sep/Sept/September all resolve', extractDates('Sep 1, 2026 / Sept 2, 2026 / September 3, 2026', A),
  ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('Month D YYYY without comma (HTML spacing)', extractDates('June 6 2026', A), ['2026-06-06']);
eq('M/D/YYYY', extractDates('on 6/6/2026', A), ['2026-06-06']);
eq('M/D/YY → 20YY', extractDates('on 6/6/26', A), ['2026-06-06']);
eq('day suffix (6th)', extractDates('June 6th, 2026', A), ['2026-06-06']);

// ── extractDates: HTML noise ──
eq('HTML around date + quote (incident shape)',
  extractDates('June 6, 2026 — FT USMNT <strong>1-2 Germany</strong> per ESPN', A), ['2026-06-06']);
eq('HTML tags INSIDE the date tokens',
  extractDates('Kickoff June <strong>6</strong>, 2026', A), ['2026-06-06']);
eq('score with dash is not a date', extractDates('FT 1-2 Germany', A), []);

// ── extractDates: year-less resolution ──
eq('year-less → anchor year', extractDates('Opener kicks off June 12 tonight', A), ['2026-06-12']);
eq('year-less wrap: Feb anchor + Dec date → prior year',
  extractDates('the Dec 20 classic', '2026-02-01'), ['2025-12-20']);
eq('year-less FORWARD wrap: Dec anchor + Jan date → next year',
  extractDates('rematch January 5', '2026-12-30'), ['2027-01-05']);
eq('year-less FORWARD wrap end-to-end: real Jan-1 game at Dec-31 anchor',
  extractDates('final January 1', '2026-12-31'), ['2027-01-01']);
eq('year-less near-future stays anchor year',
  extractDates('Dec 20 game', '2026-06-11'), ['2026-12-20']);

// ── extractDates: garbage / invalid ──
eq('garbage → empty', extractDates('no calendar dates here, just words', A), []);
eq('impossible day rejected (Feb 30)', extractDates('Feb 30, 2026', A), []);
eq('impossible M/D rejected (13/45)', extractDates('13/45/2026', A), []);
eq('impossible ISO rejected (month 13)', extractDates('2026-13-40', A), []);
eq('3-digit "year" in M/D/YY rejected (6/6/206 → never a date)', extractDates('ref 6/6/206 box', A), []);
eq('sub-1900 year rejected, valid 4-digit kept', extractDates('old 6/6/1850, new 2099-06-06', A), ['2099-06-06']);
eq('empty / null in → empty out', extractDates('', A), []);
eq('null text → empty', extractDates(null, A), []);

// ── extractDates: dedup + sort ──
eq('dedup + sort across formats',
  extractDates('June 12 and 2026-06-06 and Jun 12, 2026 and 6/6/2026', A),
  ['2026-06-06', '2026-06-12']);

// ── isWithinWindow ──
check('window: inside (+1 of anchor)', isWithinWindow('2026-06-12', A, 1) === true);
check('window: boundary (−1 of anchor, inclusive)', isWithinWindow('2026-06-10', A, 1) === true);
check('window: outside (−5)', isWithinWindow('2026-06-06', A, 1) === false);
check('window: tol 0 same day', isWithinWindow('2026-06-11', A, 0) === true);
check('window: bad date → false', isWithinWindow('not-a-date', A, 1) === false);

// ── buildEvidenceRecords: char spans + dates ──
const SR = [
  { title: 'USA vs Germany friendly — June 6, 2026', snippet: 'FT USMNT <strong>1-2 Germany</strong> per ESPN' },
  { title: 'USA vs Paraguay preview', snippet: 'Kickoff 2026-06-12, World Cup opener' },
  { title: '', snippet: 'orphan snippet line for 2026-06-12' }, // title falsy → only snippet line
];
const full = assembleEvidenceText(SR);
const evidenceForModel = full.slice(0, 1500);
const recs = buildEvidenceRecords(SR, evidenceForModel, A, { defaultBackend: 'chain' });

eq('one record per hit', recs.length, SR.length);
eq('rec0 dates (from title)', recs[0].dates, ['2026-06-06']);
eq('rec1 dates (ISO in snippet)', recs[1].dates, ['2026-06-12']);
eq('rec2 dates (snippet-only hit)', recs[2].dates, ['2026-06-12']);
check('rec0 span slices back to its own visible footprint',
  evidenceForModel.slice(recs[0].char_start, recs[0].char_end) === recs[0].snippet);
check('rec1 span slices back to its own visible footprint',
  evidenceForModel.slice(recs[1].char_start, recs[1].char_end) === recs[1].snippet);
check('rec0 footprint contains both its title and snippet text',
  recs[0].snippet.includes('June 6, 2026') && recs[0].snippet.includes('<strong>1-2 Germany</strong>'));
check('defaultBackend applied when hit carries none', recs[0].backend === 'chain');
check('scope stub present (TODO Gate 5)', recs.every(r => r.scope === null));
check('url/domain default null when unavailable', recs.every(r => r.url === null && r.domain === null));

// ── buildEvidenceRecords: 1500-char truncation boundary ──
const longSnippet = 'x'.repeat(1490) + ' tail 2026-06-06 tail';
const SRtrunc = [
  { title: 'A', snippet: longSnippet },                 // spills past 1500
  { title: 'B', snippet: 'second hit dated 2026-06-06' }, // entirely beyond 1500
];
const fullT = assembleEvidenceText(SRtrunc);
const evT = fullT.slice(0, 1500);
const recsT = buildEvidenceRecords(SRtrunc, evT, A, {});
check('truncated string is exactly 1500 chars', evT.length === 1500);
check('hit beyond 1500 collapses to empty visible span', recsT[1].char_start === recsT[1].char_end);
check('hit beyond 1500 has empty snippet + no dates', recsT[1].snippet === '' && recsT[1].dates.length === 0);
check('all spans stay within [0,1500]', recsT.every(r => r.char_start >= 0 && r.char_end <= 1500 && r.char_start <= r.char_end));

// ── buildEvidenceRecords: non-string-but-truthy title must not NaN-cascade ──
// (a non-string title would otherwise make ln.text.length undefined → NaN spans
// for THAT record and every record after it, silently disabling Gate 4.)
const SRnonstr = [
  { title: 12345, snippet: 'game dated 2026-06-06' }, // numeric title
  { title: 'Real Title', snippet: 'final on 2026-06-12' },
];
const evNon = assembleEvidenceText(SRnonstr).slice(0, 1500);
const recsNon = buildEvidenceRecords(SRnonstr, evNon, A, {});
check('non-string title: all offsets finite (no NaN cascade)',
  recsNon.every(r => Number.isFinite(r.char_start) && Number.isFinite(r.char_end)));
eq('non-string title: LATER record still date-checked', recsNon[1].dates, ['2026-06-12']);
check('non-string title: spans still reconstruct from evidenceForModel',
  evNon.slice(recsNon[0].char_start, recsNon[0].char_end) === recsNon[0].snippet);

// ── BYTE-IDENTITY (rule 4) ──
// The string the model is handed must be byte-identical pre/post the record
// layer. "Pre" = the exact services/grading.js assembly loop, reproduced inline
// here. "Post" = assembleEvidenceText (the layer's source-of-truth for that
// algorithm) AND the act of building records over it.
function assembleLikeCallSite(searchResults) {
  // VERBATIM copy of services/grading.js evidence assembly (the `snippets` loop
  // + slice). If grading.js changes this, this test must change with it.
  const snippets = [];
  for (const r of searchResults) {
    if (r.title) snippets.push(r.title);
    if (r.snippet) snippets.push(`  ${r.snippet}`);
  }
  return snippets.join('\n');
}
const FIXTURES = [
  SR,
  SRtrunc,
  [{ title: 'only title' }],
  [{ snippet: 'only snippet' }],
  [{ title: 'curly “quotes” and – dashes', snippet: 'unicode é, ñ, 中文' }],
  [{ title: 67890, snippet: 'numeric title coerced like the call-site join' }],
  [],
];
let byteOk = true;
for (const fx of FIXTURES) {
  const expected = assembleLikeCallSite(fx);
  const got = assembleEvidenceText(fx);
  if (got !== expected) { byteOk = false; console.log(`    byte-identity MISMATCH for ${JSON.stringify(fx).slice(0, 60)}`); }
  // building records must not mutate the model-visible string
  const before = expected.slice(0, 1500);
  const snapshot = String(before);
  buildEvidenceRecords(fx, before, A, {});
  if (before !== snapshot) { byteOk = false; console.log('    record build mutated evidenceForModel'); }
}
check('byte-identity: assembleEvidenceText === call-site assembly for all fixtures, build is non-mutating', byteOk);
// Belt-and-suspenders direct assertion the suite fails loudly on regression.
assert.strictEqual(assembleEvidenceText(SR), assembleLikeCallSite(SR), 'evidence assembly drifted from grading.js');

// ── evaluateOffDate: the three outcomes + multi-date union ──
const norm = s => String(s == null ? '' : s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase(); // mirror of normalizeQuoteWhitespace

eq('off_date: quote record dated outside window',
  evaluateOffDate(recs, 'FT USMNT <strong>1-2 Germany</strong>', A, 1, norm).status, 'off_date');
eq('date_ok: quote record dated inside window',
  evaluateOffDate(recs, 'Kickoff 2026-06-12, World Cup opener', A, 1, norm).status, 'date_ok');
eq('no_date_signal: quote not located in any record',
  evaluateOffDate(recs, 'a quote that appears nowhere', A, 1, norm).status, 'no_date_signal');
eq('no_date_signal: quote record carries no extractable date',
  evaluateOffDate(
    [{ idx: 0, snippet: 'Lakers beat Nuggets 118-112 (no date here)', dates: [] }],
    'Lakers beat Nuggets 118-112', A, 1, norm).status, 'no_date_signal');
// multi-date union: a quote record with one in-window date passes even if it also
// carries an out-of-window date.
eq('multi-date union: any-in-window → date_ok',
  evaluateOffDate(
    [{ idx: 0, snippet: 'recap', dates: ['2026-06-06', '2026-06-12'] }],
    'recap', A, 1, norm).status, 'date_ok');

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('Gate 4 evidence-record layer validation passed.');
