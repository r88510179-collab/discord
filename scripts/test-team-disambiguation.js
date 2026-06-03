#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// P1 BEFORE-SNAPSHOT HARNESS — team-disambiguation + sport-detection
// ───────────────────────────────────────────────────────────────────────────
// READ-ONLY. No DB writes, no mutation, no network. Pure function calls +
// console output. Captures CURRENT behavior of two high-blast-radius P1 bugs as
// a baseline / regression guard. FAILs printed below are the DOCUMENTED current
// state — this script does NOT fix anything and always exits 0.
//
//   Run:  node scripts/test-team-disambiguation.js
//
// ─── Step 1 findings (what sets the STORED sport — the single source of truth) ─
// There is no single global setter; the STORED top-level sport is path-dependent:
//
//   • Bare text picks (main Discord path, incl. DubClub-split totals like
//     "Cubs Cardinals O8"): handlers/messageHandler.js → ai.parseBetText(text).
//     With no image, parseBetText takes the regex fast-path (regexParseBet,
//     services/ai.js:611) which sets   sport: detectSport(text)  (ai.js:626).
//     normalizeBet (ai.js:473) then passes that sport through verbatim. So for
//     these shapes the STORED sport == detectSport(text). detectSport (ai.js:521)
//     is NOT exported, so this harness reaches it through the real entry point
//     parseBetText() — the "STORED" column below is parseBetText(text).bets[0].sport.
//   • LLM path (images / parlays / anything regexParseBet rejects): the LLM's
//     own "sport" field is stored verbatim (normalizeBet, ai.js:473). Not unit-
//     testable deterministically, so it is out of scope for this snapshot.
//
//   The OTHER three sport functions do NOT set the stored sport on the main path:
//   • reclassifySport (ai.js:1574) — Twitter ingest override (twitter-handler.js:199,
//     pre-storage) AND a grade-time re-derivation (grading.js:1508, gradePropWithAI).
//     It only changes a sport when EXACTLY ONE sport is detected; every shared
//     nickname matches ≥2 sports → "Multi-sport detected" → keeps original → no-op.
//   • inferLegSport (ai.js:1604) — per-LEG sport at grade time (grading.js:1597/1690)
//     and OCR-first wiring (ocrFirstWiring.js:95). Uses SPORT_TEAM_MAP (ai.js:1506),
//     whose iteration order (MLB→NBA→NFL→NHL) is OPPOSITE detectSport's TEAM_MAP
//     (NBA→NFL→MLB→NHL). That opposite ordering is why infer and stored disagree
//     on NFL/MLB-shared nicknames (cardinals, giants) — shown as a column below.
//
// ─── Bug 1 (injection) ───────────────────────────────────────────────────────
//   services/normalization.js normalizeDescription (L189) replaces every \bALIAS\b
//   from teams.json with its canonical name. Historically bare-city aliases
//   (baltimore, new york, chicago, …) injected the WRONG same-city team
//   ("Baltimore Orioles" → "Baltimore Ravens Orioles"). Those aliases were since
//   removed from data/mappings/teams.json (commits 93cbe5e, 564a88a) and the
//   un-removable common-noun nicknames context-guarded (3d12196). This harness
//   confirms NO injection on the current tree — i.e. it is the regression guard.
// ═══════════════════════════════════════════════════════════════════════════

// Importing services/ai.js pulls in services/database.js, which opens SQLite and
// runs migrations at module-load. Point it at an in-memory DB so this harness is
// hermetic: no bettracker.db file is created, no production data is touched.
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
// Belt-and-suspenders: the curated cases are all regex-fast-path eligible, so the
// LLM is never reached — but disable the Gemma vision fallback so a stray network
// path can never be taken.
process.env.GEMMA_FALLBACK_DISABLED = 'true';

const { normalizeDescription } = require('../services/normalization');
// services/ai.js → services/database.js runs migrations at module-load and logs
// each one. Silence stdout across the require so the snapshot output stays clean
// (the in-memory DB is rebuilt every run, so those logs are pure bootstrap noise).
const { parseBetText, inferLegSport, reclassifySport } = (() => {
  const orig = console.log;
  console.log = () => {};
  try { return require('../services/ai'); } finally { console.log = orig; }
})();

