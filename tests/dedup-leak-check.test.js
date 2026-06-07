// ═══════════════════════════════════════════════════════════
// F-12 follow-up — dedup leak check (services/dedupLeakCheck.js).
//
// findDedupLeaks() is the read-only SAFETY NET for the F-12 ingest gate: it
// finds same-capper Twitter reposts that slipped past findRecentRepost and got
// saved anyway (two twitter bets matching capper + bet_type + normalized desc +
// null-aware odds, inside 12h, where the later one should have been dropped).
//
// These assert the SAME match key as tests/twitter-repost-dedup.test.js, but on
// the post-hoc scan instead of the at-ingest gate. findDedupLeaks scans ALL
// twitter bets, so every case uses a FRESH capper and asserts on leaks filtered
// to that capper — cases can't cross-contaminate.
//
// Uses the standard temp-DB harness (DB_PATH set BEFORE requiring database) so
// the real bets schema + datetime('now') window run against a fresh DB.
//
// Run:  node tests/dedup-leak-check.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dedup-leak-check-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../services/database');
const { findDedupLeaks } = require('../services/dedupLeakCheck');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); failed++; }
}

// Insert a bet directly so we can backdate created_at relative to the window.
// ageHours is test-controlled (never user input), so interpolating it into the
// datetime modifier is safe. description is the only NOT NULL column without a
// default; everything else falls to schema defaults.
let seq = 0;
function insertBet({ capperId, description, odds = null, betType = 'straight', source = 'twitter_text', ageHours = 0 }) {
  const id = `b_${process.pid}_${seq++}`;
  const createdExpr = ageHours > 0 ? `datetime('now','-${ageHours} hours')` : `datetime('now')`;
  db.prepare(
    `INSERT INTO bets (id, capper_id, sport, bet_type, description, odds, source, created_at)
     VALUES (?, ?, 'Tennis', ?, ?, ?, ?, ${createdExpr})`,
  ).run(id, capperId, betType, description, odds, source);
  return id;
}

// Real capper row so the bets.capper_id FK (foreign_keys=ON) is satisfied.
let capSeq = 0;
function cap() {
  const id = `cap_${process.pid}_${capSeq++}`;
  db.prepare('INSERT INTO cappers (id, display_name) VALUES (?, ?)').run(id, id);
  return id;
}

// Leaks scoped to the cappers a given case created — isolates it from prior cases.
function leaksFor(...capperIds) {
  return findDedupLeaks({ db }).filter((l) => capperIds.includes(l.capper_id));
}

// ── 0-leak: two genuinely different picks from one capper ──
run('two different picks, same capper → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Lakers ML', odds: -150, ageHours: 2 });
  insertBet({ capperId: c, description: 'Celtics ML', odds: -150, ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0);
});

// ── 1-leak: the core dup vector — same everything, 3h apart ──
run('same capper+desc+odds+bet_type, 3h apart → 1', () => {
  const c = cap();
  const earlier = insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 3 });
  const later = insertBet({ capperId: c, description: 'Cerundolo S1 ML', odds: -150, ageHours: 0 });
  const leaks = leaksFor(c);
  assert.strictEqual(leaks.length, 1, 'expected exactly one leak');
  assert.strictEqual(leaks[0].later.id, later, 'later bet is the repost that slipped');
  assert.strictEqual(leaks[0].earlier.id, earlier, 'earlier bet is the original');
  assert.strictEqual(leaks[0].normDesc, 'cerundolo s1 ml');
  assert.strictEqual(leaks[0].odds, -150);
  assert.ok(Math.abs(leaks[0].gapMinutes - 180) <= 1, `gap ~180m, got ${leaks[0].gapMinutes}`);
});

// ── 1-leak: punctuation/case differ but normalize-equal, within 12h ──
run('normalize-equal (punctuation/case), within 12h → 1', () => {
  const c = cap();
  const earlier = insertBet({ capperId: c, description: 'Cerundolo S1 ML!!', odds: -150, ageHours: 2 });
  const later = insertBet({ capperId: c, description: 'cerundolo   s1  ml', odds: -150, ageHours: 0 });
  const leaks = leaksFor(c);
  assert.strictEqual(leaks.length, 1);
  assert.strictEqual(leaks[0].later.id, later);
  assert.strictEqual(leaks[0].earlier.id, earlier);
  assert.strictEqual(leaks[0].normDesc, 'cerundolo s1 ml');
});

// ── 0-leak: same content but 25h apart (outside the 12h window) ──
run('same content 25h apart → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Sinner ML', odds: -200, ageHours: 25 });
  insertBet({ capperId: c, description: 'Sinner ML', odds: -200, ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0, '25h gap exceeds the 12h window');
});

// ── 0-leak: same content, odds is a discriminator ──
run('same content, different odds → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Alcaraz ML', odds: -150, ageHours: 1 });
  insertBet({ capperId: c, description: 'Alcaraz ML', odds: -120, ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0);
});

// ── 0-leak: same content, different capper (dedup is per-capper) ──
run('same content, different capper → 0', () => {
  const c1 = cap();
  const c2 = cap();
  insertBet({ capperId: c1, description: 'Djokovic ML', odds: -300, ageHours: 1 });
  insertBet({ capperId: c2, description: 'Djokovic ML', odds: -300, ageHours: 0 });
  assert.strictEqual(leaksFor(c1, c2).length, 0);
});

// ── 0-leak: same content, different bet_type (different group) ──
run('same content, different bet_type → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Multi ML', odds: 200, betType: 'straight', ageHours: 1 });
  insertBet({ capperId: c, description: 'Multi ML', odds: 200, betType: 'parlay', ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0);
});

// ── null-odds: null matches null (1) ──
run('null-odds pair within 12h → 1', () => {
  const c = cap();
  const earlier = insertBet({ capperId: c, description: 'No Odds Pick', odds: null, ageHours: 2 });
  const later = insertBet({ capperId: c, description: 'No Odds Pick', odds: null, ageHours: 0 });
  const leaks = leaksFor(c);
  assert.strictEqual(leaks.length, 1);
  assert.strictEqual(leaks[0].later.id, later);
  assert.strictEqual(leaks[0].earlier.id, earlier);
  assert.strictEqual(leaks[0].odds, null, 'null-odds leak reports odds:null');
});

// ── null-odds: null does NOT match a real number (0) ──
run('null odds vs numeric odds → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Mixed Odds Pick', odds: -110, ageHours: 2 });
  insertBet({ capperId: c, description: 'Mixed Odds Pick', odds: null, ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0, 'null and -110 are not equal under (odds||null)');
});

// ── 0-leak: non-twitter (discord/slip) duplicate is out of scope ──
run('non-twitter source (discord) duplicate → 0', () => {
  const c = cap();
  insertBet({ capperId: c, description: 'Slip Dupe', odds: -150, source: 'vision_slip', ageHours: 1 });
  insertBet({ capperId: c, description: 'Slip Dupe', odds: -150, source: 'vision_slip', ageHours: 0 });
  assert.strictEqual(leaksFor(c).length, 0, 'only twitter_text/twitter_vision rows are scanned');
});

// ── cleanup ──────────────────────────────────────────────────
try { db.close(); } catch (_) {}
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
}

console.log(`\ndedup-leak-check: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
