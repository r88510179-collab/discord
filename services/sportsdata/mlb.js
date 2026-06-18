// services/sportsdata/mlb.js
// MLB Stats API adapter — official, free, no auth.
// Docs: https://statsapi.mlb.com/api/v1/

const BASE = 'https://statsapi.mlb.com/api/v1';
const TIMEOUT_MS = 8000;

const { isTeamTotalBet } = require('./teamTotal');
const { isProvableAbsence, voidPlayerDidNotPlay } = require('./terminalState');

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MLB API HTTP ${res.status}`);
  return res.json();
}

// Normalize a bet's team name to MLB Stats API canonical team name.
// Handles common variants: "Bluejays" → "Blue Jays", "Yankees" → "New York Yankees".
const TEAM_ALIASES = {
  'yankees': 'New York Yankees',
  'mets': 'New York Mets',
  'braves': 'Atlanta Braves',
  'red sox': 'Boston Red Sox',
  'redsox': 'Boston Red Sox',
  'astros': 'Houston Astros',
  'dodgers': 'Los Angeles Dodgers',
  'angels': 'Los Angeles Angels',
  'padres': 'San Diego Padres',
  'giants': 'San Francisco Giants',
  'mariners': 'Seattle Mariners',
  'rangers': 'Texas Rangers',
  'athletics': 'Athletics',
  'as': 'Athletics',
  "a's": 'Athletics',
  'blue jays': 'Toronto Blue Jays',
  'bluejays': 'Toronto Blue Jays',
  'orioles': 'Baltimore Orioles',
  'rays': 'Tampa Bay Rays',
  'tigers': 'Detroit Tigers',
  'twins': 'Minnesota Twins',
  'white sox': 'Chicago White Sox',
  'whitesox': 'Chicago White Sox',
  'royals': 'Kansas City Royals',
  'guardians': 'Cleveland Guardians',
  'phillies': 'Philadelphia Phillies',
  'nationals': 'Washington Nationals',
  'marlins': 'Miami Marlins',
  'cubs': 'Chicago Cubs',
  'cardinals': 'St. Louis Cardinals',
  'brewers': 'Milwaukee Brewers',
  'pirates': 'Pittsburgh Pirates',
  'reds': 'Cincinnati Reds',
  'rockies': 'Colorado Rockies',
  'diamondbacks': 'Arizona Diamondbacks',
  'dbacks': 'Arizona Diamondbacks',
  'd-backs': 'Arizona Diamondbacks',
};

function canonicalize(teamText) {
  if (!teamText) return null;
  const lower = teamText.toLowerCase().trim();
  // Exact alias hit
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  // Match any alias as substring (descriptions can be "Atlanta Braves ML")
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

// Get the final game for a team on a given date.
// Returns: { found, finished, away, home, awayScore, homeScore, winner } or null
async function getGameForTeam(teamName, dateYMD) {
  const canonical = canonicalize(teamName);
  if (!canonical) return null;

  const data = await fetchJSON(`${BASE}/schedule?sportId=1&date=${dateYMD}`);
  const games = data?.dates?.[0]?.games || [];

  for (const g of games) {
    const away = g.teams?.away?.team?.name;
    const home = g.teams?.home?.team?.name;
    if (away !== canonical && home !== canonical) continue;

    const finished = g.status?.abstractGameState === 'Final';
    return {
      found: true,
      finished,
      gameId: g.gamePk,
      away,
      home,
      awayScore: g.teams?.away?.score,
      homeScore: g.teams?.home?.score,
      winner: g.teams?.away?.isWinner ? away : g.teams?.home?.isWinner ? home : null,
      detailedState: g.status?.detailedState,
    };
  }
  return null;
}

// Player-stat tokens — baseball PLAYER stats the run-total grader cannot grade. Whole-word
// (\b-anchored) and scanned across the WHOLE description, deliberately NOT via the prop
// parser's resolved stat: in the failing format "Team vs Team Over 0.5 PLAYER STAT" the
// player name sits in the stat field, where the prop grader's loose resolveStat picks a stray
// letter (the 'r' in "Tarik" → "runs", the 'r' in "Cruz" → "runs") and mis-resolves the stat,
// so keying on the parser would MISS exactly the cases we must catch. A full-text token scan
// is immune to player-name placement. Covers every non-run STAT_MAP stat — full words plus the
// standard book abbreviations (ks/k/so, bb, sb, er, po, hr) that two adversarial-review passes
// found a narrower draft missed (walks/earned-runs/outs, then K/SO/SB). All abbreviations are
// \b-anchored and verified collision-free against the 30 MLB team aliases/names, EXCEPT "tb",
// which is excluded because it is Tampa Bay's book code ("TB vs BOS …") — its full form "total
// bases" is still covered. "runs"/"r" is intentionally ABSENT so real run totals and inning/
// NRFI "Under 0.5 Runs" lines still grade (see looksLikeMisroutedPlayerProp).
const PLAYER_STAT_TOKEN_RX = /\bhits?\b|to record 1\+|\bstrikeouts?\b|\bks\b|\bso\b|\bk\b|\brbis?\b|\btotal bases\b|\bhome runs?\b|\bhrs?\b|\bstolen bases?\b|\bsb\b|\bwalks?\b|\bbb\b|\bearned runs?\b|\ber\b|\bouts?\b|\bpo\b/;

// Does this description look like a PLAYER prop that mis-routed to the team/total grader?
//
// gradeMlbBet's total branch only computes the GAME RUN total (away + home), so the ONLY
// over/under it can legitimately grade is a run total. A player prop reaches here when its
// subject fails player-prop routing — an unrecognized name, or one that spuriously
// canonicalizes to a team (e.g. "Masyn Winn" → 'as' → Athletics). Without a guard the total
// branch reads the prop's "Over 0.5" as a run line, sees the real game total (always > 0.5),
// and mints a FALSE WIN that ignores the player (the −74.42u incident).
//
// Refuse whenever the description names a non-run player stat. No game-total-marker or line
// check is needed (or safe): a real run total / ML / run line never contains a player-stat
// word, while a player prop with a high line (e.g. "Over 5.5 Strikeouts") still must be
// refused — so keying on the line (≥4.5) the way a first draft did re-opened a false-WIN hole.
// The only real bets carrying a player-stat word are game-level stat markets ("Total Hits",
// "Total Bases") which gradeMlbBet also cannot grade as runs, so refusing them to manual
// review is correct, not a regression. It only REFUSES (resolved:false) — it does not
// re-route to the prop grader (guard-only, per spec).
//
// Fallback: a bare single-letter stat abbrev ("H") is too collision-prone to scan for as a
// free-floating letter, so it is caught only when the description actually parses as a player
// prop whose subject canonicalizes to a team (i.e. it genuinely mis-routed here) and resolves
// to a non-run stat — a stray letter in a real total never satisfies all three, so this adds
// no false refusals. A player-RUNS prop whose name spuriously canonicalizes to a team is an
// accepted residual: "runs" is inherently ambiguous with the game run total, the same
// ambiguity the spec keeps, and out of scope for this guard.
function looksLikeMisroutedPlayerProp(description) {
  if (typeof description !== 'string' || !description) return false;
  if (PLAYER_STAT_TOKEN_RX.test(description.toLowerCase())) return true;
  const parsed = parsePlayerProp(description);
  return !!(parsed && !parsed.fields && parsed.stat && parsed.stat !== 'runs' && canonicalize(parsed.player));
}

// Public API — used by the grader.
// description: "New York Yankees -1.5" or "Atlanta Braves ML" or "Dodgers Blue Jays Over 8"
// dateYMD: "2026-04-07"
// Returns the contract: { resolved, status, evidence } or { resolved: false, reason }
async function gradeMlbBet(description, dateYMD) {
  // Detect bet type from description
  const desc = description.toLowerCase();

  // Single-team "Team Total" bets are about one team's score, not the game total.
  // The total branch below computes the GAME total (away+home), which would misgrade
  // them — refuse so the caller falls through to ESPN+AI (which understands team totals).
  if (isTeamTotalBet(description)) {
    return { resolved: false, reason: 'team_total_unsupported' };
  }

  // A player prop that mis-routed here (its subject failed player-prop routing). Refuse
  // before the ML/RL/total branches so it falls through to ESPN+AI / manual review
  // instead of being auto-WON on the game total. See looksLikeMisroutedPlayerProp.
  if (looksLikeMisroutedPlayerProp(description)) {
    return { resolved: false, reason: 'player_prop_misrouted_to_total' };
  }

  // Find which team(s) the bet references
  const teamHits = [];
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (desc.includes(alias) && !teamHits.find(t => t.canonical === canonical)) {
      teamHits.push({ alias, canonical });
    }
  }

  if (teamHits.length === 0) {
    return { resolved: false, reason: 'no_team_found' };
  }

  // Use first team to anchor the game lookup
  const game = await getGameForTeam(teamHits[0].canonical, dateYMD);
  if (!game) return { resolved: false, reason: 'no_game_on_date' };
  if (!game.finished) {
    return { resolved: true, status: 'PENDING', evidence: `Game scheduled but not final (${game.detailedState})`, source: 'mlb_statsapi' };
  }

  const betTeam = teamHits[0].canonical;
  const betTeamScore = game.away === betTeam ? game.awayScore : game.homeScore;
  const oppScore = game.away === betTeam ? game.homeScore : game.awayScore;
  const margin = betTeamScore - oppScore;
  const totalRuns = game.awayScore + game.homeScore;

  // ── Moneyline ──
  // Description includes "ML" or no spread/total indicator
  const isML = /\bml\b/.test(desc) || (!desc.includes('+') && !desc.includes('-') && !desc.match(/over|under|o\s*\d|u\s*\d/i));
  if (isML) {
    const won = game.winner === betTeam;
    return {
      resolved: true,
      status: won ? 'WIN' : 'LOSS',
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} ${won ? 'won' : 'lost'}.`,
      source: 'mlb_statsapi',
    };
  }

  // ── Run line (-1.5 / +1.5) ──
  const rlMatch = desc.match(/([+-])\s*1\.5/);
  if (rlMatch) {
    const line = rlMatch[1] === '-' ? -1.5 : 1.5;
    const coversFavorite = margin > Math.abs(line); // -1.5: need to win by 2+
    const coversDog = margin > line; // +1.5: just need to not lose by 2+; margin > -1.5
    const won = line < 0 ? coversFavorite : coversDog;
    return {
      resolved: true,
      status: won ? 'WIN' : 'LOSS',
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} margin ${margin > 0 ? '+' : ''}${margin}, line ${line}.`,
      source: 'mlb_statsapi',
    };
  }

  // ── Total (over/under N) ──
  const totalMatch = desc.match(/(over|under|\bo\b|\bu\b)\s*(\d+(?:\.\d+)?)/i);
  if (totalMatch) {
    const direction = totalMatch[1].toLowerCase().startsWith('o') ? 'over' : 'under';
    const line = parseFloat(totalMatch[2]);
    let status;
    if (totalRuns === line) status = 'PUSH';
    else if (direction === 'over') status = totalRuns > line ? 'WIN' : 'LOSS';
    else status = totalRuns < line ? 'WIN' : 'LOSS';
    return {
      resolved: true,
      status,
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). Total ${totalRuns}, ${direction} ${line}.`,
      source: 'mlb_statsapi',
    };
  }

  // Player props or other types not yet supported by structured layer
  return { resolved: false, reason: 'unsupported_bet_type' };
}

