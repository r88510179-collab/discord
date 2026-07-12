// ═══════════════════════════════════════════════════════════
// PROP_PARSE_V2 tests — flag-gated MLB prop-parser v2 grammar
// (Build 2 blocker 2, MLB slice — services/sportsdata/mlb.js).
//
// Fixtures are the EXACT live strings sampled 2026-07-12 from the
// review_status='auto_void_no_searchable_data' backlog (the spec's
// positive/negative lists), plus the §5 router-safety invariants:
//   • off: byte-identical to the v1 parser (v2 unreachable, no emission).
//   • shadow: routing decisions byte-identical to off; ONE
//     prop_parse_v2_shadow event per distinct v2-rescued description
//     (recordStage stub — no DB) is the only side effect; a throwing
//     sink never propagates.
//   • enforce: v1-USABLE strings parse identically to v1 (regression
//     pins); v2 rescues the sampled failing shapes; explicit
//     exclusions stay null; "Los Angeles Dodgers Over 8.5 Runs" still
//     routes to the team grader (looksLikePlayerProp false).
// Plus: the new event type is registered in pipeline-events EVENT_TYPES
// (enum-drift tripwire stays quiet), and one end-to-end enforce grade
// through gradeMlbPlayerProp with a mocked statsapi fetch.
//
// Run:  node tests/mlb-prop-parse-v2.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const os = require('os');

// The parser itself is DB-free, but the event-registration check requires
// pipeline-events, which loads database.js — point DB_PATH at a throwaway
// file BEFORE any require so nothing touches a real DB.
process.env.DB_PATH = path.join(os.tmpdir(), `bettracker-prop-parse-v2-${process.pid}-${Date.now()}.db`);
// The module resolves PROP_PARSE_V2_MODE once at load — pin the default-off
// path by clearing the env var, then drive modes through the test seam.
delete process.env.PROP_PARSE_V2_MODE;

const mlb = require('../services/sportsdata/mlb');
const {
  parsePlayerProp, looksLikePlayerProp, resolvePropParseV2Mode, gradeMlbPlayerProp,
} = mlb;
const { parsePlayerPropV1, resetPropParseV2ShadowDedup } = mlb._internal;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Shadow-emission spy — the recordStage stub the spec asks for.
function makeSpy() {
  const events = [];
  const fn = (evt) => events.push(evt);
  return { events, fn };
}

