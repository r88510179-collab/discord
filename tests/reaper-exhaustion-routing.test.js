// ═══════════════════════════════════════════════════════════
// Stage 2 reaper — exhaustion terminals route to needs_review (REAPER_MODE)
// + zombie sweep for the quarantined no-exit population.
//
// Operator-ratified policy (WC-3 postmortem: 3/3 exhaustion-voids were wrong,
// -8.25u corrected): "search/adapter failed N times" is the system's
// blindness, not proof the event didn't settle — automated paths must not
// write void on exhaustion grounds. Under REAPER_MODE=enforce the three
// exhaustion writers (retry-cap void, autoVoidNoSearchableData, the
// unscoped-sport void) park the bet for a human instead:
//   review_status='needs_review' (war-room / approveBet queue),
//   result UNTOUCHED ('pending', no grade/profit),
//   grading_state='done' (the #113 divert contract — neither getPendingBets
//   nor claimBetForGrading ever re-picks it, so attempts stop burning),
//   one GRADE_EXHAUSTED_{ADAPTER|NO_SOURCE}_REVIEW drop (payload carries
//   writer, sport, attempts).
// Ordering is UNCHANGED: #191 grace deferral first, then #193's bounded
// adapter deferral (retry-cap only); the reaper only replaces the TERMINAL
// step after both runways are spent.
//   off/unset → byte-identical pre-flag behavior (deploy-safe, pinned here).
//   shadow    → voids proceed unchanged + one reaper_shadow would_route row
//               per void that LANDS (population == enforce's routing set).
//
// Zombie sweep: the one population with no future exit is
// grading_state='quarantined' + result='pending' (both selectors only admit
// ready/backoff; the 7d sweeper filters getPendingBets' snapshot — a
// quarantined pending-legs parlay was immortal). runZombieSweep (tail of
// runAutoGrade) routes it per REAPER_MODE after a 7d operator dwell, skipping
// active grace windows (#191 predicate), future events, future next-attempts,
// and review-parked bets. Deliberately NOT covered: ready/backoff bets with
// NULL/past next_attempt (that IS the live queue) and at/over-cap ready/backoff
// bets (they exit via the cap's terminal step; routing them here would bypass
// #193's deferral runway) — pinned below.
//
// Exercises the REAL write paths against a migrated throwaway DB.
// No Discord, no AI, no network.
//
// Run:  node tests/reaper-exhaustion-routing.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// No network at require-time or via any stray downstream path.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Fresh throwaway DB BEFORE requiring database.js so the migrator builds the
// full schema (sweep_exempt_until is mig 028, grading_state cols are mig 016).
process.env.DB_PATH = path.join(os.tmpdir(), `reaper-routing-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`);
// Pin the branches under test: flat requeues, no event-aware writes, and every
// mode flag explicitly controlled per section.
delete process.env.EVENT_AWARE_RECHECK;
delete process.env.RETRY_CAP_ADAPTER_EXEMPT;
delete process.env.REAPER_MODE;

delete process.env.AUTOGRADER_DISABLED;

const database = require('../services/database');
const { db, getPendingBets, approveBet } = database;
const grading = require('../services/grading');
const { gradePropWithAI, autoVoidNoSearchableData, shouldAutoVoidNoData, claimBetForGrading, runAutoGrade } = grading;
const { scheduleRecheckAfterDenial, runZombieSweep, evaluateSweep, reaperMode, ZOMBIE_DWELL_DAYS } = grading._internal;
const { DROP_REASONS, EVENT_TYPES } = require('../services/pipeline-events');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

const CAPPER_ID = 'cap0000000000000000000000000rpr1';
db.prepare('INSERT OR REPLACE INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)')
  .run(CAPPER_ID, 'disc-rpr', 'Reaper Routing Tester');

