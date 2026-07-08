// ═══════════════════════════════════════════════════════════
// RETRY_CAP_ADAPTER_EXEMPT — Build-1d parity for the retry-cap void.
//
// The residual WC-3 hole (record correction, 2026-07-08): the retry-cap void
// in scheduleRecheckAfterDenial is the writer that ACTUALLY voided the three
// recovered World Cup bets — their sport 'Soccer' is exempt from the no-data
// void via hasDeterministicAdapter (#145), which funnels adapter-covered
// no-data bets onto the denial ladder, where the cap (RETRY_CAP=15) voided
// them. #191 gated the cap behind the sweep_exempt_until grace window, but a
// bet with NO active window (never recovered/approved, or window lapsed —
// attempts stay >=15, so the first denial after the lapse re-voids) still
// cap-voids terminally today.
//
// Fix under test (mode-gated, default off): at the cap, AFTER the #191 grace
// deferral, RETRY_CAP_ADAPTER_EXEMPT gates a hasDeterministicAdapter check,
// BOUNDED by an attempts ceiling (RETRY_CAP + RETRY_CAP_EXEMPT_EXTRA = 15+4=19).
// The ceiling is load-bearing: the cap's population is exclusively pending-legs
// parlays, and the 7-Day Sweeper CANNOT settle that population (its own
// terminal write goes through the same canFinalizeBet gate, gets denied
// pending_legs, and lands back in this fn) — so an unbounded deferral would
// make a never-resolving adapter parlay immortal. The cap void itself stays
// the terminal guarantee, postponed by ~RETRY_CAP_EXEMPT_EXTRA daily re-picks.
// 19 is deliberately BELOW applyBackoff's quarantine threshold (20).
//   enforce → below the ceiling: void skipped, requeued +24h with one
//             GRADE_VOID_DEFERRED_ADAPTER row (bet NOT dropped; requeue
//             carries `AND result='pending' AND ${GRADER_ELIGIBLE_WHERE}` —
//             parked/settled bets untouched). At/above the ceiling: voids
//             exactly as pre-flag.
//   shadow  → one 'retry_cap_adapter_shadow' event_type row (would_defer),
//             emitted INSIDE the voidTx gated on the void landing so the
//             measured population is EXACTLY the set enforce would defer;
//             the void itself proceeds UNCHANGED (behavior-identical to off).
//   off/unset → byte-identical to pre-flag behavior (deploy-safe).
// Non-adapter sports void exactly as before in every mode. #190 terminal-
// state invariant (grading_state='done' in the same void statement) and #191
// ordering (grace deferral FIRST) are pinned unchanged.
//
// Exercises the REAL write path against a migrated throwaway DB.
// No Discord, no AI, no network.
//
// Run:  node tests/retry-cap-adapter-exemption.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// No network at require-time or via any stray downstream path.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Fresh throwaway DB BEFORE requiring database.js so the migrator builds the
// full schema (sweep_exempt_until is mig 028, grading_state cols are mig 016).
process.env.DB_PATH = path.join(os.tmpdir(), `retry-cap-adapter-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`);
// Flat below-cap requeues + no event-aware writes: this suite pins the cap
// branch only.
delete process.env.EVENT_AWARE_RECHECK;
delete process.env.RETRY_CAP_ADAPTER_EXEMPT;

const database = require('../services/database');
const { db } = database;
const grading = require('../services/grading');
const { scheduleRecheckAfterDenial } = grading._internal;
const { DROP_REASONS, EVENT_TYPES } = require('../services/pipeline-events');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

const CAPPER_ID = 'cap0000000000000000000000000rca1';
db.prepare('INSERT OR REPLACE INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)')
  .run(CAPPER_ID, 'disc-rca', 'Retry Cap Adapter Tester');

