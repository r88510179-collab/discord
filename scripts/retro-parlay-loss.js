// ═══════════════════════════════════════════════════════════
// scripts/retro-parlay-loss.js
//
// One-shot retro-fix (Bug A, Part 2). Re-grades exactly TWO parlay
// bets that were incorrectly VOIDed by retry-cap exhaustion despite
// having a verified LOSS leg. The forward fix shipped in Part 1
// (gradeParlay trusted-LOSS short-circuit, commit a42f805).
//
// Targets ONLY these two bet IDs — no other bet is ever touched:
//   7786c5e810cb5040e2edec2a870d184b
//   27f848584eb1a43cc8d2ef4793972cef
//
// Per-bet safety gates — ALL must pass or the bet is SKIPPED, unmodified:
//   1. bets.result is currently 'void'
//   2. >=1 leg in grading_audit has final_status='LOSS' on its most
//      recent attempt (max attempt_num for that <id>-legN bet_id)
//   3. leg-explosion guard: parlay_legs count AND grading_audit distinct
//      leg count are both within bullet_count + 1 (bullet_count===0 →
//      fallback <=20). Mirrors the Part 1 aggregateParlayLegResults
//      guard, extended to audit_legs per the Part 2 spec.
//   4. isTrustedLossLeg() — the REAL deployed function from
//      services/grading.js — returns true for the LOSS leg's evidence.
//
// With --commit, updates ONLY: result, profit_units, grade_reason,
// graded_at. The `grade` letter-grade column is left untouched. Does
// NOT touch capper_stats, parlay_legs, Discord embeds, or any other bet.
//
// Usage (default is DRY RUN — prints everything, writes nothing):
//   node scripts/retro-parlay-loss.js                 # dry run
//   node scripts/retro-parlay-loss.js --commit        # apply
//   node scripts/retro-parlay-loss.js --db /path.db   # local testing
//   fly ssh console -a bettracker-discord-bot -C "node /app/scripts/retro-parlay-loss.js"
//   fly ssh console -a bettracker-discord-bot -C "node /app/scripts/retro-parlay-loss.js --commit"
//
// NOTE: requires services/grading.js for isTrustedLossLeg — that load
// pulls in services/database.js (WAL mode; the migration check it runs
// at load is idempotent against an already-migrated DB).
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TARGET_IDS = [
  '7786c5e810cb5040e2edec2a870d184b',
  '27f848584eb1a43cc8d2ef4793972cef',
];

function parseArgs(argv) {
  const args = { dryRun: true, dbPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--db') args.dbPath = argv[++i];
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return args;
}

function resolveDbPath(explicit) {
  if (explicit) return explicit;
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (fs.existsSync('/data/bettracker.db')) return '/data/bettracker.db';
  return path.join(__dirname, '..', 'bettracker.db');
}

// Mirrors the Part 1 aggregateParlayLegResults leg-explosion guard.
function saneCount(n, bulletCount) {
  return bulletCount === 0 ? n <= 20 : n <= bulletCount + 1;
}

// Trim to <= max chars without cutting mid-word: normalize whitespace,
// slice, fall back to the last space, strip trailing punctuation/space.
function trimToWordBoundary(s, max) {
  const norm = (s || '').replace(/\s+/g, ' ').trim();
  if (norm.length <= max) return norm;
  const slice = norm.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:—-]+$/, '');
}

