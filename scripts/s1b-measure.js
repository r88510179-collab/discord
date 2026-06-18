// scripts/s1b-measure.js
// ───────────────────────────────────────────────────────────────────────────
// S1b — re-measure the backoff/quarantined grading pool by GRADEABLE SOURCE,
// sized per sport, with a NEW parlay_legs prop-keyword cut so the
// "props-within-covered-sports" slice is sized DIRECTLY (S1a only inferred it
// from parlay share). Implements BACKLOG.md "Search grading — source-path arc"
// → S1b. Mirrors the S1a probe so S1a→S1b diffs cleanly.
//
// STRICTLY READ-ONLY. No writes, no mutations, no network/adapter calls:
//   • the production DB is opened READONLY (`{ readonly: true }`);
//   • the grader's REAL prop/sport helpers are imported only as pure functions
//     (`looksLikePlayerProp`, `isPlayerPropDescription`, `normalizeSport`,
//     `inferLegSport` — all pure classifiers, no I/O);
//   • `services/database.js` opens + MIGRATES a DB at module load (it runs
//     `runMigrations` + `ALTER TABLE` + a `migration_016` `UPDATE bets`), so
//     before requiring `services/grading.js` we force `DB_PATH=':memory:'` —
//     all of that write traffic lands on a throwaway in-memory DB, never prod.
//     This is the same temp-DB harness the test suite uses.
//
// Run on Fly (cwd is /app; the bot already migrated /data/bettracker.db):
//   fly ssh console -a bettracker-discord-bot
//   node scripts/s1b-measure.js
//   BETTRACKER_DB=/data/bettracker.db node scripts/s1b-measure.js   # explicit
//
// Run locally against a copy:
//   APP_ROOT="$PWD" BETTRACKER_DB=./bettracker.db node scripts/s1b-measure.js
//
// Chosen prop detector (the one the grader ACTUALLY routes on for its
// structured pre-check): `looksLikePlayerProp` — services/grading.js:286,
// gated at services/grading.js:2415:
//     if (looksLikePlayerProp(bet) && ['MLB','NBA','NHL'].includes(sport.upper))
//        → tryStructured(bet)   // services/sportsdata adapters
// `isPlayerPropDescription` (grading.js) is broader still (also matches NFL/other
// stats and the "to score"/"anytime" phrasings) but does NOT route the structured
// pre-check — it powers the Gate-3 would-fire marker + the evidence guard. We size
// the primary `adapter_prop` bucket with `looksLikePlayerProp` (faithful to the
// grader) and report the `isPlayerPropDescription` delta as a secondary diagnostic.
// NOTE: fix/grader-prop-gate-nba-nhl broadened looksLikePlayerProp to MLB+NBA+NHL,
// so the former MLB-bias gap (NBA/NHL props MISSED by the structured pre-check) is
// now closed — the §D "missed by chosen detector" count should read ~0.
// ───────────────────────────────────────────────────────────────────────────

const path = require('path');

const ROOT = process.env.APP_ROOT || '/app';
const DB_PATH = process.env.BETTRACKER_DB || '/data/bettracker.db';

// Pool = the two non-terminal-but-stuck states the arc targets. `quarantined`
// is terminal (attempts ≥ 20, no auto-exit); `backoff` is retrying. Both are
// "not graded, web-search the weak link" — exactly S1a's pool.
const POOL_STATES = ['backoff', 'quarantined'];

// Sports with a structured adapter today (services/sportsdata/{mlb,nba,nhl}.js).
// NFL has NO structured adapter but IS in the grader's ESPN game-level
// pre-check (grading.js:2439 `['MLB','NBA','NHL','NFL']`), so NFL game-level
// bets still have a deterministic path — they count as adapter_gamelevel.
const ADAPTER_GAMELEVEL_SPORTS = ['MLB', 'NBA', 'NHL', 'NFL'];

// Label families per BACKLOG.md (sport-label taxonomy normalization, from S1a).
// Matched case-insensitively. Soccer leagues + the SOCCER casing variant are
// stored as if top-level sports; fold them so per-sport sizing isn't split.
const SOCCER_FAMILY = ['SOCCER', 'SERIE A', 'EPL', 'UCL', 'LA LIGA', 'BUNDESLIGA', 'LIGUE 1'];
const COMBAT_FAMILY = ['UFC', 'MMA', 'BOXING'];

