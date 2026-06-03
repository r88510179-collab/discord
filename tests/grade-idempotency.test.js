// ═══════════════════════════════════════════════════════════
// Gate 2 — idempotent final grades.
//
// A bet's final grade is written once per (bet_id, evidence_hash,
// grader_version). A re-grade carrying the same key returns the stored final
// and does NOT rewrite — closing the "contradictory regrade" bug (the same
// bet graded WIN then LOSS minutes apart).
//
// Part A: pure decision table (decideFinalGradeWrite).
// Part B: DB integration — finalizeBetGrading writes once, second attempt with
//         the same evidence is a no-op (and a flipped status cannot overwrite).
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-grade-idem-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const database = require('../services/database');
const { decideFinalGradeWrite, computeEvidenceHash, GRADER_VERSION } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${expected}\n    actual   ${actual}`); fail++; }
}

async function main() {
  console.log('grade-idempotency (Gate 2):');

  // ── Part A: decision table ──
  const V = 'v1';
  const H = computeEvidenceHash('Final: Celtics 118 Knicks 112');
  const H2 = computeEvidenceHash('Final: Lakers 120 Suns 115');

  check('computeEvidenceHash is stable (same input → same hash)',
    computeEvidenceHash('a  b\nc') === computeEvidenceHash('a b c'), true);
  check('computeEvidenceHash differs on different input', H === H2, false);

  check('no prior row -> write (no_prior_final)',
    decideFinalGradeWrite(null, { evidenceHash: H, graderVersion: V }).reason, 'no_prior_final');
  check('pending row -> write (no_prior_final)',
    decideFinalGradeWrite({ result: 'pending', evidence_hash: null, grader_version: null }, { evidenceHash: H, graderVersion: V }).reason, 'no_prior_final');

  const sameKey = decideFinalGradeWrite({ result: 'win', evidence_hash: H, grader_version: V }, { evidenceHash: H, graderVersion: V });
  check('finalized + same key -> NO write', sameKey.write, false);
  check('finalized + same key reason', sameKey.reason, 'idempotent_same_key');

  check('finalized + evidence changed -> write (evidence_changed)',
    decideFinalGradeWrite({ result: 'win', evidence_hash: H, grader_version: V }, { evidenceHash: H2, graderVersion: V }).reason, 'evidence_changed');

  check('finalized + admin override -> write (admin_override)',
    decideFinalGradeWrite({ result: 'win', evidence_hash: H, grader_version: V }, { evidenceHash: H, graderVersion: V, adminOverride: true }).reason, 'admin_override');

  check('finalized + grader_version bump only (same evidence) -> locked',
    decideFinalGradeWrite({ result: 'win', evidence_hash: H, grader_version: 'old' }, { evidenceHash: H, graderVersion: V }).reason, 'final_grade_locked');

  check('finalized + null prior hash, no override -> locked (not "changed")',
    decideFinalGradeWrite({ result: 'win', evidence_hash: null, grader_version: 'old' }, { evidenceHash: H, graderVersion: V }).reason, 'final_grade_locked');

  // ── Part B: DB integration — write once, second attempt is a no-op ──
  const capper = database.getOrCreateCapper('idem_user', 'Idem User', null);
  const bet = database.createBet({
    capper_id: capper.id,
    sport: 'NBA',
    bet_type: 'straight',
    description: 'Celtics ML',
    odds: -120,
    units: 1,
    source: 'manual',
  });

  const EVIDENCE = 'Final: Boston Celtics 118, New York Knicks 112 per ESPN';

  // First finalize → writes and stamps provenance.
  const first = await grading.finalizeBetGrading(null, bet, 'WIN', EVIDENCE);
  check('first finalize is graded (not idempotent skip)', first.graded !== false, true);

  const afterFirst = database.db.prepare('SELECT result, grade, evidence_hash, grader_version, graded_at FROM bets WHERE id = ?').get(bet.id);
  check('first finalize wrote result=win', afterFirst.result, 'win');
  check('first finalize stamped grader_version', afterFirst.grader_version, GRADER_VERSION);
  check('first finalize stamped evidence_hash', afterFirst.evidence_hash, computeEvidenceHash(EVIDENCE));
  assert.ok(afterFirst.graded_at, 'graded_at should be set');

  // Second finalize, SAME evidence → idempotent no-op (no second write).
  const second = await grading.finalizeBetGrading(null, bet, 'WIN', EVIDENCE);
  check('second finalize (same key) returns idempotent', second.idempotent === true, true);
  check('second finalize did not grade', second.graded, false);

  const afterSecond = database.db.prepare('SELECT result, graded_at FROM bets WHERE id = ?').get(bet.id);
  check('second finalize left result unchanged', afterSecond.result, 'win');
  check('second finalize did NOT rewrite the row (graded_at unchanged)', afterSecond.graded_at, afterFirst.graded_at);

  // Contradictory regrade: flip the status to LOSS but with the SAME evidence.
  // Same (bet_id, evidence_hash, grader_version) → the stored WIN must stand.
  const flipped = await grading.finalizeBetGrading(null, bet, 'LOSS', EVIDENCE);
  check('contradictory regrade (LOSS, same evidence) is rejected', flipped.idempotent === true, true);
  const afterFlip = database.db.prepare('SELECT result FROM bets WHERE id = ?').get(bet.id);
  check('contradictory regrade did NOT flip the stored grade', afterFlip.result, 'win');

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('Grade idempotency (Gate 2) validation passed.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    try { database.db.close(); } catch (_) {}
    try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
  });
