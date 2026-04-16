// ═══════════════════════════════════════════════════════════
// ESPN API — deterministic grading for MLB/NBA/NHL/NFL
// standard bets (moneyline, spread, total).
//
// Eliminates AI calls for the most common bet types by using
// ESPN's free public scoreboard API. No API key required.
// No rate limit at our volume (~100 req/day).
//
// Player props, parlays, and exotic bet types fall through
// (return ok:false) — those still need the AI grading path.
// ═══════════════════════════════════════════════════════════

// ── ESPN scoreboard endpoints per sport ──
const ESPN_ENDPOINTS = {
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
};

// ── In-memory stats for /admin snapshot ──
const espnStats = {
  requests: 0,
  hits: 0,
  misses: 0,
  errors: 0,
  grades: 0,
  bySport: {},
  lastRequest: null,
  lastGrade: null,
};

function recordStat(sport, type) {
  espnStats[type] = (espnStats[type] || 0) + 1;
  if (type === 'requests') espnStats.lastRequest = Date.now();
  if (type === 'grades') espnStats.lastGrade = Date.now();
  if (sport) {
    if (!espnStats.bySport[sport]) espnStats.bySport[sport] = { requests: 0, grades: 0 };
    if (type === 'requests') espnStats.bySport[sport].requests++;
    if (type === 'grades') espnStats.bySport[sport].grades++;
  }
}

// ── Prop / exotic detection — these fall through to AI ──
const PROP_KEYWORDS = /\b(pts|points|reb|rebounds|ast|assists|stl|steals|blk|blocks|yds|yards|tds|touchdowns|strikeouts|hits|runs|rbis?|sacks|receptions|goals|shots|saves|aces|kills|completions|pass.?yds|rush.?yds|rec.?yds|home.?runs?|sog|fantasy|player|anytime|first|last|scorer|td|nrfi|yrfi|sgp)\b/i;

// ── Fetch ESPN scoreboard ──
async function fetchScoreboard(sport, dateStr) {
  const base = ESPN_ENDPOINTS[sport?.toUpperCase()];
  if (!base) return [];

  const dateParam = dateStr.replace(/-/g, '');
  const url = `${base}?dates=${dateParam}`;

  recordStat(sport, 'requests');
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.log(`[ESPN] HTTP ${res.status} for ${sport} ${dateStr}`);
      recordStat(sport, 'errors');
      return [];
    }
    const data = await res.json();
    return data.events || [];
  } catch (err) {
    console.log(`[ESPN] Fetch error for ${sport} ${dateStr}: ${err.message}`);
    recordStat(sport, 'errors');
    return [];
  }
}

// ── Build a flat lookup from ESPN competitors ──
function buildTeamInfo(competitor) {
  return {
    displayName: (competitor.team?.displayName || '').toLowerCase(),
    shortName: (competitor.team?.shortDisplayName || '').toLowerCase(),
    abbrev: (competitor.team?.abbreviation || '').toLowerCase(),
    score: parseInt(competitor.score, 10),
    homeAway: competitor.homeAway,
    winner: competitor.winner,
  };
}

// ── Match bet team string against an ESPN team ──
function teamMatches(betTeam, espnTeam) {
  const bt = betTeam.toLowerCase();
  const nickname = bt.split(' ').pop();
  return (
    espnTeam.displayName === bt ||
    espnTeam.displayName.endsWith(nickname) ||
    espnTeam.shortName === nickname ||
    espnTeam.abbrev === bt ||
    espnTeam.abbrev === nickname
  );
}

// ── Find the ESPN game matching any of the bet's teams ──
function matchTeamsToEvent(events, betTeams) {
  if (!betTeams || betTeams.length === 0) return null;

  const matches = [];
  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    if (!comp.status?.type?.completed) continue;

    const competitors = (comp.competitors || []).map(buildTeamInfo);
    if (competitors.length !== 2) continue;

    const anyMatch = betTeams.some(bt =>
      competitors.some(c => teamMatches(bt, c))
    );

    if (anyMatch) matches.push({ competitors, event, competition: comp });
  }

  // Ambiguous (>1 game matches) → refuse to grade
  if (matches.length !== 1) return null;
  return matches[0];
}

