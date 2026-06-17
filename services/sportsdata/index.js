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

// Extract a YYYY-MM-DD date from a bet row.
// Prefers created_at (always populated), falls back to event_date.
function getBetDate(bet) {
  const src = bet.created_at || bet.event_date;
  if (!src) return null;
  // created_at format: "2026-04-07 16:24:37"
  if (/^\d{4}-\d{2}-\d{2}/.test(src)) return src.slice(0, 10);
  // event_date format: "07 Apr 2026 22:00" or ISO — try Date parse
  const d = new Date(src);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
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

  const dateYMD = getBetDate(bet);
  if (!dateYMD) return { resolved: false, reason: 'no_bet_date' };

  const isProp = isPropBet(bet.description, sport);

  try {
    if (sport === 'MLB') {
      return isProp
        ? await mlb.gradeMlbPlayerProp(bet.description, dateYMD)
        : await mlb.gradeMlbBet(bet.description, dateYMD);
    }
    if (sport === 'NBA') {
      return isProp
        ? await nba.gradeNbaPlayerProp(bet.description, dateYMD)
        : await nba.gradeNbaBet(bet.description, dateYMD);
    }
    if (sport === 'NHL') {
      return isProp
        ? await nhl.gradeNhlPlayerProp(bet.description, dateYMD)
        : await nhl.gradeNhlBet(bet.description, dateYMD);
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