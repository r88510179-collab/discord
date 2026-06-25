// ═══════════════════════════════════════════════════════════════
// Privileged grade override for ALREADY-FINALIZED bets.
//
// gradeBet() (services/database.js gradeBetRecord) is a no-op once a bet
// leaves 'pending' — its UPDATE is gated on `result = 'pending' OR result IS
// NULL`. So a bet that finalized to a WRONG result (e.g. a total leg graded
// against the prior-day game because event_date was null) can never be
// corrected through the normal grader. This module rewrites a graded bet's
// result/profit directly, in ONE transaction, archiving the prior state to
// bet_grade_history first.
//
// Pure + dependency-injected (no Discord, no module-level db) so it is
// unit-testable against a throwaway DB and reused verbatim by
// commands/grade.js. It deliberately does NOT call gradeBet().
//
// Idempotency: re-running with a result that already matches the stored result
// updates the reason only — it does NOT re-apply the bankroll delta or re-touch
// legs (which would double-count bankroll and double-append ' [overridden]').
// ═══════════════════════════════════════════════════════════════

const VALID_RESULTS = ['win', 'loss', 'push', 'void'];

/**
 * @param {object} deps - { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit }
 * @param {object} params - { betId, result, reason, invokerId }
 * @returns {object} on failure { ok:false, error } ; on success a summary the
 *   caller uses for the correction post + ephemeral reply.
 */
function applyGradeOverride(deps, { betId, result, reason, invokerId }) {
  const { db, getBankroll, updateBankroll, saveDailySnapshot, calcProfit } = deps;

  if (!VALID_RESULTS.includes(result)) return { ok: false, error: 'invalid_result' };
  // bet_grade_history.archived_by is NOT NULL — refuse rather than write a bad row.
  if (!invokerId) return { ok: false, error: 'missing_invoker' };

  // Load WITH the capper join so the correction post has capper_name/source.
  const bet = db.prepare(`
    SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE b.id = ?
  `).get(betId);

  if (!bet) return { ok: false, error: 'not_found' };
  // Override is for already-graded bets only; pending → use normal grading.
  if (bet.result == null || bet.result === 'pending') return { ok: false, error: 'pending' };

  const oldResult = bet.result;
  const oldProfit = parseFloat(bet.profit_units || 0);
  const effectiveReason = (reason && String(reason).trim()) ? String(reason).trim() : 'manual override';
  const gradeReason = `OVERRIDE: ${effectiveReason}`;
  // Parlay-only per spec (3.d names bet_type == 'parlay'). 'sgp' bets also carry
  // parlay_legs, but their leg rows are deliberately left untouched here — only
  // the bet-level result/profit/bankroll are corrected for any type. (The rest
  // of the codebase treats parlay+sgp alike; widening this is out of scope.)
  const isParlay = bet.bet_type === 'parlay';
  const alreadyThisResult = oldResult === result;

  // Profit recompute — ALWAYS via calcProfit(odds, units, result), which returns
  // a UNITS figure on the same scale as the `units` column. This is exactly how
  // the normal grader (finalizeBetGrading) and the manual /grade path compute
  // profit_units, so an override reproduces what a correct grade would have
  // stored. The row's payout/wager are raw slip DOLLARS on an unrelated scale (a
  // personal stake, not units × unit_size), so feeding them in here would corrupt
  // both ROI (Σ profit_units ÷ Σ units) and the bankroll delta below — which
  // multiplies a UNITS delta by unit_size (dollars-per-unit). No dollar figure may
  // land in profit_units. On an idempotent re-run we keep the stored value so the
  // bankroll delta is exactly 0.
  let newProfit;
  if (alreadyThisResult) {
    newProfit = oldProfit;
  } else {
    newProfit = calcProfit(bet.odds || -110, bet.units || 1, result);
  }

  const tx = db.transaction(() => {
    // a. Archive prior state (write-only audit log; never read by the grader).
    db.prepare(`
      INSERT INTO bet_grade_history
        (bet_id, old_result, old_profit_units, old_grade, old_grade_reason, old_graded_at, archived_by, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(bet.id, oldResult, bet.profit_units, bet.grade, bet.grade_reason, bet.graded_at, invokerId, effectiveReason);

    // c. Rewrite the bet directly (NOT gradeBet() — it no-ops on graded rows).
    db.prepare(`
      UPDATE bets SET result = ?, profit_units = ?, grade_reason = ?, graded_at = datetime('now')
      WHERE id = ?
    `).run(result, newProfit, gradeReason, bet.id);

    // d. Parlay legs: a parlay WIN logically requires every leg to win. Skip on
    //    an idempotent re-run so ' [overridden]' is not appended twice. For a
    //    non-win override we cannot infer WHICH leg lost, so legs are untouched.
    //    The marker is only appended if absent, so repeated win overrides across
    //    a win→loss→win cycle never accumulate ' [overridden] [overridden]'.
    //    (SQLite LIKE has no character classes — '[overridden]' is a literal.)
    let legsTouched = 0;
    if (!alreadyThisResult && isParlay && result === 'win') {
      const info = db.prepare(`
        UPDATE parlay_legs
        SET result = 'win',
            evidence = CASE
              WHEN COALESCE(evidence, '') LIKE '%[overridden]%' THEN evidence
              ELSE COALESCE(evidence, '') || ' [overridden]'
            END
        WHERE bet_id = ?
      `).run(bet.id);
      legsTouched = info.changes;
    }

    // e. Bankroll: shift `current` by the unit-denominated profit delta and
    //    re-snapshot. Skipped on an idempotent re-run (delta is 0) so it can
    //    never double-apply.
    let bankrollApplied = false;
    let bankrollDelta = 0;
    if (!alreadyThisResult) {
      const bankroll = getBankroll(bet.capper_id);
      if (bankroll) {
        bankrollDelta = (newProfit - oldProfit) * parseFloat(bankroll.unit_size);
        updateBankroll(bet.capper_id, bankrollDelta);
        saveDailySnapshot(bet.capper_id);
        bankrollApplied = true;
      }
    }
    return { legsTouched, bankrollApplied, bankrollDelta };
  });

  const { legsTouched, bankrollApplied, bankrollDelta } = tx();

  return {
    ok: true,
    bet,            // pre-update row (carries capper_name/source for the post)
    oldResult,
    newResult: result,
    oldProfit,
    newProfit,
    gradeReason,
    isParlay,
    legsTouched,
    bankrollApplied,
    bankrollDelta,
    idempotent: alreadyThisResult,
  };
}

module.exports = { applyGradeOverride, VALID_RESULTS };
