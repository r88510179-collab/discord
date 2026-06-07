// ═══════════════════════════════════════════════════════════
// Admin handles WRITE-route tests (Phase 2b — scraper_handles toggle).
//
// Exercises routes/adminCommands.handleSetHandleRoute directly with a mock
// req/res (the repo has no HTTP/supertest harness, mirroring
// tests/hold-dismiss.test.js). The route toggles a SEEDED scraper_handles
// row's `enabled` flag (+ optional note); it NEVER creates rows.
//
// Uses the standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds + seeds a fresh scraper_handles
// table (migration 027) that we re-seed and read back.
//
// Run:  node tests/admin-handles-write.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `admin-handles-write-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../services/database');
const { handleSetHandleRoute } = require('../routes/adminCommands');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

// ── seed / read helpers ──────────────────────────────────────
// Seed our own rows (distinct from migration 027's 9 seeds) so the
// note-preservation assertions own a known starting note.
db.prepare("INSERT INTO scraper_handles (handle, enabled, added_at, note) VALUES (?, 1, unixepoch(), ?)")
  .run('testcapper_a', 'original note A');
db.prepare("INSERT INTO scraper_handles (handle, enabled, added_at, note) VALUES (?, 1, unixepoch(), NULL)")
  .run('testcapper_b');

function getRow(handle) {
  return db.prepare('SELECT handle, enabled, added_at, note FROM scraper_handles WHERE handle = ?').get(handle);
}
function totalRows() {
  return db.prepare('SELECT COUNT(*) AS c FROM scraper_handles').get().c;
}
function mockRes() {
  return {
    _code: null,
    _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}
function call(handle, body) {
  const res = mockRes();
  handleSetHandleRoute({ params: { handle }, body: body || {} }, res);
  return res;
}

// ── toggle enabled 1 → 0 ─────────────────────────────────────
run('toggle existing handle enabled 1→0 → 200 updated, DB row enabled=0', () => {
  assert.strictEqual(getRow('testcapper_a').enabled, 1, 'precondition: starts enabled=1');
  const res = call('testcapper_a', { enabled: 0 });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.ok, true);
  assert.strictEqual(res._json.status, 'updated');
  assert.strictEqual(res._json.handle.enabled, 0, 'returned row reflects the new value');
  assert.strictEqual(getRow('testcapper_a').enabled, 0, 'DB row is now enabled=0');
});

// ── toggle back 0 → 1 ────────────────────────────────────────
run('toggle back 0→1 → 200 updated, DB row enabled=1', () => {
  const res = call('testcapper_a', { enabled: 1 });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.status, 'updated');
  assert.strictEqual(getRow('testcapper_a').enabled, 1, 'DB row is now enabled=1');
});

// ── boolean coercion (true→1 / false→0) ──────────────────────
run('boolean enabled is coerced: false→0, true→1', () => {
  let res = call('testcapper_a', { enabled: false });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(getRow('testcapper_a').enabled, 0, 'false coerced to 0');
  res = call('testcapper_a', { enabled: true });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(getRow('testcapper_a').enabled, 1, 'true coerced to 1');
});

// ── unknown handle → 404, nothing changed (never created) ─────
run('unknown handle → 404 not_found, no rows changed', () => {
  const before = totalRows();
  const res = call('does_not_exist', { enabled: 0 });
  assert.strictEqual(res._code, 404);
  assert.strictEqual(res._json.ok, false);
  assert.strictEqual(res._json.status, 'not_found');
  assert.strictEqual(totalRows(), before, 'no row inserted for an unknown handle');
  assert.strictEqual(getRow('does_not_exist'), undefined, 'unknown handle still absent (never created)');
});

// ── malformed enabled → 400 ──────────────────────────────────
run('enabled missing → 400 malformed', () => {
  const res = call('testcapper_a', {}); // no enabled key
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});
run('enabled=2 → 400 malformed', () => {
  const res = call('testcapper_a', { enabled: 2 });
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});
run('enabled="yes" → 400 malformed', () => {
  const res = call('testcapper_a', { enabled: 'yes' });
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});
run('a malformed request mutates nothing', () => {
  const before = getRow('testcapper_a').enabled;
  call('testcapper_a', { enabled: 'nope' });
  assert.strictEqual(getRow('testcapper_a').enabled, before, 'enabled unchanged after malformed request');
});

// ── empty/whitespace handle → 400 ────────────────────────────
run('empty/whitespace handle → 400 malformed', () => {
  const res = call('   ', { enabled: 1 });
  assert.strictEqual(res._code, 400);
  assert.strictEqual(res._json.status, 'malformed');
});

// ── note omitted → preserved; note provided → updated ────────
run('note omitted → existing note preserved', () => {
  assert.strictEqual(getRow('testcapper_a').note, 'original note A', 'precondition: note present');
  const res = call('testcapper_a', { enabled: 0 }); // toggles enabled, no note key
  assert.strictEqual(res._code, 200);
  assert.strictEqual(getRow('testcapper_a').note, 'original note A', 'note left untouched when omitted');
});
run('note provided → note updated (returned row + DB)', () => {
  const res = call('testcapper_a', { enabled: 1, note: 'updated by dashboard' });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.handle.note, 'updated by dashboard', 'returned row carries the new note');
  assert.strictEqual(getRow('testcapper_a').note, 'updated by dashboard', 'DB note updated');
});
run('note can be set on a row that started with NULL note', () => {
  assert.strictEqual(getRow('testcapper_b').note, null, 'precondition: note NULL');
  const res = call('testcapper_b', { enabled: 1, note: 'first note' });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(getRow('testcapper_b').note, 'first note');
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\nadmin-handles-write: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
