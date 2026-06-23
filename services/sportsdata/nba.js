// services/sportsdata/nba.js
// ESPN NBA public API adapter — free, no auth, unofficial.
// Endpoint family: site.api.espn.com/apis/site/v2/sports/basketball/nba/

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const TIMEOUT_MS = 8000;

const { isTeamTotalBet } = require('./teamTotal');
const { isProvableAbsence, voidPlayerDidNotPlay, voidPlayerInactive } = require('./terminalState');

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ESPN NBA API HTTP ${res.status}`);
  return res.json();
}

// Bet text → ESPN displayName.
const TEAM_ALIASES = {
  'celtics': 'Boston Celtics',
  'nets': 'Brooklyn Nets',
  'knicks': 'New York Knicks',
  'sixers': 'Philadelphia 76ers',
  '76ers': 'Philadelphia 76ers',
  'raptors': 'Toronto Raptors',
  'bulls': 'Chicago Bulls',
  'cavaliers': 'Cleveland Cavaliers',
  'cavs': 'Cleveland Cavaliers',
  'pistons': 'Detroit Pistons',
  'pacers': 'Indiana Pacers',
  'bucks': 'Milwaukee Bucks',
  'hawks': 'Atlanta Hawks',
  'hornets': 'Charlotte Hornets',
  'heat': 'Miami Heat',
  'magic': 'Orlando Magic',
  'wizards': 'Washington Wizards',
  'nuggets': 'Denver Nuggets',
  'timberwolves': 'Minnesota Timberwolves',
  'wolves': 'Minnesota Timberwolves',
  'thunder': 'Oklahoma City Thunder',
  'okc': 'Oklahoma City Thunder',
  'jazz': 'Utah Jazz',
  'blazers': 'Portland Trail Blazers',
  'trail blazers': 'Portland Trail Blazers',
  'warriors': 'Golden State Warriors',
  'gsw': 'Golden State Warriors',
  'clippers': 'LA Clippers',
  'lakers': 'Los Angeles Lakers',
  'suns': 'Phoenix Suns',
  'kings': 'Sacramento Kings',
  'mavericks': 'Dallas Mavericks',
  'mavs': 'Dallas Mavericks',
  'rockets': 'Houston Rockets',
  'grizzlies': 'Memphis Grizzlies',
  'pelicans': 'New Orleans Pelicans',
  'spurs': 'San Antonio Spurs',
};

function canonicalize(teamText) {
  if (!teamText) return null;
  const lower = teamText.toLowerCase().trim();
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  const sortedAliases = Object.entries(TEAM_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of sortedAliases) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

function ymdToEspnDate(ymd) {
  // 2026-04-07 → 20260407
  return ymd.replace(/-/g, '');
}

async function getGamesByDate(dateYMD) {
  const data = await fetchJSON(`${BASE}/scoreboard?dates=${ymdToEspnDate(dateYMD)}`);
  return data?.events || [];
}

function gameMatchesTeam(event, canonical) {
  const comp = event.competitions?.[0];
  if (!comp) return false;
  for (const c of comp.competitors || []) {
    if (c.team?.displayName === canonical) return true;
  }
  return false;
}

function extractGameInfo(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const status = comp.status?.type?.name;
  const finished = status === 'STATUS_FINAL';
  const home = (comp.competitors || []).find(c => c.homeAway === 'home');
  const away = (comp.competitors || []).find(c => c.homeAway === 'away');
  return {
    eventId: event.id,
    finished,
    status,
    home: home?.team?.displayName,
    homeScore: parseInt(home?.score, 10),
    away: away?.team?.displayName,
    awayScore: parseInt(away?.score, 10),
    winner: home?.winner ? home.team.displayName : away?.winner ? away.team.displayName : null,
  };
}

async function getGameForTeam(teamName, dateYMD) {
  const canonical = canonicalize(teamName);
  if (!canonical) return null;
  const events = await getGamesByDate(dateYMD);
  for (const e of events) {
    if (!gameMatchesTeam(e, canonical)) continue;
    return extractGameInfo(e);
  }
  return null;
}

async function gradeNbaBet(description, dateYMD) {
  const desc = description.toLowerCase();

  // Single-team "Team Total" bets are about one team's score, not the game total.
  // The total branch below computes the GAME total (away+home), which would misgrade
  // them — refuse so the caller falls through to ESPN+AI (which understands team totals).
  if (isTeamTotalBet(description)) {
    return { resolved: false, reason: 'team_total_unsupported' };
  }

  const teamHits = [];
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (desc.includes(alias) && !teamHits.find(t => t.canonical === canonical)) {
      teamHits.push({ alias, canonical });
    }
  }
  if (teamHits.length === 0) return { resolved: false, reason: 'no_team_found' };

  const game = await getGameForTeam(teamHits[0].canonical, dateYMD);
  if (!game) return { resolved: false, reason: 'no_game_on_date' };
  if (!game.finished) {
    return { resolved: true, status: 'PENDING', evidence: `Game not yet final (${game.status})`, source: 'espn_nba' };
  }

  const betTeam = teamHits[0].canonical;
  const betTeamScore = game.away === betTeam ? game.awayScore : game.homeScore;
  const oppScore = game.away === betTeam ? game.homeScore : game.awayScore;
  const margin = betTeamScore - oppScore;
  const totalPoints = game.awayScore + game.homeScore;

  // Moneyline
  const isML = /\bml\b/.test(desc) || (!desc.includes('+') && !desc.includes('-') && !desc.match(/over|under|o\s*\d+|u\s*\d+/i));
  if (isML) {
    const won = game.winner === betTeam;
    return {
      resolved: true,
      status: won ? 'WIN' : 'LOSS',
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} ${won ? 'won' : 'lost'}.`,
      source: 'espn_nba',
    };
  }

  // Spread ±N.N
  const spreadMatch = desc.match(/([+-])\s*(\d+(?:\.\d+)?)/);
  // Make sure this isn't a total like "Over 220.5" — total has explicit over/under keyword first
  const hasTotalKeyword = /over|under|\bo\b|\bu\b/i.test(desc);
  if (spreadMatch && !hasTotalKeyword) {
    const line = spreadMatch[1] === '-' ? -parseFloat(spreadMatch[2]) : parseFloat(spreadMatch[2]);
    // Did betTeam cover? margin + line > 0 means cover
    const covers = margin + line > 0;
    const push = margin + line === 0;
    return {
      resolved: true,
      status: push ? 'PUSH' : (covers ? 'WIN' : 'LOSS'),
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} margin ${margin > 0 ? '+' : ''}${margin}, line ${line > 0 ? '+' : ''}${line}.`,
      source: 'espn_nba',
    };
  }

  // Total over/under
  const totalMatch = desc.match(/(over|under|\bo\b|\bu\b)\s*(\d+(?:\.\d+)?)/i);
  if (totalMatch) {
    const direction = totalMatch[1].toLowerCase().startsWith('o') ? 'over' : 'under';
    const line = parseFloat(totalMatch[2]);
    let status;
    if (totalPoints === line) status = 'PUSH';
    else if (direction === 'over') status = totalPoints > line ? 'WIN' : 'LOSS';
    else status = totalPoints < line ? 'WIN' : 'LOSS';
    return {
      resolved: true,
      status,
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). Total ${totalPoints}, ${direction} ${line}.`,
      source: 'espn_nba',
    };
  }

  return { resolved: false, reason: 'unsupported_bet_type' };
}

