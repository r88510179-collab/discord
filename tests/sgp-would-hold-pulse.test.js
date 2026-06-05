// ═══════════════════════════════════════════════════════════
// sgpWouldHoldPulse.formatSgpWouldHold unit tests — the pure formatter behind
// the throwaway #bot-audits SGP would-hold pulse line (PR #43 visibility).
//
// Pure function: no DB, no network, no env. Rows mirror the shape returned by
// SGP_WOULD_HOLD_SQL (json_extract '$.pass' yields integer 1/0; '$.reason' the
// SgpGateReason code; count(*) AS c).
//
// Run:  node tests/sgp-would-hold-pulse.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const { formatSgpWouldHold } = require('../services/sgpWouldHoldPulse');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

// The prompt's worked example: 18 events, PASS 12 (12/18 = 66.6% → 67%),
// FAIL 6 broken down by reason, ordered by count desc.
run('rows → compact PASS/FAIL line with fail-reason breakdown', () => {
  const rows = [
    { pass: 1, reason: 'SGP_PASS', c: 12 },
    { pass: 0, reason: 'SGP_NO_DECLARED_COUNT', c: 4 },
    { pass: 0, reason: 'SGP_COUNT_MISMATCH', c: 2 },
  ];
  assert.strictEqual(
    formatSgpWouldHold(rows),
    'SGP would-hold (7d): 18 events · PASS 12 (67%) · FAIL 6 — SGP_NO_DECLARED_COUNT 4, SGP_COUNT_MISMATCH 2',
  );
});

run('0 rows → none yet (visibly wired, waiting)', () => {
  assert.strictEqual(formatSgpWouldHold([]), 'SGP would-hold (7d): none yet');
  assert.strictEqual(formatSgpWouldHold(undefined), 'SGP would-hold (7d): none yet');
});

run('all PASS → no FAIL breakdown, FAIL 0', () => {
  assert.strictEqual(
    formatSgpWouldHold([{ pass: 1, reason: 'SGP_PASS', c: 5 }]),
    'SGP would-hold (7d): 5 events · PASS 5 (100%) · FAIL 0',
  );
});

run('all FAIL → PASS 0 (0%), breakdown ordered by count desc', () => {
  assert.strictEqual(
    formatSgpWouldHold([
      { pass: 0, reason: 'SGP_COUNT_MISMATCH', c: 3 },
      { pass: 0, reason: 'SGP_ENTITY_NOT_IN_OCR', c: 7 },
    ]),
    'SGP would-hold (7d): 10 events · PASS 0 (0%) · FAIL 10 — SGP_ENTITY_NOT_IN_OCR 7, SGP_COUNT_MISMATCH 3',
  );
});

run('null/empty reason on a FAIL row → "unknown"', () => {
  assert.strictEqual(
    formatSgpWouldHold([
      { pass: 1, reason: 'SGP_PASS', c: 1 },
      { pass: 0, reason: null, c: 1 },
    ]),
    'SGP would-hold (7d): 2 events · PASS 1 (50%) · FAIL 1 — unknown 1',
  );
});

console.log(`\nsgp-would-hold-pulse: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
