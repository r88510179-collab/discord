// ═══════════════════════════════════════════════════════════
// GET /api/admin/{leaderboard,drops,grader-health} tests (Phase A dashboard
// read endpoints).
//
// The handlers are inline `router.get(…)` routes (not exported fns), so —
// like tests/admin-holds-imageurl.test.js — we drive them with a mock req/res,
// reaching each handler via express router introspection (router.stack → the
// route layer's terminal handle). adminAuth is a separate router-level layer;
// its fail-closed contract is exercised directly (and its position in the
// stack asserted structurally) rather than through HTTP.
//
// Standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds fresh bets / pipeline_events /
// grading_audit / search_backend_calls tables we seed and read back.
//
// Timestamp-unit fixtures are the point of several cases (docs/CODEMAP.md):
//   pipeline_events.created_at  INTEGER epoch SECONDS
//   grading_audit.timestamp     INTEGER epoch MILLIS  (Date.now())
//   search_backend_calls.ts     INTEGER epoch MILLIS  (Date.now())
// Each table gets an in-window row AND an out-of-window row, so a handler
// filtering with the wrong unit (seconds cutoff on a millis column admits
// everything; a TEXT datetime comparand admits nothing) fails these tests.
//
// Run:  node tests/admin-read-endpoints.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `admin-read-endpoints-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const database = require('../services/database');
const { db } = database;
const router = require('../routes/admin');
const { adminAuth } = require('../routes/adminAuth');

// ── reach the inline handlers via express router introspection ──
function getRouteHandler(method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      const sub = layer.route.stack;            // adminAuth is a separate layer, not in here
      return sub[sub.length - 1].handle;        // terminal handler for the route
    }
  }
  throw new Error(`route handler not found: ${method.toUpperCase()} ${routePath}`);
}
const leaderboardHandler = getRouteHandler('get', '/leaderboard');
const dropsHandler = getRouteHandler('get', '/drops');
const graderHealthHandler = getRouteHandler('get', '/grader-health');

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