// ─── Bug 1 cases: full single-team names must pass through WITHOUT a second,
//     wrong same-city team being injected. `wouldInject` documents the team the
//     historical bare-city alias spliced in (illustrative — current expected: clean).
const BUG1_CASES = [
  { input: 'Baltimore Orioles',  expected: 'Baltimore Orioles',  wouldInject: 'Ravens (NFL)' },
  { input: 'New York Yankees',   expected: 'New York Yankees',   wouldInject: 'Giants/Jets (NFL)' },
  { input: 'Chicago Cubs',       expected: 'Chicago Cubs',       wouldInject: 'Bears (NFL)' },
  { input: 'Chicago White Sox',  expected: 'Chicago White Sox',  wouldInject: 'Bears (NFL)' },
  { input: 'Dallas Stars',       expected: 'Dallas Stars',       wouldInject: 'Cowboys (NFL)' },
  { input: 'Boston Red Sox',     expected: 'Boston Red Sox',     wouldInject: 'Celtics/Patriots' },
  { input: 'Miami Marlins',      expected: 'Miami Marlins',      wouldInject: 'Dolphins/Heat' },
  { input: 'Detroit Tigers',     expected: 'Detroit Tigers',     wouldInject: 'Lions/Pistons' },
  { input: 'Houston Astros',     expected: 'Houston Astros',     wouldInject: 'Texans/Rockets' },
  { input: 'Atlanta Braves',     expected: 'Atlanta Braves',     wouldInject: 'Falcons/Hawks' },
  // Clean control: a real two-team pick whose aliases SHOULD expand (proves the
  // function still works — correct expansion is not injection).
  { input: 'LAL -3.5 vs GSW',    expected: 'Los Angeles Lakers -3.5 vs Golden State Warriors', control: true },
];

// ─── Bug 2 cases: STORED sport (= parseBetText → detectSport) vs human-expected.
//     Covers the two task anchors + one case per ambiguous nickname
//     (cardinals / giants / rangers / kings / panthers / jets).
const BUG2_CASES = [
  { input: 'Chicago Cubs Cardinals O8', expected: 'MLB', note: 'anchor; "Cubs" is MLB-only → pins MLB (e96c4e5 fix)' },
  { input: 'Arizona Cardinals -3.5',    expected: 'NFL', note: 'anchor; lone "Cardinals" (NFL+MLB) → priority NBA>NFL>MLB>NHL lands NFL' },
  { input: 'St. Louis Cardinals ML',    expected: 'MLB', note: 'cardinals: lone shared nick → priority picks NFL, not the MLB team' },
  { input: 'San Francisco Giants -1.5', expected: 'MLB', note: 'giants: lone shared nick (NFL+MLB) → priority picks NFL' },
  { input: 'New York Rangers ML',       expected: 'NHL', note: 'rangers: lone shared nick (MLB+NHL) → priority picks MLB' },
  { input: 'Los Angeles Kings ML',      expected: 'NHL', note: 'kings: lone shared nick (NBA+NHL) → priority picks NBA' },
  { input: 'Florida Panthers -1.5',     expected: 'NHL', note: 'panthers: lone shared nick (NFL+NHL) → priority picks NFL' },
  { input: 'Winnipeg Jets ML',          expected: 'NHL', note: 'jets: lone shared nick (NFL+NHL) → priority picks NFL' },
];

// ── helpers ────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RST = '\x1b[0m';
const pass = (b) => (b ? `${GREEN}PASS${RST}` : `${RED}FAIL${RST}`);

// Run a function with console.log silenced (some production fns, e.g.
// reclassifySport, log internally; keep the table clean).
function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
}

// Word-level tokens added in `out` that were not in `inp` (case-insensitive) —
// surfaces an injected team at a glance.
function addedTokens(inp, out) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const before = new Set(norm(inp));
  return norm(out).filter((w) => !before.has(w));
}

