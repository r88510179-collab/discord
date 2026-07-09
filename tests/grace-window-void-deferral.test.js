// ═══════════════════════════════════════════════════════════
// WC-3 — grace-window deferral for the void-on-exhaustion paths
// + classifier families for Gate 4 and LLM no-data phrasings.
//
// Live incident (verified 2026-07-08): three recovered HRB-hold bets with
// ACTIVE sweep_exempt_until grace windows (mig 028) were auto-voided by the
// no-data exhaustion path while INSIDE their protection window. All three were
// real, gradeable World Cup games; manual regrade confirmed all three LOSS
// (docs/regrades/graded_wc3_2026-07-08.json, applied via applyGradeOverride).
// The grace window only guarded the 7-Day Sweeper — the retry-cap void,
// autoVoidNoSearchableData, and the unscoped-sport auto-void ignored it.
//
// Fix under test: every void-on-exhaustion writer calls
// deferVoidForGraceWindow(betId, path, payload) BEFORE its terminal write.
// An ACTIVE window (sweepGraceUntil — the sweeper's exact predicate) skips
// the void, requeues grading_next_attempt_at at the window's lapse, leaves
// grading_state untouched, and emits one GRADE_VOID_DEFERRED_EXEMPT
// pipeline_events row (the bet is NOT dropped). A lapsed or NULL window is
// byte-identical to pre-fix behavior (void + grading_state='done' in the same
// statement — the #190 terminal-state invariant).
//
// Sections (each void path × {active, lapsed, NULL} exemption):
//   1. retry-cap void (scheduleRecheckAfterDenial at RETRY_CAP)
//   2. no-data void (autoVoidNoSearchableData)
//   3. unscoped-sport void (gradePropWithAI, !isSupportedSport branch)
//   4. classifier — OFF_DATE_EVIDENCE → GRADE_DATE_UNVERIFIED (both live
//      template variants); LLM no-data phrasings → GRADE_AI_PENDING_NO_DATA
//      (both live samples); existing mappings pinned unchanged.
//
// Exercises the REAL write paths against a migrated throwaway DB.
// No Discord, no AI, no network.
//
// Run:  node tests/grace-window-void-deferral.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const os = require('os');
const path = require('path');

// No network at require-time or via any stray downstream path (grading.js
// pulls in ai.js; every branch under test returns before any wire call).
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Fresh throwaway DB BEFORE requiring database.js so the migrator builds the
// full schema (sweep_exempt_until is mig 028, grading_state cols are mig 016).
process.env.DB_PATH = path.join(os.tmpdir(), `grace-void-deferral-${process.pid}-${Date.now()}.db`);
// This suite pins the pre-reaper VOID terminals — shield against a leaked REAPER_MODE.
delete process.env.REAPER_MODE;

const database = require('../services/database');
const { db } = database;
const grading = require('../services/grading');
const { gradePropWithAI } = grading;
const {
  scheduleRecheckAfterDenial,
  classifyPendingDropReason,
  deferVoidForGraceWindow,
  sweepGraceUntil,
} = grading._internal;
const { autoVoidNoSearchableData } = grading;
const { DROP_REASONS } = require('../services/pipeline-events');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

// Keystone presence — a check (not a hard assert) so a pre-fix run still
// reaches the behavior sections and shows the REAL red: bets voided inside
// their grace window. (Sections 1–3 call the production writers directly,
// never this helper.)
check('0: deferVoidForGraceWindow exported via grading._internal',
  typeof deferVoidForGraceWindow === 'function');

const CAPPER_ID = 'cap0000000000000000000000000gwd1';
db.prepare('INSERT OR REPLACE INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)')
  .run(CAPPER_ID, 'disc-gwd', 'Grace Window Tester');

