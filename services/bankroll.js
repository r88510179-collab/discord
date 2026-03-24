// ═══════════════════════════════════════════════════════════
// Bankroll Guardian — Fractional Kelly Criterion
// Recommends optimal bet sizing based on edge and bankroll.
// Uses Quarter Kelly (0.25x) for conservative risk management.
// ═══════════════════════════════════════════════════════════

const KELLY_FRACTION = 0.25; // Quarter Kelly
const MIN_GRADED_BETS = 5;   // Need this many bets for reliable win rate
const ASSUMED_EDGE = 0.02;   // 2% edge assumption for new cappers

/**
 * Convert American odds to decimal odds.
 * +150 → 2.50, -110 → 1.909
 */
function americanToDecimal(odds) {
  if (!odds || odds === 0) return 2.0; // default even money
  if (odds > 0) return (odds / 100) + 1;
  return (100 / Math.abs(odds)) + 1;
}

/**
 * Get the implied probability from American odds (no-vig).
 * -110 → ~0.524, +150 → ~0.40
 */
function impliedProbability(odds) {
  if (!odds || odds === 0) return 0.5;
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

/**
 * Calculate optimal bet amount using Fractional Kelly Criterion.
 *
 * @param {number} odds — American odds (e.g., -110, +150)
 * @param {number} availableCash — available bankroll in dollars
 * @param {number|null} capperWinRate — capper's win rate as decimal (0.55 = 55%), or null if unknown
 * @param {number} gradedBets — number of graded bets the capper has
 * @returns {{ amount: number, fraction: number, edge: number, isNegativeEV: boolean }}
 */
function calculateOptimalBet(odds, availableCash, capperWinRate, gradedBets = 0) {
  if (!availableCash || availableCash <= 0) {
    return { amount: 0, fraction: 0, edge: 0, isNegativeEV: true };
  }

  // b = net decimal odds (what you win per $1 wagered)
  const b = americanToDecimal(odds) - 1;

  // p = probability of winning
  let p;
  if (capperWinRate && gradedBets >= MIN_GRADED_BETS) {
    // Use actual capper win rate
    p = capperWinRate;
  } else {
    // New capper: use implied probability + assumed edge
    p = impliedProbability(odds) + ASSUMED_EDGE;
  }

  // q = probability of losing
  const q = 1 - p;

  // Kelly formula: f* = (bp - q) / b
  const kellyFraction = (b * p - q) / b;

  // Negative EV — Kelly says don't bet
  if (kellyFraction <= 0) {
    return { amount: 0, fraction: 0, edge: kellyFraction, isNegativeEV: true };
  }

  // Apply Quarter Kelly for safety
  const safeFraction = kellyFraction * KELLY_FRACTION;

  // Cap at 5% of bankroll regardless (safety ceiling)
  const cappedFraction = Math.min(safeFraction, 0.05);

  const amount = Math.round(availableCash * cappedFraction * 100) / 100;

  return {
    amount: Math.max(amount, 0),
    fraction: cappedFraction,
    edge: kellyFraction,
    isNegativeEV: false,
  };
}

module.exports = { calculateOptimalBet, americanToDecimal, impliedProbability };
