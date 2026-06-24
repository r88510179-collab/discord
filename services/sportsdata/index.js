// services/sportsdata/index.js
// Router: dispatches a bet to the right sport adapter.
// Contract: returns { resolved, status, evidence, source } or { resolved: false, reason }.
//
// Used by services/grading.js as a structured-data layer that runs BEFORE search+LLM.
// If resolved=true, the grader uses this result directly and skips the LLM.
// If resolved=false, the grader falls through to its existing search+LLM path.

const mlb = require('./mlb');
const nhl = require('./nhl');
const nba = require('./nba');
const { etParts } = require('../eventDate');

// Normalized sport → adapter, for prop-vs-team routing.
const ADAPTERS = { MLB: mlb, NBA: nba, NHL: nhl };

// Normalize sport string. The grader uses many spellings: "MLB", "NBA", "NHL", "Baseball", etc.
function normalizeSport(sport) {
  const s = String(sport || '').toUpperCase();
  if (s.includes('MLB') || s.includes('BASEBALL')) return 'MLB';
  if (s.includes('NBA') || s === 'BASKETBALL') return 'NBA';
  if (s.includes('NHL') || s === 'HOCKEY') return 'NHL';
  return null;
}

// Detect if a description is a player prop (single-player stat bet) vs a team-level bet.
// Heuristic: starts with a known team alias → team bet. Otherwise treat as player prop.
function isPlayerProp(description, sport) {
  const desc = description.toLowerCase().trim();
  // Heuristic 1: contains "O <num>" or "U <num>" or "N+" near a player-name-shaped start
  // Heuristic 2: contains explicit player-prop keywords
  const playerPropKeywords = [
    'anytime goal scorer', 'atgs',
    'hits+runs+rbi', 'h+r+rbi',
    'pra', 'pts + reb', 'pts + ast', 'reb + ast', 'pts+reb', 'pts+ast', 'reb+ast',
    'pitching outs', 'strikeouts', 'home run',
    'sog', 'shots on goal', 'saves',
  ];
  for (const kw of playerPropKeywords) {
    if (desc.includes(kw)) return true;
  }
  // Heuristic 3: bet has format "Name O 17.5 Stat" or "Name 2+ Stat"
  // Team bets typically have format "Team -1.5" or "Team ML" or "TeamA TeamB Over N"
  // The "N+" pattern strongly suggests a player prop (no team bet uses "2+")
  if (/\s\d+\+\s+/.test(desc)) return true;
  return false;
}

// Prop-vs-team routing decision (testable helper).
// Union of the keyword/"N+" heuristic (isPlayerProp) and the authoritative per-sport
// parser (adapter.looksLikePlayerProp). isPlayerProp misses the "O/U N <stat>" shape
// — it has no bare stat keywords and its only numeric pattern needs a literal "+", so
// "Aaron Judge O 0.5 Hits" returns false and gets sent to the team grader → no team
// found → search+LLM → Gate 3 forces PENDING. Delegating to the parser closes that gap
// so the router and parser can never disagree; the adapter's looksLikePlayerProp guards
// team totals ("Dodgers Over 8.5 Runs") so they still route to the team grader.
// Purely additive: anything isPlayerProp already routed to props still does.
function isPropBet(description, sport) {
  if (!description) return false;
  if (isPlayerProp(description, sport)) return true;
  const adapter = ADAPTERS[normalizeSport(sport)];
  if (adapter && typeof adapter.looksLikePlayerProp === 'function') {
    return adapter.looksLikePlayerProp(description);
  }
  return false;
}

