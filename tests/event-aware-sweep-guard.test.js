// ═══════════════════════════════════════════════════════════
// Event-aware recheck (EVENT_AWARE_RECHECK) — DB-backed integration tests.
//
// Companion to the pure-planner unit test (tests/event-aware-recheck.test.js).
// PR #124 wired nextAttemptForEvent into two LIVE grader sites but only unit-
// tested the planner; an adversarial re-review flagged (a) a same-cycle sweeper
// race that could finalize a just-deferred bet to a FALSE loss under enforce, and
// (b) zero DB-backed coverage of the enforce/shadow writes. This file closes both.
//
// PART A — Sweeper guard (the FIX). runAutoGrade snapshots `pending` once at cycle
//   start, then its grader loop can DEFER a not-yet-final bet (future event) by
//   writing a future grading_next_attempt_at — but the 7-day sweeper that runs
//   later in the SAME cycle filters that stale snapshot and (pre-fix) settled the
//   just-deferred bet to a loss before its recheck. evaluateSweep now re-derives
//   "is the event still in the future?" from the immutable event_date with the SAME
//   planner runAutoGrade used to defer, gated on enforce (off/shadow byte-identical).
//   • Case A1 (enforce + future event + >7d old → reason='event_pending', NOT swept)
//     FAILS on pre-fix code (pre-fix: eligible=true, reason='eligible' → swept).
//   • Cases A3/A4 (off/shadow → still eligible) are no-regression controls that
//     pass pre- AND post-fix, proving the gate does not touch the default state.
//
// PART B — scheduleRecheckAfterDenial enforce/shadow/off writes (integration gap).
// PART C — a deferred bet (future grading_next_attempt_at) is NOT claimable, so no
//   attempt is burned and no search/LLM runs — the mechanism that makes deferral
//   actually save Groq RPM.
//
// Run:  node tests/event-aware-sweep-guard.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — requiring grading.js pulls in ai.js. Nothing here reaches a
// grader dispatch, but reject the wire so a stray path fails fast, never hangs.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB. Set DB_PATH BEFORE requiring database/grading so production is
// never touched. Default state machine ON (production). Start with the flag UNSET
// (= off) so module load + any default path is the shipped default.
const dbFile = path.join(os.tmpdir(), `event-aware-sweep-guard-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.GRADING_STATE_MACHINE_ENABLED;
delete process.env.EVENT_AWARE_RECHECK;
// Section B exercises the retry-cap VOID terminal — shield against a leaked REAPER_MODE.
delete process.env.REAPER_MODE;

const grading = require('../services/grading');
const database = require('../services/database');
const { scheduleRecheckAfterDenial, claimBetForGrading, _internal } = grading;
const { evaluateSweep } = _internal;

// FK off — fixtures use a synthetic capper_id without a cappers row.
database.db.pragma('foreign_keys = OFF');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

const NOW = Date.now();
const OLD_CREATED = '2020-01-01 00:00:00';                                  // unambiguously > 7d ago
const FUTURE_EVENT = new Date(NOW + 60 * 60 * 1000).toISOString();         // +1h, carries time → pre_event
const PAST_EVENT = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();  // 5d ago → post_event, outside the 48h settle window
const RECENT_PAST_EVENT = new Date(NOW - 5 * 60 * 60 * 1000).toISOString(); // 5h ago → post_event, readyAt (event+4h) 1h ago — inside the settle window
const FUTURE_READY_MS = Date.parse(FUTURE_EVENT) + 4 * 60 * 60 * 1000;     // event + EVENT_TO_FINAL_MS (4h)

let seq = 0;
function makeBet({ sport = 'NBA', bet_type = 'straight', description, eventDate = null, createdAt = null, attempts = 0, gradingState = 'ready', nextAttemptAt = null } = {}) {
  seq += 1;
  const bet = database.createBet({
    capper_id: 'test-capper', sport,
    description: description || `event-aware single bet #${seq}`,
    bet_type, odds: '-110', units: 1, source: 'test', review_status: 'confirmed',
  });
  database.db.prepare(`
    UPDATE bets SET
      result = 'pending',
      event_date = ?,
      created_at = COALESCE(?, created_at),
      grading_attempts = ?,
      grading_state = ?,
      grading_lock_until = NULL,
      grading_next_attempt_at = ?
    WHERE id = ?
  `).run(eventDate, createdAt, attempts, gradingState, nextAttemptAt, bet.id);
  return bet.id;
}