// ── Parse bet.description into type + line + direction ──
function parseBetDescription(description, betTeams) {
  const desc = (description || '').trim();
  const descLower = desc.toLowerCase();

  // Player prop / exotic → bail early
  if (PROP_KEYWORDS.test(descLower)) {
    return { type: null, reason: 'player_prop' };
  }

  // Multi-bet strings ("Hornets -6 and Blazers +3.5") → bail
  if (/\b(and|&)\b/i.test(desc) && betTeams?.length >= 2) {
    return { type: null, reason: 'multi_bet_string' };
  }

  // ── Total (Over / Under) ──
  // Match: "O220.5", "Over 220.5", "U7.5", "Under 7.5"
  const totalMatch = descLower.match(/\b(over|under|o|u)\s*(\d+\.?\d*)/);
  if (totalMatch) {
    const rawDir = totalMatch[1];
    const direction = (rawDir === 'over' || rawDir === 'o') ? 'over' : 'under';
    const line = parseFloat(totalMatch[2]);
    // Sanity: totals are usually ≥ 2 (not odds). MLB: 5-15, NBA: 180-260, NHL: 4-9
    if (line >= 2) {
      return { type: 'total', line, direction };
    }
  }

  // ── Explicit ML / Moneyline ──
  if (/\b(ml|moneyline|money\s*line)\b/i.test(descLower)) {
    return { type: 'ml', team: betTeams?.[0] || null };
  }

  // ── Spread — look for +/- values where |value| ≤ 30 ──
  // Must NOT be 3-digit (those are American odds like +110, -115)
  // Accepts: -1.5, +5.5, -3, +7
  const spreadMatch = desc.match(/([+-]\d{1,2}(?:\.\d+)?)\b/);
  if (spreadMatch) {
    const val = parseFloat(spreadMatch[1]);
    if (Number.isFinite(val) && Math.abs(val) <= 30) {
      // Check it's not immediately followed by more digits (ruling out odds like -115)
      const afterMatch = desc.slice(desc.indexOf(spreadMatch[0]) + spreadMatch[0].length);
      if (!/^\d/.test(afterMatch)) {
        return { type: 'spread', team: betTeams?.[0] || null, line: val };
      }
    }
  }

  // ── Bare team name with 3-digit odds (implied ML) ──
  // e.g., "Atlanta Braves -115", "Cardinals +140"
  if (betTeams?.length >= 1) {
    const oddsMatch = desc.match(/[+-]\d{3,}/);
    if (oddsMatch) {
      return { type: 'ml', team: betTeams[0] };
    }
  }

  return { type: null, reason: 'unparseable' };
}

