// ═══════════════════════════════════════════════════════════
// Event-aware grading recheck (Codex #3) — unit test for the pure
// nextAttemptForEvent planner (services/grading.js _internal).
//
// EVENT_AWARE_RECHECK (off|shadow|enforce) lets scheduleRecheckAfterDenial
// and runAutoGrade defer rechecks of bets whose games haven't happened yet,
// instead of burning Groq's free 30 RPM re-grading them at a flat +30m every
// cron cycle. nextAttemptForEvent derives the next-attempt window from the
// bet's event_date and is PURE (no DB, no network) — `now` is injected so the
// classification is deterministic.
//
// Design notes (ratified with the maintainer, see grading.js header):
//   • "has time" is detected on the RAW event_date string (normalizeEventDate
//     turns an ISO date-only into "...T00:00:00.000Z", which would otherwise
//     make the date-only branch unreachable).
//   • Signature is nextAttemptForEvent(eventDateRaw, now) — no created_at
//     fallback; a falsy/unparseable event_date keeps today's flat +30m.
//   • MAX_DEFER_MS = 168h (7 days): legit multi-day futures defer; typo'd
//     years (2099) still trip the guard.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB. Must be set BEFORE requiring services/grading.js
// (which transitively requires services/database.js — reads DB_PATH at load).
// The helper under test is pure, but the module graph still opens a DB.
const DB_PATH = path.join(os.tmpdir(), `bet-event-aware-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

const { db, _internal } = require('../services/grading');
const { nextAttemptForEvent } = _internal;

// Mirror the module consts so expected times are computed independently.
const EVENT_TO_FINAL_MS = 4 * 3600e3;
const DATEONLY_SETTLE_MS = 6 * 3600e3;
const POST_EVENT_RECHECK_MS = 45 * 60e3;
const DEFAULT_RECHECK_MS = 30 * 60e3;
function endOfUtcDay(t) {
  const d = new Date(t);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
}

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

console.log('event-aware-recheck:');

// Fixed mid-day-UTC anchor avoids day-boundary edge cases in the assertions.
const NOW = Date.parse('2026-06-18T15:00:00.000Z');
const ms = (d) => (d instanceof Date ? d.getTime() : NaN);

// ── Case 1: date-only today → pre_event, defer, nextAttemptAt = endOfUtcDay+6h
{
  const evDay = new Date(NOW).toISOString().slice(0, 10); // '2026-06-18'
  const p = nextAttemptForEvent(evDay, NOW);
  const want = endOfUtcDay(Date.parse(evDay)) + DATEONLY_SETTLE_MS;
  check('1 date-only today → pre_event + defer',
    p.phase === 'pre_event' && p.defer === true && p.reason === 'event_not_final',
    JSON.stringify(p));
  check('1 nextAttemptAt = endOfUtcDay + 6h',
    ms(p.nextAttemptAt) === want,
    `got=${p.nextAttemptAt && p.nextAttemptAt.toISOString()} want=${new Date(want).toISOString()}`);
}

// ── Case 2: dated 5h ago (with time) → post_event, no defer, ≈ now+45m
{
  const ev = new Date(NOW - 5 * 3600e3).toISOString();
  const p = nextAttemptForEvent(ev, NOW);
  check('2 dated 5h ago → post_event, no defer',
    p.phase === 'post_event' && p.defer === false && p.reason === 'event_final_settling',
    JSON.stringify(p));
  check('2 nextAttemptAt = now + 45m',
    ms(p.nextAttemptAt) === NOW + POST_EVENT_RECHECK_MS,
    `got=${p.nextAttemptAt && p.nextAttemptAt.toISOString()}`);
}

// ── Case 3: dated 1h future (with time) → pre_event, defer (= event + 4h)
{
  const evMs = NOW + 1 * 3600e3;
  const ev = new Date(evMs).toISOString();
  const p = nextAttemptForEvent(ev, NOW);
  check('3 dated 1h future → pre_event + defer',
    p.phase === 'pre_event' && p.defer === true && p.reason === 'event_not_final',
    JSON.stringify(p));
  check('3 nextAttemptAt = event + 4h',
    ms(p.nextAttemptAt) === evMs + EVENT_TO_FINAL_MS,
    `got=${p.nextAttemptAt && p.nextAttemptAt.toISOString()}`);
}

// ── Case 4: date-only 3 days out → pre_event, defer, = that day-end + 6h
//    (~87h out, inside MAX_DEFER_MS=168h, so it defers rather than tripping the guard)
{
  const evDay = new Date(NOW + 3 * 86400e3).toISOString().slice(0, 10); // '2026-06-21'
  const p = nextAttemptForEvent(evDay, NOW);
  const want = endOfUtcDay(Date.parse(evDay)) + DATEONLY_SETTLE_MS;
  check('4 date-only 3 days out → pre_event + defer',
    p.phase === 'pre_event' && p.defer === true && p.reason === 'event_not_final',
    JSON.stringify(p));
  check('4 nextAttemptAt = (day+3 end) + 6h',
    ms(p.nextAttemptAt) === want,
    `got=${p.nextAttemptAt && p.nextAttemptAt.toISOString()} want=${new Date(want).toISOString()}`);
}

// ── Case 5: event_date null → unknown, no defer, ≈ now+30m, reason no_event_date
{
  const p = nextAttemptForEvent(null, NOW);
  check('5 null event_date → unknown + no_event_date + flat +30',
    p.phase === 'unknown' && p.defer === false && p.reason === 'no_event_date' &&
      ms(p.nextAttemptAt) === NOW + DEFAULT_RECHECK_MS,
    JSON.stringify(p));
}

// ── Case 6: garbage date → unknown, no defer, ≈ now+30m, reason unparseable
{
  const p = nextAttemptForEvent('garbage-not-a-date', NOW);
  check('6 garbage date → unknown + unparseable + flat +30',
    p.phase === 'unknown' && p.defer === false && p.reason === 'unparseable' &&
      ms(p.nextAttemptAt) === NOW + DEFAULT_RECHECK_MS,
    JSON.stringify(p));
}

// ── Case 7: year-typo far future (2099) → suspect_far_future, no defer, ≈ now+30m
{
  const p = nextAttemptForEvent('2099-06-18', NOW);
  check('7 year-typo 2099 → suspect_far_future + flat +30 (not deferred)',
    p.phase === 'unknown' && p.defer === false && p.reason === 'suspect_far_future' &&
      ms(p.nextAttemptAt) === NOW + DEFAULT_RECHECK_MS,
    JSON.stringify(p));
}

// nextAttemptAt is always a Date (callers .toISOString() it).
check('nextAttemptAt is a Date in every branch',
  [null, 'garbage', '2099-06-18', new Date(NOW).toISOString().slice(0, 10), new Date(NOW).toISOString()]
    .every((x) => nextAttemptForEvent(x, NOW).nextAttemptAt instanceof Date),
  'expected Date instances');

// Cleanup so re-runs start clean.
try { db.close(); } catch (_) {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