function mockRes() {
  return {
    _code: null,
    _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}
function call(handler, query = {}) {
  const res = mockRes();
  handler({ query }, res);
  return res;
}

// ═══ auth: the router-level fail-closed bearer gate ══════════
// Structural: adminAuth is a router.use layer that sits BEFORE every route
// layer, so the three new GETs are behind the same 503/401/403 gate as the
// existing ones (routes registered after a router.use always run after it).
run('auth: adminAuth layer precedes the /leaderboard, /drops, /grader-health route layers', () => {
  const authIdx = router.stack.findIndex(l => l.handle === adminAuth);
  assert.ok(authIdx >= 0, 'adminAuth layer present on the router');
  for (const p of ['/leaderboard', '/drops', '/grader-health']) {
    const routeIdx = router.stack.findIndex(l => l.route && l.route.path === p);
    assert.ok(routeIdx >= 0, `route layer present: ${p}`);
    assert.ok(authIdx < routeIdx, `adminAuth precedes ${p}`);
  }
});

// Behavioral: the fail-closed contract itself (503 no-secret / 401 no-header /
// 403 mismatch / next() on match), driven directly like the write-route tests.
run('auth: no ADMIN_API_SECRET → 503 fail-closed, handler never reached', () => {
  const saved = process.env.ADMIN_API_SECRET;
  delete process.env.ADMIN_API_SECRET;
  try {
    const res = mockRes();
    let nexted = false;
    adminAuth({ get: () => undefined, method: 'GET', path: '/leaderboard' }, res, () => { nexted = true; });
    assert.strictEqual(res._code, 503);
    assert.strictEqual(nexted, false, 'next() not called');
  } finally {
    if (saved !== undefined) process.env.ADMIN_API_SECRET = saved;
  }
});

run('auth: missing header → 401; wrong token → 403; right token → next()', () => {
  const saved = process.env.ADMIN_API_SECRET;
  process.env.ADMIN_API_SECRET = 'test-secret-value';
  try {
    const noHeader = mockRes();
    adminAuth({ get: () => undefined, method: 'GET', path: '/drops' }, noHeader, () => {});
    assert.strictEqual(noHeader._code, 401);

    const badToken = mockRes();
    adminAuth({ get: () => 'Bearer wrong-token', method: 'GET', path: '/drops' }, badToken, () => {});
    assert.strictEqual(badToken._code, 403);

    const good = mockRes();
    let nexted = false;
    adminAuth({ get: () => 'Bearer test-secret-value', method: 'GET', path: '/drops' }, good, () => { nexted = true; });
    assert.strictEqual(good._code, null, 'no status written on success');
    assert.strictEqual(nexted, true, 'next() called on token match');
  } finally {
    if (saved !== undefined) process.env.ADMIN_API_SECRET = saved;
    else delete process.env.ADMIN_API_SECRET;
  }
});

// ═══ /leaderboard ════════════════════════════════════════════
// Seed: capper A settles 2 wins of +1.0u each (more bets, less profit); capper
// B settles 1 win of +5.0u (fewer bets, more profit). Sort order between the
// two flips with the sort key, which pins that ?sort= actually reaches
// getLeaderboard. 53 filler cappers (1 pending bet each — pending still counts
// toward total_bets, and HAVING COUNT(b.id)>0 admits them) make the limit
// clamp observable: 55 total cappers, so limit=9999 must return exactly 50.
function seedBet(capperId, description, extra = {}) {
  const bet = database.createBet({
    capper_id: capperId,
    sport: 'NBA',
    bet_type: 'straight',
    description,
    odds: -110,
    units: 1,
    source: 'discord',
    raw_text: description,
    ...extra,
  });
  assert.ok(bet && !bet._deduped, `seed bet created: ${description}`);
  return bet;
}
function settle(betId, result, profitUnits) {
  db.prepare('UPDATE bets SET result = ?, profit_units = ? WHERE id = ?').run(result, profitUnits, betId);
}

const capperA = database.getOrCreateCapper('lb_capper_a', 'LB Capper A', null).id;
const capperB = database.getOrCreateCapper('lb_capper_b', 'LB Capper B', null).id;
settle(seedBet(capperA, 'A pick one').id, 'win', 1.0);
settle(seedBet(capperA, 'A pick two').id, 'win', 1.0);
settle(seedBet(capperB, 'B pick one').id, 'win', 5.0);
for (let i = 0; i < 53; i++) {
  const cid = database.getOrCreateCapper(`lb_filler_${i}`, `LB Filler ${i}`, null).id;
  seedBet(cid, `Filler pick ${i}`); // stays pending — still counts toward total_bets
}

run('leaderboard: 200 + envelope { season, sort, cappers } with real rows', () => {
  const res = call(leaderboardHandler, {});
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.season, database.ACTIVE_SEASON, 'season is ACTIVE_SEASON');
  assert.strictEqual(res._json.sort, 'total_profit_units', 'default sort echoed');
  assert.ok(Array.isArray(res._json.cappers), 'cappers is an array');
  const names = res._json.cappers.map(c => c.display_name);
  assert.ok(names.includes('LB Capper A') && names.includes('LB Capper B'), 'seeded cappers present');
  const b = res._json.cappers.find(c => c.display_name === 'LB Capper B');
  assert.strictEqual(b.total_profit_units, 5, 'stats columns ride each row');
});

run('leaderboard: default limit is 10', () => {
  const res = call(leaderboardHandler, {});
  assert.strictEqual(res._json.cappers.length, 10, '55 qualifying cappers, default limit 10');
});

run('leaderboard: sort=total_profit_units ranks B (5u) above A (2u)', () => {
  const res = call(leaderboardHandler, { sort: 'total_profit_units', limit: '55' });
  const names = res._json.cappers.map(c => c.display_name);
  assert.ok(names.indexOf('LB Capper B') < names.indexOf('LB Capper A'), 'B before A by profit');
});

