// ═══════════════════════════════════════════════════════════
// Grader-gate sync — GRADER_ELIGIBLE_WHERE ⇔ GRADER_HIDDEN_REVIEW_STATUSES parity.
//
// WHY THIS EXISTS (#118 hardening):
// The grader-vs-revert race (Codex finding #2, closed by #118) is held shut by
// gating terminal grader WRITES on review_status. That status list is encoded
// TWICE, in two different representations that MUST stay identical:
//   1. services/database.js — `GRADER_HIDDEN_REVIEW_STATUSES` (a JS array): the
//      claim-time / getPendingBets selection exclusion AND the gradeBetRecord
//      `requireGraderEligible` opt-in gate.  (database.js:683)
//   2. services/grading.js — `GRADER_ELIGIBLE_WHERE` (an inline SQL-fragment
//      string `(review_status IS NULL OR review_status NOT IN (...))`): the
//      write-time gate `${GRADER_ELIGIBLE_WHERE}` appended to every terminal
//      void/divert UPDATE — the single source for all of them.  (grading.js:24-25)
//
// (2) is a hardcoded LITERAL, not an import of (1), on purpose: it is built at
// MODULE LOAD time and warRoom → grading → database form a require cycle in which
// a destructured database export can still be `undefined` when grading.js's top
// level runs (see grading.js comment, lines 16-23). An imported constant would be
// undefined; a literal cannot break under require ordering.
//
// The cost of that dodge: NOTHING enforces that the two stay identical. A future
// edit to one and not the other silently diverges the write-time gate from the
// claim-time gate, reopening the #118 race with NO other test failure. This test
// IS that enforcement: it imports BOTH runtime values, extracts the status set
// from the SQL fragment, and asserts set-equality. It goes RED the moment either
// side adds, removes, or renames a status.
//
// It imports the LIVE constants (not source text) so it checks the ACTUAL values
// the gates use at runtime. Exporting a precomputed string/array adds no new
// require(), so it does NOT reintroduce the cycle (2) was inlined to dodge.
//
// Run:  node tests/grader-gate-sync.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Requiring grading.js pulls in database.js, which opens a SQLite DB at DB_PATH.
// Point it at a throwaway temp file so the real production DB is never touched,
// and reject the wire so nothing in the module graph can hit the network.
const dbFile = path.join(os.tmpdir(), `bettracker-grader-gate-sync-${process.pid}.db`);
process.env.DB_PATH = dbFile;
global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

const { GRADER_HIDDEN_REVIEW_STATUSES } = require('../services/database');
const { GRADER_ELIGIBLE_WHERE } = require('../services/grading');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; }
  else { console.log(`  FAIL: ${label}`); fail++; }
}

// 1. Both exports must actually exist in the expected shape. (An accidental
//    export removal must fail loudly, not silently make the parity check vacuous.)
ok('database.js exports GRADER_HIDDEN_REVIEW_STATUSES (non-empty array)',
   Array.isArray(GRADER_HIDDEN_REVIEW_STATUSES) && GRADER_HIDDEN_REVIEW_STATUSES.length > 0);
ok('grading.js exports GRADER_ELIGIBLE_WHERE (non-empty string)',
   typeof GRADER_ELIGIBLE_WHERE === 'string' && GRADER_ELIGIBLE_WHERE.length > 0);

// 2. Extract the status set from the SQL fragment.
//    GRADER_ELIGIBLE_WHERE looks like:
//      (review_status IS NULL OR review_status NOT IN ('needs_review', 'manual_review_unmodeled_sport'))
//    Anchor TIGHTLY to the `NOT IN (...)` group, then pull every single-quoted
//    literal inside it. Anchoring (instead of scanning the whole string) means a
//    future `review_status = 'foo'` clause added elsewhere in the fragment cannot
//    leak a non-status literal into the comparison. If the gate ever stops using
//    the `NOT IN (...)` shape, this assert fails — which is correct: the test then
//    demands a human re-confirm the parity invariant against the new shape.
function statusesFromWhere(where) {
  const m = where.match(/NOT\s+IN\s*\(([^)]*)\)/i);
  assert.ok(m, `GRADER_ELIGIBLE_WHERE has no "NOT IN (...)" group: ${where}`);
  const lits = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.ok(lits.length > 0, `no quoted status literals inside NOT IN (...): ${m[1]}`);
  return lits;
}
const fromWhere = statusesFromWhere(GRADER_ELIGIBLE_WHERE);

// 3. The parity assertion — same members, order-independent.
const dbSet = [...GRADER_HIDDEN_REVIEW_STATUSES].sort();
const gradingSet = [...fromWhere].sort();
let parityOk = true;
try {
  assert.deepStrictEqual(gradingSet, dbSet);
} catch (_) {
  parityOk = false;
  console.log('        database.js GRADER_HIDDEN_REVIEW_STATUSES = ' + JSON.stringify(dbSet));
  console.log('        grading.js  GRADER_ELIGIBLE_WHERE statuses = ' + JSON.stringify(gradingSet));
}
ok('GRADER_ELIGIBLE_WHERE and GRADER_HIDDEN_REVIEW_STATUSES are identical sets', parityOk);

// 4. Neither side may carry a duplicate — a dup could mask a real divergence once
//    both are compared as sorted lists (e.g. ['a','a'] vs ['a','b'] both length 2).
ok('GRADER_HIDDEN_REVIEW_STATUSES has no duplicates', new Set(dbSet).size === dbSet.length);
ok('GRADER_ELIGIBLE_WHERE status list has no duplicates', new Set(gradingSet).size === gradingSet.length);

// 5. NULL-tolerance guard — the other half of the #118 invariant. The write-time
//    gate MUST keep the `review_status IS NULL OR ...` form; an `AND review_status
//    != '...'` rewrite would silently EXCLUDE legacy NULL-review rows under
//    SQLite three-valued logic (grading.js comment, line 22).
ok('GRADER_ELIGIBLE_WHERE is NULL-tolerant (keeps "review_status IS NULL")',
   /review_status\s+IS\s+NULL/i.test(GRADER_ELIGIBLE_WHERE));

console.log(`\ngrader-gate-sync: ${pass} passed, ${fail} failed`);
try { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbFile + s)) fs.unlinkSync(dbFile + s); } catch (_) {}
process.exit(fail === 0 ? 0 : 1);
