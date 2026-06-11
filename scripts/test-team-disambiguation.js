#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// P1 BEFORE-SNAPSHOT HARNESS — team-disambiguation + sport-detection
// ───────────────────────────────────────────────────────────────────────────
// READ-ONLY. No DB writes, no mutation, no network. Pure function calls +
// console output. Originally a before-snapshot of two high-blast-radius P1 bugs;
// both are now fixed (Bug 1 = 93cbe5e/564a88a/3d12196, Bug 2 = PR #36) and the
// KBO/unmodeled-league sport gate (this PR) is added below — ALL sections are
// GREEN today, so the harness is now a regression GATE: it exits NONZERO if any
// section regresses. Still read-only (no DB writes, no mutation, no network).
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
const { parseBetText, inferLegSport, reclassifySport, disambiguateAmbiguousTeam } = (() => {
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

// ─── Multi-franchise cases (Codex blocker): assert disambiguateAmbiguousTeam
//     DIRECTLY. The helper now matches a CONTIGUOUS "<city> <nickname>" phrase
//     and ABSTAINS (returns null) when the string holds franchises of DIFFERENT
//     sports. The old (nickname-anywhere + that-nickname's-city-anywhere) logic
//     force-classified these to the first table hit / wrong sport; phrase-match
//     + abstain fixes it. expected:null means "should abstain, let downstream
//     resolve the cross-sport string". These assert the helper's return value,
//     not the 3-way gate (null isn't a sport the stored/infer/reclass paths emit).
const MULTI_FRANCHISE_CASES = [
  { input: 'New York Rangers vs Giants',                  expected: 'NHL', note: 'only "new york rangers" is a phrase; bare "giants" has no adjacent city (old bug: NFL via giants + "new york")' },
  { input: 'New York Giants vs Rangers',                  expected: 'NFL', note: 'only "new york giants" is a phrase; bare "rangers" has no adjacent city' },
  { input: 'New York Rangers ML, San Francisco Giants ML', expected: null, note: 'NHL + MLB franchises → conflict → abstain (old bug: forced MLB via giants + "san francisco")' },
  { input: 'Florida Panthers vs Sacramento Kings',        expected: null, note: 'NHL + NBA franchises → conflict → abstain (old bug: forced NBA via kings + "sacramento")' },
];

// ─── Sport-gate cases (KBO incident 2026-06-11, ingest disc_1514481735335805030):
//     normalizeDescription(text, declaredSport) must NOT expand nickname aliases
//     when the declared sport is a league we don't model (no team mappings in
//     teams.json). A bare "Eagles"/"Lions"/"Twins"/"Giants" in a KBO slip is a
//     Korean club (Hanwha Eagles, Samsung Lions), not Philadelphia Eagles /
//     Detroit Lions — expanding it splices a real, wrong US team into the slip.
//     `sport` omitted ⇒ no declared context ⇒ expand as before (backward compat,
//     the shape every other caller + the Bug 1 cases above use).
const SPORT_GATE_CASES = [
  // — declared KBO: byte-identical passthrough (the live incident) —
  { input: 'Hanwha Eagles +1.5', sport: 'KBO', expected: 'Hanwha Eagles +1.5',
    note: 'KBO Hanwha Eagles must NOT become "Hanwha Philadelphia Eagles"' },
  { input: 'Samsung Lions ML', sport: 'KBO', expected: 'Samsung Lions ML',
    note: 'KBO Samsung Lions must NOT become "Samsung Detroit Lions" ("ML" is bet-context)' },
  { input: 'Hanwha Eagles +1.5 / SSG Landers +1.5 / Samsung Lions ML', sport: 'KBO',
    expected: 'Hanwha Eagles +1.5 / SSG Landers +1.5 / Samsung Lions ML',
    note: 'the live 3-leg repro stays uncorrupted end-to-end through normalizeDescription' },
  { input: 'Samsung Lions ML', sport: 'kbo', expected: 'Samsung Lions ML',
    note: 'sport match is case-insensitive' },
  // — other unmodeled leagues suppress too (general fix, not KBO-exhaustive) —
  { input: 'Kings ML', sport: 'KHL', expected: 'Kings ML',
    note: 'KHL: "kings" (NBA/NHL collision) left raw for an unmodeled league' },
  { input: 'Giants -1.5', sport: 'NPB', expected: 'Giants -1.5',
    note: 'NPB Yomiuri Giants left raw, not San Francisco/NY Giants' },
  // — modeled leagues still expand exactly as before (no regression) —
  { input: 'Eagles ML', sport: 'NFL', expected: 'Philadelphia Eagles ML',
    note: 'NFL context: Eagles expansion unchanged' },
  { input: 'Lions -3.5', sport: 'NFL', expected: 'Detroit Lions -3.5',
    note: 'NFL context: Lions expansion unchanged' },
  { input: 'Cards ML', sport: 'MLB', expected: 'St. Louis Cardinals ML',
    note: 'MLB: real alias expansion still fires for a modeled league' },
  { input: 'Minnesota Twins -1.5', sport: 'MLB', expected: 'Minnesota Twins -1.5',
    note: 'MLB: "Twins" is not an alias in teams.json → unchanged (modeled, no match)' },
  // — backward compat: no declared sport ⇒ expand (every existing caller) —
  { input: 'Eagles ML', sport: undefined, expected: 'Philadelphia Eagles ML',
    note: 'no declared sport → prior behavior preserved (expand)' },
  // — 'Unknown'/placeholder ⇒ EXPAND: detectSport returns the literal 'Unknown'
  //   for abbreviation/slang/player-prop text; suppressing it would regress the
  //   common LAL/GSW/Dubs class vs main (review HIGH finding) —
  { input: 'LAL -3.5 vs GSW', sport: 'Unknown',
    expected: 'Los Angeles Lakers -3.5 vs Golden State Warriors',
    note: "Unknown = no league signal → expand (detectSport's value for abbreviations)" },
  { input: 'Dubs ML', sport: 'Unknown', expected: 'Golden State Warriors ML',
    note: 'Unknown still expands modeled-team aliases' },
  { input: 'Cards ML', sport: 'N/A', expected: 'St. Louis Cardinals ML',
    note: 'placeholder containing "/" recognized before the compound split' },
  // — long-form modeled labels expand via whole-word league CODE match —
  { input: 'Lakers -3.5', sport: 'NBA Basketball', expected: 'Los Angeles Lakers -3.5',
    note: 'long-form "NBA Basketball" → \\bNBA\\b whole word → expand' },
  // — generic / full league NAMES for a modeled league expand ("Baseball" is a
  //   real stored sport — tests/s1b-measure-fixture.test.js) —
  { input: 'Cards ML', sport: 'Baseball', expected: 'St. Louis Cardinals ML',
    note: 'generic name "Baseball" → MLB → expand (LEAGUE_NAME_ALIASES)' },
  { input: 'Oilers ML', sport: 'Hockey', expected: 'Edmonton Oilers ML',
    note: 'generic name "Hockey" → NHL → expand' },
  { input: 'Cards ML', sport: 'Major League Baseball', expected: 'St. Louis Cardinals ML',
    note: 'full league name (multi-word, checked before the / & , split)' },
  { input: 'Eagles ML', sport: 'American Football', expected: 'Philadelphia Eagles ML',
    note: 'unambiguous full name → NFL → expand' },
  // — but bare "Football" (globally = soccer) and foreign-qualified names suppress —
  { input: 'Eagles ML', sport: 'Football', expected: 'Eagles ML',
    note: 'bare "Football" OMITTED from LEAGUE_NAME_ALIASES (soccer-ambiguous) → suppress' },
  { input: 'Cards ML', sport: 'Korean Baseball', expected: 'Cards ML',
    note: 'foreign-qualified name never exact-matches "Baseball" → suppress' },
  // — extra no-signal placeholders expand —
  { input: 'Cards ML', sport: 'Pending', expected: 'St. Louis Cardinals ML',
    note: 'Pending = no league signal → expand' },
  // — WNBA/NCAAF carry a code-LIKE string but no whole-word code → suppress
  //   (those teams are not in teams.json; suppressing avoids college/W collisions) —
  { input: 'Eagles ML', sport: 'WNBA', expected: 'Eagles ML',
    note: 'WNBA: no \\bNBA\\b whole word (W glued on) → not modeled → suppress' },
  { input: 'Eagles ML', sport: 'NCAAF', expected: 'Eagles ML',
    note: 'college not modeled → suppress (e.g. Boston College Eagles never US Eagles)' },
  // — sponsor-prefix guard: sport-INDEPENDENT backstop for the bare-text path,
  //   where detectSport mislabels "Hanwha Eagles" as NFL —
  { input: 'Hanwha Eagles +1.5', sport: 'NFL', expected: 'Hanwha Eagles +1.5',
    note: 'sponsor guard: "Hanwha" prefix → Korean club, stays raw even when mislabeled NFL' },
  { input: 'Hanwha Eagles +1.5', sport: undefined, expected: 'Hanwha Eagles +1.5',
    note: 'sponsor guard fires regardless of declared sport (bare-text path)' },
  { input: 'Samsung Lions ML', sport: 'NFL', expected: 'Samsung Lions ML',
    note: 'sponsor guard overrides bet-context: "ML" would otherwise expand Lions' },
  { input: 'KT Wiz ML', sport: undefined, expected: 'KT Wiz ML',
    note: 'sponsor "KT" guards "Wiz" (Washington Wizards alias)' },
  { input: 'KT\nLions ML', sport: undefined, expected: 'KT\nDetroit Lions ML',
    note: 'guard is SAME-LINE only: a bare sponsor ending a leg does not reach the next line' },
  { input: 'Philadelphia Eagles ML', sport: 'NFL', expected: 'Philadelphia Eagles ML',
    note: 'real NFL Eagles unaffected — "Philadelphia" is not a sponsor token' },
  { input: 'Eagles ML', sport: 'NFL', expected: 'Philadelphia Eagles ML',
    note: 'no sponsor prefix → normal NFL expansion still fires' },
  // — compound declared sport (mirrors validateLegSportConsistency set-split) —
  { input: 'Eagles ML', sport: 'MLB/NHL', expected: 'Philadelphia Eagles ML',
    note: 'compound, every part modeled → expand' },
  { input: 'Eagles ML', sport: 'MLB/KBO', expected: 'Eagles ML',
    note: 'compound with an unmodeled part → suppress (KBO leg can\'t be corrupted)' },
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
  console.log(' [S/I/R ✓/✗] = each of STORED / INFER / RECLASS vs EXPECT · 3-way gate = all three == EXPECT');
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
      const inferRaw = inferLegSport(c.input);
      const reclass = reclassifySport(stored, c.input); // reclassifySport(<detected sport>, input)
      const storedOk = stored === c.expected;
      const inferOk = inferRaw === c.expected;
      const reclassOk = reclass === c.expected;
      rows.push({
        ...c, stored,
        infer: inferRaw == null ? '(null)' : inferRaw,
        reclass, storedOk, inferOk, reclassOk,
        allOk: storedOk && inferOk && reclassOk,
        ok: storedOk, // headline verdict tracks STORED — the value actually persisted
      });
    }
  } finally {
    console.log = origLog;
  }

  const W = 30, S = 7;
  const m = (ok) => (ok ? `${GREEN}✓${RST}` : `${RED}✗${RST}`); // each column vs EXPECT
  console.log(`\n  ${'INPUT'.padEnd(W)} ${'STORED'.padEnd(S)} ${'INFER'.padEnd(S)} ${'RECLASS'.padEnd(S)} ${'EXPECT'.padEnd(S)} STORED?  vs EXPECT`);
  console.log(`  ${'─'.repeat(W)} ${'─'.repeat(S)} ${'─'.repeat(S)} ${'─'.repeat(S)} ${'─'.repeat(S)} ───────  ─────────`);
  for (const r of rows) {
    const cells = `${String(r.stored).padEnd(S)} ${String(r.infer).padEnd(S)} ${String(r.reclass).padEnd(S)} ${String(r.expected).padEnd(S)}`;
    const compare = `[S${m(r.storedOk)} I${m(r.inferOk)} R${m(r.reclassOk)}]`;
    console.log(`  ${JSON.stringify(r.input).padEnd(W)} ${cells} ${pass(r.ok)}  ${compare}`);
    console.log(`      ${DIM}${r.note}${RST}`);
  }
  const p = rows.filter((r) => r.ok).length;
  const consistent = rows.filter((r) => r.allOk).length;
  console.log(`\n  Bug 2 (STORED verdict — the value persisted): ${p}/${rows.length} pass`);
  console.log(`  Bug 2 (3-way gate STORED==INFER==RECLASS==EXPECT): ${consistent}/${rows.length} consistent`);
  const broken = rows.filter((r) => !r.allOk);
  if (broken.length) {
    console.log(`  ${DIM}↳ not 3-way consistent (fix target): ${broken.map((r) => JSON.stringify(r.input)).join(', ')}${RST}`);
  }
  return rows;
}

