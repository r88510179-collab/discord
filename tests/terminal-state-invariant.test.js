// ═══════════════════════════════════════════════════════════
// Terminal-state invariant + queue filter + Gate 3 drop classifier.
//
// Live incident (verified 2026-07-08): 375 bets carried a terminal `result`
// (93% void) while `grading_state` stayed 'backoff'/'ready'/'quarantined' —
// ~40% of the week's grading-side pipeline_events churned on already-terminal
// bets (deployed build). A one-time DB cleanup set 372 rows to
// grading_state='done'; these tests pin the code invariant so the class
// cannot recur:
//
//   INVARIANT: any write that sets bets.result to a terminal value
//   (win/loss/push/void) sets grading_state='done' in the same statement.
//
// Sections:
//   1. retry-cap void (scheduleRecheckAfterDenial) — the recurring creator:
//      pre-fix it wrote result='void' with grading_state='backoff' + a +24h
//      next attempt. RED-proven.
//   2. /grade override (applyGradeOverride) — perpetuated drift on rows §1
//      created (void→loss correction kept grading_state='backoff'). RED-proven.
//   3. gradeBetRecord (= database.gradeBet) — regression pin (already set
//      'done' in the same UPDATE).
//   4. queue filter — getPendingBets + claimBetForGrading exclude a
//      terminal-result/backoff row and include a pending/backoff row.
//   5. terminal-state drift counter — the one-time startup visibility log's
//      counting query (countTerminalStateDrift).
//   6. PENDING drop-reason classifier — both Gate 3 UNVERIFIED_QUOTE forced-
//      PENDING variants map to GRADE_QUOTE_UNVERIFIED (pre-fix: the
//      GRADE_PENDING_UNCLASSIFIED catch-all). RED-proven.
//
// Exercises the REAL write/select paths against a migrated throwaway DB.
// No Discord, no AI, no network.
//
// Run:  node tests/terminal-state-invariant.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

// No network at require-time (grading.js is pulled in for the real write paths).
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

// Fresh throwaway DB BEFORE requiring database.js so the migrator builds the
// full schema (grading_state cols are mig 016).
process.env.DB_PATH = path.join(os.tmpdir(), `terminal-state-invariant-${process.pid}-${Date.now()}.db`);

const database = require('../services/database');
const { db, getPendingBets, gradeBet, getBankroll, updateBankroll, saveDailySnapshot, countTerminalStateDrift } = database;
const grading = require('../services/grading');
const { claimBetForGrading, calcProfit } = grading;
const { scheduleRecheckAfterDenial, classifyPendingDropReason } = grading._internal;
const { applyGradeOverride } = require('../services/gradeOverride');
const { DROP_REASONS } = require('../services/pipeline-events');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

const CAPPER_ID = 'cap0000000000000000000000000tsi1';
db.prepare('INSERT OR REPLACE INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)')
  .run(CAPPER_ID, 'disc-tsi', 'Terminal State Tester');
db.prepare('INSERT OR REPLACE INTO bankrolls (id, capper_id, starting, current, unit_size) VALUES (?, ?, ?, ?, ?)')
  .run('bank000000000000000000000000tsi1', CAPPER_ID, 1000, 1000, 25);

