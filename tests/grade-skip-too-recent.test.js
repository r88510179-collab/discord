// ═══════════════════════════════════════════════════════════
// SKIP_TOO_RECENT audit-suppression test (P1 — bet-idempotency).
//
// The TOO_RECENT time-gate fires every poll while a bet sits inside
// the 3h window, so the prior behaviour wrote one grading_audit row
// per ~10s per pending bet (Apr 14 baseline: 13 rows/10min). We
// keep recordDrop (pipeline_events visibility) but stop calling
// writeAudit on this path, and emit a structured `grade.skip_too_recent`
// log line for observability.
//
// This test invokes gradePropWithAI on a real-shaped bet whose
// event_date is 1h ago and asserts:
//   1. result is PENDING with the too-soon evidence string
//   2. grading_audit count for that bet is unchanged after the call
//   3. stdout contains the structured `grade.skip_too_recent` line
//      and includes the bet id
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the test from the dev DB. Must be set BEFORE requiring
// services/database.js (which reads DB_PATH at module load).
const DB_PATH = path.join(os.tmpdir(), `bet-skip-too-recent-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
}

const { db } = require('../services/database');
const { gradePropWithAI } = require('../services/grading');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

console.log('grade-skip-too-recent:');

// Capture stdout so we can assert the structured log appears.
let captured = '';
const realWrite = process.stdout.write.bind(process.stdout);
function startCapture() {
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return realWrite(chunk, ...rest);
  };
}
function stopCapture() {
  process.stdout.write = realWrite;
}

(async () => {
  const capperId = 'capper-skip-too-recent';
  const betId = 'bet-skip-too-recent-1';
  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Seed capper + bet. Lakers ML is in the NBA team-keyword set, so
  // reclassifySport keeps sport=NBA and isSupportedSport allows it
  // through to gradeSingleBet where the TOO_RECENT block lives.
  db.prepare('INSERT OR REPLACE INTO cappers (id, display_name) VALUES (?, ?)').run(capperId, 'Test Capper');
  db.prepare(
    `INSERT OR REPLACE INTO bets (id, capper_id, sport, bet_type, description, event_date, created_at, result)
     VALUES (?, ?, 'NBA', 'straight', 'Lakers ML -110', ?, ?, 'pending')`,
  ).run(betId, capperId, oneHourAgoIso, oneHourAgoIso);

  const before = db.prepare('SELECT COUNT(*) AS c FROM grading_audit WHERE bet_id = ?').get(betId).c;
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);

  let result;
  startCapture();
  try {
    result = await gradePropWithAI(bet);
  } finally {
    stopCapture();
  }

  const after = db.prepare('SELECT COUNT(*) AS c FROM grading_audit WHERE bet_id = ?').get(betId).c;

  check(
    'returns PENDING with "too soon to grade" evidence',
    result && result.status === 'PENDING' && /too soon to grade/i.test(result.evidence || ''),
    `result=${JSON.stringify(result)}`,
  );

  check(
    'grading_audit count unchanged for TOO_RECENT skip',
    after === before,
    `before=${before} after=${after}`,
  );

  check(
    'stdout contains structured grade.skip_too_recent log',
    /grade\.skip_too_recent/.test(captured),
    `captured ${captured.length} bytes; no match`,
  );

  check(
    'structured log includes betId',
    new RegExp(`grade\\.skip_too_recent[^\\n]*betId=${betId}`).test(captured),
    `betId not in skip log`,
  );

  // Cleanup so re-runs start clean.
  try { db.close(); } catch (_) {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  stopCapture();
  console.error('test crashed:', err);
  process.exit(2);
});
