// ═══════════════════════════════════════════════════════════
// event_date write-time SANITY GUARD — GAP-ONLY.
//
// normalizeEventDateForStorage parses the extractor's event_date, but the
// vision model occasionally emits a real-but-stale datetime (a prior-year
// tournament fixture, e.g. "Japan vs Sweden" → 2023-11-26 on a 2026 bet).
// Such values PARSE cleanly and are then trusted event_date-first by the
// grader/search/ESPN paths → wrong-year (mis)grading.
//
// The guard NULLs (never throws) a parsed datetime that is implausibly far
// from created_at, so the bet still saves and falls back to created_at:
//   gap < -2 days OR > +60 days.
//
// ONE rule, by gap ONLY — there is deliberately NO cross-year / calendar-year
// rule. The gap bounds already null every wrong-year fixture (all are hundreds
// of days off), and a year rule would ALSO null legitimate same-week Dec→Jan
// bets days apart (bowls / NFL Wk18 / NBA) — which MUST be preserved. The
// "Dec→Jan PRESERVED" case (§4 below) locks that in; it was NULLed by #153's
// since-removed cross-year rule.
//
// Bounds are derived from the live distribution: every legit bet is -1..+8d;
// every corrupt value is 354..9131d off.
//
// RED-proof: `git stash push -- services/eventDate.js` (reverts to the
// pre-guard normalizer) then `node tests/event-date-guard.test.js` — every
// "stores NULL" case below FAILS because the garbage passes through. Restore
// and it goes green.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB. Must be set BEFORE requiring services/database.js.
const DB_PATH = path.join(os.tmpdir(), `bet-event-date-guard-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

const { normalizeEventDateForStorage } = require('../services/eventDate');
const { db, createBet } = require('../services/database');

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

// Assert a raw value is NULLed by the guard, anchored to `created`.
function expectNull(label, raw, created) {
  const got = normalizeEventDateForStorage(raw, new Date(created));
  check(label, got === null, `expected null, got ${JSON.stringify(got)}`);
}
// Assert a raw value is PRESERVED (returns the same instant's ISO).
function expectPreserve(label, raw, created, expectedIso) {
  const got = normalizeEventDateForStorage(raw, new Date(created));
  check(label, got === expectedIso, `expected ${expectedIso}, got ${JSON.stringify(got)}`);
}

// ── 1. Real-data garbage → NULL ─────────────────────────────
// Each of these is a valid-but-implausible datetime that parses cleanly and,
// pre-guard, would be stored verbatim and trusted by the grader.
console.log('garbage values store NULL:');

// -354d (event ~a year before created) — caught by the gap bound, no year rule.
expectNull('-354d prior-year fixture NULLed by gap bound', '2025-07-06T12:00:00.000Z', '2026-06-25T12:00:00Z');
// -942d, "Japan vs Sweden" 2023 World-Cup fixture on a 2026 bet (real: e2feed30).
expectNull('"Japan vs Sweden" 2023 (-942d) NULLed', '2023-11-26T19:00:00.000Z', '2026-06-25T12:00:00Z');
// -9131d, 2001 NCAAM (real: 5a56c9bf "Michigan vs Arizona Over 157.5").
expectNull('2001 NCAAM (-9131d) NULLed', '2001-04-04T12:00:00.000Z', '2026-04-04T12:00:00Z');
// Synthetic WITHIN-YEAR staleness — same calendar year so only bound (b) can
// fire (rule (a) is inert), exercising the gap backstop in isolation.
expectNull('within-year +120d NULLed by bound (b)', '2026-06-01T12:00:00.000Z', '2026-02-01T12:00:00Z');
expectNull('within-year -10d NULLed by bound (b)', '2026-06-10T12:00:00.000Z', '2026-06-20T12:00:00Z');

// ── 2. Legit values → PRESERVED ─────────────────────────────
console.log('legit values pass through unchanged:');

// +8d = the real maximum forward gap in live data (a golf futures).
expectPreserve('+8d golf futures preserved', '2026-04-20T12:00:00.000Z', '2026-04-12T12:00:00Z', '2026-04-20T12:00:00.000Z');
expectPreserve('+7d preserved', '2026-04-19T12:00:00.000Z', '2026-04-12T12:00:00Z', '2026-04-19T12:00:00.000Z');
// -1d = the timezone slice artifact (the only legit negative).
expectPreserve('-1d timezone artifact preserved', '2026-06-19T12:00:00.000Z', '2026-06-20T12:00:00Z', '2026-06-19T12:00:00.000Z');
// 0d = same-day (a game on the day the bet was placed).
expectPreserve('0d same-day preserved', '2026-06-20T19:00:00.000Z', '2026-06-20T12:00:00Z', '2026-06-20T19:00:00.000Z');

// ── 3. Boundary precision (rules are < -2 and > +60, inclusive endpoints) ──
console.log('boundary precision:');

expectPreserve('exactly -2d preserved (boundary inclusive)', '2026-06-18T12:00:00.000Z', '2026-06-20T12:00:00Z', '2026-06-18T12:00:00.000Z');
expectNull('-2.04d NULLed (just past lower bound)', '2026-06-18T11:00:00.000Z', '2026-06-20T12:00:00Z');
expectPreserve('exactly +60d preserved (boundary inclusive)', '2026-03-02T12:00:00.000Z', '2026-01-01T12:00:00Z', '2026-03-02T12:00:00.000Z');
expectNull('+60.04d NULLed (just past upper bound)', '2026-03-02T13:00:00.000Z', '2026-01-01T12:00:00Z');

// ── 4. Cross-year PRESERVED (anti-regression) ───────────────
// A New-Year's-boundary bet (created late Dec, game early Jan — bowls / NFL
// Wk18 / NBA) is cross-year but only ~1 day apart, so the gap bound keeps it.
// Gap-only by design: this LOCKS OUT any re-introduction of a year rule (which
// would wrongly NULL this legit value). #153's cross-year rule NULLed it; the
// gap-only guard PRESERVES it.
console.log('cross-year Dec→Jan PRESERVED (anti-regression):');
expectPreserve('Dec-31 bet on Jan-1 game PRESERVED (+1.1d, gap-only)', '2027-01-01T20:00:00.000Z', '2026-12-31T18:00:00Z', '2027-01-01T20:00:00.000Z');
// Backward cross-year too: a Jan-1 bet on a Dec-31 PRIOR-year game (-1d, a
// next-morning recap/timezone-slice post) was NULLed by the year rule, now
// preserved — same -2d window the guard already allows within-year. Locks the
// other edge of the behavior-change set so a forward-only year exemption fails.
expectPreserve('Jan-1 bet on Dec-31 prior-year game PRESERVED (-1d, gap-only)', '2025-12-31T20:00:00.000Z', '2026-01-01T18:00:00Z', '2025-12-31T20:00:00.000Z');

// ── 5. No usable anchor → preserve (the guard needs both dates) ──
console.log('no-anchor preservation:');
check(
  'invalid created_at anchor preserves the parsed value (cannot compare)',
  normalizeEventDateForStorage('2023-11-26T19:00:00.000Z', 'not-a-date') === '2023-11-26T19:00:00.000Z',
  `got ${JSON.stringify(normalizeEventDateForStorage('2023-11-26T19:00:00.000Z', 'not-a-date'))}`,
);

// ── 6. Default anchor (now) — the production call passes no createdAt ──
console.log('default-anchor (now) guarding:');
check(
  'garbage 2001 date NULLed against default now-anchor',
  normalizeEventDateForStorage('2001-04-04T12:00:00.000Z') === null,
);

// ── 7. Existing parse branches still resolve (guard does not over-clip) ──
console.log('existing parse branches survive the guard:');
expectPreserve(
  'time-only "9:10PM ET" still resolves on created_at day',
  '9:10PM ET', '2026-06-01T12:00:00Z', '2026-06-02T01:10:00.000Z',
);

// ── 8. Warn log carries betId + rejected value + which rule ─────
console.log('warn log:');
{
  let captured = '';
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { captured += String(chunk); return realErr(chunk, ...rest); };
  try {
    normalizeEventDateForStorage('2023-11-26T19:00:00.000Z', new Date('2026-06-25T12:00:00Z'), { betId: 'TESTBET123' });
  } finally {
    process.stderr.write = realErr;
  }
  check(
    'warn log includes bet id, rejected value, gapDays and rule',
    /implausible event_date NULLed bet=TESTBET123/.test(captured)
      && /value=2023-11-26T19:00:00\.000Z/.test(captured)
      && /gapDays=/.test(captured)
      && /rule=out-of-bounds/.test(captured),
    `captured: ${captured.replace(/\n/g, ' ').slice(0, 200)}`,
  );
}

// ── 9. End-to-end createBet write path (DEPLOY_CHECKLIST step 2 wiring) ──
console.log('createBet write path:');
db.prepare('INSERT OR REPLACE INTO cappers (id, display_name) VALUES (?, ?)').run('capper-evg', 'Event Date Guard Capper');

function storedEventDate(desc, eventDate) {
  const bet = createBet({
    capper_id: 'capper-evg', sport: 'NBA', bet_type: 'straight',
    description: desc, source: 'manual', event_date: eventDate,
  });
  return db.prepare('SELECT event_date FROM bets WHERE id = ?').get(bet.id);
}

// created_at defaults to now (~2026); a 2001 event is decades out of bounds → guard NULLs.
const garbageRow = storedEventDate('Lakers ML -110 evg-garbage', '2001-04-04T12:00:00.000Z');
check('out-of-bounds event_date stored as NULL through createBet', garbageRow.event_date === null, `stored="${garbageRow.event_date}"`);

// A near-now event (same year, +1d) survives the guard end-to-end.
const nearIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const goodRow = storedEventDate('Celtics ML -110 evg-good', nearIso);
check('plausible near-now event_date preserved through createBet', goodRow.event_date === nearIso, `stored="${goodRow.event_date}"`);

// ── teardown ────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
