// ═══════════════════════════════════════════════════════════
// scripts/regrade-export.js
//
// Phase 1 of the Grading Reconciliation Project (see docs/BACKLOG.md
// "Grading Reconciliation Project"). Reads all graded bets
// (result IN win|loss|push|void) from the database, splits them
// into batches of 50, and writes each batch as a JSON file under
// ./regrade-exports/. Also records one row per batch in
// `regrade_batches` for import-side tracking.
//
// Usage:
//   node scripts/regrade-export.js
//   node scripts/regrade-export.js --dry-run
//   node scripts/regrade-export.js --force
//   node scripts/regrade-export.js --db /path/to.db --out ./out
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 50;
const PROMPT_VERSION = 'v1';
const DEFAULT_OUT_DIR = './regrade-exports';

function parseArgs(argv) {
  const args = {
    force: false,
    dryRun: false,
    dbPath: null,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--db') args.dbPath = argv[++i];
    else if (a === '--out') args.outDir = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function resolveDbPath(explicit) {
  if (explicit) return explicit;
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const prod = '/data/bettracker.db';
  if (fs.existsSync(prod)) return prod;
  return './bettracker.db';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildBatchRow(row) {
  return {
    bet_id: row.id,
    capper: {
      id: row.capper_id || null,
      display_name: row.capper_display_name || null,
      twitter_handle: row.capper_handle || null,
    },
    sport: row.sport || null,
    league: row.league || null,
    bet_type: row.bet_type || null,
    description: row.description || null,
    odds: row.odds ?? null,
    units: row.units ?? null,
    original_result: row.result || null,
    original_profit_units: row.profit_units ?? null,
    event_date: row.event_date || null,
    created_at: row.created_at || null,
    source: row.source || null,
    source_url: row.source_url || null,
    source_tweet_handle: row.source_tweet_handle || null,
  };
}

function dateRangeOfBatch(batch) {
  if (!batch.length) return { first: null, last: null };
  const first = batch[0].created_at || batch[0].event_date || 'unknown';
  const last = batch[batch.length - 1].created_at || batch[batch.length - 1].event_date || 'unknown';
  return { first: String(first).slice(0, 10), last: String(last).slice(0, 10) };
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDbPath(args.dbPath);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error(`Failed to load better-sqlite3: ${err.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: false });
  } catch (err) {
    console.error(`Failed to open database ${dbPath}: ${err.message}`);
    process.exit(1);
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        b.id, b.capper_id, b.sport, b.league, b.bet_type, b.description,
        b.odds, b.units, b.result, b.profit_units, b.grade, b.grade_reason,
        b.event_date, b.created_at, b.source, b.source_url, b.source_tweet_handle,
        c.display_name AS capper_display_name, c.twitter_handle AS capper_handle
      FROM bets b
      LEFT JOIN cappers c ON c.id = b.capper_id
      WHERE b.result IN ('win', 'loss', 'push', 'void')
      ORDER BY b.created_at ASC
    `).all();
  } catch (err) {
    console.error(`Query failed: ${err.message}`);
    db.close();
    process.exit(1);
  }

  const totalBets = rows.length;
  const batchCount = Math.ceil(totalBets / BATCH_SIZE);

  if (totalBets === 0) {
    console.log('No eligible bets found (result IN win|loss|push|void). Nothing to export.');
    db.close();
    return;
  }

  const batches = [];
  for (let i = 0; i < batchCount; i++) {
    const slice = rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    batches.push({
      batchId: `batch_${pad2(i + 1)}`,
      fileName: `regrade_batch_${pad2(i + 1)}.json`,
      bets: slice,
    });
  }

  if (args.dryRun) {
    console.log(`[dry-run] Would export ${totalBets} bets in ${batchCount} batches to ${args.outDir}/`);
    for (const b of batches) {
      const { first, last } = dateRangeOfBatch(b.bets);
      console.log(`  ${b.fileName} — ${b.bets.length} bets (${first} to ${last})`);
    }
    console.log('[dry-run] No files written, no DB rows inserted.');
    db.close();
    return;
  }

  if (!fs.existsSync(args.outDir)) {
    try {
      fs.mkdirSync(args.outDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create output directory ${args.outDir}: ${err.message}`);
      db.close();
      process.exit(1);
    }
  }

  const exportedAt = new Date().toISOString();
  const written = [];
  const skipped = [];

  for (const b of batches) {
    const outPath = path.join(args.outDir, b.fileName);
    if (fs.existsSync(outPath) && !args.force) {
      console.warn(`[skip] ${outPath} already exists (use --force to overwrite)`);
      skipped.push(b);
      continue;
    }

    const payload = {
      batch_id: b.batchId,
      prompt_version: PROMPT_VERSION,
      exported_at: exportedAt,
      bet_count: b.bets.length,
      bets: b.bets.map(buildBatchRow),
    };

    const tmpPath = `${outPath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore cleanup failure */ }
      }
      console.error(`Failed to write ${outPath}: ${err.message}`);
      db.close();
      process.exit(1);
    }
    written.push(b);
  }

  const insertBatch = db.prepare(`
    INSERT OR IGNORE INTO regrade_batches (batch_id, bet_count, prompt_version)
    VALUES (?, ?, ?)
  `);
  const recordBatches = db.transaction((list) => {
    for (const b of list) {
      insertBatch.run(b.batchId, b.bets.length, PROMPT_VERSION);
    }
  });
  try {
    recordBatches(batches);
  } catch (err) {
    console.error(`Failed to record batches in regrade_batches: ${err.message}`);
    db.close();
    process.exit(1);
  }

  console.log(`✅ Exported ${totalBets} bets in ${batchCount} batches to ${args.outDir}/`);
  for (const b of batches) {
    const { first, last } = dateRangeOfBatch(b.bets);
    const tag = written.includes(b) ? '' : ' [skipped: already exists]';
    console.log(`  ${b.fileName} — ${b.bets.length} bets (${first} to ${last})${tag}`);
  }
  if (skipped.length) {
    console.log(`(${skipped.length} existing file(s) left untouched — re-run with --force to overwrite)`);
  }

  db.close();
}

main();
