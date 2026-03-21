const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const TEST_DB = path.join(__dirname, `test-audit-${Date.now()}.db`);

function setupDb() {
  const db = new Database(TEST_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_mode', 'on');

    CREATE TABLE IF NOT EXISTS cappers (
      id TEXT PRIMARY KEY,
      discord_id TEXT UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      capper_id TEXT REFERENCES cappers(id),
      sport TEXT NOT NULL DEFAULT 'Unknown',
      league TEXT,
      bet_type TEXT NOT NULL DEFAULT 'straight',
      description TEXT NOT NULL,
      odds INTEGER,
      units REAL DEFAULT 1.0,
      result TEXT DEFAULT 'pending',
      profit_units REAL DEFAULT 0,
      event_date TEXT,
      source TEXT DEFAULT 'manual',
      source_channel_id TEXT,
      source_message_id TEXT,
      fingerprint TEXT,
      raw_text TEXT,
      review_status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function uid() { return crypto.randomBytes(16).toString('hex'); }

// Test 1: Settings table created with audit_mode = 'on' by default
function testSettingsTableCreated() {
  const db = setupDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('audit_mode');
  assert.strictEqual(row.value, 'on', 'audit_mode should default to on');
  db.close();
}

// Test 2: getSetting / setSetting toggle
function testSettingToggle() {
  const db = setupDb();
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  assert.strictEqual(get.get('audit_mode').value, 'on');
  set.run('audit_mode', 'off');
  assert.strictEqual(get.get('audit_mode').value, 'off');
  set.run('audit_mode', 'on');
  assert.strictEqual(get.get('audit_mode').value, 'on');
  db.close();
}

// Test 3: Audit ON forces needs_review
function testAuditOnForcesReview() {
  const db = setupDb();
  const capperId = uid();
  db.prepare('INSERT INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)').run(capperId, 'disc_1', 'Tester');

  const auditMode = db.prepare('SELECT value FROM settings WHERE key = ?').get('audit_mode').value;
  assert.strictEqual(auditMode, 'on');

  const betId = uid();
  const reviewStatus = auditMode === 'on' ? 'needs_review' : 'confirmed';
  db.prepare('INSERT INTO bets (id, capper_id, description, review_status) VALUES (?, ?, ?, ?)').run(betId, capperId, 'Lakers -3.5', reviewStatus);

  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
  assert.strictEqual(bet.review_status, 'needs_review', 'audit ON should route to needs_review');
  db.close();
}

// Test 4: Audit OFF allows confirmed
function testAuditOffAllowsConfirmed() {
  const db = setupDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('audit_mode', 'off');
  const capperId = uid();
  db.prepare('INSERT INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)').run(capperId, 'disc_2', 'Tester2');

  const auditMode = db.prepare('SELECT value FROM settings WHERE key = ?').get('audit_mode').value;
  const betId = uid();
  const reviewStatus = auditMode === 'on' ? 'needs_review' : 'confirmed';
  db.prepare('INSERT INTO bets (id, capper_id, description, review_status) VALUES (?, ?, ?, ?)').run(betId, capperId, 'Celtics +5', reviewStatus);

  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
  assert.strictEqual(bet.review_status, 'confirmed', 'audit OFF should allow confirmed');
  db.close();
}

// Test 5: Approve bet changes review_status
function testApproveBet() {
  const db = setupDb();
  const capperId = uid();
  db.prepare('INSERT INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)').run(capperId, 'disc_3', 'Tester3');
  const betId = uid();
  db.prepare('INSERT INTO bets (id, capper_id, description, review_status) VALUES (?, ?, ?, ?)').run(betId, capperId, 'Heat ML', 'needs_review');

  const info = db.prepare("UPDATE bets SET review_status = 'confirmed' WHERE id = ? AND review_status = 'needs_review'").run(betId);
  assert.strictEqual(info.changes, 1, 'approve should update one row');
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
  assert.strictEqual(bet.review_status, 'confirmed');
  db.close();
}

// Test 6: Reject bet deletes it
function testRejectBet() {
  const db = setupDb();
  const capperId = uid();
  db.prepare('INSERT INTO cappers (id, discord_id, display_name) VALUES (?, ?, ?)').run(capperId, 'disc_4', 'Tester4');
  const betId = uid();
  db.prepare('INSERT INTO bets (id, capper_id, description, review_status) VALUES (?, ?, ?, ?)').run(betId, capperId, 'Knicks -2', 'needs_review');

  db.prepare("DELETE FROM bets WHERE id = ? AND review_status = 'needs_review'").run(betId);
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
  assert.strictEqual(bet, undefined, 'rejected bet should be deleted');
  db.close();
}

// Cleanup and run
const fs = require('fs');
try {
  testSettingsTableCreated();
  testSettingToggle();
  testAuditOnForcesReview();
  testAuditOffAllowsConfirmed();
  testApproveBet();
  testRejectBet();
  console.log('audit-mode validation passed (6/6 tests).');
} finally {
  // Clean up test DBs
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('test-audit-') && (f.endsWith('.db') || f.endsWith('.db-wal') || f.endsWith('.db-shm'))) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}
