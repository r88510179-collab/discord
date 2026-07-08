// ═══════════════════════════════════════════════════════════
// BetService Stage 2 — pipeline_events idempotency keys
// (PIPELINE_IDEM_MODE, migration 032).
//
// Covers:
//   1. deriveIdempotencyKey determinism + null on missing components
//   2. off        → key not computed, duplicate rows both written,
//                   column NULL, no payload marker (no-op contract)
//   3. shadow     → duplicate DETECTED (payload idem_would_reject +
//                   console marker) but row WRITTEN ANYWAY, column
//                   stays NULL; queryable via json_extract
//   4. enforce    → duplicate silently rejected via mig 032's partial
//                   unique index; NO throw up the call stack
//   5. cross-attempt repeat (grading_attempts bumped) is NOT a
//                   duplicate in any mode
//   6. parlay-leg synthetic id `<parent>-legN` → key uses the
//                   parent's grading_attempts, full leg id in key
//   7. missing bets row → key null → write proceeds un-deduped
//
// Uses the standard test-harness DB pattern (temp DB_PATH set BEFORE
// requiring database) so the migrator builds the real schema incl.
// migration 032 — the enforce tests exercise the actual unique index.
//
// Run:  node tests/pipeline-idem-key.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so the
// migrator (incl. migration 032) runs against a fresh file.
const DB_FILE = path.join(os.tmpdir(), `pipeline-idem-key-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
delete process.env.PIPELINE_IDEM_MODE; // start every run from 'off'

const pe = require('../services/pipeline-events');
const bets = require('../services/bets');
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

// ── fixtures ─────────────────────────────────────────────────
function makeBet(id, attempts) {
  db.prepare(
    "INSERT INTO bets (id, description, grading_attempts) VALUES (?, 'Test bet — idem key', ?)"
  ).run(id, attempts);
}
function setAttempts(id, attempts) {
  db.prepare('UPDATE bets SET grading_attempts = ? WHERE id = ?').run(attempts, id);
}
function rowsForBet(betId) {
  return db.prepare(
    "SELECT id, drop_reason, payload, idempotency_key FROM pipeline_events WHERE bet_id = ? ORDER BY id"
  ).all(betId);
}
function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = original; }
  return lines;
}
function dropFor(betId, extra = {}) {
  return bets.recordDrop({
    betId,
    stage: 'GRADING_DROPPED',
    dropReason: 'GRADE_NO_SEARCH_HITS',
    payload: { where: 'idem-key-test', ...extra },
  });
}

// ── 1. key derivation ────────────────────────────────────────
run('deriveIdempotencyKey is deterministic for identical inputs', () => {
  const input = { betId: 'abc123', attempts: 3, stage: 'GRADING_AI', eventType: 'DROP', dropReason: 'GRADE_TOO_RECENT' };
  const a = pe.deriveIdempotencyKey(input);
  const b = pe.deriveIdempotencyKey({ ...input });
  assert.strictEqual(typeof a, 'string');
  assert.strictEqual(a, b, 'same inputs must produce the same key');
});

run('deriveIdempotencyKey varies with each component', () => {
  const base = { betId: 'abc123', attempts: 3, stage: 'GRADING_AI', eventType: 'DROP', dropReason: 'GRADE_TOO_RECENT' };
  const key = pe.deriveIdempotencyKey(base);
  assert.notStrictEqual(pe.deriveIdempotencyKey({ ...base, attempts: 4 }), key, 'attempts must change the key');
  assert.notStrictEqual(pe.deriveIdempotencyKey({ ...base, betId: 'abc123-leg1' }), key, 'betId must change the key');
  assert.notStrictEqual(pe.deriveIdempotencyKey({ ...base, stage: 'GRADING_DROPPED' }), key, 'stage must change the key');
  assert.notStrictEqual(pe.deriveIdempotencyKey({ ...base, dropReason: 'GRADE_NO_SEARCH_HITS' }), key, 'dropReason must change the key');
});

run('deriveIdempotencyKey returns null on missing identifying components', () => {
  assert.strictEqual(pe.deriveIdempotencyKey({ betId: null, attempts: 1, stage: 'S', eventType: 'DROP' }), null);
  assert.strictEqual(pe.deriveIdempotencyKey({ betId: 'x', attempts: null, stage: 'S', eventType: 'DROP' }), null);
  assert.strictEqual(pe.deriveIdempotencyKey({ betId: 'x', attempts: 1, stage: null, eventType: 'DROP' }), null);
  assert.strictEqual(pe.deriveIdempotencyKey({}), null);
});

run('resolvePipelineIdemMode: strict compare, unset/garbage → off', () => {
  assert.strictEqual(pe.resolvePipelineIdemMode(undefined), 'off');
  assert.strictEqual(pe.resolvePipelineIdemMode('shadow'), 'shadow');
  assert.strictEqual(pe.resolvePipelineIdemMode('enforce'), 'enforce');
  assert.strictEqual(pe.resolvePipelineIdemMode('SHADOW'), 'off', 'strict comparison — no case folding');
  assert.strictEqual(pe.resolvePipelineIdemMode(' shadow '), 'off', 'strict comparison — no trimming');
  assert.strictEqual(pe.resolvePipelineIdemMode('on'), 'off');
});

// ── 2. off: no key computed, duplicates both written ─────────
run('off: duplicate DROPs both written, column NULL, no payload marker', () => {
  delete process.env.PIPELINE_IDEM_MODE;
  makeBet('bet-off-1', 2);
  assert.strictEqual(bets.computeGradingIdemKey({ betId: 'bet-off-1', stage: 'GRADING_DROPPED', eventType: 'DROP', dropReason: 'GRADE_NO_SEARCH_HITS' }), null, 'off must not compute a key');
  dropFor('bet-off-1');
  dropFor('bet-off-1'); // same attempt, same stage/reason — today's duplicate
  const rows = rowsForBet('bet-off-1');
  assert.strictEqual(rows.length, 2, 'off must write both rows (current behavior)');
  for (const r of rows) {
    assert.strictEqual(r.idempotency_key, null, 'off must leave the column NULL');
    assert.ok(!String(r.payload).includes('idem_key'), 'off must not touch the payload');
  }
});

// ── 3. shadow: detect, mark, WRITE ANYWAY ────────────────────
run('shadow: same-attempt duplicate detected via payload key, both rows written, column NULL', () => {
  process.env.PIPELINE_IDEM_MODE = 'shadow';
  makeBet('bet-shadow-1', 5);
  const logs1 = captureLog(() => dropFor('bet-shadow-1'));
  const logs2 = captureLog(() => dropFor('bet-shadow-1'));
  const rows = rowsForBet('bet-shadow-1');
  assert.strictEqual(rows.length, 2, 'shadow must WRITE ANYWAY — both rows land');
  for (const r of rows) assert.strictEqual(r.idempotency_key, null, 'shadow must keep the COLUMN NULL (index must not reject measured duplicates)');
  const p1 = JSON.parse(rows[0].payload);
  const p2 = JSON.parse(rows[1].payload);
  assert.ok(p1.idem_key, 'first shadow row must carry idem_key in payload');
  assert.strictEqual(p1.idem_key, p2.idem_key, 'both writes must derive the same key');
  assert.ok(!p1.idem_would_reject, 'first write is not a duplicate');
  assert.strictEqual(p2.idem_would_reject, true, 'second write must carry the would-reject marker');
  assert.ok(!logs1.some(l => l.includes('would-reject')), 'no would-reject log on first write');
  assert.ok(logs2.some(l => l.includes('would-reject')), 'would-reject console marker on duplicate');
});

run('shadow: would-reject rate is SQL-queryable via json_extract', () => {
  const c = db.prepare(`
    SELECT COUNT(*) AS c FROM pipeline_events
     WHERE event_type = 'DROP'
       AND json_extract(payload, '$.idem_would_reject') = 1
  `).get().c;
  assert.ok(c >= 1, 'operator shadow-review query must find the marked duplicate');
});

run('shadow: cross-attempt repeat is NOT flagged', () => {
  process.env.PIPELINE_IDEM_MODE = 'shadow';
  makeBet('bet-shadow-2', 3);
  dropFor('bet-shadow-2');
  setAttempts('bet-shadow-2', 4); // next grading attempt (claimBetForGrading increments)
  const logs = captureLog(() => dropFor('bet-shadow-2'));
  const rows = rowsForBet('bet-shadow-2');
  assert.strictEqual(rows.length, 2);
  const p2 = JSON.parse(rows[1].payload);
  assert.ok(!p2.idem_would_reject, 'a repeat on a later attempt is a legitimate event — must not be flagged');
  assert.ok(!logs.some(l => l.includes('would-reject')), 'no would-reject log for a cross-attempt repeat');
  assert.notStrictEqual(JSON.parse(rows[0].payload).idem_key, p2.idem_key, 'attempt bump must change the key');
});

// ── 4. enforce: duplicate rejected silently ──────────────────
run('enforce: first write lands with the column populated', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  makeBet('bet-enf-1', 7);
  const ok = dropFor('bet-enf-1');
  assert.strictEqual(ok, true, 'recordDrop must report success');
  const rows = rowsForBet('bet-enf-1');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].idempotency_key, 'enforce must populate the column');
  assert.strictEqual(JSON.parse(rows[0].payload).idem_key, rows[0].idempotency_key, 'payload mirror must match the column');
});

run('enforce: same-attempt duplicate rejected — no second row, NO throw', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  let threw = null;
  let logs = [];
  try {
    logs = captureLog(() => dropFor('bet-enf-1'));
  } catch (e) { threw = e; }
  assert.strictEqual(threw, null, 'rejection must NEVER throw up the call stack');
  assert.strictEqual(rowsForBet('bet-enf-1').length, 1, 'duplicate insert must be rejected by the unique index');
  assert.ok(logs.some(l => l.includes('idem enforce rejected duplicate')), 'rejection must be logged');
});

run('enforce: cross-attempt repeat writes a second row', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  setAttempts('bet-enf-1', 8);
  dropFor('bet-enf-1');
  const rows = rowsForBet('bet-enf-1');
  assert.strictEqual(rows.length, 2, 'attempt bump → new key → row must be written');
  assert.notStrictEqual(rows[0].idempotency_key, rows[1].idempotency_key);
});

run('enforce: different drop_reason within the same attempt is NOT a duplicate', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  makeBet('bet-enf-2', 1);
  dropFor('bet-enf-2');
  bets.recordDrop({ betId: 'bet-enf-2', stage: 'GRADING_DROPPED', dropReason: 'GRADE_TOO_RECENT', payload: { where: 'idem-key-test' } });
  assert.strictEqual(rowsForBet('bet-enf-2').length, 2, 'distinct reasons are distinct logical events');
});

// ── 5. parlay-leg synthetic ids ──────────────────────────────
run('parlay-leg id `<parent>-legN` keys off the PARENT grading_attempts', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  makeBet('parent-1', 4); // legs have no bets row — only the parent
  assert.strictEqual(bets.readGradingAttemptsForKey('parent-1-leg1'), 4, 'leg id must fall back to the parent row');
  dropFor('parent-1-leg1');
  dropFor('parent-1-leg2'); // sibling leg, same attempt/stage/reason — distinct betId → distinct key
  dropFor('parent-1-leg1'); // true duplicate of leg1
  assert.strictEqual(rowsForBet('parent-1-leg1').length, 1, 'duplicate leg drop must be rejected');
  assert.strictEqual(rowsForBet('parent-1-leg2').length, 1, 'sibling leg must NOT collide with leg1');
});

// ── 6. missing bets row → no key, write proceeds ─────────────
run('unknown betId (no bets row) → key null, write proceeds un-deduped, no throw', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  assert.strictEqual(bets.readGradingAttemptsForKey('ghost-bet'), null);
  let threw = null;
  try {
    dropFor('ghost-bet');
    dropFor('ghost-bet');
  } catch (e) { threw = e; }
  assert.strictEqual(threw, null, 'missing row must never throw');
  const rows = rowsForBet('ghost-bet');
  assert.strictEqual(rows.length, 2, 'un-keyable writes fall back to current behavior');
  for (const r of rows) assert.strictEqual(r.idempotency_key, null);
});

// ── 7. non-DROP grading writes are never keyed ───────────────
run('non-DROP transitionTo (telemetry) is never keyed in any mode', () => {
  process.env.PIPELINE_IDEM_MODE = 'enforce';
  makeBet('bet-telemetry-1', 2);
  // Mirrors emitEventAwareShadow: same bet, same attempt, repeated
  // per-poll telemetry — every row must land (repeats ARE the signal).
  for (let i = 0; i < 3; i++) {
    bets.transitionTo({ betId: 'bet-telemetry-1', toStage: 'GRADING_ENTER', eventType: 'event_aware_shadow', payload: { kind: 'would_defer', poll: i } });
  }
  const rows = rowsForBet('bet-telemetry-1');
  assert.strictEqual(rows.length, 3, 'per-poll telemetry repeats must all be written');
  for (const r of rows) assert.strictEqual(r.idempotency_key, null);
});

// ── 8. migration shape ───────────────────────────────────────
run('migration 032: column exists, partial unique index only constrains non-NULL keys', () => {
  const cols = db.prepare("PRAGMA table_info(pipeline_events)").all().map(c => c.name);
  assert.ok(cols.includes('idempotency_key'), 'idempotency_key column missing');
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_pipeline_events_idem_key'").get();
  assert.ok(idx && /WHERE idempotency_key IS NOT NULL/i.test(idx.sql), 'partial unique index missing or unqualified');
  // NULL keys never collide — two NULL-key rows already proven above (off/shadow tests).
});

// ── cleanup ──────────────────────────────────────────────────
delete process.env.PIPELINE_IDEM_MODE;
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\npipeline-idem-key: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
