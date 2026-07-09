// ═══════════════════════════════════════════════════════════
// event_date prompt-region pinning (leg-match-binding precedent, PR #188).
//
// The EVENT DATE/TIME extraction directives are prompt-only behavior — no
// code enforces them — so this test pins the load-bearing strings inside each
// LLM prompt region of services/ai.js the way tests/leg-match-binding.test.js
// pins the MATCH BINDING rule: fs.readFileSync the source, slice each prompt
// region between two literal anchors (with an anchor-sanity check so a moved
// prompt fails loudly, never pins an empty region), then assert the directive
// text. No LLM call anywhere.
//
// Regions pinned:
//   A. parseBetText sys prompt (the live slip-vision + text parser; #154's
//      directive + BOTH worked-example shapes — one populated, one null — the
//      anti-always-fill design).
//   B. parseGemmaOutputWithCerebras sys prompt (parity directive; dormant
//      while GEMMA_FALLBACK_DISABLED=true).
//   C. parseBetSlipImage sys prompt (NEW this PR: the 🔄 re-ingest #182 and
//      Onyx pure-slip reclassify #179 paths create bets through it, and it
//      previously had no event_date field at all).
//
// Also pins the ingest THREADING added this PR — the payload sites that
// previously dropped an extracted event_date on the floor (the reason
// twitter_vision, the single largest source bucket, was 100% NULL):
//   D. services/twitter-handler.js — the vision pick rebuild + all three
//      createBetWithLegs payloads carry event_date.
//   E. services/warRoom.js — war_split singles deliberately do NOT inherit
//      the parent's event_date (adversarial-review decision: split legs are
//      independent picks, often different days; the parent's one date is
//      wrong for off-day legs, sits inside the ±(-2..+60d) guard, and Gate 4's
//      ±1d tolerance passes it → silent wrong-game grade). Pinned as ABSENCE
//      so a future "fix" can't re-thread it without meeting this rationale.
// (Source-level pins, matching the repo's driveable-surface reality: the
// tweet pipeline has no end-to-end harness — tests/twitter-repost-dedup.test.js
// exercises exported helpers only. The ocrFirstWiring threading has a real
// behavior test in tests/ocr-first/wiring.test.js.)
//
// RED-proof: pins C/D/E fail on pre-PR source (`git stash` the five files);
// A/B are anti-regression pins of #154's shipped directives.
//
// Run: node tests/event-date-prompt-pinning.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// Slice a prompt region between two literal anchors, asserting both exist and
// are ordered so a refactor fails loudly instead of silently pinning ''.
function sliceRegion(src, label, startAnchor, endAnchor) {
  const start = src.indexOf(startAnchor);
  const end = src.indexOf(endAnchor, start);
  check(`${label} region isolated (anchors present, ordered)`, () => {
    assert.ok(start !== -1, `${label}: start anchor ${JSON.stringify(startAnchor)} not found`);
    assert.ok(end !== -1, `${label}: end anchor ${JSON.stringify(endAnchor)} not found`);
    assert.ok(end > start, `${label}: end anchor must follow start anchor`);
  });
  return src.slice(start, end);
}

const AI_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'ai.js'), 'utf8');

const DIRECTIVE_NEVER_GUESS = 'NEVER invent, infer, or compute a date — copy only what is shown.';

// ── A. parseBetText (live slip-vision + text parser) ─────────
console.log('\nA. parseBetText sys prompt');
// 'RESPONSE TYPE 1 — New Bet:' opens the worked-example block; the prompt
// closes with the 'Output strictly valid JSON' footer (same end anchor as
// leg-match-binding). This window spans both examples + the STRICT RULES list.
const REGION_A = sliceRegion(AI_SRC, 'parseBetText', 'RESPONSE TYPE 1 — New Bet:', 'Output strictly valid JSON');

check('EVENT DATE/TIME directive present exactly once', () => {
  assert.strictEqual(
    countOccurrences(REGION_A, '- EVENT DATE/TIME: If the slip/text shows a game date or start time'),
    1,
  );
});
check('directive demands VERBATIM copy into "event_date"', () => {
  assert.ok(REGION_A.includes('copy it VERBATIM into "event_date"'));
});
check('directive carries the omit-if-not-visible / never-guess rule', () => {
  assert.ok(REGION_A.includes('If no date/time is visible, set "event_date": null.'));
  assert.ok(REGION_A.includes(DIRECTIVE_NEVER_GUESS));
});
check('BOTH example shapes present: populated STRAIGHT + null PARLAY (anti always-fill)', () => {
  assert.ok(
    REGION_A.includes('"event_date":"Today 7:10 PM ET"'),
    'populated worked example missing — the model needs to see the filled shape',
  );
  assert.ok(
    REGION_A.includes('"event_date":null'),
    'null worked example missing — without it the model drifts toward always filling',
  );
});

