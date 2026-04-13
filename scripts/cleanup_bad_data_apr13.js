// One-time cleanup for data integrity issues identified in audit 2026-04-13
// Safe to run once. Idempotent — re-running is a no-op after first success.
// Run via: fly ssh console -a bettracker-discord-bot -C "node /app/scripts/cleanup_bad_data_apr13.js"

const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/bettracker.db');

function calcProfit(odds, units, result) {
  if (result === 'void' || result === 'push') return 0;
  if (result === 'loss') return -units;
  if (result === 'win') {
    return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
  }
  return 0;
}

console.log('=== Cleanup: cash-as-units bets ===');
// Bets with units > 50 are cash values that leaked into units field.
// Move cash to wager, set units to 1, recompute profit using stored odds (or -110 default)
const cashLeaks = db.prepare(`
  SELECT id, description, units, wager, odds, result, profit_units
  FROM bets WHERE CAST(units AS REAL) > 50 OR units = 'N/A'
`).all();

for (const bet of cashLeaks) {
  const cashValue = bet.units === 'N/A' ? null : parseFloat(bet.units);
  const oddsNum = typeof bet.odds === 'number' ? bet.odds : -110;
  const newUnits = 1;
  const newWager = cashValue && cashValue > 10 ? cashValue : bet.wager;
  const newProfit = calcProfit(oddsNum, newUnits, bet.result);

  console.log(`  Fixing ${bet.id.slice(0, 12)} | was: units=${bet.units} profit=${bet.profit_units}`);
  console.log(`           | now: units=${newUnits} wager=${newWager} profit=${newProfit.toFixed(2)}`);

  db.prepare(`
    UPDATE bets SET units = ?, wager = ?, profit_units = ? WHERE id = ?
  `).run(newUnits, newWager, newProfit, bet.id);
}

console.log(`\nFixed ${cashLeaks.length} cash-leak bets.\n`);

console.log('=== Cleanup: odds="N/A" (text in INTEGER column) ===');
// Coerce text 'N/A' to NULL. If bet was graded WIN with 0 profit, recompute with -110 default.
const odds_na = db.prepare(`
  SELECT id, description, units, odds, result, profit_units
  FROM bets WHERE typeof(odds) = 'text'
`).all();

for (const bet of odds_na) {
  const units = typeof bet.units === 'number' ? bet.units : 1;
  // Use -110 as default odds for text 'N/A' bets (spread/total standard)
  const defaultOdds = -110;
  const newProfit = calcProfit(defaultOdds, units, bet.result);

  console.log(`  Fixing ${bet.id.slice(0, 12)} | was: odds='${bet.odds}' profit=${bet.profit_units}`);
  console.log(`           | now: odds=${defaultOdds} profit=${newProfit.toFixed(2)}`);

  db.prepare(`
    UPDATE bets SET odds = ?, profit_units = ? WHERE id = ?
  `).run(defaultOdds, newProfit, bet.id);
}

console.log(`\nFixed ${odds_na.length} odds='N/A' bets.\n`);

console.log('=== Cleanup: WIN bets with 0 profit ===');
const winZero = db.prepare(`
  SELECT id, description, units, odds, result, profit_units
  FROM bets WHERE result = 'win' AND (profit_units = 0 OR profit_units IS NULL)
`).all();

for (const bet of winZero) {
  const units = typeof bet.units === 'number' && bet.units > 0 ? bet.units : 1;
  const odds = typeof bet.odds === 'number' ? bet.odds : -110;
  const newProfit = calcProfit(odds, units, 'win');

  console.log(`  Fixing ${bet.id.slice(0, 12)} | was: profit=${bet.profit_units} odds=${bet.odds} units=${bet.units}`);
  console.log(`           | now: profit=${newProfit.toFixed(2)}`);

  db.prepare(`UPDATE bets SET profit_units = ? WHERE id = ?`).run(newProfit, bet.id);
}

console.log(`\nFixed ${winZero.length} WIN-with-0-profit bets.\n`);

console.log('=== Summary ===');
const stillBroken = db.prepare(`
  SELECT COUNT(*) as c FROM bets WHERE CAST(units AS REAL) > 50 OR units = 'N/A' OR typeof(odds) = 'text'
`).get();
console.log(`Remaining bad rows: ${stillBroken.c} (should be 0)`);

const winZeroProfit = db.prepare(`
  SELECT COUNT(*) as c FROM bets WHERE result='win' AND (profit_units = 0 OR profit_units IS NULL)
`).get();
console.log(`WIN bets with 0 profit: ${winZeroProfit.c}`);

db.close();
console.log('\nCleanup complete. Recommend: run /admin snapshot to verify leaderboard numbers.');
