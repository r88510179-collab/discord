#!/usr/bin/env node
// scripts/apply-tierb-tailed-corrections.js
// ═══════════════════════════════════════════════════════════
// Operator-run, in-container FOLLOW-UP to scripts/apply-tierb-corrections.js
// (#172). That script corrected the 4 externally-verified Tier B PINNED rows of
// docs/audits/2026-07-03-pregate-tierb-reanchor.md — but its user_bets HARD GATE
// refused 3 of them because each carries a single user_bets "tail" and
// applyGradeOverride does not reconcile user_bets. #172 therefore applied only
// the 0-tail row (320bc36b); the other 3 stayed uncorrected.
//
// This script corrects those 3 tail-gated pinned rows AND settles their tails in
// ONE atomic transaction: flip the bet (archive→update, reusing #172's machinery
// verbatim) + settle the tailed user_bets row(s) for that bet. The HARD GATE is
// RELAXED to a scoped allow: the tails are permitted ONLY for the one
// synthetic/admin user_id below; any other user_id still refuses the row.
//
// OPERATOR-VERIFIED CONTEXT (2026-07-03 — cited as fact, NOT re-queried here):
//   • #172's apply-tierb-corrections.js flipped 320bc36b (0 tails); d7bf7159 /
//     b5bb1ad7 / f4946029 were REFUSED, each with exactly 1 user_bets tail.
//   • Every tail across user_bets belongs to user_id '1059681615418236948' — the
//     ONLY user_id in the table. All 25 rows are status='pending', action='fade',
//     risk_amount=1.0 (the schema default). This is a synthetic/admin identity,
//     not a real bettor: there is NO live P/L riding on it. (A real bettor would
//     need a proper settlement ledger; that is out of scope — see RELAXED GATE.)
//   • user_bets schema (PRAGMA-verified): id INTEGER PK, user_id TEXT, bet_id
//     TEXT, action TEXT, status TEXT DEFAULT 'pending', created_at TEXT,
//     risk_amount REAL DEFAULT 1.0. NO stake / settlement-ledger column.
//
// THE OPERATOR RUNS THIS — never an agent, never CI. Upload to the Fly container
// and run there per docs/RUNBOOKS/db-interventions.md.
//
// Usage (in-container):
//   node apply-tierb-tailed-corrections.js            # DRY RUN (db opened readonly)
//   node apply-tierb-tailed-corrections.js --apply    # writes, ONE transaction
//
// Env: APP_ROOT (default /app), DB_PATH (default /data/bettracker.db).
// Self-contained for sftp upload: requires better-sqlite3 and
// services/gradeOverride.js from APP_ROOT only; no other app module loads.
//
// ── Write scope: bets + bet_grade_history + user_bets ONLY. ──
// This WIDENS #172's bets-only scope by exactly the user_bets settlement UPDATE
// (status only). No pipeline_events, no Discord, no network, no bankrolls /
// daily_snapshots / parlay_legs / user_bets.risk_amount writes. user_bets carries
// NO settlement ledger (no stake column, and payoutTailers only ever moves
// users.bankroll, and only for action='tail'), so settling a fade tail is a
// terminal status stamp, nothing more.
//
// ── Reuse of services/gradeOverride.js (re-audited 2026-07-03, UNCHANGED since
//    #168/#172) ──
//   applyGradeOverride still archives to bet_grade_history BEFORE the bets
//   UPDATE, is pure + dependency-injected (no Discord client, no module-level db,
//   no import-time side effects), reconciles bankrolls + parlay legs but NOT
//   user_bets — so --apply REUSES its archive→update core verbatim and this
//   script adds the user_bets settlement itself. Two deps are neutered exactly as
//   in #172 to hold the write scope:
//     • getBankroll → () => null. Bankroll reconciliation is OUT OF SCOPE — these
//       are pre-gate (Beta-era) bets and bankrolls were season-reset to a fresh
//       S2 slate (docs/SEASON-RESET.md); shifting `current` by a prior-era delta
//       would corrupt the live slate. updateBankroll / saveDailySnapshot are
//       throwing stubs (unreachable while getBankroll returns null), so any future
//       widening of applyGradeOverride's bankroll scope aborts the run.
//     • calcProfit — inline mirror of services/grading.js calcProfit()
//       (grading.js is not require-safe standalone). Asserted per row against the
//       embedded new_pu (±PU_TOLERANCE) before any write.
//
// ── Settled-status vocabulary decision ──
//   Grep confirms user_bets.status is NEVER written to a terminal value anywhere
//   in the codebase, and is NEVER read (`!mystats` derives a tailing record from
//   the joined bets.result, not ub.status; payoutTailers ignores status). There
//   is therefore no existing settled-status vocabulary to match, so this script
//   uses 'won' / 'lost' (see settleTailStatus). Settling status here is
//   forward-looking bookkeeping — nothing consumes it today — but it is the
//   correct terminal state and it is what unblocks the tail HARD GATE. The
//   permanent fix (a real settlement path, or marking the table test-only) is a
//   backlog item (docs/BACKLOG.md).
//
// ── Fade inversion ──
//   A FADE is a bet AGAINST the pick: the fader WINS when the bet LOSES and LOSES
//   when the bet WINS (a TAIL mirrors the bet instead). All 3 tails here are
//   action='fade', so:
//     d7bf7159 bet loss→WIN  ⇒ fade LOSES  ⇒ user_bets.status='lost'
//     b5bb1ad7 bet win →LOSS ⇒ fade WINS   ⇒ user_bets.status='won'
//     f4946029 bet win →LOSS ⇒ fade WINS   ⇒ user_bets.status='won'
//   settleTailStatus() derives this from the row's own `action`, so a stray
//   action='tail' (none exist today) would still settle correctly, not wrongly.
//
// Row gates (evaluated identically in both modes; per-row, run continues):
//   skip   : id not found · stored result != expect_stored_result (already
//            corrected / drifted) · grader_version NOT NULL (post-gate write —
//            re-run inert) · a tail row already in a settled status (settle only)
//   refuse : bet_type != straight (legs out of scope) · mirrored calcProfit
//            differs from the embedded new_pu by > PU_TOLERANCE (odds/units
//            drifted vs the audit) · RELAXED GATE — any tail on the bet has a
//            user_id other than the synthetic one (a real bettor needs a ledger)
//   fatal  : an id prefix matches more than one bets row (table unsafe — abort
//            before any write)
//
// Idempotent: a second --apply run skips every bet (grader_version is now stamped
// 'manual-v1' and the stored result no longer equals expect_stored_result), and
// the settle UPDATE is guarded on status NOT IN ('won','lost'), so no tail is
// double-settled even if a bet were somehow re-reached.
//
// Arithmetic (embedded, cross-checked in the DB-free test):
//   Per row, ΔPU = new_pu − expect_stored_pu (the running-total impact, the same
//   convention #172 and the audit's ΔPU column use):
//     d7bf7159 +1.9091 · b5bb1ad7 −1.9091 · f4946029 −1.9091  = −1.9091u ΔPU
//   The 3 corrected bets then CARRY new profit_units summing to
//     +0.9091 − 1.00 − 1.00 = −1.0909u  (this is the "−1.09u" figure; it is the
//     post-flip profit_units total of the 3 rows, NOT the running-total delta).
//   Combined pinned-set running-total impact once #172 + this both run:
//     320bc36b −5.7273 (#172) + (−1.9091) (this) = −7.6364u ≈ −7.64u
//   i.e. the FULL pre-tail estimate — the tail gate deferred these 3 rows to this
//   follow-up, it did not drop any correction.
// ═══════════════════════════════════════════════════════════