// Coerce a single date-ish string to YYYY-MM-DD (or null).
function toYMD(src) {
  if (!src) return null;
  // created_at format: "2026-04-07 16:24:37"
  if (/^\d{4}-\d{2}-\d{2}/.test(src)) return src.slice(0, 10);
  // event_date format: "07 Apr 2026 22:00" or ISO — try Date parse
  const d = new Date(src);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Extract a YYYY-MM-DD date from a bet row.
// Prefers created_at (always populated), falls back to event_date.
function getBetDate(bet) {
  return toYMD(bet.created_at || bet.event_date);
}

// ── EVENT_DATE_SLATE (root-cause fix) ────────────────────────────────────────
// The structured slate date drives WHICH day's full final game slate the prop
// adapters query. Historically it keyed off getBetDate() (created_at-first), but
// grading.js's future/too-recent GUARDs key off event_date — so a pick posted the
// night before / on a back-to-back (created_at = day N, event_date = N+1) makes the
// structured layer query the WRONG day. The player's game is on N+1, so they read as
// "absent" from N's slate; both DNP band-aids (#128/#129) therefore FORBID the VOID
// and fall through (looping / mis-sweeping), and even a normal prop for a player who
// played on N+1 isn't found in N's games. Aligning the slate with event_date queries
// the actual game day, so absence/DNP VOID and normal grading all become correct and
// the two date-gates collapse.
//
// Tri-state env flag EVENT_DATE_SLATE (strict compare; unset/unknown → 'off'):
//   off     (default) — slate = getBetDate() (created_at-first). absenceVoidAllowed =
//                       Boolean(eventYMD && createdYMD === eventYMD) (present AND same
//                       day). Current behavior exactly — ZERO change; merge is a no-op.
//   shadow            — REAL result = 'off' behavior. Additionally, on the divergent
//                       population (the bet's ET GAME date is present AND differs from
//                       created_at's day — the bets 'enforce' would re-slate) emit one
//                       fire-and-forget 'slate_shadow' pipeline_events row. No result
//                       change.
//   enforce           — slate = eventEtYMD || createdYMD (event_date-first, created_at
//                       fallback). absenceVoidAllowed = Boolean(eventEtYMD): a present
//                       event_date IS the trustworthy slate, so same-day is no longer
//                       required. mlb/nba/nhl already read opts.absenceVoidAllowed !==
//                       false, so they inherit the corrected meaning with no per-adapter
//                       change.
//
// CRITICAL — the slate date must be the GAME's ET calendar date, NOT a UTC slice.
// event_date is stored in UTC (normalizeEventDateForStorage → .toISOString()), but the
// sports-data slates (statsapi schedule?date=, ESPN scoreboard?dates=) are keyed by the
// game's ET date. Slicing the UTC ISO (toYMD) rolls a ≥8 PM ET game FORWARD a day, so
// enforce would query the wrong slate and false-VOID the player as "absent". eventEtYMD
// resolves event_date in America/New_York (etParts) to get the real game day. (off keeps
// toYMD-based eventYMD verbatim for byte-equivalence — it only uses it for the same-day
// comparison, never to fetch, so the roll there is inert.)
//
// Irreducible residual under enforce: a NULL event_date still can't anchor the slate
// → slate falls back to createdYMD and absenceVoidAllowed = false → falls through,
// same as today. The real cure is populating event_date at ingest (out of scope here).
function eventDateSlateMode() {
  const m = process.env.EVENT_DATE_SLATE;
  if (m === 'shadow') return 'shadow';
  if (m === 'enforce') return 'enforce';
  return 'off';
}

// The event's ET calendar date (YYYY-MM-DD) — the day the sports-data slate is keyed
// by. event_date is a UTC instant; etParts (services/eventDate.js) resolves it in
// America/New_York so a ≥8 PM ET game keeps its real game day instead of rolling to the
// next UTC day. Returns null for a missing/unparseable date.
function eventEtYMD(eventDate) {
  if (!eventDate) return null;
  const d = new Date(eventDate);
  if (isNaN(d.getTime())) return null;
  const p = etParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Shadow telemetry for EVENT_DATE_SLATE (measure before flip). One fire-and-forget,
// error-swallowed pipeline_events row per divergent bet. event_type 'slate_shadow' is
// registered in services/pipeline-events.js; written via bets.transitionTo under
// sourceType='grading' (null ingest_id). LAZY-required so 'off' (the default) never
// pulls the DB/bets layer into this pure adapter module. Never throws — observability
// must not affect grading control flow.
function emitSlateShadow(betId, payload) {
  if (!betId) return;
  try {
    const bets = require('../bets');
    bets.transitionTo({
      betId,
      toStage: 'GRADING_ENTER',
      eventType: 'slate_shadow',
      payload,
    });
  } catch (_) { /* observability must not break grading */ }
}

// Main entry point.
// bet = { description, sport, created_at, event_date }
// Returns the contract object.
async function tryStructured(bet) {
  if (!bet || !bet.description) {
    return { resolved: false, reason: 'no_description' };
  }

  const sport = normalizeSport(bet.sport);
  if (!sport) return { resolved: false, reason: 'sport_not_supported' };

  const createdYMD = toYMD(bet.created_at);
  const eventYMD = toYMD(bet.event_date);
  const slateMode = eventDateSlateMode();

  // Slate date + absence-VOID gate, selected by EVENT_DATE_SLATE (see the mode table
  // above). The adapter call SIGNATURE is unchanged across all modes — only the slate
  // date VALUE and the absenceVoidAllowed flag differ. A prop grader may VOID a player
  // provably absent from the slate's full final slate (terminalState.js); the flag
  // governs whether that VOID is trustworthy for this bet's date. eventEtYMD (the GAME's
  // ET date) is computed ONLY in the enforce/shadow paths, so the off path is provably
  // unchanged from main (no new call, no new side effect).
  let slateYMD;
  let absenceVoidAllowed;
  if (slateMode === 'enforce') {
    // event_date-first, in the GAME's ET calendar: query the ACTUAL game day. A present
    // event_date is the trustworthy slate, so it alone allows the absence/DNP VOID
    // (same-day no longer required). A null/unparseable event_date falls back to
    // created_at with the VOID forbidden — the residual the comment above notes.
    const evEt = eventEtYMD(bet.event_date);
    slateYMD = evEt || createdYMD;
    absenceVoidAllowed = Boolean(evEt);
  } else {
    // off + shadow share the REAL (current) behavior. The slate keys off created_at
    // (getBetDate); the absence VOID is only allowed when event_date is PRESENT and
    // lands on the SAME day as created_at. DIFFERENT days (a pick posted the night
    // before — the slate we'd check is the wrong day) or a NULL event_date (unproven
    // slate) both forbid the VOID and fall through to search (which keys off
    // event_date). Only a present, same-day event_date allows the VOID.
    slateYMD = getBetDate(bet);
    absenceVoidAllowed = Boolean(eventYMD && createdYMD === eventYMD);
  }

  if (!slateYMD) return { resolved: false, reason: 'no_bet_date' };

  // shadow: measure the population enforce WOULD re-slate — the bet's ET GAME date (the
  // day enforce queries) is present AND differs from created_at's day. Result path is
  // unchanged (off behavior). No-op in off/enforce.
  if (slateMode === 'shadow') {
    const evEt = eventEtYMD(bet.event_date);
    if (evEt && evEt !== createdYMD) {
      emitSlateShadow(bet.id, {
        bet_id: bet.id,
        created_ymd: createdYMD,
        event_ymd: evEt,
        sport,
        bet_type: bet.bet_type || null,
      });
    }
  }

  const isProp = isPropBet(bet.description, sport);

  try {
    if (sport === 'MLB') {
      // Matchup-prefixed player prop ("Team vs Team Over N PLAYER [-] STAT"): strip the
      // matchup, rewrite to the canonical "<PLAYER> Over/Under N <stat>", and grade through
      // the player-prop path. #130 REFUSES these (player_prop_misrouted_to_total) so they
      // never false-WIN as a game total; this reroutes the RECOGNIZED ones to grade. A failed
      // extraction or player lookup stays inside gradeMlbPlayerProp (→ resolved:false / VOID),
      // never the game-total grader — so the no-false-WIN guarantee is preserved. Checked
      // BEFORE the isProp branch (these legs fail isProp: their subject canonicalizes to a
      // team) so the rewrite wins; non-matchup descriptions return null → routing unchanged.
      const rewritten = mlb.rewriteMatchupPrefixedProp(bet.description);
      if (rewritten) {
        return await mlb.gradeMlbPlayerProp(rewritten, slateYMD, { absenceVoidAllowed });
      }
      return isProp
        ? await mlb.gradeMlbPlayerProp(bet.description, slateYMD, { absenceVoidAllowed })
        : await mlb.gradeMlbBet(bet.description, slateYMD);
    }
    if (sport === 'NBA') {
      return isProp
        ? await nba.gradeNbaPlayerProp(bet.description, slateYMD, { absenceVoidAllowed })
        : await nba.gradeNbaBet(bet.description, slateYMD);
    }
    if (sport === 'NHL') {
      return isProp
        ? await nhl.gradeNhlPlayerProp(bet.description, slateYMD, { absenceVoidAllowed })
        : await nhl.gradeNhlBet(bet.description, slateYMD);
    }
  } catch (err) {
    return { resolved: false, reason: `adapter_error: ${err.message}` };
  }

  return { resolved: false, reason: 'no_adapter_for_sport' };
}

module.exports = {
  tryStructured,
  normalizeSport,
  isPlayerProp,
  isPropBet,
  getBetDate,
};