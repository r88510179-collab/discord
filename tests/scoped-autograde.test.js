// ═══════════════════════════════════════════════════════════
// T2-01/V2 + T1-08/V3 + T6-01/V6 — scoped recap/graphic/celebration
// auto-grade.
//
// The pre-fix graphic path graded via a GLOBAL `LIKE '%term%'` across ALL
// cappers' confirmed pending bets, oldest-first, then auto-confirmed and
// wrote bankroll (audit T2-01, cross-capper wrong-grade). The adjudicated
// fix (PR #164): scope is mandatory — capper AND recency — and exactly ONE
// in-scope match may auto-grade; zero matches, multiple matches, stale
// matches, or an unresolvable capper defer to needs_review with no terminal
// grade, no auto-confirm, no bankroll write.
//
// Exercises the REAL policy (services/grading.js autoGradeFromRecap — the
// function both messageHandler call sites route through) against a migrated
// temp DB. No Discord (client=null), no AI.
//
// Run:  node tests/scoped-autograde.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `scoped-autograde-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
delete process.env.WAR_ROOM_CHANNEL_ID; // keep the notification block inert

const database = require('../services/database');
const { db, createBetWithLegs, getOrCreateCapper, setBankroll, getBankroll, findPendingBetsByCapperSubject } = database;
const { autoGradeFromRecap, gradeFromCelebration } = require('../services/grading');
const pe = require('../services/pipeline-events');

const CAPPER_A = getOrCreateCapper('cap_scoped_a', 'Scoped Capper A', null).id;
const CAPPER_B = getOrCreateCapper('cap_scoped_b', 'Scoped Capper B', null).id;
setBankroll(CAPPER_A, 1000, 25);
setBankroll(CAPPER_B, 1000, 25);

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

let seq = 0;
function seedBet(capperId, description, { createdAgoDays = 0, reviewStatus = 'confirmed' } = {}) {
  seq += 1;
  const bet = createBetWithLegs({
    capper_id: capperId,
    sport: 'NBA',
    bet_type: 'straight',
    description,
    odds: -110,
    units: 1,
    source: 'scoped_autograde_test',
    source_message_id: `sag_${process.pid}_${seq}`,
    review_status: reviewStatus,
  }, []);
  assert.ok(bet && bet.id && !bet._deduped, `seed should create a fresh bet (${description})`);
  if (createdAgoDays > 0) {
    db.prepare("UPDATE bets SET created_at = datetime('now', ?) WHERE id = ?").run(`-${createdAgoDays} days`, bet.id);
  }
  return bet.id;
}

const rowOf = id => db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
const deferRowsFor = id => db.prepare("SELECT * FROM pipeline_events WHERE bet_id = ? AND drop_reason = 'GRADE_RECAP_MATCH_DEFERRED'").all(id);
const completeRowsFor = id => db.prepare("SELECT * FROM pipeline_events WHERE bet_id = ? AND stage = 'GRADING_COMPLETE'").all(id);
const auditRowsFor = id => db.prepare('SELECT * FROM grading_audit WHERE bet_id = ?').all(id);
const nullBetDeferRows = () => db.prepare("SELECT * FROM pipeline_events WHERE bet_id IS NULL AND drop_reason = 'GRADE_RECAP_MATCH_DEFERRED'").all();