// ── Player prop grading ──

// Map common bet-text stat names to MLB API field names.
// Returns either a single field name or an array of field names to sum.
const STAT_MAP = {
  // Batting
  'h': 'hits',
  'hit': 'hits',
  'hits': 'hits',
  'r': 'runs',
  'run': 'runs',
  'runs': 'runs',
  'rbi': 'rbi',
  'rbis': 'rbi',
  'hr': 'homeRuns',
  'hrs': 'homeRuns',
  'home run': 'homeRuns',
  'home runs': 'homeRuns',
  'tb': 'totalBases',
  'total bases': 'totalBases',
  'sb': 'stolenBases',
  'stolen base': 'stolenBases',
  'stolen bases': 'stolenBases',
  'bb': 'baseOnBalls',
  'walks': 'baseOnBalls',
  'walk': 'baseOnBalls',
  // Pitching
  'k': 'strikeOuts',
  'ks': 'strikeOuts',
  'strikeout': 'strikeOuts',
  'strikeouts': 'strikeOuts',
  'so': 'strikeOuts',
  'pitching outs': 'outs',
  'po': 'outs',
  'outs': 'outs',
  'er': 'earnedRuns',
  'earned runs': 'earnedRuns',
};

// Compound stats (sum of multiple fields)
const COMPOUND_STATS = {
  'h+r+rbi': ['hits', 'runs', 'rbi'],
  'hits+runs+rbi': ['hits', 'runs', 'rbi'],
  'hits+runs+rbis': ['hits', 'runs', 'rbi'],
  'h+r+rbis': ['hits', 'runs', 'rbi'],
};