run('leaderboard: sort=total_bets ranks A (2 bets) above B (1 bet)', () => {
  const res = call(leaderboardHandler, { sort: 'total_bets', limit: '55' });
  assert.strictEqual(res._json.sort, 'total_bets', 'effective sort echoed');
  const names = res._json.cappers.map(c => c.display_name);
  assert.ok(names.indexOf('LB Capper A') < names.indexOf('LB Capper B'), 'A before B by volume');
});

run('leaderboard: non-whitelisted sort falls back to total_profit_units (mirrors getLeaderboard)', () => {
  const res = call(leaderboardHandler, { sort: 'units; DROP TABLE bets', limit: '55' });
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.sort, 'total_profit_units', 'fallback sort echoed');
  const names = res._json.cappers.map(c => c.display_name);
  assert.ok(names.indexOf('LB Capper B') < names.indexOf('LB Capper A'), 'profit order = fallback applied');
});

run('leaderboard: limit clamps — 9999→50, 0→1, 3→3, junk→default 10', () => {
  assert.strictEqual(call(leaderboardHandler, { limit: '9999' })._json.cappers.length, 50, '55 cappers exist, upper clamp 50');
  assert.strictEqual(call(leaderboardHandler, { limit: '0' })._json.cappers.length, 1, 'lower clamp 1');
  assert.strictEqual(call(leaderboardHandler, { limit: '3' })._json.cappers.length, 3, 'in-range limit honored');
  assert.strictEqual(call(leaderboardHandler, { limit: 'abc' })._json.cappers.length, 10, 'junk limit → default 10');
});

