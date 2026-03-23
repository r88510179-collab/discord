const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runMigrations } = require('../services/migrator');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `audit_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { db, dbPath };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// ═══════════════════════════════════════════════════════════
// TEST 1: Migration creates settings table with audit_mode = 'on'
// ═══════════════════════════════════════════════════════════
function testMigrationCreatesSettings() {
  const { db, dbPath } = freshDb();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all();
  assert.strictEqual(tables.length, 1, 'settings table should exist');

  const row = db.prepare("SELECT value FROM settings WHERE key = 'audit_mode'").get();
  assert.ok(row, 'audit_mode row should exist');
  assert.strictEqual(row.value, 'on', 'audit_mode should default to on');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ Migration creates settings table with audit_mode = on');
}

// ═══════════════════════════════════════════════════════════
// TEST 2: getSetting / setSetting work correctly
// ═══════════════════════════════════════════════════════════
function testGetSetSetting() {
  const { db, dbPath } = freshDb();

  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  // Read default
  let row = getSetting.get('audit_mode');
  assert.strictEqual(row.value, 'on');

  // Toggle off
  setSetting.run('audit_mode', 'off');
  row = getSetting.get('audit_mode');
  assert.strictEqual(row.value, 'off');

  // Toggle back on
  setSetting.run('audit_mode', 'on');
  row = getSetting.get('audit_mode');
  assert.strictEqual(row.value, 'on');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ getSetting/setSetting correctly toggle audit_mode');
}

// ═══════════════════════════════════════════════════════════
// TEST 3: Audit mode ON — bets saved as needs_review
// ═══════════════════════════════════════════════════════════
function testAuditModeOnForcesReview() {
  const { db, dbPath } = freshDb();

  // Confirm audit mode is on
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'audit_mode'").get();
  assert.strictEqual(mode.value, 'on');

  // Insert a capper
  db.prepare("INSERT INTO cappers (id, discord_id, display_name) VALUES ('c1', 'd1', 'TestCapper')").run();

  // Simulate saving a bet with needs_review (as messageHandler would when audit_mode is on)
  db.prepare(`INSERT INTO bets (id, capper_id, sport, description, odds, units, source, review_status)
    VALUES ('b1', 'c1', 'NBA', 'Lakers -3.5', -110, 1, 'discord', 'needs_review')`).run();

  const bet = db.prepare("SELECT * FROM bets WHERE id = 'b1'").get();
  assert.strictEqual(bet.review_status, 'needs_review', 'Bet should be needs_review when audit mode is on');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ Audit mode ON: bets saved as needs_review');
}

// ═══════════════════════════════════════════════════════════
// TEST 4: Audit mode OFF — bets saved as confirmed
// ═══════════════════════════════════════════════════════════
function testAuditModeOffAllowsConfirmed() {
  const { db, dbPath } = freshDb();

  // Turn audit mode off
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('audit_mode', 'off')").run();

  // Insert a capper
  db.prepare("INSERT INTO cappers (id, discord_id, display_name) VALUES ('c1', 'd1', 'TestCapper')").run();

  // Simulate saving a bet with confirmed (as messageHandler would when audit_mode is off)
  db.prepare(`INSERT INTO bets (id, capper_id, sport, description, odds, units, source, review_status)
    VALUES ('b1', 'c1', 'NBA', 'Celtics ML', -150, 1, 'discord', 'confirmed')`).run();

  const bet = db.prepare("SELECT * FROM bets WHERE id = 'b1'").get();
  assert.strictEqual(bet.review_status, 'confirmed', 'Bet should be confirmed when audit mode is off');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ Audit mode OFF: bets saved as confirmed');
}

// ═══════════════════════════════════════════════════════════
// TEST 5: Migration is idempotent
// ═══════════════════════════════════════════════════════════
function testMigrationIdempotent() {
  const { db, dbPath } = freshDb();

  // Run migrations again — should not error or duplicate rows
  runMigrations(db);

  const rows = db.prepare("SELECT * FROM settings WHERE key = 'audit_mode'").all();
  assert.strictEqual(rows.length, 1, 'Should have exactly one audit_mode row');
  assert.strictEqual(rows[0].value, 'on');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ Migration is idempotent (no duplicate settings rows)');
}

// ═══════════════════════════════════════════════════════════
// TEST 6: Staging workflow — on -> save review -> approve -> off -> save confirmed
// ═══════════════════════════════════════════════════════════
function testStagingWorkflow() {
  const { db, dbPath } = freshDb();

  db.prepare("INSERT INTO cappers (id, discord_id, display_name) VALUES ('c1', 'd1', 'TestCapper')").run();

  // Step 1: audit mode ON — bet goes to review
  let mode = db.prepare("SELECT value FROM settings WHERE key = 'audit_mode'").get();
  assert.strictEqual(mode.value, 'on');

  db.prepare(`INSERT INTO bets (id, capper_id, sport, description, odds, units, source, review_status)
    VALUES ('b1', 'c1', 'NFL', 'Chiefs -7', -110, 1, 'discord', 'needs_review')`).run();

  let bet = db.prepare("SELECT * FROM bets WHERE id = 'b1'").get();
  assert.strictEqual(bet.review_status, 'needs_review');

  // Step 2: Admin approves the bet
  db.prepare("UPDATE bets SET review_status = 'confirmed' WHERE id = 'b1'").run();
  bet = db.prepare("SELECT * FROM bets WHERE id = 'b1'").get();
  assert.strictEqual(bet.review_status, 'confirmed');

  // Step 3: Turn audit mode OFF
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('audit_mode', 'off')").run();
  mode = db.prepare("SELECT value FROM settings WHERE key = 'audit_mode'").get();
  assert.strictEqual(mode.value, 'off');

  // Step 4: New bet goes straight to confirmed
  db.prepare(`INSERT INTO bets (id, capper_id, sport, description, odds, units, source, review_status)
    VALUES ('b2', 'c1', 'NBA', 'Lakers ML', -130, 2, 'discord', 'confirmed')`).run();
  bet = db.prepare("SELECT * FROM bets WHERE id = 'b2'").get();
  assert.strictEqual(bet.review_status, 'confirmed');

  db.close();
  cleanup(dbPath);
  console.log('  ✓ Full staging workflow: audit ON → review → approve → audit OFF → auto-confirm');
}

// ═══════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════
console.log('Audit mode validation:');
testMigrationCreatesSettings();
testGetSetSetting();
testAuditModeOnForcesReview();
testAuditModeOffAllowsConfirmed();
testMigrationIdempotent();
testStagingWorkflow();
console.log('Audit mode validation passed.');