// Find a player's stats line across both teams.
// Returns: { player, team, batting, pitching } or null.
function findPlayerInBoxscore(boxscore, playerLastName, playerFirstName = null) {
  const lastLower = playerLastName.toLowerCase();
  const firstLower = (playerFirstName || '').toLowerCase();
  for (const side of ['home', 'away']) {
    const team = boxscore?.teams?.[side];
    if (!team?.players) continue;
    for (const pdata of Object.values(team.players)) {
      const full = pdata?.person?.fullName?.toLowerCase() || '';
      const boxName = pdata?.person?.boxscoreName?.toLowerCase() || '';
      const fullWords = full.split(/\s+/);
      const lastNameMatches = fullWords[fullWords.length - 1] === lastLower || boxName === lastLower;
      if (!lastNameMatches) continue;
      if (firstLower && fullWords[0] !== firstLower) continue;
      return {
        player: pdata.person.fullName,
        team: team.team?.name,
        batting: pdata.stats?.batting || {},
        pitching: pdata.stats?.pitching || {},
      };
    }
  }
  return null;
}

// Parse a player-prop description. Returns { player, stat, direction, threshold } or null.
// Examples:
//   "Aaron Judge 2+ H+R+RBI" → { player: "Aaron Judge", stat: 'compound', fields: [hits,runs,rbi], direction: 'over', threshold: 1.5 (2+ → over 1.5) }
//   "Tarik Skubal O 17.5 Pitching Outs" → { player: "Tarik Skubal", stat: 'outs', direction: 'over', threshold: 17.5 }
//   "Aaron Judge 1+ Home Runs" → { player: "Aaron Judge", stat: 'homeRuns', direction: 'over', threshold: 0.5 }
function parsePlayerProp(description) {
  const desc = description.trim();

  // Pattern A: "Player Name O|U 17.5 Stat" (e.g. "Skubal O 17.5 Pitching Outs")
  // Pattern B: "Player Name 2+ Stat" (e.g. "Judge 2+ H+R+RBI") — "+" means over (threshold - 0.5)
  // Pattern C: "Player Name Over/Under N Stat"

  // Try compound stats first (longest match wins)
  let compoundKey = null;
  let compoundFields = null;
  const descLower = desc.toLowerCase().replace(/\s+/g, ' ');
  for (const [key, fields] of Object.entries(COMPOUND_STATS)) {
    if (descLower.includes(key)) {
      compoundKey = key;
      compoundFields = fields;
      break;
    }
  }

  // Pattern: "N+ <stat>" (X-plus, treated as Over X-0.5)
  let m = desc.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/i);
  if (m) {
    const playerRaw = m[1].trim();
    const num = parseFloat(m[2]);
    const statText = m[3].trim();
    const stat = compoundFields ? null : resolveStat(statText);
    return {
      player: playerRaw,
      stat: compoundFields ? 'compound' : stat,
      fields: compoundFields,
      direction: 'over',
      threshold: num - 0.5, // "2+" means over 1.5
    };
  }

  // Pattern: "<player> O|U|Over|Under <N> <stat>"
  m = desc.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (m) {
    const playerRaw = m[1].trim();
    const dirRaw = m[2].toLowerCase();
    const direction = dirRaw.startsWith('o') ? 'over' : 'under';
    const threshold = parseFloat(m[3]);
    const statText = m[4].trim();
    const stat = compoundFields ? null : resolveStat(statText);
    return {
      player: playerRaw,
      stat: compoundFields ? 'compound' : stat,
      fields: compoundFields,
      direction,
      threshold,
    };
  }

  return null;
}