let seq = 0;
// Direct INSERT (not createBet) so grading_state / attempts / result /
// sweep_exempt_until are seedable exactly — these tests pin state-machine
// transitions, not ingest.
function seedBet(fields = {}) {
  seq += 1;
  const f = Object.assign({
    id: `gwdbet${String(seq).padStart(26, '0')}`,
    capper_id: CAPPER_ID, sport: 'MLB', bet_type: 'straight',
    description: `Test bet ${seq} ML`, odds: -110, units: 1,
    result: 'pending', profit_units: null, grade: null, grade_reason: null,
    review_status: 'confirmed', season: 'Beta',
    created_at: '2026-07-01 00:00:00', graded_at: null,
    grading_state: 'ready', grading_attempts: 0,
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
// Same idiom the writers stamp with: SQLite-local datetime, 'YYYY-MM-DD HH:MM:SS'.
const setExemptSql = (id, modifier) => // e.g. '+2 days' (active) / '-1 days' (lapsed)
  db.prepare("UPDATE bets SET sweep_exempt_until = datetime('now', ?) WHERE id = ?").run(modifier, id);

// Shared assertions for one deferred void.
function checkDeferred(section, id, voidPath) {
  const b = rowOf(id);
  check(`${section}: NOT voided — result stays pending`, b.result === 'pending' && b.grade == null);
  check(`${section}: grading_state untouched (retry loop keeps the bet)`, b.grading_state !== 'done');
  check(`${section}: next attempt rescheduled AT the window's lapse`,
    b.grading_next_attempt_at != null && b.grading_next_attempt_at === b.sweep_exempt_until);
  check(`${section}: lock cleared`, b.grading_lock_until == null);
  const drops = dropRowsFor(id, 'GRADE_VOID_DEFERRED_EXEMPT');
  check(`${section}: exactly one GRADE_VOID_DEFERRED_EXEMPT event`, drops.length === 1);
  const payload = drops.length ? JSON.parse(drops[0].payload || '{}') : {};
  check(`${section}: event payload carries void_path='${voidPath}' + the window`,
    payload.void_path === voidPath && payload.sweep_exempt_until === b.sweep_exempt_until);
}

// Shared assertions for one landed (non-deferred) void.
function checkVoided(section, id, expectDeferEvent = 0) {
  const b = rowOf(id);
  check(`${section}: voided`, b.result === 'void' && b.grade === 'VOID');
  check(`${section}: grading_state='done' in the same statement (invariant #190)`, b.grading_state === 'done');
  check(`${section}: no deferral event`, dropRowsFor(id, 'GRADE_VOID_DEFERRED_EXEMPT').length === expectDeferEvent);
}

(async () => {

  // ── 1. retry-cap void (scheduleRecheckAfterDenial at RETRY_CAP) ────────────
  console.log('1. retry-cap void × {active, lapsed, NULL} grace window');
  {
    // (a) ACTIVE window → deferred.
    const id = seedBet({ grading_state: 'backoff', grading_attempts: 15 });
    setExemptSql(id, '+2 days');
    scheduleRecheckAfterDenial(id, 'pending_legs', 30);
    checkDeferred('1a', id, 'retry_cap');
    check('1a: sweepGraceUntil (sweeper predicate) agrees the window is open', sweepGraceUntil(id) != null);

    // (b) LAPSED window → voids exactly as before.
    const id2 = seedBet({ grading_state: 'backoff', grading_attempts: 15 });
    setExemptSql(id2, '-1 days');
    scheduleRecheckAfterDenial(id2, 'pending_legs', 30);
    checkVoided('1b', id2);
    check('1b: GRADE_BACKOFF_EXHAUSTED drop recorded', dropRowsFor(id2, 'GRADE_BACKOFF_EXHAUSTED').length === 1);

    // (c) NULL window → current behavior unchanged.
    const id3 = seedBet({ grading_state: 'backoff', grading_attempts: 15 });
    scheduleRecheckAfterDenial(id3, 'pending_legs', 30);
    checkVoided('1c', id3);

    // (d) Below-cap control with an active window: the deferral must not fire
    // (the cap branch owns it) — normal requeue only.
    const id4 = seedBet({ grading_state: 'backoff', grading_attempts: 3 });
    setExemptSql(id4, '+2 days');
    scheduleRecheckAfterDenial(id4, 'pending_legs', 30);
    const b4 = rowOf(id4);
    check('1d: below cap — still pending, normal requeue', b4.result === 'pending' && b4.grading_next_attempt_at != null);
    check('1d: below cap — no deferral event', dropRowsFor(id4, 'GRADE_VOID_DEFERRED_EXEMPT').length === 0);

    // (e) Review-parked control (#118 GRADER_ELIGIBLE_WHERE on the requeue):
    // an operator-parked needs_review bet with an active window at cap must be
    // left completely untouched — no void, no requeue, no event.
    const id5 = seedBet({ grading_state: 'backoff', grading_attempts: 15, review_status: 'needs_review' });
    setExemptSql(id5, '+2 days');
    scheduleRecheckAfterDenial(id5, 'pending_legs', 30);
    const b5 = rowOf(id5);
    check('1e: review-parked — not voided, not requeued (0-change no-op)',
      b5.result === 'pending' && b5.grading_next_attempt_at == null && b5.grading_last_failure_reason == null);
    check('1e: review-parked — no deferral event', dropRowsFor(id5, 'GRADE_VOID_DEFERRED_EXEMPT').length === 0);
  }

  // ── 2. no-data void (autoVoidNoSearchableData) ─────────────────────────────
  console.log('2. no-data void × {active, lapsed, NULL} grace window');
  {
    const info = { attempts: 7, hours: 26 };

    // (a) ACTIVE window → deferred. The exact WC-3 shape: a recovered bet
    // inside its window hitting the no-data exhaustion writer.
    const id = seedBet({ grading_state: 'backoff', grading_attempts: 7 });
    setExemptSql(id, '+2 days');
    autoVoidNoSearchableData(rowOf(id), info);
    checkDeferred('2a', id, 'no_data');

    // (b) LAPSED window → voids exactly as before.
    const id2 = seedBet({ grading_state: 'backoff', grading_attempts: 7 });
    setExemptSql(id2, '-1 days');
    autoVoidNoSearchableData(rowOf(id2), info);
    checkVoided('2b', id2);
    check("2b: review_status stamped 'auto_void_no_searchable_data'", rowOf(id2).review_status === 'auto_void_no_searchable_data');

    // (c) NULL window → current behavior unchanged.
    const id3 = seedBet({ grading_state: 'backoff', grading_attempts: 7 });
    autoVoidNoSearchableData(rowOf(id3), info);
    checkVoided('2c', id3);
  }

  // ── 3. unscoped-sport void (gradePropWithAI supported-sport gate) ──────────
  console.log('3. unscoped-sport void × {active, lapsed, NULL} grace window');
  {
    // sport='Unknown' + a teamless description: survives reclassifySport,
    // canonicalizeSportForGrading, and the national-team rescue → hits the
    // !isSupportedSport void branch before any search/AI dispatch.
    const mk = () => seedBet({ sport: 'Unknown', description: 'mystery pick of the day' });

    // (a) ACTIVE window → deferred; sentinel returned, nothing terminal.
    const id = mk();
    setExemptSql(id, '+2 days');
    const r = await gradePropWithAI({ ...rowOf(id) });
    check('3a: sentinel VOID_DEFERRED_EXEMPT returned', r && r.status === 'VOID_DEFERRED_EXEMPT');
    checkDeferred('3a', id, 'unscoped_sport');
    check('3a: no GRADE_AUTOVOID_UNSCOPED drop for a void that never happened',
      dropRowsFor(id, 'GRADE_AUTOVOID_UNSCOPED').length === 0);

    // (b) LAPSED window → voids exactly as before.
    const id2 = mk();
    setExemptSql(id2, '-1 days');
    const r2 = await gradePropWithAI({ ...rowOf(id2) });
    check('3b: AUTO_VOIDED sentinel returned', r2 && r2.status === 'AUTO_VOIDED');
    checkVoided('3b', id2);
    check("3b: review_status stamped 'auto_void_unscoped_bet'", rowOf(id2).review_status === 'auto_void_unscoped_bet');
    check('3b: GRADE_AUTOVOID_UNSCOPED drop recorded', dropRowsFor(id2, 'GRADE_AUTOVOID_UNSCOPED').length === 1);

    // (c) NULL window → current behavior unchanged.
    const id3 = mk();
    const r3 = await gradePropWithAI({ ...rowOf(id3) });
    check('3c: AUTO_VOIDED sentinel returned', r3 && r3.status === 'AUTO_VOIDED');
    checkVoided('3c', id3);

    // (d) Unmodeled-league divert control: NOT a void, so the grace window must
    // not interpose — KBO parks for a human even inside an active window.
    const id4 = seedBet({ sport: 'KBO', description: 'Doosan Bears ML' });
    setExemptSql(id4, '+2 days');
    const r4 = await gradePropWithAI({ ...rowOf(id4) });
    const b4 = rowOf(id4);
    check('3d: unmodeled divert unaffected by the window (parked, not deferred)',
      r4 && r4.status === 'MANUAL_REVIEW_UNMODELED' && b4.review_status === 'manual_review_unmodeled_sport');
    check('3d: no deferral event on the divert path', dropRowsFor(id4, 'GRADE_VOID_DEFERRED_EXEMPT').length === 0);
  }

  // ── 4. classifier — Gate 4 family + LLM no-data family ─────────────────────
  console.log('4. classifyPendingDropReason (GRADE_DATE_UNVERIFIED + no-data phrasings)');
  {
    // EXACT template gradeSingleBet builds at the Gate 4 enforce earlyReturn
    // (`OFF_DATE_EVIDENCE: evidence dated <dates> outside <anchor>±<tol>d —
    // forced PENDING (model claimed <STATUS>)`), both claimed-status variants +
    // single- and multi-date evdates joins.
    const g4Win = 'OFF_DATE_EVIDENCE: evidence dated 2026-07-01 outside 2026-07-07±1d — forced PENDING (model claimed WIN)';
    const g4Loss = 'OFF_DATE_EVIDENCE: evidence dated 2026-06-06,2026-06-07 outside 2026-06-12±1d — forced PENDING (model claimed LOSS)';
    check('4a: Gate 4 claimed-WIN variant → GRADE_DATE_UNVERIFIED',
      classifyPendingDropReason(g4Win) === 'GRADE_DATE_UNVERIFIED');
    check('4b: Gate 4 claimed-LOSS multi-date variant → GRADE_DATE_UNVERIFIED',
      classifyPendingDropReason(g4Loss) === 'GRADE_DATE_UNVERIFIED');
    check('4c: GRADE_DATE_UNVERIFIED registered in DROP_REASONS',
      DROP_REASONS.includes('GRADE_DATE_UNVERIFIED'));
    check('4d: GRADE_VOID_DEFERRED_EXEMPT registered in DROP_REASONS',
      DROP_REASONS.includes('GRADE_VOID_DEFERRED_EXEMPT'));

    // Both live 2026-07-08 LLM no-data samples → the EXISTING
    // GRADE_AI_PENDING_NO_DATA (no new reason).
    const noData1 = 'No final score or sports event results for Norway in soccer on 2026-06-30 found';
    const noData2 = "No final score or match details found for Brazil's game on 2026-06-29 in search";
    check('4e: live sample 1 → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData1) === 'GRADE_AI_PENDING_NO_DATA');
    check('4f: live sample 2 → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData2) === 'GRADE_AI_PENDING_NO_DATA');
    check('4g: other conservative stems match ("No match details…" / "No results…")',
      classifyPendingDropReason('No match details found for this fixture') === 'GRADE_AI_PENDING_NO_DATA'
      && classifyPendingDropReason('No results for the queried game in search') === 'GRADE_AI_PENDING_NO_DATA');

    // Existing mappings unaffected (chain-order pins).
    check('4h: pin — code-templated "No final score found…" STILL → GRADE_NO_SEARCH_HITS (matched first)',
      classifyPendingDropReason('No final score found for this game') === 'GRADE_NO_SEARCH_HITS');
    check('4i: pin — Gate 3 UNVERIFIED_QUOTE variants unchanged',
      classifyPendingDropReason('UNVERIFIED_QUOTE: missing evidence_quote — forced PENDING (model claimed LOSS). Original: ') === 'GRADE_QUOTE_UNVERIFIED'
      && classifyPendingDropReason('UNVERIFIED_QUOTE: evidence_quote is not an exact substring of the evidence — forced PENDING (model claimed WIN). Original: Final score 118-112') === 'GRADE_QUOTE_UNVERIFIED');
    check('4j: pin — too-recent family unchanged (incl. "No event date…" which must NOT hit the no-data stems)',
      classifyPendingDropReason('No event date — cannot determine if game has occurred') === 'GRADE_TOO_RECENT'
      && classifyPendingDropReason('Game has not started yet') === 'GRADE_TOO_RECENT');
    check('4k: pin — unknown evidence still falls to the catch-all (stems are anchored, not substring)',
      classifyPendingDropReason('some novel evidence string') === 'GRADE_PENDING_UNCLASSIFIED'
      && classifyPendingDropReason('Search found no final score anywhere') === 'GRADE_PENDING_UNCLASSIFIED');

    // Widened bounded-gap form (2026-07-08 batch 2): three more live LLM
    // no-data phrasings, verbatim from production, whose leading words fall
    // outside the original three stems. Pattern: anchored "No" + 1-7
    // letter-only gap words + a found/results terminator.
    const noData3 = 'No soccer match scores or stats found for Ecuador/Mexico in provided s…';
    const noData4 = 'No final score or game statistics found for Lamine Yamal on 2026-07-05…';
    const noData5 = 'No soccer game data or Messi statistics found in search results';
    check('4l: live sample 3 (soccer match scores/stats) → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData3) === 'GRADE_AI_PENDING_NO_DATA');
    check('4l: live sample 4 (game statistics for player) → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData4) === 'GRADE_AI_PENDING_NO_DATA');
    check('4l: live sample 5 (game data or player statistics) → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData5) === 'GRADE_AI_PENDING_NO_DATA');

    // Negatives for the widened form. CHAIN-ORDER CRITICAL: the no-data branch
    // sits BEFORE the OFF_DATE_EVIDENCE branch — if the widened regex ever
    // matched a Gate 4 string, it would swallow GRADE_DATE_UNVERIFIED silently.
    check('4m: negative — OFF_DATE_EVIDENCE string is NOT swallowed by the widened no-data regex',
      classifyPendingDropReason('OFF_DATE_EVIDENCE: evidence dated 2026-07-01 outside 2026-07-07±1d — forced PENDING (model claimed WIN)') === 'GRADE_DATE_UNVERIFIED');
    check('4m: negative — strings carrying an actual score/verdict do NOT match (→ catch-all)',
      classifyPendingDropReason('Final score: Ecuador 2-1 Mexico on 2026-07-05 — bet result WIN') === 'GRADE_PENDING_UNCLASSIFIED'
      && classifyPendingDropReason('Norway found the net twice in a 2-1 win over Ecuador') === 'GRADE_PENDING_UNCLASSIFIED'
      && classifyPendingDropReason('No. 10 Messi scored twice — final score 3-1 found in highlights') === 'GRADE_PENDING_UNCLASSIFIED');
    check('4m: negative — digits/punctuation in the gap block the match (score cannot hide inside)',
      classifyPendingDropReason('No 2-1 scoreline found for this match') === 'GRADE_PENDING_UNCLASSIFIED'
      && classifyPendingDropReason('No goals for Messi, match found, final score 2-1') === 'GRADE_PENDING_UNCLASSIFIED');

    // v3 widening (2026-07-08 batch 3, live ~19:15-19:18 UTC): two more
    // production no-data phrasings the batch-2 form misses by design limits —
    // an ISO date token in the gap (blocked by the letter-only class) and an
    // 8-word gap (bound was 7). Widened: gap tokens are letter-only OR a full
    // 3-group date (\d{4}[-/]\d{2}[-/]\d{2}); bound 1–10. The SCORE-GUARD is
    // the invariant: short digit-dash tokens that read as scores must stay
    // structurally blocked.
    const noData6 = 'No MLB game scores or stats for 2026-07-08 found in search results';
    const noData7 = 'No soccer match scores or Julian Alvarez goal data found in search res…';
    check('4n: live sample 6 (ISO date token in the gap) → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData6) === 'GRADE_AI_PENDING_NO_DATA');
    check('4n: live sample 7 (8-word gap) → GRADE_AI_PENDING_NO_DATA',
      classifyPendingDropReason(noData7) === 'GRADE_AI_PENDING_NO_DATA');

    // Score-guard negatives: date widening must NOT open a path for
    // score-shaped digit-dash tokens (two groups, 1-3 digits each — never a
    // 4-digit first group + third group like a date).
    check('4o: negative — score-carrying string (no leading "No") → catch-all',
      classifyPendingDropReason('United States 1-4 Belgium — no stats found in search results') === 'GRADE_PENDING_UNCLASSIFIED');
    check('4o: negative — bare "No 2-1 scoreline found" stays blocked → catch-all',
      classifyPendingDropReason('No 2-1 scoreline found') === 'GRADE_PENDING_UNCLASSIFIED');
    check('4o: negative — 3-digit basketball score in the gap stays blocked → catch-all',
      classifyPendingDropReason('No recap of the 107-106 thriller found in search results') === 'GRADE_PENDING_UNCLASSIFIED');
    check('4o: negative — prefixed families keep their own reasons (chain order intact)',
      classifyPendingDropReason('OFF_DATE_EVIDENCE: evidence dated 2026-07-08 outside 2026-07-06±1d — forced PENDING (model claimed LOSS)') === 'GRADE_DATE_UNVERIFIED'
      && classifyPendingDropReason('UNVERIFIED_QUOTE: missing evidence_quote — forced PENDING (model claimed WIN). Original: ') === 'GRADE_QUOTE_UNVERIFIED');
    check('4o: negative — gap beyond the new 10-word bound → catch-all',
      classifyPendingDropReason('No soccer match scores or stats or goal data or assists whatsoever found') === 'GRADE_PENDING_UNCLASSIFIED');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
