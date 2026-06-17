// ═══════════════════════════════════════════════════════════
// GET /api/admin/holds imageUrl-join tests (read-only field addition).
//
// The bet-slip image URL is NOT on the MANUAL_REVIEW_HOLD event's own payload;
// it rides a SEPARATE pipeline_events row for the same ingest_id (the
// EXTRACTED-stage event, payload {imageCount, imageUrl}). routes/admin.js GET
// /holds now joins that row per hold and surfaces `imageUrl` (verbatim, or
// null when absent / unparseable). These tests pin that behaviour.
//
// The handler is an inline `router.get('/holds', …)` (not an exported fn like
// the write routes), so — like the repo's other route tests — we drive it with
// a mock req/res, reaching the handler via express router introspection
// (router.stack → the /holds route layer's terminal handle). adminAuth is a
// separate router-level layer, so invoking the route handler directly
// exercises the holds logic without auth, exactly as the HTTP path would after
// the bearer check.
//
// Standard harness DB pattern: a temp DB_PATH set BEFORE requiring
// services/database, so the migrator builds a fresh pipeline_events table
// (migrations 018/021) that we seed and read back.
//
// Each assertion FAILS on pre-fix code: the old item object has no `imageUrl`
// key, so item.imageUrl is `undefined` — strictly unequal to both a URL string
// and to `null`.
//
// Run:  node tests/admin-holds-imageurl.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `admin-holds-imageurl-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../services/database');
const router = require('../routes/admin');

// ── reach the inline /holds handler via express router introspection ──
function getRouteHandler(method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      const sub = layer.route.stack;            // adminAuth is a separate layer, not in here
      return sub[sub.length - 1].handle;        // terminal handler for the route
    }
  }
  throw new Error(`route handler not found: ${method.toUpperCase()} ${routePath}`);
}
const holdsHandler = getRouteHandler('get', '/holds');

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

// ── seed helpers ─────────────────────────────────────────────
const insertEvent = db.prepare(`
  INSERT INTO pipeline_events (ingest_id, source_type, stage, event_type, payload, created_at)
  VALUES (?, ?, ?, 'STAGE_ENTER', ?, ?)
`);
function event({ ingestId = null, stage, payload = null, createdAt, sourceType = 'discord' }) {
  return insertEvent.run(ingestId, sourceType, stage, payload, createdAt).lastInsertRowid;
}
function hold(ingestId, createdAt, extraPayload = {}) {
  return event({
    ingestId,
    stage: 'MANUAL_REVIEW_HOLD',
    payload: JSON.stringify({ capper: 'tester', messageUrl: 'https://discord.com/x', ...extraPayload }),
    createdAt,
  });
}
function extracted(ingestId, createdAt, payloadStr) {
  return event({ ingestId, stage: 'EXTRACTED', payload: payloadStr, createdAt });
}

const NOW = 1750000000; // fixed epoch seconds — deterministic ordering, no Date.now