// ── Player props ──

// ESPN keys array → index. Used to pull stats by name.
function statIndex(keys, statName) {
  return keys.indexOf(statName);
}

// Bet text stat → ESPN keys array name.
const STAT_FIELD_MAP = {
  'points': 'points',
  'pts': 'points',
  'point': 'points',
  'rebounds': 'rebounds',
  'reb': 'rebounds',
  'rebound': 'rebounds',
  'rebs': 'rebounds',
  'assists': 'assists',
  'ast': 'assists',
  'asts': 'assists',
  'assist': 'assists',
  'steals': 'steals',
  'stl': 'steals',
  'blocks': 'blocks',
  'blk': 'blocks',
  'turnovers': 'turnovers',
  'to': 'turnovers',
  'tos': 'turnovers',
  'threes': 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', // special: parse made
  'three pointers': 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  '3pm': 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  'made threes': 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
};

// Compound stats — sum of base stats.
const COMPOUND_DEFS = {
  'pra': ['points', 'rebounds', 'assists'],
  'pts+reb+ast': ['points', 'rebounds', 'assists'],
  'pts + reb + ast': ['points', 'rebounds', 'assists'],
  'pts+reb': ['points', 'rebounds'],
  'pts + reb': ['points', 'rebounds'],
  'pts+ast': ['points', 'assists'],
  'pts + ast': ['points', 'assists'],
  'reb+ast': ['rebounds', 'assists'],
  'reb + ast': ['rebounds', 'assists'],
};

function resolveSingleStat(statText) {
  const key = statText.toLowerCase().trim();
  if (STAT_FIELD_MAP[key]) return STAT_FIELD_MAP[key];
  for (const [alias, field] of Object.entries(STAT_FIELD_MAP)) {
    if (key.includes(alias)) return field;
  }
  return null;
}

