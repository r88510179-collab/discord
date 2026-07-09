// ═══════════════════════════════════════════════════════════
// EVENT_DATE_SANITY_MODE — telemetry-gate matrix over the write-time
// sanity guard (services/eventDate.js + services/database.js createBet).
//
// The guard's NULLing is ALWAYS-ON (#153/#154, live prod) — this flag gates
// ONLY the event_date_sanity_rejected pipeline event. The matrix below
// therefore asserts two invariants per mode:
//   1. STORAGE IS MODE-INVARIANT: off/shadow/enforce store byte-identical
//      values (plausible → ISO, wrong-year/far-future → NULL, null → NULL).
//   2. TELEMETRY IS MODE-GATED: exactly one event_date_sanity_rejected row
//      per rejection under shadow/enforce, zero under off/unset/garbage,
//      zero ever for plausible/null inputs.
//
// Also pins: ingest-identity derivation (disc_/twit_/skip), payload shape,
// per-call flag read (flip between createBet calls in one process), the
// resolver's strict-compare contract, and the recoverHold backdate bypass
// (source-level: holdReview writes event_date directly, never through the
// gate — so no mode can affect it).
//
// RED-proof: `git stash push -- services/eventDate.js services/database.js
// services/pipeline-events.js` → emission cases fail (no event rows, resolver
// missing); pop → green.
//
// Run: node tests/event-date-sanity-mode.test.js
// ═══════════════════════════════════════════════════════════

