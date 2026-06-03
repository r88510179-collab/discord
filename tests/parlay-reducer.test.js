// ═══════════════════════════════════════════════════════════
// Gate 1 — deterministic parlay reducer (keystone).
//
// reduceParlayResult is the SINGLE source of a parlay's final result. The
// LLM grades legs only; this pure function applies the precedence
// LOSS > PENDING > WIN over the per-leg statuses it returned.
//
// Production bug this closes: a parlay graded WIN while ≥1 leg was never
// confirmed ([1 WIN, 4 PENDING] must be PENDING, never WIN).
//
// Pure functions, no DB. Point DB_PATH at a throwaway file anyway because
// requiring grading.js loads database.js transitively.
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-parlay-reducer-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const database = require('../services/database');
const { reduceParlayResult, normalizeLegStatus } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}

try {
  console.log('parlay-reducer (Gate 1):');

  // ── Truth-table rows (status + reduced flag) ──
  const rows = [
    // [label, legStatuses, expected{status,reduced}]
    ['single LOSS                       -> LOSS',            ['LOSS'],                              { status: 'LOSS', reduced: false }],
    ['LOSS beats PENDING                -> LOSS',            ['LOSS', 'PENDING'],                   { status: 'LOSS', reduced: false }],
    ['LOSS beats WIN+PENDING            -> LOSS',            ['WIN', 'PENDING', 'LOSS'],            { status: 'LOSS', reduced: false }],
    ['single PENDING                    -> PENDING',         ['PENDING'],                           { status: 'PENDING', reduced: false }],
    ['PENDING blocks WIN (THE INVARIANT)-> PENDING',         ['WIN', 'PENDING'],                    { status: 'PENDING', reduced: false }],
    ['all WIN                           -> WIN',             ['WIN', 'WIN', 'WIN'],                 { status: 'WIN', reduced: false }],
    ['WIN + dropped VOID                -> WIN reduced',     ['WIN', 'VOID'],                       { status: 'WIN', reduced: true }],
    ['WIN + dropped PUSH                -> WIN reduced',     ['WIN', 'PUSH'],                       { status: 'WIN', reduced: true }],
    ['all VOID                          -> VOID',            ['VOID', 'VOID'],                      { status: 'VOID', reduced: false }],
    ['all VOID/PUSH                     -> VOID',            ['VOID', 'PUSH'],                      { status: 'VOID', reduced: false }],
  ];
  for (const [label, statuses, expected] of rows) {
    check(label, reduceParlayResult(statuses), expected);
  }

  // ── Required regression cases from the spec ──
  check('[1 WIN, 4 PENDING, 0 LOSS] -> PENDING (the production bug)',
    reduceParlayResult(['WIN', 'PENDING', 'PENDING', 'PENDING', 'PENDING']),
    { status: 'PENDING', reduced: false });

  check('[1 LOSS, rest PENDING] -> LOSS',
    reduceParlayResult(['LOSS', 'PENDING', 'PENDING', 'PENDING']),
    { status: 'LOSS', reduced: false });

  check('[all WIN] -> WIN',
    reduceParlayResult(['WIN', 'WIN']),
    { status: 'WIN', reduced: false });

  check('[2 WIN, 1 VOID] -> WIN reduced',
    reduceParlayResult(['WIN', 'WIN', 'VOID']),
    { status: 'WIN', reduced: true });

  // ── Invariant: a leg not explicitly WIN/LOSS/PUSH/VOID is PENDING and never
  // counts toward a WIN. null / undefined / unknown strings normalize to
  // PENDING. ──
  check('normalizeLegStatus: null -> PENDING',      normalizeLegStatus(null),        'PENDING');
  check('normalizeLegStatus: undefined -> PENDING', normalizeLegStatus(undefined),   'PENDING');
  check('normalizeLegStatus: "" -> PENDING',        normalizeLegStatus(''),          'PENDING');
  check('normalizeLegStatus: "unknown" -> PENDING', normalizeLegStatus('unknown'),   'PENDING');
  check('normalizeLegStatus: lowercase "win" -> WIN', normalizeLegStatus('win'),     'WIN');
  check('normalizeLegStatus: " Loss " -> LOSS',     normalizeLegStatus(' Loss '),    'LOSS');

  check('[WIN, null] -> PENDING (null leg never counts toward WIN)',
    reduceParlayResult(['WIN', null]),
    { status: 'PENDING', reduced: false });

  check('[WIN, "garbage"] -> PENDING (unknown leg never counts toward WIN)',
    reduceParlayResult(['WIN', 'garbage']),
    { status: 'PENDING', reduced: false });

  check('empty leg list -> PENDING (fail-safe)',
    reduceParlayResult([]),
    { status: 'PENDING', reduced: false });

  // Exhaustive: WIN must NEVER be returned when any leg normalizes to PENDING.
  const FINAL = ['WIN', 'LOSS', 'PUSH', 'VOID'];
  const NONFINAL = [null, undefined, '', 'unknown', 'pending', 'PENDING'];
  let invariantHolds = true;
  for (const f of FINAL) {
    for (const nf of NONFINAL) {
      const r = reduceParlayResult([f, nf, 'WIN']);
      if (r.status === 'WIN') { invariantHolds = false; console.log(`    invariant broke on [${f}, ${nf}, WIN] -> ${r.status}`); }
    }
  }
  check('INVARIANT: no [final, non-final, WIN] combo ever yields WIN', invariantHolds, true);

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('Parlay reducer (Gate 1) validation passed.');
} finally {
  try { database.db.close(); } catch (_) {}
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
}
