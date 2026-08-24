'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = () => Promise.reject(new Error('offline-test-no-network'));

const DB_FILE = path.join(os.tmpdir(), `user-bet-settlement-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.REAPER_MODE = 'off';

const database = require('../services/database');
const grading = require('../services/grading');
const { applyGradeOverride } = require('../services/gradeOverride');
const { calculateUserBetSettlement } = require('../services/userBetSettlement');

const {
  db,
  createBet,
  getOrCreateCapper,
  gradeBet,
  upsertUserBet,
  getUserBankroll,
  getUserBets,
  getUserBetSettlementSummary,
  revertBetToPending,
  getBankroll,
  updateBankroll,
  saveDailySnapshot,
} = database;

const CAPPER = getOrCreateCapper('community_settlement_capper', 'Community Settlement', null);
let sequence = 0;

function near(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`);
}

function seedBet(fields = {}) {
  sequence += 1;
  const bet = createBet({
    capper_id: CAPPER.id,
    sport: 'NBA',
    bet_type: 'straight',
    description: `Community settlement test ${sequence}`,
    odds: -110,
    units: 1,
    source: 'user_bet_settlement_test',
    source_message_id: `ubs-${process.pid}-${sequence}`,
    review_status: 'confirmed',
    ...fields,
  });
  assert.ok(bet?.id && !bet._deduped, 'seed must create a fresh bet');
  return bet;
}

function userBet(userId, betId) {
  return db.prepare(`
    SELECT ub.*, s.parent_result, s.profit_units
    FROM user_bets ub
    LEFT JOIN user_bet_settlements s ON s.user_bet_id = ub.id
    WHERE ub.user_id = ? AND ub.bet_id = ?
  `).get(userId, betId);
}