function main() {
  const args = parseArgs(process.argv);

  // database.js reads DB_PATH at require-time — set it before requiring.
  const dbPath = resolveDbPath(args.dbPath);
  process.env.DB_PATH = dbPath;

  const { db } = require('../services/database');
  const { isTrustedLossLeg } = require('../services/grading')._internal;

  const today = new Date().toISOString().slice(0, 10);
  const mode = args.dryRun ? 'DRY RUN (no writes)' : 'COMMIT (writing changes)';

  console.log('═══════════════════════════════════════════════════════');
  console.log(`retro-parlay-loss.js — ${mode}`);
  console.log(`DB:      ${dbPath}`);
  console.log(`Date:    ${today}`);
  console.log(`Targets: ${TARGET_IDS.length} bet(s)`);
  console.log('═══════════════════════════════════════════════════════');

  const plan = [];    // bets that passed every gate
  const skipped = []; // bets that failed a gate (left unmodified)

  for (const id of TARGET_IDS) {
    console.log(`\n────────── ${id} ──────────`);

    const bet = db.prepare(
      'SELECT id, bet_type, sport, units, odds, result, profit_units, grade, grade_reason, graded_at, description '
      + 'FROM bets WHERE id = ?'
    ).get(id);

    if (!bet) {
      console.log('  SKIP — bet not found in DB.');
      skipped.push({ id, reason: 'not found in DB' });
      continue;
    }

    console.log(`  bet_type=${bet.bet_type}  sport=${bet.sport}  units=${bet.units}  odds=${bet.odds}`);
    console.log(`  description:  ${(bet.description || '').replace(/\n/g, ' ').slice(0, 120)}`);
    console.log(`  CURRENT:      result=${bet.result}  grade=${bet.grade}  profit_units=${bet.profit_units}  graded_at=${bet.graded_at}`);
    console.log(`  CURRENT grade_reason: ${(bet.grade_reason || '').slice(0, 160)}`);
    if (!(bet.units > 0)) {
      console.log('  WARN — units is not a positive number; verify the computed profit_units below.');
    }

    // ── Gate 1: must currently be 'void' ──
    if (bet.result !== 'void') {
      console.log(`  SKIP — Gate 1 failed: result is '${bet.result}', expected 'void'. Not modifying.`);
      skipped.push({ id, reason: `result='${bet.result}' (expected 'void')` });
      continue;
    }
    console.log('  Gate 1 OK — result is currently void.');

    // ── Leg data ──
    const legs = db.prepare(
      'SELECT id, description, result, sport, evidence FROM parlay_legs WHERE bet_id = ? ORDER BY created_at'
    ).all(id);
    const bulletCount = (bet.description?.match(/•/g) || []).length;
    const auditLegs = db.prepare(
      'SELECT COUNT(DISTINCT bet_id) c FROM grading_audit WHERE bet_id LIKE ?'
    ).get(`${id}-leg%`).c;
    console.log(`  parlay_legs=${legs.length}  bullet_count=${bulletCount}  audit_legs=${auditLegs}`);

    // ── Gate 3: leg-explosion guard (parlay_legs AND audit_legs) ──
    const legCountSane = saneCount(legs.length, bulletCount);
    const auditLegsSane = saneCount(auditLegs, bulletCount);
    if (!legCountSane || !auditLegsSane) {
      console.log(`  SKIP — Gate 3 failed: leg-explosion guard tripped `
        + `(legCountSane=${legCountSane}, auditLegsSane=${auditLegsSane}). Manual review required. Not modifying.`);
      skipped.push({ id, reason: `leg-explosion: legs=${legs.length}, audit=${auditLegs}, bullets=${bulletCount}` });
      continue;
    }
    console.log(`  Gate 3 OK — leg-explosion guard passed (legCountSane=${legCountSane}, auditLegsSane=${auditLegsSane}).`);

    // ── Gate 2: find LOSS leg(s) — most-recent attempt per leg ──
    const auditLegIds = db.prepare(
      'SELECT DISTINCT bet_id FROM grading_audit WHERE bet_id LIKE ? ORDER BY bet_id'
    ).all(`${id}-leg%`).map(r => r.bet_id);

    const lossLegs = [];
    for (const legBetId of auditLegIds) {
      const latest = db.prepare(
        'SELECT bet_id, attempt_num, final_status, final_evidence FROM grading_audit '
        + 'WHERE bet_id = ? ORDER BY attempt_num DESC LIMIT 1'
      ).get(legBetId);
      if (latest && latest.final_status === 'LOSS') {
        const m = legBetId.match(/-leg(\d+)$/);
        lossLegs.push({
          legBetId,
          legNum: m ? parseInt(m[1], 10) : null,
          attempt: latest.attempt_num,
          evidence: latest.final_evidence || '',
        });
      }
    }

    if (lossLegs.length === 0) {
      console.log('  SKIP — Gate 2 failed: no leg has final_status=LOSS on its most-recent attempt. Not modifying.');
      skipped.push({ id, reason: 'no LOSS leg on most-recent attempt' });
      continue;
    }
    lossLegs.sort((a, b) => (a.legNum || 0) - (b.legNum || 0));
    console.log(`  Gate 2 OK — LOSS leg(s): ${lossLegs.map(l => `leg${l.legNum} (attempt ${l.attempt})`).join(', ')}`);

    // The lowest-numbered LOSS leg anchors the grade_reason.
    const lossLeg = lossLegs[0];
    const legRow = (lossLeg.legNum && legs[lossLeg.legNum - 1]) ? legs[lossLeg.legNum - 1] : null;

    // ── Gate 4: trust check on the LOSS leg's evidence (real deployed fn) ──
    const trusted = isTrustedLossLeg(
      { description: legRow ? legRow.description : '' },
      lossLeg.evidence,
      bet.sport,
    );
    console.log(`  Gate 4 — isTrustedLossLeg() on leg ${lossLeg.legNum}:`);
    console.log(`    leg desc:  ${legRow ? (legRow.description || '').slice(0, 100) : '(no matching parlay_legs row)'}`);
    console.log(`    evidence:  ${(lossLeg.evidence || '').replace(/\n/g, ' ').slice(0, 160)}`);
    console.log(`    RESULT:    ${trusted ? 'TRUSTED ✓' : 'NOT TRUSTED ✗'}`);

    if (!trusted) {
      console.log('  SKIP — Gate 4 failed: LOSS leg evidence did NOT pass isTrustedLossLeg(). Not modifying.');
      console.log('         Diagnostic: trust check rejected this evidence. Do NOT auto-loosen the check —');
      console.log('         report this and investigate whether the check is too aggressive.');
      skipped.push({ id, reason: `trust check failed on leg${lossLeg.legNum}` });
      continue;
    }

    // ── All gates passed — compute the change ──
    const newProfitUnits = -bet.units;
    const evidenceSnippet = trimToWordBoundary(lossLeg.evidence, 80);
    const newGradeReason =
      `LOSS [retro-fix ${today}]: leg ${lossLeg.legNum} lost — ${evidenceSnippet}. `
      + 'Previously voided by retry cap exhaustion.';

    const prior = {
      result: bet.result,
      grade: bet.grade,
      profit_units: bet.profit_units,
      grade_reason: bet.grade_reason,
      graded_at: bet.graded_at,
    };
    const next = {
      result: 'loss',
      profit_units: newProfitUnits,
      grade_reason: newGradeReason,
      graded_at: "datetime('now')",
    };

    console.log('  ✓ ALL GATES PASSED — change to apply:');
    console.log(`      result:       ${prior.result}  →  ${next.result}`);
    console.log(`      profit_units: ${prior.profit_units}  →  ${next.profit_units}`);
    console.log(`      graded_at:    ${prior.graded_at}  →  datetime('now')`);
    console.log(`      grade:        ${prior.grade}  (UNCHANGED — letter grade left alone per spec)`);
    console.log(`      grade_reason: ${next.grade_reason}`);

    plan.push({ id, prior, next });
  }

  // ── Apply (only with --commit) ──
  if (!args.dryRun && plan.length > 0) {
    console.log('\n═══ COMMITTING ═══');
    // grading_state='done': terminal-state invariant — a terminal result write
    // must land with a terminal grading_state (also heals drift on the row).
    const stmt = db.prepare(
      "UPDATE bets SET result = 'loss', profit_units = ?, grade_reason = ?, graded_at = datetime('now'), "
      + "grading_state = 'done', grading_lock_until = NULL "
      + "WHERE id = ? AND result = 'void'"
    );
    const tx = db.transaction((items) => {
      for (const item of items) {
        const info = stmt.run(item.next.profit_units, item.next.grade_reason, item.id);
        item.changes = info.changes;
      }
    });
    tx(plan);
    for (const item of plan) {
      console.log(`  ${item.id}: ${item.changes === 1
        ? 'UPDATED'
        : `NO-OP (changes=${item.changes} — result was no longer 'void')`}`);
    }

    console.log('\n═══ POST-COMMIT STATE (result, grade, profit_units, grade_reason) ═══');
    for (const item of plan) {
      const after = db.prepare(
        'SELECT id, result, grade, profit_units, grade_reason FROM bets WHERE id = ?'
      ).get(item.id);
      console.log(`  ${JSON.stringify(after)}`);
    }
  }

  // ── Final summary ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`SUMMARY — ${mode}`);
  console.log(`  Passed all gates: ${plan.length}`);
  for (const item of plan) {
    console.log(`    ${item.id}`);
    console.log(`      result        ${item.prior.result} → ${item.next.result}`);
    console.log(`      profit_units  ${item.prior.profit_units} → ${item.next.profit_units}`);
    console.log(`      grade_reason  → ${item.next.grade_reason}`);
  }
  console.log(`  Skipped (gate failed, unmodified): ${skipped.length}`);
  for (const s of skipped) {
    console.log(`    ${s.id} — ${s.reason}`);
  }
  console.log(args.dryRun
    ? '\n  DRY RUN — nothing was written. Re-run with --commit to apply.'
    : '\n  COMMIT complete.');
  console.log('═══════════════════════════════════════════════════════');

  db.close();
}

main();