'use strict';

const APP_ROOT = process.env.APP_ROOT || '/app';
const DB_PATH = process.env.DB_PATH || '/data/bettracker.db';

const ARCHIVED_BY = 'tierb-tailed-2026-07-03';
const PU_TOLERANCE = 0.02;
const VALID_RESULTS = ['win', 'loss', 'push', 'void'];

// The one synthetic/admin identity the RELAXED GATE allows a tail for. Any other
// user_id on these bets refuses the row (a real bettor requires a proper ledger).
const SYNTHETIC_USER_ID = '1059681615418236948';
// Terminal user_bets.status values this script writes / treats as already-settled.
const SETTLED_STATUSES = ['won', 'lost'];

// ── Correction table ────────────────────────────────────────
// The 3 tail-gated PINNED rows of docs/audits/2026-07-03-pregate-tierb-reanchor.md
// (§Corrections applied) — i.e. #172's 4 pinned rows MINUS the 0-tail 320bc36b it
// already applied. Reasons + evidence_urls are copied verbatim from #172 so the
// bet_grade_history provenance is byte-identical to what a non-tailed apply would
// have written. id = the 8-char prefix as it appears in the audit; resolved to a
// full bets id at runtime via LIKE with a fatal-abort on ambiguity (see resolve()
// — the audit records only the 8-char prefix, and DB access is operator-only, so
// full-id resolution necessarily happens in-container, exactly as in #172).
// new_pu is derived from the stored American odds; odds are empty on the export so
// the −110 default applies (win pu = 0.9091×units, loss pu = −units). Every pu was
// externally verified against ESPN + b-ref on 2026-07-03 before this was written.
const CORRECTIONS = [
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
// applyGradeOverride (grading.js itself is not require-safe standalone) and used
// for the per-row cross-check against the embedded new_pu.
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

// ── Fade / tail settlement (pure, DB-free, unit-tested) ─────
// A FADE is inverse to the bet; a TAIL mirrors it. Only win/loss settle here (the
// correction table admits only win/loss flips). Anything else throws — a loud
// refusal beats writing a guessed status.
function settleTailStatus(action, betResult) {
  const betWon = betResult === 'win';
  const betLost = betResult === 'loss';
  if (!betWon && !betLost) throw new Error(`settleTailStatus: unsupported bet result '${betResult}' (only win/loss settle)`);
  if (action === 'fade') return betLost ? 'won' : 'lost';
  if (action === 'tail') return betWon ? 'won' : 'lost';
  throw new Error(`settleTailStatus: unknown action '${action}'`);
}

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
  calcProfit, round2, validateCorrectionTable, settleTailStatus,
  ARCHIVED_BY, PU_TOLERANCE, SYNTHETIC_USER_ID, SETTLED_STATUSES,
};

