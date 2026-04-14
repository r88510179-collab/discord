const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-reliability-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const database = require('../services/database');

function run() {
  const capper = database.getOrCreateCapper('discord_user_1', 'Capper One', null);

  const baseBet = {
    capper_id: capper.id,
    sport: 'NBA',
    league: 'NBA',
    bet_type: 'straight',
    description: 'Lakers -3.5',
    odds: -110,
    units: 1,
    source_channel_id: 'channel_1',
    source_message_id: 'message_1',
    raw_text: 'Lakers -3.5 -110 1u',
  };

  // 1) Same message processed twice should be idempotent.
  const first = database.createBetWithLegs({ ...baseBet, source: 'discord' }, []);
  const second = database.createBetWithLegs({ ...baseBet, source: 'discord' }, []);
  assert.strictEqual(second.id, first.id, 'same message processed twice should return existing bet');

  // 2) Text + image from same message should also be idempotent.
  const textBet = database.createBetWithLegs({ ...baseBet, source: 'discord' }, []);
  const slipBet = database.createBetWithLegs({ ...baseBet, source: 'slip' }, []);
  assert.strictEqual(slipBet.id, textBet.id, 'text and image from same message should dedupe');

  const totalStored = database.db.prepare('SELECT COUNT(*) as c FROM bets').get().c;
  assert.strictEqual(totalStored, 1, 'only one bet row should exist for duplicated ingestion paths');

  // 3) Repeated grading pass should ignore already-graded bets.
  const pendingBet = database.createBet({
    capper_id: capper.id,
    sport: 'NBA',
    bet_type: 'straight',
    description: 'Celtics ML',
    odds: -125,
    units: 1,
    source: 'manual',
  });

  assert.ok(database.getAllPendingBets().some((b) => b.id === pendingBet.id), 'new bet should start pending');

  database.gradeBet(pendingBet.id, 'win', 0.8, 'B', 'Covered in regulation');
  assert.ok(!database.getAllPendingBets().some((b) => b.id === pendingBet.id), 'graded bet should be excluded from pending list');

  // Simulate repeat grading cycle query.
  const pendingAfterRepeat = database.getAllPendingBets().filter((b) => b.id === pendingBet.id);
  assert.strictEqual(pendingAfterRepeat.length, 0, 'repeat grading passes should not re-queue graded bets');

  console.log('Reliability validation passed.');
}

try {
  run();
} finally {
  database.db.close();
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
}
