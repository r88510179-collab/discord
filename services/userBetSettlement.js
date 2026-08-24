'use strict';

const VALID_ACTIONS = new Set(['tail', 'fade']);
const VALID_RESULTS = new Set(['win', 'loss', 'push', 'void']);
const EPSILON = 1e-9;

function normalizeRisk(value) {
  const risk = Number(value);
  if (!Number.isFinite(risk) || risk <= 0) {
    throw new TypeError(`Invalid user-bet risk: ${value}`);
  }
  return risk;
}

function normalizeOdds(value) {
  const odds = Number(value);
  return Number.isFinite(odds) && odds !== 0 ? odds : -110;
}

function oddsProfit(odds, risk) {
  const price = normalizeOdds(odds);
  return price > 0
    ? risk * (price / 100)
    : risk * (100 / Math.abs(price));
}

/**
 * Resolve one community position against its parent bet.
 *
 * The database stores only the pick's quoted price, not a separately priced
 * opposite market. Tail and Fade therefore use that same stored price: the
 * side that is correct earns price-based profit and the wrong side loses its
 * declared risk. Push and void are bankroll-neutral.
 */
function calculateUserBetSettlement(action, parentResult, odds, riskAmount = 1) {
  const normalizedAction = String(action || '').toLowerCase();
  const normalizedResult = String(parentResult || '').toLowerCase();
  if (!VALID_ACTIONS.has(normalizedAction)) {
    throw new TypeError(`Invalid user-bet action: ${action}`);
  }
  if (!VALID_RESULTS.has(normalizedResult)) {
    throw new TypeError(`Invalid parent result: ${parentResult}`);
  }

  const risk = normalizeRisk(riskAmount);
  if (normalizedResult === 'push' || normalizedResult === 'void') {
    return { status: 'push', profitUnits: 0 };
  }

  const won = normalizedAction === 'tail'
    ? normalizedResult === 'win'
    : normalizedResult === 'loss';
  return {
    status: won ? 'won' : 'lost',
    profitUnits: won ? oddsProfit(odds, risk) : -risk,
  };
}

function emptySummary() {
  return {
    total: 0,
    tailers: 0,
    faders: 0,
    won: 0,
    lost: 0,
    pushes: 0,
    totalRiskUnits: 0,
    totalProfitUnits: 0,
    bankrollDelta: 0,
    changed: 0,
  };
}

/**
 * Reconcile every Tail/Fade row for a terminal parent result.
 *
 * Call this inside the same SQLite transaction as the parent grade. The ledger
 * makes repeat calls and terminal-result corrections safe: only the difference
 * between the newly calculated P/L and the recorded P/L reaches the bankroll.
 */
function reconcileUserBets(db, { betId, parentResult, odds }) {
  const result = String(parentResult || '').toLowerCase();
  if (!VALID_RESULTS.has(result)) {
    throw new TypeError(`Invalid parent result: ${parentResult}`);
  }

  const rows = db.prepare(`
    SELECT ub.id, ub.user_id, ub.action, ub.status,
           COALESCE(ub.risk_amount, 1.0) AS risk_amount,
           s.parent_result AS recorded_parent_result,
           s.profit_units AS recorded_profit_units
    FROM user_bets ub
    LEFT JOIN user_bet_settlements s ON s.user_bet_id = ub.id
    WHERE ub.bet_id = ?
    ORDER BY ub.id
  `).all(betId);
  if (rows.length === 0) return emptySummary();

  const ensureUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, bankroll) VALUES (?, 'Unknown', 100.0)",
  );
  const applyBankrollDelta = db.prepare('UPDATE users SET bankroll = bankroll + ? WHERE id = ?');
  const updateStatus = db.prepare('UPDATE user_bets SET status = ? WHERE id = ?');
  const upsertSettlement = db.prepare(`
    INSERT INTO user_bet_settlements (user_bet_id, parent_result, profit_units, settled_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_bet_id) DO UPDATE SET
      parent_result = excluded.parent_result,
      profit_units = excluded.profit_units,
      settled_at = excluded.settled_at
  `);

  const summary = emptySummary();
  for (const row of rows) {
    const risk = normalizeRisk(row.risk_amount);
    const target = calculateUserBetSettlement(row.action, result, odds, risk);
    const recordedProfit = row.recorded_profit_units == null
      ? 0
      : Number(row.recorded_profit_units);
    if (!Number.isFinite(recordedProfit)) {
      throw new TypeError(`Invalid recorded user-bet profit for row ${row.id}`);
    }
    const delta = target.profitUnits - recordedProfit;
    const needsWrite = row.status !== target.status
      || row.recorded_parent_result !== result
      || row.recorded_profit_units == null
      || Math.abs(delta) > EPSILON;

    ensureUser.run(row.user_id);
    if (Math.abs(delta) > EPSILON) {
      const applied = applyBankrollDelta.run(delta, row.user_id);
      if (applied.changes !== 1) {
        throw new Error(`Unable to apply user-bet bankroll delta for ${row.user_id}`);
      }
    }
    if (needsWrite) {
      updateStatus.run(target.status, row.id);
      upsertSettlement.run(row.id, result, target.profitUnits);
      summary.changed += 1;
    }

    summary.total += 1;
    summary.tailers += row.action === 'tail' ? 1 : 0;
    summary.faders += row.action === 'fade' ? 1 : 0;
    summary.won += target.status === 'won' ? 1 : 0;
    summary.lost += target.status === 'lost' ? 1 : 0;
    summary.pushes += target.status === 'push' ? 1 : 0;
    summary.totalRiskUnits += risk;
    summary.totalProfitUnits += target.profitUnits;
    summary.bankrollDelta += delta;
  }
  return summary;
}

/** Reverse ledger-backed community P/L and return positions to pending. */
function resetUserBetSettlements(db, betId) {
  const rows = db.prepare(`
    SELECT ub.id, ub.user_id, s.profit_units
    FROM user_bets ub
    LEFT JOIN user_bet_settlements s ON s.user_bet_id = ub.id
    WHERE ub.bet_id = ?
    ORDER BY ub.id
  `).all(betId);
  if (rows.length === 0) return { total: 0, reversed: 0, bankrollDelta: 0 };

  const applyBankrollDelta = db.prepare('UPDATE users SET bankroll = bankroll + ? WHERE id = ?');
  let reversed = 0;
  let bankrollDelta = 0;
  for (const row of rows) {
    if (row.profit_units == null) continue;
    const profit = Number(row.profit_units);
    if (!Number.isFinite(profit)) {
      throw new TypeError(`Invalid recorded user-bet profit for row ${row.id}`);
    }
    if (Math.abs(profit) > EPSILON) {
      const applied = applyBankrollDelta.run(-profit, row.user_id);
      if (applied.changes !== 1) {
        throw new Error(`Unable to reverse user-bet bankroll delta for ${row.user_id}`);
      }
      bankrollDelta -= profit;
    }
    reversed += 1;
  }

  db.prepare(`
    DELETE FROM user_bet_settlements
    WHERE user_bet_id IN (SELECT id FROM user_bets WHERE bet_id = ?)
  `).run(betId);
  db.prepare("UPDATE user_bets SET status = 'pending' WHERE bet_id = ?").run(betId);
  return { total: rows.length, reversed, bankrollDelta };
}

module.exports = {
  calculateUserBetSettlement,
  reconcileUserBets,
  resetUserBetSettlements,
};
