// ═══════════════════════════════════════════════════════════
// PR-B: per-leg MATCH BINDING rule in the parseBetText VISION prompt.
//
// Background: open Onyx pick-receipt slips print a matchup line
// ("<TeamA> @ <TeamB>") under each leg. The VISION prompt required
// team/player per leg but NOT the match line, so market-type legs
// ("Total Goals: Over 1.5", "Both Teams To Score: Yes") landed as
// bare markets with no bound game — ungradeable, since the grader
// reads `description` only. The fix is prompt-text ONLY:
//   1. A MATCH BINDING rule instructing the MODEL to APPEND the
//      matchup to the description as "<pick> (<TeamA> @ <TeamB>)"
//      for player-less market legs (the load-bearing fix — it rides
//      in `description`, which is persisted verbatim), and to set a
//      best-effort `match` field.
//   2. The rule + a `match` field entry are added to BOTH near-
//      identical leg-rule blocks (CRITICAL FORMAT RULES + STRICT
//      RULES).
//
// WHAT IS AND ISN'T UNIT-TESTABLE HERE:
//   The load-bearing behavior — the model reading the matchup line
//   and appending it to `description` — happens at LLM inference and
//   cannot be exercised without a live vision call. So:
//   • Part 1 is the real regression guard: it asserts the VISION
//     prompt string carries the rule in BOTH blocks (RED-proofed —
//     reverting the prompt fails these).
//   • Part 2 does NOT re-prove the fix. It pins the STORAGE CONTRACT
//     the prompt-only fix relies on: (a) the new best-effort `match`
//     field is inert at write time (no error, not persisted), (b)
//     storage does NOT itself bind match→description — confirming the
//     append must be produced upstream in the prompt — and (c) an
//     already-bound `description` round-trips losslessly, which is why
//     riding the binding in `description` is the load-bearing choice.
//
// Note (deviation): the source prompt's test sketch asked to assert a
// leg "normalizes/persists with the match bound into description". No
// code performs that binding (verified: storage persists a bare
// description bare — see Part 2b); the binding is the model's job. So
// Part 2 encodes the ACTUAL storage contract instead of a binding the
// code does not do. See the PR body's consumer-path note.
//
// Run:  node tests/leg-match-binding.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated temp DB — must be set before requiring database so migrations run.
const DB_FILE = path.join(os.tmpdir(), `leg-match-binding-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db, createBetWithLegs, getOrCreateCapper } = require('../services/database');

let passed = 0;
let failed = 0;
function check(name, fn) {
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

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Set of persisted leg descriptions for a bet — order-independent so the
// assertions never depend on SQLite's tie-break of equal created_at values.
function legDescriptions(betId) {
  return db
    .prepare('SELECT description FROM parlay_legs WHERE bet_id = ?')
    .all(betId)
    .map((r) => r.description);
}

// ── Part 1: VISION prompt string carries the rule in BOTH blocks ──
// Slice out the parseBetText VISION sys template (the only prompt that
// runs CRITICAL FORMAT RULES + STRICT RULES). GEMMA_SLIP_PROMPT lives
// earlier and shares neither anchor, so the region is unambiguous.
const AI_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'ai.js'), 'utf8');
const REGION_START = AI_SRC.indexOf('CRITICAL FORMAT RULES:');
const REGION_END = AI_SRC.indexOf('Output strictly valid JSON', REGION_START);
const VISION_PROMPT = AI_SRC.slice(REGION_START, REGION_END);

check('VISION-prompt region isolated (anchors present, ordered)', () => {
  assert.ok(REGION_START !== -1, 'CRITICAL FORMAT RULES: anchor not found');
  assert.ok(REGION_END !== -1, 'Output strictly valid JSON anchor not found');
  assert.ok(REGION_END > REGION_START, 'end anchor must follow start anchor');
});

check('MATCH BINDING rule appears in BOTH leg-rule blocks', () => {
  assert.strictEqual(
    countOccurrences(VISION_PROMPT, 'MATCH BINDING (CRITICAL)'),
    2,
    'expected the MATCH BINDING rule in both the CRITICAL FORMAT RULES and STRICT RULES blocks',
  );
});

check('description-append instruction "(<TeamA> @ <TeamB>)" present', () => {
  assert.ok(
    VISION_PROMPT.includes('APPEND it to the description as "<pick> (<TeamA> @ <TeamB>)"'),
    'the load-bearing description-append instruction must be in the prompt',
  );
  // The parenthesized game-line token that survives via `description`.
  assert.ok(
    VISION_PROMPT.includes('(<TeamA> @ <TeamB>)'),
    'the "(<TeamA> @ <TeamB>)" append token must appear',
  );
});

check('both leg field enumerations add the "match" game-line field', () => {
  assert.strictEqual(
    countOccurrences(VISION_PROMPT, 'match (the "<TeamA> @ <TeamB>" game line, or null)'),
    2,
    'both "Each leg MUST include/have" lines must enumerate the match field',
  );
});

check('pre-existing MATCH RESULT / DRAW rule still in both blocks (no regression)', () => {
  assert.strictEqual(
    countOccurrences(VISION_PROMPT, 'MATCH RESULT / DRAW SELECTION (CRITICAL)'),
    2,
    'the existing MATCH RESULT / DRAW rule must remain in both blocks',
  );
});

// ── Part 2: storage contract the prompt-only fix relies on ──
// (NOT a re-test of the model-side append — see the header.)
const CAPPER = getOrCreateCapper('cap_match_binding_test', 'Match Binding Tester', null);

check('2a/2c — stray `match` field is inert; an already-bound description round-trips non-bare', () => {
  // Legs as the model now emits them under the new rule: `description`
  // already carries the "(<TeamA> @ <TeamB>)" append, plus a best-effort
  // `match` field that storage must tolerate but need not read.
  const boundTotal = 'Total Goals: Over 1.5 (France @ Paraguay)';
  const boundBtts = 'Both Teams To Score: Yes (Spain @ Portugal)';

  const saved = createBetWithLegs(
    {
      capper_id: CAPPER.id,
      sport: 'Soccer',
      bet_type: 'parlay',
      description: `• ${boundTotal}\n• ${boundBtts}`,
      odds: 150,
      units: 1,
      source: 'vision_slip',
      review_status: 'needs_review',
    },
    [
      { description: boundTotal, odds: -120, team: null, line: 'Over 1.5', type: 'total', match: 'France @ Paraguay' },
      { description: boundBtts, odds: -110, team: null, line: null, type: 'total', match: 'Spain @ Portugal' },
    ],
  );

  // (a) write-safety: the extra `match` field never throws on insert.
  assert.ok(saved && saved.id, 'createBetWithLegs must return a persisted bet (no throw on the extra `match` field)');

  const descs = legDescriptions(saved.id);
  assert.strictEqual(descs.length, 2, 'both legs must persist');

  // (c) the `description` carrier is lossless — the model's binding survives
  // verbatim (order-independent membership, not positional).
  assert.ok(descs.includes(boundTotal), 'the bound total leg must persist verbatim in `description`');
  assert.ok(descs.includes(boundBtts), 'the bound BTTS leg must persist verbatim in `description`');

  // No market leg lands bare — every one carries a "(TeamA @ TeamB)" binding.
  for (const d of descs) {
    assert.ok(/\(.+@.+\)/.test(d), `persisted leg is a bare market with no bound match: "${d}"`);
  }
});

check('2b — storage does NOT bind match→description (append is the model’s job, in the prompt)', () => {
  // A BARE market `description` plus a `match` field persists BARE. No code
  // binds match into description — that append is the MODEL's responsibility
  // under the new VISION rule (Part 1). This is exactly why the description-
  // append is the load-bearing carrier and the `match` field alone is inert.
  // It also documents the current contract: a storage-side binder would need
  // to consciously update this assertion.
  const bare = 'Total Goals: Over 1.5';

  const saved = createBetWithLegs(
    {
      capper_id: CAPPER.id,
      sport: 'Soccer',
      bet_type: 'straight',
      description: bare,
      odds: -120,
      units: 1,
      source: 'vision_slip',
      review_status: 'needs_review',
    },
    [{ description: bare, odds: -120, team: null, line: 'Over 1.5', type: 'total', match: 'France @ Paraguay' }],
  );

  const descs = legDescriptions(saved.id);
  assert.strictEqual(descs.length, 1, 'the single leg must persist');
  assert.strictEqual(descs[0], bare, 'storage must persist the bare description verbatim — it performs no binding');
  assert.ok(
    !/\(.+@.+\)/.test(descs[0]),
    'storage must NOT append a match binding — that is the model’s job (the reason the prompt rule exists)',
  );
});

console.log(`\nleg-match-binding: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Cleanup runs in a trailing setImmediate so the deferred dedup-telemetry
// writes queued during createBetWithLegs (logDedupEvent → setImmediate) flush
// against the still-open connection BEFORE we close it — otherwise they log a
// harmless-but-noisy "database connection is not open".
setImmediate(() => {
  try {
    db.close();
    fs.unlinkSync(DB_FILE);
  } catch (_) { /* best-effort */ }
});
