// ═══════════════════════════════════════════════════════════
// Spec §9 — grader event_date write-back.
//
// When a deterministic adapter (services/sportsdata / services/espn) RESOLVES a bet
// to a REAL matched game, that game carries its AUTHORITATIVE start date. If the
// bet's event_date is still NULL, the grader fills it from that resolved date —
// a self-healing event_date source that closes the NULL backlog with no OCR/
// hallucination risk (docs/specs/event-date-ingest.md §9). Strictly a side-effect:
// the grade outcome is untouched.
//
// Covers:
//   A. writeBackResolvedEventDate() unit:
//      - NULL event_date → filled with the GUARDED, full-ISO instant
//      - existing event_date → NEVER overwritten (in-memory fast-path AND the
//        race-safe `AND event_date IS NULL` SQL gate)
//      - implausible resolved date → NULLed by the storage guard (not written raw)
//      - no resolved date (null/''/undefined) → no write
//      - stored value is the full ISO instant, never date-only
//      - grader-INELIGIBLE bet (reverted to needs_review / manual_review_unmodeled_sport
//        mid-attempt) → NO write, mirroring the terminal grade write's eligibility gate
//        (Codex #156 P2); still-eligible (confirmed / NULL review_status) → still heals
//   B. Integration through gradePropWithAI (real §9 wiring + RED proof):
//      - a NULL-event_date MLB prop, resolved by the structured adapter, gets
//        event_date populated with the resolved game's guarded date  (RED: without
//        the write-back call, this stays NULL post-resolution)
//      - an EXISTING event_date is not overwritten by a resolution
//      - an AI-fallback PENDING (adapter did NOT resolve) writes nothing
//      - a needs_review bet still resolves but its event_date is NOT healed (the §9 P2
//        gate carried through the real structured call site)
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB. Must be set BEFORE requiring services/database.js.
const DB_PATH = path.join(os.tmpdir(), `bet-evd-writeback-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}
// Default slate mode (off) + soccer off, so the structured pre-check keys the slate
// off created_at exactly like prod default and nothing else perturbs the run.
delete process.env.EVENT_DATE_SLATE;
delete process.env.SOCCER_GRADER_MODE;
delete process.env.SOCCER_PROPS_MODE;

const { db, createBet } = require('../services/database');
const { writeBackResolvedEventDate, gradePropWithAI } = require('../services/grading');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

// Full ISO-8601 UTC instant (what the eventEtYMD slate + read-side consumers expect).
// Deliberately NOT date-only: a date-only event_date breaks eventEtYMD under
// EVENT_DATE_SLATE enforce (Phase-3 diagnosis).
const FULL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

db.prepare('INSERT OR REPLACE INTO cappers (id, display_name) VALUES (?, ?)').run('capper-wb', 'Writeback Capper');

function insertBet(id, eventDate, createdAt, { sport = 'MLB', bet_type = 'straight', description = 'Lakers ML -110', review_status = 'confirmed' } = {}) {
  // review_status defaults to 'confirmed' (= the bets-table column default, grader-eligible),
  // so every existing call is byte-unchanged. Pass 'needs_review' /
  // 'manual_review_unmodeled_sport' / null to exercise the eligibility gate (§9 P2).
  db.prepare(
    `INSERT OR REPLACE INTO bets (id, capper_id, sport, bet_type, description, event_date, created_at, result, review_status)
     VALUES (?, 'capper-wb', ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, sport, bet_type, description, eventDate, createdAt, review_status);
}
function storedEventDate(id) {
  return db.prepare('SELECT event_date FROM bets WHERE id = ?').get(id).event_date;
}

