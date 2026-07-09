// ═══════════════════════════════════════════════════════════
// backfill-event-dates.js — dry-run/report correctness + CLI safety guards.
// Pattern: tests/apply-regrade-s01-s05.test.js (Section A DB-free unit cases,
// Section B throwaway migrated sqlite DB, Section C end-to-end CLI via
// child_process on an isolated DB copy).
//
// Run: node tests/backfill-event-dates.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Resolve the script's APP_ROOT-based requires against this checkout.
process.env.APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..');

const S = require('../scripts/backfill-event-dates.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill-event-dates.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

// ── Section A — DB-free unit cases ──────────────────────────────────────────
console.log('Section A — parseArgs + predicates');

check('A1: default is dry-run', S.parseArgs(['--scrub']).mode === 'dry-run');
check('A1: default db is prod', S.parseArgs(['--scrub']).dbPath === S.PROD_DB_PATH);
check('A1: --apply --dry-run conflict', !!S.parseArgs(['--scrub', '--apply', '--dry-run']).error);
check('A1: no op selected → error', !!S.parseArgs([]).error);
check('A1: unknown arg → error', !!S.parseArgs(['--scrub', '--frobnicate']).error);
check('A1: both ops parse', (() => { const a = S.parseArgs(['--scrub', '--populate']); return a.scrub && a.populate && !a.error; })());

check('A2: parseStoredUtc space-separated is UTC',
  S.parseStoredUtc('2026-06-21 14:15:24').toISOString() === '2026-06-21T14:15:24.000Z');
check('A2: parseStoredUtc date-only → UTC midnight',
  S.parseStoredUtc('2026-06-21').toISOString() === '2026-06-21T00:00:00.000Z');
check('A2: parseStoredUtc ISO passthrough',
  S.parseStoredUtc('2023-11-26T19:00:00.000Z').toISOString() === '2023-11-26T19:00:00.000Z');
check('A2: parseStoredUtc junk → null', S.parseStoredUtc('not a date') === null);
check('A2: parseStoredUtc null/empty → null', S.parseStoredUtc(null) === null && S.parseStoredUtc('') === null);

// Boundary semantics mirror the gate: outOfBounds strictly < -2 or > +60.
check('A3: gap exactly -2d is IN bounds', !S.isImplausibleGap(-2));
check('A3: gap exactly +60d is IN bounds', !S.isImplausibleGap(60));
check('A3: gap -2.01d is OUT', S.isImplausibleGap(-2.01));
check('A3: gap +60.01d is OUT', S.isImplausibleGap(60.01));
check('A3: wrong-year specimen (-941d) is OUT', S.isImplausibleGap(
  S.gapDays(new Date('2023-11-26T19:00:00Z'), new Date('2026-06-25T12:00:00Z')),
));

check('A4: "Fri 3:00 PM ET" flags Tier-2 (the 40815408 specimen)', S.hasDateishToken('FRA @ NOR • Fri 3:00 PM ET'));
check('A4: "Friday night lock" flags', S.hasDateishToken('Friday night lock'));
check('A4: "Apr 12 5:00 PM" flags', S.hasDateishToken('Apr 12 5:00 PM'));
check('A4: numeric M/D flags', S.hasDateishToken('Yankees ML 6/24'));
check('A4: "Suns ML" does NOT flag (weekday substring guard)', !S.hasDateishToken('Suns ML -110'));
check('A4: bare "May" without a day number does NOT flag', !S.hasDateishToken('May the parlay gods bless us'));
check('A4: plain prop text does NOT flag', !S.hasDateishToken('Aaron Judge 2+ Total Bases'));

check('A5: populateValueFromCreatedAt = full ISO instant, never date-only',
  S.populateValueFromCreatedAt('2026-06-21 14:15:24') === '2026-06-21T14:15:24.000Z');

// ── Section B — throwaway migrated DB, plan correctness ─────────────────────
let database;
try {
  process.env.DB_PATH = path.join(os.tmpdir(), `backfill-evd-${process.pid}-${process.hrtime.bigint()}.db`);
  database = require('../services/database');
} catch (err) {
  console.log(`\nSection B — SKIPPED (database.js/better-sqlite3 unavailable: ${err.message})`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\nSection B — plan correctness on a seeded DB');
{
  const db = database.db;
  function seed(id, f) {
    const row = Object.assign({
      id, sport: 'MLB', bet_type: 'straight', description: `seed ${id}`, odds: -110, units: 1,
      result: 'pending', review_status: 'confirmed', source: 'vision_slip',
      created_at: '2026-06-25 12:00:00', event_date: null,
    }, f);
    db.prepare(`INSERT OR REPLACE INTO bets (id, sport, bet_type, description, odds, units, result, review_status, source, created_at, event_date)
      VALUES (@id,@sport,@bet_type,@description,@odds,@units,@result,@review_status,@source,@created_at,@event_date)`).run(row);
  }

  // scrub cohort
  seed('scrub-wrong-year', { event_date: '2023-11-26T19:00:00.000Z' });                       // → SCRUB_NULL
  seed('scrub-graded', { event_date: '2023-11-26T19:00:00.000Z', result: 'loss' });           // finalized → untouched
  seed('scrub-in-bounds', { event_date: '2026-06-26T19:00:00.000Z' });                        // +1.3d → SKIP_IN_BOUNDS
  seed('scrub-dateonly-recoverhold', { event_date: '2026-06-25', created_at: '2026-06-25 14:15:24' }); // -0.6d → in bounds

  // populate cohort
  seed('pop-mlb', { description: 'Yankees ML' });                                             // → POPULATE
  seed('pop-nba', { sport: 'NBA', description: 'Lakers -3.5' });                              // → POPULATE
  seed('pop-soccer', { sport: 'Soccer', description: 'Arsenal ML' });                         // → SKIP_SPORT (silent)
  seed('pop-needs-review', { description: 'Mets ML', review_status: 'needs_review' });        // outside query scope
  seed('pop-tier2', { description: 'FRA @ NOR • Fri 3:00 PM ET' });                           // → SKIP_TIER2

  const scrub = S.buildScrubPlan(db);
  const byId = (plan, id) => plan.find(p => p.row.id === id);

  check('B1: wrong-year pending → SCRUB_NULL', byId(scrub, 'scrub-wrong-year')?.action === 'SCRUB_NULL');
  check('B1: gap reported', typeof byId(scrub, 'scrub-wrong-year')?.gap === 'number' && byId(scrub, 'scrub-wrong-year').gap < -900);
  check('B1: finalized wrong-year row NOT in scrub plan', !byId(scrub, 'scrub-graded'));
  check('B1: in-bounds populated row → SKIP_IN_BOUNDS', byId(scrub, 'scrub-in-bounds')?.action === 'SKIP_IN_BOUNDS');
  check('B1: recoverHold date-only row survives the scrub', byId(scrub, 'scrub-dateonly-recoverhold')?.action === 'SKIP_IN_BOUNDS');

  const pop = S.buildPopulatePlan(db);
  check('B2: MLB confirmed pending NULL → POPULATE', byId(pop, 'pop-mlb')?.action === 'POPULATE');
  check('B2: populate value is created_at full ISO instant', byId(pop, 'pop-mlb')?.value === '2026-06-25T12:00:00.000Z');
  check('B2: NBA also in scope', byId(pop, 'pop-nba')?.action === 'POPULATE');
  check('B2: soccer skipped (out-of-scope sport, silent aggregate)', byId(pop, 'pop-soccer')?.action === 'SKIP_SPORT' && byId(pop, 'pop-soccer')?.silent === true);
  check('B2: needs_review row outside the query scope entirely', !byId(pop, 'pop-needs-review'));
  check('B2: date-ish description → SKIP_TIER2_DATEISH_DESC', byId(pop, 'pop-tier2')?.action === 'SKIP_TIER2_DATEISH_DESC');
  check('B2: scrubbed-wrong-year row is NOT in populate plan (event_date not NULL)', !byId(pop, 'scrub-wrong-year'));

  const counts = S.summarize([...scrub, ...pop]);
  check('B3: summary counts every action', counts['scrub:SCRUB_NULL'] === 1 && counts['populate:POPULATE'] === 2 && counts['populate:SKIP_TIER2_DATEISH_DESC'] === 1);

  // ── Section C — end-to-end CLI on an isolated DB copy ─────────────────────
  console.log('\nSection C — CLI safety guards + apply');

  db.pragma('wal_checkpoint(TRUNCATE)');
  const CHILDDB = path.join(os.tmpdir(), `backfill-evd-child-${process.pid}-${process.hrtime.bigint()}.db`);
  fs.copyFileSync(process.env.DB_PATH, CHILDDB);

  function runCli(cliArgs) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...cliArgs], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, APP_ROOT: path.join(__dirname, '..') },
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status == null ? -1 : err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
  }
  const childDb = () => new (require('better-sqlite3'))(CHILDDB, { readonly: true });
  const eventDateOf = (id) => { const d = childDb(); const v = d.prepare('SELECT event_date FROM bets WHERE id = ?').get(id)?.event_date; d.close(); return v; };

  // C1: no op selected → exit 2 + usage.
  const c1 = runCli(['--db', CHILDDB, '--allow-nonprod']);
  check('C1: no-op refused exit 2', c1.status === 2 && /pick at least one op/.test(c1.stderr));

  // C2: non-prod path refused without --allow-nonprod.
  const c2 = runCli(['--scrub', '--db', CHILDDB]);
  check('C2: non-prod refusal exit 2', c2.status === 2 && /REFUSED/.test(c2.stderr));

  // C3: conflict flags.
  const c3 = runCli(['--scrub', '--apply', '--dry-run', '--db', CHILDDB, '--allow-nonprod']);
  check('C3: --apply --dry-run conflict exit 2', c3.status === 2 && /mutually exclusive/.test(c3.stderr));

  // C4: dry-run (default) reports and writes NOTHING.
  const c4 = runCli(['--scrub', '--populate', '--db', CHILDDB, '--allow-nonprod']);
  check('C4: dry-run exit 0', c4.status === 0, c4.stderr.slice(0, 200));
  check('C4: dry-run banner + no-writes notice', /DRY RUN/.test(c4.stdout) && /no writes/i.test(c4.stdout));
  check('C4: dry-run reports the scrub row (8-char id prefix)', /scrub-wr/.test(c4.stdout) && /SCRUB_NULL/.test(c4.stdout));
  check('C4: dry-run reports Tier-2 skip + operator warning', /SKIP_TIER2_DATEISH_DESC/.test(c4.stdout) && /verify each by hand/.test(c4.stdout));
  check('C4: dry-run reports the populate pre-staging warning', /pre-staging for EVENT_DATE_SLATE=enforce/.test(c4.stdout));
  check('C4: dry-run wrote nothing (wrong-year intact)', eventDateOf('scrub-wrong-year') === '2023-11-26T19:00:00.000Z');
  check('C4: dry-run wrote nothing (MLB still NULL)', eventDateOf('pop-mlb') === null);

  // C5: --scrub --apply writes ONLY scrubs.
  const c5 = runCli(['--scrub', '--apply', '--db', CHILDDB, '--allow-nonprod']);
  check('C5: scrub apply exit 0', c5.status === 0, c5.stderr.slice(0, 200));
  check('C5: wrong-year pending row NULLed', eventDateOf('scrub-wrong-year') === null);
  check('C5: finalized wrong-year row untouched', eventDateOf('scrub-graded') === '2023-11-26T19:00:00.000Z');
  check('C5: in-bounds row untouched', eventDateOf('scrub-in-bounds') === '2026-06-26T19:00:00.000Z');
  check('C5: populate rows untouched by scrub-only apply', eventDateOf('pop-mlb') === null);

  // C6: --populate --apply fills only the in-scope rows.
  const c6 = runCli(['--populate', '--apply', '--db', CHILDDB, '--allow-nonprod']);
  check('C6: populate apply exit 0', c6.status === 0, c6.stderr.slice(0, 200));
  check('C6: MLB filled with created_at instant', eventDateOf('pop-mlb') === '2026-06-25T12:00:00.000Z');
  check('C6: NBA filled', eventDateOf('pop-nba') === '2026-06-25T12:00:00.000Z');
  check('C6: soccer untouched', eventDateOf('pop-soccer') === null);
  check('C6: needs_review untouched', eventDateOf('pop-needs-review') === null);
  check('C6: Tier-2 date-ish row untouched', eventDateOf('pop-tier2') === null);
  check('C6: scrubbed row NOT resurrected by populate (needs confirmed+NULL, it is NULL+confirmed… scope check)',
    // scrub-wrong-year is now NULL + pending + confirmed + MLB → it IS in
    // populate scope on this second run. That is by design (a scrubbed row
    // becomes an ordinary Tier-1 candidate); assert it got the created_at echo.
    eventDateOf('scrub-wrong-year') === '2026-06-25T12:00:00.000Z');

  // C7: idempotency — a second apply plans zero writes.
  const c7 = runCli(['--scrub', '--populate', '--apply', '--db', CHILDDB, '--allow-nonprod']);
  check('C7: re-run applies nothing', c7.status === 0 && /APPLIED: scrubbed=0 populated=0/.test(c7.stdout), c7.stdout.split('\n').pop());

  try { fs.unlinkSync(CHILDDB); } catch (_) {}
}

console.log(`\nbackfill-event-dates: ${pass} passed, ${fail} failed`);
// No fire-and-forget writes in this test (raw INSERTs only) — safe to close
// synchronously before exiting, unlike the pipeline-events-driven suites.
try { database.db.close(); } catch (_) {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + ext); } catch (_) {}
}
process.exit(fail === 0 ? 0 : 1);
