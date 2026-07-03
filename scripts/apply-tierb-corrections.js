#!/usr/bin/env node
// scripts/apply-tierb-corrections.js
// ═══════════════════════════════════════════════════════════
// Operator-run, in-container correction pass for the 4 externally-verified
// Tier B PINNED disagreements of the pre-gate snowflake re-anchor audit
// (docs/audits/2026-07-03-pregate-tierb-reanchor.md).
//
// These are the high-confidence "pinned" rows — matchup totals (the engine
// requires BOTH named teams, so only one matchup can match) and single-team
// picks whose adjacent games are against DIFFERENT opponents — where the tweet
// snowflake (true post instant) re-anchored the bet onto the correct ET slate
// day and the game's final flips the stored grade. Every pu was independently
// re-verified against ESPN + league-official sources on 2026-07-03 before this
// script was written. The 5th report-time "pinned" row, 2c12a667 (Angels ML),
// was RECLASSIFIED to the same-opponent-series bucket and is deliberately NOT
// here — LAA also played CIN on 04-11 (a series), so the 04-12 snowflake alone
// does not pin the intended game. See the audit's "Corrections applied" section.
//
// THE OPERATOR RUNS THIS — never an agent, never CI. Upload to the Fly
// container and run there per docs/RUNBOOKS/db-interventions.md.
//
// Usage (in-container):
//   node apply-tierb-corrections.js            # DRY RUN (db opened readonly)
//   node apply-tierb-corrections.js --apply    # writes, ONE transaction
//
// Env: APP_ROOT (default /app), DB_PATH (default /data/bettracker.db).
// Self-contained for sftp upload: requires better-sqlite3 and
// services/gradeOverride.js from APP_ROOT only; no other app module loads.
//
// Write scope: bets + bet_grade_history ONLY. No pipeline_events, no Discord,
// no network, no bankrolls / daily_snapshots / parlay_legs / user_bets writes.
//
// Reuse decision (re-audit of services/gradeOverride.js, 2026-07-03 — UNCHANGED
// since #168's apply-pregate-corrections.js):
//   applyGradeOverride still archives to bet_grade_history BEFORE the bets
//   UPDATE, is pure + dependency-injected (no Discord client, no module-level
//   db, no import-time side effects), reconciles bankrolls + parlay legs but
//   NOT user_bets — so --apply REUSES its archive→update transaction core
//   verbatim. Two deps are deliberately neutered to hold the write scope above:
//     • getBankroll → () => null. Bankroll reconciliation is OUT OF SCOPE:
//       these are pre-gate (Beta-era) bets and bankrolls were season-reset to
//       a fresh S2 slate (docs/SEASON-RESET.md) — shifting `current` by a
//       prior-era delta would corrupt the live slate. updateBankroll /
//       saveDailySnapshot are throwing stubs (unreachable while getBankroll
//       returns null), so any future widening of applyGradeOverride's write
//       scope aborts the transaction instead of writing silently.
//     • calcProfit — inline mirror of services/grading.js calcProfit()
//       (grading.js is not require-safe standalone: it pulls the full grader
//       import graph). The mirrored math is asserted per row against the
//       embedded new_pu (±PU_TOLERANCE) before any write.
//   applyGradeOverride does NOT reconcile user_bets (tails) — hence the HARD
//   GATE below: rows with user_bets rows are refused, never silently flipped.
//
// Row gates (evaluated identically in both modes; per-row, run continues):
//   skip   : id not found · stored result != expect_stored_result (already
//            corrected / drifted) · grader_version NOT NULL (post-gate write)
//   refuse : user_bets rows exist (manual decision) · bet_type != straight
//            (legs out of scope) · mirrored calcProfit differs from the
//            embedded new_pu by > PU_TOLERANCE (odds/units drifted vs the audit)
//   fatal  : an id prefix matches more than one bets row (table unsafe —
//            abort before any write)
//
// Idempotent: a second --apply run skips every row (stored result no longer
// equals expect_stored_result, and grader_version is now stamped 'manual-v1').
// ═══════════════════════════════════════════════════════════

'use strict';

const APP_ROOT = process.env.APP_ROOT || '/app';
const DB_PATH = process.env.DB_PATH || '/data/bettracker.db';

const ARCHIVED_BY = 'tierb-reanchor-2026-07-03';
const PU_TOLERANCE = 0.02;
const VALID_RESULTS = ['win', 'loss', 'push', 'void'];