let seq = 0;
// Direct INSERT (not createBet) so grading_state / attempts / result are
// seedable exactly — these tests pin state-machine transitions, not ingest.
function seedBet(fields = {}) {
  seq += 1;
  const f = Object.assign({
    id: `tsibet${String(seq).padStart(26, '0')}`,
    capper_id: CAPPER_ID, sport: 'MLB', bet_type: 'straight',
    description: `Test bet ${seq} ML`, odds: -110, units: 1,
    result: 'pending', profit_units: null, grade: null, grade_reason: null,
    review_status: 'confirmed', season: 'Beta',
    created_at: '2026-07-01 00:00:00', graded_at: null,
    grading_state: 'ready', grading_attempts: 0,
    grading_lock_until: null, grading_next_attempt_at: null,
  }, fields);
  db.prepare(`INSERT INTO bets
    (id, capper_id, sport, bet_type, description, odds, units, result, profit_units, grade, grade_reason,
     review_status, season, created_at, graded_at, grading_state, grading_attempts, grading_lock_until, grading_next_attempt_at)
    VALUES (@id, @capper_id, @sport, @bet_type, @description, @odds, @units, @result, @profit_units, @grade, @grade_reason,
     @review_status, @season, @created_at, @graded_at, @grading_state, @grading_attempts, @grading_lock_until, @grading_next_attempt_at)`)
    .run(f);
  return f.id;
}
const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
const dropRowsFor = (id, reason) => db.prepare(
  'SELECT * FROM pipeline_events WHERE bet_id = ? AND drop_reason = ?').all(id, reason);

// ── 1. Retry-cap void sets grading_state='done' (terminal-state invariant) ──
console.log('1. retry-cap void (scheduleRecheckAfterDenial at RETRY_CAP)');
{
  const id = seedBet({ grading_state: 'backoff', grading_attempts: 15 });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  const b = rowOf(id);
  check('1a: result voided at the cap', b.result === 'void' && b.grade === 'VOID');
  check("1b: grading_state='done' in the SAME statement (invariant)", b.grading_state === 'done');
  check('1c: no future next-attempt scheduled on a terminal row', b.grading_next_attempt_at == null);
  check('1d: lock cleared', b.grading_lock_until == null);
  check('1e: GRADE_BACKOFF_EXHAUSTED drop recorded', dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 1);
  check('1f: grader_version stamped', b.grader_version === 'retry-void-v1');
}

// Below-cap control: recheck path must stay non-terminal and untouched by the fix.
{
  const id = seedBet({ grading_state: 'backoff', grading_attempts: 3 });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  const b = rowOf(id);
  check('1g: below cap — still pending', b.result === 'pending');
  check('1h: below cap — state unchanged (backoff)', b.grading_state === 'backoff');
  check('1i: below cap — requeued with a next attempt', b.grading_next_attempt_at != null);
}

// Review-parked no-op control: GRADER_ELIGIBLE_WHERE still guards the void.
{
  const id = seedBet({ grading_state: 'backoff', grading_attempts: 15, review_status: 'needs_review' });
  scheduleRecheckAfterDenial(id, 'pending_legs', 30);
  const b = rowOf(id);
  check('1j: review-parked bet not voided (0-change no-op)', b.result === 'pending' && b.grading_state === 'backoff');
  check('1k: no drop emitted for the no-op', dropRowsFor(id, 'GRADE_BACKOFF_EXHAUSTED').length === 0);
}

// ── 2. /grade override sets grading_state='done' ────────────────────────────
console.log('2. applyGradeOverride (terminal rewrite of a finalized bet)');
{
  // Drifted row — exactly what the pre-fix retry-cap void left behind.
  const id = seedBet({
    result: 'void', profit_units: 0, grade: 'VOID', graded_at: '2026-07-02 00:00:00',
    grading_state: 'backoff', grading_next_attempt_at: '2026-07-03 00:00:00',
  });
  const deps = { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit };
  const out = applyGradeOverride(deps, { betId: id, result: 'loss', reason: 'test correction', invokerId: 'admin-tsi' });
  const b = rowOf(id);
  check('2a: override applied', out.ok === true && b.result === 'loss');
  check("2b: grading_state='done' stamped by the override (invariant)", b.grading_state === 'done');
  check('2c: lock cleared', b.grading_lock_until == null);

  // Idempotent re-run keeps the terminal state.
  const again = applyGradeOverride(deps, { betId: id, result: 'loss', reason: 'again', invokerId: 'admin-tsi' });
  const b2 = rowOf(id);
  check('2d: idempotent re-run keeps done', again.ok === true && again.idempotent === true && b2.grading_state === 'done');
}

