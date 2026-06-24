// ═══════════════════════════════════════════════════════════
// services/preFilter.js — preFilterDecision contract tests.
//
// preFilterDecision is the PURE core of the shadow-mode pre-hold filter wired
// into the two MANUAL_REVIEW_HOLD branches in handlers/messageHandler.js. These
// tests pin its decision table directly (no DB, no Discord, no env): given the
// raw cleaned text + a mode + the enforce-opt-in buckets, it returns
// { bucket, reason, action } and NEVER performs a side effect.
//
// Invariants under test:
//   • mode 'off' (or unset/garbage) → 'pass' for ANY text  (pure no-op default)
//   • shadow → matched non-bets measure-only ('shadow'); real picks 'pass'
//   • empty/image-only text is NEVER flagged (no false would-drop on slip images)
//   • enforce drops ONLY buckets listed in enforceBuckets; others stay 'shadow'
//   • enforceBuckets accepts an Array OR a Set
//
// Run:  node --test tests/pre-filter.test.js   (also discovered by `node --test`)
// ═══════════════════════════════════════════════════════════

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { preFilterDecision, bucketFromHint, DROP_REASON } = require('../services/preFilter');

// Representative text per class. PROMO trips guessDisposition's promo regex
// ("profit boost", "fanduel", "load here"); RECAP trips recap ("cashed",
// "last night"); PICK trips none → "likely a pick".
const PROMO = 'Tail my bank builder: profit boost on FanDuel, load here ❤️';
const RECAP = 'both legs cashed last night';
const SWEAT = "let's go we just need one more, sweat this last leg";
const PICK = 'Lakers -4.5 -110 2u';

// ── mode off → pure no-op for every class ────────────────────
test('off + any text → pass (no bucket, no reason)', () => {
  for (const txt of [PROMO, RECAP, SWEAT, PICK, '', 'random words']) {
    assert.deepEqual(preFilterDecision(txt, 'off', []), { bucket: null, reason: null, action: 'pass' });
  }
});

test('unset/garbage mode → pass (defensive: only shadow|enforce activate)', () => {
  assert.equal(preFilterDecision(PROMO, undefined, []).action, 'pass');
  assert.equal(preFilterDecision(PROMO, 'cutover', []).action, 'pass');
  assert.equal(preFilterDecision(PROMO, '', []).action, 'pass');
});

// ── shadow → measure-only for matched non-bets ───────────────
test('shadow + promo text → promo / shadow', () => {
  const d = preFilterDecision(PROMO, 'shadow', []);
  assert.equal(d.bucket, 'promo');
  assert.equal(d.reason, 'PRE_FILTER_PROMO_SHEET');
  assert.equal(d.action, 'shadow');
});

test('shadow + recap text → recap / shadow', () => {
  const d = preFilterDecision(RECAP, 'shadow', []);
  assert.equal(d.bucket, 'recap');
  assert.equal(d.reason, 'PRE_FILTER_RECAP');
  assert.equal(d.action, 'shadow');
});

test('shadow + sweat text → sweat / shadow', () => {
  const d = preFilterDecision(SWEAT, 'shadow', []);
  assert.equal(d.bucket, 'sweat');
  assert.equal(d.reason, 'PRE_FILTER_SWEAT_COMMENTARY');
  assert.equal(d.action, 'shadow');
});

test('shadow + real pick → null / pass (never flag a live pick)', () => {
  assert.deepEqual(preFilterDecision(PICK, 'shadow', []), { bucket: null, reason: null, action: 'pass' });
});

test('shadow + empty text → null / pass (image-only slip is never flagged)', () => {
  assert.deepEqual(preFilterDecision('', 'shadow', []), { bucket: null, reason: null, action: 'pass' });
  assert.deepEqual(preFilterDecision('   ', 'shadow', []), { bucket: null, reason: null, action: 'pass' });
});

// ── enforce → drops ONLY opted-in buckets, else measure-only ─
test('enforce + promo text + enforceBuckets=[promo] → promo / drop', () => {
  const d = preFilterDecision(PROMO, 'enforce', ['promo']);
  assert.equal(d.bucket, 'promo');
  assert.equal(d.reason, 'PRE_FILTER_PROMO_SHEET');
  assert.equal(d.action, 'drop');
});

test('enforce + promo text + enforceBuckets=[] → promo / shadow (opted-out = measure only)', () => {
  const d = preFilterDecision(PROMO, 'enforce', []);
  assert.equal(d.bucket, 'promo');
  assert.equal(d.action, 'shadow');
});

test('enforce + recap text + enforceBuckets=[promo] → recap / shadow (not opted-in)', () => {
  const d = preFilterDecision(RECAP, 'enforce', ['promo']);
  assert.equal(d.bucket, 'recap');
  assert.equal(d.reason, 'PRE_FILTER_RECAP');
  assert.equal(d.action, 'shadow');
});

// ── enforce never invents a drop for a non-bucket ────────────
test('enforce + real pick → pass even when buckets are opted in', () => {
  assert.deepEqual(preFilterDecision(PICK, 'enforce', ['promo', 'recap', 'sweat']),
    { bucket: null, reason: null, action: 'pass' });
});

test('enforce + empty text → pass even when buckets are opted in (image-only safe)', () => {
  assert.deepEqual(preFilterDecision('', 'enforce', ['promo', 'recap', 'sweat']),
    { bucket: null, reason: null, action: 'pass' });
});

// ── enforceBuckets accepts a Set as well as an Array ─────────
test('enforce + enforceBuckets as a Set → drop when present', () => {
  assert.equal(preFilterDecision(PROMO, 'enforce', new Set(['promo'])).action, 'drop');
  assert.equal(preFilterDecision(RECAP, 'enforce', new Set(['promo'])).action, 'shadow');
});

test('enforce + missing/non-iterable enforceBuckets → shadow, never throws', () => {
  assert.equal(preFilterDecision(PROMO, 'enforce', undefined).action, 'shadow');
  assert.equal(preFilterDecision(PROMO, 'enforce', null).action, 'shadow');
});

// ── bucketFromHint precision: the likely-a-pick hint contains the literal
//    words "recap" and "promo" and MUST still map to null. ─────
test('bucketFromHint maps the real guessDisposition hints, pick/image → null', () => {
  assert.equal(bucketFromHint('Looks like a recap (past-tense / "yesterday" / "cashed")'), 'recap');
  assert.equal(bucketFromHint('Looks like promo / sheet / marketing'), 'promo');
  assert.equal(bucketFromHint('Looks like sweat / commentary on existing bet'), 'sweat');
  assert.equal(bucketFromHint('No obvious recap/promo markers — likely a pick'), null);
  assert.equal(bucketFromHint('Image-only slip — check attachment'), null);
  assert.equal(bucketFromHint(''), null);
  assert.equal(bucketFromHint(undefined), null);
});

// ── reason strings are stable + match the registered DROP_REASON map ──
test('reason on a matched decision equals DROP_REASON[bucket]', () => {
  assert.equal(preFilterDecision(PROMO, 'shadow', []).reason, DROP_REASON.promo);
  assert.equal(preFilterDecision(RECAP, 'shadow', []).reason, DROP_REASON.recap);
  assert.equal(preFilterDecision(SWEAT, 'shadow', []).reason, DROP_REASON.sweat);
});