// ── Fixtures (EXACT live strings) ─────────────────────────────────────────
// Positive: desc → expected { player, stat, direction, threshold } under
// enforce. `emits` = shadow must emit for it (i.e. v1 cannot usably parse it);
// "Ketel Marte O 0.5 Hits" is v1-parseable and pins the identity path instead.
const POSITIVE = [
  { desc: 'Over 0.5 Yandy Diaz Hits',                     player: 'Yandy Diaz',       stat: 'hits',       direction: 'over', threshold: 0.5, pattern: 'D',       emits: true },
  { desc: 'Over 0.5 Ramon Laureano - Home Runs',          player: 'Ramon Laureano',   stat: 'homeRuns',   direction: 'over', threshold: 0.5, pattern: 'D',       emits: true },
  { desc: 'Over 0.5 Shohei Ohtani - Doubles',             player: 'Shohei Ohtani',    stat: 'doubles',    direction: 'over', threshold: 0.5, pattern: 'D',       emits: true },
  { desc: 'Aaron Judge To Record A Hit',                  player: 'Aaron Judge',      stat: 'hits',       direction: 'over', threshold: 0.5, pattern: 'verbose', emits: true },
  { desc: 'Michael Harris II - TO RECORD 1+ HITS',        player: 'Michael Harris II', stat: 'hits',      direction: 'over', threshold: 0.5, pattern: 'verbose', emits: true },
  { desc: 'Over 0.5 JACKSON CHOURIO - TO RECORD 1+ HITS', player: 'JACKSON CHOURIO',  stat: 'hits',       direction: 'over', threshold: 0.5, pattern: 'D',       emits: true },
  { desc: 'Joey Cantillo - To Record 5+ Strikeouts',      player: 'Joey Cantillo',    stat: 'strikeOuts', direction: 'over', threshold: 4.5, pattern: 'verbose', emits: true },
  { desc: 'Kyle Harrison - Over 6.5 Strikeouts',          player: 'Kyle Harrison',    stat: 'strikeOuts', direction: 'over', threshold: 6.5, pattern: 'v1ext',   emits: true },
  { desc: 'IVAN HERRERA - HITS Over 0.5',                 player: 'IVAN HERRERA',     stat: 'hits',       direction: 'over', threshold: 0.5, pattern: 'verbose', emits: true },
  { desc: 'Nick Kurtz To Hit A Home Run',                 player: 'Nick Kurtz',       stat: 'homeRuns',   direction: 'over', threshold: 0.5, pattern: 'verbose', emits: true },
  { desc: 'Mike Trout HR',                                player: 'Mike Trout',       stat: 'homeRuns',   direction: 'over', threshold: 0.5, pattern: 'bare_hr', emits: true },
  { desc: 'Pete Alonso HR',                               player: 'Pete Alonso',      stat: 'homeRuns',   direction: 'over', threshold: 0.5, pattern: 'bare_hr', emits: true },
  { desc: 'Mark Vientos Straight Bet HR',                 player: 'Mark Vientos',     stat: 'homeRuns',   direction: 'over', threshold: 0.5, pattern: 'bare_hr', emits: true },
  { desc: 'Davis Schneider O 0.5 Doubles',                player: 'Davis Schneider',  stat: 'doubles',    direction: 'over', threshold: 0.5, pattern: 'v1ext',   emits: true },
  { desc: 'Ketel Marte O 0.5 Hits',                       player: 'Ketel Marte',      stat: 'hits',       direction: 'over', threshold: 0.5, pattern: null,      emits: false },
];

// Negative: v2 must return null (parsePlayerProp null under enforce because v1
// is also null for each) and looksLikePlayerProp false under every mode.
const NEGATIVE = [
  'NRFI',
  'NRFI + NRSI',
  'Carter Jensen HR / FS',
  'J. Wetherholt .5 hits',
  'Under 0.5 1st Inning Total Runs',
  'MLB Picks',
  '4x MLB Data Sheets',
  'MLB Pick of the Day',
  'Stanton Rice Judge Trout SGP',
];

// v1-USABLE regression pins — must parse identically to parsePlayerPropV1
// under off, shadow AND enforce (the §5 v1-identity invariant).
const V1_PINS = [
  'Aaron Judge 2+ H+R+RBI',
  'Tarik Skubal O 17.5 Pitching Outs',
  'Aaron Judge 1+ Home Runs',
  'Ketel Marte O 0.5 Hits',
  'Juan Soto O 1.5 Total Bases',
  'Los Angeles Dodgers Over 8.5 Runs', // team-greedy v1 parse — team guard handles routing
];