// ── 3. gradeBetRecord regression pin (already invariant-correct) ────────────
console.log('3. gradeBetRecord (= database.gradeBet)');
{
  const id = seedBet({ grading_state: 'backoff' });
  const res = gradeBet(id, 'win', 0.91, 'WIN', 'test win');
  const b = rowOf(id);
  check('3a: graded', res.graded === true && b.result === 'win');
  check("3b: grading_state='done' in the same UPDATE (pin)", b.grading_state === 'done');
}

// ── 4. Queue filter — terminal rows can never be picked up ──────────────────
console.log('4. grader eligibility (getPendingBets + claimBetForGrading)');
{
  // Terminal result but NON-terminal state (the drift class): would satisfy
  // every OTHER predicate (state backoff, no lock, no next attempt).
  const terminalId = seedBet({
    result: 'void', profit_units: 0, grade: 'VOID', graded_at: '2026-07-02 00:00:00',
    grading_state: 'backoff',
  });
  // Legitimately pending work in the same state.
  const pendingId = seedBet({ grading_state: 'backoff' });

  const queueIds = getPendingBets().map(b => b.id);
  check('4a: terminal/backoff row excluded from the queue', !queueIds.includes(terminalId));
  check('4b: pending/backoff row included in the queue', queueIds.includes(pendingId));
  check('4c: claim refuses the terminal row', claimBetForGrading(terminalId) === false);
  check('4d: claim accepts the pending row', claimBetForGrading(pendingId) === true);
  // Undo the claim's lock/attempt so later counts are unaffected.
  db.prepare("UPDATE bets SET grading_lock_until = NULL, grading_attempts = 0 WHERE id = ?").run(pendingId);
}

// ── 5. Drift counter behind the one-time startup log ────────────────────────
console.log('5. countTerminalStateDrift (startup visibility)');
{
  const before = countTerminalStateDrift();
  // Section 4's terminal/backoff row + a quarantined drift row.
  const qId = seedBet({
    result: 'loss', profit_units: -1, grade: 'LOSS', graded_at: '2026-07-02 00:00:00',
    grading_state: 'quarantined',
  });
  const after = countTerminalStateDrift();
  check('5a: counts terminal-result rows with non-terminal grading_state', after.total === before.total + 1);
  check('5b: byState breaks out quarantined', (after.byState.quarantined || 0) === (before.byState.quarantined || 0) + 1);
  // A clean terminal row (done) is NOT drift.
  gradeBet(seedBet({}), 'loss', -1, 'LOSS', 'clean terminal');
  check('5c: done rows are not counted', countTerminalStateDrift().total === after.total);
  // 'archived' is terminal per mig 016 policy ('done' ↔ won/lost/pushed/voided/
  // ARCHIVED): a drifted row flipped by the legacy !reset_season archive must not
  // silently LEAVE the count (the tripwire's "growing count = regression" reading
  // breaks if archiving shrinks it without healing anything).
  const aId = seedBet({
    result: 'archived', profit_units: -1, grade: 'LOSS', graded_at: '2026-07-02 00:00:00',
    grading_state: 'ready',
  });
  check('5d: archived drift rows stay counted', countTerminalStateDrift().total === after.total + 1);
  db.prepare('DELETE FROM bets WHERE id IN (?, ?)').run(qId, aId);
}