function resolveCompoundStat(statText) {
  const key = statText.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [pattern, fields] of Object.entries(COMPOUND_DEFS)) {
    if (key.includes(pattern)) return fields;
  }
  return null;
}

// Parse a player-prop description.
function parsePlayerProp(description) {
  const desc = description.trim();

  // Compound check first
  const compoundFields = resolveCompoundStat(desc);

  // Pattern: "Player N+ Stat"
  let m = desc.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/i);
  if (m) {
    const stat = compoundFields ? null : resolveSingleStat(m[3].trim());
    return {
      player: m[1].trim(),
      stat: compoundFields ? 'compound' : stat,
      fields: compoundFields,
      direction: 'over',
      threshold: parseFloat(m[2]) - 0.5,
      propName: m[3].trim(),
    };
  }

  // Pattern: "Player O|U|Over|Under N Stat"
  m = desc.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (m) {
    const dir = m[2].toLowerCase().startsWith('o') ? 'over' : 'under';
    const stat = compoundFields ? null : resolveSingleStat(m[4].trim());
    return {
      player: m[1].trim(),
      stat: compoundFields ? 'compound' : stat,
      fields: compoundFields,
      direction: dir,
      threshold: parseFloat(m[3]),
      propName: m[4].trim(),
    };
  }

  return null;
}

// Router predicate: does this description name a *player* prop (not a team total)?
// Delegates to parsePlayerProp so the prop-vs-team router can never disagree with the
// parser, then guards the team-total case. parsePlayerProp matches a team total
// greedily ("Los Angeles Lakers Over 220.5 Points" → {player:"Los Angeles Lakers",
// stat:"points"}), so if the subject before the O/U resolves to a known team, this is
// a team total — route it to the team grader, not the prop grader.
function looksLikePlayerProp(description) {
  const parsed = parsePlayerProp(description);
  if (!parsed) return false;
  if (parsed.stat === null && !parsed.fields) return false; // no gradeable stat
  if (canonicalize(parsed.player)) return false;            // subject is a team → team total
  return true;
}

function findPlayerInBoxscore(boxscore, lastName, firstName = null) {
  const lastLower = lastName.toLowerCase();
  const firstLower = (firstName || '').toLowerCase();
  const teams = boxscore?.players || [];
  for (const t of teams) {
    const teamName = t.team?.displayName;
    const stats = t.statistics?.[0];
    if (!stats) continue;
    const keys = stats.keys || [];
    for (const a of stats.athletes || []) {
      const fullName = (a.athlete?.displayName || '').toLowerCase();
      const tokens = fullName.split(/\s+/);
      if (tokens.length < 2) continue;
      const apiLast = tokens[tokens.length - 1].replace(/[^a-z]/g, ''); // strip Jr./III/punctuation
      const apiFirst = tokens[0];
      if (apiLast !== lastLower) continue;
      if (firstLower && apiFirst !== firstLower) continue;
      return {
        player: a.athlete.displayName,
        team: teamName,
        keys,
        stats: a.stats,
        // AUTHORITATIVE DNP signal only. ESPN sets a.didNotPlay=true (with an
        // empty stats array) for a true DNP — coach's decision / inactive. The
        // old `|| all-zero stats` fallback conflated that with a player who DID
        // play and recorded zeros: it both (a) mislabeled a played-zero line as a
        // DNP and (b) — since the caller graded a DNP as LOSS — flipped a real
        // UNDER win into a loss. a.reason / a.active are unreliable (ESPN leaves
        // stale values on players who played), so neither is used.
        didNotPlay: a.didNotPlay === true,
      };
    }
  }
  return null;
}

function readStat(player, statFieldName) {
  const idx = player.keys.indexOf(statFieldName);
  if (idx === -1) return null;
  const raw = player.stats[idx];
  if (raw === undefined || raw === null || raw === '') return null;
  // Some fields are "X-Y" format (made-attempted). Caller decides if it wants made or attempts.
  // For now, threes use "threePointFieldGoalsMade-threePointFieldGoalsAttempted" → parse first number.
  if (typeof raw === 'string' && raw.includes('-')) {
    return parseInt(raw.split('-')[0], 10);
  }
  return parseInt(raw, 10);
}

