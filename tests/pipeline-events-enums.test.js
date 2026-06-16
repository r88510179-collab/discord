// ═══════════════════════════════════════════════════════════
// pipeline-events enum-drift tests (F-04 + F-05).
//
// F-04: the post-Vision indeterminate branch drops with reason
//       PRE_FILTER_AI_EMPTY_RESULT, which used to be absent from
//       DROP_REASONS — anything keyed on the canonical list missed it.
// F-05: writeRow now carries a SOFT validation tripwire — an off-list
//       stage/event/drop/source value logs one warn line, then the row
//       is written ANYWAY. It must never throw and never skip the insert.
//
// Uses the standard test-harness DB pattern (temp DB_PATH set BEFORE
// requiring database/pipeline-events) so writeRow's insert actually runs
// and we can prove the row landed despite drift.
//
// Run:  node tests/pipeline-events-enums.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so the migrator
// builds a fresh pipeline_events table we can insert into and read back.
const DB_FILE = path.join(os.tmpdir(), `pipeline-events-enums-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const pe = require('../services/pipeline-events');
const { db } = require('../services/database');

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

function countRows() {
  return db.prepare('SELECT COUNT(*) AS c FROM pipeline_events').get().c;
}

// Capture console.warn lines emitted while running fn (always restores).
function captureWarn(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

// ── (a) registration: every value registered for F-04/F-05 is present ──
run('PRE_FILTER_AI_EMPTY_RESULT is registered in DROP_REASONS (F-04)', () => {
  assert.ok(
    pe.DROP_REASONS.includes('PRE_FILTER_AI_EMPTY_RESULT'),
    'PRE_FILTER_AI_EMPTY_RESULT missing from DROP_REASONS',
  );
});

run('every F-04/F-05 registered value is in its enum', () => {
  for (const reason of ['PRE_FILTER_AI_EMPTY_RESULT', 'TEXT_EXTRACTION_FAILED', 'VALIDATOR_LEG_SHAPE_INVALID']) {
    assert.ok(pe.DROP_REASONS.includes(reason), `${reason} missing from DROP_REASONS`);
  }
  assert.ok(pe.STAGES.includes('MANUAL_REVIEW_RELEASED'), 'MANUAL_REVIEW_RELEASED missing from STAGES');
});

// GUARD 5 heuristic-drop reason (incident 2026-06-11). Registered so the
// warn-only write-boundary tripwire stays quiet and dashboards can key on it.
run('GUARD5_INSUFFICIENT_SIGNALS is registered in DROP_REASONS', () => {
  assert.ok(
    pe.DROP_REASONS.includes('GUARD5_INSUFFICIENT_SIGNALS'),
    'GUARD5_INSUFFICIENT_SIGNALS missing from DROP_REASONS',
  );
});

// F17 (audit 2026-06-16): the relay-image vision path returned on a recap/result
// classification without recording any terminal event. These three drop reasons make
// each silent exit queryable and DISTINCT from a genuine extraction failure. Registered
// so the warn-only write-boundary tripwire stays quiet when the call sites emit them.
run('F17 vision-recap drop reasons are registered in DROP_REASONS', () => {
  for (const reason of ['VISION_RESULT_RECAP', 'VISION_UNTRACKED_WIN', 'VISION_TICKET_RECAP']) {
    assert.ok(pe.DROP_REASONS.includes(reason), `${reason} missing from DROP_REASONS`);
  }
});

// Hold-recovery retry-cap marker (services/holdReview.js): one row per
// vision-burning failed recovery attempt; COUNT(*) per ingest is the cap
// counter. Registered so the tripwire stays quiet on every failed attempt.
run('RECOVERY_ATTEMPT_FAILED is registered in STAGES', () => {
  assert.ok(
    pe.STAGES.includes('RECOVERY_ATTEMPT_FAILED'),
    'RECOVERY_ATTEMPT_FAILED missing from STAGES',
  );
});

// ── (b) drift: unknown value warns ONCE, does NOT throw, does NOT skip ──
run('unknown stage → warns, does NOT throw, row STILL written', () => {
  const before = countRows();
  let threw = null;
  const warns = captureWarn(() => {
    try {
      pe.writeRow({
        ingestId: 'disc_enumtest_unknown',
        sourceType: 'discord',
        sourceRef: 'enumtest_unknown',
        stage: 'NOT_A_REAL_STAGE_ZZZ',   // <-- drift
        eventType: 'STAGE_ENTER',
        dropReason: null,
        payload: { where: 'enum-drift-test' },
      });
    } catch (e) { threw = e; }
  });
  assert.strictEqual(threw, null, 'writeRow must not throw on enum drift');
  assert.strictEqual(countRows(), before + 1, 'row must be written despite drift (never skip the insert)');
  assert.ok(warns.length >= 1, 'expected at least one warn line on drift');
  assert.ok(
    warns.some(l => l.includes('stage') && l.includes('NOT_A_REAL_STAGE_ZZZ')),
    `warn must name the field and value; got: ${warns.join(' | ')}`,
  );
  assert.ok(
    warns.some(l => l.includes('enum-drift-test')),
    `warn should include the caller marker; got: ${warns.join(' | ')}`,
  );
});

run('unknown dropReason → warns, does NOT throw, row STILL written', () => {
  const before = countRows();
  let threw = null;
  const warns = captureWarn(() => {
    try {
      pe.writeRow({
        ingestId: 'disc_enumtest_unknown_drop',
        sourceType: 'discord',
        sourceRef: 'enumtest_unknown_drop',
        stage: 'DROPPED',
        eventType: 'DROP',
        dropReason: 'TOTALLY_BOGUS_REASON_ZZZ',   // <-- drift
        payload: { where: 'enum-drift-test' },
      });
    } catch (e) { threw = e; }
  });
  assert.strictEqual(threw, null, 'writeRow must not throw on enum drift');
  assert.strictEqual(countRows(), before + 1, 'row must be written despite drift');
  assert.ok(
    warns.some(l => l.includes('dropReason') && l.includes('TOTALLY_BOGUS_REASON_ZZZ')),
    `warn must name the dropReason field+value; got: ${warns.join(' | ')}`,
  );
});

// ── (c) all-known values → NO warn, row written ──────────────
run('all-known values → NO warn, row written', () => {
  const before = countRows();
  const warns = captureWarn(() => {
    pe.writeRow({
      ingestId: 'disc_enumtest_known',
      sourceType: 'discord',
      sourceRef: 'enumtest_known',
      stage: 'RECEIVED',
      eventType: 'STAGE_ENTER',
      dropReason: null,
      payload: { where: 'enum-drift-test' },
    });
  });
  assert.strictEqual(warns.length, 0, `expected no warn for known values; got: ${warns.join(' | ')}`);
  assert.strictEqual(countRows(), before + 1, 'known-value row must be written');
});

run('newly-registered values are accepted with NO warn', () => {
  const warns = captureWarn(() => {
    pe.writeRow({
      ingestId: 'disc_enumtest_registered',
      sourceType: 'discord',
      sourceRef: 'enumtest_registered',
      stage: 'MANUAL_REVIEW_RELEASED',          // newly registered
      eventType: 'STAGE_ENTER',
      dropReason: null,
      payload: { where: 'enum-drift-test' },
    });
    pe.writeRow({
      ingestId: 'disc_enumtest_registered2',
      sourceType: 'discord',
      sourceRef: 'enumtest_registered2',
      stage: 'DROPPED',
      eventType: 'DROP',
      dropReason: 'PRE_FILTER_AI_EMPTY_RESULT',  // newly registered (F-04)
      payload: { where: 'enum-drift-test' },
    });
  });
  assert.strictEqual(warns.length, 0, `registered values must not warn; got: ${warns.join(' | ')}`);
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\npipeline-events-enums: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
