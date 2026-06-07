// ═══════════════════════════════════════════════════════════
// F-12 — Twitter repost content-window dedup.
//
// One source account (bobby__tracker) re-posts the SAME pick across
// multiple separate tweets the same day — each a DISTINCT real tweet id,
// gaps observed 6s–3.25h. createBetWithLegs' fingerprint hashes the
// per-message id, so same-content/different-tweet reposts hash
// differently and BOTH get saved. findRecentRepost() collapses them on a
// 12h window.
//
// CRITICAL GUARDRAIL (this is the test that matters): the same pick TEXT
// legitimately recurs across DIFFERENT days for different matches. Observed
// dup gaps are all <= 3.25h; legit repeats are >= 2 days — so a prior bet
// outside the 12h window MUST NOT dedup.
//
// Uses the standard temp-DB harness (DB_PATH set BEFORE requiring database)
// so the real bets schema + datetime('now') window run against a fresh DB.
//
// Run:  node tests/twitter-repost-dedup.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `twitter-repost-dedup-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../services/database');
const { normalizeForDedup, findRecentRepost } = require('../services/twitter-handler');
const { DROP_REASONS } = require('../services/pipeline-events');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); failed++; }
}

// Insert a bet directly so we can backdate created_at relative to the 12h
// window. ageHours is test-controlled (never user input), so interpolating it
// into the datetime modifier is safe. description is the only NOT NULL column
// without a default; everything else falls to schema defaults.
let seq = 0;
function insertBet({ capperId, description, odds = null, betType = 'straight', source = 'twitter_text', ageHours = 0 }) {
  const id = `t_${process.pid}_${seq++}`;
  const createdExpr = ageHours > 0 ? `datetime('now','-${ageHours} hours')` : `datetime('now')`;
  db.prepare(
    `INSERT INTO bets (id, capper_id, sport, bet_type, description, odds, source, created_at)
     VALUES (?, ?, 'Tennis', ?, ?, ?, ?, ${createdExpr})`,
  ).run(id, capperId, betType, description, odds, source);
  return id;
}

// Create a real capper row so the bets.capper_id FK (foreign_keys=ON) is
// satisfied. Returns the new capper id.
let capSeq = 0;
function cap() {
  const id = `cap_${process.pid}_${capSeq++}`;
  db.prepare('INSERT INTO cappers (id, display_name) VALUES (?, ?)').run(id, id);
  return id;
}

// ── normalization: the forensic grouping, not whitespace-only ──
run('normalizeForDedup lowercases + collapses non-alphanumerics + trims', () => {
  assert.strictEqual(normalizeForDedup('  Cerundolo  S1   ML!! '), 'cerundolo s1 ml');
  assert.strictEqual(normalizeForDedup('BlockX-S2-ML-150'), 'blockx s2 ml 150');
  assert.strictEqual(normalizeForDedup('A. Zverev   o/u  22.5'), 'a zverev o u 22 5');
});

run('normalizeForDedup keeps genuinely different picks distinct', () => {
  assert.notStrictEqual(normalizeForDedup('Cerundolo S1 ML'), normalizeForDedup('BlockX S2 ML'));
});

run('normalizeForDedup handles null/empty', () => {
  assert.strictEqual(normalizeForDedup(null), '');
  assert.strictEqual(normalizeForDedup(''), '');
  assert.strictEqual(normalizeForDedup('!!!'), '');
});

// ── DUPLICATE_REPOST registered (no enum-drift warn at the write boundary) ──
run('DUPLICATE_REPOST is registered in DROP_REASONS', () => {
  assert.ok(DROP_REASONS.includes('DUPLICATE_REPOST'), 'DUPLICATE_REPOST missing from DROP_REASONS');
});

// ── the dup vector: same content/odds, distinct tweet, inside 12h → MATCH ──
run('repost inside 12h (same capper/text/odds) is detected', () => {
  const c = cap();
  const prior = insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 3 }); // 3h ago
  const hit = findRecentRepost({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, betType: 'straight' });
  assert.ok(hit, 'expected a match for a 3h-old repost');
  assert.strictEqual(hit.id, prior);
});

run('repost matches across punctuation/case differences', () => {
  const c = cap();
  const prior = insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'cerundolo   s1  ml', odds: -150, betType: 'straight' });
  assert.ok(hit && hit.id === prior, 'normalized text should match despite spacing/case');
});

run('twitter_vision source also participates in the window', () => {
  const c = cap();
  const prior = insertBet({ capperId: c, description: 'Lakers ML', odds: 120, source: 'twitter_vision', ageHours: 2 });
  const hit = findRecentRepost({ capperId: c, description: 'Lakers ML', odds: 120, betType: 'straight' });
  assert.ok(hit && hit.id === prior);
});

// ── THE GUARDRAIL: legit same-text repeat >= 2 days apart → NO match ──
run('GUARDRAIL: identical text 2 days earlier is NOT a dup (outside 12h)', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 48 }); // 2 days ago
  const hit = findRecentRepost({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, betType: 'straight' });
  assert.strictEqual(hit, null, 'a 2-day-old same-text bet must be preserved, not deduped');
});

run('boundary: just over 12h (13h) is outside the window', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Blockx S2 ML', odds: 150, ageHours: 13 });
  const hit = findRecentRepost({ capperId: c, description: 'Blockx S2 ML', odds: 150, betType: 'straight' });
  assert.strictEqual(hit, null);
});

// ── discriminators: must NOT collapse distinct bets ──
run('different odds do NOT match', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'Cerundolo S1 ML', odds: -120, betType: 'straight' });
  assert.strictEqual(hit, null, 'odds is a discriminator');
});

run('different capper does NOT match', () => {
  insertBet({ capperId: cap(), description: 'Cerundolo S1 ML', odds: -150, ageHours: 1 });
  const hit = findRecentRepost({ capperId: cap(), description: 'Cerundolo S1 ML', odds: -150, betType: 'straight' });
  assert.strictEqual(hit, null, 'dedup is scoped per capper');
});

run('different bet_type does NOT match', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, betType: 'straight', ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, betType: 'parlay' });
  assert.strictEqual(hit, null);
});

run('non-twitter source is ignored (Discord/slip paths untouched)', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, source: 'vision_slip', ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, betType: 'straight' });
  assert.strictEqual(hit, null, 'only twitter_text/twitter_vision rows are dedup candidates');
});

// ── null-odds handling: null matches null, but null != a real number ──
run('null odds matches a prior null-odds repost', () => {
  const c = cap();
  const prior = insertBet({ capperId: c, description: 'Some ML No Odds', odds: null, ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'Some ML No Odds', odds: null, betType: 'straight' });
  assert.ok(hit && hit.id === prior, 'null should match null');
});

run('null odds does NOT match a prior numeric-odds bet', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Some ML', odds: -110, ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: 'Some ML', odds: null, betType: 'straight' });
  assert.strictEqual(hit, null);
});

run('empty/whitespace description never matches (guards against junk collapse)', () => {
  const c = cap();
  insertBet({ capperId: c, description: '!!!', odds: null, ageHours: 1 });
  const hit = findRecentRepost({ capperId: c, description: '   ', odds: null, betType: 'straight' });
  assert.strictEqual(hit, null, 'normalized-empty descriptions must not collapse together');
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\ntwitter-repost-dedup: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
