#!/usr/bin/env node
// scripts/apply-regrade-s01-s05.js
// ═══════════════════════════════════════════════════════════
// Operator-run, in-container application of the completed manual regrade
// S01–S05 — 113 auto-swept bets re-graded by hand against web sources
// (regrade-final.json, co-located). This rewrites live `bets` result / grade /
// profit_units (+ 7 unit corrections, 1 sport correction) and archives each
// bet's prior state to bet_grade_history. It CHANGES the live ROI/bankroll
// surface and is IRREVERSIBLE — default is DRY RUN.
//
// THE OPERATOR RUNS THIS — never an agent, never CI. Upload to the Fly
// container and run there per docs/RUNBOOKS/db-interventions.md.
//
// Usage:
//   node scripts/apply-regrade-s01-s05.js                       # DRY RUN (readonly), default input+db
//   node scripts/apply-regrade-s01-s05.js --input <path> --db <path> --dry-run
//   node scripts/apply-regrade-s01-s05.js --input <path> --db <path> --apply
//   Flags: --allow-nonprod  (permit a --db other than /data/bettracker.db)
//          --mma-sport <v>   (override the MMA enum for the sport correction)
//
// Defaults: --input = <script dir>/regrade-final.json ; --db = /data/bettracker.db
//
// Write scope: bets + bet_grade_history ONLY. No pipeline_events, no Discord,
// no network, no bankrolls / daily_snapshots / parlay_legs / user_bets writes.
//
// ── Reuse decision (audit of services/gradeOverride.js) ─────────────────────
// The prompt asks to reuse applyGradeOverride per-bet. Its ARCHIVE contract is
// reused verbatim (same bet_grade_history columns; migration 022), and its
// result vocabulary is imported (VALID_RESULTS) so our target results can never
// drift from the canonical set. Its bet-UPDATE, however, is deliberately NOT
// used, because it cannot express the FINAL state this regrade requires:
//   • profit_units — applyGradeOverride RECOMPUTES via calcProfit(odds,units).
//     This regrade carries an explicit, manually-graded profit_units per bet
//     (odds in the DB are often wrong/empty — that is WHY these were regraded),
//     so profit must be written verbatim, not recomputed.
//   • grader_version — applyGradeOverride hardcodes 'manual-v1'; requirement #3
//     mandates 'manual-regrade-s01-s05' (and idempotency #4 keys on it).
//   • grade column — applyGradeOverride never writes `grade`; requirement is
//     result/grade together (grade='WIN'/'LOSS'/'VOID').
//   • units / sport — applyGradeOverride touches neither; this pass corrects 7
//     units + 1 sport.
// Forcing applyGradeOverride would mean calling it AND then 4–5 corrective raw
// UPDATEs per bet — strictly MORE raw writes, not fewer. Instead each bet does
// exactly ONE archive INSERT immediately followed by ONE comprehensive UPDATE,
// inside a single transaction. This honors the TRUE invariant — "no raw UPDATE
// that BYPASSES archiving" — every UPDATE here is archive-gated in the same
// loop iteration. Bankroll `current` (bankrolls table) is intentionally NOT
// reconciled: the ROI/leaderboard surface is DERIVED from bets rows at read
// time (SETTLED_BET, grading.js/#77), so rewriting profit_units/units/result
// updates ROI directly; the persisted `current` is season-sliced and shifting
// it by a cross-season delta would corrupt the live slate (mirrors the
// apply-pregate-corrections.js bankroll-neutering rationale + docs/SEASON-RESET.md).
//
// Idempotent: a second run skips every bet already stamped
// grader_version='manual-regrade-s01-s05' (re-run = no-op).
// ═══════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

// App-module resolution root. The operator uploads this script to /tmp and runs
// it there (sftp), so a relative `../services/…` require would resolve against
// /tmp and throw MODULE_NOT_FOUND. Resolve app modules from APP_ROOT (default
// /app, matching apply-pregate-corrections.js) so load works regardless of the
// script's on-disk location. requireBetterSqlite() uses the same base.
const APP_ROOT = process.env.APP_ROOT || '/app';

// Canonical result vocabulary — reused from services/gradeOverride.js so our
// mapped targets ('win'/'loss'/'void') can never drift from the codebase set.
// Side-effect-free (no better-sqlite3 at load).
const { VALID_RESULTS } = require(path.join(APP_ROOT, 'services/gradeOverride'));