// Router predicate: does this description name a *player* prop (not a team total)?
// Delegates to parsePlayerProp so the prop-vs-team router can never disagree with the
// parser, then guards the team-total case. parsePlayerProp matches a team total
// greedily ("Los Angeles Dodgers Over 8.5 Runs" → {player:"Los Angeles Dodgers",
// stat:"runs"}), so if the subject before the O/U resolves to a known team, this is a
// team total — route it to the team grader, not the prop grader.
function looksLikePlayerProp(description) {
  const parsed = parsePlayerProp(description);
  if (!parsed) return false;
  if (parsed.stat === null && !parsed.fields) return false; // no gradeable stat
  if (canonicalize(parsed.player)) return false;            // subject is a team → team total
  return true;
}

function resolveStat(statText) {
  const key = statText.toLowerCase().trim();
  if (STAT_MAP[key]) return STAT_MAP[key];
  // Try partial: "Pitches Thrown" wouldn't match, but "Strikeouts" → strikeOuts.
  for (const [alias, field] of Object.entries(STAT_MAP)) {
    if (key.includes(alias)) return field;
  }
  return null;
}

// Find the gamePk for a specific player on a date by checking the schedule for any game they played in.
// Strategy: pull all games for the date, fetch each game's boxscore until we find the player.
// On a hit, returns the player's stat line (shape unchanged). On a miss, returns a
// not-found record carrying the slate metadata the caller needs to decide whether
// the absence is PROVABLE (→ VOID) or merely indeterminate — see terminalState.js.
async function findPlayerGame(playerLastName, dateYMD, playerFirstName = null) {
  const data = await fetchJSON(`${BASE}/schedule?sportId=1&date=${dateYMD}`);
  const games = data?.dates?.[0]?.games || [];
  let allFinal = true;
  let anyFetchError = false;
  for (const g of games) {
    const gameFinal = g.status?.abstractGameState === 'Final';
    if (!gameFinal) allFinal = false;
    try {
      const feed = await fetchJSON(`https://statsapi.mlb.com/api/v1.1/game/${g.gamePk}/feed/live`);
      const bs = feed?.liveData?.boxscore;
      const found = findPlayerInBoxscore(bs, playerLastName, playerFirstName);
      if (found) {
        return {
          gamePk: g.gamePk,
          finished: gameFinal,
          detailedState: g.status?.detailedState,
          ...found,
        };
      }
    } catch (_) { anyFetchError = true; /* skip game, try next */ }
  }
  return { notFound: true, gamesOnDate: games.length, allFinal, anyFetchError };
}