let seq = 0;
// Direct INSERT (not createBet) so grading_state / attempts / result /
// sweep_exempt_until are seedable exactly — these tests pin state-machine
// transitions, not ingest.
function seedBet(fields = {}) {
  seq += 1;
  const f = Object.assign({
    id: `rprbet${String(seq).padStart(26, '0')}`,
    capper_id: CAPPER_ID, sport: 'Boxing', bet_type: 'parlay',
    description: `Reaper test bet ${seq} ML`, odds: -110, units: 1,
    result: 'pending', profit_units: null, grade: null, grade_reason: null,
    review_status: 'confirmed', season: 'Beta',
    created_at: '2026-06-01 00:00:00', graded_at: null, event_date: null,
    grading_state: 'backoff', grading_attempts: 15,
    grading_lock_until: null, grading_next_attempt_at: null,
    grading_last_attempt_at: null, sweep_exempt_until: null,
  }, fields);
  db.prepare(`INSERT INTO bets
    (id, capper_id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason,
     review_status, season, created_at, graded_at, event_date, grading_state, grading_attempts, grading_lock_until,
     grading_next_attempt_at, grading_last_attempt_at, sweep_exempt_until)
    VALUES (@id, @capper_id, @sport, @bet_type, @description, @odds, @units, @result, @profit_units, @grade, @grade_reason,
     @review_status, @season, @created_at, @graded_at, @event_date, @grading_state, @grading_attempts, @grading_lock_until,
     @grading_next_attempt_at, @grading_last_attempt_at, @sweep_exempt_until)`)
    .run(f);
  return f.id;
}
const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
const dropRowsFor = (id, reason) => db.prepare(
  'SELECT * FROM pipeline_events WHERE bet_id = ? AND drop_reason = ?').all(id, reason);
const reaperShadowRowsFor = id => db.prepare(
  "SELECT * FROM pipeline_events WHERE bet_id = ? AND event_type = 'reaper_shadow'").all(id);
const capShadowRowsFor = id => db.prepare(
  "SELECT * FROM pipeline_events WHERE bet_id = ? AND event_type = 'retry_cap_adapter_shadow'").all(id);
// Same idiom the writers stamp with: SQLite-local datetime, 'YYYY-MM-DD HH:MM:SS'.
const setExemptSql = (id, modifier) => // e.g. '+2 days' (active) / '-1 days' (lapsed)
  db.prepare("UPDATE bets SET sweep_exempt_until = datetime('now', ?) WHERE id = ?").run(modifier, id);

