// scripts/gate4-firing-check.js
// Read-only Gate 4 diagnostic: over a window, how many non-PENDING grades did
// Gate 4 actually evaluate, how many passed (date_ok), how many would-fire
// (off-date evidence), and how many fell through with no date signal — plus a
// dump of the would-fire rows for manual review before any enforce flip.
//
// Run on Fly (interactive session, cwd is /app):
//   fly ssh console -a bettracker-discord-bot
//   node scripts/gate4-firing-check.js            # default 24h window
//   WIN_H=48 node scripts/gate4-firing-check.js   # wider window
//
// M-13 lesson (gate3-firing-check.js forgot this): a diagnostic must NEVER take a
// write lock on the live grading DB. We open with { readonly: true } so this can
// run alongside the autograder without contending for the write lock or risking
// an accidental mutation. (gate3-firing-check.js opens read-write; do it right
// here.)
//
// Markers exist only since the Gate 4 deploy (DATE_BOUND_GRADING shipped shadow):
//   guards_failed   carries GATE4_WOULD_FIRE|mode=|claimed=|anchor=|tol=|evdates=|participants=|reason=
//   guards_passed   carries GATE4:date_ok  or  GATE4:no_date_signal

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require('/app/node_modules/better-sqlite3'); } // fallback if run from outside /app

const db = new Database(process.env.DB_PATH || '/data/bettracker.db', { readonly: true });
const WIN_H = Number(process.env.WIN_H || 24);
const since = Date.now() - WIN_H * 3600 * 1000; // grading_audit.timestamp is epoch MILLIS

const rows = db.prepare(
  'SELECT bet_id, leg_index, final_status, provider_used, guards_passed, guards_failed, final_evidence FROM grading_audit WHERE timestamp > ?'
).all(since);

// Pull the value of a `key=` field out of a GATE4_WOULD_FIRE token.
function markerField(gfl, key) {
  const m = String(gfl || '').match(new RegExp(`${key}=([^|"]*)`));
  return m ? m[1] : '';
}

const keyOf = r => r.bet_id + '|' + (r.leg_index == null ? 'n' : r.leg_index);
const agg = new Map(); // dedup by bet+leg across attempts
for (const r of rows) {
  const key = keyOf(r);
  let a = agg.get(key);
  if (!a) { a = { betId: r.bet_id, nonPending: false, dateOk: false, noDate: false, fire: false, fireMarker: '', claimed: '', evidence: '' }; agg.set(key, a); }
  const fs = String(r.final_status || '').toUpperCase();
  if (fs && fs !== 'PENDING') { a.nonPending = true; if (!a.claimed) a.claimed = fs; }
  const gp = String(r.guards_passed || ''), gfl = String(r.guards_failed || '');
  if (/GATE4:date_ok/.test(gp)) a.dateOk = true;
  if (/GATE4:no_date_signal/.test(gp)) a.noDate = true;
  if (/GATE4_WOULD_FIRE/.test(gfl)) { a.fire = true; a.fireMarker = gfl; if (r.final_evidence) a.evidence = String(r.final_evidence); }
}

const all = [...agg.values()];
// "Evaluated" = Gate 4 reached a verdict on this bet+leg (passed, no-date, or fired).
const evaluated = all.filter(a => a.dateOk || a.noDate || a.fire);
const passed = all.filter(a => a.dateOk);
const noDate = all.filter(a => a.noDate);
const fired = all.filter(a => a.fire);

console.log(`\nwindow ${WIN_H}h — distinct bet+leg`);
console.log(`Gate 4 evaluated: ${evaluated.length}`);
console.log(`  date_ok (passed):        ${passed.length}`);
console.log(`  no_date_signal (passed): ${noDate.length}`);
console.log(`  would-fire (off-date):   ${fired.length}`);

if (fired.length) {
  console.log(`\nwould-fire rows (review each: is the evidence really off-date, or a tolerance/anchor miss?):`);
  for (const a of fired) {
    const claimed = markerField(a.fireMarker, 'claimed') || a.claimed || '?';
    const anchor = markerField(a.fireMarker, 'anchor');
    const evdates = markerField(a.fireMarker, 'evdates');
    const tol = markerField(a.fireMarker, 'tol');
    const parts = markerField(a.fireMarker, 'participants');
    console.log(`  bet=${String(a.betId).slice(0, 8)} claimed=${claimed} anchor=${anchor} tol=${tol} evdates=${evdates} participants=${parts}`);
    if (a.evidence) console.log(`      evidence: ${a.evidence.slice(0, 160)}`);
  }
}

console.log(`\nrule: Gate-4-evaluated >= ~20-30 with would-fires reviewed -> flip candidate.`);
console.log(`      eyeball each would-fire: confirm the evidence date is genuinely off the bet's game window`);
console.log(`      (true wrong-fixture) before \`fly secrets set DATE_BOUND_GRADING=enforce\`; verify live != staged.`);
db.close();