// Parlay predicate — mirrors the grader's leg-explosion dispatcher
// (grading.js:2048 `betType === 'parlay' || betType === 'sgp'`).
function isParlayBet(bet) {
  const bt = String(bet && bet.bet_type || '').toLowerCase();
  return bt === 'parlay' || bt === 'sgp';
}

// Group a raw stored sport label into its presentation family (BACKLOG list).
// Non-family labels pass through trimmed (e.g. 'MLB', 'Tennis', 'Golf', 'NFL').
function groupSport(rawSport) {
  const up = String(rawSport == null ? '' : rawSport).trim().toUpperCase();
  if (!up) return 'Unknown';
  if (SOCCER_FAMILY.includes(up)) return 'Soccer';
  if (COMBAT_FAMILY.includes(up)) return 'Combat';
  return String(rawSport).trim();
}

// NFL literal check — matches the grader's ESPN pre-check, which does a literal
// uppercase match (NOT via normalizeSport, which doesn't handle NFL at all).
function isNflSport(rawSport) {
  return String(rawSport == null ? '' : rawSport).trim().toUpperCase() === 'NFL';
}

// Source classification per bet (BACKLOG §3):
//   adapter_gamelevel — covered sport {MLB,NBA,NHL,NFL} AND not a player prop
//   adapter_prop      — adapter sport {MLB,NBA,NHL}     AND     a player prop
//   search_only       — everything else (Tennis, Soccer family, Combat, Golf…)
// `normalizeSport` (the reused grader helper) folds Baseball/Basketball/Hockey
// spellings to MLB/NBA/NHL. `prop` is from the chosen detector
// (`looksLikePlayerProp`).
function classifySource(bet, deps) {
  const covered = deps.normalizeSport(bet.sport);   // 'MLB'|'NBA'|'NHL'|null
  const prop = deps.looksLikePlayerProp(bet);
  if (covered && prop) return 'adapter_prop';
  if ((covered || isNflSport(bet.sport)) && !prop) return 'adapter_gamelevel';
  return 'search_only';
}