// ── Grade deterministically from score ──
function gradeFromScore(parsed, match, betTeams) {
  if (!parsed || !match) return null;
  const { competitors } = match;

  const homeTeam = competitors.find(c => c.homeAway === 'home');
  const awayTeam = competitors.find(c => c.homeAway === 'away');
  if (!homeTeam || !awayTeam) return null;

  const scoreLine = `${awayTeam.displayName} ${awayTeam.score}, ${homeTeam.displayName} ${homeTeam.score} (Final per ESPN)`;

  // ── Total ──
  if (parsed.type === 'total') {
    const gameTotal = homeTeam.score + awayTeam.score;
    if (gameTotal === parsed.line) {
      return { result: 'PUSH', evidence: `Total ${gameTotal} = line ${parsed.line}. ${scoreLine}` };
    }
    if (parsed.direction === 'over') {
      const won = gameTotal > parsed.line;
      return { result: won ? 'WIN' : 'LOSS', evidence: `Total ${gameTotal} ${won ? '>' : '<'} ${parsed.line} (over). ${scoreLine}` };
    } else {
      const won = gameTotal < parsed.line;
      return { result: won ? 'WIN' : 'LOSS', evidence: `Total ${gameTotal} ${won ? '<' : '>'} ${parsed.line} (under). ${scoreLine}` };
    }
  }

  // ── ML / Spread — need to identify which team the bettor picked ──
  let picked = null;
  let opponent = null;
  if (betTeams?.length >= 1) {
    for (const c of competitors) {
      if (teamMatches(betTeams[0], c)) {
        picked = c;
        opponent = competitors.find(x => x !== c);
        break;
      }
    }
  }
  if (!picked || !opponent) return null;

  if (parsed.type === 'ml') {
    if (picked.score === opponent.score) {
      return { result: 'PUSH', evidence: `Tied ${picked.score}-${opponent.score}. ${scoreLine}` };
    }
    const won = picked.score > opponent.score;
    return { result: won ? 'WIN' : 'LOSS', evidence: `${picked.displayName} ${picked.score}, ${opponent.displayName} ${opponent.score} (ML). ${scoreLine}` };
  }

  if (parsed.type === 'spread') {
    const covered = picked.score + parsed.line - opponent.score;
    if (covered === 0) {
      return { result: 'PUSH', evidence: `${picked.displayName} ${picked.score} + (${parsed.line}) = ${opponent.displayName} ${opponent.score}. ${scoreLine}` };
    }
    const won = covered > 0;
    return { result: won ? 'WIN' : 'LOSS', evidence: `${picked.displayName} ${picked.score} + (${parsed.line}) vs ${opponent.displayName} ${opponent.score} (${won ? 'covered' : 'missed'}). ${scoreLine}` };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// Main entry point — called from gradeSingleBet
// ═══════════════════════════════════════════════════════════
async function tryGradeViaESPN(bet, betTeamList) {
  const sport = (bet.sport || '').toUpperCase();
  if (!ESPN_ENDPOINTS[sport]) {
    return { ok: false, reason: 'unsupported_sport' };
  }

  // Skip parlays/SGPs — these are dispatched through gradeParlay, not gradeSingleBet,
  // but guard defensively in case someone calls us on one.
  const bt = (bet.bet_type || '').toLowerCase();
  if (bt === 'parlay' || bt === 'sgp') {
    return { ok: false, reason: 'parlay' };
  }

  // Parse the description
  const parsed = parseBetDescription(bet.description, betTeamList);
  if (!parsed.type) {
    console.log(`[ESPN] Skip: ${parsed.reason || 'unparseable'} | "${(bet.description || '').slice(0, 60)}"`);
    return { ok: false, reason: parsed.reason || 'unparseable' };
  }

  // Date from event_date (preferred) or created_at
  const rawDate = bet.event_date || bet.created_at;
  if (!rawDate) return { ok: false, reason: 'no_date' };
  const dateStr = new Date(rawDate).toISOString().split('T')[0];

  console.log(`[ESPN] ${sport} score lookup: date=${dateStr}, teams=[${(betTeamList || []).join(', ')}], type=${parsed.type}${parsed.line != null ? ` line=${parsed.line}` : ''}${parsed.direction ? ` dir=${parsed.direction}` : ''}`);

  // Fetch scoreboard
  const events = await fetchScoreboard(sport, dateStr);
  if (events.length === 0) {
    console.log(`[ESPN] No events for ${sport} on ${dateStr}`);
    recordStat(sport, 'misses');
    return { ok: false, reason: 'no_events' };
  }

  // Match teams
  const match = matchTeamsToEvent(events, betTeamList);
  if (!match) {
    console.log(`[ESPN] No match for [${(betTeamList || []).join(', ')}] in ${events.length} events`);
    recordStat(sport, 'misses');
    return { ok: false, reason: 'no_team_match' };
  }

  recordStat(sport, 'hits');

  // Deterministic grade
  const grade = gradeFromScore(parsed, match, betTeamList);
  if (!grade) {
    console.log(`[ESPN] Could not grade type=${parsed.type} for "${(bet.description || '').slice(0, 60)}"`);
    return { ok: false, reason: 'grade_failed' };
  }

  recordStat(sport, 'grades');
  console.log(`[ESPN] Grade: ${(bet.description || '').slice(0, 50)} = ${grade.result} | ${grade.evidence.slice(0, 80)}`);

  return { ok: true, result: grade.result, evidence: grade.evidence };
}

module.exports = {
  getScore: fetchScoreboard,
  tryGradeViaESPN,
  matchTeamsToEvent,
  parseBetDescription,
  gradeFromScore,
  espnStats,
  ESPN_ENDPOINTS,
};
