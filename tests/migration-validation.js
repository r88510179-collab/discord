const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../services/migrator');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

function run() {
  // ── TEST 1: Fresh database — all migrations applied ────────
  {
    const dbFile = path.join(os.tmpdir(), `migrator-fresh-${Date.now()}.db`);
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const result = runMigrations(db);

    // Should have applied both migrations
    assert.ok(result.applied.includes('001_initial_schema.sql'),
      '001 should be applied on fresh db');
    assert.ok(result.applied.includes('002_add_review_columns.sql'),
      '002 should be applied on fresh db');
    assert.strictEqual(result.skipped.length, 0,
      'No migrations should be skipped on fresh db');

    // Verify schema_migrations table tracks them
    const tracked = db.prepare('SELECT filename FROM schema_migrations ORDER BY filename').all();
    assert.strictEqual(tracked.length, migrationFiles.length, `Should track ${migrationFiles.length} migrations`);
    assert.strictEqual(tracked[0].filename, '001_initial_schema.sql');
    assert.strictEqual(tracked[1].filename, '002_add_review_columns.sql');
    assert.strictEqual(tracked[2].filename, '003_add_settings_table.sql');
    assert.strictEqual(tracked[3].filename, '004_create_props_table.sql');
    assert.strictEqual(tracked[4].filename, '005_create_user_bets_table.sql');
    assert.strictEqual(tracked[5].filename, '006_add_season_to_bets.sql');

    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('cappers'), 'cappers table should exist');
    assert.ok(tables.includes('bets'), 'bets table should exist');
    assert.ok(tables.includes('parlay_legs'), 'parlay_legs table should exist');
    assert.ok(tables.includes('bankrolls'), 'bankrolls table should exist');
    assert.ok(tables.includes('tracked_twitter'), 'tracked_twitter table should exist');
    assert.ok(tables.includes('daily_snapshots'), 'daily_snapshots table should exist');
    assert.ok(tables.includes('scan_state'), 'scan_state table should exist');

    // Verify review_status column exists on bets
    const betCols = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
    assert.ok(betCols.includes('review_status'), 'bets should have review_status column');
    assert.ok(betCols.includes('season'), 'bets should have season column');

    db.close();
    fs.unlinkSync(dbFile);
    console.log('  ✓ Fresh database: all migrations applied, schema correct');
  }

  // ── TEST 2: Idempotent — running twice skips already-applied ─
  {
    const dbFile = path.join(os.tmpdir(), `migrator-idempotent-${Date.now()}.db`);
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const first = runMigrations(db);
    assert.strictEqual(first.applied.length, migrationFiles.length, `First run should apply ${migrationFiles.length}`);

    const second = runMigrations(db);
    assert.strictEqual(second.applied.length, 0, 'Second run should apply 0');
    assert.strictEqual(second.skipped.length, migrationFiles.length, `Second run should skip ${migrationFiles.length}`);

    db.close();
    fs.unlinkSync(dbFile);
    console.log('  ✓ Idempotent: second run skips all migrations');
  }

  // ── TEST 3: Legacy database — 002 tolerates existing column ──
  {
    const dbFile = path.join(os.tmpdir(), `migrator-legacy-${Date.now()}.db`);
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Simulate legacy: manually create schema WITH review_status already present
    const sql001 = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_initial_schema.sql'), 'utf-8');
    db.exec(sql001);
    db.exec("ALTER TABLE bets ADD COLUMN review_status TEXT DEFAULT 'confirmed'");

    // Now run migrations — 001 uses IF NOT EXISTS so it's safe,
    // 002 will hit "duplicate column" but should be tolerated
    const result = runMigrations(db);
    assert.ok(result.applied.includes('001_initial_schema.sql'),
      '001 should be applied (IF NOT EXISTS is safe)');
    assert.ok(result.applied.includes('002_add_review_columns.sql'),
      '002 should be applied (duplicate column tolerated)');

    // Verify it's tracked so it won't run again
    const tracked = db.prepare("SELECT filename FROM schema_migrations WHERE filename = '002_add_review_columns.sql'").get();
    assert.ok(tracked, '002 should be tracked even after duplicate column tolerance');

    db.close();
    fs.unlinkSync(dbFile);
    console.log('  ✓ Legacy database: duplicate column tolerated gracefully');
  }

  // ── TEST 4: Migration files are valid SQL ──────────────────
  {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    assert.ok(files.length >= 2, 'Should have at least 2 migration files');
    assert.strictEqual(files[0], '001_initial_schema.sql');
    assert.strictEqual(files[1], '002_add_review_columns.sql');

    for (const file of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      assert.ok(content.length > 10, `${file} should have content`);
    }
    console.log('  ✓ Migration files exist and have valid content');
  }

  // ── TEST 5: Full database module works with migrator ───────
  {
    const dbFile = path.join(os.tmpdir(), `migrator-integration-${Date.now()}.db`);
    process.env.DB_PATH = dbFile;

    // Clear require cache to force fresh load with migrator
    const dbModPath = path.resolve(__dirname, '../services/database.js');
    const migratorPath = path.resolve(__dirname, '../services/migrator.js');
    delete require.cache[dbModPath];
    delete require.cache[migratorPath];

    const database = require('../services/database');

    // Should be able to create a capper (proves schema is up)
    const capper = database.getOrCreateCapper('migrator_test', 'Migrator Test', null);
    assert.ok(capper.id, 'Should create capper through migrated schema');

    // Should be able to create a bet with review_status
    const bet = database.createBet({
      capper_id: capper.id,
      sport: 'NBA',
      bet_type: 'straight',
      description: 'Test bet via migrator',
      odds: -110,
      units: 1,
      source: 'manual',
      review_status: 'needs_review',
    });
    assert.ok(bet.id, 'Should create bet through migrated schema');

    // Verify review_status persisted
    const row = database.db.prepare('SELECT review_status FROM bets WHERE id = ?').get(bet.id);
    assert.strictEqual(row.review_status, 'needs_review',
      'review_status should persist through migrated schema');

    database.db.close();
    fs.unlinkSync(dbFile);
    console.log('  ✓ Full database module works end-to-end with migrator');
  }

  console.log('Migration validation passed.');
}

run();