const rowOf = (id) => database.db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
// SQLite datetime() stores UTC 'YYYY-MM-DD HH:MM:SS'; Date.parse treats a bare
// string as LOCAL — normalize to an explicit UTC instant.
const dbTimeMs = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');

function withMode(mode, fn) {
  if (mode) process.env.EVENT_AWARE_RECHECK = mode;
  else delete process.env.EVENT_AWARE_RECHECK;
  try { return fn(); } finally { delete process.env.EVENT_AWARE_RECHECK; }
}

// ─────────────────────────────────────────────────────────────
// PART A — Sweeper guard (the fix)
// ─────────────────────────────────────────────────────────────
console.log('A. evaluateSweep event-aware guard');

// A1 — enforce + >7d old + FUTURE event → NOT swept (reason=event_pending).
//      This is the regression the fix closes; FAILS on pre-fix code.
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: FUTURE_EVENT, description: 'future-event single, 8d old' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A1 enforce + old + future event → not eligible', v.eligible === false, JSON.stringify(v));
  ok('A1 reason === event_pending', v.reason === 'event_pending', JSON.stringify(v));
}

// A2 — enforce + >7d old + PAST event (outside the 48h settle window) → swept
//      normally (event long done; the settle window has lapsed).
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: PAST_EVENT, description: 'past-event single, 8d old' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A2 enforce + old + past event → eligible (event done, sweeps)', v.eligible === true, JSON.stringify(v));
  ok('A2 reason === eligible', v.reason === 'eligible', JSON.stringify(v));
}

// A2b — enforce + >7d old + JUST-FINISHED event (readyAt <48h ago) → NOT swept
//      (reason=event_settling). Stage 2 reaper PR: a deferred bet spends its
//      whole pre-sweep window waiting for its game, so without this window the
//      sweep voids it after a single post-event recheck — the residual half of
//      the MAX_DEFER(7d)/SWEEP_CUTOFF(7d) enforce-flip blocker. This is a
//      DELIBERATE change to the old A2 contract (which used a 5h-old event and
//      asserted eligible): under enforce, "event happened" now means "event
//      happened AND the recheck had its 48h runway".
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: RECENT_PAST_EVENT, description: 'just-finished event, 8d old' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A2b enforce + old + just-finished event → not eligible', v.eligible === false, JSON.stringify(v));
  ok('A2b reason === event_settling', v.reason === 'event_settling', JSON.stringify(v));
}

// A2c — OFF + old + just-finished event → still eligible (settle window is
//      enforce-gated; off/shadow stay byte-identical to the shipped default).
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: RECENT_PAST_EVENT, description: 'just-finished event, off mode' });
  const vOff = withMode(null, () => evaluateSweep(rowOf(id)));
  ok('A2c off + old + just-finished event → eligible (window is enforce-gated)', vOff.eligible === true, JSON.stringify(vOff));
  const vShadow = withMode('shadow', () => evaluateSweep(rowOf(id)));
  ok('A2c shadow + old + just-finished event → eligible (shadow == off)', vShadow.eligible === true, JSON.stringify(vShadow));
}

// A3 — OFF (default) + old + future event → STILL eligible. No-regression control:
//      proves the guard is gated and does not change the shipped default state.
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: FUTURE_EVENT, description: 'future-event single, off mode' });
  const v = withMode(null, () => evaluateSweep(rowOf(id)));
  ok('A3 off + old + future event → eligible (no regression / gate proof)', v.eligible === true, JSON.stringify(v));
}