let seq = 0;
// Direct INSERT (not createBet) so grading_state / attempts / result /
// sweep_exempt_until are seedable exactly — these tests pin state-machine
// transitions, not ingest.
function seedBet(fields = {}) {
  seq += 1;
  const f = Object.assign({
    id: `rcabet${String(seq).padStart(26, '0')}`,
    capper_id: CAPPER_ID, sport: 'MLB', bet_type: 'parlay',
    description: `Test bet ${seq} ML`, odds: -110, units: 1,
    result: 'pending', profit_units: null, grade: null, grade_reason: null,
    review_status: 'confirmed', season: 'Beta',
    created_at: '2026-07-01 00:00:00', graded_at: null,
    grading_state: 'backoff', grading_attempts: 15,
    grading_lock_until: null, grading_next_attempt_at: null,
    sweep_exempt_until: null,
  }, fields);
  db.prepare(`INSERT INTO bets
    (id, capper_id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason,
     review_status, season, created_at, graded_at, grading_state, grading_attempts, grading_lock_until,
     grading_next_attempt_at, sweep_exempt_until)
    VALUES (@id, @capper_id, @sport, @bet_type, @description, @odds, @units, @result, @profit_units, @grade, @grade_reason,
     @review_status, @season, @created_at, @graded_at, @grading_state, @grading_attempts, @grading_lock_until,
     @grading_next_attempt_at, @sweep_exempt_until)`)
    .run(f);
  return f.id;
}
const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
const dropRowsFor = (id, reason) => db.prepare(
  'SELECT * FROM pipeline_events WHERE bet_id = ? AND drop_reason = ?').all(id, reason);
const shadowRowsFor = id => db.prepare(
  "SELECT * FROM pipeline_events WHERE bet_id = ? AND event_type = 'retry_cap_adapter_shadow'").all(id);
// Same idiom the writers stamp with: SQLite-local datetime, 'YYYY-MM-DD HH:MM:SS'.
const setExemptSql = (id, modifier) => // e.g. '+2 days' (active) / '-1 days' (lapsed)
  db.prepare("UPDATE bets SET sweep_exempt_until = datetime('now', ?) WHERE id = ?").run(modifier, id);
// The +24h requeue, checked in SQLite's own comparison space (lexical on the
// normalized 'YYYY-MM-DD HH:MM:SS' format) with slack for test runtime.
const requeuedAbout24h = id => db.prepare(`SELECT CASE
    WHEN grading_next_attempt_at > datetime('now', '+23 hours')
     AND grading_next_attempt_at <= datetime('now', '+25 hours')
    THEN 1 ELSE 0 END AS ok
  FROM bets WHERE id = ?`).get(id).ok === 1;

// Shared assertions for one adapter-deferred cap void (enforce).
function checkAdapterDeferred(section, id) {
  const b = rowOf(id);
  check(`${section}: NOT voided — result stays pending`, b.result === 'pending' && b.grade == null);
  check(`${section}: grading_state untouched (retry loop keeps the bet)`, b.grading_state !== 'done');
  check(`${section}: requeued ~+24h`, requeuedAbout24h(id));
  check(`${section}: lock cleared`, b.grading_lock_until == null);
  check(`${section}: failure reason stamped _cap_adapter_deferred`,
    /_cap_adapter_deferred$/.test(b.grading_last_failure_reason || ''));
  check(`${section}: grading_attempts COLUMN unchanged (>=15 — the ceiling counts real claims, a defer must not reset it)`,
    b.grading_attempts >= 15);
  const drops = dropRowsFor(id, 'GRADE_VOID_DEFERRED_ADAPTER');
  check(`${section}: exactly one GRADE_VOID_DEFERRED_ADAPTER event`, drops.length === 1);
  const payload = drops.length ? JSON.parse(drops[0].payload || '{}') : {};
  check(`${section}: payload carries void_path/sport/attempts`,
    payload.void_path === 'retry_cap' && payload.sport === b.sport && payload.attempts >= 15);
  check(`${section}: no GRADE_BACKOFF_EXHAUSTED (void never happened)`,
    dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 0);
  check(`${section}: no shadow row under enforce`, shadowRowsFor(id).length === 0);
}

// Shared assertions for one landed (non-deferred) cap void.
function checkVoided(section, id) {
  const b = rowOf(id);
  check(`${section}: voided`, b.result === 'void' && b.grade === 'VOID');
  check(`${section}: grading_state='done' in the same statement (invariant #190)`, b.grading_state === 'done');
  check(`${section}: GRADE_BACKOFF_EXHAUSTED drop recorded`, dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 1);
  check(`${section}: no adapter-deferral event`, dropRowsFor(id, 'GRADE_VOID_DEFERRED_ADAPTER').length === 0);
}

// ── 0. Enum registration (write-boundary tripwire stays quiet) ──────────────
console.log('0. enum registration');
check('0a: DROP_REASONS registers GRADE_VOID_DEFERRED_ADAPTER',
  DROP_REASONS.includes('GRADE_VOID_DEFERRED_ADAPTER'));
check('0b: EVENT_TYPES registers retry_cap_adapter_shadow',
  EVENT_TYPES.includes('retry_cap_adapter_shadow'));

