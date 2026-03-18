const { getPendingBets, gradeBet, updateBankroll, saveDailySnapshot } = require('./database');
const { gradeBetAI } = require('./ai');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = process.env.ODDS_API_KEY;

// Map our sport names to Odds API sport keys
const SPORT_MAP = {
  'NBA': 'basketball_nba',
  'NFL': 'americanfootball_nfl',
  'MLB': 'baseball_mlb',
  'NHL': 'icehockey_nhl',
  'NCAAF': 'americanfootball_ncaaf',
  'NCAAB': 'basketball_ncaab',
  'MLS': 'soccer_usa_mls',
  'EPL': 'soccer_epl',
  'UCL': 'soccer_uefa_champs_league',
  'CHAMPIONS LEAGUE': 'soccer_uefa_champs_league',
  'EUROPA LEAGUE': 'soccer_uefa_europa_league',
  'LA LIGA': 'soccer_spain_la_liga',
  'SERIE A': 'soccer_italy_serie_a',
  'BUNDESLIGA': 'soccer_germany_bundesliga',
  'LIGUE 1': 'soccer_france_ligue_one',
  'WORLD CUP': 'soccer_fifa_world_cup',
  'SOCCER': 'soccer_epl',
  'UFC': 'mma_mixed_martial_arts',
  'MMA': 'mma_mixed_martial_arts',
  'BOXING': 'mma_mixed_martial_arts',
  'GOLF': 'golf_pga_championship',
  'TENNIS': 'tennis_atp_french_open',
};

// ── Fetch completed scores ──────────────────────────────────
async function fetchScores(sport) {
  const sportKey = SPORT_MAP[sport?.toUpperCase()];
  if (!sportKey || !API_KEY) return [];

  try {
    const url = `${ODDS_API_BASE}/sports/${sportKey}/scores/?apiKey=${API_KEY}&daysFrom=3&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.filter(g => g.completed);
  } catch (err) {
    console.error(`[Grading] Score fetch error for ${sport}:`, err.message);
    return [];
  }
}

// ── Calculate profit from odds ──────────────────────────────
function calcProfit(odds, units, result) {
  if (result === 'push') return 0;
  if (result === 'loss') return -units;
  if (result === 'void') return 0;

  // Win
  if (odds > 0) return units * (odds / 100);
  if (odds < 0) return units * (100 / Math.abs(odds));
  return 0;
}

// ── Match a bet description to a game result ────────────────
function matchBetToGame(bet, scores) {
  const desc = bet.description.toLowerCase();

  for (const game of scores) {
    const home = game.home_team?.toLowerCase() || '';
    const away = game.away_team?.toLowerCase() || '';

    // Check if any team name fragment is in the bet description
    const homeWords = home.split(' ');
    const awayWords = away.split(' ');

    const homeMatch = homeWords.some(w => w.length > 3 && desc.includes(w));
    const awayMatch = awayWords.some(w => w.length > 3 && desc.includes(w));

    if (homeMatch || awayMatch) {
      const homeScore = game.scores?.find(s => s.name === game.home_team)?.score;
      const awayScore = game.scores?.find(s => s.name === game.away_team)?.score;

      if (homeScore != null && awayScore != null) {
        return {
          game,
          homeScore: parseFloat(homeScore),
          awayScore: parseFloat(awayScore),
          matchedTeam: homeMatch ? game.home_team : game.away_team,
          isHome: homeMatch,
        };
      }
    }
  }
  return null;
}

// ── Try to determine W/L from score ─────────────────────────
function determineResult(bet, matchData) {
  if (!matchData) return null;
  const { homeScore, awayScore, isHome } = matchData;
  const desc = bet.description.toLowerCase();

  // Moneyline
  if (desc.includes('ml') || desc.includes('moneyline') || desc.includes('money line')) {
    const teamWon = isHome ? homeScore > awayScore : awayScore > homeScore;
    if (homeScore === awayScore) return 'push';
    return teamWon ? 'win' : 'loss';
  }

  // Spread — look for patterns like -3.5, +7
  const spreadMatch = desc.match(/([+-]?\d+\.?\d*)/);
  if (spreadMatch && (desc.includes('spread') || /[+-]\d/.test(desc))) {
    const spread = parseFloat(spreadMatch[1]);
    const teamScore = isHome ? homeScore : awayScore;
    const oppScore = isHome ? awayScore : homeScore;
    const covered = teamScore + spread - oppScore;
    if (covered > 0) return 'win';
    if (covered === 0) return 'push';
    return 'loss';
  }

  // Over/Under
  const ouMatch = desc.match(/(over|under|o|u)\s*(\d+\.?\d*)/i);
  if (ouMatch) {
    const direction = ouMatch[1].toLowerCase();
    const total = parseFloat(ouMatch[2]);
    const gameTotal = homeScore + awayScore;

    if (gameTotal === total) return 'push';
    const isOver = direction === 'over' || direction === 'o';
    if (isOver) return gameTotal > total ? 'win' : 'loss';
    return gameTotal < total ? 'win' : 'loss';
  }

  // Can't determine — might be a prop, let AI handle
  return null;
}

// ── Main auto-grade cycle ───────────────────────────────────
async function runAutoGrade(client) {
  console.log('[AutoGrade] Starting grading cycle...');
  const pending = await getPendingBets();
  if (pending.length === 0) {
    console.log('[AutoGrade] No pending bets.');
    return { graded: 0 };
  }

  // Group by sport and fetch scores
  const sportGroups = {};
  for (const bet of pending) {
    const sport = bet.sport?.toUpperCase() || 'UNKNOWN';
    if (!sportGroups[sport]) sportGroups[sport] = [];
    sportGroups[sport].push(bet);
  }

  let gradedCount = 0;
  const gradedBets = [];

  for (const [sport, bets] of Object.entries(sportGroups)) {
    const scores = await fetchScores(sport);
    if (scores.length === 0) continue;

    for (const bet of bets) {
      const matchData = matchBetToGame(bet, scores);
      const result = determineResult(bet, matchData);

      if (result) {
        const profitUnits = calcProfit(bet.odds || -110, bet.units || 1, result);

        // Get AI grade
        const aiGrade = await gradeBetAI(bet, result);

        await gradeBet(bet.id, result, profitUnits, aiGrade.grade, aiGrade.reason);

        // Update bankroll
        if (bet.capper_id) {
          const bankroll = await require('./database').getBankroll(bet.capper_id);
          if (bankroll) {
            const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
            await updateBankroll(bet.capper_id, dollarAmount);
          }
          await saveDailySnapshot(bet.capper_id);
        }

        gradedBets.push({ bet, result, profitUnits, grade: aiGrade });
        gradedCount++;
      }
    }
  }

  console.log(`[AutoGrade] Graded ${gradedCount} bets.`);
  return { graded: gradedCount, bets: gradedBets };
}

module.exports = { runAutoGrade, calcProfit, fetchScores };