// ═════════════════════════ runtime ══════════════════════════
if (require.main === module) main();

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const unknown = argv.filter(a => a !== '--apply');
  if (unknown.length) {
    console.error(`unknown arg(s): ${unknown.join(' ')}\nUsage: node apply-tierb-tailed-corrections.js [--apply]`);
    process.exit(2);
  }

  const dirTotals = validateCorrectionTable(CORRECTIONS);

  // Preflight both requires in BOTH modes so a dry run surfaces a missing module
  // before the operator reaches --apply.
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

  console.log(`apply-tierb-tailed-corrections — ${apply ? 'APPLY' : 'DRY RUN (readonly)'}`);
  console.log(`  db: ${DB_PATH}   app: ${APP_ROOT}   rows: ${CORRECTIONS.length} tail-gated pinned corrections`);
  console.log(`  relaxed tail gate: allow user_id=${SYNTHETIC_USER_ID} only\n`);

  const findByPrefix = db.prepare(`
    SELECT id, description, bet_type, sport, odds, units, result, profit_units,
           grade, grade_reason, graded_at, grader_version
    FROM bets WHERE id LIKE ?
  `);
  const tailRowsFor = db.prepare('SELECT id, user_id, action, status FROM user_bets WHERE bet_id = ?');

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
    if (bet.grader_version != null) return { row, bet, status: 'skip', why: `grader_version=${bet.grader_version} (already corrected / not a pre-gate row)` };
    if (bet.result !== row.expect_stored_result) return { row, bet, status: 'skip', why: `stored result '${bet.result}' != expected '${row.expect_stored_result}' (already corrected?)` };

    const refusals = [];
    const warns = [];
    if (bet.bet_type !== 'straight') refusals.push(`bet_type='${bet.bet_type}' (pinned rows are straights; legs out of scope)`);
    const writeValue = calcProfit(bet.odds || -110, bet.units || 1, row.new_result);
    if (Math.abs(round2(writeValue) - row.new_pu) > PU_TOLERANCE) {
      refusals.push(`pu mismatch: calcProfit(odds=${bet.odds}, units=${bet.units}) = ${round2(writeValue)} vs table new_pu ${row.new_pu} (odds/units drifted vs audit?)`);
    }

    // Tails. RELAXED GATE: any tail on a non-synthetic user_id refuses the row
    // (a real bettor needs a proper settlement ledger — out of scope). Synthetic
    // tails already in a settled status are left alone (idempotent); the rest are
    // settled by the fade/tail inversion.
    const tailRows = tailRowsFor.all(bet.id);
    const foreignTails = tailRows.filter(t => t.user_id !== SYNTHETIC_USER_ID);
    if (foreignTails.length) {
      const ids = [...new Set(foreignTails.map(t => t.user_id))].join(', ');
      refusals.push(`RELAXED GATE: ${foreignTails.length} tail(s) on non-synthetic user_id(s) [${ids}] — a real bettor needs a settlement ledger (out of scope)`);
    }
    const synthTails = tailRows.filter(t => t.user_id === SYNTHETIC_USER_ID);
    const alreadySettled = synthTails.filter(t => SETTLED_STATUSES.includes(t.status));
    const settleTails = synthTails
      .filter(t => !SETTLED_STATUSES.includes(t.status))
      .map(t => ({ id: t.id, action: t.action, from: t.status, to: settleTailStatus(t.action, row.new_result) }));

    const storedPu = bet.profit_units == null ? null : parseFloat(bet.profit_units);
    if (storedPu != null && Math.abs(storedPu - row.expect_stored_pu) > 0.005) {
      warns.push(`stored pu ${storedPu} != audit's ${row.expect_stored_pu} (informational)`);
    }
    for (const t of alreadySettled) warns.push(`tail ${t.id} already settled '${t.status}' — leaving as-is (idempotent)`);

    return {
      row, bet, writeValue, storedPu, warns, refusals,
      tailRows, settleTails, alreadySettled,
      status: refusals.length ? 'refuse' : 'ok',
    };
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
    console.log(`        tails:  ${p.tailRows.length} total (${p.settleTails.length} to settle, ${p.alreadySettled.length} already settled)`);
    for (const t of p.settleTails) console.log(`          settle ub#${t.id} ${t.action} '${t.from}'→'${t.to}' (bet ${p.row.new_result} ⇒ ${t.action} ${t.to})`);
    console.log(`        ev:     ${p.row.evidence_url}`);
    for (const w of p.warns) console.log(`        WARN:   ${w}`);
    for (const r of p.refusals) console.log(`        REFUSE: ${r}`);
  }

  const ok = plans.filter(p => p.status === 'ok');
  const refused = plans.filter(p => p.status === 'refuse');
  const skipped = plans.filter(p => p.status === 'skip');
  // ΔPU = Σ(new − stored) — the running-total impact (#172 / audit convention).
  const netDelta = ok.reduce((s, p) => s + (p.writeValue - (p.storedPu || 0)), 0);
  // Σ(new_pu) — what the corrected rows now CARRY (the audit doc's "−1.09u").
  const sumNewPu = ok.reduce((s, p) => s + p.writeValue, 0);
  const settleTotal = ok.reduce((s, p) => s + p.settleTails.length, 0);
  const tailsTotal = plans.reduce((s, p) => s + (p.tailRows ? p.tailRows.length : 0), 0);
  const dirOk = { lossToWin: 0, winToLoss: 0, winToVoid: 0 };
  for (const p of ok) {
    if (p.row.new_result === 'win') dirOk.lossToWin++;
    else if (p.row.new_result === 'loss') dirOk.winToLoss++;
    else dirOk.winToVoid++;
  }

  console.log('\ntotals:');
  console.log(`  table:      loss→win ${dirTotals.lossToWin}, win→loss ${dirTotals.winToLoss}, win→void ${dirTotals.winToVoid}`);
  console.log(`  actionable: loss→win ${dirOk.lossToWin}, win→loss ${dirOk.winToLoss}, win→void ${dirOk.winToVoid}  (skipped ${skipped.length}, refused ${refused.length})`);
  console.log(`  net profit_units ΔPU (actionable, vs stored): ${round2(netDelta) >= 0 ? '+' : ''}${round2(netDelta)}u  (expects -1.91u)`);
  console.log(`  Σ new profit_units the 3 rows now carry:      ${round2(sumNewPu) >= 0 ? '+' : ''}${round2(sumNewPu)}u  (the audit's "-1.09u")`);
  console.log(`  tails to settle (fade inversion): ${settleTotal}   (user_bets tails across evaluated rows: ${tailsTotal})`);
  console.log(`  combined pinned impact once #172 + this run: -5.73u + ${round2(netDelta)}u = ${round2(-5.7273 + netDelta)}u (pre-tail estimate -7.64u)`);

  if (refused.length) {
    console.log('\nREFUSED rows (manual decision required, NOT applied):');
    for (const p of refused) console.log(`  ${p.row.id} — ${p.refusals.join(' | ')}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return;
  }

  // ── Apply (ONE transaction for everything: flips + archives + tail settles) ──
  // better-sqlite3 nests transactions as savepoints, so applyGradeOverride's own
  // db.transaction runs inside this outer one; a throw anywhere rolls back the
  // WHOLE run — no partial flip-without-settle can commit.
  const deps = {
    db,
    getBankroll: () => null, // bankroll reconciliation out of scope — see header
    updateBankroll: () => { throw new Error('write-scope violation: updateBankroll called'); },
    saveDailySnapshot: () => { throw new Error('write-scope violation: saveDailySnapshot called'); },
    calcProfit,
  };
  const settleStmt = db.prepare(
    `UPDATE user_bets SET status = ? WHERE id = ? AND user_id = ? AND status NOT IN ('won','lost')`
  );

  const runAll = db.transaction(() => {
    let flips = 0, settled = 0;
    for (const p of ok) {
      const res = applyGradeOverride(deps, {
        betId: p.bet.id,
        result: p.row.new_result,
        reason: `${p.row.reason} — ${p.row.evidence_url}`,
        invokerId: ARCHIVED_BY,
      });
      if (!res.ok) throw new Error(`applyGradeOverride failed on ${p.row.id}: ${res.error}`);
      // Belt-and-braces: neutered deps + straight-only gate make these unreachable;
      // a hit means the bets/bankroll/legs write scope was violated — roll back all.
      if (res.bankrollApplied || res.legsTouched) throw new Error(`write-scope violation on ${p.row.id}: bankrollApplied=${res.bankrollApplied} legsTouched=${res.legsTouched}`);
      if (Math.abs(res.newProfit - p.writeValue) > 1e-9) throw new Error(`profit drift on ${p.row.id}: wrote ${res.newProfit}, planned ${p.writeValue}`);
      flips++;

      // Settle the synthetic fade tails for this bet (status only; idempotent).
      for (const t of p.settleTails) {
        const info = settleStmt.run(t.to, t.id, SYNTHETIC_USER_ID);
        if (info.changes !== 1) throw new Error(`tail settle drift on ${p.row.id}: ub#${t.id} changed ${info.changes} rows (already settled / gone?) — rolling back`);
        settled++;
      }
    }
    return { flips, settled };
  });

  try {
    const { flips, settled } = runAll();
    console.log(`\nAPPLIED: ${flips} bets corrected (archive+update) + ${settled} fade tail(s) settled — one transaction, committed.`);
  } catch (err) {
    console.error(`\nAPPLY FAILED — transaction rolled back, nothing written: ${err.message}`);
    db.close();
    process.exit(2);
  }
  db.close();
}
