// scripts/soccer-prop-enforce-check.js
// Read-only diagnostic: while SOCCER_PROPS_MODE was enforce, what did the soccer
// PROP path actually grade — especially DNP→VOID — so those live grades can be
// eyeballed before re-enabling enforce. No writes, no UPDATEs, no schema changes.
//
// Why VOIDs are the review set: the soccer props path ships a DNP→VOID rule
// (rostered-but-did-not-appear → VOID, not LOSS) that was flagged NEEDS-SIGN-OFF
// before enforce (PR #142 Build 1b). Every VOID prop row below is a live grade
// that rule (or a genuine push/no-result) produced under enforce — the highest-
// value rows to verify before flipping SOCCER_PROPS_MODE back to enforce.
//
// Whole-history scan — no date-window filter. The enforce window can't be bounded
// from Fly: a secret flip (SOCCER_PROPS_MODE) is not recorded in `fly releases`.
// fifa.world prop volume is small, so a full-history soccer-prop scan stays cheap.
//
// Run on Fly (interactive session, cwd is /app):
//   fly ssh console -a bettracker-discord-bot
//   node scripts/soccer-prop-enforce-check.js
//
// Read-only by construction: opens the live DB with { readonly: true } so it can
// run alongside the autograder without contending for the write lock or risking
// an accidental mutation (same discipline as scripts/gate4-firing-check.js).

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require('/app/node_modules/better-sqlite3'); } // fallback if run from outside /app

// Reuse the codebase's own prop classifier — do NOT reimplement the heuristic.
// isPlayerProp is a narrow, whole-bet-text keyword/"N+" heuristic: it fires on
// prop keywords ("anytime goal scorer", "saves", "sog"/"shots on goal", …) and
// the literal "N+" shape. It has NO decimal over/under matcher, and no "shots on
// target"/"to score or assist"/"first goalscorer" keyword, so it UNDER-COUNTS
// those soccer prop shapes — treat the PROP count below as a LOWER BOUND, not a
// census of what enforce graded as props.
//   Caveat, stated plainly so nobody over-trusts a low PROP count: the real
//   production soccer prop gate is soccer.js parseSoccerProp (result.marketClass
//   === 'prop'), applied per parlay LEG — NOT this bet-level heuristic. Soccer
//   exports no looksLikePlayerProp, so for soccer isPropBet reduces to exactly
//   isPlayerProp (no extra coverage). This scan is a coarse proxy: good for
//   surfacing rows to eyeball, not for certifying the review set is complete.
const { isPlayerProp } = require('../services/sportsdata/index.js');

const db = new Database(process.env.DB_PATH || '/data/bettracker.db', { readonly: true });

// The soccer-ish sport filter, defined once and reused for step 1 and step 2 so
// they can never drift apart.
const SOCCER_WHERE =
  "lower(sport) LIKE '%soccer%' OR lower(sport) LIKE '%fifa%' OR lower(sport) LIKE '%world%'";

// ── Step 1: self-verify the schema this diagnostic relies on (don't assume) ──
const cols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
console.log('bets columns:', cols.join(','));

const REQUIRED = ['sport', 'result', 'description'];
const missing = REQUIRED.filter(c => !cols.includes(c));
if (missing.length) {
  console.error(`\nABORT: bets table is missing required column(s): ${missing.join(', ')}.`);
  console.error('Column-name mismatch — surface it and fix the query rather than guessing.');
  db.close();
  process.exit(1);
}

const soccerSports = db.prepare(`SELECT DISTINCT sport FROM bets WHERE ${SOCCER_WHERE}`)
  .all().map(r => r.sport);
console.log('distinct soccer-ish sport values:', JSON.stringify(soccerSports));

const resultValues = db.prepare('SELECT DISTINCT result FROM bets WHERE result IS NOT NULL')
  .all().map(r => r.result);
console.log('distinct result values:', JSON.stringify(resultValues));

// ── Step 2: pull soccer bets with a result written (only columns confirmed above) ──
const WANT = ['id', 'sport', 'description', 'result', 'profit_units'];
const selectCols = WANT.filter(c => cols.includes(c));
const hasProfit = cols.includes('profit_units');
const rows = db.prepare(
  `SELECT ${selectCols.join(', ')} FROM bets WHERE (${SOCCER_WHERE}) AND result IS NOT NULL`
).all();
// NB: `result` defaults to 'pending' (migration 001) and is NOT NULL for un-graded
// bets, so the spec-mandated `result IS NOT NULL` admits pending rows too. They are
// NOT settled — they surface as their own bucket in the tally below and are excluded
// from the VOID and win/loss dumps (which key on terminal result values).
console.log(`\nsoccer-ish bets, result IS NOT NULL (spec filter — INCLUDES un-graded 'pending'): ${rows.length}`);

// ── Step 3: partition PROP vs TEAM via isPlayerProp; PROP is the review set ──
const props = [];
const team = [];
for (const r of rows) {
  (isPlayerProp(r.description || '', r.sport) ? props : team).push(r);
}
console.log(`  PROP  (isPlayerProp=true):  ${props.length}`);
console.log(`  TEAM  (isPlayerProp=false): ${team.length}`);

// display helpers
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const puOf = r => hasProfit ? (r.profit_units == null ? 'null' : r.profit_units) : 'n/a';
const resultLc = r => String(r.result).toLowerCase();

if (props.length) {
  // ── Step 4a: tally PROP rows by result (win/loss/void/…) ──
  // Key on the case-folded result so this tally and the VOID / win-loss dumps
  // below (which use resultLc) can never disagree on mixed-case data. Production
  // writes lowercase, but step-1's DISTINCT-result line could surface a stray
  // uppercase value — folding here keeps the headline counts consistent with the
  // dumped review set regardless.
  const tally = new Map();
  for (const r of props) { const k = resultLc(r); tally.set(k, (tally.get(k) || 0) + 1); }
  console.log('\nPROP grades by result (case-folded, matching the dumps):');
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    const note = k === 'pending' ? '   <- un-graded, NOT settled; excluded from the dumps below' : '';
    console.log(`  ${k}: ${n}${note}`);
  }

  // ── Step 4b: full dump of every VOID prop row (the DNP→VOID review set) ──
  const voids = props.filter(r => resultLc(r) === 'void');
  console.log(`\nVOID prop rows — DNP→VOID review set (verify each is a genuine did-not-appear/void, not a swallowed loss): ${voids.length}`);
  for (const r of voids) {
    console.log(`  id=${r.id}  profit_units=${puOf(r)}`);
    console.log(`      ${oneLine(r.description)}`);
  }

  // ── Step 4c: dump win/loss prop rows ──
  const winloss = props.filter(r => resultLc(r) === 'win' || resultLc(r) === 'loss');
  console.log(`\nwin/loss prop rows: ${winloss.length}`);
  for (const r of winloss) {
    console.log(`  id=${r.id}  result=${r.result}`);
    console.log(`      ${oneLine(r.description)}`);
  }
} else {
  console.log('\nNo soccer PROP rows graded — nothing to eyeball.');
}

console.log('\n(read-only: no rows written, updated, or archived.)');
db.close();