// ── 7. applyBackoff cannot clobber a terminal row's state ───────────────────
// The write-side dual of the queue filter: runAutoGrade claims a pending bet,
// awaits the AI, and a concurrent handler (manual /grade, celebration/recap
// auto-grade) terminally grades it mid-await (grading_state='done'). The loop
// then calls applyBackoff on the PENDING/throw outcome — without a result gate
// that write would stamp 'backoff'/'quarantined' over the terminal row,
// re-creating the exact drift class this PR closes (same interleaving shape as
// the #118 grader-vs-revert race).
console.log('7. applyBackoff terminal-row guard');
{
  const { applyBackoff } = grading;
  const doneId = seedBet({
    result: 'win', profit_units: 0.91, grade: 'WIN', graded_at: '2026-07-02 00:00:00',
    grading_state: 'done', grading_attempts: 3,
  });
  applyBackoff(doneId, 3, 'ai_pending_after_concurrent_grade');
  const d = rowOf(doneId);
  check("7a: terminal row keeps grading_state='done' (no clobber)", d.grading_state === 'done');
  check('7b: terminal row gets no next attempt', d.grading_next_attempt_at == null);

  // Control: a pending row still backs off normally.
  const pendId = seedBet({ grading_attempts: 3 });
  applyBackoff(pendId, 3, 'transient');
  const p = rowOf(pendId);
  check("7c: pending row still transitions to 'backoff'", p.grading_state === 'backoff');
  check('7d: pending row gets a next attempt', p.grading_next_attempt_at != null);

  // Control: quarantine threshold still works on a pending row.
  const qId2 = seedBet({ grading_attempts: 20 });
  applyBackoff(qId2, 20, 'exhausted');
  check("7e: pending row still quarantines at attempts>=20", rowOf(qId2).grading_state === 'quarantined');
}

// ── 6. PENDING drop-reason classifier — Gate 3 forced-PENDING ───────────────
console.log('6. classifyPendingDropReason (Gate 3 UNVERIFIED_QUOTE)');
{
  // EXACT strings gradeSingleBet builds at the Gate 3 enforce earlyReturn
  // (services/grading.js — `UNVERIFIED_QUOTE: ${g3.detail} — forced PENDING …`)
  // for the two validateEvidenceQuote failure variants.
  const notSubstring = 'UNVERIFIED_QUOTE: evidence_quote is not an exact substring of the evidence — forced PENDING (model claimed WIN). Original: Final score 118-112';
  const missingQuote = 'UNVERIFIED_QUOTE: missing evidence_quote — forced PENDING (model claimed LOSS). Original: ';
  check('6a: quote-not-substring variant → GRADE_QUOTE_UNVERIFIED',
    classifyPendingDropReason(notSubstring) === 'GRADE_QUOTE_UNVERIFIED');
  check('6b: missing-quote variant → GRADE_QUOTE_UNVERIFIED',
    classifyPendingDropReason(missingQuote) === 'GRADE_QUOTE_UNVERIFIED');
  check('6c: no longer the catch-all',
    classifyPendingDropReason(notSubstring) !== 'GRADE_PENDING_UNCLASSIFIED'
    && classifyPendingDropReason(missingQuote) !== 'GRADE_PENDING_UNCLASSIFIED');
  check('6d: GRADE_QUOTE_UNVERIFIED registered in DROP_REASONS',
    DROP_REASONS.includes('GRADE_QUOTE_UNVERIFIED'));

  // Existing prefixes still classify (extraction is behavior-preserving).
  check('6e: pin — no-search-hits prefix unchanged',
    classifyPendingDropReason('No final score found for this game') === 'GRADE_NO_SEARCH_HITS');
  check('6f: pin — too-recent prefix unchanged',
    classifyPendingDropReason('Game has not started yet') === 'GRADE_TOO_RECENT');
  check('6g: Gate 4 OFF_DATE_EVIDENCE now classifies to GRADE_DATE_UNVERIFIED (WC-3 follow-up; full coverage in tests/grace-window-void-deferral.test.js)',
    classifyPendingDropReason('OFF_DATE_EVIDENCE: evidence dated 2026-06-06 outside 2026-06-12±1d — forced PENDING (model claimed WIN)') === 'GRADE_DATE_UNVERIFIED');
  check('6h: pin — unknown evidence falls back to the catch-all',
    classifyPendingDropReason('some novel evidence string') === 'GRADE_PENDING_UNCLASSIFIED');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