// ── CORE: read-only measurement against an open db handle ────────────────────
// db   — an open better-sqlite3 handle (caller owns lifecycle; READONLY in prod)
// deps — { looksLikePlayerProp, isPlayerPropDescription, normalizeSport,
//          inferLegSport } (injected so the cut matches the grader AND the
//          fixture test is pure)
function measure(db, deps) {
  if (!deps || typeof deps.looksLikePlayerProp !== 'function'
      || typeof deps.normalizeSport !== 'function'
      || typeof deps.isPlayerPropDescription !== 'function'
      || typeof deps.inferLegSport !== 'function') {
    throw new Error('measure(): deps must provide looksLikePlayerProp, isPlayerPropDescription, normalizeSport, inferLegSport');
  }
  // Sanity: required tables present (clear error beats a cryptic SQL throw).
  for (const t of ['bets', 'parlay_legs']) {
    const ok = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!ok) throw new Error(`measure(): required table '${t}' not found in DB`);
  }

  const placeholders = POOL_STATES.map(() => '?').join(',');
  const bets = db.prepare(
    `SELECT id, sport, bet_type, description, grading_state, grading_attempts, created_at
       FROM bets
      WHERE grading_state IN (${placeholders})`,
  ).all(...POOL_STATES);

  // ── §1 Pool totals by grading_state ──
  const pool = { total: bets.length };
  for (const s of POOL_STATES) pool[s] = 0;
  for (const b of bets) pool[b.grading_state] = (pool[b.grading_state] || 0) + 1;

  // ── §2 Per-sport (grouped + raw): count, parlay vs straight ──
  const groupedMap = new Map();
  const rawMap = new Map();
  const bump = (map, key, isParlay) => {
    let e = map.get(key);
    if (!e) { e = { sport: key, total: 0, parlay: 0, straight: 0 }; map.set(key, e); }
    e.total++;
    if (isParlay) e.parlay++; else e.straight++;
  };
  for (const b of bets) {
    const isP = isParlayBet(b);
    bump(groupedMap, groupSport(b.sport), isP);
    bump(rawMap, String(b.sport == null ? '' : b.sport).trim() || 'Unknown', isP);
  }
  const byTotalDesc = (a, z) => z.total - a.total || a.sport.localeCompare(z.sport);
  const perSportGrouped = [...groupedMap.values()].sort(byTotalDesc);
  const perSportRaw = [...rawMap.values()].sort(byTotalDesc);

  // ── §3 Source classification per bet (+ per-grouped-sport matrix) ──
  const source = { adapter_gamelevel: 0, adapter_prop: 0, search_only: 0, total: bets.length };
  const sourceBySport = new Map();
  for (const b of bets) {
    const cls = classifySource(b, deps);
    source[cls]++;
    const g = groupSport(b.sport);
    let row = sourceBySport.get(g);
    if (!row) { row = { sport: g, adapter_gamelevel: 0, adapter_prop: 0, search_only: 0, total: 0 }; sourceBySport.set(g, row); }
    row[cls]++; row.total++;
  }
  const sourceMatrix = [...sourceBySport.values()].sort(byTotalDesc);

  // ── §4 NEW — parlay_legs prop cut for covered-sport parlays {MLB,NBA,NHL} ──
  // Join each covered-sport parlay's legs and classify each leg prop vs non-prop
  // with the CHOSEN detector. Report per-parlay all-prop/mixed/no-prop (+ a
  // no_legs bucket for parlays with zero recorded leg rows — incomplete parlays
  // that sit in the pool), and total prop vs non-prop legs.
  //
  // FIDELITY CAVEAT (parent-keyed approximation): this PRIMARY cut keys each
  // parlay — and every one of its legs — on the parlay's PARENT stored sport,
  // and considers only parlays whose parent normalizeSport ∈ {MLB,NBA,NHL}. The
  // live grader does NOT route a parlay at the parent level: it explodes it
  // (grading.js:2048 → gradeParlay) and routes EACH leg on
  // `inferLegSport(leg.description) || parlayBet.sport` (grading.js:2204), so a
  // leg's real adapter can differ from its parent label (documented prod cases:
  // MLB-labeled parlays carrying NBA prop legs; NBA parlays carrying tennis/NHL
  // legs — services/ai.js SPORT_ACTION_MAP, BACKLOG.md). We keep this cut
  // parent-keyed on purpose so it diffs cleanly against S1a (whose ~151 was
  // parent-keyed too); the §4b leg-routed view below re-buckets legs by the
  // grader's real per-leg routing and sizes that divergence directly.
  const poolParlays = bets.filter(isParlayBet);
  const coveredParlays = poolParlays.filter(b => deps.normalizeSport(b.sport));
  const legStmt = db.prepare('SELECT description FROM parlay_legs WHERE bet_id = ?');
  const legsByBet = new Map(); // cache so §4 + §4b share one fetch per parlay
  const legsOf = (id) => { let l = legsByBet.get(id); if (!l) { l = legStmt.all(id); legsByBet.set(id, l); } return l; };
  const legCut = {
    parlaysConsidered: coveredParlays.length,
    allProp: 0, mixed: 0, noProp: 0, noLegs: 0,
    propLegs: 0, nonPropLegs: 0, totalLegs: 0,
    bySport: {},
  };
  for (const p of coveredParlays) {
    const sportKey = deps.normalizeSport(p.sport); // MLB|NBA|NHL
    const bs = legCut.bySport[sportKey] || (legCut.bySport[sportKey] = { allProp: 0, mixed: 0, noProp: 0, noLegs: 0, propLegs: 0, nonPropLegs: 0 });
    const legs = legsOf(p.id);
    if (legs.length === 0) { legCut.noLegs++; bs.noLegs++; continue; }
    let propN = 0;
    for (const leg of legs) {
      const isProp = deps.looksLikePlayerProp({ description: leg.description });
      if (isProp) { propN++; legCut.propLegs++; bs.propLegs++; }
      else { legCut.nonPropLegs++; bs.nonPropLegs++; }
      legCut.totalLegs++;
    }
    if (propN === legs.length) { legCut.allProp++; bs.allProp++; }
    else if (propN === 0) { legCut.noProp++; bs.noProp++; }
    else { legCut.mixed++; bs.mixed++; }
  }

  // ── §4b NEW — leg-routed view (faithful to the grader's per-leg dispatch) ──
  // Scans the legs of EVERY pool parlay (any parent sport) and routes each leg
  // the way the grader does: `inferLegSport(leg.description) || parent.sport`
  // (mirrors grading.js:2204), then asks whether that routed sport hits a
  // structured adapter {MLB,NBA,NHL} and whether the leg is a player prop. This
  // sizes the props-within-covered-sports slice at the LEG level — independent
  // of the parent label — and surfaces the two divergences §4 hides:
  //   • coveredPropLegsInNonCoveredParent — covered prop legs the PRIMARY cut
  //     EXCLUDES because they sit inside a non-covered-parent parlay;
  //   • crossSportLegs — legs whose routed adapter ≠ the parent's normalized
  //     sport (cross-sport contamination size).
  const legRouting = {
    parlaysScanned: 0, legsScanned: 0,
    routedCovered: { MLB: { prop: 0, nonProp: 0 }, NBA: { prop: 0, nonProp: 0 }, NHL: { prop: 0, nonProp: 0 } },
    routedCoveredTotal: { prop: 0, nonProp: 0 },
    coveredPropLegsInNonCoveredParent: 0,
    crossSportLegs: 0,
  };
  for (const p of poolParlays) {
    const legs = legsOf(p.id);
    if (legs.length === 0) continue;
    legRouting.parlaysScanned++;
    const parentCov = deps.normalizeSport(p.sport); // MLB|NBA|NHL|null
    for (const leg of legs) {
      legRouting.legsScanned++;
      const routed = deps.inferLegSport(leg.description) || p.sport; // mirror grading.js:2204
      const routedCov = deps.normalizeSport(routed);                 // MLB|NBA|NHL|null
      if (!routedCov) continue;                                      // leg hits no structured adapter
      const isProp = deps.looksLikePlayerProp({ description: leg.description });
      const slot = legRouting.routedCovered[routedCov];
      if (isProp) { slot.prop++; legRouting.routedCoveredTotal.prop++; }
      else { slot.nonProp++; legRouting.routedCoveredTotal.nonProp++; }
      if (isProp && !parentCov) legRouting.coveredPropLegsInNonCoveredParent++;
      if (routedCov !== parentCov) legRouting.crossSportLegs++;
    }
  }

  // ── §5 Honesty check — grading_attempts distribution + age span ──
  const attempts = bets.map(b => Number.isFinite(+b.grading_attempts) ? +b.grading_attempts : 0);
  const honesty = {
    attempts: {
      count: attempts.length,
      zero: attempts.filter(a => a === 0).length,
      oneToThree: attempts.filter(a => a >= 1 && a <= 3).length,
      fourPlus: attempts.filter(a => a >= 4).length,
      min: attempts.length ? Math.min(...attempts) : 0,
      max: attempts.length ? Math.max(...attempts) : 0,
      avg: attempts.length ? attempts.reduce((s, a) => s + a, 0) / attempts.length : 0,
    },
    createdAt: { oldest: null, newest: null },
  };
  const dates = bets.map(b => b.created_at).filter(Boolean).sort();
  if (dates.length) { honesty.createdAt.oldest = dates[0]; honesty.createdAt.newest = dates[dates.length - 1]; }

  // ── Secondary diagnostics — grader-fidelity caveats made measurable ──
  // (a) props the BROADER detector sees but the chosen structured-pre-check
  //     detector misses, inside covered sports — the NBA/NHL gap S3 targets.
  // (b) raw labels normalizeSport folds to MLB/NBA/NHL but that the grader's
  //     LITERAL gate (2415/2439) would NOT match → script may over-count
  //     adapter_* vs the live grader for those rows. Surfaced for honesty.
  let broadButNotChosen = 0;
  const nonCanonByLabel = new Map();
  for (const b of bets) {
    const covered = deps.normalizeSport(b.sport);
    if (covered) {
      if (deps.isPlayerPropDescription(b.description) && !deps.looksLikePlayerProp(b)) broadButNotChosen++;
      const upLit = String(b.sport == null ? '' : b.sport).trim().toUpperCase();
      if (upLit !== covered) nonCanonByLabel.set(b.sport, (nonCanonByLabel.get(b.sport) || 0) + 1);
    }
  }
  const diagnostics = {
    coveredPropsMissedByChosenDetector: broadButNotChosen,
    nonCanonicalCoveredLabels: [...nonCanonByLabel.entries()].map(([label, count]) => ({ label, count })),
  };

  return { pool, perSportGrouped, perSportRaw, source, sourceMatrix, legCut, legRouting, honesty, diagnostics };
}

