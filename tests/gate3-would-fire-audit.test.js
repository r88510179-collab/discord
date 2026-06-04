// ═══════════════════════════════════════════════════════════
// B0 — Gate 3 would-fire persistence to grading_audit (DB-level).
//
// Gate 3 in shadow logs "[GATE3 would-fire]" to stdout and leaves the grade
// unchanged. Fly stdout rolls off, so the would-be false-PENDING rate that
// gates the off→shadow→enforce flip can't be measured over a real window. B0
// marks THIS attempt's grading_audit row (zero extra rows — a dedicated row
// would perturb shouldAutoVoidNoData's recent-5 window and the daily-cap count,
// both of which gate grading) so each event is SELECT-able by SQL.
//
// The grading_audit write path is network-bound through the LLM waterfall, so —
// matching the repo's pure-helper test convention — this test composes the REAL
// units the call site uses (applyGate3 → buildGate3WouldFireMarker →
// writeGradingAudit) and asserts on the persisted row. The only test-authored
// line mirrors earlyReturn's `audit.final_status = result.status`
// (services/grading.js): PENDING when Gate 3 force-pends, else the claimed
// status (grade unchanged). The 4-line call-site glue is covered by npm run
// check + the PR's grep proof.
//
// Asserts:
//   shadow + failing quote → a GATE3_WOULD_FIRE row is written AND grade unchanged
//   the marker is queryable (SELECT by it returns the row)
//   enforce + failing quote → marker row written AND grade forced PENDING
//   off → no marker row, grade unchanged
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the dev DB. Must be set BEFORE requiring services/database.js
// (which reads DB_PATH at module load).
const DB_PATH = path.join(os.tmpdir(), `bet-gate3-would-fire-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

const { db } = require('../services/database');
const grading = require('../services/grading');
const { applyGate3, buildGate3WouldFireMarker, writeGradingAudit } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

console.log('gate3-would-fire-audit (B0):');

// Evidence the model was "given"; the FAILING quote is a paraphrase that is NOT
// an exact substring → Gate 3 would-fire.
const EVIDENCE = 'Final: Boston Celtics 118, New York Knicks 112 (ESPN box score).';
const FAILING = { status: 'WIN', evidence: 'Celtics won', evidence_quote: 'Celtics beat the Knicks by six' };

// Faithfully replays the gradeSingleBet Gate 3 call site against a fresh audit
// row, then persists it via the real writeGradingAudit. Returns the bet_id.
function runGate3Attempt({ betId, bet, mode, legIndex = null }) {
  const audit = { bet_id: betId, is_parlay: 0, leg_index: legIndex, guards_passed: [], guards_failed: [], final_status: null, final_evidence: null };
  const g3 = applyGate3(FAILING, EVIDENCE, { mode, betId, legIndex });   // real Gate 3 decision
  const marker = buildGate3WouldFireMarker(g3, bet);                     // real marker (null when off / quote ok)
  if (marker) audit.guards_failed.push(marker);
  // Mirror of earlyReturn: forced PENDING on enforce, else the claimed grade.
  if (g3.forcePending) { audit.final_status = 'PENDING'; audit.final_evidence = 'UNVERIFIED_QUOTE: forced PENDING'; }
  else { audit.final_status = FAILING.status; audit.final_evidence = FAILING.evidence; }
  writeGradingAudit(audit);                                             // real persistence
  return betId;
}

function rowFor(betId) {
  return db.prepare('SELECT bet_id, guards_failed, final_status FROM grading_audit WHERE bet_id = ? ORDER BY rowid DESC LIMIT 1').get(betId);
}
function markerCount(betId) {
  return db.prepare("SELECT COUNT(*) AS c FROM grading_audit WHERE bet_id = ? AND guards_failed LIKE '%GATE3_WOULD_FIRE%'").get(betId).c;
}

const GAME_LINE = { description: 'Lakers ML -110', bet_type: 'straight' };
const PROP_LINE = { description: 'OVER 14.5 POINTS SCOOT HENDERSON', bet_type: 'straight' };

// ── shadow + failing quote → marker row written, grade UNCHANGED ──
runGate3Attempt({ betId: 'bet-shadow', bet: GAME_LINE, mode: 'shadow' });
const sRow = rowFor('bet-shadow');
check('shadow: a grading_audit row was written', !!sRow, `row=${JSON.stringify(sRow)}`);
check('shadow: row carries GATE3_WOULD_FIRE marker', !!sRow && sRow.guards_failed.includes('GATE3_WOULD_FIRE'), `guards_failed=${sRow && sRow.guards_failed}`);
check('shadow: marker records mode=shadow', !!sRow && sRow.guards_failed.includes('mode=shadow'), sRow && sRow.guards_failed);
check('shadow: grade UNCHANGED (final_status=WIN, not forced PENDING)', !!sRow && sRow.final_status === 'WIN', `final_status=${sRow && sRow.final_status}`);

// ── the marker is queryable (SELECT by it returns the row) ──
check('queryable: WHERE guards_failed LIKE %GATE3_WOULD_FIRE% returns the shadow row', markerCount('bet-shadow') === 1, `count=${markerCount('bet-shadow')}`);

// ── enforce + failing quote → marker row written, grade FORCED PENDING ──
runGate3Attempt({ betId: 'bet-enforce', bet: GAME_LINE, mode: 'enforce' });
const eRow = rowFor('bet-enforce');
check('enforce: a grading_audit row was written', !!eRow);
check('enforce: row carries GATE3_WOULD_FIRE marker', !!eRow && eRow.guards_failed.includes('GATE3_WOULD_FIRE'), eRow && eRow.guards_failed);
check('enforce: marker records mode=enforce', !!eRow && eRow.guards_failed.includes('mode=enforce'), eRow && eRow.guards_failed);
check('enforce: grade FORCED PENDING', !!eRow && eRow.final_status === 'PENDING', `final_status=${eRow && eRow.final_status}`);
check('enforce: marker is queryable', markerCount('bet-enforce') === 1, `count=${markerCount('bet-enforce')}`);

// ── off → NO marker row, grade unchanged ──
runGate3Attempt({ betId: 'bet-off', bet: GAME_LINE, mode: 'off' });
const oRow = rowFor('bet-off');
check('off: an audit row was still written (the normal attempt row)', !!oRow);
check('off: row has NO GATE3_WOULD_FIRE marker', !!oRow && !oRow.guards_failed.includes('GATE3_WOULD_FIRE'), oRow && oRow.guards_failed);
check('off: grade unchanged (final_status=WIN)', !!oRow && oRow.final_status === 'WIN', `final_status=${oRow && oRow.final_status}`);
check('off: zero marker rows for this bet', markerCount('bet-off') === 0, `count=${markerCount('bet-off')}`);

// ── prop/non-prop split persists to the row ──
runGate3Attempt({ betId: 'bet-prop', bet: PROP_LINE, mode: 'shadow' });
const pRow = rowFor('bet-prop');
check('prop bet: marker records prop=1', !!pRow && pRow.guards_failed.includes('prop=1'), pRow && pRow.guards_failed);
check('game-line bet: marker records prop=0', !!sRow && sRow.guards_failed.includes('prop=0'), sRow && sRow.guards_failed);

// Cleanup so re-runs start clean.
try { db.close(); } catch (_) {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('Gate 3 would-fire audit (B0) validation passed.');