// ── 1. off / unset — deploy-safety: byte-identical to pre-flag behavior ─────
console.log('1. off/unset — adapter-covered sport still cap-voids exactly as today');
{
  delete process.env.RETRY_CAP_ADAPTER_EXEMPT;
  const id = seedBet({ sport: 'Soccer' });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  checkVoided('1a (unset, Soccer)', id);
  check('1a: no shadow row either', shadowRowsFor(id).length === 0);

  process.env.RETRY_CAP_ADAPTER_EXEMPT = 'garbage-value';
  const id2 = seedBet({ sport: 'MLB' });
  scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
  checkVoided('1b (garbage value → off, MLB)', id2);
}

// ── 2. enforce — the exemption (RED without the fix: these bets void) ───────
console.log('2. enforce — adapter-covered cap void deferred +24h');
{
  process.env.RETRY_CAP_ADAPTER_EXEMPT = 'enforce';

  // (a) The exact residual WC-3 shape: adapter-covered sport, at cap, NO
  // grace window (never recovered/approved). Pre-fix: terminal void.
  const id = seedBet({ sport: 'Soccer' });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  checkAdapterDeferred('2a (Soccer, no window)', id);

  // (b) LAPSED window — the re-void-after-lapse hole (#191 defers only while
  // the window is ACTIVE; attempts stay >=15 so the first denial after the
  // lapse re-enters the cap). Pre-fix: terminal void.
  const id2 = seedBet({ sport: 'World Cup' });
  setExemptSql(id2, '-1 days');
  scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
  checkAdapterDeferred('2b (World Cup, lapsed window)', id2);

  // (c) Structured-adapter sport (MLB) — exemption is sport-wide, not soccer-special.
  const id3 = seedBet({ sport: 'MLB' });
  scheduleRecheckAfterDenial(id3, 'pending_legs', 30);
  checkAdapterDeferred('2c (MLB)', id3);

  // (d) NON-adapter sport voids exactly as before — the exemption is scoped.
  const id4 = seedBet({ sport: 'Boxing' });
  scheduleRecheckAfterDenial(id4, 'pending_legs', 30);
  checkVoided('2d (Boxing unaffected)', id4);

  // (e) #191 ordering preserved: an ACTIVE window wins — requeue AT the
  // window's lapse with GRADE_VOID_DEFERRED_EXEMPT; the adapter path must
  // NOT fire (no +24h, no ADAPTER event).
  const id5 = seedBet({ sport: 'Soccer' });
  setExemptSql(id5, '+2 days');
  scheduleRecheckAfterDenial(id5, 'pending_legs', 30);
  const b5 = rowOf(id5);
  check('2e: active window — not voided', b5.result === 'pending');
  check('2e: requeued AT the window lapse (grace path, not +24h)',
    b5.grading_next_attempt_at === b5.sweep_exempt_until);
  check('2e: GRADE_VOID_DEFERRED_EXEMPT emitted (grace path)',
    dropRowsFor(id5, 'GRADE_VOID_DEFERRED_EXEMPT').length === 1);
  check('2e: NO adapter-deferral event (grace checked first)',
    dropRowsFor(id5, 'GRADE_VOID_DEFERRED_ADAPTER').length === 0);

  // (f) Review-parked control (#118 GRADER_ELIGIBLE_WHERE on the requeue):
  // an operator-parked bet at cap is left completely untouched.
  const id6 = seedBet({ sport: 'Soccer', review_status: 'needs_review' });
  scheduleRecheckAfterDenial(id6, 'pending_legs', 30);
  const b6 = rowOf(id6);
  check('2f: review-parked — not voided, not requeued (0-change no-op)',
    b6.result === 'pending' && b6.grading_next_attempt_at == null && b6.grading_last_failure_reason == null);
  check('2f: review-parked — no adapter event (gated on the requeue landing)',
    dropRowsFor(id6, 'GRADE_VOID_DEFERRED_ADAPTER').length === 0);

  // (g) Concurrently-settled control (result guard on the requeue): a bet a
  // parallel handler already graded is never touched.
  const id7 = seedBet({ sport: 'MLB', result: 'win', grade: 'WIN', grading_state: 'done' });
  scheduleRecheckAfterDenial(id7, 'pending_legs', 30);
  const b7 = rowOf(id7);
  check('2g: already-settled — untouched (no requeue, result intact)',
    b7.result === 'win' && b7.grading_next_attempt_at == null);
  check('2g: already-settled — no adapter event',
    dropRowsFor(id7, 'GRADE_VOID_DEFERRED_ADAPTER').length === 0);

  // (h) Below-cap control: normal flat requeue, cap branch (and the
  // exemption) never runs.
  const id8 = seedBet({ sport: 'Soccer', grading_attempts: 3 });
  scheduleRecheckAfterDenial(id8, 'pending_legs', 30);
  const b8 = rowOf(id8);
  check('2h: below cap — still pending, normal requeue', b8.result === 'pending' && b8.grading_next_attempt_at != null);
  check('2h: below cap — no adapter event', dropRowsFor(id8, 'GRADE_VOID_DEFERRED_ADAPTER').length === 0);

  // (i) Ceiling boundary — last deferrable attempt count (18 < 19) defers…
  const id9 = seedBet({ sport: 'Soccer', grading_attempts: 18 });
  scheduleRecheckAfterDenial(id9, 'pending_legs', 30);
  checkAdapterDeferred('2i (Soccer, attempts=18 — last below ceiling)', id9);

  // (j) …and AT the ceiling (19 = RETRY_CAP + RETRY_CAP_EXEMPT_EXTRA) the cap
  // void fires exactly as pre-flag — the terminal guarantee. The cap's
  // population (pending-legs parlays) is un-sweepable (sweepExpiredBet's own
  // terminal write is denied pending_legs and lands back here), so WITHOUT
  // this ceiling an adapter-covered never-resolving parlay would be immortal.
  const id10 = seedBet({ sport: 'Soccer', grading_attempts: 19 });
  scheduleRecheckAfterDenial(id10, 'pending_legs', 30);
  checkVoided('2j (Soccer, attempts=19 — ceiling reached, terminal void)', id10);

  // (k) Ceiling void still honors an ACTIVE grace window (#191 checked first,
  // independent of the ceiling).
  const id11 = seedBet({ sport: 'Soccer', grading_attempts: 19 });
  setExemptSql(id11, '+2 days');
  scheduleRecheckAfterDenial(id11, 'pending_legs', 30);
  check('2k: at ceiling + active window — grace deferral still wins',
    rowOf(id11).result === 'pending' && dropRowsFor(id11, 'GRADE_VOID_DEFERRED_EXEMPT').length === 1);
}

