// ═══════════════════════════════════════════════════════════
// SQLite Migration Runner
// Reads .sql files from migrations/ in sorted order.
// Tracks execution in a schema_migrations table so each
// file runs once and only once.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Run all pending migrations against the given better-sqlite3 database.
 * Safe to call on every startup — already-applied files are skipped.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ applied: string[], skipped: string[] }}
 */
function runMigrations(db) {
  // 1. Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // 2. Read already-applied migrations
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations ORDER BY filename')
      .all()
      .map(r => r.filename),
  );

  // 3. Discover .sql files on disk, sorted alphabetically (001_, 002_, …)
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('[Migrator] No migrations/ directory found — skipping.');
    return { applied: [], skipped: [] };
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];
  const skipped = [];

  // 4. Run each pending migration inside a transaction
  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    const applyMigration = db.transaction(() => {
      try {
        db.exec(sql);
      } catch (err) {
        // Tolerate "duplicate column" errors for idempotent ALTER TABLE
        // migrations applied to databases that already have the column
        // from old ad-hoc code.
        const msg = String(err.message || '');
        if (msg.includes('duplicate column name')) {
          console.log(`[Migrator] ${file}: column already exists — skipping SQL (marking as applied).`);
        } else {
          throw err;
        }
      }
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });

    applyMigration();
    newlyApplied.push(file);
    console.log(`[Migrator] Applied: ${file}`);
  }

  if (newlyApplied.length === 0) {
    console.log('[Migrator] Schema is up to date.');
  } else {
    console.log(`[Migrator] Applied ${newlyApplied.length} migration(s).`);
  }

  return { applied: newlyApplied, skipped };
}

module.exports = { runMigrations };