const GRADER_VERSION = 'manual-regrade-s01-s05';
const ARCHIVED_BY = 'manual-regrade-s01-s05';
const PROD_DB_PATH = '/data/bettracker.db';
const REASON_MAX = 1200; // cap the (unbounded TEXT) grade_reason we write

// ── Ingest-error corrections (applied in the same op, archived) ─────────────
// units column corrections. profit_units in the JSON ALREADY reflects these
// stakes; here we also fix the `units` column so ROI's Σunits denominator is
// right (roi_pct = Σprofit_units ÷ Σunits, grading.js/#77).
const UNIT_CORRECTIONS = {
  '716a7b2cd0dadea096350c0c6d353c94': 1,
  '7596d20a589c39c3820ca1f1531b8901': 1,
  'b3198994e1fc82464ab3b449b78cd2db': 4,
  '5df44d7cb8cb9c49fb273e1805566e2b': 3,
  '9113745924df1bc89683dee1e772bc3d': 2,
  'bd5bb34e1d94b89b6223b7f3dd706d6e': 3,
  '8436c0c7a28e303fed1d561af23fa595': 10,
};

// sport column correction. 8436c0c7 (Christian Rodriguez ML, UFC Vegas 119) was
// mislabeled Soccer by the vision parser. The target MMA enum is resolved at
// RUNTIME from the Nickal–Daukaus anchor bet's stored sport (the prompt's named
// reference), falling back to 'MMA' (ai.js normalizes ufc/mma → 'MMA').
const SPORT_CORRECTION = {
  id: '8436c0c7a28e303fed1d561af23fa595',
  expectFromSport: 'Soccer',
  anchorBetId: '7e0e7777d778776b69531156c19b6544', // Nickal–Daukaus (MMA)
  fallbackMmaSport: 'MMA',
};

const RESULT_TABLE = {
  win: { result: 'win', grade: 'WIN' },
  loss: { result: 'loss', grade: 'LOSS' },
  unknown: { result: 'void', grade: 'VOID' }, // VOID + refund stake (profit 0)
};

// Columns the run reads/writes — asserted present via PRAGMA before any work.
const REQUIRED_BETS_COLS = ['id', 'description', 'bet_type', 'sport', 'odds', 'units',
  'result', 'profit_units', 'grade', 'grade_reason', 'graded_at', 'grader_version'];
const REQUIRED_HISTORY_COLS = ['bet_id', 'old_result', 'old_profit_units', 'old_grade',
  'old_grade_reason', 'old_graded_at', 'archived_by', 'reason'];

function round2(x) { return Math.round(x * 100) / 100; }

// ── Input load + shape validation (DB-free, unit-tested) ────────────────────
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('input: not a non-empty array');
  const seen = new Set();
  let win = 0, loss = 0, unknown = 0;
  for (const e of entries) {
    const tag = `entry[${e && e.bet_id}]`;
    if (!e || typeof e.bet_id !== 'string' || !/^[0-9a-f]{32}$/.test(e.bet_id)) throw new Error(`${tag}: bad bet_id (want 32-hex)`);
    if (seen.has(e.bet_id)) throw new Error(`${tag}: duplicate bet_id`);
    seen.add(e.bet_id);
    if (!['win', 'loss', 'unknown'].includes(e.result)) throw new Error(`${tag}: bad result '${e.result}'`);
    if (e.result === 'win') {
      if (!(typeof e.profit_units === 'number' && e.profit_units > 0)) throw new Error(`${tag}: win must have profit_units > 0`);
      win++;
    } else if (e.result === 'loss') {
      if (!(typeof e.profit_units === 'number' && e.profit_units < 0)) throw new Error(`${tag}: loss must have profit_units < 0`);
      loss++;
    } else { // unknown → void
      if (e.profit_units !== null && e.profit_units !== 0) throw new Error(`${tag}: unknown must have profit_units null|0`);
      unknown++;
    }
    if (typeof e.grade_reason !== 'string' || !e.grade_reason.trim()) throw new Error(`${tag}: empty grade_reason`);
  }
  // Every unit/sport correction id must be one of the input entries.
  for (const id of Object.keys(UNIT_CORRECTIONS)) if (!seen.has(id)) throw new Error(`unit-correction id ${id} absent from input`);
  if (!seen.has(SPORT_CORRECTION.id)) throw new Error(`sport-correction id ${SPORT_CORRECTION.id} absent from input`);
  // Mapped targets must be in the canonical result set (reuse-linkage guard).
  for (const k of Object.keys(RESULT_TABLE)) {
    if (!VALID_RESULTS.includes(RESULT_TABLE[k].result)) throw new Error(`RESULT_TABLE.${k} -> ${RESULT_TABLE[k].result} not in VALID_RESULTS`);
  }
  return { total: entries.length, win, loss, unknown };
}

