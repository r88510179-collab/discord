// Tests for the parlay trusted-LOSS short-circuit + leg-explosion guard
// (Bug A, 2026-05-14). Exercises isTrustedLossLeg and
// aggregateParlayLegResults — both pure, both exported via _internal.
//
// The trusted-LOSS short-circuit lets a parlay settle LOSS as soon as one
// leg has a TRUSTED losing result, instead of waiting weeks for an
// ungradeable leg and voiding via the retry cap. Untrusted LOSS evidence
// (cross-sport contamination — see commit 42a2296) still falls through to
// PENDING-blocks-LOSS.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the DB at a throwaway file BEFORE requiring grading.js (it loads
// database.js transitively). These tests never touch the DB — they only
// call the two pure functions — but this keeps the real DB untouched.
const dbFile = path.join(os.tmpdir(), `bettracker-parlay-shortcircuit-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const database = require('../services/database');
const { isTrustedLossLeg, aggregateParlayLegResults } = grading._internal;

// Real same-sport final-score evidence for an NBA leg.
const TRUSTED_NBA_EVIDENCE = 'boston celtics 93, philadelphia 76ers 106 (Final per ESPN)';
// The repro: NBA score text returned as "evidence" for an MLB parlay leg.
const CROSS_SPORT_EVIDENCE = 'Final score Thunder 146-111 Jazz';

function runIsTrustedLossLegChecks() {
  assert.strictEqual(
    isTrustedLossLeg({ description: 'Boston Celtics ML' }, TRUSTED_NBA_EVIDENCE, 'NBA'),
    true,
    'real same-sport final-score evidence should be trusted',
  );
  assert.strictEqual(
    isTrustedLossLeg({ description: 'Aaron Judge total bases over 1.5' }, CROSS_SPORT_EVIDENCE, 'MLB'),
    false,
    'NBA score text on an MLB leg should be rejected as cross-sport contamination',
  );
  assert.strictEqual(
    isTrustedLossLeg({ description: 'Aaron Judge total bases over 1.5' }, 'Player [Aaron Judge] not in evidence', 'MLB'),
    false,
    'prop-guard-tripped evidence should be untrusted',
  );
  assert.strictEqual(
    isTrustedLossLeg({ description: 'Over 215.5' }, 'No final score found', 'NBA'),
    false,
    'placeholder "no final score" evidence should be untrusted',
  );
  assert.strictEqual(isTrustedLossLeg({ description: 'x' }, '', 'NBA'), false, 'empty evidence is untrusted');
  assert.strictEqual(isTrustedLossLeg({ description: 'x' }, null, 'NBA'), false, 'null evidence is untrusted');

  console.log('  isTrustedLossLeg: trusted / cross-sport / guard-tripped / placeholder / empty / null — all pass');
}

function runShortCircuitChecks() {
  // Scenario 1: trusted LOSS leg + a PENDING leg → short-circuits to LOSS.
  const s1 = aggregateParlayLegResults(
    [
      { leg: { description: 'Boston Celtics ML' }, status: 'LOSS', evidence: TRUSTED_NBA_EVIDENCE },
      { leg: { description: 'Over 215.5' }, status: 'PENDING', evidence: 'No final score found' },
    ],
    [{}, {}],
    { description: '• Boston Celtics ML\n• Over 215.5', sport: 'NBA' },
  );
  assert.strictEqual(s1.status, 'LOSS', 'scenario 1: trusted LOSS leg should short-circuit the parlay to LOSS');
  assert.ok(/leg 1/.test(s1.evidence), 'scenario 1: evidence should name the losing leg');
  console.log(`  scenario 1 (trusted LOSS + PENDING) → ${s1.status}: "${s1.evidence.split('\n')[0]}"`);

  // Scenario 2: cross-sport (untrusted) LOSS leg + PENDING leg → falls
  // through to PENDING-blocks-LOSS; NO short-circuit.
  const s2 = aggregateParlayLegResults(
    [
      { leg: { description: 'Aaron Judge total bases over 1.5' }, status: 'LOSS', evidence: CROSS_SPORT_EVIDENCE },
      { leg: { description: 'Shohei Ohtani home runs over 0.5' }, status: 'PENDING', evidence: 'No final score found' },
    ],
    [{}, {}],
    { description: '• Aaron Judge total bases over 1.5\n• Shohei Ohtani home runs over 0.5', sport: 'MLB' },
  );
  assert.strictEqual(s2.status, 'PENDING', 'scenario 2: untrusted (cross-sport) LOSS leg must NOT short-circuit');
  assert.ok(!/LEG_EXPLOSION_GUARD/.test(s2.evidence), 'scenario 2: should be a plain PENDING, not the explosion guard');
  console.log(`  scenario 2 (cross-sport LOSS + PENDING) → ${s2.status}: "${s2.evidence.split('\n')[0]}"`);

  // Scenario 3: leg-explosion (5 bullets, 11 legs) → PENDING with the
  // explosion guard, even though leg 1 is a trusted LOSS.
  const explodedLegResults = [
    { leg: { description: 'Boston Celtics ML' }, status: 'LOSS', evidence: TRUSTED_NBA_EVIDENCE },
  ];
  for (let i = 2; i <= 11; i++) {
    explodedLegResults.push({ leg: { description: `Leg ${i}` }, status: 'PENDING', evidence: 'No final score found' });
  }
  const s3 = aggregateParlayLegResults(
    explodedLegResults,
    new Array(11).fill({}),
    { description: '• a\n• b\n• c\n• d\n• e', sport: 'NBA' },
  );
  assert.strictEqual(s3.status, 'PENDING', 'scenario 3: exploded parlay should stay PENDING despite a trusted LOSS leg');
  assert.ok(/LEG_EXPLOSION_GUARD/.test(s3.evidence), 'scenario 3: evidence should carry the explosion guard marker');
  assert.ok(/legs\.length=11/.test(s3.evidence), 'scenario 3: evidence should report the actual leg count');
  console.log(`  scenario 3 (5 bullets, 11 legs) → ${s3.status}: "${s3.evidence.split('\n')[0]}"`);

  // Regression: an all-WIN parlay still resolves WIN.
  const sWin = aggregateParlayLegResults(
    [
      { leg: { description: 'Boston Celtics ML' }, status: 'WIN', evidence: TRUSTED_NBA_EVIDENCE },
      { leg: { description: 'Over 215.5' }, status: 'WIN', evidence: 'final 230' },
    ],
    [{}, {}],
    { description: '• Boston Celtics ML\n• Over 215.5', sport: 'NBA' },
  );
  assert.strictEqual(sWin.status, 'WIN', 'regression: all-WIN parlay should resolve WIN');

  // Regression: trusted LOSS with no PENDING legs still resolves LOSS.
  const sLossResolved = aggregateParlayLegResults(
    [
      { leg: { description: 'Boston Celtics ML' }, status: 'LOSS', evidence: TRUSTED_NBA_EVIDENCE },
      { leg: { description: 'Over 215.5' }, status: 'WIN', evidence: 'final 230' },
    ],
    [{}, {}],
    { description: '• Boston Celtics ML\n• Over 215.5', sport: 'NBA' },
  );
  assert.strictEqual(sLossResolved.status, 'LOSS', 'regression: LOSS + WIN (no PENDING) should resolve LOSS');
  console.log('  regression: all-WIN → WIN, LOSS+WIN (no pending) → LOSS — pass');
}

try {
  runIsTrustedLossLegChecks();
  runShortCircuitChecks();
  console.log('Parlay LOSS short-circuit validation passed.');
} finally {
  try { database.db.close(); } catch (_) {}
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
}