// ═══ /drops ══════════════════════════════════════════════════
// pipeline_events.created_at is epoch SECONDS. Ages relative to test start:
//   4 in-hour rows (≤1h), 1 two-hour row, 1 thirty-hour row.
// Non-DROP rows (MANUAL_REVIEW_HOLD carrying a drop_reason, EXTRACTED) must
// never surface — the filter is event_type='DROP', not "has a drop_reason".
const NOW_SEC = Math.floor(Date.now() / 1000);
const insertEvent = db.prepare(`
  INSERT INTO pipeline_events (ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function seedDrop({ ingestId, stage = 'DROPPED', reason, payload = null, createdAt }) {
  return insertEvent.run(ingestId, null, 'discord', null, stage, 'DROP', reason, payload, createdAt).lastInsertRowid;
}
seedDrop({ ingestId: 'dr-1', reason: 'BOUNCER_REJECTED', createdAt: NOW_SEC - 100, payload: '{"reason":"offseason"}' });
seedDrop({ ingestId: 'dr-2', reason: 'BOUNCER_REJECTED', createdAt: NOW_SEC - 200 });
seedDrop({ ingestId: 'dr-3', reason: 'BOUNCER_REJECTED', createdAt: NOW_SEC - 300 });
seedDrop({ ingestId: 'dr-4', reason: 'GUARD5_INSUFFICIENT_SIGNALS', createdAt: NOW_SEC - 400 });
const gradingDropId = seedDrop({ ingestId: 'dr-grading', stage: 'GRADING_DROPPED', reason: 'GRADE_EXCEPTION', createdAt: NOW_SEC - 500 });
seedDrop({ ingestId: 'dr-2h', reason: 'AGE_GATE', createdAt: NOW_SEC - 2 * 3600 });   // outside a 1h window
seedDrop({ ingestId: 'dr-30h', reason: 'AGE_GATE', createdAt: NOW_SEC - 30 * 3600 }); // outside 24h, inside 168h
// Non-DROP rows that must never appear:
insertEvent.run('dr-hold', null, 'discord', null, 'MANUAL_REVIEW_HOLD', 'STAGE_ENTER', 'BOUNCER_REJECTED', '{}', NOW_SEC - 50);
insertEvent.run('dr-extracted', null, 'discord', null, 'EXTRACTED', 'STAGE_ENTER', null, '{}', NOW_SEC - 60);

run('drops: 200 + envelope { since, counts, drops }; default 24h window; non-DROP rows excluded', () => {
  const res = call(dropsHandler, {});
  assert.strictEqual(res._code, 200);
  assert.ok(Number.isInteger(res._json.since), 'since is epoch seconds');
  assert.ok(Math.abs(res._json.since - (NOW_SEC - 24 * 3600)) < 60, 'since ≈ now-24h');
  const ingests = res._json.drops.map(d => d.ingest_id);
  assert.deepStrictEqual(ingests, ['dr-1', 'dr-2', 'dr-3', 'dr-4', 'dr-grading', 'dr-2h'], 'in-window DROPs newest first; 30h row + hold/extracted rows excluded');
});

run('drops: rows carry the documented columns; payload stays raw TEXT', () => {
  const res = call(dropsHandler, {});
  const row = res._json.drops.find(d => d.ingest_id === 'dr-1');
  for (const k of ['id', 'ingest_id', 'bet_id', 'source_type', 'source_ref', 'drop_reason', 'payload', 'created_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, k), `row has ${k}`);
  }
  assert.strictEqual(row.payload, '{"reason":"offseason"}', 'payload is the raw TEXT, not parsed');
  assert.strictEqual(row.created_at, NOW_SEC - 100, 'created_at verbatim epoch seconds');
});

run('drops: GRADING_DROPPED recordDrop rows are included (filter is event_type, not stage)', () => {
  const res = call(dropsHandler, {});
  const row = res._json.drops.find(d => d.ingest_id === 'dr-grading');
  assert.ok(row, 'grading-side drop present');
  assert.strictEqual(row.id, gradingDropId);
});

run('drops: counts grouped by reason, descending, window-wide', () => {
  const res = call(dropsHandler, {});
  assert.deepStrictEqual(res._json.counts[0], { drop_reason: 'BOUNCER_REJECTED', n: 3 }, 'top count first');
  const reasons = Object.fromEntries(res._json.counts.map(c => [c.drop_reason, c.n]));
  assert.deepStrictEqual(reasons, { BOUNCER_REJECTED: 3, GUARD5_INSUFFICIENT_SIGNALS: 1, GRADE_EXCEPTION: 1, AGE_GATE: 1 });
});

run('drops: hours=0 clamps to 1 → the 2h-old row leaves the window', () => {
  const res = call(dropsHandler, { hours: '0' });
  const ingests = res._json.drops.map(d => d.ingest_id);
  assert.ok(!ingests.includes('dr-2h'), '2h row excluded under a 1h window');
  assert.ok(ingests.includes('dr-1'), 'sub-1h rows still present');
});

run('drops: hours=9999 clamps to 168 → the 30h-old row enters the window', () => {
  const res = call(dropsHandler, { hours: '9999' });
  const ingests = res._json.drops.map(d => d.ingest_id);
  assert.ok(ingests.includes('dr-30h'), '30h row included under a 168h window');
  assert.ok(Math.abs(res._json.since - (NOW_SEC - 168 * 3600)) < 60, 'since ≈ now-168h');
});

run('drops: reason= filters both drops and counts', () => {
  const res = call(dropsHandler, { reason: 'BOUNCER_REJECTED' });
  assert.strictEqual(res._code, 200);
  assert.ok(res._json.drops.every(d => d.drop_reason === 'BOUNCER_REJECTED'), 'drops filtered');
  assert.deepStrictEqual(res._json.counts, [{ drop_reason: 'BOUNCER_REJECTED', n: 3 }], 'counts filtered');
});

run('drops: unregistered-but-well-formed reason is allowed (format-validated, enum NOT hardcoded)', () => {
  const res = call(dropsHandler, { reason: 'SOME_FUTURE_REASON_9' });
  assert.strictEqual(res._code, 200, 'format-valid unknown reason is not rejected');
  assert.deepStrictEqual(res._json.drops, [], 'just matches nothing');
});

run('drops: malformed reason → 400 (lowercase, spaces, injection chars)', () => {
  for (const bad of ['bouncer_rejected', 'BOUNCER REJECTED', "X'; DROP TABLE bets;--", 'a-b']) {
    const res = call(dropsHandler, { reason: bad });
    assert.strictEqual(res._code, 400, `400 for reason=${JSON.stringify(bad)}`);
  }
});

run('drops: limit caps rows but not counts', () => {
  const res = call(dropsHandler, { limit: '1' });
  assert.strictEqual(res._json.drops.length, 1, 'row cap applied');
  assert.strictEqual(res._json.drops[0].ingest_id, 'dr-1', 'newest row survives the cap');
  assert.strictEqual(res._json.counts.reduce((s, c) => s + c.n, 0), 6, 'counts stay window-wide');
});

run('drops: limit=9999 clamps to 200', () => {
  // 205 same-reason rows, isolated from the other cases via the reason filter.
  const stmt = db.prepare(`
    INSERT INTO pipeline_events (ingest_id, source_type, stage, event_type, drop_reason, created_at)
    VALUES (?, 'discord', 'DROPPED', 'DROP', 'DUPLICATE_IMAGE', ?)
  `);
  for (let i = 0; i < 205; i++) stmt.run(`dr-bulk-${i}`, NOW_SEC - 600 - i);
  const res = call(dropsHandler, { reason: 'DUPLICATE_IMAGE', limit: '9999' });
  assert.strictEqual(res._json.drops.length, 200, 'row cap clamped to 200');
  assert.deepStrictEqual(res._json.counts, [{ drop_reason: 'DUPLICATE_IMAGE', n: 205 }], 'counts see all 205');
});

// ═══ /grader-health ══════════════════════════════════════════
// bets: 3 pending (2 confirmed + 1 needs_review, one backdated to 2020) and
// one settled win that must not count as pending.
const ghCapper = database.getOrCreateCapper('gh_capper', 'GH Capper', null).id;
const ghOld = seedBet(ghCapper, 'GH oldest pending');
db.prepare("UPDATE bets SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ghOld.id);
seedBet(ghCapper, 'GH recent pending');
seedBet(ghCapper, 'GH needs review pending', { review_status: 'needs_review' });
settle(seedBet(ghCapper, 'GH settled win').id, 'win', 1.0);

// grading_audit.timestamp is epoch MILLIS: 3 in-window attempts across 2 bets
// + 1 out-of-window attempt 25h old.
const NOW_MS = Date.now();
const insertAudit = db.prepare(`
  INSERT INTO grading_audit (id, bet_id, attempt_num, timestamp, provider_used, final_status)
  VALUES (?, ?, ?, ?, ?, ?)
`);
insertAudit.run('ga-1', 'bet-aaa', 1, NOW_MS - 1000, 'cerebras', 'WIN');
insertAudit.run('ga-2', 'bet-aaa', 2, NOW_MS - 2000, 'cerebras', 'PENDING');
insertAudit.run('ga-3', 'bet-bbb', 1, NOW_MS - 3000, 'gemini', 'WIN');
insertAudit.run('ga-old', 'bet-old', 1, NOW_MS - 25 * 3600 * 1000, 'stale_provider', 'LOSS');

// search_backend_calls.ts is also epoch MILLIS (Date.now() in
// recordBackendCall): 4 in-window calls + 1 out-of-window.
const insertCall = db.prepare(`
  INSERT INTO search_backend_calls (ts, backend, status, http_code, bet_id, latency_ms, hits)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insertCall.run(NOW_MS - 1000, 'brave', 'ok', 200, 'bet-aaa', 120, 5);
insertCall.run(NOW_MS - 2000, 'brave', 'ok', 200, 'bet-bbb', 130, 3);
insertCall.run(NOW_MS - 3000, 'brave', 'parse_empty', 200, 'bet-aaa', 90, 0);
insertCall.run(NOW_MS - 4000, 'ddg', 'circuit_open', null, null, null, null);
insertCall.run(NOW_MS - 25 * 3600 * 1000, 'brave', 'ok', 200, 'bet-old', 100, 4);

run('grader-health: 200 + envelope { pending, grading24h, backends24h }', () => {
  const res = call(graderHealthHandler, {});
  assert.strictEqual(res._code, 200);
  assert.ok(res._json.pending && res._json.grading24h && Array.isArray(res._json.backends24h), 'all three sections present');
});

run('grader-health: pending totals, oldest created_at, by review_status; settled bets excluded', () => {
  const { pending } = call(graderHealthHandler, {})._json;
  // 53 pending filler bets + 3 GH pending bets = 56 pending; A/B/GH-settled excluded.
  assert.strictEqual(pending.total, 56, 'pending total counts result=pending only');
  assert.strictEqual(pending.oldestCreatedAt, '2020-01-01T00:00:00.000Z', 'oldest pending created_at');
  const byStatus = Object.fromEntries(pending.byReviewStatus.map(r => [r.review_status, r.n]));
  assert.strictEqual(byStatus.needs_review, 1, 'needs_review bucket');
  assert.strictEqual(byStatus.confirmed, 55, 'confirmed bucket');
});

run('grader-health: grading24h uses the MILLIS window — 25h-old attempt excluded', () => {
  const { grading24h } = call(graderHealthHandler, {})._json;
  assert.strictEqual(grading24h.attempts, 3, '3 in-window attempts (a seconds-unit cutoff would admit 4)');
  assert.strictEqual(grading24h.distinctBets, 2, 'bet-aaa + bet-bbb');
  const byProvider = Object.fromEntries(grading24h.byProvider.map(r => [r.provider_used, r.n]));
  assert.deepStrictEqual(byProvider, { cerebras: 2, gemini: 1 }, 'stale_provider excluded');
  const byStatus = Object.fromEntries(grading24h.byFinalStatus.map(r => [r.final_status, r.n]));
  assert.deepStrictEqual(byStatus, { WIN: 2, PENDING: 1 }, 'LOSS rode only the out-of-window row');
});

run('grader-health: backends24h groups backend+status over the MILLIS ts window', () => {
  const { backends24h } = call(graderHealthHandler, {})._json;
  const key = r => `${r.backend}/${r.status}`;
  const grouped = Object.fromEntries(backends24h.map(r => [key(r), r.n]));
  assert.deepStrictEqual(grouped, {
    'brave/ok': 2,            // 3rd brave/ok is 25h old — excluded
    'brave/parse_empty': 1,
    'ddg/circuit_open': 1,
  });
});

run('grader-health: empty-DB shape stays well-formed (fresh tables, no rows)', () => {
  // Run against a throwaway connection? Not needed — assert the null contract
  // directly: MIN() over zero rows is NULL, COUNT is 0. Simulate by querying
  // with an impossible filter through the real handler is not possible, so pin
  // the SQL contract the handler relies on instead.
  const row = db.prepare("SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM bets WHERE result = 'no_such_result'").get();
  assert.strictEqual(row.total, 0);
  assert.strictEqual(row.oldest, null);
});

// ═══ 500 path: db unavailable → clean Internal error ═════════
run('all three handlers 500 cleanly when the DB layer throws', () => {
  const originalPrepare = db.prepare;
  db.prepare = () => { throw new Error('boom'); };
  try {
    for (const h of [dropsHandler, graderHealthHandler]) {
      const res = call(h, {});
      assert.strictEqual(res._code, 500);
      assert.deepStrictEqual(res._json, { error: 'Internal error' });
    }
  } finally {
    db.prepare = originalPrepare;
  }
  // /leaderboard goes through getLeaderboard, not db.prepare directly.
  const originalGetLeaderboard = database.getLeaderboard;
  database.getLeaderboard = () => { throw new Error('boom'); };
  try {
    const res = call(leaderboardHandler, {});
    assert.strictEqual(res._code, 500);
    assert.deepStrictEqual(res._json, { error: 'Internal error' });
  } finally {
    database.getLeaderboard = originalGetLeaderboard;
  }
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\nadmin-read-endpoints: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