// ─── Multi-franchise: call disambiguateAmbiguousTeam DIRECTLY and assert its
//     return value (a sport string, or null when it abstains on a cross-sport
//     conflict). This is the unit the Codex blocker was about — the contiguous
//     phrase match — so it is asserted at the helper, not through the callers.
function runMultiFranchise() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' MULTI-FRANCHISE — disambiguateAmbiguousTeam(text) asserted DIRECTLY');
  console.log(' Phrase-match a contiguous "<city> <nickname>"; abstain (null) on cross-sport conflict.');
  console.log('══════════════════════════════════════════════════════════════════════');
  const rows = MULTI_FRANCHISE_CASES.map((c) => {
    const out = quiet(() => disambiguateAmbiguousTeam(c.input));
    return { ...c, out, ok: out === c.expected };
  });
  const W = 42, S = 7;
  const show = (v) => (v == null ? '(null)' : v);
  console.log(`\n  ${'INPUT'.padEnd(W)} ${'GOT'.padEnd(S)} ${'EXPECT'.padEnd(S)} RESULT`);
  console.log(`  ${'─'.repeat(W)} ${'─'.repeat(S)} ${'─'.repeat(S)} ──────`);
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r.input).padEnd(W)} ${String(show(r.out)).padEnd(S)} ${String(show(r.expected)).padEnd(S)} ${pass(r.ok)}`);
    console.log(`      ${DIM}${r.note}${RST}`);
  }
  const p = rows.filter((r) => r.ok).length;
  console.log(`\n  Multi-franchise (helper-direct): ${p}/${rows.length} pass  ${p === rows.length ? '(phrase-match + abstain holds)' : '(REGRESSION)'}`);
  return rows;
}

// ─── Sport gate: normalizeDescription(text, declaredSport) suppresses alias
//     expansion for unmodeled leagues (KBO/KHL/NPB/…), expands for modeled ones,
//     and preserves the no-sport behavior. Asserted DIRECTLY on normalizeDescription.
function runSportGate() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' SPORT GATE — normalizeDescription(text, declaredSport) (services/normalization.js)');
  console.log(' Unmodeled league (KBO/KHL/NPB) → raw passthrough · modeled / no-sport → expand.');
  console.log('══════════════════════════════════════════════════════════════════════');
  const rows = SPORT_GATE_CASES.map((c) => {
    const out = quiet(() => normalizeDescription(c.input, c.sport));
    const added = addedTokens(c.input, out);
    return { ...c, out, ok: out === c.expected, added };
  });
  const W = 52, S = 9;
  const show = (v) => (v === undefined ? '(none)' : JSON.stringify(v));
  console.log(`\n  ${'INPUT'.padEnd(W)} ${'SPORT'.padEnd(S)} RESULT`);
  console.log(`  ${'─'.repeat(W)} ${'─'.repeat(S)} ──────`);
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r.input).padEnd(W)} ${String(show(r.sport)).padEnd(S)} ${pass(r.ok)}  -> ${JSON.stringify(r.out)}`);
    if (!r.ok && r.added.length) {
      console.log(`      ${RED}↳ INJECTED tokens: ${r.added.join(', ')}${RST}`);
    }
    console.log(`      ${DIM}${r.note}${RST}`);
  }
  const p = rows.filter((r) => r.ok).length;
  console.log(`\n  Sport gate: ${p}/${rows.length} pass  ${p === rows.length ? '(unmodeled leagues left raw, modeled ones expand)' : '(REGRESSION — alias injection on an unmodeled league)'}`);
  return rows;
}