// On a hit, returns the player's stat line (shape unchanged). On a miss, returns
// a not-found record carrying slate metadata so the caller can decide whether the
// absence is PROVABLE (→ VOID) or indeterminate — see terminalState.js.
async function findPlayerGame(lastName, dateYMD, firstName = null) {
  const events = await getGamesByDate(dateYMD);
  let allFinal = true;
  let anyFetchError = false;
  for (const e of events) {
    const gameInfo = extractGameInfo(e);
    if (!gameInfo?.finished) allFinal = false;
    try {
      const summary = await fetchJSON(`${BASE}/summary?event=${e.id}`);
      const bs = summary?.boxscore;
      const found = findPlayerInBoxscore(bs, lastName, firstName);
      if (found) {
        return {
          eventId: e.id,
          finished: gameInfo?.finished,
          status: gameInfo?.status,
          ...found,
        };
      }
    } catch (_) { anyFetchError = true; /* skip */ }
  }
  return { notFound: true, gamesOnDate: events.length, allFinal, anyFetchError };
}

// opts.absenceVoidAllowed (default true): the caller may forbid the provable-
// absence VOID when the bet's date is ambiguous (see tryStructured date gate).
async function gradeNbaPlayerProp(description, dateYMD, opts = {}) {
  const parsed = parsePlayerProp(description);
  if (!parsed) return { resolved: false, reason: 'unparseable_player_prop' };
  if (parsed.stat === null && !parsed.fields) {
    return { resolved: false, reason: 'unknown_stat' };
  }

  const tokens = parsed.player.split(/\s+/).filter(Boolean);
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1].replace(/[^a-zA-Z]/g, '') : tokens[0];
  const firstName = tokens.length > 1 ? tokens[0] : null;

  const result = await findPlayerGame(lastName, dateYMD, firstName);
  if (result.notFound) {
    // Player in no box score on the date. VOID only if absence is PROVABLE (full
    // final slate, every box score read, player in none); otherwise the miss is
    // indeterminate (no games / a live game / a skipped fetch / a misparsed name
    // could all hide a real result) → fall through to search. See terminalState.js.
    // opts.absenceVoidAllowed===false suppresses the VOID when the date is ambiguous.
    if (opts.absenceVoidAllowed !== false && isProvableAbsence(result)) {
      return voidPlayerDidNotPlay(parsed.player, dateYMD, result.gamesOnDate, 'NBA', 'espn_nba');
    }
    return { resolved: false, reason: 'player_not_found_in_games_on_date' };
  }
  if (!result.finished) {
    return { resolved: true, status: 'PENDING', evidence: `${result.player}'s game not yet final (${result.status})`, source: 'espn_nba' };
  }
  // Confirmed DNP: the player was rostered for a game that DID occur (we found
  // their box-score row) but did not take the court. The prop had NO ACTION →
  // VOID (stake returned, no W/L, no capper effect), per Smokke's rule (PR #128).
  // result.didNotPlay is now the authoritative ESPN flag only (see
  // findPlayerInBoxscore); a player who PLAYED and recorded zeros has
  // didNotPlay=false and grades normally below (value 0 vs the line).
  if (result.didNotPlay) {
    // The structured slate is keyed off created_at (getBetDate); on a back-to-back
    // the created_at-day game can be the WRONG game — the player can be a DNP that
    // day yet PLAY the event_date game. So a found-in-game DNP only VOIDs under the
    // same date guard the provable-absence path uses (opts.absenceVoidAllowed);
    // when the dates disagree, fall through to grade the real event_date game.
    if (opts.absenceVoidAllowed !== false) {
      return voidPlayerInactive(result.player, 'espn_nba');
    }
    return { resolved: false, reason: 'dnp_date_unconfirmed' };
  }

  // Compute value
  let value, statLabel;
  if (parsed.fields) {
    value = parsed.fields.reduce((sum, f) => sum + (readStat(result, f) || 0), 0);
    statLabel = parsed.fields.join('+');
  } else {
    value = readStat(result, parsed.stat);
    if (value === null) return { resolved: false, reason: `stat_not_in_boxscore: ${parsed.stat}` };
    statLabel = parsed.stat;
  }

  let status;
  if (value === parsed.threshold) status = 'PUSH';
  else if (parsed.direction === 'over') status = value > parsed.threshold ? 'WIN' : 'LOSS';
  else status = value < parsed.threshold ? 'WIN' : 'LOSS';

  return {
    resolved: true,
    status,
    evidence: `${result.player} had ${value} ${statLabel} (line: ${parsed.direction} ${parsed.threshold}).`,
    source: 'espn_nba',
  };
}

module.exports = {
  gradeNbaBet,
  gradeNbaPlayerProp,
  getGameForTeam,
  findPlayerGame,
  parsePlayerProp,
  looksLikePlayerProp,
  canonicalize,
  _internal: { TEAM_ALIASES, STAT_FIELD_MAP, COMPOUND_DEFS },
};