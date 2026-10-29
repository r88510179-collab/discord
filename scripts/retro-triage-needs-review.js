#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// retro-triage-needs-review.js — controlled release of the pending
// needs_review backlog (OPERATOR-run, in-container). DEFAULT IS DRY-RUN;
// nothing is written without --apply.
//
// Why (BACKLOG 2026-08): ~3,327 bets sit result='pending',
// review_status='needs_review' — invisible to the grader (both selectors
// exclude GRADER_HIDDEN_REVIEW_STATUSES). Bulk-confirming them all at once
// would hand the 7-day sweeper anything older than its window the moment the
// approval grace expires, and would spike LLM spend in one tick. This script
// releases them in operator-paced batches through the EXISTING atomic
// approveBet() gate (services/database.js — confirm + clean-slate grading
// reset + 3-day sweep_exempt_until in ONE gated UPDATE), so the deterministic
// adapters get first shot and the normal backoff / retry-cap / sweeper
// semantics decide the rest. A separate opt-in flag (--void-season) voids a
// season's evidence-free leftovers with a breadcrumb, sweeper-style.
//
// Modes:
//   (no flags)              dry-run report. DB opened {readonly, fileMustExist}.
//   --apply --batch N --since YYYY-MM-DD [--until YYYY-MM-DD]
//                           approve the N NEWEST in-range backlog bets via
//                           approveBet(), ONE transaction. Defaults:
//                           --batch 200 --since 2026-08-01 --until now.
//   --apply --void-season X void season X's backlog rows (sweeper column set,
//                           'retro-triage-v1' + breadcrumb), ONE IMMEDIATE
//                           transaction per bet, archive row first. Tailed
//                           bets (user_bets) are HARD-SKIPPED — judged again
//                           INSIDE each bet's transaction and by a NOT EXISTS
//                           guard on the UPDATE itself, so a tail accepted
//                           after selection is still skipped; a refused void
//                           rolls its archive row back. Opt-in, separate from
//                           --batch: combining them in one --apply run is
//                           refused.
//
// Safety rails (reconcile-needs-review.js mold):
//   • dry-run by default; --apply is the only write gate; --apply --dry-run
//     conflict → exit 2 (STICKY sentinel). Dry-run opens the DB READONLY.
//   • --apply requires services/database (relative, then $APP_ROOT fallback)
//     AFTER pinning process.env.DB_PATH, so approveBet, recordStage, and the
//     batch transaction all share ONE connection; the DB file is validated
//     {readonly, fileMustExist} BEFORE that require (database.js would
//     otherwise CREATE an empty DB on a typo'd path).
//   • every write statement repeats the full gate in its WHERE clause;
//     info.changes is printed per write.
//   • --batch positive int, --since/--until real ISO dates; bad input exit 2.
//   • no secrets printed, no Discord client required, no Discord posts.
//   • exitCode + natural exit after large prints (64KB pipe-truncation trap).
//
// Usage (in-container, operator — PREFLIGHT Rule 4):
//   fly ssh console -a bettracker-discord-bot -C \
//     "sh -c 'cd /app && node scripts/retro-triage-needs-review.js'"
//   fly ssh console -a bettracker-discord-bot -C \
//     "sh -c 'cd /app && node scripts/retro-triage-needs-review.js --apply --batch 300 --since 2026-08-01'"
//   fly ssh console -a bettracker-discord-bot -C \
//     "sh -c 'cd /app && node scripts/retro-triage-needs-review.js --apply --void-season Beta'"
// ═══════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/data/bettracker.db';
const APP_ROOT = process.env.APP_ROOT || '/app';

const DEFAULT_BATCH = 200;
const DEFAULT_SINCE = '2026-08-01';

const GRADER_VERSION = 'retro-triage-v1';
const ARCHIVED_BY = 'retro-triage-needs-review';
const SCRIPT_NAME = 'retro-triage-needs-review';

// The backlog population — repeated VERBATIM in every write's WHERE clause.
const PENDING_NR_WHERE = "result = 'pending' AND review_status = 'needs_review'";