(async () => {
  // ── Mode resolution (load-once idiom, slateResplit parity) ──
  console.log(' mode resolution:');
  check("unset → 'off'", resolvePropParseV2Mode(undefined) === 'off');
  check("'' → 'off'", resolvePropParseV2Mode('') === 'off');
  check("garbage → 'off'", resolvePropParseV2Mode('banana') === 'off');
  check("'shadow' → 'shadow'", resolvePropParseV2Mode('shadow') === 'shadow');
  check("' ENFORCE ' → 'enforce'", resolvePropParseV2Mode(' ENFORCE ') === 'enforce');
  check('module default (env unset) is off', mlb._internal.PROP_PARSE_V2_MODE === 'off');

  // ── Event type registered (enum-drift tripwire stays quiet) ──
  const pe = require('../services/pipeline-events');
  check("pipeline-events EVENT_TYPES includes 'prop_parse_v2_shadow'",
    pe.EVENT_TYPES.includes('prop_parse_v2_shadow'));

  // ── off: byte-identical to v1 for EVERY fixture, no emission ──
  console.log(' off — byte-identical to v1, v2 unreachable:');
  {
    const spy = makeSpy();
    let allIdentical = true;
    for (const f of [...POSITIVE.map(p => p.desc), ...NEGATIVE, ...V1_PINS]) {
      const got = parsePlayerProp(f, { mode: 'off', recordStageFn: spy.fn });
      if (!deepEq(got, parsePlayerPropV1(f))) { allIdentical = false; check(`off identical: ${f}`, false, JSON.stringify(got)); }
    }
    check('every fixture parses identically to v1 under off', allIdentical);
    check('no emission under off', spy.events.length === 0, `${spy.events.length} events`);
    check('default-mode call (no opts) ≡ v1 for a v2-only shape',
      deepEq(parsePlayerProp('Over 0.5 Yandy Diaz Hits'), parsePlayerPropV1('Over 0.5 Yandy Diaz Hits')));
  }

  // ── shadow: routing byte-identical to off; emission the only side effect ──
  console.log(' shadow — routing identical, one event per distinct rescued desc:');
  {
    resetPropParseV2ShadowDedup();
    const spy = makeSpy();
    let allIdentical = true;
    let allRouting = true;
    for (const f of [...POSITIVE.map(p => p.desc), ...NEGATIVE, ...V1_PINS]) {
      const shadowed = parsePlayerProp(f, { mode: 'shadow', recordStageFn: spy.fn });
      if (!deepEq(shadowed, parsePlayerProp(f, { mode: 'off' }))) { allIdentical = false; check(`shadow parse identical: ${f}`, false); }
      if (looksLikePlayerProp(f, { mode: 'shadow', recordStageFn: spy.fn }) !==
          looksLikePlayerProp(f, { mode: 'off' })) { allRouting = false; check(`shadow routing identical: ${f}`, false); }
    }
    check('shadow parse results byte-identical to off (all fixtures)', allIdentical);
    check('shadow looksLikePlayerProp verdicts byte-identical to off (all fixtures)', allRouting);

    const expected = POSITIVE.filter(p => p.emits);
    check(`exactly one event per rescued positive (${expected.length})`,
      spy.events.length === expected.length,
      `got ${spy.events.length}: ${spy.events.map(e => e.payload && e.payload.desc).join(' | ')}`);

    // dedup: a second pass over the same strings emits nothing new
    for (const p of expected) parsePlayerProp(p.desc, { mode: 'shadow', recordStageFn: spy.fn });
    check('re-parsing the same descriptions emits nothing (per-process dedup)',
      spy.events.length === expected.length);

    // payload shape + envelope
    const byDesc = new Map(spy.events.map(e => [e.payload.desc, e]));
    let payloadOk = true;
    for (const p of expected) {
      const e = byDesc.get(p.desc.slice(0, 90));
      const ok = e
        && e.eventType === 'prop_parse_v2_shadow'
        && e.sourceType === 'grading'
        && e.stage === 'GRADING_ENTER'
        && e.payload.desc.length <= 90
        && e.payload.pattern === p.pattern
        && e.payload.player === p.player
        && e.payload.stat === p.stat
        && e.payload.threshold === p.threshold
        && e.payload.direction === p.direction;
      if (!ok) { payloadOk = false; check(`payload for: ${p.desc}`, false, JSON.stringify(e)); }
    }
    check('every emission carries the spec payload {desc<=90, pattern, player, stat, threshold, direction}', payloadOk);

    // a throwing sink must never throw into grading
    resetPropParseV2ShadowDedup();
    let threw = false;
    let result;
    try {
      result = parsePlayerProp('Over 0.5 Yandy Diaz Hits', { mode: 'shadow', recordStageFn: () => { throw new Error('sink boom'); } });
    } catch (_) { threw = true; }
    check('throwing recordStage sink never propagates (emit is try/caught)', !threw && result === null, `threw=${threw} result=${JSON.stringify(result)}`);
  }

  // ── enforce: v2 parses the sampled failing shapes ──
  console.log(' enforce — v2 rescues the live failing shapes:');
  for (const p of POSITIVE) {
    const got = parsePlayerProp(p.desc, { mode: 'enforce' });
    const ok = got
      && got.player === p.player
      && got.stat === p.stat
      && got.direction === p.direction
      && got.threshold === p.threshold
      && (got.fields == null);
    check(`enforce: ${p.desc}`, ok, JSON.stringify(got));
  }
  console.log(' enforce — leading threshold WINS over the embedded verbose one:');
  {
    const got = parsePlayerProp('Over 0.5 JACKSON CHOURIO - TO RECORD 1+ HITS', { mode: 'enforce' });
    check('embedded "1+" is stat-phrase text, not a second parse (threshold 0.5, not 0.5-from-1+)',
      got && got.threshold === 0.5 && got.player === 'JACKSON CHOURIO', JSON.stringify(got));
  }

  // ── enforce: negatives stay null / non-prop ──
  console.log(' enforce — exclusions and negatives stay null:');
  for (const d of NEGATIVE) {
    check(`null under enforce: ${d}`, parsePlayerProp(d, { mode: 'enforce' }) === null,
      JSON.stringify(parsePlayerProp(d, { mode: 'enforce' })));
    check(`looksLikePlayerProp false under enforce: ${d}`, looksLikePlayerProp(d, { mode: 'enforce' }) === false);
  }

  // ── §5 router-safety invariants ──
  console.log(' §5 invariants:');
  {
    let allPinned = true;
    for (const mode of ['off', 'shadow', 'enforce']) {
      resetPropParseV2ShadowDedup();
      for (const d of V1_PINS) {
        if (!deepEq(parsePlayerProp(d, { mode, recordStageFn: () => {} }), parsePlayerPropV1(d))) {
          allPinned = false; check(`v1 pin under ${mode}: ${d}`, false);
        }
      }
    }
    check('v1-parseable strings parse identically under off/shadow/enforce', allPinned);
    for (const mode of ['off', 'shadow', 'enforce']) {
      check(`"Los Angeles Dodgers Over 8.5 Runs" stays TEAM route under ${mode}`,
        looksLikePlayerProp('Los Angeles Dodgers Over 8.5 Runs', { mode, recordStageFn: () => {} }) === false);
    }
    // bare-noun set is HR-ONLY — a bare hits/doubles/Ks noun must NOT parse
    for (const d of ['Mike Trout Hits', 'Shohei Ohtani Doubles', 'Joey Cantillo Ks']) {
      check(`bare non-HR noun stays null under enforce: ${d}`,
        parsePlayerProp(d, { mode: 'enforce' }) === null);
    }
    // a team-subject bare-HR line is a TEAM market, never a player prop
    check('"Yankees HR" stays null under enforce (subject canonicalizes to a team)',
      parsePlayerProp('Yankees HR', { mode: 'enforce' }) === null);
  }

  // ── enforce end-to-end: a v2 parse actually GRADES via the box score ──
  console.log(' enforce end-to-end (mocked statsapi):');
  {
    const realFetch = global.fetch;
    const schedule = { dates: [{ games: [{ gamePk: 777, gameDate: '2026-07-01T23:10:00Z', status: { abstractGameState: 'Final', detailedState: 'Final' } }] }] };
    const feed = {
      liveData: { boxscore: { teams: { home: { team: { name: 'Tampa Bay Rays' }, players: {
        p1: { person: { fullName: 'Yandy Diaz' }, stats: { batting: { hits: 2 }, pitching: {} } },
      } }, away: { team: { name: 'Boston Red Sox' }, players: {} } } } },
    };
    global.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/schedule') ? schedule : feed),
    });
    try {
      const graded = await gradeMlbPlayerProp('Over 0.5 Yandy Diaz Hits', '2026-07-01', { propParseV2: { mode: 'enforce' } });
      check('v2-parsed prop grades WIN from the box score',
        graded.resolved === true && graded.status === 'WIN' && /Yandy Diaz had 2 hits/.test(graded.evidence),
        JSON.stringify(graded));
      const offGraded = await gradeMlbPlayerProp('Over 0.5 Yandy Diaz Hits', '2026-07-01');
      check('same call under module default (off) still refuses (unparseable_player_prop)',
        offGraded.resolved === false && offGraded.reason === 'unparseable_player_prop',
        JSON.stringify(offGraded));
    } finally {
      global.fetch = realFetch;
    }
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