// ── Compact text report ──────────────────────────────────────────────────────
function formatReport(r) {
  const L = [];
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
  L.push('═══════════════════════════════════════════════════════════');
  L.push('S1b — backoff/quarantined pool by gradeable source (read-only)');
  L.push('═══════════════════════════════════════════════════════════');

  // §1
  L.push('\n§1 POOL TOTALS (grading_state)');
  for (const s of POOL_STATES) L.push(`  ${s.padEnd(12)} ${r.pool[s] || 0}`);
  L.push(`  ${'TOTAL'.padEnd(12)} ${r.pool.total}`);

  // §2
  L.push('\n§2 PER-SPORT (grouped per BACKLOG taxonomy)  [parlay/straight]');
  for (const e of r.perSportGrouped) {
    L.push(`  ${e.sport.padEnd(14)} ${String(e.total).padStart(3)}   (${e.parlay}P / ${e.straight}S)`);
  }
  L.push('   — raw labels (ungrouped) —');
  for (const e of r.perSportRaw) {
    L.push(`  ${e.sport.padEnd(14)} ${String(e.total).padStart(3)}   (${e.parlay}P / ${e.straight}S)`);
  }

  // §3
  L.push('\n§3 SOURCE CLASSIFICATION (per bet)');
  const t = r.source.total;
  L.push(`  adapter_gamelevel ${String(r.source.adapter_gamelevel).padStart(3)}  ${pct(r.source.adapter_gamelevel, t)}   (MLB/NBA/NHL/NFL, not a player prop)`);
  L.push(`  adapter_prop      ${String(r.source.adapter_prop).padStart(3)}  ${pct(r.source.adapter_prop, t)}   (MLB/NBA/NHL player prop — props-within-covered-sports)`);
  L.push(`  search_only       ${String(r.source.search_only).padStart(3)}  ${pct(r.source.search_only, t)}   (Tennis, Soccer, Combat, Golf, …)`);
  L.push('   — by grouped sport [gamelevel/prop/search] —');
  for (const e of r.sourceMatrix) {
    L.push(`  ${e.sport.padEnd(14)} ${String(e.total).padStart(3)}   (${e.adapter_gamelevel}G / ${e.adapter_prop}P / ${e.search_only}S)`);
  }

  // §4 (parent-keyed — diffs cleanly against S1a)
  const c = r.legCut;
  L.push('\n§4 PARLAY_LEGS PROP CUT — covered-sport parlays {MLB,NBA,NHL}  (NEW vs S1a)');
  L.push('   parent-keyed: parlay + every leg attributed to the PARENT stored sport (S1a-comparable). See §4b for the grader\'s real per-leg routing.');
  L.push(`  parlays considered ${c.parlaysConsidered}`);
  L.push(`    all-prop ${c.allProp}   mixed ${c.mixed}   no-prop ${c.noProp}   no-legs(unsplit) ${c.noLegs}`);
  L.push(`  legs: prop ${c.propLegs} / non-prop ${c.nonPropLegs} / total ${c.totalLegs}   (${pct(c.propLegs, c.totalLegs)} prop)`);
  for (const [sp, b] of Object.entries(c.bySport)) {
    L.push(`    ${sp.padEnd(4)} all-prop ${b.allProp} mixed ${b.mixed} no-prop ${b.noProp} no-legs ${b.noLegs} | legs ${b.propLegs}P/${b.nonPropLegs}N`);
  }

  // §4b (leg-routed — faithful to grading.js:2204 per-leg dispatch)
  const lr = r.legRouting;
  L.push('\n§4b LEG-ROUTED VIEW — every pool parlay\'s legs routed via inferLegSport (grading.js:2204)');
  L.push(`  parlays scanned ${lr.parlaysScanned} (any parent sport) / legs scanned ${lr.legsScanned}`);
  L.push(`  legs routing to a structured adapter:  prop ${lr.routedCoveredTotal.prop} / non-prop ${lr.routedCoveredTotal.nonProp}`);
  for (const sp of ['MLB', 'NBA', 'NHL']) {
    const s = lr.routedCovered[sp];
    L.push(`    ${sp}  ${s.prop}P / ${s.nonProp}N`);
  }
  L.push(`  ↳ covered PROP legs hiding in a NON-covered-parent parlay (EXCLUDED by §4): ${lr.coveredPropLegsInNonCoveredParent}`);
  L.push(`  ↳ legs routing to an adapter ≠ parent's normalized sport (cross-sport contamination): ${lr.crossSportLegs}`);
  L.push('    → §4 (parent-keyed) under-sizes props-within-covered-sports by the first number and mis-attributes by the second; §4b is the leg-faithful sizing.');

  // §5
  const a = r.honesty.attempts;
  L.push('\n§5 HONESTY CHECK — grading_attempts over the pool');
  L.push(`  buckets:  0 → ${a.zero}   |   1–3 → ${a.oneToThree}   |   4+ → ${a.fourPlus}   (n=${a.count})`);
  L.push(`  min ${a.min} / avg ${a.avg.toFixed(2)} / max ${a.max}`);
  L.push(`  created_at span:  oldest ${r.honesty.createdAt.oldest || '—'}  →  newest ${r.honesty.createdAt.newest || '—'}`);

  // diagnostics
  const d = r.diagnostics;
  L.push('\n§D DIAGNOSTICS (grader-fidelity caveats)');
  L.push(`  covered-sport props MISSED by the chosen detector (isPlayerPropDescription true, looksLikePlayerProp false): ${d.coveredPropsMissedByChosenDetector}`);
  L.push('    → was the MLB-bias gap: looksLikePlayerProp (grading.js) used to key on MLB-only stat words, so NBA/NHL pts/reb/ast/goals props did not');
  L.push('      trip it. Closed by fix/grader-prop-gate-nba-nhl (PLAYER_PROP_STAT_HINTS now covers MLB/NBA/NHL); a nonzero count here would flag any remaining gap.');
  if (d.nonCanonicalCoveredLabels.length) {
    L.push('  non-canonical covered labels (normalizeSport folds to MLB/NBA/NHL but the grader\'s LITERAL gate would not match — possible adapter_* over-count vs live grader):');
    for (const x of d.nonCanonicalCoveredLabels) L.push(`    "${x.label}" → ${x.count}`);
  } else {
    L.push('  non-canonical covered labels: none (all covered-sport rows stored as literal MLB/NBA/NHL — script matches the grader\'s literal gate).');
  }
  L.push('');
  return L.join('\n');
}