// ── Correction table ────────────────────────────────────────
// The 4 externally-verified PINNED rows of
// docs/audits/2026-07-03-pregate-tierb-reanchor.md (§NEW correction candidates
// rows #3/#9/#10/#11 — the pinned rows MINUS the reclassified 2c12a667).
// id = the 8-char prefix as it appears in the audit's disagreement table
// (resolved to a full bets id at runtime via LIKE, fatal-abort on ambiguity —
// see resolve()). expect_stored_result/pu = the audit's stored column; the
// re-verified verdict + suggested_pu are new_result/new_pu. new_pu is derived
// from the stored American odds; where odds are empty the -110 default applies
// (win pu = 0.9091×units, loss pu = -units). Every pu externally verified
// against ESPN + league-official sources 2026-07-03.
//
// Net delta vs stored (Σ new_pu − expect_stored_pu):
//   320bc36b -5.7273 · d7bf7159 +1.9091 · b5bb1ad7 -1.9091 · f4946029 -1.9091
//   = -7.6364u (rounds to -7.64u). Matches the audit ΔPU column exactly.
const CORRECTIONS = [
  { id: '320bc36b', sport: 'NHL', market: 'game_total', desc: 'Lightning / Bruins OVER 6.5',
    expect_stored_result: 'win', expect_stored_pu: 2.7273, new_result: 'loss', new_pu: -3.00,
    reason: 'Tier B re-anchor + external verify: TBL 2-1 BOS = total 3, Over 6.5 loses (nhl.com/hockey-ref, 2026-04-11; snowflake corrected 04-13→04-11)',
    evidence_url: 'api-web.nhle.com/v1/score/2026-04-11' },
  { id: 'd7bf7159', sport: 'NBA', market: 'spread', desc: 'Toronto Raptors -13.5',
    expect_stored_result: 'loss', expect_stored_pu: -1.00, new_result: 'win', new_pu: 0.9091,
    reason: 'Tier B re-anchor + external verify: TOR 128-96 MEM, -13.5 covers (ESPN/b-ref, 2026-04-03; snowflake corrected 04-06→04-03)',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260403' },
  { id: 'b5bb1ad7', sport: 'NBA', market: 'game_total', desc: 'Bulls Knicks Over 237.5',
    expect_stored_result: 'win', expect_stored_pu: 0.9091, new_result: 'loss', new_pu: -1.00,
    reason: 'Tier B re-anchor + external verify: NYK 136-96 CHI = total 232, Over 237.5 loses (ESPN/b-ref, 2026-04-03; snowflake corrected 04-06→04-03)',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260403' },
  { id: 'f4946029', sport: 'NBA', market: 'game_total', desc: 'Hornets Pacers Under 235.5',
    expect_stored_result: 'win', expect_stored_pu: 0.9091, new_result: 'loss', new_pu: -1.00,
    reason: 'Tier B re-anchor + external verify: CHA 129-108 IND = total 237, Under 235.5 loses (ESPN/b-ref, 2026-04-03; snowflake corrected 04-06→04-03)',
    evidence_url: 'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260403' },
];

// ── Payout math (inline mirror) ─────────────────────────────
// Byte-equivalent mirror of services/grading.js calcProfit(). Injected into
// applyGradeOverride (grading.js itself is not require-safe standalone) and
// used for the per-row cross-check against the embedded new_pu.
function calcProfit(odds, units, result) {
  if (result === 'push') return 0;
  if (result === 'loss') return -units;
  if (result === 'void') return 0;

  // Win
  if (odds > 0) return units * (odds / 100);
  if (odds < 0) return units * (100 / Math.abs(odds));
  return 0;
}

function round2(x) { return Math.round(x * 100) / 100; }

// ── Table shape validation (unit-tested, DB-free) ───────────
function validateCorrectionTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('corrections: not a non-empty array');
  const seen = new Set();
  const dir = { lossToWin: 0, winToLoss: 0, winToVoid: 0 };
  for (const r of rows) {
    const tag = `corrections[${r && r.id}]`;
    if (!r || typeof r.id !== 'string' || !/^[0-9a-f]{8,12}$/.test(r.id)) throw new Error(`${tag}: bad id`);
    if (seen.has(r.id)) throw new Error(`${tag}: duplicate id`);
    seen.add(r.id);
    if (!VALID_RESULTS.includes(r.expect_stored_result)) throw new Error(`${tag}: bad expect_stored_result`);
    if (!VALID_RESULTS.includes(r.new_result)) throw new Error(`${tag}: bad new_result`);
    if (r.new_result === r.expect_stored_result) throw new Error(`${tag}: new_result equals expect_stored_result`);
    if (typeof r.expect_stored_pu !== 'number' || Number.isNaN(r.expect_stored_pu)) throw new Error(`${tag}: bad expect_stored_pu`);
    if (typeof r.new_pu !== 'number' || Number.isNaN(r.new_pu)) throw new Error(`${tag}: bad new_pu`);
    if (r.new_result === 'win' && !(r.new_pu > 0)) throw new Error(`${tag}: win must have new_pu > 0`);
    if (r.new_result === 'loss' && !(r.new_pu < 0)) throw new Error(`${tag}: loss must have new_pu < 0`);
    if ((r.new_result === 'void' || r.new_result === 'push') && r.new_pu !== 0) throw new Error(`${tag}: void/push must have new_pu 0`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${tag}: empty reason`);
    if (typeof r.evidence_url !== 'string' || !r.evidence_url.trim()) throw new Error(`${tag}: empty evidence_url`);
    if (r.expect_stored_result === 'loss' && r.new_result === 'win') dir.lossToWin++;
    else if (r.expect_stored_result === 'win' && r.new_result === 'loss') dir.winToLoss++;
    else if (r.expect_stored_result === 'win' && r.new_result === 'void') dir.winToVoid++;
    else throw new Error(`${tag}: unexpected flip direction ${r.expect_stored_result}→${r.new_result}`);
  }
  return dir;
}

module.exports = {
  CORRECTIONS,
  calcProfit, round2, validateCorrectionTable,
  ARCHIVED_BY, PU_TOLERANCE,
};

// ═════════════════════════ runtime ══════════════════════════
if (require.main === module) main();

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const unknown = argv.filter(a => a !== '--apply');
  if (unknown.length) {
    console.error(`unknown arg(s): ${unknown.join(' ')}\nUsage: node apply-tierb-corrections.js [--apply]`);
    process.exit(2);
  }

  const dirTotals = validateCorrectionTable(CORRECTIONS);

  // Preflight both requires in BOTH modes so a dry run surfaces a missing
  // module before the operator reaches --apply.
  let Database, applyGradeOverride;
  try {
    Database = require(APP_ROOT + '/node_modules/better-sqlite3');
    ({ applyGradeOverride } = require(APP_ROOT + '/services/gradeOverride.js'));
  } catch (err) {
    console.error(`preflight require failed (APP_ROOT=${APP_ROOT}): ${err.message}`);
    process.exit(2);
  }

  let db;
  try {
    db = new Database(DB_PATH, { readonly: !apply, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open DB_PATH=${DB_PATH}: ${err.message}`);
    process.exit(2);
  }

  console.log(`apply-tierb-corrections — ${apply ? 'APPLY' : 'DRY RUN (readonly)'}`);
  console.log(`  db: ${DB_PATH}   app: ${APP_ROOT}   rows: ${CORRECTIONS.length} pinned corrections\n`);

  const findByPrefix = db.prepare(`
    SELECT id, description, bet_type, sport, odds, units, result, profit_units,
           grade, grade_reason, graded_at, grader_version
    FROM bets WHERE id LIKE ?
  `);
  const tailCount = db.prepare('SELECT COUNT(*) AS n FROM user_bets WHERE bet_id = ?');

  // Prefix → exactly one bets row, or fatal on ambiguity (no writes yet — safe).
  function resolve(prefix) {
    const rows = findByPrefix.all(prefix + '%');
    if (rows.length > 1) {
      console.error(`FATAL: id prefix ${prefix} matches ${rows.length} bets — correction table is unsafe, aborting.`);
      process.exit(2);
    }
    return rows[0] || null;
  }

  // ── Evaluate corrections (shared by both modes) ───────────
  const plans = CORRECTIONS.map((row) => {
    const bet = resolve(row.id);
    if (!bet) return { row, status: 'skip', why: 'not_found' };
    if (bet.grader_version != null) return { row, bet, status: 'skip', why: `grader_version=${bet.grader_version} (not a pre-gate row)` };
    if (bet.result !== row.expect_stored_result) return { row, bet, status: 'skip', why: `stored result '${bet.result}' != expected '${row.expect_stored_result}' (already corrected?)` };

    const refusals = [];
    const warns = [];
    if (bet.bet_type !== 'straight') refusals.push(`bet_type='${bet.bet_type}' (pinned rows are straights; legs out of scope)`);
    const writeValue = calcProfit(bet.odds || -110, bet.units || 1, row.new_result);
    if (Math.abs(round2(writeValue) - row.new_pu) > PU_TOLERANCE) {
      refusals.push(`pu mismatch: calcProfit(odds=${bet.odds}, units=${bet.units}) = ${round2(writeValue)} vs table new_pu ${row.new_pu} (odds/units drifted vs audit?)`);
    }
    const tails = tailCount.get(bet.id).n;
    if (tails > 0) refusals.push(`HARD GATE: ${tails} user_bets row(s) — applyGradeOverride does not reconcile user_bets; manual decision required`);
    const storedPu = bet.profit_units == null ? null : parseFloat(bet.profit_units);
    if (storedPu != null && Math.abs(storedPu - row.expect_stored_pu) > 0.005) {
      warns.push(`stored pu ${storedPu} != audit's ${row.expect_stored_pu} (informational)`);
    }
    return { row, bet, tails, writeValue, storedPu, warns, refusals, status: refusals.length ? 'refuse' : 'ok' };
  });

  // ── Report ────────────────────────────────────────────────
  let i = 0;
  for (const p of plans) {
    i++;
    const head = `[${String(i).padStart(2)}/${plans.length}] ${p.row.id}  ${p.row.sport} ${p.row.market}`;
    if (p.status === 'skip') { console.log(`${head}  SKIP — ${p.why}`); continue; }
    const flip = `${p.row.expect_stored_result}→${p.row.new_result.toUpperCase()}`;
    console.log(`${head}  ${p.status === 'refuse' ? 'REFUSE' : 'FLIP'} ${flip}`);
    console.log(`        desc:   ${String(p.bet.description).slice(0, 100)}`);
    console.log(`        stored: ${p.bet.result} / ${p.storedPu}  →  ${p.row.new_result} / ${round2(p.writeValue)} (table ${p.row.new_pu})`);
    console.log(`        tails:  ${p.tails}`);
    console.log(`        ev:     ${p.row.evidence_url}`);
    for (const w of p.warns) console.log(`        WARN:   ${w}`);
    for (const r of p.refusals) console.log(`        REFUSE: ${r}`);
  }

  const ok = plans.filter(p => p.status === 'ok');
  const refused = plans.filter(p => p.status === 'refuse');
  const skipped = plans.filter(p => p.status === 'skip');
  const netDelta = ok.reduce((s, p) => s + (p.writeValue - (p.storedPu || 0)), 0);
  const tailsTotal = plans.reduce((s, p) => s + (p.tails || 0), 0);
  const dirOk = { lossToWin: 0, winToLoss: 0, winToVoid: 0 };
  for (const p of ok) {
    if (p.row.new_result === 'win') dirOk.lossToWin++;
    else if (p.row.new_result === 'loss') dirOk.winToLoss++;
    else dirOk.winToVoid++;
  }

  console.log('\ntotals:');
  console.log(`  table:      loss→win ${dirTotals.lossToWin}, win→loss ${dirTotals.winToLoss}, win→void ${dirTotals.winToVoid}`);
  console.log(`  actionable: loss→win ${dirOk.lossToWin}, win→loss ${dirOk.winToLoss}, win→void ${dirOk.winToVoid}  (skipped ${skipped.length}, refused ${refused.length})`);
  console.log(`  net profit_units delta (actionable rows): ${round2(netDelta) >= 0 ? '+' : ''}${round2(netDelta)}u  (table expects -7.64u)`);
  console.log(`  user_bets tails across evaluated rows: ${tailsTotal}`);

  if (refused.length) {
    console.log('\nREFUSED rows (manual decision required, NOT applied):');
    for (const p of refused) console.log(`  ${p.row.id} — ${p.refusals.join(' | ')}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  // ── Apply (ONE transaction for everything) ────────────────
  const deps = {
    db,
    getBankroll: () => null, // bankroll reconciliation out of scope — see header
    updateBankroll: () => { throw new Error('write-scope violation: updateBankroll called'); },
    saveDailySnapshot: () => { throw new Error('write-scope violation: saveDailySnapshot called'); },
    calcProfit,
  };

  const runAll = db.transaction(() => {
    let flips = 0;
    for (const p of ok) {
      const res = applyGradeOverride(deps, {
        betId: p.bet.id,
        result: p.row.new_result,
        reason: `${p.row.reason} — ${p.row.evidence_url}`,
        invokerId: ARCHIVED_BY,
      });
      if (!res.ok) throw new Error(`applyGradeOverride failed on ${p.row.id}: ${res.error}`);
      // Belt-and-braces: the neutered deps + straight-only gate make these
      // unreachable; a hit means the write scope was violated — roll back all.
      if (res.bankrollApplied || res.legsTouched) throw new Error(`write-scope violation on ${p.row.id}: bankrollApplied=${res.bankrollApplied} legsTouched=${res.legsTouched}`);
      if (Math.abs(res.newProfit - p.writeValue) > 1e-9) throw new Error(`profit drift on ${p.row.id}: wrote ${res.newProfit}, planned ${p.writeValue}`);
      flips++;
    }
    return { flips };
  });

  try {
    const { flips } = runAll();
    console.log(`\nAPPLIED: ${flips} bets corrected (archive+update) — one transaction, committed.`);
  } catch (err) {
    console.error(`\nAPPLY FAILED — transaction rolled back, nothing written: ${err.message}`);
    db.close();
    process.exit(2);
  }
  db.close();
}