function loadEntries(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const entries = JSON.parse(raw);
  validateEntries(entries);
  return entries;
}

// ── MMA enum resolution for the sport correction ────────────────────────────
function looksLikeMmaSport(s) { return typeof s === 'string' && /^(mma|ufc)$/i.test(s.trim()); }

function resolveMmaSport(getBet, override) {
  if (override) return { value: override, source: 'override' };
  const anchor = getBet(SPORT_CORRECTION.anchorBetId);
  if (anchor && looksLikeMmaSport(anchor.sport)) return { value: anchor.sport, source: `anchor ${SPORT_CORRECTION.anchorBetId.slice(0, 8)}` };
  return { value: SPORT_CORRECTION.fallbackMmaSport, source: anchor ? `fallback (anchor sport='${anchor.sport}' not MMA-ish)` : 'fallback (anchor bet absent)' };
}

// ── Plan builder (pure; getBet injected → DB-free unit-testable) ─────────────
// getBet(id) → the bets row (with at least the REQUIRED_BETS_COLS) or null.
function buildPlan(entries, { getBet, mmaSport }) {
  const missing = [];
  const plans = [];
  for (const e of entries) {
    const bet = getBet(e.bet_id);
    if (!bet) { missing.push(e.bet_id); continue; }

    const map = RESULT_TABLE[e.result];
    const newProfit = e.result === 'unknown' ? 0 : e.profit_units;
    const unitCorrection = Object.prototype.hasOwnProperty.call(UNIT_CORRECTIONS, e.bet_id)
      ? UNIT_CORRECTIONS[e.bet_id] : null;
    const sportCorrection = e.bet_id === SPORT_CORRECTION.id ? mmaSport : null;
    const finalUnits = unitCorrection != null ? unitCorrection : bet.units;
    const finalSport = sportCorrection != null ? sportCorrection : bet.sport;

    const warnings = [];
    // loss profit is ALWAYS −stake; a mismatch means the stake in the DB and the
    // manually-graded profit disagree (a units row we should also be fixing?).
    if (e.result === 'loss' && finalUnits != null && Math.abs(newProfit - (-finalUnits)) > 0.01) {
      warnings.push(`loss profit ${newProfit} != -units ${finalUnits} (stake/profit disagree)`);
    }
    if (sportCorrection != null && bet.sport !== SPORT_CORRECTION.expectFromSport) {
      warnings.push(`sport-correction: stored sport '${bet.sport}' != expected '${SPORT_CORRECTION.expectFromSport}'`);
    }

    const already = bet.grader_version === GRADER_VERSION;
    plans.push({
      entry: e,
      action: already ? 'skip' : 'apply',
      why: already ? `already stamped ${GRADER_VERSION}` : null,
      old: { result: bet.result, profit_units: bet.profit_units, units: bet.units, sport: bet.sport, grade: bet.grade, grade_reason: bet.grade_reason, graded_at: bet.graded_at, description: bet.description },
      next: { result: map.result, grade: map.grade, profit_units: newProfit, units: finalUnits, sport: finalSport },
      unitCorrection, sportCorrection, warnings,
    });
  }

  const apply = plans.filter(p => p.action === 'apply');
  const summary = {
    total: entries.length,
    present: plans.length,
    missing: missing.length,
    skipped: plans.length - apply.length,
    win: apply.filter(p => p.next.result === 'win').length,
    loss: apply.filter(p => p.next.result === 'loss').length,
    void: apply.filter(p => p.next.result === 'void').length,
    unitCorrections: apply.filter(p => p.unitCorrection != null).length,
    sportCorrections: apply.filter(p => p.sportCorrection != null).length,
    toArchive: apply.length,
    warnings: apply.reduce((s, p) => s + p.warnings.length, 0),
    netDelta: round2(apply.reduce((s, p) => s + (p.next.profit_units - (p.old.profit_units || 0)), 0)),
  };
  return { plans, apply, missing, summary };
}