// Grade a single player prop.
// opts.absenceVoidAllowed (default true): the caller may forbid the provable-
// absence VOID when the bet's date is ambiguous (see tryStructured date gate).
async function gradeMlbPlayerProp(description, dateYMD, opts = {}) {
  const parsed = parsePlayerProp(description);
  if (!parsed) return { resolved: false, reason: 'unparseable_player_prop' };
  if (parsed.stat === null && !parsed.fields) {
    return { resolved: false, reason: 'unknown_stat' };
  }

  // Extract first and last name from player text.
  const tokens = parsed.player.split(/\s+/).filter(Boolean);
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : tokens[0];
  const firstName = tokens.length > 1 ? tokens[0] : null;

  const result = await findPlayerGame(lastName, dateYMD, firstName);
  if (result.notFound) {
    // Player in no box score on the date. VOID only if absence is PROVABLE (full
    // final slate, every box score read, player in none); otherwise the miss is
    // indeterminate (no games / a live game / a skipped fetch / a misparsed name
    // could all hide a real result) → fall through to search. See terminalState.js.
    // opts.absenceVoidAllowed===false suppresses the VOID when the date is ambiguous.
    if (opts.absenceVoidAllowed !== false && isProvableAbsence(result)) {
      return voidPlayerDidNotPlay(parsed.player, dateYMD, result.gamesOnDate, 'MLB', 'mlb_statsapi');
    }
    return { resolved: false, reason: 'player_not_found_in_games_on_date' };
  }
  if (!result.finished) {
    return { resolved: true, status: 'PENDING', evidence: `${result.player}'s game not yet final (${result.detailedState})`, source: 'mlb_statsapi' };
  }

  // Compute the stat value
  let value, statLabel;
  if (parsed.fields) {
    value = parsed.fields.reduce((sum, f) => sum + (result.batting[f] || 0), 0);
    statLabel = parsed.fields.join('+');
  } else {
    // Check both batting and pitching for the stat (pitching outs is in pitching, hits is in batting, strikeOuts exists in both)
    const isPitchingStat = parsed.stat === 'outs' || parsed.stat === 'earnedRuns';
    const isLikelyPitcher = (result.pitching && Object.keys(result.pitching).length > 0) && isPitchingStat;
    if (isLikelyPitcher) {
      value = result.pitching[parsed.stat] ?? 0;
    } else if (parsed.stat in (result.batting || {})) {
      value = result.batting[parsed.stat];
    } else if (parsed.stat in (result.pitching || {})) {
      value = result.pitching[parsed.stat];
    } else {
      // MLB DNP note (PR #128 follow-up): a player who genuinely did not play is
      // ABSENT from the box score entirely → the not-found branch above VOIDs on
      // provable absence (the live Laureano case). A player present here with the
      // stat missing is NOT treated as a DNP: statsapi lists pinch-runners and
      // defensive subs (empty batting, but they DID play), so voiding would erase
      // a real result. Stay a fall-through — under-voiding is the safe error.
      return { resolved: false, reason: `stat_not_in_boxscore: ${parsed.stat}` };
    }
    statLabel = parsed.stat;
  }

  // Grade
  let status;
  if (value === parsed.threshold) status = 'PUSH';
  else if (parsed.direction === 'over') status = value > parsed.threshold ? 'WIN' : 'LOSS';
  else status = value < parsed.threshold ? 'WIN' : 'LOSS';

  return {
    resolved: true,
    status,
    evidence: `${result.player} had ${value} ${statLabel} (line: ${parsed.direction} ${parsed.threshold}).`,
    source: 'mlb_statsapi',
  };
}

module.exports = {
  gradeMlbBet,
  gradeMlbPlayerProp,
  getGameForTeam,
  findPlayerGame,
  parsePlayerProp,
  looksLikePlayerProp,
  looksLikeMisroutedPlayerProp,
  canonicalize,
  _internal: { TEAM_ALIASES, STAT_MAP, COMPOUND_STATS },
};