function runBug1() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' BUG 1 — normalizeDescription team injection  (services/normalization.js:189)');
  console.log(' Expect: single-team names UNCHANGED (no wrong same-city team injected).');
  console.log('══════════════════════════════════════════════════════════════════════');
  const rows = BUG1_CASES.map((c) => {
    const out = quiet(() => normalizeDescription(c.input));
    const ok = out === c.expected;
    const added = addedTokens(c.input, out);
    return { ...c, out, ok, added };
  });

  const W = 28;
  for (const r of rows) {
    const tag = r.control ? `${DIM}(control: should expand)${RST}` : '';
    console.log(`${pass(r.ok)}  ${JSON.stringify(r.input).padEnd(W)} -> ${JSON.stringify(r.out)} ${tag}`);
    if (!r.control && r.added.length) {
      console.log(`      ${RED}↳ INJECTED tokens: ${r.added.join(', ')}${RST}  (would-inject: ${r.wouldInject})`);
    }
  }
  const p = rows.filter((r) => r.ok).length;
  console.log(`\n  Bug 1: ${p}/${rows.length} pass  ${p === rows.length ? '(no injection — regression guard holds)' : '(INJECTION PRESENT)'}`);
  return rows;
}

async function runBug2() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' BUG 2 — stored sport vs expected  (STORED = parseBetText→detectSport)');
  console.log(' INFER = inferLegSport (grade-time, per leg) · RECLASS = reclassifySport(STORED)');
  console.log('══════════════════════════════════════════════════════════════════════');

  // Compute every row first, then render a clean table. Suppress console.log
  // across the whole async loop — parseBetText/reclassifySport log internally,
  // and a sync wrapper would restore stdout before the awaited work runs.
  const rows = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    for (const c of BUG2_CASES) {
      const parsed = await parseBetText(c.input); // no image → regex fast-path → detectSport
      const stored = parsed && parsed.bets && parsed.bets[0] ? parsed.bets[0].sport : '(no-bet)';
      const infer = inferLegSport(c.input);
      const reclass = reclassifySport(stored, c.input);
      rows.push({ ...c, stored, infer: infer == null ? '(null)' : infer, reclass, ok: stored === c.expected });
    }
  } finally {
    console.log = origLog;
  }

  const W = 30, S = 7;
  console.log(`\n  ${'INPUT'.padEnd(W)} ${'STORED'.padEnd(S)} ${'INFER'.padEnd(S)} ${'RECLASS'.padEnd(S)} ${'EXPECT'.padEnd(S)} VERDICT`);
  console.log(`  ${'─'.repeat(W)} ${'─'.repeat(S)} ${'─'.repeat(S)} ${'─'.repeat(S)} ${'─'.repeat(S)} ───────`);
  for (const r of rows) {
    const disagree = r.infer !== r.stored ? `${DIM} ⟂ infer≠stored${RST}` : '';
    console.log(`  ${JSON.stringify(r.input).padEnd(W)} ${String(r.stored).padEnd(S)} ${String(r.infer).padEnd(S)} ${String(r.reclass).padEnd(S)} ${String(r.expected).padEnd(S)} ${pass(r.ok)}${disagree}`);
    console.log(`      ${DIM}${r.note}${RST}`);
  }
  const p = rows.filter((r) => r.ok).length;
  console.log(`\n  Bug 2: ${p}/${rows.length} pass  (FAILs = current sport-disambiguation bug; this is the before-snapshot)`);
  return rows;
}

(async () => {
  console.log('P1 disambiguation + sport-detection BEFORE-SNAPSHOT (read-only)');
  const b1 = runBug1();
  const b2 = await runBug2();
  const total = b1.length + b2.length;
  const passed = b1.filter((r) => r.ok).length + b2.filter((r) => r.ok).length;
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(` TOTAL: ${passed}/${total} pass · ${total - passed} fail (documented current state)`);
  console.log('══════════════════════════════════════════════════════════════════════');
  // Always exit 0 — this is a snapshot of current (buggy) behavior, not a CI gate.
  process.exit(0);
})();
