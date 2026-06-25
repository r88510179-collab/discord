// ═══════════════════════════════════════════════════════════
// event_date validation — write-time gate + grader skew fallback.
//
// Live failure (specimens b24aedaf "9:10PM ET", 3a503cc4 "3:00 PM ET"):
// a time-only string stored in bets.event_date re-anchors to "today" on
// every grading poll, so the event sits hours in the future forever and
// the bet returns "Event was -X.Xh ago — too soon to grade" until its
// attempts burn to quarantine.
//
// Covers:
//   1. normalizeEventDateForStorage unit cases (both specimen strings,
//      a valid datetime, garbage)
//   2. createBet write path — stored event_date is NULL or parseable
//   3. migration 029 nulls pre-existing unparseable rows
//   4. grader read-side: future-skewed event_date falls back to
//      created_at with the grade.event_date_skew_fallback marker
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB. Must be set BEFORE requiring services/database.js.
const DB_PATH = path.join(os.tmpdir(), `bet-event-date-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

const { normalizeEventDateForStorage } = require('../services/eventDate');
const { db, createBet } = require('../services/database');
const { gradePropWithAI } = require('../services/grading');

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

// ── 1. Storage normalizer unit cases ────────────────────────
console.log('normalizeEventDateForStorage:');

// Specimen 1 (bet b24aedaf): time-only, EDT anchor. created_at noon UTC
// Jun 1 = 8:00AM ET → 9:10PM ET that day = 01:10 UTC Jun 2.
check(
  'specimen "9:10PM ET" resolves on created_at ET date (EDT)',
  normalizeEventDateForStorage('9:10PM ET', new Date('2026-06-01T12:00:00Z')) === '2026-06-02T01:10:00.000Z',
  `got ${normalizeEventDateForStorage('9:10PM ET', new Date('2026-06-01T12:00:00Z'))}`,
);

// Specimen 2 (bet 3a503cc4): time-only with space, EST anchor.
check(
  'specimen "3:00 PM ET" resolves on created_at ET date (EST)',
  normalizeEventDateForStorage('3:00 PM ET', new Date('2026-01-15T12:00:00Z')) === '2026-01-15T20:00:00.000Z',
  `got ${normalizeEventDateForStorage('3:00 PM ET', new Date('2026-01-15T12:00:00Z'))}`,
);

// created_at just after UTC midnight is still the previous day in ET —
// the time must resolve against the ET calendar date, not the UTC one.
check(
  'UTC/ET date rollover uses the ET calendar date',
  normalizeEventDateForStorage('9:10PM ET', new Date('2026-06-02T02:00:00Z')) === '2026-06-02T01:10:00.000Z',
  `got ${normalizeEventDateForStorage('9:10PM ET', new Date('2026-06-02T02:00:00Z'))}`,
);

check(
  'weekday-prefixed time ("THU 6:29AM ET") resolves on created_at ET date',
  normalizeEventDateForStorage('THU 6:29AM ET', new Date('2026-06-01T12:00:00Z')) === '2026-06-01T10:29:00.000Z',
  `got ${normalizeEventDateForStorage('THU 6:29AM ET', new Date('2026-06-01T12:00:00Z'))}`,
);

check(
  'valid ISO datetime passes through (same instant)',
  normalizeEventDateForStorage('2026-04-12T17:00:00.000Z', new Date('2026-04-01T12:00:00Z')) === '2026-04-12T17:00:00.000Z',
  `got ${normalizeEventDateForStorage('2026-04-12T17:00:00.000Z', new Date('2026-04-01T12:00:00Z'))}`,
);

check(
  'sportsbook "Thu Apr 2 @ 10:30pm" anchors to created_at year, ET wall clock',
  normalizeEventDateForStorage('Thu Apr 2 @ 10:30pm', new Date('2026-04-01T12:00:00Z')) === '2026-04-03T02:30:00.000Z',
  `got ${normalizeEventDateForStorage('Thu Apr 2 @ 10:30pm', new Date('2026-04-01T12:00:00Z'))}`,
);

check(
  '"4/12/26 5:00 PM" parses as ET wall clock',
  normalizeEventDateForStorage('4/12/26 5:00 PM', new Date('2026-04-01T12:00:00Z')) === '2026-04-12T21:00:00.000Z',
  `got ${normalizeEventDateForStorage('4/12/26 5:00 PM', new Date('2026-04-01T12:00:00Z'))}`,
);

check(
  'garbage string stores NULL — never the raw string',
  normalizeEventDateForStorage('vs Yankees tonight, hammer it', new Date()) === null,
);

check('null stays null', normalizeEventDateForStorage(null) === null);
check('empty string stores NULL', normalizeEventDateForStorage('   ') === null);

// ── 2. createBet write path ─────────────────────────────────
console.log('createBet write gate:');

db.prepare('INSERT OR REPLACE INTO cappers (id, display_name) VALUES (?, ?)').run('capper-evd', 'Event Date Capper');

function storedEventDate(desc, eventDate) {
  const bet = createBet({
    capper_id: 'capper-evd', sport: 'NBA', bet_type: 'straight',
    description: desc, source: 'manual', event_date: eventDate,
  });
  return db.prepare('SELECT event_date, datetime(event_date) AS parsed FROM bets WHERE id = ?').get(bet.id);
}

const poisoned = storedEventDate('Lakers ML -110 evd-poison', '9:10PM ET');
check(
  'time-only input stores a SQLite-parseable datetime, not the raw string',
  poisoned.event_date !== '9:10PM ET' && poisoned.parsed !== null,
  `stored="${poisoned.event_date}" parsed=${poisoned.parsed}`,
);

const junk = storedEventDate('Celtics ML -110 evd-junk', 'sometime tonight??');
check('garbage input stores NULL', junk.event_date === null, `stored="${junk.event_date}"`);

// createBet anchors the write-time sanity guard on created_at = now, so the
// fixture event_date must sit within the guard's plausible window (a fixed
// far-past date would be NULLed once `now` drifts >60d past it). Use a
// near-now instant; assert exact round-trip + SQLite-parseability.
const ISO_EVENT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const ISO_EVENT_PARSED = `${ISO_EVENT.slice(0, 10)} ${ISO_EVENT.slice(11, 19)}`;
const iso = storedEventDate('Knicks ML -110 evd-iso', ISO_EVENT);
check(
  'valid datetime input stays a parseable datetime at the same instant',
  iso.event_date === ISO_EVENT && iso.parsed === ISO_EVENT_PARSED,
  `stored="${iso.event_date}" parsed=${iso.parsed}`,
);

// ── 3. Migration 029 nulls pre-existing unparseable rows ────
console.log('migration 029:');

// Simulate legacy rows written before the gate (bypass createBet).
db.prepare("UPDATE bets SET event_date = '3:00 PM ET' WHERE description LIKE '%evd-poison%'").run();
db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '029_null_unparseable_event_dates.sql'), 'utf8'));
const afterMig = db.prepare("SELECT event_date FROM bets WHERE description LIKE '%evd-poison%'").get();
const isoAfterMig = db.prepare("SELECT event_date FROM bets WHERE description LIKE '%evd-iso%'").get();
check('time-only legacy row nulled', afterMig.event_date === null, `got "${afterMig.event_date}"`);
check('valid ISO row untouched', isoAfterMig.event_date === ISO_EVENT, `got "${isoAfterMig.event_date}"`);

// ── 4. Grader read-side skew fallback ───────────────────────
console.log('grader skew fallback:');

let captured = '';
const realWrite = process.stdout.write.bind(process.stdout);
function startCapture() {
  process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return realWrite(chunk, ...rest); };
}
function stopCapture() { process.stdout.write = realWrite; }

// Pin the clock so "30 minutes in the future, same UTC day" is deterministic
// regardless of when the suite runs. Date subclass keeps instanceof intact.
const RealDate = global.Date;
const FIXED_NOW = RealDate.parse('2026-06-01T12:00:00Z');
class FakeDate extends RealDate {
  constructor(...args) { args.length ? super(...args) : super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
}

(async () => {
  // Bet whose event_date sits 0.5h in the future (beyond the -0.25h skew
  // tolerance) on the same UTC day, with created_at 1h in the past. The
  // fallback should re-date from created_at and land in the normal
  // TOO_RECENT window with POSITIVE hours.
  db.prepare(
    `INSERT OR REPLACE INTO bets (id, capper_id, sport, bet_type, description, event_date, created_at, result)
     VALUES ('bet-evd-skew', 'capper-evd', 'NBA', 'straight', 'Lakers ML -110', '2026-06-01T12:30:00.000Z', '2026-06-01T11:00:00.000Z', 'pending')`,
  ).run();
  // Control: valid event_date 2h in the past must NOT trigger the fallback.
  db.prepare(
    `INSERT OR REPLACE INTO bets (id, capper_id, sport, bet_type, description, event_date, created_at, result)
     VALUES ('bet-evd-valid', 'capper-evd', 'NBA', 'straight', 'Lakers ML -110', '2026-06-01T10:00:00.000Z', '2026-06-01T09:00:00.000Z', 'pending')`,
  ).run();

  const skewBet = db.prepare("SELECT * FROM bets WHERE id = 'bet-evd-skew'").get();
  const validBet = db.prepare("SELECT * FROM bets WHERE id = 'bet-evd-valid'").get();

  let skewResult, validResult;
  global.Date = FakeDate;
  startCapture();
  try {
    skewResult = await gradePropWithAI(skewBet);
    validResult = await gradePropWithAI(validBet);
  } finally {
    stopCapture();
    global.Date = RealDate;
  }

  check(
    'future-skewed event_date no longer yields negative-hours "too soon"',
    skewResult && skewResult.status === 'PENDING' && /Event was 1\.0h ago/.test(skewResult.evidence || ''),
    `result=${JSON.stringify(skewResult)}`,
  );
  check(
    'skew fallback emits grade.event_date_skew_fallback with betId',
    /grade\.event_date_skew_fallback[^\n]*betId=bet-evd-skew/.test(captured),
    'marker missing from stdout',
  );
  check(
    'valid past event_date does not trigger the fallback',
    validResult && validResult.status === 'PENDING' && /Event was 2\.0h ago/.test(validResult.evidence || '')
      && !/grade\.event_date_skew_fallback[^\n]*betId=bet-evd-valid/.test(captured),
    `result=${JSON.stringify(validResult)}`,
  );

  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  stopCapture();
  global.Date = RealDate;
  console.error('test crashed:', err);
  process.exit(2);
});