// ── B. parseGemmaOutputWithCerebras (dormant parity) ─────────
console.log('\nB. parseGemmaOutputWithCerebras sys prompt');
const REGION_B = sliceRegion(
  AI_SRC,
  'parseGemmaOutputWithCerebras',
  'You are a strict JSON normalizer.',
  'NEVER fabricate. If the PICK lines do not support a field, use null.',
);
check('PICK-line date directive present (verbatim copy, never fabricate)', () => {
  assert.strictEqual(
    countOccurrences(REGION_B, '- If a PICK line shows a game date/time, copy it verbatim into "event_date"; otherwise null. Never fabricate a date.'),
    1,
  );
});
check('expected-shape example keeps "event_date":null', () => {
  assert.ok(REGION_B.includes('"event_date":null'));
});

// ── C. parseBetSlipImage (🔄 re-ingest #182 / pure-slip reclassify #179) ──
console.log('\nC. parseBetSlipImage sys prompt');
const REGION_C = sliceRegion(
  AI_SRC,
  'parseBetSlipImage',
  'Bet slip OCR expert.',
  'Transcribe team and player names EXACTLY as printed',
);
check('EVENT DATE/TIME directive present exactly once', () => {
  assert.strictEqual(
    countOccurrences(REGION_C, 'EVENT DATE/TIME: If the slip shows a game date or start time'),
    1,
  );
});
check('directive demands VERBATIM copy + null-when-absent + never-guess', () => {
  assert.ok(REGION_C.includes('copy it VERBATIM into "event_date"'));
  assert.ok(REGION_C.includes('If no date/time is visible, set "event_date": null.'));
  assert.ok(REGION_C.includes(DIRECTIVE_NEVER_GUESS));
});
check('JSON example carries a populated event_date field', () => {
  assert.ok(REGION_C.includes('"event_date":"Today 7:10 PM ET"'));
});
check('normalizeBet passes event_date through for every parser (ai.js)', () => {
  assert.ok(AI_SRC.includes('event_date: bet.event_date || null'));
});

// ── D. twitter-handler threading ─────────────────────────────
console.log('\nD. twitter-handler event_date threading');
const TW_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'twitter-handler.js'), 'utf8');

check('vision pick rebuild keeps bet.event_date', () => {
  // The rebuild whitelists fields off parsed.bets[0]; this is the historical
  // drop point that zeroed twitter_vision.
  const rebuild = TW_SRC.match(/pick = \{ sport: bet\.sport[^}]*\}/);
  assert.ok(rebuild, 'vision pick rebuild literal not found');
  assert.ok(rebuild[0].includes('event_date: bet.event_date || null'), rebuild && rebuild[0]);
});
check('every createBetWithLegs payload carries event_date (ladder, re-split, normal)', () => {
  const payloads = TW_SRC.match(/createBetWithLegs\(\{[^}]*\}/g) || [];
  assert.strictEqual(payloads.length, 3, `expected 3 createBetWithLegs payloads, found ${payloads.length}`);
  for (const p of payloads) {
    assert.ok(p.includes('event_date: pick.event_date || null'), `payload missing event_date: ${p.slice(0, 120)}…`);
  }
});

// ── E. warRoom split NON-threading (deliberate) ──────────────
console.log('\nE. warRoom war_split event_date non-inheritance (deliberate)');
const WR_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'warRoom.js'), 'utf8');

check('war_split payloads do NOT inherit the parent event_date (ABSENCE pin)', () => {
  // Split legs are independent picks, often on different days — the parent's
  // single date would be an in-bounds WRONG anchor for off-day legs (Gate 4
  // tolerance ±1d passes it → silent wrong-game grade). NULL keeps the
  // designed-safe created_at fallback. Do not re-thread without revisiting
  // that rationale (documented at both payload sites in warRoom.js).
  assert.strictEqual(
    countOccurrences(WR_SRC, 'event_date: originalBet.event_date'),
    0,
    'war_split must NOT inherit the parent event_date — see the rationale comments in warRoom.js',
  );
  assert.strictEqual(
    countOccurrences(WR_SRC, 'event_date DELIBERATELY NOT inherited'),
    1,
    'the rationale comment must stay with the desc-split payload',
  );
});
check('untracked-win payload stays date-less (no parent bet exists there)', () => {
  const untracked = WR_SRC.match(/source: 'untracked_win'/);
  assert.ok(untracked, 'untracked_win payload not found');
  // The war_logwin branch has no parent bet in scope; nothing to inherit.
  const region = WR_SRC.slice(untracked.index - 400, untracked.index + 100);
  assert.ok(!region.includes('event_date'), 'untracked_win must not fabricate an event_date');
});

console.log(`\nevent-date-prompt-pinning: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