function settlementCount(betId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM user_bet_settlements s
    JOIN user_bets ub ON ub.id = s.user_bet_id
    WHERE ub.bet_id = ?
  `).get(betId).n;
}

async function main() {
  console.log('user-bet settlement');

  assert.deepStrictEqual(
    calculateUserBetSettlement('tail', 'win', -110, 2),
    { status: 'won', profitUnits: 2 * (100 / 110) },
  );
  assert.deepStrictEqual(
    calculateUserBetSettlement('fade', 'loss', 150, 2),
    { status: 'won', profitUnits: 3 },
  );
  assert.deepStrictEqual(
    calculateUserBetSettlement('fade', 'win', -110, 2),
    { status: 'lost', profitUnits: -2 },
  );
  assert.deepStrictEqual(
    calculateUserBetSettlement('tail', 'void', -110, 2),
    { status: 'push', profitUnits: 0 },
  );
  console.log('  PASS pure Tail/Fade outcome and odds table');

  const corrected = seedBet({ odds: -110 });
  upsertUserBet('tail-user', corrected.id, 'tail', 2);
  upsertUserBet('fade-user', corrected.id, 'fade', 1);

  const first = gradeBet(corrected.id, 'win', grading.calcProfit(-110, 1, 'win'), 'B', 'test win');
  assert.strictEqual(first.graded, true);
  assert.deepStrictEqual(
    { total: first.userSettlement.total, tailers: first.userSettlement.tailers, faders: first.userSettlement.faders, changed: first.userSettlement.changed },
    { total: 2, tailers: 1, faders: 1, changed: 2 },
  );
  assert.strictEqual(userBet('tail-user', corrected.id).status, 'won');
  assert.strictEqual(userBet('fade-user', corrected.id).status, 'lost');
  near(getUserBankroll('tail-user'), 100 + (2 * 100 / 110), 'tail WIN bankroll');
  near(getUserBankroll('fade-user'), 99, 'fade LOSS bankroll');
  assert.strictEqual(settlementCount(corrected.id), 2);

  const duplicate = gradeBet(corrected.id, 'win', grading.calcProfit(-110, 1, 'win'), 'B', 'duplicate');
  assert.strictEqual(duplicate.graded, false, 'second parent grade must no-op');
  near(getUserBankroll('tail-user'), 100 + (2 * 100 / 110), 'duplicate grade leaves tail bankroll');
  near(getUserBankroll('fade-user'), 99, 'duplicate grade leaves fade bankroll');
  console.log('  PASS first grade settles atomically and duplicate grade is inert');

  const override = applyGradeOverride(
    { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit: grading.calcProfit },
    { betId: corrected.id, result: 'loss', reason: 'corrected test result', invokerId: 'owner-test' },
  );
  assert.strictEqual(override.ok, true);
  assert.strictEqual(override.userSettlement.changed, 2);
  assert.strictEqual(userBet('tail-user', corrected.id).status, 'lost');
  assert.strictEqual(userBet('fade-user', corrected.id).status, 'won');
  near(getUserBankroll('tail-user'), 98, 'correction replaces tail P/L');
  near(getUserBankroll('fade-user'), 100 + (100 / 110), 'correction replaces fade P/L');

  const sameOverride = applyGradeOverride(
    { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit: grading.calcProfit },
    { betId: corrected.id, result: 'loss', reason: 'same result', invokerId: 'owner-test' },
  );
  assert.strictEqual(sameOverride.idempotent, true);
  assert.strictEqual(sameOverride.userSettlement.changed, 0);
  near(getUserBankroll('tail-user'), 98, 'same correction leaves tail bankroll');
  near(getUserBankroll('fade-user'), 100 + (100 / 110), 'same correction leaves fade bankroll');
  console.log('  PASS grade correction applies only the community P/L delta');

  assert.strictEqual(revertBetToPending(corrected.id, 'test revert'), true);
  assert.strictEqual(userBet('tail-user', corrected.id).status, 'pending');
  assert.strictEqual(userBet('fade-user', corrected.id).status, 'pending');
  assert.strictEqual(settlementCount(corrected.id), 0);
  near(getUserBankroll('tail-user'), 100, 'revert restores tail bankroll');
  near(getUserBankroll('fade-user'), 100, 'revert restores fade bankroll');

  const regraded = gradeBet(corrected.id, 'push', 0, 'N/A', 'test push');
  assert.strictEqual(regraded.graded, true);
  assert.strictEqual(userBet('tail-user', corrected.id).status, 'push');
  assert.strictEqual(userBet('fade-user', corrected.id).status, 'push');
  near(getUserBankroll('tail-user'), 100, 'push is neutral for tail');
  near(getUserBankroll('fade-user'), 100, 'push is neutral for fade');
  console.log('  PASS revert reverses ledger P/L and a new grade settles once');

  const oppositePrice = seedBet({ odds: 150 });
  upsertUserBet('tail-loss-user', oppositePrice.id, 'tail', 3);
  upsertUserBet('fade-win-user', oppositePrice.id, 'fade', 2);
  gradeBet(oppositePrice.id, 'loss', -1, 'D', 'test loss');
  near(getUserBankroll('tail-loss-user'), 97, 'tail loss debits declared risk');
  near(getUserBankroll('fade-win-user'), 103, 'fade win uses stored +150 price');
  console.log('  PASS Fade wins at the stored pick price');

  const autoVoid = seedBet();
  upsertUserBet('void-tail-user', autoVoid.id, 'tail', 4);
  upsertUserBet('void-fade-user', autoVoid.id, 'fade', 1);
  grading.autoVoidNoSearchableData(autoVoid, { attempts: 7, hours: 24 });
  assert.strictEqual(db.prepare('SELECT result FROM bets WHERE id = ?').get(autoVoid.id).result, 'void');
  assert.strictEqual(userBet('void-tail-user', autoVoid.id).status, 'push');
  assert.strictEqual(userBet('void-fade-user', autoVoid.id).status, 'push');
  near(getUserBankroll('void-tail-user'), 100, 'auto-void tail is neutral');
  near(getUserBankroll('void-fade-user'), 100, 'auto-void fade is neutral');
  console.log('  PASS direct autonomous VOID writer settles community rows');

  assert.throws(
    () => upsertUserBet('late-user', oppositePrice.id, 'tail', 1),
    err => err?.code === 'BET_ALREADY_SETTLED',
    'late Tail/Fade writes must be rejected after parent settlement',
  );

  const summary = getUserBetSettlementSummary(oppositePrice.id);
  assert.deepStrictEqual(
    { total: summary.total, tailers: summary.tailers, faders: summary.faders, won: summary.won, lost: summary.lost },
    { total: 2, tailers: 1, faders: 1, won: 1, lost: 1 },
  );
  near(summary.tailProfitUnits, -3, 'summary tail P/L');
  near(summary.fadeProfitUnits, 3, 'summary fade P/L');
  const mine = getUserBets('fade-win-user').find(row => row.bet_id === oppositePrice.id);
  assert.strictEqual(mine.status, 'won');
  near(mine.profit_units, 3, '/mybets query exposes user P/L, not parent P/L');
  console.log('  PASS summaries expose settled user status/P/L and reject late actions');

  console.log('user-bet settlement: all checks passed');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { db.close(); } catch (_) {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (fs.existsSync(`${DB_FILE}${suffix}`)) fs.unlinkSync(`${DB_FILE}${suffix}`); } catch (_) {}
    }
  });