// ─── End-to-end: the production regex fast-path (parseBetText → detectSport →
//     normalizeBet → normalizeDescription). detectSport returns 'Unknown' for
//     abbreviation/slang text, which must STILL canonicalize (review HIGH finding).
//     This catches the wiring, not just the unit gate.
const E2E_CASES = [
  { input: 'LAL -3.5 vs GSW', expectedDesc: 'Los Angeles Lakers -3.5 vs Golden State Warriors',
    note: "detectSport→'Unknown'; stored desc must be canonical, not raw 'LAL … GSW'" },
  { input: 'Dubs ML', expectedDesc: 'Golden State Warriors ML',
    note: "abbreviation/slang → 'Unknown' sport → still expands" },
];
async function runEndToEndUnknown() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' END-TO-END — parseBetText regex fast-path stores canonical desc for Unknown sport');
  console.log('══════════════════════════════════════════════════════════════════════');
  const rows = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    for (const c of E2E_CASES) {
      const parsed = await parseBetText(c.input);
      const bet = parsed && parsed.bets && parsed.bets[0];
      rows.push({ ...c, sport: bet ? bet.sport : '(no-bet)', desc: bet ? bet.description : '(no-bet)' });
    }
  } finally {
    console.log = origLog;
  }
  for (const r of rows) {
    r.ok = r.desc === r.expectedDesc;
    console.log(`  ${pass(r.ok)}  ${JSON.stringify(r.input).padEnd(20)} sport=${String(r.sport).padEnd(9)} -> ${JSON.stringify(r.desc)}`);
    console.log(`      ${DIM}${r.note}${RST}`);
  }
  const p = rows.filter((r) => r.ok).length;
  console.log(`\n  End-to-end: ${p}/${rows.length} pass  ${p === rows.length ? "('Unknown' sport keeps canonicalizing)" : '(REGRESSION — canonicalization lost on the Unknown bucket)'}`);
  return rows;
}

