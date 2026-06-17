// services/sportsdata/nhl.js
// NHL Web API adapter — api-web.nhle.com, free, no auth.
// Docs (unofficial): https://github.com/Zmalski/NHL-API-Reference

const BASE = 'https://api-web.nhle.com/v1';
const TIMEOUT_MS = 8000;

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`NHL API HTTP ${res.status}`);
  return res.json();
}

// Team aliases — bet text → canonical team name as returned by NHL API.
// Note: NHL API returns names like { default: "Rangers" } and placeName: { default: "New York" }.
// We match on the nickname (commonName) which is just the team's nickname.
const TEAM_ALIASES = {
  'avalanche': 'Avalanche',
  'avs': 'Avalanche',
  'maple leafs': 'Maple Leafs',
  'leafs': 'Maple Leafs',
  'golden knights': 'Golden Knights',
  'vgk': 'Golden Knights',
  'knights': 'Golden Knights',
  'red wings': 'Red Wings',
  'wings': 'Red Wings',
  'rangers': 'Rangers',
  'capitals': 'Capitals',
  'caps': 'Capitals',
  'bruins': 'Bruins',
  'penguins': 'Penguins',
  'pens': 'Penguins',
  'flyers': 'Flyers',
  'islanders': 'Islanders',
  'isles': 'Islanders',
  'devils': 'Devils',
  'lightning': 'Lightning',
  'bolts': 'Lightning',
  'panthers': 'Panthers',
  'hurricanes': 'Hurricanes',
  'canes': 'Hurricanes',
  'blue jackets': 'Blue Jackets',
  'jackets': 'Blue Jackets',
  'cbj': 'Blue Jackets',
  'sabres': 'Sabres',
  'senators': 'Senators',
  'sens': 'Senators',
  'canadiens': 'Canadiens',
  'habs': 'Canadiens',
  'jets': 'Jets',
  'wild': 'Wild',
  'blues': 'Blues',
  'stars': 'Stars',
  'predators': 'Predators',
  'preds': 'Predators',
  'blackhawks': 'Blackhawks',
  'hawks': 'Blackhawks',
  'sharks': 'Sharks',
  'kings': 'Kings',
  'ducks': 'Ducks',
  'oilers': 'Oilers',
  'flames': 'Flames',
  'canucks': 'Canucks',
  'kraken': 'Kraken',
  'utah': 'Mammoth',
  'mammoth': 'Mammoth',
};