function withEnv(pairs, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(pairs)) {
    prior[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// One landed (non-routed) exhaustion void — the pre-flag terminal, which must
// stay byte-identical under off/shadow (incl. the #190 invariant).
function checkVoided(section, id, { reviewStatus = null } = {}) {
  const b = rowOf(id);
  check(`${section}: voided`, b.result === 'void' && b.grade === 'VOID');
  check(`${section}: grading_state='done' in the same statement (invariant #190)`, b.grading_state === 'done');
  if (reviewStatus) check(`${section}: review_status='${reviewStatus}'`, b.review_status === reviewStatus);
  check(`${section}: no GRADE_EXHAUSTED_* drop (nothing was routed)`,
    dropRowsFor(id, 'GRADE_EXHAUSTED_ADAPTER_REVIEW').length === 0 &&
    dropRowsFor(id, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);
}

// One routed bet (REAPER_MODE=enforce terminal): the #113 divert contract.
function checkRouted(section, id, { writer, dropReason, minAttempts = null }) {
  const b = rowOf(id);
  check(`${section}: NOT voided — result stays pending, no grade/profit`,
    b.result === 'pending' && b.grade == null && b.profit_units == null);
  check(`${section}: review_status='needs_review'`, b.review_status === 'needs_review');
  check(`${section}: grading_state='done' (out of both selectors — attempts stop burning)`, b.grading_state === 'done');
  check(`${section}: grading_next_attempt_at nulled (human queue owns the bet)`, b.grading_next_attempt_at == null);
  check(`${section}: lock cleared`, b.grading_lock_until == null);
  const drops = dropRowsFor(id, dropReason);
  check(`${section}: exactly one ${dropReason} drop`, drops.length === 1);
  const payload = drops.length ? JSON.parse(drops[0].payload || '{}') : {};
  check(`${section}: payload carries writer/sport/attempts`,
    payload.writer === writer && payload.sport === b.sport &&
    (minAttempts == null || payload.attempts >= minAttempts));
  const other = dropReason === 'GRADE_EXHAUSTED_ADAPTER_REVIEW'
    ? 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW' : 'GRADE_EXHAUSTED_ADAPTER_REVIEW';
  check(`${section}: not double-classified (${other} absent)`, dropRowsFor(id, other).length === 0);
  check(`${section}: no GRADE_BACKOFF_EXHAUSTED (void never happened)`,
    dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 0);
  check(`${section}: no reaper_shadow row under enforce`, reaperShadowRowsFor(id).length === 0);
}

async function main() {
  // ── 0. Enum registration (write-boundary tripwire stays quiet) ────────────
  console.log('0. enum registration + flag reader');
  check('0a: DROP_REASONS registers GRADE_EXHAUSTED_ADAPTER_REVIEW',
    DROP_REASONS.includes('GRADE_EXHAUSTED_ADAPTER_REVIEW'));
  check('0b: DROP_REASONS registers GRADE_EXHAUSTED_NO_SOURCE_REVIEW',
    DROP_REASONS.includes('GRADE_EXHAUSTED_NO_SOURCE_REVIEW'));
  check('0c: EVENT_TYPES registers reaper_shadow', EVENT_TYPES.includes('reaper_shadow'));
  check('0d: reaperMode unset → off', withEnv({ REAPER_MODE: null }, () => reaperMode()) === 'off');
  check('0e: reaperMode garbage → off (strict compare)', withEnv({ REAPER_MODE: 'ENFORCE' }, () => reaperMode()) === 'off');
  check('0f: reaperMode shadow/enforce', withEnv({ REAPER_MODE: 'shadow' }, () => reaperMode()) === 'shadow'
    && withEnv({ REAPER_MODE: 'enforce' }, () => reaperMode()) === 'enforce');

  // ── 1. off / unset — deploy safety: byte-identical to pre-flag behavior ───
  console.log('1. off/unset — every writer voids exactly as today, zero new events');
  await withEnv({ REAPER_MODE: null }, async () => {
    const id = seedBet({ sport: 'Boxing' });
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    checkVoided('1a (retry-cap, unset)', id);
    check('1a: no reaper_shadow row', reaperShadowRowsFor(id).length === 0);
    check('1a: GRADE_BACKOFF_EXHAUSTED recorded (void marker unchanged)',
      dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 1);

    const id2 = seedBet({ sport: 'Boxing', grading_attempts: 7 });
    autoVoidNoSearchableData(rowOf(id2), { attempts: 7, hours: 24 });
    checkVoided('1b (no-data, unset)', id2, { reviewStatus: 'auto_void_no_searchable_data' });
    check('1b: no reaper_shadow row', reaperShadowRowsFor(id2).length === 0);

    const id3 = seedBet({ sport: 'Unknown', description: 'mystery pick of the day', grading_attempts: 1 });
    const r3 = await gradePropWithAI({ ...rowOf(id3) });
    check('1c: AUTO_VOIDED sentinel returned', r3 && r3.status === 'AUTO_VOIDED');
    checkVoided('1c (unscoped, unset)', id3, { reviewStatus: 'auto_void_unscoped_bet' });
    check('1c: no reaper_shadow row', reaperShadowRowsFor(id3).length === 0);
  });
  await withEnv({ REAPER_MODE: 'garbage-value' }, async () => {
    const id = seedBet({ sport: 'MLB' });
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    checkVoided('1d (retry-cap, garbage value → off)', id);
    check('1d: no reaper_shadow row', reaperShadowRowsFor(id).length === 0);
  });

  // ── 2. retry-cap × enforce ─────────────────────────────────────────────────
  console.log('2. retry-cap × enforce — route to needs_review after both runways');
  await withEnv({ REAPER_MODE: 'enforce' }, async () => {
    // (a) search-only sport, no window → routed as NO_SOURCE. Seeded with a
    // NON-NULL next-attempt + lock so checkRouted's "nulled/cleared"
    // assertions actually pin the SET clauses (vacuous against the NULL
    // seed defaults — adversarial-review finding).
    const id = seedBet({ sport: 'Boxing', grading_next_attempt_at: '2027-01-01 00:00:00', grading_lock_until: '2027-01-01 00:00:00' });
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    checkRouted('2a (Boxing)', id, { writer: 'retry_cap', dropReason: 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW', minAttempts: 15 });

    // (b) adapter-covered sport (#193 flag off) → routed as ADAPTER — the
    // WC-3 shape, no deferral runway configured.
    const id2 = seedBet({ sport: 'Soccer' });
    scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
    checkRouted('2b (Soccer, RETRY_CAP_ADAPTER_EXEMPT off)', id2, { writer: 'retry_cap', dropReason: 'GRADE_EXHAUSTED_ADAPTER_REVIEW', minAttempts: 15 });

    // (c) ACTIVE grace window → #191 deferral still wins (runs FIRST): no
    // routing, no drop, bet requeued at the lapse.
    const id3 = seedBet({ sport: 'Soccer' });
    setExemptSql(id3, '+2 days');
    scheduleRecheckAfterDenial(id3, 'pending_legs', 30);
    const b3 = rowOf(id3);
    check('2c: grace deferral wins — not routed, still confirmed/pending',
      b3.result === 'pending' && b3.review_status === 'confirmed' && b3.grading_state !== 'done');
    check('2c: GRADE_VOID_DEFERRED_EXEMPT recorded, no GRADE_EXHAUSTED_*',
      dropRowsFor(id3, 'GRADE_VOID_DEFERRED_EXEMPT').length === 1 &&
      dropRowsFor(id3, 'GRADE_EXHAUSTED_ADAPTER_REVIEW').length === 0);

    // (d) LAPSED window → routed (the post-lapse re-void becomes a re-route).
    const id4 = seedBet({ sport: 'Soccer' });
    setExemptSql(id4, '-1 days');
    scheduleRecheckAfterDenial(id4, 'pending_legs', 30);
    checkRouted('2d (Soccer, lapsed window)', id4, { writer: 'retry_cap', dropReason: 'GRADE_EXHAUSTED_ADAPTER_REVIEW', minAttempts: 15 });

    // (e) #193 enforce, adapter, BELOW ceiling → the +24h deferral runway is
    // untouched; the reaper terminal is never reached.
    await withEnv({ RETRY_CAP_ADAPTER_EXEMPT: 'enforce' }, () => {
      const id5 = seedBet({ sport: 'Soccer', grading_attempts: 15 });
      scheduleRecheckAfterDenial(id5, 'pending_legs', 30);
      const b5 = rowOf(id5);
      check('2e: #193 deferral runway intact — requeued, not routed',
        b5.result === 'pending' && b5.review_status === 'confirmed' &&
        b5.grading_state !== 'done' && b5.grading_next_attempt_at != null);
      check('2e: GRADE_VOID_DEFERRED_ADAPTER recorded, no GRADE_EXHAUSTED_*',
        dropRowsFor(id5, 'GRADE_VOID_DEFERRED_ADAPTER').length === 1 &&
        dropRowsFor(id5, 'GRADE_EXHAUSTED_ADAPTER_REVIEW').length === 0);

      // (f) #193 enforce, adapter, AT the ceiling (19) → the runway is spent;
      // the terminal is now a route, not a void. RED vs #193-only main.
      const id6 = seedBet({ sport: 'Soccer', grading_attempts: 19 });
      scheduleRecheckAfterDenial(id6, 'pending_legs', 30);
      checkRouted('2f (Soccer at ceiling 19)', id6, { writer: 'retry_cap', dropReason: 'GRADE_EXHAUSTED_ADAPTER_REVIEW', minAttempts: 19 });
    });

    // (g) #193 shadow + reaper enforce → routed, and the retry_cap_adapter_shadow
    // measurement row still rides (gated on the routing landing).
    await withEnv({ RETRY_CAP_ADAPTER_EXEMPT: 'shadow' }, () => {
      const id7 = seedBet({ sport: 'MLB' });
      scheduleRecheckAfterDenial(id7, 'pending_legs', 30);
      checkRouted('2g (MLB, #193 shadow)', id7, { writer: 'retry_cap', dropReason: 'GRADE_EXHAUSTED_ADAPTER_REVIEW', minAttempts: 15 });
      check('2g: retry_cap_adapter_shadow row still emitted (gated on routing landing)',
        capShadowRowsFor(id7).length === 1);
    });

    // (h) already review-parked bet → routing is a 0-change no-op, no drop
    // (GRADER_ELIGIBLE_WHERE — idempotency + the #118 revert race).
    const id8 = seedBet({ sport: 'Boxing', review_status: 'needs_review' });
    scheduleRecheckAfterDenial(id8, 'pending_legs', 30);
    const b8 = rowOf(id8);
    check('2h: parked bet untouched (no-op)', b8.result === 'pending' && b8.review_status === 'needs_review' && b8.grading_state === 'backoff');
    check('2h: no drop emitted for a routing that never landed',
      dropRowsFor(id8, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);
  });

  // ── 3. retry-cap × shadow — voids unchanged + would-route measurement ─────
  console.log('3. retry-cap × shadow — void lands + one would_route row');
  await withEnv({ REAPER_MODE: 'shadow' }, async () => {
    const id = seedBet({ sport: 'Boxing' });
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    checkVoided('3a (Boxing)', id);
    const rows = reaperShadowRowsFor(id);
    check('3a: exactly one reaper_shadow row', rows.length === 1);
    const p = rows.length ? JSON.parse(rows[0].payload || '{}') : {};
    check('3a: payload {kind:would_route, writer:retry_cap, would_reason:NO_SOURCE}',
      p.kind === 'would_route' && p.writer === 'retry_cap' &&
      p.would_reason === 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW' && p.adapter_covered === false);

    const id2 = seedBet({ sport: 'Soccer' });
    scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
    checkVoided('3b (Soccer)', id2);
    const rows2 = reaperShadowRowsFor(id2);
    check('3b: adapter-covered classifies ADAPTER_REVIEW',
      rows2.length === 1 && JSON.parse(rows2[0].payload || '{}').would_reason === 'GRADE_EXHAUSTED_ADAPTER_REVIEW');

    // Grace-active → deferral, no void → NO shadow row (population fidelity:
    // shadow measures exactly what enforce would route, and enforce never
    // reaches the terminal while the grace runway holds).
    const id3 = seedBet({ sport: 'Soccer' });
    setExemptSql(id3, '+2 days');
    scheduleRecheckAfterDenial(id3, 'pending_legs', 30);
    check('3c: grace-deferred bet emits no would_route row', reaperShadowRowsFor(id3).length === 0);

    // Review-parked → void no-ops → NO shadow row (same fidelity gate).
    const id4 = seedBet({ sport: 'Boxing', review_status: 'needs_review' });
    scheduleRecheckAfterDenial(id4, 'pending_legs', 30);
    check('3d: parked no-op emits no would_route row', reaperShadowRowsFor(id4).length === 0);
  });

  // ── 4. no-data writer ──────────────────────────────────────────────────────
  console.log('4. no-data void × modes (always search-only — Build-1d guards the gate)');
  {
    // Adapter-covered sports never reach this writer (matrix cell = unreachable
    // by design): shouldAutoVoidNoData's FIRST check returns null.
    const idg = seedBet({ sport: 'Soccer', grading_attempts: 9, created_at: '2026-06-01 00:00:00' });
    check('4-gate: shouldAutoVoidNoData null for adapter-covered sport (Build 1d)',
      shouldAutoVoidNoData(rowOf(idg)) === null);

    await withEnv({ REAPER_MODE: 'enforce' }, async () => {
      const id = seedBet({ sport: 'Boxing', grading_attempts: 7, grading_next_attempt_at: '2027-01-01 00:00:00', grading_lock_until: '2027-01-01 00:00:00' });
      autoVoidNoSearchableData(rowOf(id), { attempts: 7, hours: 24 });
      checkRouted('4a (enforce)', id, { writer: 'no_data', dropReason: 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW', minAttempts: 7 });
      check('4a: review_status is needs_review, NOT auto_void_no_searchable_data',
        rowOf(id).review_status === 'needs_review');

      // Grace window still wins (runs first inside the writer).
      const id2 = seedBet({ sport: 'Boxing', grading_attempts: 7 });
      setExemptSql(id2, '+2 days');
      autoVoidNoSearchableData(rowOf(id2), { attempts: 7, hours: 24 });
      check('4b: grace deferral wins — not routed',
        rowOf(id2).review_status === 'confirmed' &&
        dropRowsFor(id2, 'GRADE_VOID_DEFERRED_EXEMPT').length === 1 &&
        dropRowsFor(id2, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);
    });

    await withEnv({ REAPER_MODE: 'shadow' }, async () => {
      const id = seedBet({ sport: 'Boxing', grading_attempts: 7 });
      autoVoidNoSearchableData(rowOf(id), { attempts: 7, hours: 24 });
      checkVoided('4c (shadow)', id, { reviewStatus: 'auto_void_no_searchable_data' });
      const rows = reaperShadowRowsFor(id);
      check('4c: one would_route row {writer:no_data}',
        rows.length === 1 && JSON.parse(rows[0].payload || '{}').writer === 'no_data');
    });
  }

  // ── 5. unscoped-sport writer (gradePropWithAI supported-sport gate) ───────
  console.log('5. unscoped-sport void × modes');
  {
    // sport='Unknown' + a teamless description: survives reclassifySport,
    // canonicalizeSportForGrading, and the national-team rescue → hits the
    // !isSupportedSport branch before any search/AI dispatch.
    const mk = extra => seedBet({ sport: 'Unknown', description: 'mystery pick of the day', grading_attempts: 1, ...extra });

    await withEnv({ REAPER_MODE: 'enforce' }, async () => {
      const id = mk({ grading_next_attempt_at: '2027-01-01 00:00:00', grading_lock_until: '2027-01-01 00:00:00' });
      const r = await gradePropWithAI({ ...rowOf(id) });
      check('5a: EXHAUSTED_REVIEW sentinel returned (runAutoGrade if/else won\'t match)',
        r && r.status === 'EXHAUSTED_REVIEW');
      checkRouted('5a (enforce)', id, { writer: 'unscoped_sport', dropReason: 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW' });
      check('5a: no GRADE_AUTOVOID_UNSCOPED drop (void never happened)',
        dropRowsFor(id, 'GRADE_AUTOVOID_UNSCOPED').length === 0);

      // Grace window still wins, sentinel unchanged.
      const id2 = mk();
      setExemptSql(id2, '+2 days');
      const r2 = await gradePropWithAI({ ...rowOf(id2) });
      check('5b: VOID_DEFERRED_EXEMPT sentinel still wins over routing',
        r2 && r2.status === 'VOID_DEFERRED_EXEMPT' &&
        dropRowsFor(id2, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);

      // Unmodeled-league divert still runs BEFORE the reaper terminal: KBO
      // parks as manual_review_unmodeled_sport, not needs_review.
      const id3 = seedBet({ sport: 'KBO', description: 'Doosan Bears ML', grading_attempts: 1 });
      const r3 = await gradePropWithAI({ ...rowOf(id3) });
      check('5c: unmodeled divert wins — MANUAL_REVIEW_UNMODELED, no reaper drop',
        r3 && r3.status === 'MANUAL_REVIEW_UNMODELED' &&
        rowOf(id3).review_status === 'manual_review_unmodeled_sport' &&
        dropRowsFor(id3, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);
    });

    await withEnv({ REAPER_MODE: 'shadow' }, async () => {
      const id = mk();
      const r = await gradePropWithAI({ ...rowOf(id) });
      check('5d: AUTO_VOIDED sentinel unchanged in shadow', r && r.status === 'AUTO_VOIDED');
      checkVoided('5d (shadow)', id, { reviewStatus: 'auto_void_unscoped_bet' });
      const rows = reaperShadowRowsFor(id);
      check('5d: one would_route row {writer:unscoped_sport}',
        rows.length === 1 && JSON.parse(rows[0].payload || '{}').writer === 'unscoped_sport');
    });
  }

  // ── 6. routed bet is invisible to grader + sweeper; approveBet re-arms ────
  console.log('6. routed-bet isolation + operator exit (steady state is stable)');
  await withEnv({ REAPER_MODE: 'enforce' }, async () => {
    const id = seedBet({ sport: 'Boxing' });
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    check('6a: routed', rowOf(id).review_status === 'needs_review');
    check('6b: getPendingBets never returns the routed bet',
      !getPendingBets().some(b => b.id === id));
    check('6c: claimBetForGrading refuses the routed bet', claimBetForGrading(id) === false);
    const sweepVerdict = evaluateSweep(rowOf(id), Date.now());
    check('6d: sweeper sees it as parked (grading_state done)', sweepVerdict.eligible === false && sweepVerdict.reason === 'parked');
    // Re-running the writer is a no-op (idempotent — no second drop).
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    check('6e: re-route is a no-op (still exactly one drop)',
      dropRowsFor(id, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 1);
    // Operator exit: approveBet re-arms grading with fresh attempts + grace.
    const approved = approveBet(id);
    const b = rowOf(id);
    check('6f: approveBet re-arms (confirmed/ready/attempts=0/+3d grace)',
      approved != null && b.review_status === 'confirmed' && b.grading_state === 'ready' &&
      b.grading_attempts === 0 && b.sweep_exempt_until != null);
  });

  // ── 7. zombie sweep ────────────────────────────────────────────────────────
  console.log('7. zombie sweep — quarantined no-exit population');
  {
    const mkZombie = extra => seedBet({
      grading_state: 'quarantined', grading_attempts: 22,
      created_at: '2026-05-01 00:00:00',
      grading_last_attempt_at: '2026-05-20 00:00:00', // dwell way past ZOMBIE_DWELL_DAYS
      ...extra,
    });

    // (a) off → hard no-op: no query, no events, bet untouched.
    await withEnv({ REAPER_MODE: null }, () => {
      const id = mkZombie({ sport: 'Boxing' });
      const out = runZombieSweep();
      check('7a: off → examined 0 / routed 0', out.examined === 0 && out.routed === 0);
      const b = rowOf(id);
      check('7a: bet untouched', b.grading_state === 'quarantined' && b.review_status === 'confirmed');
      check('7a: no events', reaperShadowRowsFor(id).length === 0 &&
        dropRowsFor(id, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0);
    });

    // (b) shadow → would_route row per eligible candidate, bet untouched.
    await withEnv({ REAPER_MODE: 'shadow' }, () => {
      const id = mkZombie({ sport: 'Soccer' });
      const out = runZombieSweep();
      check('7b: examined >= 1', out.examined >= 1);
      const b = rowOf(id);
      check('7b: bet untouched in shadow', b.grading_state === 'quarantined' && b.review_status === 'confirmed');
      const rows = reaperShadowRowsFor(id);
      check('7b: one would_route row {writer:zombie_sweep, ADAPTER (Soccer)}',
        rows.length === 1 && (() => {
          const p = JSON.parse(rows[0].payload || '{}');
          return p.writer === 'zombie_sweep' && p.would_reason === 'GRADE_EXHAUSTED_ADAPTER_REVIEW';
        })());
      // Cleanup so later sections don't re-count this candidate.
      db.prepare("UPDATE bets SET result = 'void', grading_state = 'done' WHERE id = ?").run(id);
    });

    // (c) enforce → routed with writer='zombie_sweep'; second run is a no-op.
    await withEnv({ REAPER_MODE: 'enforce' }, () => {
      const id = mkZombie({ sport: 'Boxing' });
      const out = runZombieSweep();
      check('7c: routed >= 1', out.routed >= 1);
      checkRouted('7c (zombie enforce)', id, { writer: 'zombie_sweep', dropReason: 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW', minAttempts: 20 });
      const out2 = runZombieSweep();
      check('7c: second run no-op (routed bet no longer selected)',
        out2.examined === 0 && dropRowsFor(id, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 1);
    });

    // (d) skip conditions — each seeded bet must be left untouched under enforce.
    await withEnv({ REAPER_MODE: 'enforce' }, () => {
      const skips = [];
      // active grace window (#191 predicate — the BACKLOG WC-3 requirement)
      const idGrace = mkZombie({ sport: 'Boxing' });
      setExemptSql(idGrace, '+2 days');
      skips.push(['grace window', idGrace]);
      // future event → waiting, not exhausted
      const idEvent = mkZombie({ sport: 'Boxing', event_date: new Date(Date.now() + 3600e3).toISOString() });
      skips.push(['future event', idEvent]);
      // future grading_next_attempt_at → scheduled (e.g. a fresh quarantine's +24h)
      const idNext = mkZombie({ sport: 'Boxing' });
      db.prepare("UPDATE bets SET grading_next_attempt_at = datetime('now', '+2 hours') WHERE id = ?").run(idNext);
      skips.push(['future next_attempt', idNext]);
      // dwell too recent → operator runway not elapsed
      const idFresh = mkZombie({ sport: 'Boxing' });
      db.prepare("UPDATE bets SET grading_last_attempt_at = datetime('now', '-1 day') WHERE id = ?").run(idFresh);
      skips.push(['dwell < ' + ZOMBIE_DWELL_DAYS + 'd', idFresh]);
      // already parked for a human
      const idParked = mkZombie({ sport: 'Boxing', review_status: 'needs_review' });
      skips.push(['review-parked', idParked]);
      // NOT zombies by design (pinned discrepancy): live-queue and at-cap
      // ready/backoff bets have futures — the cap writer / quarantine own them.
      const idLive = seedBet({ grading_state: 'backoff', grading_attempts: 25, grading_next_attempt_at: null, created_at: '2026-05-01 00:00:00' });
      skips.push(['ready/backoff at-cap (cap writer owns it)', idLive]);
      // terminal-result drift row (result != pending) → out of scope
      const idDrift = mkZombie({ sport: 'Boxing', result: 'void', grade: 'VOID' });
      skips.push(['terminal result', idDrift]);

      runZombieSweep();
      for (const [label, id] of skips) {
        const b = rowOf(id);
        const untouched = b.review_status !== 'needs_review' || label === 'review-parked';
        const noDrop = dropRowsFor(id, 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW').length === 0
          && dropRowsFor(id, 'GRADE_EXHAUSTED_ADAPTER_REVIEW').length === 0;
        check(`7d skip: ${label} — not routed, no drop`, untouched && noDrop);
      }
      // The grace-window skip specifically must also leave state/next-attempt alone.
      const bg = rowOf(idGrace);
      check('7d: grace skip leaves quarantine state untouched (no requeue either)',
        bg.grading_state === 'quarantined' && bg.review_status === 'confirmed');
    });

    // (e) WIRING: the sweep must run even when the pending queue is EMPTY.
    // Zombies accumulate precisely in quiet periods (offseason) when
    // getPendingBets returns nothing, and the zombie population is DISJOINT
    // from that snapshot — so runAutoGrade's empty-queue early return must
    // not gate the sweep (adversarial-review finding: pre-fix the call sat at
    // the tail, after the early return, making the "no future exit"
    // population exitless again exactly when only zombies remain).
    await withEnv({ REAPER_MODE: 'enforce' }, async () => {
      // Neutralize every remaining live-queue fixture so the queue is empty.
      db.prepare(`UPDATE bets SET result = 'void', grade = 'VOID', grading_state = 'done', grading_next_attempt_at = NULL
        WHERE result = 'pending' AND grading_state IN ('ready','backoff')`).run();
      check('7e: pending queue is empty', getPendingBets().length === 0);
      // Past (non-NULL) next-attempt + lock: passes the sweep's own SELECT
      // and makes checkRouted's null assertions real for the zombie writer.
      const id = mkZombie({ sport: 'Boxing', grading_next_attempt_at: '2026-05-21 00:00:00', grading_lock_until: '2026-05-21 00:00:00' });
      const out = await runAutoGrade(null);
      check('7e: empty-queue cycle returns graded 0', out && out.graded === 0);
      checkRouted('7e (zombie via empty-queue runAutoGrade)', id, { writer: 'zombie_sweep', dropReason: 'GRADE_EXHAUSTED_NO_SOURCE_REVIEW', minAttempts: 20 });
    });
  }

  // ── 8. summary ─────────────────────────────────────────────────────────────
  console.log(`\nreaper-exhaustion-routing: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