// ── 3. shadow — measured, never gates: void unchanged + one would-defer row ─
console.log('3. shadow — void proceeds unchanged, one measurement row');
{
  process.env.RETRY_CAP_ADAPTER_EXEMPT = 'shadow';

  const id = seedBet({ sport: 'Soccer' });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  checkVoided('3a (Soccer voids under shadow)', id);
  const rows = shadowRowsFor(id);
  check('3a: exactly one retry_cap_adapter_shadow row', rows.length === 1);
  const payload = rows.length ? JSON.parse(rows[0].payload || '{}') : {};
  check('3a: shadow payload carries kind=would_defer + sport',
    payload.kind === 'would_defer' && payload.sport === 'Soccer');

  // Non-adapter sport in shadow: no measurement row (the predicate gates it).
  const id2 = seedBet({ sport: 'Boxing' });
  scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
  checkVoided('3b (Boxing voids under shadow)', id2);
  check('3b: no shadow row for a non-adapter sport', shadowRowsFor(id2).length === 0);

  // At the ceiling: enforce would NOT defer, so shadow must not count it.
  const id3 = seedBet({ sport: 'Soccer', grading_attempts: 19 });
  scheduleRecheckAfterDenial(id3, 'pending_legs', 30);
  checkVoided('3c (Soccer at ceiling voids under shadow)', id3);
  check('3c: no shadow row at the ceiling (enforce would void too)', shadowRowsFor(id3).length === 0);

  // Review-parked in shadow: the void no-ops (#118) → the shadow row must not
  // emit either (it is gated on the void landing, mirroring enforce's no-op).
  const id4 = seedBet({ sport: 'Soccer', review_status: 'needs_review' });
  scheduleRecheckAfterDenial(id4, 'pending_legs', 30);
  const b4 = rowOf(id4);
  check('3d: review-parked — untouched under shadow', b4.result === 'pending' && b4.grading_next_attempt_at == null);
  check('3d: review-parked — no shadow row (would_defer population matches enforce exactly)',
    shadowRowsFor(id4).length === 0);
}

delete process.env.RETRY_CAP_ADAPTER_EXEMPT;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