async function main() {
  console.log('T2-01 — scoped recap auto-grade policy');

  // ── 1. exactly one in-scope match → auto-grades, with telemetry ──────────
  await run('single in-scope match auto-grades (bankroll + GRADING_COMPLETE + grading_audit)', async () => {
    const id = seedBet(CAPPER_A, 'Lakers ML tonight');
    const bankrollBefore = getBankroll(CAPPER_A).current;

    const res = await autoGradeFromRecap(null, { capperId: CAPPER_A, outcome: 'win', subjects: ['Lakers'], source: 'graphic_auto' });
    assert.ok(res, 'single in-scope match must auto-grade');
    assert.strictEqual(res.bet.id, id);
    assert.strictEqual(res.result, 'win');

    const after = rowOf(id);
    assert.strictEqual(after.result, 'win');
    assert.strictEqual(after.review_status, 'confirmed', 'stays confirmed (no auto-confirm involved)');
    assert.ok(after.graded_at);
    assert.ok(/Auto-graded from capper graphic: Lakers/.test(after.grade_reason), `grade_reason names source + matched term — got "${after.grade_reason}"`);

    const expectedProfit = 1 * (100 / 110);
    assert.ok(Math.abs(res.profitUnits - expectedProfit) < 1e-9, 'win profit at -110');
    const bankrollAfter = getBankroll(CAPPER_A).current;
    assert.ok(Math.abs((bankrollAfter - bankrollBefore) - expectedProfit * 25) < 1e-6, 'bankroll credited profit × unit_size');

    const complete = completeRowsFor(id);
    assert.strictEqual(complete.length, 1, 'one GRADING_COMPLETE row for the auto-grade');
    const payload = JSON.parse(complete[0].payload);
    assert.strictEqual(payload.source, 'graphic_auto');
    assert.strictEqual(payload.match_count, 1, 'match count recorded');
    const audits = auditRowsFor(id);
    assert.strictEqual(audits.length, 1, 'one grading_audit row for the auto-grade');
    assert.strictEqual(audits[0].provider_used, 'graphic_auto');
    assert.strictEqual(audits[0].final_status, 'WIN');
  });

  // ── 2. same subject, different capper → never matches ────────────────────
  await run("same subject from a different capper never matches (cross-capper grade impossible)", async () => {
    const otherId = seedBet(CAPPER_B, 'Celtics ML lock of the day');
    const before = JSON.stringify(rowOf(otherId));
    const nullRowsBefore = nullBetDeferRows().length;

    const res = await autoGradeFromRecap(null, { capperId: CAPPER_A, outcome: 'win', subjects: ['Celtics'], source: 'graphic_auto' });
    assert.strictEqual(res, null, "capper A's recap must not grade capper B's bet");
    assert.strictEqual(JSON.stringify(rowOf(otherId)), before, "capper B's bet is byte-identical — not graded, not parked");
    assert.strictEqual(nullBetDeferRows().length, nullRowsBefore + 1, 'zero-candidate deferral recorded (betId-NULL GRADE_RECAP_MATCH_DEFERRED row)');
    const payload = JSON.parse(nullBetDeferRows().pop().payload);
    assert.strictEqual(payload.match_count, 0, 'match count 0 recorded');
  });

  // ── 3. two in-scope matches → both parked needs_review, no grade ─────────
  await run('two in-scope matches → needs_review (no grade, no bankroll write, match count 2)', async () => {
    const id1 = seedBet(CAPPER_A, 'Yankees ML early');
    const id2 = seedBet(CAPPER_A, 'Yankees -1.5 run line');
    const bankrollBefore = getBankroll(CAPPER_A).current;

    const res = await autoGradeFromRecap(null, { capperId: CAPPER_A, outcome: 'loss', subjects: ['Yankees'], source: 'celebration' });
    assert.strictEqual(res, null, 'ambiguous matches must not auto-grade');

    for (const id of [id1, id2]) {
      const row = rowOf(id);
      assert.strictEqual(row.result, 'pending', 'no terminal grade on an ambiguous match');
      assert.strictEqual(row.graded_at, null);
      assert.strictEqual(row.review_status, 'needs_review', 'candidate parked for human review');
      assert.strictEqual(row.drop_reason, 'GRADE_RECAP_MATCH_DEFERRED', 'bets.drop_reason stamped');
      const defers = deferRowsFor(id);
      assert.strictEqual(defers.length, 1, 'one deferral row per parked candidate');
      const payload = JSON.parse(defers[0].payload);
      assert.strictEqual(payload.match_count, 2, 'match count 2 recorded');
      assert.strictEqual(payload.why, 'ambiguous_matches');
    }
    assert.strictEqual(getBankroll(CAPPER_A).current, bankrollBefore, 'no bankroll write on deferral');
  });

  // ── 4. only a stale (>7d) match → needs_review, no grade ─────────────────
  await run('match older than 7 days → needs_review (recency scope enforced)', async () => {
    const staleId = seedBet(CAPPER_A, 'Dodgers ML from last month', { createdAgoDays: 10 });

    const res = await autoGradeFromRecap(null, { capperId: CAPPER_A, outcome: 'win', subjects: ['Dodgers'], source: 'graphic_auto' });
    assert.strictEqual(res, null, 'a stale match must not auto-grade');

    const row = rowOf(staleId);
    assert.strictEqual(row.result, 'pending');
    assert.strictEqual(row.review_status, 'needs_review', 'stale candidate parked for human review');
    const payload = JSON.parse(deferRowsFor(staleId)[0].payload);
    assert.strictEqual(payload.why, 'stale_match');
    assert.strictEqual(payload.match_count, 0, 'zero in-window matches');
    assert.strictEqual(payload.stale_count, 1, 'one stale match recorded');
  });

  // ── 5. unresolvable capper → deferral only, nothing graded ───────────────
  await run('unresolvable capper → deferral telemetry, no grade', async () => {
    const nullRowsBefore = nullBetDeferRows().length;
    const res = await autoGradeFromRecap(null, { capperId: null, outcome: 'win', subjects: ['Anything'], source: 'graphic_auto' });
    assert.strictEqual(res, null);
    const rows = nullBetDeferRows();
    assert.strictEqual(rows.length, nullRowsBefore + 1);
    assert.strictEqual(JSON.parse(rows.pop().payload).why, 'capper_unresolved');
  });

  // ── 6. celebration wrapper routes through the same policy ────────────────
  await run('gradeFromCelebration applies the identical scoped policy', async () => {
    const id = seedBet(CAPPER_B, 'Knicks ML celebration probe');
    const res = await gradeFromCelebration(null, CAPPER_B, 'win', ['Knicks']);
    assert.ok(res, 'single in-scope celebration match grades');
    assert.strictEqual(res.bet.id, id);
    assert.strictEqual(auditRowsFor(id)[0].provider_used, 'celebration', 'telemetry names the celebration writer');
  });

  // ── 7. matcher contract: capper + recency scope, no global path ──────────
  await run('findPendingBetsByCapperSubject is capper-bound and splits in-window vs stale', async () => {
    const freshId = seedBet(CAPPER_A, 'Warriors ML matcher probe');
    const staleId = seedBet(CAPPER_A, 'Warriors spread matcher probe', { createdAgoDays: 9 });
    seedBet(CAPPER_B, 'Warriors total matcher probe'); // other capper — must never surface

    const { inWindow, stale } = findPendingBetsByCapperSubject(CAPPER_A, ['Warriors'], 7);
    assert.deepStrictEqual(inWindow.map(b => b.id), [freshId]);
    assert.deepStrictEqual(stale.map(b => b.id), [staleId]);
    const none = findPendingBetsByCapperSubject(null, ['Warriors'], 7);
    assert.deepStrictEqual(none, { inWindow: [], stale: [] }, 'no capper → no candidates, never a global scan');
  });

  // ── 8. word-tokenized recall: full OCR phrase terms still match ──────────
  // The ticket-recap caller passes full phrases (leg description first
  // segment, description first line). The pre-fix celebration matcher word-
  // tokenized them; the scoped matcher must keep that recall — a whole-phrase
  // LIKE would silently no-match ("Los Angeles Lakers ML -110" is not a
  // substring of "Lakers ML vs Suns") and let the sweeper void a bet whose
  // outcome the capper's recap announced.
  await run('full-phrase recap term matches by word token (recall parity with pre-fix matcher)', async () => {
    const id = seedBet(CAPPER_B, 'Lakers ML vs Suns');
    const res = await autoGradeFromRecap(null, { capperId: CAPPER_B, outcome: 'win', subjects: ['Los Angeles Lakers ML -110'], source: 'celebration' });
    assert.ok(res, 'phrase term must match via its "Lakers" token');
    assert.strictEqual(res.bet.id, id);
    assert.strictEqual(rowOf(id).result, 'win');
  });

  // ── 9. mixed ambiguity: stale candidates are parked alongside fresh ──────
  // A stale candidate is already past SWEEP_DAYS; leaving it in the
  // autonomous pool on an ambiguous deferral would let the very next sweep
  // cycle settle it evidence-free without the recap context.
  await run('two fresh + one stale match → all three parked to needs_review', async () => {
    const capperC = getOrCreateCapper('cap_scoped_c', 'Scoped Capper C', null).id;
    const fresh1 = seedBet(capperC, 'Mets ML early');
    const fresh2 = seedBet(capperC, 'Mets -1.5 run line');
    const staleId = seedBet(capperC, 'Mets total from two weeks ago', { createdAgoDays: 14 });

    const res = await autoGradeFromRecap(null, { capperId: capperC, outcome: 'win', subjects: ['Mets'], source: 'celebration' });
    assert.strictEqual(res, null, 'ambiguous matches must not auto-grade');
    for (const id of [fresh1, fresh2, staleId]) {
      const row = rowOf(id);
      assert.strictEqual(row.result, 'pending', 'no terminal grade');
      assert.strictEqual(row.review_status, 'needs_review', 'every recap-matched candidate leaves the autonomous pool');
    }
    const payload = JSON.parse(deferRowsFor(staleId)[0].payload);
    assert.strictEqual(payload.match_count, 2);
    assert.strictEqual(payload.stale_count, 1);
  });

  // ── 10. T1-08: dead ungated stmts.gradeBet is gone ───────────────────────
  await run('stmts.gradeBet prepared statement no longer defined (T1-08)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'database.js'), 'utf8');
    assert.ok(!/gradeBet:\s*db\.prepare/.test(src), 'the ungated stmts.gradeBet UPDATE must stay deleted');
    assert.strictEqual(typeof database.gradeBet, 'function', 'the gated gradeBetRecord export (gradeBet) remains');
  });

  // ── 11. enum registration (Change D) ─────────────────────────────────────
  await run('GRADE_RECAP_MATCH_DEFERRED is registered in DROP_REASONS', () => {
    assert.ok(pe.DROP_REASONS.includes('GRADE_RECAP_MATCH_DEFERRED'), 'deferral reason must be a registered enum member');
  });

  console.log(`\nT2-01 scoped auto-grade: ${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(() => {
    database.db.close();
    try { fs.unlinkSync(DB_FILE); } catch (_) {}
    if (failed > 0) process.exit(1);
  });
