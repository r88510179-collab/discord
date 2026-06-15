// scripts/backfill-sport-casing.js
//
// One-shot, idempotent backfill that normalizes sport-string CASING in the three
// columns that hold a sport label:
//   • bets.sport
//   • grading_audit.sport_out
//   • grading_audit.sport_in   (same write path canonicalizes it — keep them in sync)
//
// It reuses the SHARED canonicalizer (services/sportNormalize.canonicalizeSport)
// — the same map the live write sites use — so the script can never drift from
// production behavior. Acronym leagues stay UPPERCASE (MLB/NBA/NHL/NFL), word
// sports become Title-Case (Soccer/Tennis/…), and any value the map does not
// recognize is left UNCHANGED.
//
// Usage:
//   node scripts/backfill-sport-casing.js            # DRY RUN (read-only) — the default
//   node scripts/backfill-sport-casing.js --apply    # execute the updates in one transaction
//
// On Fly:
//   fly ssh console -a bettracker-discord-bot -C "node /app/scripts/backfill-sport-casing.js"
//   fly ssh console -a bettracker-discord-bot -C "node /app/scripts/backfill-sport-casing.js --apply"
//
// SAFE TO RE-RUN: the operation is idempotent. Every UPDATE is keyed on the exact
// stored (off-casing) value (BINARY collation — case-sensitive), so a second
// --apply finds nothing to change and reports 0 rows. Only the sport column is
// ever touched; no other column is read for the write or modified. Under --apply,
// ALL updates across every column commit in ONE transaction (cross-column atomic).

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { canonicalizeSport } = require('../services/sportNormalize');

// Columns to normalize: [tableName, columnName]. Table/column names are hardcoded
// constants here (never user input), so the interpolation below is injection-safe.
const TARGETS = [
  ['bets', 'sport'],
  ['grading_audit', 'sport_out'],
  ['grading_audit', 'sport_in'],
];

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(table);
}

function columnExists(db, table, col) {
  // PRAGMA table_info takes no bound params; `table` is a hardcoded constant.
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Returns the list of distinct stored values whose canonical casing differs,
// each with its current row count and canonical target. Read-only. A missing
// table OR column is reported as `missing` (skipped) rather than throwing — so
// the script is resilient to schema drift.
function findDivergent(db, table, col) {
  if (!tableExists(db, table) || !columnExists(db, table, col)) return { missing: true, diffs: [] };
  const rows = db.prepare(
    `SELECT ${col} AS val, COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL GROUP BY ${col}`
  ).all();
  const diffs = [];
  for (const { val, n } of rows) {
    const canonical = canonicalizeSport(val);
    if (canonical !== val) diffs.push({ stored: val, canonical, count: n });
  }
  return { missing: false, diffs };
}

// Core routine — operates on an OPEN db handle so it is unit-testable against a
// temp DB. With apply=false it only reads + reports; with apply=true it commits
// EVERY column's UPDATEs in ONE transaction (cross-column atomic). Returns a
// structured summary. Idempotent: re-running after an apply reports 0 divergent
// values (UPDATEs are keyed on the exact stored value under BINARY collation).
function backfillOnce(db, { apply = false, log = console.log } = {}) {
  const perTable = [];

  // Phase 1 — gather divergent values (read-only) and report counts.
  for (const [table, col] of TARGETS) {
    const { missing, diffs } = findDivergent(db, table, col);
    if (missing) {
      log(`── ${table}.${col}: table/column absent, skipped ──\n`);
      perTable.push({ table, col, missing: true, diffs: [], changed: 0 });
      continue;
    }
    const tableTotal = diffs.reduce((s, d) => s + d.count, 0);
    log(`── ${table}.${col}: ${diffs.length} off-casing value(s), ${tableTotal} row(s) ──`);
    if (diffs.length === 0) {
      log('  (already canonical)');
    } else if (!apply) {
      for (const d of diffs) {
        log(`  [WOULD CHANGE] ${JSON.stringify(d.stored)} → ${JSON.stringify(d.canonical)} : ${d.count} row(s)`);
      }
      log(`  subtotal: ${tableTotal} row(s) would change`);
    }
    log('');
    perTable.push({ table, col, missing: false, diffs, changed: 0 });
  }

  // Phase 2 — apply ALL updates in one transaction.
  let grandTotal = perTable.reduce((s, p) => s + p.diffs.reduce((a, d) => a + d.count, 0), 0);
  if (apply) {
    const applyAll = db.transaction(() => {
      let total = 0;
      for (const p of perTable) {
        for (const d of p.diffs) {
          const res = db.prepare(`UPDATE ${p.table} SET ${p.col} = ? WHERE ${p.col} = ?`)
            .run(d.canonical, d.stored);
          log(`  [APPLIED] ${p.table}.${p.col} ${JSON.stringify(d.stored)} → ${JSON.stringify(d.canonical)} : ${res.changes} row(s)`);
          p.changed += res.changes;
          total += res.changes;
        }
      }
      return total;
    });
    grandTotal = applyAll();
    log(`  applied: ${grandTotal} row(s) updated in one transaction\n`);
  }

  return { apply, grandTotal, perTable };
}

function main() {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db');
  const APPLY = process.argv.includes('--apply');

  console.log(`[backfill-sport-casing] DB: ${DB_PATH}`);
  console.log(`[backfill-sport-casing] mode: ${APPLY ? 'APPLY (writable)' : 'DRY RUN (read-only)'}`);
  console.log('');

  const db = new Database(DB_PATH, { readonly: !APPLY });
  let summary;
  try {
    summary = backfillOnce(db, { apply: APPLY });
  } finally {
    db.close();
  }

  console.log(
    APPLY
      ? `[backfill-sport-casing] DONE — ${summary.grandTotal} row(s) updated across ${TARGETS.length} columns. Re-run with --apply to confirm idempotency (expect 0).`
      : `[backfill-sport-casing] DRY RUN — ${summary.grandTotal} row(s) would change across ${TARGETS.length} columns. Re-run with --apply to execute.`
  );
}

if (require.main === module) main();

module.exports = { backfillOnce, findDivergent, tableExists, columnExists, TARGETS, canonicalizeSport };