(async () => {
  console.log('P1 disambiguation + sport-detection harness (read-only)');
  const b1 = runBug1();
  const b2 = await runBug2();
  const mf = runMultiFranchise();
  const sg = runSportGate();
  const e2e = await runEndToEndUnknown();
  const total = b1.length + b2.length;
  // Headline pass count tracks STORED (the persisted value) for Bug 2 + the
  // Bug 1 injection guard — this is the number the before-snapshot documented.
  const passed = b1.filter((r) => r.ok).length + b2.filter((r) => r.ok).length;
  // The 3-way gate is the real Bug-2 fix criterion: STORED, INFER and RECLASS
  // must ALL equal EXPECT. Bug 1 has no INFER/RECLASS, so its ok IS its 3-way
  // state. The fix must drive this to total/total with zero green→red flips.
  const threeWay = b1.filter((r) => r.ok).length + b2.filter((r) => r.allOk).length;
  // Helper-direct gate: disambiguateAmbiguousTeam phrase-match + abstain.
  const mfPassed = mf.filter((r) => r.ok).length;
  // Sport gate: normalizeDescription unmodeled-league suppression (KBO incident).
  const sgPassed = sg.filter((r) => r.ok).length;
  const e2ePassed = e2e.filter((r) => r.ok).length;
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(` TOTAL (STORED verdict): ${passed}/${total} pass · ${total - passed} fail`);
  console.log(` 3-WAY GATE (STORED==INFER==RECLASS==EXPECT): ${threeWay}/${total} · ${threeWay === total ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(` MULTI-FRANCHISE (helper-direct phrase-match + abstain): ${mfPassed}/${mf.length} · ${mfPassed === mf.length ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(` SPORT GATE (unmodeled-league alias suppression): ${sgPassed}/${sg.length} · ${sgPassed === sg.length ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(` END-TO-END (parseBetText Unknown-sport canonicalization): ${e2ePassed}/${e2e.length} · ${e2ePassed === e2e.length ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log('══════════════════════════════════════════════════════════════════════');
  // All sections are green today — exit NONZERO if any regresses so this acts as
  // a real gate (Bug 1 injection, Bug 2 3-way, multi-franchise, KBO sport gate, E2E).
  const green =
    b1.every((r) => r.ok) &&
    b2.every((r) => r.allOk) &&
    mf.every((r) => r.ok) &&
    sg.every((r) => r.ok) &&
    e2e.every((r) => r.ok);
  process.exit(green ? 0 : 1);
})();