function canonicalize(teamText) {
  if (!teamText) return null;
  const lower = teamText.toLowerCase().trim();
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  // Longer aliases first so "blue jackets" matches before "jackets" partials don't fire
  const sortedAliases = Object.entries(TEAM_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of sortedAliases) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

// Fetch all games on a given date.
async function getGamesByDate(dateYMD) {
  const data = await fetchJSON(`${BASE}/score/${dateYMD}`);
  return data?.games || [];
}

function matchesTeam(g, canonical) {
  const homeName = g.homeTeam?.name?.default;
  const awayName = g.awayTeam?.name?.default;
  return homeName === canonical || awayName === canonical;
}

// Get the final game for a team on a given date.
async function getGameForTeam(teamName, dateYMD) {
  const canonical = canonicalize(teamName);
  if (!canonical) return null;
  const games = await getGamesByDate(dateYMD);
  for (const g of games) {
    if (!matchesTeam(g, canonical)) continue;
    // gameState: "OFF" = final, "FUT" = scheduled, "LIVE" = in progress, "FINAL" = final too
    const finished = g.gameState === 'OFF' || g.gameState === 'FINAL';
    const homeName = g.homeTeam?.name?.default;
    const awayName = g.awayTeam?.name?.default;
    const homeScore = g.homeTeam?.score ?? 0;
    const awayScore = g.awayTeam?.score ?? 0;
    return {
      found: true,
      finished,
      gameId: g.id,
      away: awayName,
      home: homeName,
      awayScore,
      homeScore,
      winner: finished ? (homeScore > awayScore ? homeName : awayName) : null,
      gameState: g.gameState,
    };
  }
  return null;
}

// Game-level bet grading: ML, puck line, totals.
async function gradeNhlBet(description, dateYMD) {
  const desc = description.toLowerCase();

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

  const game = await getGameForTeam(teamHits[0].canonical, dateYMD);
  if (!game) return { resolved: false, reason: 'no_game_on_date' };
  if (!game.finished) {
    return { resolved: true, status: 'PENDING', evidence: `Game scheduled but not final (${game.gameState})`, source: 'nhl_api' };
  }

  const betTeam = teamHits[0].canonical;
  const betTeamScore = game.away === betTeam ? game.awayScore : game.homeScore;
  const oppScore = game.away === betTeam ? game.homeScore : game.awayScore;
  const margin = betTeamScore - oppScore;
  const totalGoals = game.awayScore + game.homeScore;

  // Moneyline
  const isML = /\bml\b/.test(desc) || (!desc.includes('+') && !desc.includes('-') && !desc.match(/over|under|o\s*\d|u\s*\d/i));
  if (isML) {
    const won = game.winner === betTeam;
    return {
      resolved: true,
      status: won ? 'WIN' : 'LOSS',
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} ${won ? 'won' : 'lost'}.`,
      source: 'nhl_api',
    };
  }

  // Puck line ±1.5
  const plMatch = desc.match(/([+-])\s*1\.5/);
  if (plMatch) {
    const line = plMatch[1] === '-' ? -1.5 : 1.5;
    const won = line < 0 ? margin > Math.abs(line) : margin > line;
    return {
      resolved: true,
      status: won ? 'WIN' : 'LOSS',
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). ${betTeam} margin ${margin > 0 ? '+' : ''}${margin}, line ${line}.`,
      source: 'nhl_api',
    };
  }

  // Total goals over/under
  const totalMatch = desc.match(/(over|under|\bo\b|\bu\b)\s*(\d+(?:\.\d+)?)/i);
  if (totalMatch) {
    const direction = totalMatch[1].toLowerCase().startsWith('o') ? 'over' : 'under';
    const line = parseFloat(totalMatch[2]);
    let status;
    if (totalGoals === line) status = 'PUSH';
    else if (direction === 'over') status = totalGoals > line ? 'WIN' : 'LOSS';
    else status = totalGoals < line ? 'WIN' : 'LOSS';
    return {
      resolved: true,
      status,
      evidence: `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} (Final). Total ${totalGoals}, ${direction} ${line}.`,
      source: 'nhl_api',
    };
  }

  return { resolved: false, reason: 'unsupported_bet_type' };
}

// ── Player props ──

// Map common bet-text stat names to NHL boxscore field names.
const STAT_MAP = {
  'goal': 'goals',
  'goals': 'goals',
  'g': 'goals',
  'assist': 'assists',
  'assists': 'assists',
  'a': 'assists',
  'point': 'points',
  'points': 'points',
  'p': 'points',
  'sog': 'sog',
  'shot': 'sog',
  'shots': 'sog',
  'shots on goal': 'sog',
  'shot on goal': 'sog',
  'hits': 'hits',
  'hit': 'hits',
  'blocked shots': 'blockedShots',
  'blocks': 'blockedShots',
  // Goalie
  'saves': 'saves',
  'save': 'saves',
  'shots against': 'shotsAgainst',
  'goals against': 'goalsAgainst',
};

function resolveStat(statText) {
  const key = statText.toLowerCase().trim();
  if (STAT_MAP[key]) return STAT_MAP[key];
  for (const [alias, field] of Object.entries(STAT_MAP)) {
    if (key.includes(alias)) return field;
  }
  return null;
}

// NHL names in boxscore come as "Z. Benson" (first initial + last name).
// We need to match against bet-text names like "Zach Benson" or "Connor McDavid".
function nameMatches(boxName, lastLower, firstLower) {
  // boxName format: "Z. Benson" → split on "." then take last word
  const cleaned = boxName.toLowerCase().replace(/\./g, '').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) return false;
  const apiLast = parts[parts.length - 1];
  const apiFirstInitial = parts[0]; // "z" for "Z. Benson"
  if (apiLast !== lastLower) return false;
  if (firstLower && apiFirstInitial !== firstLower[0]) return false;
  return true;
}

function findPlayerInBoxscore(boxscore, lastName, firstName = null) {
  const lastLower = lastName.toLowerCase();
  const firstLower = (firstName || '').toLowerCase();
  const pbg = boxscore?.playerByGameStats;
  if (!pbg) return null;

  for (const side of ['homeTeam', 'awayTeam']) {
    const team = pbg[side];
    if (!team) continue;
    const allPlayers = [
      ...(team.forwards || []),
      ...(team.defense || []),
      ...(team.goalies || []),
    ];
    for (const p of allPlayers) {
      const name = p.name?.default || '';
      if (nameMatches(name, lastLower, firstLower)) {
        return {
          player: name,
          isGoalie: p.position === 'G',
          stats: p,
        };
      }
    }
  }
  return null;
}

