// ═══════════════════════════════════════════════════════════
// Grader-vs-revert race — terminal grader WRITES must re-check review_status.
//
// The bug (Codex finding #2, code-confirmed): getPendingBets() excludes
// review_status IN GRADER_HIDDEN_REVIEW_STATUSES at SELECTION time, so the grader
// never CLAIMS a parked bet. But the terminal WRITES in the grading path gated
// only on result ('WHERE id=? AND (result=\'pending\' OR result IS NULL)') — they
// did NOT re-check review_status. So this race was reachable:
//   (1) the grader claims a CONFIRMED pending bet,
//   (2) an operator runs revertBetToPending() — review_status='needs_review',
//       result='pending', grading_state='ready' — BEFORE the grader's write lands,
//   (3) the grader's terminal write still matches (result is still 'pending') and
//       voids/grades a bet that is now parked in the human review queue.
// This is the last residual of the #93 review-queue-protection work: selection
// was protected, the WRITE was not.
//
// Fix: every terminal grader write gains the write-time DUAL of getPendingBets'
// selection guard —
//   AND (review_status IS NULL OR review_status NOT IN ('needs_review','manual_review_unmodeled_sport'))
// — so a reverted (needs_review) bet is a 0-change NO-OP (left safely parked),
// while a normal confirmed (or legacy NULL) bet still settles exactly as before.
//
// Writes under test (each: reverted bet → no-op; confirmed bet → still settles):
//   1. autoVoidNoSearchableData            (services/grading.js)
//   2. scheduleRecheckAfterDenial retry-cap void (services/grading.js)
//   3. gradePropWithAI auto_void_unscoped_bet    (services/grading.js)
//   4. gradePropWithAI manual_review_unmodeled_sport divert (services/grading.js)
//   5. finalizeBetGrading / sweeper grade via gradeBetRecord opt-in flag
//      (services/database.js requireGraderEligible) — the SHARED helper stays
//      ungated by default so human paths (manual /admin grade, war-room untracked
//      win, admin revert-void) can still write to a needs_review bet; only the
//      autonomous grader paths opt in.
//
// Every "reverted → no-op" assertion FAILS on pre-fix code (pre-fix the
// needs_review bet WOULD be voided/graded). The "confirmed → settles" assertions
// are no-regression controls. The manual-path test guards against the gate being
// applied too broadly.
//
// Run:  node tests/grader-revert-race.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No real network — requiring grading.js pulls in ai.js. The auto-void / divert
// branches return their sentinel BEFORE any grader dispatch, but reject the wire
// so any stray downstream path fails fast instead of hanging.
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Throwaway DB. Set DB_PATH BEFORE requiring database/grading so the real
// production DB is never opened. Default to state-machine ON (production).
const dbFile = path.join(os.tmpdir(), `bettracker-grader-revert-race-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
delete process.env.GRADING_STATE_MACHINE_ENABLED;

const grading = require('../services/grading');
const database = require('../services/database');
const { autoVoidNoSearchableData, scheduleRecheckAfterDenial, gradePropWithAI, finalizeBetGrading } = grading;
const { gradeBet } = database;

// FK off — fixtures use a synthetic capper_id without a cappers row.
database.db.pragma('foreign_keys = OFF');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

// Create a CONFIRMED pending bet, then drive it through the REAL revert path so
// the row carries the exact reverted-mid-flight shape (result='pending',
// review_status='needs_review', grading_state='ready', attempts=0).
function makeRevertedBet(overrides = {}) {
  const bet = database.createBet({
    capper_id: 'test-capper', sport: overrides.sport || 'NBA',
    description: overrides.description || 'reverted mid-flight bet test-race',
    bet_type: overrides.bet_type || 'straight', odds: '-110', units: 1, source: 'test',
    review_status: 'confirmed',
  });
  const reverted = database.revertBetToPending(bet.id, 'operator reverted mid-flight');
  assert.ok(reverted, 'revertBetToPending should flip the confirmed bet to needs_review');
  return bet;
}

function makeConfirmedBet(overrides = {}) {
  return database.createBet({
    capper_id: 'test-capper', sport: overrides.sport || 'NBA',
    description: overrides.description || 'normal confirmed pending bet test-race',
    bet_type: overrides.bet_type || 'straight', odds: '-110', units: 1, source: 'test',
    review_status: 'confirmed',
  });
}

function row(id) {
  return database.db.prepare(
    'SELECT result, review_status, grading_state, grade, profit_units, graded_at FROM bets WHERE id = ?',
  ).get(id);
}

function dropCount(id, reason) {
  return database.db.prepare(
    "SELECT COUNT(*) AS c FROM pipeline_events WHERE bet_id = ? AND event_type = 'DROP' AND drop_reason = ?",
  ).get(id, reason).c;
}

(async () => {
  // ── 1. autoVoidNoSearchableData ─────────────────────────────────────────
  console.log('1. autoVoidNoSearchableData — reverted bet is a no-op; confirmed bet still voids');
  {
    const reverted = makeRevertedBet();
    autoVoidNoSearchableData({ id: reverted.id }, { attempts: 5, hours: 13 });
    const r = row(reverted.id);
    ok('reverted: result stays pending (not voided)', r.result === 'pending');
    ok('reverted: review_status stays needs_review', r.review_status === 'needs_review');
    ok('reverted: no grade written', r.grade === null);

    const confirmed = makeConfirmedBet();
    autoVoidNoSearchableData({ id: confirmed.id }, { attempts: 5, hours: 13 });
    const c = row(confirmed.id);
    ok('confirmed: result void (no regression)', c.result === 'void');
    ok('confirmed: review_status auto_void_no_searchable_data', c.review_status === 'auto_void_no_searchable_data');

    // Legacy NULL review_status must STILL auto-void — proves the NULL-tolerant
    // "review_status IS NULL OR ..." branch of the gate. A naive "AND review_status
    // != 'needs_review'" form would wrongly no-op this row (NULL != x is NULL, not
    // TRUE, under SQLite three-valued logic), stranding it pending forever.
    const legacyNull = makeConfirmedBet();
    database.db.prepare('UPDATE bets SET review_status = NULL WHERE id = ?').run(legacyNull.id);
    autoVoidNoSearchableData({ id: legacyNull.id }, { attempts: 5, hours: 13 });
    ok('legacy NULL review_status: result void (NULL passes the gate, no regression)', row(legacyNull.id).result === 'void');
  }

  // ── 2. scheduleRecheckAfterDenial retry-cap void ────────────────────────
  // The cap branch (attempts >= 15) writes result='void', grade='VOID' and emits
  // a GRADE_BACKOFF_EXHAUSTED drop. The void must respect a mid-flight revert,
  // and a 0-change no-op must NOT emit a false drop (task 4).
  console.log('2. scheduleRecheckAfterDenial retry-cap void — reverted no-op (no void, no drop); confirmed voids');
  {
    const reverted = makeRevertedBet();
    database.db.prepare('UPDATE bets SET grading_attempts = 15 WHERE id = ?').run(reverted.id);
    scheduleRecheckAfterDenial(reverted.id, 'pending_legs', 30);
    const r = row(reverted.id);
    ok('reverted: result stays pending (not retry-cap voided)', r.result === 'pending');
    ok('reverted: review_status stays needs_review', r.review_status === 'needs_review');
    ok('reverted: grade not VOID', r.grade !== 'VOID');
    ok('reverted: NO GRADE_BACKOFF_EXHAUSTED drop emitted on 0-change no-op', dropCount(reverted.id, 'GRADE_BACKOFF_EXHAUSTED') === 0);

    const confirmed = makeConfirmedBet();
    database.db.prepare('UPDATE bets SET grading_attempts = 15 WHERE id = ?').run(confirmed.id);
    scheduleRecheckAfterDenial(confirmed.id, 'pending_legs', 30);
    const c = row(confirmed.id);
    ok('confirmed: result void (no regression)', c.result === 'void');
    ok('confirmed: grade VOID', c.grade === 'VOID');
    ok('confirmed: GRADE_BACKOFF_EXHAUSTED drop emitted', dropCount(confirmed.id, 'GRADE_BACKOFF_EXHAUSTED') === 1);
  }

  // ── 3. gradePropWithAI auto_void_unscoped_bet ───────────────────────────
  // Unsupported, non-unmodeled sport (Unknown + no team/nation in the caption)
  // hits the auto-void branch BEFORE any network call.
  console.log('3. gradePropWithAI unscoped auto-void — reverted no-op; confirmed voids');
  {
    const reverted = makeRevertedBet({ sport: 'Unknown', description: 'random qwerty chatter no teams here test-race' });
    try { await gradePropWithAI({ ...reverted, sport: 'Unknown', description: 'random qwerty chatter no teams here test-race' }); } catch (_) {}
    const r = row(reverted.id);
    ok('reverted: result stays pending (not unscoped-voided)', r.result === 'pending');
    ok('reverted: review_status stays needs_review', r.review_status === 'needs_review');
    ok('reverted: no GRADE_AUTOVOID_UNSCOPED drop on no-op', dropCount(reverted.id, 'GRADE_AUTOVOID_UNSCOPED') === 0);

    const confirmed = makeConfirmedBet({ sport: 'Unknown', description: 'random qwerty chatter no teams here test-race' });
    try { await gradePropWithAI({ ...confirmed, sport: 'Unknown', description: 'random qwerty chatter no teams here test-race' }); } catch (_) {}
    const c = row(confirmed.id);
    ok('confirmed: result void (no regression)', c.result === 'void');
    ok('confirmed: review_status auto_void_unscoped_bet', c.review_status === 'auto_void_unscoped_bet');
  }

  // ── 4. gradePropWithAI manual_review_unmodeled_sport divert ──────────────
  // An unmodeled league (KBO) parks the bet for human grading. If the operator
  // already parked it in needs_review, the grader must NOT override that — leave
  // the human's needs_review intact (no-op), not re-park it as unmodeled.
  console.log('4. gradePropWithAI unmodeled-league divert — reverted no-op (needs_review preserved); confirmed diverts');
  {
    const reverted = makeRevertedBet({ sport: 'KBO', description: 'KBO run line first five innings test-race' });
    try { await gradePropWithAI({ ...reverted, sport: 'KBO', description: 'KBO run line first five innings test-race' }); } catch (_) {}
    const r = row(reverted.id);
    ok('reverted: review_status stays needs_review (NOT re-parked as unmodeled)', r.review_status === 'needs_review');
    ok('reverted: result stays pending', r.result === 'pending');

    const confirmed = makeConfirmedBet({ sport: 'KBO', description: 'KBO run line first five innings test-race' });
    try { await gradePropWithAI({ ...confirmed, sport: 'KBO', description: 'KBO run line first five innings test-race' }); } catch (_) {}
    const c = row(confirmed.id);
    ok('confirmed: review_status manual_review_unmodeled_sport (divert still works)', c.review_status === 'manual_review_unmodeled_sport');
    ok('confirmed: result stays pending (parked, not voided)', c.result === 'pending');
  }

  // ── 5a. gradeBetRecord opt-in flag (the finalize/sweeper grade write) ────
  console.log('5a. gradeBetRecord requireGraderEligible flag — reverted no-op; confirmed grades');
  {
    const reverted = makeRevertedBet();
    const gr = gradeBet(reverted.id, 'loss', -1, 'F', 'AI grade mid-flight', false, { requireGraderEligible: true });
    ok('reverted: gradeBet returns graded:false', gr.graded === false);
    const r = row(reverted.id);
    ok('reverted: result stays pending (not graded loss)', r.result === 'pending');
    ok('reverted: review_status stays needs_review', r.review_status === 'needs_review');

    const confirmed = makeConfirmedBet();
    const gc = gradeBet(confirmed.id, 'loss', -1, 'F', 'AI grade', false, { requireGraderEligible: true });
    ok('confirmed: gradeBet returns graded:true (no regression)', gc.graded === true);
    ok('confirmed: result loss', row(confirmed.id).result === 'loss');
  }

  // ── 5b. sweeper-shaped call (allowAutoConfirm=true + the gate flag) ──────
  console.log('5b. 7-day sweeper grade (gradeBet loss + requireGraderEligible) — reverted no-op; confirmed sweeps');
  {
    const reverted = makeRevertedBet();
    const gr = gradeBet(reverted.id, 'loss', -1, 'F', 'Auto-swept: pending >7 days', true, { requireGraderEligible: true });
    ok('reverted: sweeper grade returns graded:false', gr.graded === false);
    ok('reverted: result stays pending (not swept to loss)', row(reverted.id).result === 'pending');
    ok('reverted: review_status stays needs_review', row(reverted.id).review_status === 'needs_review');

    const confirmed = makeConfirmedBet();
    const gc = gradeBet(confirmed.id, 'loss', -1, 'F', 'Auto-swept: pending >7 days', true, { requireGraderEligible: true });
    ok('confirmed: sweeper grade returns graded:true (no regression)', gc.graded === true);
    ok('confirmed: result loss', row(confirmed.id).result === 'loss');
  }

  // ── 5c. finalizeBetGrading end-to-end opts into the gate ────────────────
  console.log('5c. finalizeBetGrading (AI grader) — reverted no-op; confirmed grades');
  {
    const reverted = makeRevertedBet();
    const fr = await finalizeBetGrading(null, reverted, 'loss', 'Final: Home 95, Away 110 test-race', {});
    ok('reverted: finalizeBetGrading does not grade (graded:false)', fr.graded === false);
    ok('reverted: result stays pending', row(reverted.id).result === 'pending');
    ok('reverted: review_status stays needs_review', row(reverted.id).review_status === 'needs_review');

    const confirmed = makeConfirmedBet();
    const fc = await finalizeBetGrading(null, confirmed, 'loss', 'Final: Home 95, Away 110 test-race', {});
    // finalizeBetGrading's SUCCESS return (grading.js:3302) carries result but no
    // `graded` field — only its no-op returns set graded:false. Assert the row.
    ok('confirmed: finalizeBetGrading result loss (no regression)', fc.result === 'loss');
    ok('confirmed: result loss', row(confirmed.id).result === 'loss');
  }

  // ── 6. CRITICAL no-regression: human paths can STILL grade a needs_review bet ──
  // The gate is OPT-IN. A manual /admin grade or war-room untracked-win calls the
  // shared gradeBet WITHOUT the flag (and with allowAutoConfirm=true), and MUST
  // still be able to write a result to a needs_review bet — that is the entire
  // point of the human review queue. This passes pre- AND post-fix; it guards
  // against the gate being applied to the shared helper unconditionally.
  console.log('6. human path (no flag) still grades a needs_review bet — gate must stay opt-in');
  {
    const reverted = makeRevertedBet();
    const gr = gradeBet(reverted.id, 'win', 1, 'B', 'Manual grade via /admin', true /* allowAutoConfirm */);
    ok('human: gradeBet grades the needs_review bet (graded:true)', gr.graded === true);
    const r = row(reverted.id);
    ok('human: result win', r.result === 'win');
    ok('human: allowAutoConfirm flips review_status to confirmed', r.review_status === 'confirmed');
  }

  // ── 7. gradeBetRecord gate COMPOSES with the parlay pending-legs clause ──
  // gradeBetRecord's WHERE already has "(bet_type NOT IN ('parlay','sgp') OR no
  // pending legs)". A parlay with 0 legs satisfies that clause (COUNT of pending
  // legs = 0), so the review gate is the SOLE differentiator here — proving the
  // appended gate ANDs cleanly with the pre-existing parlay guard rather than
  // interfering with it.
  console.log('7. gradeBetRecord gate composes with the parlay pending-legs clause');
  {
    const revP = makeRevertedBet({ bet_type: 'parlay' });
    const gr = gradeBet(revP.id, 'loss', -1, 'F', 'AI grade parlay', false, { requireGraderEligible: true });
    ok('reverted parlay: graded:false (gate no-op, legs clause was satisfied)', gr.graded === false);
    ok('reverted parlay: result stays pending', row(revP.id).result === 'pending');
    ok('reverted parlay: review_status stays needs_review', row(revP.id).review_status === 'needs_review');

    const confP = makeConfirmedBet({ bet_type: 'parlay' });
    const gc = gradeBet(confP.id, 'loss', -1, 'F', 'AI grade parlay', false, { requireGraderEligible: true });
    ok('confirmed parlay: graded:true (no regression)', gc.graded === true);
    ok('confirmed parlay: result loss', row(confP.id).result === 'loss');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\ngrader-revert-race: ${pass} passed, ${fail} failed`);
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-wal')) fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { if (fs.existsSync(dbFile + '-shm')) fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