// The EXACT column set the 7-day sweeper writes for a void (sweepExpiredBet →
// gradeBetRecord, services/grading.js + services/database.js): result,
// profit_units, grade, grade_reason, graded_at, grading_state='done',
// grading_lock_until=NULL, grader_version. evidence_hash is COALESCE-kept
// there, so it is left untouched here; review_status stays as is (deliberate
// — this population was parked for a human, and the void IS that decision's
// paper trail). Distinguishable from a swept void only by grader_version and
// the grade_reason breadcrumb. The WHERE clause repeats the full gate AND the
// tailed hard-skip (NOT EXISTS user_bets) so both are judged at WRITE time —
// a tail/fade accepted after selection can never be voided out from under the
// community ledger (PR #211 review).
const VOID_UPDATE_SQL = `UPDATE bets SET
  result = 'void',
  profit_units = 0,
  grade = 'VOID',
  grade_reason = ?,
  graded_at = datetime('now'),
  grading_state = 'done',
  grading_lock_until = NULL,
  grader_version = '${GRADER_VERSION}'
  WHERE id = ? AND result = 'pending' AND review_status = 'needs_review' AND season = ?
    AND NOT EXISTS (SELECT 1 FROM user_bets ub WHERE ub.bet_id = bets.id)`;

// Every bets column this script reads or writes — preflighted via PRAGMA
// (PREFLIGHT Rule 1: never assume columns).
const REQUIRED_BETS_COLS = [
  'id', 'result', 'review_status', 'created_at', 'season', 'sport', 'source',
  'capper_id', 'source_message_id', 'source_tweet_id',
  'profit_units', 'grade', 'grade_reason', 'graded_at',
  'grading_state', 'grading_lock_until', 'grader_version', 'sweep_exempt_until',
];

// ── Pure helpers (exported for unit tests) ──────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Round-trip: rejects 2026-02-30 etc.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Exclusive upper bound for an inclusive --until date: the next calendar day,
// compared lexicographically against the TEXT created_at column.
function nextDayYmd(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {
    mode: null, batch: null, since: null, until: null, voidSeason: null,
    batchExplicit: false, rangeExplicit: false,
  };
  // 'conflict' is STICKY (reconcile-needs-review.js mold): once both modes
  // have been seen, no later repeat of either flag may un-conflict the parse.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = (out.mode === 'dry-run' || out.mode === 'conflict') ? 'conflict' : 'apply';
    else if (a === '--dry-run') out.mode = (out.mode === 'apply' || out.mode === 'conflict') ? 'conflict' : 'dry-run';
    else if (a === '--batch') {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { error: '--batch requires a value' };
      if (!/^\d+$/.test(v) || parseInt(v, 10) < 1) return { error: `--batch must be a positive integer, got '${v}'` };
      out.batch = parseInt(v, 10);
      out.batchExplicit = true;
    } else if (a === '--since' || a === '--until') {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { error: `${a} requires a value` };
      if (!isValidYmd(v)) return { error: `${a} must be a real YYYY-MM-DD date, got '${v}'` };
      out[a.slice(2)] = v;
      out.rangeExplicit = true;
    } else if (a === '--void-season') {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { error: '--void-season requires a season value' };
      out.voidSeason = v;
    } else return { error: `unknown arg: ${a}` };
  }
  if (out.mode === 'conflict') return { error: '--dry-run and --apply are mutually exclusive' };
  if (out.mode == null) out.mode = 'dry-run'; // DRY RUN is the default
  // One intervention per --apply invocation: the void routine is opt-in and
  // SEPARATE from the batch release. (Dry-run previews both side by side.)
  if (out.mode === 'apply' && out.voidSeason != null && (out.batchExplicit || out.rangeExplicit)) {
    return { error: '--void-season is a separate intervention: do not combine it with --batch/--since/--until under --apply' };
  }
  if (out.batch == null) out.batch = DEFAULT_BATCH;
  if (out.since == null) out.since = DEFAULT_SINCE;
  // out.until stays null = "now" (no upper bound beyond datetime('now')).
  // Validated AFTER defaults so `--until <before the default since>` is
  // caught instead of silently selecting an empty range.
  if (out.until != null && out.until < out.since) {
    return { error: `--until ${out.until} precedes --since ${out.since}` };
  }
  return out;
}

