// services/sportsdata/terminalState.js
// ── Structured-grader terminal-state policy (authoritative-negative bucket) ──
//
// A structured prop grader returns { resolved:false, reason } for every case it
// cannot settle, and grading.js's STRUCTURED PRE-CHECK then FALLS THROUGH to web
// search + LLM. For most reasons that is correct. But for a player who provably
// did NOT appear in any game on the bet's date, search is GUARANTEED to find
// nothing (there is no box-score line to read), so the bet loops forever —
// burning a search + LLM call every cycle. Live: bet 0f50c2bf's leg
// "Ramon Laureano O 0.5 Hits" on 2026-05-31 — 15 MLB games were played and his
// team (Padres) played, but he did not appear (no game-log entry, per statsapi).
//
// Resolution rule (Smokke): a player who did not play had NO ACTION, so the prop
// VOIDs — stake returned, does not count for or against the capper — regardless
// of market or direction. VOID, never LOSS, never search. In a parlay a VOID leg
// REDUCES the parlay (drops out; the remaining legs decide the result) — see
// reduceParlayResult in services/grading.js.
//
// ── The bucketing decision (keep it CONSERVATIVE) ──
// This is the single, deliberate place that decides which "not found" outcomes
// are authoritative enough to HARD-SETTLE a bet as VOID. Be conservative: a
// false VOID erases a real result, so when in doubt, fall through (under-voiding
// is the safe error).
//
//   AUTHORITATIVE-NEGATIVE → VOID. The official feed DEFINITIVELY establishes
//   the player did not play. The ONLY member is provable absence
//   (isProvableAbsence below): the full slate of games on the date is FINAL,
//   every box score was fetched successfully, and the player is in none of them.
//   A bare "player not found" is NOT enough — see the indeterminate cases.
//
//   GENUINELY-INDETERMINATE → keep falling through. The API/network errored
//   (adapter_error / a feed fetch we had to skip — the player could be hiding in
//   the game we could not read); no games were found on the date (often a
//   date-resolution mismatch, not a real absence); a game is not yet final (the
//   player may still appear); the bet's created_at and event_date disagree, so
//   the slate we checked may be the wrong day (the caller forbids the VOID via
//   opts.absenceVoidAllowed — see tryStructured); the name was unresolved/
//   misparsed; the prop was unparseable; the stat was unknown or absent from the
//   box score (the player DID play). None of these prove absence, so none may
//   hard-settle a bet.
//
// Every reason an adapter emits as { resolved:false, reason } stays a fall-
// through — including player_not_found_in_games_on_date, which now fires ONLY for
// the indeterminate residue above. The authoritative VOID is emitted as a
// resolved:true status (voidPlayerDidNotPlay), not as a fall-through reason.

// Pure predicate: is the player's absence on the date PROVABLE (→ VOID)?
//   gamesOnDate   number of games scheduled on the date
//   allFinal      every one of those games reached a final state
//   anyFetchError any per-game box-score fetch failed (so a game went unread)
// Provable iff there were games, the entire slate is final, and we read every
// box score. If any game is still live the player may yet appear; if a fetch
// failed the player may be hiding in the game we could not read; if there were
// no games the date itself is suspect. Any of those → indeterminate, not VOID.
function isProvableAbsence({ gamesOnDate, allFinal, anyFetchError } = {}) {
  return Number(gamesOnDate) > 0 && allFinal === true && anyFetchError === false;
}

// Build the VOID contract for a player who WAS rostered for a game that occurred
// but did NOT take the court — a CONFIRMED DNP (coach's decision / inactive),
// established from the box score's authoritative did-not-play flag (NOT an all-
// zero stat line, which is a player who played and produced nothing). Same "no
// action, void" semantics as an absent player; only the evidence wording differs
// (we located their game, so no slate/date qualifier is needed). See the NBA
// grader. Per Smokke's rule (PR #128): a player who did not play VOIDs, never LOSS.
function voidPlayerInactive(playerName, source) {
  return {
    resolved: true,
    status: 'VOID',
    evidence: `${playerName} did not play — no action, void.`,
    source,
  };
}

// Build the VOID contract for a player who provably did not appear in any game
// on the date. Matches the structured contract { resolved, status, evidence,
// source } so grading.js's structured pre-check uses it directly (no fall-
// through). The evidence names the player, the date, and the slate size.
function voidPlayerDidNotPlay(playerName, dateYMD, gameCount, leagueLabel, source) {
  const n = Number(gameCount);
  const games = Number.isFinite(n) && n > 0
    ? `any of the ${n} ${leagueLabel} game${n === 1 ? '' : 's'}`
    : `any ${leagueLabel} game`;
  return {
    resolved: true,
    status: 'VOID',
    evidence: `${playerName} did not appear in ${games} on ${dateYMD} (all final) — no action, void.`,
    source,
  };
}

module.exports = { isProvableAbsence, voidPlayerDidNotPlay, voidPlayerInactive };
