// ═══════════════════════════════════════════════════════════
// Gate 4 — off-date evidence reject (DATE_BOUND_GRADING off|shadow|enforce).
//
// Gate 3 proves the model copied a REAL quote; Gate 4 proves that quote came
// from a source dated inside the bet's game window. Mirrors the Gate 3 test
// shape: pure-unit assertions on applyGate4 + buildGate4WouldFireMarker, then a
// DB-level replay of the gradeSingleBet call site (applyGate4 →
// buildGate4WouldFireMarker → writeGradingAudit) asserting the persisted row.
//
// Asserts:
//   resolveGate4Mode tri-state (incl. unknown → shadow fail-safe)
//   window logic: inside / boundary / outside / multi-date union / no-date
//   INCIDENT REGRESSION (e5d27de0, 2026-06-12): anchor 2026-06-11, tol ±1,
//     evidence dated 2026-06-06 containing the verbatim quote
//     "FT USMNT <strong>1-2 Germany</strong>", model claims LOSS →
//       shadow  → GATE4_WOULD_FIRE marker, grade UNCHANGED
//       enforce → grade FORCED PENDING with OFF_DATE_EVIDENCE evidence
//     inverse: evidence dated 2026-06-12 → GATE4:date_ok, grade stands
//   DB persistence: the would-fire marker rides the existing audit row (zero
//     extra rows) and is queryable; off mode writes no marker.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB — must be set BEFORE requiring services/database.js.
const DB_PATH = path.join(os.tmpdir(), `bet-gate4-off-date-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext); } catch (_) {} }

const { db } = require('../services/database');
const grading = require('../services/grading');
const {
  resolveGate4Mode, applyGate4, buildGate4WouldFireMarker,
  gate4ToleranceFor, GATE4_TOLERANCE_DAYS,
  buildEvidenceRecords, writeGradingAudit,
} = grading._internal;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

console.log('gate4-off-date (Gate 4):');

const ANCHOR = '2026-06-11';

// ── resolveGate4Mode tri-state ──
check('mode: off', resolveGate4Mode('off') === 'off');
check('mode: shadow', resolveGate4Mode('shadow') === 'shadow');
check('mode: enforce', resolveGate4Mode('enforce') === 'enforce');
check('mode: ENFORCE (case/space)', resolveGate4Mode('  ENFORCE ') === 'enforce');
check('mode: unset → shadow', resolveGate4Mode(undefined) === 'shadow');
check('mode: unknown/legacy → shadow (never silently enforce)', resolveGate4Mode('on') === 'shadow');

// ── tolerance map ──
check('tol: default ±1', gate4ToleranceFor('Soccer') === 1);
check('tol: unknown sport → default', gate4ToleranceFor('KBO') === GATE4_TOLERANCE_DAYS.default);
check('tol: null sport → default', gate4ToleranceFor(null) === GATE4_TOLERANCE_DAYS.default);

// Helper: assemble records the way gradeSingleBet does (build the evidence
// string from hits, slice to 1500, build records around it).
function recordsFor(searchResults, anchorISO) {
  const ev = (function assemble(results) {
    const snippets = [];
    for (const r of results) { if (r.title) snippets.push(r.title); if (r.snippet) snippets.push(`  ${r.snippet}`); }
    return snippets.join('\n');
  })(searchResults).slice(0, 1500);
  return buildEvidenceRecords(searchResults, ev, anchorISO, { defaultBackend: 'chain' });
}

// ── window logic via applyGate4 ──
function statusFor(searchResults, quote, claimed, opts = {}) {
  const recs = recordsFor(searchResults, opts.anchorISO || ANCHOR);
  return applyGate4({ status: claimed, evidence: 'x', evidence_quote: quote }, recs, {
    mode: opts.mode || 'shadow', betId: opts.betId || 'b', anchorISO: opts.anchorISO || ANCHOR,
    sport: opts.sport || 'Soccer', betTeamList: opts.betTeamList || [], sportContext: opts.sportContext || null,
  });
}

const INSIDE = [{ title: 'recap', snippet: 'final on 2026-06-12 USA win 2-0' }];
const BOUNDARY = [{ title: 'recap', snippet: 'final on 2026-06-10 USA win 2-0' }];
const OUTSIDE = [{ title: 'recap', snippet: 'final on 2026-06-06 USA lost 1-2' }];
check('window: inside (+1) → date_ok',
  statusFor(INSIDE, 'final on 2026-06-12 USA win 2-0', 'WIN').status === 'date_ok');
check('window: boundary (−1) → date_ok',
  statusFor(BOUNDARY, 'final on 2026-06-10 USA win 2-0', 'WIN').status === 'date_ok');
check('window: outside (−5) → off_date',
  statusFor(OUTSIDE, 'final on 2026-06-06 USA lost 1-2', 'LOSS').status === 'off_date');

// multi-date union — one in-window date saves it
const MULTI = [{ title: 'doubleheader notes', snippet: 'games 2026-06-06 and 2026-06-12 listed' }];
check('window: multi-date union (one in-window) → date_ok',
  statusFor(MULTI, 'games 2026-06-06 and 2026-06-12 listed', 'WIN').status === 'date_ok');

// no date signal — quote record carries no extractable date → pass-through
const NODATE = [{ title: 'recap', snippet: 'USA beat Paraguay two-nil, great match' }];
check('window: no extractable date → no_date_signal (pass-through, ok)',
  statusFor(NODATE, 'USA beat Paraguay two-nil, great match', 'WIN').status === 'no_date_signal');

// PENDING claim is exempt (nothing to attribute)
check('PENDING claim → not evaluated (exempt)',
  statusFor(OUTSIDE, 'final on 2026-06-06 USA lost 1-2', 'PENDING').evaluated === false);

// off mode → never evaluates
check('off mode → not evaluated',
  statusFor(OUTSIDE, 'final on 2026-06-06 USA lost 1-2', 'LOSS', { mode: 'off' }).evaluated === false);

// ── INCIDENT REGRESSION ──
// The real evidence: a June-6 friendly record whose snippet carries the verbatim
// quote, anchored at the June-11 placement of a June-12 World Cup opener bet.
const INCIDENT_HITS = [{
  title: 'USMNT friendly result — June 6, 2026',
  snippet: 'FT USMNT <strong>1-2 Germany</strong> (full time) per ESPN',
}];
const INCIDENT_QUOTE = 'FT USMNT <strong>1-2 Germany</strong>';
const incidentRecs = recordsFor(INCIDENT_HITS, ANCHOR);
const claimedParsed = { status: 'LOSS', evidence: 'USA lost 1-2 to Germany', evidence_quote: INCIDENT_QUOTE };

const incShadow = applyGate4(claimedParsed, incidentRecs, {
  mode: 'shadow', betId: 'e5d27de0', anchorISO: ANCHOR, sport: 'Soccer', betTeamList: [], sportContext: null,
});
check('incident shadow: off_date would-fire', incShadow.wouldFire === true && incShadow.status === 'off_date');
check('incident shadow: grade NOT forced (forcePending=false)', incShadow.forcePending === false);
const incMarker = buildGate4WouldFireMarker(incShadow);
check('incident shadow: marker is GATE4_WOULD_FIRE', !!incMarker && incMarker.startsWith('GATE4_WOULD_FIRE|'), incMarker);
check('incident shadow: marker mode=shadow', incMarker.includes('|mode=shadow|'), incMarker);
check('incident shadow: marker claimed=LOSS', incMarker.includes('|claimed=LOSS|'), incMarker);
check('incident shadow: marker anchor=2026-06-11', incMarker.includes('|anchor=2026-06-11|'), incMarker);
check('incident shadow: marker tol=1', incMarker.includes('|tol=1|'), incMarker);
check('incident shadow: marker evdates=2026-06-06', incMarker.includes('|evdates=2026-06-06|'), incMarker);
check('incident shadow: marker reason=OFF_DATE_EVIDENCE', incMarker.includes('|reason=OFF_DATE_EVIDENCE'), incMarker);

const incEnforce = applyGate4(claimedParsed, incidentRecs, {
  mode: 'enforce', betId: 'e5d27de0', anchorISO: ANCHOR, sport: 'Soccer', betTeamList: [], sportContext: null,
});
check('incident enforce: grade FORCED PENDING (forcePending=true)', incEnforce.forcePending === true);
const enforceEvidence = `OFF_DATE_EVIDENCE: evidence dated ${incEnforce.evdates.join(',')} outside ${incEnforce.anchorISO}±${incEnforce.tol}d — forced PENDING (model claimed ${claimedParsed.status})`;
check('incident enforce: evidence string matches spec format',
  enforceEvidence === 'OFF_DATE_EVIDENCE: evidence dated 2026-06-06 outside 2026-06-11±1d — forced PENDING (model claimed LOSS)',
  enforceEvidence);

// inverse: evidence dated inside the window → date_ok, grade stands
const INVERSE_HITS = [{
  title: 'USA vs Paraguay — June 12, 2026 World Cup opener',
  snippet: 'FT USA 2-0 Paraguay per ESPN',
}];
const inverseRecs = recordsFor(INVERSE_HITS, ANCHOR);
const inv = applyGate4({ status: 'WIN', evidence: 'USA won 2-0', evidence_quote: 'FT USA 2-0 Paraguay per ESPN' }, inverseRecs, {
  mode: 'enforce', betId: 'e5d27de0', anchorISO: ANCHOR, sport: 'Soccer', betTeamList: [], sportContext: null,
});
check('incident inverse: date_ok, no fire', inv.status === 'date_ok' && inv.wouldFire === false && inv.forcePending === false);
check('incident inverse: passLabel GATE4:date_ok', inv.passLabel === 'GATE4:date_ok');
check('incident inverse: no would-fire marker', buildGate4WouldFireMarker(inv) === null);

// ── DB persistence (replay of the gradeSingleBet call site) ──
// Faithfully mirrors the 4-line call-site glue against a fresh audit row, then
// persists via the real writeGradingAudit. Returns the bet_id.
function runGate4Attempt({ betId, parsed, records, mode, anchorISO, sport }) {
  const audit = { bet_id: betId, is_parlay: 0, leg_index: null, guards_passed: [], guards_failed: [], final_status: null, final_evidence: null };
  const g4 = applyGate4(parsed, records, { mode, betId, anchorISO, sport, betTeamList: [], sportContext: null });
  const marker = buildGate4WouldFireMarker(g4);
  if (marker) audit.guards_failed.push(marker);
  if (g4.forcePending) {
    audit.final_status = 'PENDING';
    audit.final_evidence = `OFF_DATE_EVIDENCE: evidence dated ${g4.evdates.join(',')} outside ${g4.anchorISO}±${g4.tol}d — forced PENDING (model claimed ${parsed.status})`;
  } else {
    if (g4.passLabel) audit.guards_passed.push(g4.passLabel);
    audit.final_status = parsed.status;
    audit.final_evidence = parsed.evidence;
  }
  writeGradingAudit(audit);
  return betId;
}
function rowFor(betId) {
  return db.prepare('SELECT bet_id, guards_passed, guards_failed, final_status FROM grading_audit WHERE bet_id = ? ORDER BY rowid DESC LIMIT 1').get(betId);
}
function rowCount(betId) {
  return db.prepare('SELECT COUNT(*) AS c FROM grading_audit WHERE bet_id = ?').get(betId).c;
}
function markerCount(betId) {
  return db.prepare("SELECT COUNT(*) AS c FROM grading_audit WHERE bet_id = ? AND guards_failed LIKE '%GATE4_WOULD_FIRE%'").get(betId).c;
}

// shadow + off-date → one marker row, grade UNCHANGED (LOSS), zero extra rows
runGate4Attempt({ betId: 'g4-shadow', parsed: claimedParsed, records: incidentRecs, mode: 'shadow', anchorISO: ANCHOR, sport: 'Soccer' });
const sRow = rowFor('g4-shadow');
check('shadow DB: a single grading_audit row written (zero extra)', rowCount('g4-shadow') === 1, `count=${rowCount('g4-shadow')}`);
check('shadow DB: row carries GATE4_WOULD_FIRE', !!sRow && sRow.guards_failed.includes('GATE4_WOULD_FIRE'), sRow && sRow.guards_failed);
check('shadow DB: grade UNCHANGED (final_status=LOSS)', !!sRow && sRow.final_status === 'LOSS', sRow && sRow.final_status);
check('shadow DB: marker queryable by LIKE', markerCount('g4-shadow') === 1, `count=${markerCount('g4-shadow')}`);

// enforce + off-date → marker row, grade FORCED PENDING
runGate4Attempt({ betId: 'g4-enforce', parsed: claimedParsed, records: incidentRecs, mode: 'enforce', anchorISO: ANCHOR, sport: 'Soccer' });
const eRow = rowFor('g4-enforce');
check('enforce DB: row carries GATE4_WOULD_FIRE', !!eRow && eRow.guards_failed.includes('GATE4_WOULD_FIRE'), eRow && eRow.guards_failed);
check('enforce DB: marker mode=enforce', !!eRow && eRow.guards_failed.includes('mode=enforce'), eRow && eRow.guards_failed);
check('enforce DB: grade FORCED PENDING', !!eRow && eRow.final_status === 'PENDING', eRow && eRow.final_status);

// date_ok → pass-marker in guards_passed, NO would-fire marker
runGate4Attempt({ betId: 'g4-dateok', parsed: { status: 'WIN', evidence: 'won', evidence_quote: 'FT USA 2-0 Paraguay per ESPN' }, records: inverseRecs, mode: 'shadow', anchorISO: ANCHOR, sport: 'Soccer' });
const okRow = rowFor('g4-dateok');
check('date_ok DB: guards_passed has GATE4:date_ok', !!okRow && okRow.guards_passed.includes('GATE4:date_ok'), okRow && okRow.guards_passed);
check('date_ok DB: NO would-fire marker', markerCount('g4-dateok') === 0, `count=${markerCount('g4-dateok')}`);
check('date_ok DB: grade stands (WIN)', !!okRow && okRow.final_status === 'WIN', okRow && okRow.final_status);

// off mode → no marker at all
runGate4Attempt({ betId: 'g4-off', parsed: claimedParsed, records: incidentRecs, mode: 'off', anchorISO: ANCHOR, sport: 'Soccer' });
check('off DB: zero would-fire markers', markerCount('g4-off') === 0, `count=${markerCount('g4-off')}`);
check('off DB: grade unchanged (LOSS)', rowFor('g4-off').final_status === 'LOSS');

// Cleanup
try { db.close(); } catch (_) {}
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext); } catch (_) {} }

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('Gate 4 off-date evidence reject validation passed.');