function ageBucket(createdAt, nowMs = Date.now()) {
  if (!createdAt || typeof createdAt !== 'string') return 'unknown';
  const t = new Date(createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const days = (nowMs - t) / 86400000;
  if (days < 1) return '<1d';
  if (days < 7) return '1-7d';
  if (days < 30) return '7-30d';
  return '>30d';
}

function buildVoidReason(season, today) {
  return `[retro-triage ${today}] ${season} needs_review backlog voided, evidence-free (sweeper semantics)`;
}

function missingColumns(pragmaNames, required = REQUIRED_BETS_COLS) {
  const have = new Set(pragmaNames);
  return required.filter(c => !have.has(c));
}

// bets ingest identity, same precedence as the event_date_sanity emitter:
// Discord ref, then tweet ref, else a manual_<betId> fallback so the
// pipeline_events row is always attributable (writeRow drops ingestId-less
// non-grading rows).
function ingestIdentityFor(bet) {
  if (bet.source_message_id) return { ingestId: `disc_${bet.source_message_id}`, sourceRef: String(bet.source_message_id) };
  if (bet.source_tweet_id) return { ingestId: `twit_${bet.source_tweet_id}`, sourceRef: String(bet.source_tweet_id) };
  return { ingestId: `manual_${bet.id}`, sourceRef: String(bet.id) };
}

function fmtRow(r) {
  const cap = r.capper_display_name == null ? '(none)' : String(r.capper_display_name);
  return `${String(r.id).slice(0, 8)} | ${r.created_at} | ${r.season} | ${r.sport} | ${r.source} | ${cap}`;
}

// Per-bet void worker (exported for tests). Returns betId → outcome, one of
// 'voided' | 'tailed' | 'gate_noop' | 'rolled_back'. The transaction is
// IMMEDIATE so the write lock is held across recheck → archive → UPDATE:
// the tailed/gate state is re-read INSIDE the transaction (a tail/fade or an
// operator confirm landing after selection is honored at write time, never
// the stale selection snapshot), the archive row's before-state comes from
// that same live read, and if the gated UPDATE still refuses, the throw rolls
// the archive insert back — no history row ever claims a void that did not
// happen (PR #211 review, both findings).
function buildVoidWorker(db, { season, reason, insertCols }) {
  const insertHistory = db.prepare(
    `INSERT INTO bet_grade_history (${insertCols.join(', ')}) VALUES (${insertCols.map(c => `@${c}`).join(', ')})`,
  );
  const voidStmt = db.prepare(VOID_UPDATE_SQL);
  const recheck = db.prepare(`
    SELECT b.result, b.review_status, b.season, b.profit_units, b.grade,
           b.grade_reason, b.graded_at,
           EXISTS(SELECT 1 FROM user_bets ub WHERE ub.bet_id = b.id) AS tailed
    FROM bets b WHERE b.id = ?`);
  const tx = db.transaction((betId) => {
    const live = recheck.get(betId);
    if (!live || live.result !== 'pending' || live.review_status !== 'needs_review' || live.season !== season) return 'gate_noop';
    if (live.tailed) return 'tailed';
    const values = {
      bet_id: betId,
      old_result: live.result,
      old_profit_units: live.profit_units,
      old_grade: live.grade,
      old_grade_reason: live.grade_reason,
      old_graded_at: live.graded_at,
      archived_by: ARCHIVED_BY,
      reason: `${reason} → new result 'void'`,
    };
    const picked = {};
    for (const c of insertCols) picked[c] = values[c];
    insertHistory.run(picked);
    const changes = voidStmt.run(reason, betId, season).changes;
    // Belt-and-braces: unreachable under the immediate lock + recheck above,
    // but a refusal here must take the archive row down with it.
    if (changes !== 1) throw new Error(`void gate refused ${betId} after in-transaction recheck (changes=${changes})`);
    return 'voided';
  });
  return (betId) => {
    try { return tx.immediate(betId); } catch (err) {
      console.log(`  ROLLED BACK (${err.message})`);
      return 'rolled_back';
    }
  };
}

module.exports = {
  parseArgs,
  isValidYmd,
  nextDayYmd,
  ageBucket,
  buildVoidReason,
  missingColumns,
  ingestIdentityFor,
  fmtRow,
  buildVoidWorker,
  PENDING_NR_WHERE,
  VOID_UPDATE_SQL,
  REQUIRED_BETS_COLS,
  DEFAULT_BATCH,
  DEFAULT_SINCE,
  GRADER_VERSION,
  ARCHIVED_BY,
};

// ═════════════════════════ runtime ══════════════════════════

const USAGE = 'Usage: node scripts/retro-triage-needs-review.js [--dry-run|--apply] [--batch N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--void-season X]';

// sftp-to-/tmp operator flow: a bare require resolves nothing on the /tmp
// ancestor chain — fall back to $APP_ROOT (reconcile-needs-review.js mold).
function requireBetterSqlite() {
  const candidates = ['better-sqlite3', path.join(APP_ROOT, 'node_modules', 'better-sqlite3')];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function requireService(rel) {
  const candidates = [path.join(__dirname, '..', 'services', rel), path.join(APP_ROOT, 'services', rel)];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// Range clause shared by the approve preview and the apply selection. The
// lower bound is inclusive; --until is inclusive via an exclusive next-day
// bound; default upper bound is now (TEXT created_at, lexicographic ISO).
function rangeClause(args) {
  const untilEx = args.until ? nextDayYmd(args.until) : null;
  return {
    sql: "AND b.created_at >= @since AND b.created_at < COALESCE(@untilEx, datetime('now'))",
    binds: { since: args.since, untilEx },
  };
}

function selectApproveCandidates(db, args, limit) {
  const { sql, binds } = rangeClause(args);
  return db.prepare(`
    SELECT b.id, b.created_at, b.season, b.sport, b.source,
           b.source_message_id, b.source_tweet_id,
           c.display_name AS capper_display_name
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE ${PENDING_NR_WHERE} ${sql}
    ORDER BY b.created_at DESC
    LIMIT @lim
  `).all({ ...binds, lim: limit });
}

function selectVoidCandidates(db, season) {
  return db.prepare(`
    SELECT b.id, b.created_at, b.season, b.sport, b.source,
           b.profit_units, b.grade, b.grade_reason, b.graded_at,
           c.display_name AS capper_display_name,
           EXISTS(SELECT 1 FROM user_bets ub WHERE ub.bet_id = b.id) AS tailed
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE ${PENDING_NR_WHERE} AND b.season = @season
    ORDER BY b.created_at DESC
  `).all({ season });
}

function printReport(db, args) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE ${PENDING_NR_WHERE}`).get().n;
  console.log(`\npending needs_review backlog: ${total} bets\n`);

  console.log('by season:');
  for (const r of db.prepare(`SELECT season, COUNT(*) AS n FROM bets WHERE ${PENDING_NR_WHERE} GROUP BY season ORDER BY n DESC`).all()) {
    console.log(`  ${r.season}: ${r.n}`);
  }

  console.log('by age bucket (created_at → now):');
  const buckets = { '<1d': 0, '1-7d': 0, '7-30d': 0, '>30d': 0, unknown: 0 };
  for (const r of db.prepare(`SELECT created_at FROM bets WHERE ${PENDING_NR_WHERE}`).all()) {
    buckets[ageBucket(r.created_at)]++;
  }
  for (const [b, n] of Object.entries(buckets)) {
    if (n > 0 || b !== 'unknown') console.log(`  ${b}: ${n}`);
  }

  console.log('by sport (top 10):');
  for (const r of db.prepare(`SELECT sport, COUNT(*) AS n FROM bets WHERE ${PENDING_NR_WHERE} GROUP BY sport ORDER BY n DESC LIMIT 10`).all()) {
    console.log(`  ${r.sport}: ${r.n}`);
  }

  console.log('by source (top 10):');
  for (const r of db.prepare(`SELECT source, COUNT(*) AS n FROM bets WHERE ${PENDING_NR_WHERE} GROUP BY source ORDER BY n DESC LIMIT 10`).all()) {
    console.log(`  ${r.source}: ${r.n}`);
  }

  const tailedRows = db.prepare(`
    SELECT DISTINCT b.id FROM bets b JOIN user_bets ub ON ub.bet_id = b.id
    WHERE ${PENDING_NR_WHERE} ORDER BY b.created_at DESC
  `).all();
  console.log(`\ntailed (user_bets row exists): ${tailedRows.length}`);
  for (const r of tailedRows.slice(0, 25)) console.log(`  ${r.id}`);
  if (tailedRows.length > 25) console.log(`  … ${tailedRows.length - 25} more`);

  const untilLabel = args.until || 'now';
  const preview = selectApproveCandidates(db, args, args.batch);
  console.log(`\n--apply --batch ${args.batch} --since ${args.since} --until ${untilLabel} WOULD approve ${preview.length} bets (newest first):`);
  console.log('  id(8) | created_at | season | sport | source | capper_display_name');
  for (const r of preview) console.log(`  ${fmtRow(r)}`);

  if (args.voidSeason != null) {
    const voidPreview = selectVoidCandidates(db, args.voidSeason);
    const skips = voidPreview.filter(r => r.tailed).length;
    console.log(`\n--void-season ${args.voidSeason} WOULD void ${voidPreview.length - skips} bets (${skips} tailed → SKIP):`);
    console.log('  id(8) | created_at | season | sport | source | capper_display_name');
    for (const r of voidPreview) console.log(`  ${fmtRow(r)}${r.tailed ? '  ← SKIP (tailed)' : ''}`);
  } else {
    console.log('\n(no --void-season given — pass --void-season <X> to preview the void set)');
  }
}

function applyBatchApprove(database, pipelineEvents, args) {
  const db = database.db;
  const candidates = selectApproveCandidates(db, args, args.batch);
  console.log(`\nAPPLY: approving ${candidates.length} bets (--batch ${args.batch} --since ${args.since} --until ${args.until || 'now'}), newest first, ONE transaction:`);
  console.log('  id(8) | created_at | season | sport | source | capper_display_name');
  for (const r of candidates) console.log(`  ${fmtRow(r)}`);

  let approved = 0, refused = 0;
  db.transaction(() => {
    for (const bet of candidates) {
      // approveBet is the single gated UPDATE (confirm + clean-slate grading
      // reset + 3-day sweep_exempt_until). null = REFUSAL (gate no longer
      // matches — settled or confirmed since selection): count, never retry.
      const res = database.approveBet(bet.id);
      if (res == null) { refused++; continue; }
      approved++;
      if (pipelineEvents) {
        const { ingestId, sourceRef } = ingestIdentityFor(bet);
        // Existing enum values only: VALIDATED + STAGE_EXIT (fire-and-forget;
        // observability failure must not break the batch).
        pipelineEvents.recordStage({
          ingestId,
          betId: bet.id,
          sourceType: 'manual',
          sourceRef,
          stage: 'VALIDATED',
          eventType: 'STAGE_EXIT',
          payload: { retroTriage: 'approve', script: SCRIPT_NAME },
        });
      }
    }
  })();

  console.log(`\napproved=${approved} refused=${refused}`);
  console.log('Approved bets re-enter the grader with clean state and a 3-day sweep grace (approveBet stamps sweep_exempt_until).');
}

function applyVoidSeason(database, args, today) {
  const db = database.db;
  const season = args.voidSeason;

  // PRAGMA-driven archive insert (PREFLIGHT Rule 1): fill whatever of the
  // known provenance columns exist. bet_id + archived_by (NOT NULL) are
  // required — refuse rather than write a bad archive row.
  const historyCols = db.prepare('PRAGMA table_info(bet_grade_history)').all().map(c => c.name);
  for (const required of ['bet_id', 'archived_by']) {
    if (!historyCols.includes(required)) {
      console.error(`bet_grade_history is missing required column '${required}' — aborting before any write.`);
      process.exitCode = 2;
      return;
    }
  }
  const reason = buildVoidReason(season, today);
  const CANDIDATE_HISTORY_COLS = [
    'bet_id', 'old_result', 'old_profit_units', 'old_grade',
    'old_grade_reason', 'old_graded_at', 'archived_by', 'reason',
  ];
  const insertCols = CANDIDATE_HISTORY_COLS.filter(c => historyCols.includes(c));
  const voidOne = buildVoidWorker(db, { season, reason, insertCols });

  const candidates = selectVoidCandidates(db, season);
  console.log(`\nAPPLY: --void-season ${season} over ${candidates.length} candidates (archive row + sweeper-column void, ONE transaction per bet):`);

  let voided = 0, skippedTailed = 0;
  for (const bet of candidates) {
    // HARD-GATE at selection time — and again INSIDE the worker's immediate
    // transaction, so a tail/fade accepted after this read is still skipped.
    // The user-settlement ledger is not reconciled by this script.
    if (bet.tailed) {
      skippedTailed++;
      console.log(`  SKIP (tailed): ${fmtRow(bet)}`);
      continue;
    }
    const outcome = voidOne(bet.id);
    if (outcome === 'voided') {
      voided++;
      console.log(`  VOIDED (changes=1): ${fmtRow(bet)}`);
    } else if (outcome === 'tailed') {
      skippedTailed++;
      console.log(`  SKIP (tailed at write time): ${fmtRow(bet)}`);
    } else {
      console.log(`  NO-OP (changes=0, ${outcome} — gate no longer matches): ${fmtRow(bet)}`);
    }
  }

  console.log(`\nvoided=${voided} skipped_tailed=${skippedTailed}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const apply = args.mode === 'apply';
  const today = new Date().toISOString().slice(0, 10);

  // Validate the DB file + schema with a READONLY open in BOTH modes, before
  // services/database (which opens read-write and would CREATE a missing
  // file) can ever be required.
  const Database = requireBetterSqlite();
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open DB_PATH=${DB_PATH}: ${err.message}`);
    process.exit(2);
  }

  for (const t of ['bets', 'user_bets', 'cappers', 'bet_grade_history']) {
    if (!tableExists(db, t)) {
      console.error(`schema mismatch — table '${t}' is missing; wrong DB file? (DB_PATH=${DB_PATH})`);
      db.close();
      process.exit(2);
    }
  }
  const betsCols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
  const missing = missingColumns(betsCols);
  if (missing.length) {
    console.error(`schema mismatch — bets is missing expected column(s) [${missing.join(', ')}]; re-verify with PRAGMA table_info(bets).`);
    db.close();
    process.exit(2);
  }

  console.log(`retro-triage-needs-review — ${apply ? 'APPLY' : 'DRY RUN (readonly)'} against ${DB_PATH}`);
  console.log(`population: ${PENDING_NR_WHERE}`);

  if (!apply) {
    printReport(db, args);
    console.log('\nDRY RUN — no writes. Re-run with --apply to execute.');
    db.close();
    return; // natural exit — large tables may exceed the 64KB pipe buffer
  }

  db.close(); // the shared services/database connection takes over for apply

  // Pin DB_PATH BEFORE the require so database.js opens the SAME file the
  // preflight just validated (its own default differs from this script's).
  process.env.DB_PATH = DB_PATH;
  const database = requireService('database');
  let pipelineEvents = null;
  try {
    pipelineEvents = requireService('pipeline-events');
  } catch (err) {
    console.log(`pipeline-events unavailable (${err.message}) — approvals will not emit events; breadcrumb lives in this console summary only.`);
  }

  if (args.voidSeason != null) applyVoidSeason(database, args, today);
  else applyBatchApprove(database, pipelineEvents, args);
}

if (require.main === module) main();
