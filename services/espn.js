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

// teamTotal.js is a pure leaf module (no requires) — safe to pull in at
// top level; espn.js itself is only require()'d lazily from grading.js, so
// this does not create a cycle.
const { isTeamTotalBet } = require('./sportsdata/teamTotal');

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

// ── Team-total scoring units per sport ──
// A team total ("Mariners under 4.5 runs") resolves to ONE team's SCORE, which
// is exactly competitor.score in the sport's scoring unit. We only grade the
// units that map to the score: runs (MLB), goals (NHL), points (NBA/NFL).
// Stats NOT on the scoreboard (hits, strikeouts, total bases, corners) are
// deliberately excluded — we can't settle them, so they fall through to AI.
const TEAM_TOTAL_UNITS = {
  MLB: /\bruns?\b/i,
  NHL: /\bgoals?\b/i,
  NBA: /\b(points?|pts)\b/i,
  NFL: /\b(points?|pts)\b/i,
};

// Plausible UPPER bound for a single team's full-game score per sport. A line
// above this is game-total magnitude ("Mariners over 8.5 runs" is the GAME
// total, not Seattle's team total) → refuse and fall through to AI rather than
// risk a wrong confident grade. Biased LOW so the overlap band with low game
// totals (MLB ~6.5, NHL ~5) is excluded; legit high team totals just fall
// through to AI (a missing grade is acceptable; a wrong grade is not).
const TEAM_TOTAL_MAX_LINE = { MLB: 5.5, NHL: 4.5, NBA: 150, NFL: 34 };

// Period / segment markets are NOT full-game team totals — refuse them so we
// never grade a segment line off the final score.
const SEGMENT_RX = /\b(1st|first|2nd|second|3rd|third|4th|fourth|5th|6th|7th|8th|9th|inning|innings|inn|frame|f5|1h|2h|first\s+half|second\s+half|halftime|half|quarter|qtr|1q|2q|3q|4q|period|1p|2p|3p|thru|through|top|bottom)\b/i;

// Words allowed to remain in a "bare" team-total description after the team
// name, over/under, line, and score unit are removed. Deliberately TIGHT — only
// explicit team-total vocabulary, NOT broad English words. A broad blacklist
// would silently absorb a player surname (e.g. "Reg", "Game") and let a player
// prop through; an allow-list refuses anything it doesn't recognize.
const TEAM_TOTAL_ALLOWED = new Set([
  'team', 'total', 'totals', 'tt', 'itt', 'alt', 'alternate', 'altline', 'line',
]);

// Word-tokens left over after removing the team name, the over/under N, and the
// score unit. ANY leftover token outside TEAM_TOTAL_ALLOWED means a player name
// or extra market is present ("Chiefs Mahomes over 1.5 points" → ["mahomes"];
// "Mariners over 0.5 runs Reg" → ["reg"]) → disqualify the team total.
function teamTotalLeftoverTokens(descLower, teamLc) {
  let s = ' ' + descLower + ' ';
  for (const tok of String(teamLc || '').split(/\s+/)) {
    if (tok.length >= 2) s = s.replace(new RegExp(`\\b${escapeRegex(tok)}\\b`, 'g'), ' ');
  }
  s = s
    .replace(/\b(over|under|o|u)\b/g, ' ')
    .replace(/[+-]?\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(runs?|goals?|points?|pts)\b/g, ' ')
    .replace(/[^a-z]+/g, ' ');
  return s.split(/\s+/).filter(t => t.length >= 2 && !TEAM_TOTAL_ALLOWED.has(t));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize a team string for comparison: lowercase, drop periods/apostrophes
// ("st. louis" → "st louis", "d'angelo" → "dangelo"), collapse whitespace.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
}