(async () => {
  // ── A. writeBackResolvedEventDate() unit ──────────────────────
  console.log('writeBackResolvedEventDate (unit):');

  // A1 — NULL event_date is filled with the guarded, full-ISO instant.
  insertBet('wb-fill', null, '2026-06-20 18:00:00');
  const filled = writeBackResolvedEventDate(
    { id: 'wb-fill', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('NULL event_date filled with the resolved game date',
    storedEventDate('wb-fill') === '2026-06-20T23:10:00.000Z',
    `stored="${storedEventDate('wb-fill')}"`);
  check('returns the stored ISO string', filled === '2026-06-20T23:10:00.000Z', `ret=${filled}`);
  check('stored value is a FULL ISO instant (not date-only)',
    FULL_ISO.test(storedEventDate('wb-fill')), `stored="${storedEventDate('wb-fill')}"`);

  // A2 — an existing event_date is NEVER overwritten (in-memory fast-path).
  insertBet('wb-keep', '2026-06-01T00:00:00.000Z', '2026-06-20 18:00:00');
  const kept = writeBackResolvedEventDate(
    { id: 'wb-keep', event_date: '2026-06-01T00:00:00.000Z', created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('existing event_date is NOT overwritten', storedEventDate('wb-keep') === '2026-06-01T00:00:00.000Z',
    `stored="${storedEventDate('wb-keep')}"`);
  check('no-overwrite returns null', kept === null, `ret=${kept}`);

  // A2b — race-safe SQL gate: even with a STALE in-memory event_date===null, the
  // `AND event_date IS NULL` clause refuses to clobber a value already in the DB.
  insertBet('wb-race', '2026-06-02T00:00:00.000Z', '2026-06-20 18:00:00');
  const raced = writeBackResolvedEventDate(
    { id: 'wb-race', event_date: null, created_at: '2026-06-20 18:00:00' }, // stale in-memory NULL
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('SQL gate refuses to clobber a DB value (stale in-memory NULL)',
    storedEventDate('wb-race') === '2026-06-02T00:00:00.000Z' && raced === null,
    `stored="${storedEventDate('wb-race')}" ret=${raced}`);

  // A3 — an implausible resolved date is NULLed by the storage guard, never written
  // raw. Resolved 2 years before created_at → gap far past the −2d bound.
  insertBet('wb-implausible', null, '2026-06-20 18:00:00');
  const guarded = writeBackResolvedEventDate(
    { id: 'wb-implausible', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2024-06-20T23:10:00Z', 'mlb_statsapi');
  check('implausible resolved date NULLed by guard → DB stays NULL',
    storedEventDate('wb-implausible') === null && guarded === null,
    `stored="${storedEventDate('wb-implausible')}" ret=${guarded}`);

  // A4 — no resolved date → no write.
  insertBet('wb-nodate', null, '2026-06-20 18:00:00');
  const n1 = writeBackResolvedEventDate({ id: 'wb-nodate', event_date: null, created_at: '2026-06-20 18:00:00' }, null, 's');
  const n2 = writeBackResolvedEventDate({ id: 'wb-nodate', event_date: null, created_at: '2026-06-20 18:00:00' }, undefined, 's');
  const n3 = writeBackResolvedEventDate({ id: 'wb-nodate', event_date: null, created_at: '2026-06-20 18:00:00' }, '', 's');
  check('null/undefined/empty resolved date → no write',
    storedEventDate('wb-nodate') === null && n1 === null && n2 === null && n3 === null,
    `stored="${storedEventDate('wb-nodate')}"`);

  // A5 — a bet id with NO matching `bets` row → no write. This is the PARLAY-LEG
  // path: gradeParlay grades each leg via gradeSingleBet with a synthetic legBet id
  // (`<parentId>-legN`, NOT a real row), so a leg's resolution must NOT write the
  // parent's event_date (spec §4 bet-level scope). The NULL-only UPDATE matches 0 rows.
  const legNoop = writeBackResolvedEventDate(
    { id: 'parlay-abc-leg1', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('synthetic parlay-leg id (no bets row) → no write',
    legNoop === null && db.prepare("SELECT COUNT(*) AS c FROM bets WHERE id = 'parlay-abc-leg1'").get().c === 0,
    `ret=${legNoop}`);

  // ── A6–A9. Grader-eligibility gate on the write-back (Codex #156 P2) ──────────
  // The terminal GRADE write carries GRADER_ELIGIBLE_WHERE (finalizeBetGrading →
  // gradeBet requireGraderEligible): a bet an operator reverts to needs_review
  // mid-attempt has its grade refused as a 0-change race-loss and stays parked. The §9
  // date side-write must carry the SAME gate — else a review-parked bet is left holding
  // the refused attempt's resolved date, which event-date-first grading later trusts
  // even though that attempt's grade was rejected. RED proof: without the
  // `AND ${GRADER_ELIGIBLE_WHERE}` clause on the UPDATE, A6/A7 write the date anyway.

  // A6 — reverted-to-needs_review bet, NULL event_date, PLAUSIBLE resolved date →
  // event_date must NOT be written (mirrors the grade refusal). This is the bug.
  insertBet('wb-needs-review', null, '2026-06-20 18:00:00', { review_status: 'needs_review' });
  const ineligNR = writeBackResolvedEventDate(
    { id: 'wb-needs-review', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('grader-INELIGIBLE (needs_review) → event_date NOT written (stays NULL)',
    storedEventDate('wb-needs-review') === null && ineligNR === null,
    `stored="${storedEventDate('wb-needs-review')}" ret=${ineligNR}`);

  // A7 — the OTHER hidden status (manual_review_unmodeled_sport) is equally ineligible.
  insertBet('wb-manual-review', null, '2026-06-20 18:00:00', { review_status: 'manual_review_unmodeled_sport' });
  const ineligMR = writeBackResolvedEventDate(
    { id: 'wb-manual-review', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('grader-INELIGIBLE (manual_review_unmodeled_sport) → event_date NOT written',
    storedEventDate('wb-manual-review') === null && ineligMR === null,
    `stored="${storedEventDate('wb-manual-review')}" ret=${ineligMR}`);

  // A8 — control: an explicitly grader-ELIGIBLE (confirmed) bet STILL heals. The fix
  // narrows ONLY the ineligible case; the normal still-eligible resolution is unchanged.
  insertBet('wb-confirmed', null, '2026-06-20 18:00:00', { review_status: 'confirmed' });
  const eligC = writeBackResolvedEventDate(
    { id: 'wb-confirmed', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('control: grader-ELIGIBLE (confirmed) bet still heals event_date',
    storedEventDate('wb-confirmed') === '2026-06-20T23:10:00.000Z' && eligC === '2026-06-20T23:10:00.000Z',
    `stored="${storedEventDate('wb-confirmed')}" ret=${eligC}`);

  // A9 — control: a NULL review_status (the gate's NULL-tolerant arm) is grader-ELIGIBLE
  // and STILL heals — a naive `review_status != 'needs_review'` form would wrongly skip
  // it under SQLite three-valued logic.
  insertBet('wb-null-review', null, '2026-06-20 18:00:00', { review_status: null });
  const eligNull = writeBackResolvedEventDate(
    { id: 'wb-null-review', event_date: null, created_at: '2026-06-20 18:00:00' },
    '2026-06-20T23:10:00Z', 'mlb_statsapi');
  check('control: NULL review_status (NULL-tolerant arm) still heals event_date',
    storedEventDate('wb-null-review') === '2026-06-20T23:10:00.000Z' && eligNull === '2026-06-20T23:10:00.000Z',
    `stored="${storedEventDate('wb-null-review')}" ret=${eligNull}`);

  // ── B. Integration through gradePropWithAI (real §9 wiring + RED proof) ──
  console.log('gradePropWithAI integration (§9 wiring):');

  // Date-aware MLB fetch stub (mirrors tests/event-date-slate.test.js), with the
  // schedule game now carrying its statsapi gameDate — the authoritative date §9
  // surfaces. Any unrouted URL (search backends) → benign empty 200 so a
  // non-resolving bet falls cleanly to GUARD-4 PENDING (no live HTTP).
  const realFetch = global.fetch;
  const GAME_DATE = '2026-06-20T23:10:00Z';                // matched game's own start instant
  const SLATE_YMD = '2026-06-20';                          // = created_at ET day (slate, off mode)
  const mlbGame = (pk, gameDate) => ({
    gamePk: pk, gameDate,
    status: { abstractGameState: 'Final', detailedState: 'Final' },
    teams: {
      away: { team: { name: 'San Diego Padres' }, score: 3, isWinner: false },
      home: { team: { name: 'Los Angeles Dodgers' }, score: 5, isWinner: true },
    },
  });
  const mlbBoxscore = (players) => ({ liveData: { boxscore: { teams: {
    away: { team: { name: 'San Diego Padres' }, players },
    home: { team: { name: 'Los Angeles Dodgers' }, players: {} },
  } } } });
  const laureano = (hits) => ({ ID1: { person: { fullName: 'Ramon Laureano', boxscoreName: 'Laureano' }, stats: { batting: { hits }, pitching: {} } } });
  // ESPN scoreboard event (mirrors tests/espn-validation.js mkEvent), with the
  // event-level `date` field §9 surfaces. Dodgers home win → "Dodgers ML" WIN.
  const SLATE_YMD_COMPACT = SLATE_YMD.replace(/-/g, '');
  const espnEvent = (date) => {
    const mkTeam = (name) => ({ displayName: name, shortDisplayName: name.split(' ').pop(), abbreviation: name.split(' ').map(w => w[0]).join('').toUpperCase() });
    return { id: 'espn-evt-1', date, competitions: [{
      competitors: [
        { team: mkTeam('Los Angeles Dodgers'), score: '5', homeAway: 'home', winner: true },
        { team: mkTeam('Miami Marlins'), score: '3', homeAway: 'away', winner: false },
      ],
      status: { type: { completed: true, description: 'Final' } },
    }] };
  };

  function installFetch({ slateGames = [], espnEvents = null }) {
    global.fetch = async (url) => {
      const u = String(url);
      let body;
      if (u.includes('/schedule')) {                   // statsapi (structured MLB)
        const dm = u.match(/date=(\d{4}-\d{2}-\d{2})/);
        const games = (dm && dm[1] === SLATE_YMD) ? slateGames : [];
        body = { dates: [{ games }] };
      } else if (/\/game\/\d+\/feed\/live/.test(u)) {
        body = mlbBoxscore(laureano(2));               // Laureano: 2 hits → O 0.5 WIN
      } else if (u.includes('/scoreboard')) {          // ESPN scoreboard
        const dm = u.match(/dates=(\d{8})/);
        body = { events: (espnEvents && dm && dm[1] === SLATE_YMD_COMPACT) ? espnEvents : [] };
      } else {
        body = {};                                     // benign empty (search) → no results
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  }

  const MLB_PROP = { sport: 'MLB', bet_type: 'straight', description: 'Ramon Laureano O 0.5 Hits' };

  // B1 — NULL event_date, adapter RESOLVES → event_date filled with the guarded
  // game date. This assertion is the RED proof: without the write-back call at the
  // structured consumption point, event_date stays NULL after the WIN.
  installFetch({ slateGames: [mlbGame(501, GAME_DATE)] });
  insertBet('wb-int-fill', null, '2026-06-20 18:00:00', MLB_PROP);
  const r1 = await gradePropWithAI(db.prepare("SELECT * FROM bets WHERE id = 'wb-int-fill'").get());
  check('integration: adapter resolved the prop to a WIN', r1 && r1.status === 'WIN', `result=${JSON.stringify(r1)}`);
  check('integration: NULL event_date healed from the resolved game date',
    storedEventDate('wb-int-fill') === '2026-06-20T23:10:00.000Z',
    `stored="${storedEventDate('wb-int-fill')}"`);
  check('integration: healed value is a FULL ISO instant',
    FULL_ISO.test(storedEventDate('wb-int-fill') || ''), `stored="${storedEventDate('wb-int-fill')}"`);

  // B2 — EXISTING event_date is not overwritten by a resolution.
  installFetch({ slateGames: [mlbGame(501, GAME_DATE)] });
  insertBet('wb-int-keep', '2026-06-20T18:00:00.000Z', '2026-06-20 18:00:00', MLB_PROP);
  const r2 = await gradePropWithAI(db.prepare("SELECT * FROM bets WHERE id = 'wb-int-keep'").get());
  check('integration: resolution still graded with an existing event_date', r2 && r2.status === 'WIN', `result=${JSON.stringify(r2)}`);
  check('integration: existing event_date NOT overwritten by resolution',
    storedEventDate('wb-int-keep') === '2026-06-20T18:00:00.000Z',
    `stored="${storedEventDate('wb-int-keep')}"`);

  // B3 — empty slate → adapter does NOT resolve → AI-fallback PENDING → NO write.
  installFetch({ slateGames: [] });
  insertBet('wb-int-pending', null, '2026-06-20 18:00:00', MLB_PROP);
  const r3 = await gradePropWithAI(db.prepare("SELECT * FROM bets WHERE id = 'wb-int-pending'").get());
  check('integration: unresolved bet returns PENDING', r3 && r3.status === 'PENDING', `result=${JSON.stringify(r3)}`);
  check('integration: AI-fallback PENDING writes NO event_date',
    storedEventDate('wb-int-pending') === null, `stored="${storedEventDate('wb-int-pending')}"`);

  // B4 — the OTHER consumption point: a team bet resolved by the ESPN pre-check
  // (tryGradeViaESPN) heals event_date from espnResult.eventDate (match.event.date).
  // A player prop would route to the structured path; a plain ML routes to ESPN.
  installFetch({ espnEvents: [espnEvent(GAME_DATE)] });
  insertBet('wb-int-espn', null, '2026-06-20 18:00:00', { sport: 'MLB', bet_type: 'straight', description: 'Los Angeles Dodgers ML' });
  const r4 = await gradePropWithAI(db.prepare("SELECT * FROM bets WHERE id = 'wb-int-espn'").get());
  check('integration (ESPN path): team ML resolved to WIN', r4 && r4.status === 'WIN', `result=${JSON.stringify(r4)}`);
  check('integration (ESPN path): NULL event_date healed via espnResult.eventDate',
    storedEventDate('wb-int-espn') === '2026-06-20T23:10:00.000Z', `stored="${storedEventDate('wb-int-espn')}"`);

  // B5 — the §9 P2 gate end-to-end through the REAL structured call site
  // (grading.js writeBackResolvedEventDate). A bet reverted to needs_review mid-attempt
  // still RESOLVES to a WIN (the grade is decided — eligibility gating is a write-time
  // concern, not a routing one), but the event_date side-write is refused, mirroring
  // finalizeBetGrading's grade refusal for the same race. RED proof: without the
  // GRADER_ELIGIBLE_WHERE clause on the write-back UPDATE, this event_date would be
  // written despite the bet being parked in the human review queue.
  installFetch({ slateGames: [mlbGame(501, GAME_DATE)] });
  insertBet('wb-int-ineligible', null, '2026-06-20 18:00:00', { ...MLB_PROP, review_status: 'needs_review' });
  const r5 = await gradePropWithAI(db.prepare("SELECT * FROM bets WHERE id = 'wb-int-ineligible'").get());
  check('integration: needs_review bet still resolves to WIN (grade decided, not persisted here)',
    r5 && r5.status === 'WIN', `result=${JSON.stringify(r5)}`);
  check('integration: needs_review bet event_date NOT healed (gate mirrors grade refusal)',
    storedEventDate('wb-int-ineligible') === null, `stored="${storedEventDate('wb-int-ineligible')}"`);

  global.fetch = realFetch;

  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