// A4 — SHADOW + old + future event → STILL eligible. Shadow must be behavior-
//      identical to off (it never writes the defer), so the guard stays inert.
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: FUTURE_EVENT, description: 'future-event single, shadow mode' });
  const v = withMode('shadow', () => evaluateSweep(rowOf(id)));
  ok('A4 shadow + old + future event → eligible (shadow == off)', v.eligible === true, JSON.stringify(v));
}

// A5 — enforce + typo'd far-future year (2099) → suspect_far_future, defer=false →
//      NOT protected → still sweeps (the guard must not shield date typos).
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: '2099-06-18', description: 'year-typo event, 8d old' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A5 enforce + 2099 typo → eligible (far-future not protected)', v.eligible === true, JSON.stringify(v));
}

// A6 — enforce + NULL event_date → unknown, defer=false → not protected → sweeps.
{
  const id = makeBet({ createdAt: OLD_CREATED, eventDate: null, description: 'no event_date, 8d old' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A6 enforce + null event_date → eligible (dateless not protected)', v.eligible === true, JSON.stringify(v));
}

// A7 — enforce + FRESH (<7d) future-event bet → reason stays 'fresh' (age gate runs
//      first; the guard never masks the existing ordering).
{
  const id = makeBet({ createdAt: null, eventDate: FUTURE_EVENT, description: 'fresh future-event bet' });
  const v = withMode('enforce', () => evaluateSweep(rowOf(id)));
  ok('A7 enforce + fresh → not eligible, reason fresh (age gate precedes)', v.eligible === false && v.reason === 'fresh', JSON.stringify(v));
}

// ─────────────────────────────────────────────────────────────
// PART B — scheduleRecheckAfterDenial enforce/shadow/off writes
// ─────────────────────────────────────────────────────────────
console.log('B. scheduleRecheckAfterDenial mode-dependent write');

function shadowRows(id) {
  return database.db.prepare(
    "SELECT payload FROM pipeline_events WHERE bet_id = ? AND event_type = 'event_aware_shadow'",
  ).all(id);
}

// B1 — enforce: writes the event-aware window (event + 4h), NOT flat +30m.
{
  const id = makeBet({ eventDate: FUTURE_EVENT, attempts: 0, description: 'enforce reschedule' });
  withMode('enforce', () => scheduleRecheckAfterDenial(id, 'pending_legs', 30));
  const r = rowOf(id);
  const storedMs = dbTimeMs(r.grading_next_attempt_at);
  ok('B1 enforce next_attempt ≈ event + 4h', Math.abs(storedMs - FUTURE_READY_MS) < 2000, `stored=${r.grading_next_attempt_at} want≈${new Date(FUTURE_READY_MS).toISOString()}`);
  ok('B1 enforce next_attempt is the event window, not flat +30m', storedMs - NOW > 2 * 60 * 60 * 1000, `delta_h=${((storedMs - NOW) / 3600e3).toFixed(2)}`);
  ok('B1 enforce clears grading_lock_until', r.grading_lock_until === null, `lock=${r.grading_lock_until}`);
  ok('B1 enforce stamps grading_last_failure_reason', r.grading_last_failure_reason === 'pending_legs', `reason=${r.grading_last_failure_reason}`);
  ok('B1 enforce emits NO shadow row', shadowRows(id).length === 0);
}

// B2 — shadow: keeps flat +30m AND emits one event_aware_shadow measurement row.
{
  const callNow = Date.now();
  const id = makeBet({ eventDate: FUTURE_EVENT, attempts: 0, description: 'shadow reschedule' });
  withMode('shadow', () => scheduleRecheckAfterDenial(id, 'pending_legs', 30));
  const r = rowOf(id);
  const storedMs = dbTimeMs(r.grading_next_attempt_at);
  ok('B2 shadow next_attempt ≈ now + 30m (flat preserved)', Math.abs((storedMs - callNow) - 30 * 60 * 1000) < 10000, `delta_m=${((storedMs - callNow) / 60000).toFixed(2)}`);
  const rows = shadowRows(id);
  ok('B2 shadow emits one event_aware_shadow row', rows.length === 1, `rows=${rows.length}`);
  if (rows.length) {
    let phase = null;
    try { phase = JSON.parse(rows[0].payload).phase; } catch (_) {}
    ok('B2 shadow payload phase === pre_event', phase === 'pre_event', `phase=${phase}`);
  } else { ok('B2 shadow payload phase === pre_event', false, 'no row'); }
}

// B3 — off (default): flat +30m, NO shadow row (byte-identical to pre-#124).
{
  const callNow = Date.now();
  const id = makeBet({ eventDate: FUTURE_EVENT, attempts: 0, description: 'off reschedule' });
  withMode(null, () => scheduleRecheckAfterDenial(id, 'pending_legs', 30));
  const r = rowOf(id);
  const storedMs = dbTimeMs(r.grading_next_attempt_at);
  ok('B3 off next_attempt ≈ now + 30m (flat)', Math.abs((storedMs - callNow) - 30 * 60 * 1000) < 10000, `delta_m=${((storedMs - callNow) / 60000).toFixed(2)}`);
  ok('B3 off emits NO shadow row', shadowRows(id).length === 0);
}

// B4 — enforce + NULL event_date → unknown phase → flat +30m (no spurious defer).
{
  const callNow = Date.now();
  const id = makeBet({ eventDate: null, attempts: 0, description: 'enforce no-date reschedule' });
  withMode('enforce', () => scheduleRecheckAfterDenial(id, 'pending_legs', 30));
  const storedMs = dbTimeMs(rowOf(id).grading_next_attempt_at);
  ok('B4 enforce + null event_date → flat +30m (dateless not deferred)', Math.abs((storedMs - callNow) - 30 * 60 * 1000) < 10000, `delta_m=${((storedMs - callNow) / 60000).toFixed(2)}`);
}

// B5 — retry cap still fires regardless of mode (backstop preserved under enforce).
{
  const id = makeBet({ eventDate: FUTURE_EVENT, attempts: 15, description: 'enforce retry-cap void' });
  withMode('enforce', () => scheduleRecheckAfterDenial(id, 'pending_legs', 30));
  const r = rowOf(id);
  ok('B5 enforce + attempts=15 → retry cap voids (backstop intact)', r.result === 'void' && r.grade === 'VOID', `result=${r.result} grade=${r.grade}`);
}

// ─────────────────────────────────────────────────────────────
// PART C — a deferred bet is not claimable (no attempt burned)
// ─────────────────────────────────────────────────────────────
console.log('C. deferred bet (future grading_next_attempt_at) is not claimable');

// C1 — future next_attempt → claim blocked, grading_attempts unchanged.
{
  const future = new Date(NOW + 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const id = makeBet({ gradingState: 'ready', attempts: 0, nextAttemptAt: future });
  const claimed = claimBetForGrading(id);
  ok('C1 deferred bet is NOT claimed', claimed === false);
  ok('C1 grading_attempts NOT incremented (no attempt burned)', rowOf(id).grading_attempts === 0, `attempts=${rowOf(id).grading_attempts}`);
}

// C2 — control: null next_attempt + ready → claimable, attempts increments.
{
  const id = makeBet({ gradingState: 'ready', attempts: 0, nextAttemptAt: null });
  const claimed = claimBetForGrading(id);
  ok('C2 ready bet with no defer IS claimed (no regression)', claimed === true);
  ok('C2 grading_attempts incremented to 1', rowOf(id).grading_attempts === 1, `attempts=${rowOf(id).grading_attempts}`);
}

// ── Summary ───────────────────────────────────────────────────
console.log(`\nevent-aware-sweep-guard: ${pass} passed, ${fail} failed`);
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(dbFile + ext); } catch (_) {}
}
process.exit(fail === 0 ? 0 : 1);