// ── Load the REAL grader helpers as pure functions (write-safe) ──────────────
// Forces DB_PATH=':memory:' BEFORE requiring services/grading.js so the
// DB-open + migrations + migration_016 UPDATE that database.js runs at module
// load all land on a throwaway in-memory DB — NEVER the prod DB we read.
// Silences the migration console noise so the report stays clean.
function loadDeps() {
  process.env.DB_PATH = ':memory:'; // override any inherited /data path
  const origLog = console.log, origInfo = console.info, origWarn = console.warn;
  console.log = console.info = console.warn = () => {};
  try {
    const grading = require(path.join(ROOT, 'services', 'grading'));
    const { normalizeSport } = require(path.join(ROOT, 'services', 'sportsdata'));
    // ai is already in the require cache (grading.js requires it); inferLegSport
    // is the pure per-leg sport classifier the grader uses at grading.js:2204.
    const { inferLegSport } = require(path.join(ROOT, 'services', 'ai'));
    const looksLikePlayerProp = grading._internal && grading._internal.looksLikePlayerProp;
    const isPlayerPropDescription = grading.isPlayerPropDescription;
    if (typeof looksLikePlayerProp !== 'function') throw new Error('grading._internal.looksLikePlayerProp missing');
    if (typeof isPlayerPropDescription !== 'function') throw new Error('grading.isPlayerPropDescription missing');
    if (typeof normalizeSport !== 'function') throw new Error('sportsdata.normalizeSport missing');
    if (typeof inferLegSport !== 'function') throw new Error('ai.inferLegSport missing');
    return { looksLikePlayerProp, isPlayerPropDescription, normalizeSport, inferLegSport };
  } finally {
    console.log = origLog; console.info = origInfo; console.warn = origWarn;
  }
}

function openReadonlyDb() {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch { Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3')); }
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function main() {
  const deps = loadDeps();
  const db = openReadonlyDb();
  try {
    const result = measure(db, deps);
    console.log(formatReport(result));
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = {
  measure, formatReport, loadDeps, openReadonlyDb,
  isParlayBet, groupSport, isNflSport, classifySource,
  POOL_STATES, ADAPTER_GAMELEVEL_SPORTS, SOCCER_FAMILY, COMBAT_FAMILY,
};