// ── seed scenarios ───────────────────────────────────────────
// A: hold + EXTRACTED carrying a real slip URL → that URL surfaces.
hold('ing-a', NOW - 100);
extracted('ing-a', NOW - 200, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/AAA.jpg' }));

// B: hold with NO image-bearing row → null.
hold('ing-b', NOW - 90);

// C: hold + a row whose payload contains the substring "imageUrl" but is NOT
//    valid JSON → null, and the handler must not throw.
hold('ing-c', NOW - 80);
extracted('ing-c', NOW - 180, '{"imageCount":1,"imageUrl":"https://x.jpg"'); // missing closing brace

// D: hold + TWO image rows → the MOST RECENT one wins.
hold('ing-d', NOW - 70);
extracted('ing-d', NOW - 300, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/OLD.jpg' }));
extracted('ing-d', NOW - 150, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/NEW.jpg' }));

// E: hold + a row where imageUrl is present-but-null → null (no junk value).
hold('ing-e', NOW - 60);
extracted('ing-e', NOW - 160, JSON.stringify({ imageCount: 1, imageUrl: null }));

// F: hold + a NON-slip junk image URL (promo asset) → surfaced as-is, UNFILTERED.
hold('ing-f', NOW - 55);
extracted('ing-f', NOW - 155, JSON.stringify({ imageCount: 1, imageUrl: 'https://gamescript.ai/promo.png' }));

// G: hold with a NULL ingest_id (no join key) → null; image rows for other
//    ingests must never leak in.
const gEventId = event({
  ingestId: null,
  stage: 'MANUAL_REVIEW_HOLD',
  payload: JSON.stringify({ capper: 'nullcap', messageUrl: 'https://discord.com/g' }),
  createdAt: NOW - 50,
});

// H: SHADOWING REGRESSION (the bug the adversarial review found). The EXTRACTED
//    row carries the real URL, but the MANUAL_REVIEW_HOLD row for the SAME
//    ingest is written LATER and its `sample` value is exactly "imageUrl", so
//    the hold's JSON payload literally contains the `"imageUrl"` token and is a
//    candidate — yet it has no real imageUrl KEY. A substring-LIKE + LIMIT 1
//    lookup picks the newer keyless hold and returns null; the parse-and-
//    iterate lookup must skip it and still surface the EXTRACTED URL.
extracted('ing-h', NOW - 410, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/SHADOW.jpg' }));
hold('ing-h', NOW - 400, { sample: 'imageUrl' }); // hold is NEWER and matches the LIKE but has no imageUrl key

// I: same shadowing trap, but the EXTRACTED and HOLD rows share the SAME
//    created_at (prod has 1-second granularity), with the hold inserted AFTER
//    → higher id. The created_at-DESC, id-DESC tie must not let the keyless
//    hold win the lookup.
extracted('ing-i', NOW - 350, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/TIE.jpg' }));
hold('ing-i', NOW - 350, { sample: 'imageUrl' }); // same second, inserted later (higher id)

// R: a hold that is later RELEASED must stay EXCLUDED even though it has an
//    image row — the new imageUrl field must never resurrect a resolved hold.
hold('ing-r', NOW - 45);
extracted('ing-r', NOW - 145, JSON.stringify({ imageCount: 1, imageUrl: 'https://pbs.twimg.com/media/RESOLVED.jpg' }));
event({ ingestId: 'ing-r', stage: 'MANUAL_REVIEW_RELEASED', payload: '{}', createdAt: NOW - 40 });

// ── invoke ───────────────────────────────────────────────────
function mockRes() {
  return {
    _code: null,
    _json: null,
    status(c) { this._code = c; return this; },
    json(b) { this._json = b; return this; },
  };
}
function callHolds() {
  const res = mockRes();
  holdsHandler({}, res); // /holds reads nothing off req
  return res;
}
function itemByIngest(res, ingestId) {
  return res._json.holds.find(h => h.ingestId === ingestId);
}

const res = callHolds();

// ── assertions ───────────────────────────────────────────────
run('responds 200 with all 9 unresolved holds (resolved ing-r excluded)', () => {
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.count, 9);
  assert.strictEqual(res._json.holds.length, 9);
});

run('A: imageUrl from the EXTRACTED event is surfaced verbatim', () => {
  const item = itemByIngest(res, 'ing-a');
  assert.ok(item, 'hold ing-a present');
  assert.strictEqual(item.imageUrl, 'https://pbs.twimg.com/media/AAA.jpg');
});

run('B: no image row → imageUrl is null', () => {
  const item = itemByIngest(res, 'ing-b');
  assert.ok(item, 'hold ing-b present');
  assert.strictEqual(item.imageUrl, null);
});

run('C: malformed image payload → imageUrl null, no throw', () => {
  const item = itemByIngest(res, 'ing-c');
  assert.ok(item, 'hold ing-c present');
  assert.strictEqual(item.imageUrl, null);
});

run('D: most recent image row wins (NEW over OLD)', () => {
  const item = itemByIngest(res, 'ing-d');
  assert.ok(item, 'hold ing-d present');
  assert.strictEqual(item.imageUrl, 'https://pbs.twimg.com/media/NEW.jpg');
});

run('E: imageUrl present-but-null in payload → null', () => {
  const item = itemByIngest(res, 'ing-e');
  assert.ok(item, 'hold ing-e present');
  assert.strictEqual(item.imageUrl, null);
});

run('F: junk/non-slip URL is surfaced UNFILTERED (no classification in the bot)', () => {
  const item = itemByIngest(res, 'ing-f');
  assert.ok(item, 'hold ing-f present');
  assert.strictEqual(item.imageUrl, 'https://gamescript.ai/promo.png');
});

run('G: hold with null ingest_id → imageUrl null (no join key, no cross-ingest leak)', () => {
  const item = res._json.holds.find(h => h.ingestId === null && h.id === String(gEventId));
  assert.ok(item, 'null-ingest hold present');
  assert.strictEqual(item.imageUrl, null);
});

run('H: a NEWER keyless hold whose payload mentions "imageUrl" does NOT shadow the real EXTRACTED URL', () => {
  const item = itemByIngest(res, 'ing-h');
  assert.ok(item, 'hold ing-h present');
  assert.strictEqual(item.imageUrl, 'https://pbs.twimg.com/media/SHADOW.jpg');
});

run('I: same-second tie (hold inserted after EXTRACTED, higher id) still surfaces the real URL', () => {
  const item = itemByIngest(res, 'ing-i');
  assert.ok(item, 'hold ing-i present');
  assert.strictEqual(item.imageUrl, 'https://pbs.twimg.com/media/TIE.jpg');
});

run('R: a RELEASED hold stays excluded even though it has an image row (no resurrection)', () => {
  assert.strictEqual(itemByIngest(res, 'ing-r'), undefined, 'resolved hold ing-r must not appear');
});

run('every item carries an own `imageUrl` key (string or null, never undefined)', () => {
  for (const item of res._json.holds) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(item, 'imageUrl'),
      `item ${item.id} is missing the imageUrl key`,
    );
    assert.ok(
      item.imageUrl === null || typeof item.imageUrl === 'string',
      `item ${item.id} imageUrl is neither null nor string: ${item.imageUrl}`,
    );
  }
});

run('the rest of the hold shape is unchanged (smoke: capper/messageUrl still surface)', () => {
  const item = itemByIngest(res, 'ing-a');
  assert.strictEqual(item.capper, 'tester');
  assert.strictEqual(item.messageUrl, 'https://discord.com/x');
  assert.strictEqual(item.ingestId, 'ing-a');
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\nadmin-holds-imageurl: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