const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolate from the dev DB. Must be set BEFORE requiring services/database.js.
const DB_PATH = path.join(os.tmpdir(), `event-date-sanity-mode-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}
delete process.env.EVENT_DATE_SANITY_MODE;

const { resolveEventDateSanityMode } = require('../services/eventDate');
const { db, createBet, getOrCreateCapper } = require('../services/database');
const pe = require('../services/pipeline-events');

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

// ── §1 resolver contract ─────────────────────────────────────
console.log('\n§1 resolveEventDateSanityMode (strict compare, unset → off)');
check('unset → off', resolveEventDateSanityMode(undefined) === 'off');
check('empty string → off', resolveEventDateSanityMode('') === 'off');
check('garbage → off', resolveEventDateSanityMode('Shadow') === 'off'); // case-sensitive strict compare
check('"on" → off (unknown value rejected)', resolveEventDateSanityMode('on') === 'off');
check('"shadow" → shadow', resolveEventDateSanityMode('shadow') === 'shadow');
check('"enforce" → enforce', resolveEventDateSanityMode('enforce') === 'enforce');
check('reads process.env per call', (() => {
  process.env.EVENT_DATE_SANITY_MODE = 'shadow';
  const a = resolveEventDateSanityMode();
  delete process.env.EVENT_DATE_SANITY_MODE;
  const b = resolveEventDateSanityMode();
  return a === 'shadow' && b === 'off';
})());

// ── §2 registration ──────────────────────────────────────────
console.log('\n§2 pipeline-events registration');
check(
  'event_date_sanity_rejected registered in EVENT_TYPES',
  pe.EVENT_TYPES.includes('event_date_sanity_rejected'),
);

// ── §3 the matrix ────────────────────────────────────────────
console.log('\n§3 mode × input matrix through createBet');

const capper = getOrCreateCapper('sanity-mode-capper', 'Sanity Mode Capper');

const eventCount = () => db.prepare(
  "SELECT COUNT(*) AS c FROM pipeline_events WHERE event_type = 'event_date_sanity_rejected'",
).get().c;
const lastEvent = () => db.prepare(
  "SELECT * FROM pipeline_events WHERE event_type = 'event_date_sanity_rejected' ORDER BY id DESC LIMIT 1",
).get();

let seq = 0;
function makeBet(eventDate, extra = {}) {
  seq++;
  return createBet({
    capper_id: capper.id,
    sport: 'MLB',
    bet_type: 'straight',
    description: `sanity matrix bet ${seq}`,
    odds: -110,
    units: 1,
    event_date: eventDate,
    source: 'vision_slip',
    source_channel_id: 'chan-1',
    source_message_id: `msg-${process.pid}-${seq}`,
    review_status: 'confirmed',
    ...extra,
  });
}

// Inputs. Anchors are relative to now because createBet anchors the guard on
// the real insert-time clock (database.js: normalizeEventDateForStorage(..., new Date())).
const PLAUSIBLE = new Date(Date.now() + 6 * 3600 * 1000).toISOString();      // +6h — in bounds
const WRONG_YEAR = '2023-11-26T19:00:00.000Z';                               // the e2feed30 specimen — hundreds of days back
const FAR_FUTURE = new Date(Date.now() + 400 * 86400 * 1000).toISOString();  // +400d — beyond +60d bound

const MODES = [
  ['off (unset)', () => { delete process.env.EVENT_DATE_SANITY_MODE; }, false],
  ['off (garbage value)', () => { process.env.EVENT_DATE_SANITY_MODE = 'bogus'; }, false],
  ['shadow', () => { process.env.EVENT_DATE_SANITY_MODE = 'shadow'; }, true],
  ['enforce', () => { process.env.EVENT_DATE_SANITY_MODE = 'enforce'; }, true],
];

const storedByMode = {}; // storage mode-invariance cross-check

for (const [label, setMode, emits] of MODES) {
  setMode();
  const stored = {};

  let before = eventCount();
  const bPlausible = makeBet(PLAUSIBLE);
  stored.plausible = bPlausible.event_date;
  check(`${label}: plausible (+6h) stored non-NULL`, bPlausible.event_date === PLAUSIBLE,
    `got ${JSON.stringify(bPlausible.event_date)}`);
  check(`${label}: plausible emits nothing`, eventCount() === before);

  before = eventCount();
  const bWrongYear = makeBet(WRONG_YEAR);
  stored.wrongYear = bWrongYear.event_date;
  check(`${label}: wrong-year stored NULL (guard always on)`, bWrongYear.event_date === null,
    `got ${JSON.stringify(bWrongYear.event_date)}`);
  check(
    `${label}: wrong-year ${emits ? 'emits exactly one event' : 'emits nothing'}`,
    eventCount() === before + (emits ? 1 : 0),
    `count ${before} → ${eventCount()}`,
  );

  before = eventCount();
  const bFarFuture = makeBet(FAR_FUTURE);
  stored.farFuture = bFarFuture.event_date;
  check(`${label}: far-future (+400d) stored NULL`, bFarFuture.event_date === null,
    `got ${JSON.stringify(bFarFuture.event_date)}`);
  check(
    `${label}: far-future ${emits ? 'emits exactly one event' : 'emits nothing'}`,
    eventCount() === before + (emits ? 1 : 0),
  );

  before = eventCount();
  const bNull = makeBet(null);
  stored.nullInput = bNull.event_date;
  check(`${label}: NULL input stays NULL`, bNull.event_date === null);
  check(`${label}: NULL input emits nothing (not a rejection)`, eventCount() === before);

  storedByMode[label] = stored;
}
delete process.env.EVENT_DATE_SANITY_MODE;

// Storage mode-invariance: every mode stored identical values per input class.
const base = storedByMode['off (unset)'];
check(
  'storage is mode-invariant across off/shadow/enforce',
  Object.values(storedByMode).every(s =>
    s.plausible === base.plausible
    && s.wrongYear === base.wrongYear
    && s.farFuture === base.farFuture
    && s.nullInput === base.nullInput),
  JSON.stringify(storedByMode),
);

// ── §4 event row shape + ingest identity ─────────────────────
console.log('\n§4 event row shape + ingest identity');

process.env.EVENT_DATE_SANITY_MODE = 'shadow';

makeBet(WRONG_YEAR);
let row = lastEvent();
check('row: stage STAGED', row && row.stage === 'STAGED');
check('row: source_type discord (from source_message_id)', row && row.source_type === 'discord');
check('row: ingest_id disc_<message id>', row && /^disc_msg-/.test(row.ingest_id), row && row.ingest_id);
check('row: bet_id set', row && !!row.bet_id);
{
  const p = row && JSON.parse(row.payload);
  check('payload: where createBet', p && p.where === 'createBet');
  check('payload: rejected_value carries the rejected ISO', p && p.rejected_value === WRONG_YEAR);
  check('payload: gap_days negative + large', p && typeof p.gap_days === 'number' && p.gap_days < -300, p && String(p.gap_days));
  check('payload: raw carries extractor output', p && p.raw === WRONG_YEAR);
  check('payload: bounds recorded', p && p.min_gap_days === -2 && p.max_gap_days === 60);
  check('payload: mode recorded', p && p.mode === 'shadow');
  check('payload: source recorded', p && p.source === 'vision_slip');
}

// Twitter identity: no message id, tweet id present.
{
  seq++;
  const before = eventCount();
  createBet({
    capper_id: capper.id,
    sport: 'MLB',
    bet_type: 'straight',
    description: `sanity twitter bet ${seq}`,
    odds: -110,
    units: 1,
    event_date: WRONG_YEAR,
    source: 'twitter_vision',
    source_tweet_id: `tw-${process.pid}-${seq}`,
    review_status: 'needs_review',
  });
  row = lastEvent();
  check('twitter bet: one event emitted', eventCount() === before + 1);
  check('twitter bet: source_type twitter', row && row.source_type === 'twitter');
  check('twitter bet: ingest_id twit_<tweet id>', row && /^twit_tw-/.test(row.ingest_id), row && row.ingest_id);
}

// No source refs at all: rejection still NULLs, telemetry skipped (writeRow
// would drop an ingest-side row without an ingestId; we skip explicitly).
{
  seq++;
  const before = eventCount();
  const b = createBet({
    capper_id: capper.id,
    sport: 'MLB',
    bet_type: 'straight',
    description: `sanity no-ref bet ${seq}`,
    odds: -110,
    units: 1,
    event_date: WRONG_YEAR,
    source: 'manual',
  });
  check('no-source-ref bet: still stored NULL', b.event_date === null);
  check('no-source-ref bet: telemetry skipped (no ingest identity)', eventCount() === before);
}

delete process.env.EVENT_DATE_SANITY_MODE;

// ── §5 recoverHold backdate bypass unaffected ────────────────
// The backdate path (services/holdReview.js _backdateRecoveredBets) writes
// event_date in a direct UPDATE from the Discord message timestamp — it never
// routes through normalizeEventDateForStorage, so EVENT_DATE_SANITY_MODE
// cannot affect it in any mode. Pin that at the source level (the behavioral
// coverage lives in tests/hold-recover.test.js).
console.log('\n§5 recoverHold bypass (source pin)');
{
  const HOLD_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'holdReview.js'), 'utf8');
  check(
    'holdReview backdate writes event_date via direct UPDATE',
    HOLD_SRC.includes('UPDATE bets SET created_at = ?, event_date = ? WHERE id = ?'),
  );
  check(
    'holdReview never imports the write gate (bypass intact)',
    !HOLD_SRC.includes('normalizeEventDateForStorage'),
  );
  check(
    'holdReview never reads EVENT_DATE_SANITY_MODE',
    !HOLD_SRC.includes('EVENT_DATE_SANITY_MODE'),
  );
}

// ── §6 #190 terminal-state invariant untouched ───────────────
// This PR's writes are ingest-side: createBet's INSERT names neither result
// nor grading_state (both take defaults), and the telemetry emit is a
// pipeline_events INSERT — no terminal result write anywhere on this path.
console.log('\n§6 #190 invariant (ingest-side writes only)');
{
  const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'database.js'), 'utf8');
  const insertStmt = DB_SRC.match(/INSERT INTO bets \(([^)]+)\)/);
  check('createBet INSERT has no result/grading_state columns',
    !!insertStmt && !insertStmt[1].includes('result') && !insertStmt[1].includes('grading_state'));
  check('sanity emit helper writes no bets columns',
    !/emitEventDateSanityRejected[\s\S]{0,2500}UPDATE bets/.test(DB_SRC));
}

console.log(`\nevent-date-sanity-mode: ${pass} passed / ${fail} failed`);
// Deferred cleanup mirrors leg-match-binding: let fire-and-forget writes flush.
setImmediate(() => {
  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }
});
if (fail > 0) process.exit(1);
