// scripts/gate3-firing-check.js
// Read-only Gate 3 diagnostic: how many non-PENDING grades did Gate 3 actually evaluate
// (vs deterministic-adapter grades that bypass it), and any GATE3_WOULD_FIRE markers.
//
// Run on Fly (interactive session, cwd is /app):
//   fly ssh console -a bettracker-discord-bot
//   node scripts/gate3-firing-check.js            # default 24h window
//   WIN_H=40 node scripts/gate3-firing-check.js   # wider window
//
// Note: GATE3_WOULD_FIRE markers exist only since the v526 deploy; GATE3:quote_ok pass-markers since v524.

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require('/app/node_modules/better-sqlite3'); } // fallback if run from outside /app

const db = new Database(process.env.DB_PATH || '/data/bettracker.db');
const WIN_H = Number(process.env.WIN_H || 24);
const since = Date.now() - WIN_H * 3600 * 1000; // grading_audit.timestamp is epoch MILLIS

const rows = db.prepare(
  "SELECT bet_id, leg_index, final_status, provider_used, guards_passed, guards_failed FROM grading_audit WHERE timestamp > ?"
).all(since);

const keyOf = r => r.bet_id + '|' + (r.leg_index == null ? 'n' : r.leg_index);
const agg = new Map(); // dedup by bet+leg across attempts
for (const r of rows) {
  const key = keyOf(r);
  let a = agg.get(key);
  if (!a) { a = { nonPending: false, g3pass: false, g3fire: false, provs: new Set(), passSample: '' }; agg.set(key, a); }
  const fs = String(r.final_status || '').toUpperCase();
  if (fs && fs !== 'PENDING') a.nonPending = true;
  const gp = String(r.guards_passed || ''), gfl = String(r.guards_failed || '');
  if (/GATE3/.test(gp)) { a.g3pass = true; if (!a.passSample) a.passSample = gp; }
  if (/GATE3_WOULD_FIRE/.test(gfl)) a.g3fire = true;
  if (r.provider_used) a.provs.add(r.provider_used);
}

const np = [...agg.values()].filter(a => a.nonPending);
const evaluated = np.filter(a => a.g3pass || a.g3fire);
const passed = np.filter(a => a.g3pass);
const fired = np.filter(a => a.g3fire);

console.log(`\nwindow ${WIN_H}h — distinct bet+leg`);
console.log(`non-PENDING grades: ${np.length}`);
console.log(`  Gate 3 evaluated: ${evaluated.length}   (passed ${passed.length} / would-fire ${fired.length})`);

const byProv = {};
for (const a of np) { if (a.provs.size === 0) byProv['(none/adapter)'] = (byProv['(none/adapter)'] || 0) + 1; for (const p of a.provs) byProv[p] = (byProv[p] || 0) + 1; }
console.log(`provider_used of non-PENDING (LLM model names = Gate 3 applies; espn/none = adapter, bypasses Gate 3):`);
for (const [p, c] of Object.entries(byProv).sort((x, y) => y[1] - x[1])) console.log(`  ${p}: ${c}`);

const samp = np.map(a => a.passSample).filter(Boolean).slice(0, 5);
console.log(`sample guards_passed containing GATE3:`);
samp.length ? samp.forEach(s => console.log(`  ${s.slice(0, 160)}`)) : console.log(`  (none — Gate 3 pass-marked no non-PENDING grade in window)`);

console.log(`\nrule: Gate-3-evaluated >= ~20-30 with would-fire 0 -> safe to flip QUOTE_BOUND_GRADING=enforce.`);
console.log(`      if would-fire > 0, eyeball those rows (raw_response vs final_evidence) for hallucination vs correct-but-unquotable first.`);
db.close();