// ── Apply (ONE transaction; archive-then-update per bet) ────────────────────
function applyPlan(db, apply) {
  const reread = db.prepare(`SELECT ${REQUIRED_BETS_COLS.join(', ')} FROM bets WHERE id = ?`);
  const insertHistory = db.prepare(`
    INSERT INTO bet_grade_history
      (bet_id, old_result, old_profit_units, old_grade, old_grade_reason, old_graded_at, archived_by, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    let archived = 0, updated = 0;
    for (const p of apply) {
      const e = p.entry;

      // Re-read the row INSIDE the transaction so the archive records the TRUE
      // pre-overwrite state even if a concurrent writer (the live bot) touched
      // the row between planning and applying. bet_grade_history is the only
      // recovery record for this irreversible migration, so it must be faithful.
      const cur = reread.get(e.bet_id);
      if (!cur) throw new Error(`row ${e.bet_id} vanished between plan and apply — rolling back`);
      if (cur.grader_version === GRADER_VERSION) throw new Error(`row ${e.bet_id} already stamped ${GRADER_VERSION} (concurrent apply?) — rolling back`);

      // 1. Archive PRIOR state (from the fresh in-txn read). bet_grade_history
      //    has no units/sport columns, so prior units/sport (when they change)
      //    are folded into `reason`.
      const deltas = [`${cur.result ?? 'null'}/${cur.profit_units ?? 'null'} -> ${p.next.result}/${p.next.profit_units}`];
      if (p.unitCorrection != null) deltas.push(`units ${cur.units ?? 'null'}->${p.next.units}`);
      if (p.sportCorrection != null) deltas.push(`sport ${cur.sport ?? 'null'}->${p.next.sport}`);
      const archiveReason = `${GRADER_VERSION}: ${deltas.join('; ')}`.slice(0, REASON_MAX);
      insertHistory.run(e.bet_id, cur.result, cur.profit_units, cur.grade, cur.grade_reason, cur.graded_at, ARCHIVED_BY, archiveReason);
      archived++;

      // 2. Comprehensive UPDATE — result/grade/profit always; units/sport only
      //    when this bet is corrected. WHERE guards against a double-apply.
      const sets = ['result = ?', 'grade = ?', 'profit_units = ?', 'grade_reason = ?',
        "grader_version = ?", "graded_at = datetime('now')"];
      const params = [p.next.result, p.next.grade, p.next.profit_units, newGradeReason(e), GRADER_VERSION];
      if (p.unitCorrection != null) { sets.push('units = ?'); params.push(p.next.units); }
      if (p.sportCorrection != null) { sets.push('sport = ?'); params.push(p.next.sport); }
      params.push(e.bet_id, GRADER_VERSION);
      const info = db.prepare(`UPDATE bets SET ${sets.join(', ')}
        WHERE id = ? AND (grader_version IS NULL OR grader_version != ?)`).run(...params);
      if (info.changes !== 1) throw new Error(`expected 1 row updated for ${e.bet_id}, got ${info.changes} (concurrent stamp? already applied?)`);
      updated++;
    }
    return { archived, updated };
  });

  return run();
}

// grade_reason we write to the live column: the manual verdict + a regrade
// breadcrumb + evidence pointer (Rule 5). Capped so no absurd row lands.
function newGradeReason(e) {
  const src = [e.evidence_source, e.evidence_url].filter(Boolean).join(' ');
  const tail = src ? ` (src: ${src})` : '';
  return `[regrade S01–S05] ${e.grade_reason}${tail}`.slice(0, REASON_MAX);
}

// ── Post-apply verification (re-read; counts + sample rows) ──────────────────
function verifyPostApply(db, entries) {
  const ids = entries.map(e => e.bet_id);
  const place = ids.map(() => '?').join(',');
  const stamped = db.prepare(`SELECT result, COUNT(*) n FROM bets WHERE id IN (${place}) AND grader_version = ? GROUP BY result`).all(...ids, GRADER_VERSION);
  const byResult = Object.fromEntries(stamped.map(r => [r.result, r.n]));
  const archived = db.prepare(`SELECT COUNT(*) n FROM bet_grade_history WHERE bet_id IN (${place}) AND archived_by = ?`).get(...ids, ARCHIVED_BY).n;
  const sportRow = db.prepare('SELECT id, sport, units, result, profit_units FROM bets WHERE id = ?').get(SPORT_CORRECTION.id);
  const unitSample = db.prepare('SELECT id, units, result, profit_units FROM bets WHERE id = ?').get(Object.keys(UNIT_CORRECTIONS)[0]);
  return { byResult, archived, sportRow, unitSample };
}

// ═════════════════════════ CLI + runtime ══════════════════════════
function parseArgs(argv) {
  const out = { mode: null, inputPath: null, dbPath: null, allowNonprod: false, mmaSport: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = out.mode === 'dry-run' ? 'conflict' : 'apply';
    else if (a === '--dry-run') out.mode = out.mode === 'apply' ? 'conflict' : 'dry-run';
    else if (a === '--allow-nonprod') out.allowNonprod = true;
    else if (a === '--input') out.inputPath = argv[++i];
    else if (a === '--db') out.dbPath = argv[++i];
    else if (a === '--mma-sport') out.mmaSport = argv[++i];
    else return { error: `unknown arg: ${a}` };
  }
  if (out.mode === 'conflict') return { error: '--dry-run and --apply are mutually exclusive' };
  if (out.mode == null) out.mode = 'dry-run'; // DRY RUN is the default
  if (out.inputPath == null) out.inputPath = path.join(__dirname, 'regrade-final.json');
  if (out.dbPath == null) out.dbPath = PROD_DB_PATH;
  return out;
}

function requireBetterSqlite() {
  const candidates = ['better-sqlite3', path.join(APP_ROOT, 'node_modules', 'better-sqlite3')];
  let lastErr;
  for (const c of candidates) { try { return require(c); } catch (err) { lastErr = err; } }
  throw new Error(`better-sqlite3 not resolvable (tried ${candidates.join(', ')}): ${lastErr && lastErr.message}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`${args.error}\nUsage: node scripts/apply-regrade-s01-s05.js --input <path> --db <path> [--dry-run|--apply] [--allow-nonprod] [--mma-sport <v>]`); process.exit(2); }

  const apply = args.mode === 'apply';

  // Safety: refuse a non-prod DB unless explicitly allowed.
  if (args.dbPath !== PROD_DB_PATH && !args.allowNonprod) {
    console.error(`REFUSED: --db='${args.dbPath}' is not ${PROD_DB_PATH}. Pass --allow-nonprod to target a non-prod DB.`);
    process.exit(2);
  }

  let entries, counts;
  try { entries = loadEntries(args.inputPath); counts = validateEntries(entries); }
  catch (err) { console.error(`input load/validate failed (${args.inputPath}): ${err.message}`); process.exit(2); }

  const Database = requireBetterSqlite();
  let db;
  try { db = new Database(args.dbPath, { readonly: !apply, fileMustExist: true }); }
  catch (err) { console.error(`cannot open --db=${args.dbPath}: ${err.message}`); process.exit(2); }

  // Requirement #1: verify columns exist before assuming anything.
  const betsCols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
  const histCols = db.prepare('PRAGMA table_info(bet_grade_history)').all().map(c => c.name);
  const missBets = REQUIRED_BETS_COLS.filter(c => !betsCols.includes(c));
  const missHist = REQUIRED_HISTORY_COLS.filter(c => !histCols.includes(c));
  if (missBets.length || missHist.length) {
    console.error(`schema mismatch — bets missing [${missBets}] ; bet_grade_history missing [${missHist}]`);
    db.close(); process.exit(2);
  }

  console.log(`apply-regrade-s01-s05 — ${apply ? 'APPLY' : 'DRY RUN (readonly)'}`);
  console.log(`  input: ${args.inputPath}   db: ${args.dbPath}`);
  console.log(`  entries: ${counts.total} (${counts.win} win, ${counts.loss} loss, ${counts.unknown} unknown→void)\n`);

  const getBetStmt = db.prepare(`SELECT ${REQUIRED_BETS_COLS.join(', ')} FROM bets WHERE id = ?`);
  const getBet = (id) => getBetStmt.get(id) || null;

  const mma = resolveMmaSport(getBet, args.mmaSport);
  console.log(`  MMA sport for ${SPORT_CORRECTION.id.slice(0, 8)}: '${mma.value}' (source: ${mma.source})\n`);

  const { plans, apply: applyRows, missing, summary } = buildPlan(entries, { getBet, mmaSport: mma.value });

  // Requirement #5: abort (list + non-zero) if ANY bet_id is absent.
  if (missing.length) {
    console.error(`ABORT: ${missing.length} bet_id(s) absent from the DB — no writes:`);
    for (const id of missing) console.error(`  ${id}`);
    db.close(); process.exit(1);
  }

  // ── Per-bet report ────────────────────────────────────────
  let i = 0;
  for (const p of plans) {
    i++;
    const flag = p.action === 'skip' ? 'SKIP' : (p.unitCorrection != null || p.sportCorrection != null ? 'FIX ' : 'SET ');
    const head = `[${String(i).padStart(3)}/${plans.length}] ${p.entry.bet_id.slice(0, 8)} ${flag}`;
    if (p.action === 'skip') { console.log(`${head} — ${p.why}`); continue; }
    const oldS = `${p.old.result ?? 'null'}/${fmt(p.old.profit_units)}/${fmt(p.old.units)}u/${p.old.sport}`;
    const newS = `${p.next.result}/${fmt(p.next.profit_units)}/${fmt(p.next.units)}u/${p.next.sport}`;
    console.log(`${head} ${String(p.old.description).slice(0, 46).padEnd(46)}  ${oldS}  ->  ${newS}`);
    for (const w of p.warnings) console.log(`        WARN: ${w}`);
  }

  // ── Summary ───────────────────────────────────────────────
  const target = { win: 58, loss: 35, void: 20, unit: 7, sport: 1, archive: 113 };
  const hit = summary.win === target.win && summary.loss === target.loss && summary.void === target.void
    && summary.unitCorrections === target.unit && summary.sportCorrections === target.sport && summary.toArchive === target.archive;
  console.log('\nsummary (actionable rows):');
  console.log(`  results:          ${summary.win} win, ${summary.loss} loss, ${summary.void} void`);
  console.log(`  unit corrections: ${summary.unitCorrections}   sport corrections: ${summary.sportCorrections}`);
  console.log(`  to archive:       ${summary.toArchive}   skipped (already stamped): ${summary.skipped}`);
  console.log(`  net profit_units delta: ${summary.netDelta >= 0 ? '+' : ''}${summary.netDelta}u   warnings: ${summary.warnings}`);
  console.log(`  sanity target (fresh run) 58W/35L/20void/7unit/1sport/113archive: ${hit ? 'MATCH' : 'NO MATCH (ok if a re-run: ' + summary.skipped + ' already stamped)'}`);

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  // ── Apply — ONE transaction, rollback on any error ────────
  let res;
  try {
    res = applyPlan(db, applyRows);
  } catch (err) {
    console.error(`\nAPPLY FAILED — transaction rolled back, nothing written: ${err.message}`);
    db.close(); process.exit(2);
  }
  console.log(`\nAPPLIED: ${res.updated} bets rewritten, ${res.archived} archived — one transaction, committed.`);

  // Post-apply verification (re-read).
  const v = verifyPostApply(db, entries);
  console.log('\npost-apply verification (re-read):');
  console.log(`  stamped by result:  win=${v.byResult.win || 0} loss=${v.byResult.loss || 0} void=${v.byResult.void || 0}`);
  console.log(`  archive rows (this run): ${v.archived}`);
  console.log(`  sport-correction 8436c0c7: sport='${v.sportRow.sport}' units=${v.sportRow.units} ${v.sportRow.result}/${v.sportRow.profit_units}`);
  console.log(`  unit-correction sample ${Object.keys(UNIT_CORRECTIONS)[0].slice(0, 8)}: units=${v.unitSample.units} ${v.unitSample.result}/${v.unitSample.profit_units}`);
  db.close();
}

function fmt(x) { return x == null ? 'null' : (Math.round(x * 100) / 100); }

module.exports = {
  GRADER_VERSION, ARCHIVED_BY, PROD_DB_PATH, UNIT_CORRECTIONS, SPORT_CORRECTION, RESULT_TABLE,
  REQUIRED_BETS_COLS, REQUIRED_HISTORY_COLS,
  validateEntries, loadEntries, buildPlan, applyPlan, resolveMmaSport, looksLikeMmaSport,
  verifyPostApply, newGradeReason, parseArgs, round2,
};

if (require.main === module) main();