// Does `haystack` end with `needle` on a whole-word boundary?
// "boston red sox" endsWithWord "red sox" → true; "chicago white sox" → false.
function endsWithWord(haystack, needle) {
  if (!needle || !haystack.endsWith(needle)) return false;
  const i = haystack.length - needle.length;
  return i === 0 || haystack[i - 1] === ' ';
}

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
// The old form derived a single last-word nickname (`bt.split(' ').pop()`) and
// did `displayName.endsWith(nickname)`, so "boston red sox" → nickname "sox"
// matched BOTH "boston red sox" AND "chicago white sox". On a slate with both
// Sox games that produced 2 matches → ambiguity refusal → no grade (Build 2
// canary). We now match on the FULL strings, anchored on whole nicknames:
//   (1) exact against any normalized ESPN name field;
//   (2) bet string ends with ESPN's whole nickname — covers ESPN dropping or
//       abbreviating the city ("oakland athletics" ⊃ ESPN "athletics",
//       "los angeles clippers" ⊃ ESPN short "clippers") while still keeping
//       "boston red sox" ⊅ "white sox";
//   (3) ESPN display ends with the whole bet string — covers the bet dropping
//       the city ("red sox" ⊂ "boston red sox", but ⊄ "chicago white sox").
// Punctuation is normalized so "st louis" matches ESPN "St. Louis". A genuinely
// bare ambiguous token ("sox") still matches both Sox and is correctly refused
// downstream by the matches.length!==1 ambiguity guard.
function teamMatches(betTeam, espnTeam) {
  const bt = normName(betTeam);
  if (!bt) return false;
  const displayName = normName(espnTeam.displayName);
  const shortName = normName(espnTeam.shortName);
  const abbrev = normName(espnTeam.abbrev);

  if (displayName === bt || shortName === bt || abbrev === bt) return true;
  if (shortName && endsWithWord(bt, shortName)) return true;
  if (displayName && endsWithWord(displayName, bt)) return true;

  return false;
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
function parseBetDescription(description, betTeams, sport) {
  const desc = (description || '').trim();
  const descLower = desc.toLowerCase();

  // ── Team total (ONE team's score) — must run BEFORE the prop bail and the
  // game-total branch. "Mariners under 4.5 runs" is the named team's runs, not
  // a player prop (PROP_KEYWORDS hits "runs") and not the game total (sum of
  // both teams). It only grades when ALL guards hold, otherwise it falls
  // through to AI (a missing grade is safe; a wrong grade is not):
  //   • exactly ONE team subject, whose name appears in the description;
  //   • the explicit "team total"/"TT" keyword OR a sport-matching SCORE unit
  //     word (runs/goals/points) — only the unit that maps to competitor.score;
  //   • no player name / extra market left over (residual-token guard) — keeps
  //     "Chiefs Mahomes over 2.5 points" out;
  //   • not an inning/period segment;
  //   • the line is within the sport's plausible TEAM-total range — a game-total
  //     magnitude line ("Mariners over 8.5 runs") falls through, not mis-graded.
  const ouTeamTotal = descLower.match(/\b(over|under|o|u)\s*(\d+\.?\d*)\b/);
  const ttMaxLine = TEAM_TOTAL_MAX_LINE[(sport || '').toUpperCase()];
  if (
    ouTeamTotal && ttMaxLine &&
    Array.isArray(betTeams) && betTeams.length === 1 &&
    !SEGMENT_RX.test(descLower)
  ) {
    const explicitTT = isTeamTotalBet(description);
    const unitRx = TEAM_TOTAL_UNITS[(sport || '').toUpperCase()];
    const hasScoreUnit = unitRx ? unitRx.test(descLower) : false;
    if (explicitTT || hasScoreUnit) {
      const teamLc = normName(betTeams[0]);
      const nick = teamLc.split(/\s+/).pop();
      const descNorm = normName(desc);
      const subjectInDesc =
        descNorm.includes(teamLc) ||
        (nick && nick.length >= 3 && new RegExp(`\\b${escapeRegex(nick)}\\b`).test(descNorm));
      const bareTeamTotal = teamTotalLeftoverTokens(descNorm, teamLc).length === 0;
      const line = parseFloat(ouTeamTotal[2]);
      if (subjectInDesc && bareTeamTotal && Number.isFinite(line) && line >= 0.5 && line <= ttMaxLine) {
        const direction = (ouTeamTotal[1] === 'over' || ouTeamTotal[1] === 'o') ? 'over' : 'under';
        return { type: 'team_total', line, direction, team: betTeams[0] };
      }
    }
  }

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

  // ── Team total — the NAMED team's score only (not the game total) ──
  if (parsed.type === 'team_total') {
    const wanted = parsed.team || (betTeams && betTeams[0]);
    let picked = null;
    if (wanted) {
      for (const c of competitors) {
        if (teamMatches(wanted, c)) { picked = c; break; }
      }
    }
    if (!picked || !Number.isFinite(picked.score)) return null;
    if (picked.score === parsed.line) {
      return { result: 'PUSH', evidence: `${picked.displayName} team total ${picked.score} = ${parsed.line}. ${scoreLine}` };
    }
    const won = parsed.direction === 'over'
      ? picked.score > parsed.line
      : picked.score < parsed.line;
    return { result: won ? 'WIN' : 'LOSS', evidence: `${picked.displayName} team total ${picked.score} vs ${parsed.line} (${parsed.direction}). ${scoreLine}` };
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
  const parsed = parseBetDescription(bet.description, betTeamList, sport);
  if (!parsed.type) {
    console.log(`[ESPN] Skip: ${parsed.reason || 'unparseable'} | "${(bet.description || '').slice(0, 60)}"`);
    return { ok: false, reason: parsed.reason || 'unparseable' };
  }

  // Date from event_date (preferred) or created_at.
  // ESPN scoreboards are indexed by ET date; bet timestamps are UTC. A bet
  // created at 01:30 UTC is often for the previous ET calendar day. Try
  // both dates so we don't need a timezone lib. Max 2 API calls per bet.
  const rawDate = bet.event_date || bet.created_at;
  if (!rawDate) return { ok: false, reason: 'no_date' };
  const dateObj = new Date(rawDate);
  const dateStr = dateObj.toISOString().split('T')[0];
  const prevDate = new Date(dateObj.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  console.log(`[ESPN] ${sport} score lookup: date=${dateStr} (fallback ${prevDate}), teams=[${(betTeamList || []).join(', ')}], type=${parsed.type}${parsed.line != null ? ` line=${parsed.line}` : ''}${parsed.direction ? ` dir=${parsed.direction}` : ''}`);

  // 1. Try primary (UTC-derived) date
  let events = await fetchScoreboard(sport, dateStr);
  let usedDate = dateStr;

  // 2. Fallback to previous day if primary has no events at all
  if (!events || events.length === 0) {
    console.log(`[ESPN] No events on ${dateStr}, trying ${prevDate}`);
    events = await fetchScoreboard(sport, prevDate);
    usedDate = prevDate;
  }

  if (!events || events.length === 0) {
    console.log(`[ESPN] No events for ${sport} on ${dateStr} or ${prevDate}`);
    recordStat(sport, 'misses');
    return { ok: false, reason: 'no_events' };
  }

  // 3. Try team match on the date we have
  let match = matchTeamsToEvent(events, betTeamList);

  // 4. If primary date had events but no team match, retry on prevDate
  //    (covers the case where the UTC-derived date happens to have other
  //    games scheduled but the team we want played the night before ET).
  if (!match && usedDate === dateStr) {
    const prevEvents = await fetchScoreboard(sport, prevDate);
    if (prevEvents && prevEvents.length > 0) {
      const prevMatch = matchTeamsToEvent(prevEvents, betTeamList);
      if (prevMatch) {
        match = prevMatch;
        events = prevEvents;
        usedDate = prevDate;
      }
    }
  }

  if (!match) {
    // Debug-dump ESPN's team names so we can spot alias gaps.
    const espnTeams = events
      .map(e => (e.competitions?.[0]?.competitors || []).map(c => c.team?.displayName).filter(Boolean))
      .flat();
    console.log(`[ESPN] No match for [${(betTeamList || []).join(', ')}] in ${events.length} events on ${usedDate}. ESPN teams: [${espnTeams.join(', ')}]`);
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
  teamMatches,
  parseBetDescription,
  gradeFromScore,
  espnStats,
  ESPN_ENDPOINTS,
};