// Find which game a player appeared in on a given date.
async function findPlayerGame(lastName, dateYMD, firstName = null) {
  const games = await getGamesByDate(dateYMD);
  for (const g of games) {
    try {
      const bs = await fetchJSON(`${BASE}/gamecenter/${g.id}/boxscore`);
      const found = findPlayerInBoxscore(bs, lastName, firstName);
      if (found) {
        return {
          gameId: g.id,
          finished: g.gameState === 'OFF' || g.gameState === 'FINAL',
          gameState: g.gameState,
          ...found,
        };
      }
    } catch (_) { /* skip */ }
  }
  return null;
}

// Parse a player-prop description.
function parsePlayerProp(description) {
  const desc = description.trim();

  // Pattern: Anytime Goal Scorer / Anytime Goalscorer / ATGS
  if (/anytime\s+goal\s*scorer|atgs|any time goal scorer/i.test(desc)) {
    // Extract player name — everything before "anytime" or "any time"
    const m = desc.match(/^(.+?)\s+(?:anytime|any\s+time)/i);
    if (m) {
      return {
        player: m[1].trim(),
        stat: 'goals',
        direction: 'over',
        threshold: 0.5, // anytime = 1+ goal = over 0.5
        propName: 'Anytime Goal Scorer',
      };
    }
  }

  // Pattern: "Player N+ Stat"
  let m = desc.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/i);
  if (m) {
    const stat = resolveStat(m[3].trim());
    return {
      player: m[1].trim(),
      stat,
      direction: 'over',
      threshold: parseFloat(m[2]) - 0.5,
      propName: m[3].trim(),
    };
  }

  // Pattern: "Player O|U|Over|Under N Stat"
  m = desc.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (m) {
    const dir = m[2].toLowerCase().startsWith('o') ? 'over' : 'under';
    const stat = resolveStat(m[4].trim());
    return {
      player: m[1].trim(),
      stat,
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
// greedily ("Edmonton Oilers Over 6.5 Goals" → {player:"Edmonton Oilers",
// stat:"goals"}), so if the subject before the O/U resolves to a known team, this is a
// team total — route it to the team grader, not the prop grader.
function looksLikePlayerProp(description) {
  const parsed = parsePlayerProp(description);
  if (!parsed || !parsed.stat) return false;     // no gradeable stat
  if (canonicalize(parsed.player)) return false; // subject is a team → team total
  return true;
}

async function gradeNhlPlayerProp(description, dateYMD) {
  const parsed = parsePlayerProp(description);
  if (!parsed) return { resolved: false, reason: 'unparseable_player_prop' };
  if (!parsed.stat) return { resolved: false, reason: 'unknown_stat' };

  const tokens = parsed.player.split(/\s+/).filter(Boolean);
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : tokens[0];
  const firstName = tokens.length > 1 ? tokens[0] : null;

  const result = await findPlayerGame(lastName, dateYMD, firstName);
  if (!result) return { resolved: false, reason: 'player_not_found_in_games_on_date' };
  if (!result.finished) {
    return { resolved: true, status: 'PENDING', evidence: `${result.player}'s game not yet final (${result.gameState})`, source: 'nhl_api' };
  }

  const value = result.stats[parsed.stat];
  if (value === undefined || value === null) {
    return { resolved: false, reason: `stat_not_in_boxscore: ${parsed.stat}` };
  }

  let status;
  if (value === parsed.threshold) status = 'PUSH';
  else if (parsed.direction === 'over') status = value > parsed.threshold ? 'WIN' : 'LOSS';
  else status = value < parsed.threshold ? 'WIN' : 'LOSS';

  return {
    resolved: true,
    status,
    evidence: `${result.player} had ${value} ${parsed.stat} (line: ${parsed.direction} ${parsed.threshold}).`,
    source: 'nhl_api',
  };
}

module.exports = {
  gradeNhlBet,
  gradeNhlPlayerProp,
  getGameForTeam,
  findPlayerGame,
  parsePlayerProp,
  looksLikePlayerProp,
  canonicalize,
  _internal: { TEAM_ALIASES, STAT_MAP },
};