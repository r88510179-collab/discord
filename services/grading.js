const { getPendingBets, gradeBet, updateBankroll, saveDailySnapshot, getBankroll, db, payoutTailers } = require('./database');
const { gradeBetAI } = require('./ai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = process.env.ODDS_API_KEY;

// Prop detection keywords
const PROP_KEYWORDS = /\b(pts|points|reb|rebounds|ast|assists|stl|steals|blk|blocks|yds|yards|tds|touchdowns|strikeouts|hits|runs|sacks|receptions|goals|shots|saves|aces|kills)\b/i;
const OVER_UNDER_PATTERN = /\b(over|under|o|u)\s*\d+\.?\d*/i;

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

// Data-driven alias table for high-frequency leagues first (NBA/NFL/MLB/NHL).
const TEAM_ALIAS_ROWS = [
  { team: 'los angeles lakers', aliases: ['lakers', 'lal', 'la lakers', 'lake show'], league: 'NBA' },
  { team: 'golden state warriors', aliases: ['warriors', 'gsw', 'dubs'], league: 'NBA' },
  { team: 'boston celtics', aliases: ['celtics', 'bos'], league: 'NBA' },
  { team: 'new york knicks', aliases: ['knicks', 'nyk'], league: 'NBA' },
  { team: 'dallas mavericks', aliases: ['mavericks', 'mavs', 'dal'], league: 'NBA' },
  { team: 'phoenix suns', aliases: ['suns', 'phx'], league: 'NBA' },
  { team: 'miami heat', aliases: ['heat', 'mia'], league: 'NBA' },
  { team: 'milwaukee bucks', aliases: ['bucks', 'mil'], league: 'NBA' },

  { team: 'kansas city chiefs', aliases: ['chiefs', 'kc'], league: 'NFL' },
  { team: 'san francisco 49ers', aliases: ['49ers', 'niners', 'sf'], league: 'NFL' },
  { team: 'philadelphia eagles', aliases: ['eagles', 'phi'], league: 'NFL' },
  { team: 'new york giants', aliases: ['giants', 'nyg'], league: 'NFL' },
  { team: 'dallas cowboys', aliases: ['cowboys', 'dal'], league: 'NFL' },
  { team: 'green bay packers', aliases: ['packers', 'gb'], league: 'NFL' },
  { team: 'new england patriots', aliases: ['patriots', 'pats', 'ne'], league: 'NFL' },

  { team: 'los angeles dodgers', aliases: ['dodgers', 'lad'], league: 'MLB' },
  { team: 'new york yankees', aliases: ['yankees', 'nyy'], league: 'MLB' },
  { team: 'boston red sox', aliases: ['red sox', 'bos'], league: 'MLB' },
  { team: 'houston astros', aliases: ['astros', 'hou'], league: 'MLB' },
  { team: 'atlanta braves', aliases: ['braves', 'atl'], league: 'MLB' },

  { team: 'toronto maple leafs', aliases: ['maple leafs', 'leafs', 'tor'], league: 'NHL' },
  { team: 'new york rangers', aliases: ['rangers', 'nyr'], league: 'NHL' },
  { team: 'vegas golden knights', aliases: ['golden knights', 'vgk'], league: 'NHL' },
  { team: 'edmonton oilers', aliases: ['oilers', 'edm'], league: 'NHL' },
];

const ALIAS_TO_TEAMS = {};
const TEAM_TO_LEAGUE = {};
for (const row of TEAM_ALIAS_ROWS) {
  const canonical = row.team;
  TEAM_TO_LEAGUE[canonical] = row.league;
  if (!ALIAS_TO_TEAMS[canonical]) ALIAS_TO_TEAMS[canonical] = new Set();
  ALIAS_TO_TEAMS[canonical].add(canonical);
  for (const alias of row.aliases) {
    if (!ALIAS_TO_TEAMS[alias]) ALIAS_TO_TEAMS[alias] = new Set();
    ALIAS_TO_TEAMS[alias].add(canonical);
  }
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(text);
}

function canonicalizeTeamName(teamName) {
  const normalized = normalizeForMatch(teamName);
  const matches = ALIAS_TO_TEAMS[normalized];
  if (!matches || matches.size !== 1) return normalized;
  return [...matches][0];
}

function normalizeSportContext(sport) {
  const s = String(sport || '').toUpperCase();
  if (s.includes('NBA')) return 'NBA';
  if (s.includes('NFL') || s.includes('NCAAF')) return 'NFL';
  if (s.includes('MLB')) return 'MLB';
  if (s.includes('NHL')) return 'NHL';
  return null;
}

function filterTeamsBySport(candidates, sportContext) {
  if (!sportContext) return candidates;
  const filtered = candidates.filter((team) => TEAM_TO_LEAGUE[team] === sportContext);
  return filtered.length > 0 ? filtered : candidates;
}

function findMentionedTeams(description, sportContext = null) {
  const normalized = normalizeForMatch(description);
  const matchedTeams = new Set();
  const ambiguousAliases = new Set();

  for (const [alias, teams] of Object.entries(ALIAS_TO_TEAMS)) {
    if (!containsPhrase(normalized, alias)) continue;

    const scopedTeams = filterTeamsBySport([...teams], sportContext);

    if (scopedTeams.length === 1) {
      matchedTeams.add(scopedTeams[0]);
      continue;
    }

    // Ambiguous alias: only accept if one candidate canonical name appears explicitly.
    const explicit = scopedTeams.filter(team => containsPhrase(normalized, team));
    if (explicit.length === 1) matchedTeams.add(explicit[0]);
    else ambiguousAliases.add(alias);
  }

  return { matchedTeams, ambiguousAliases };
}

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
  const desc = normalizeForMatch(bet.description);
  const sportContext = normalizeSportContext(bet.sport);
  const { matchedTeams, ambiguousAliases } = findMentionedTeams(bet.description, sportContext);

  for (const game of scores) {
    const home = normalizeForMatch(game.home_team);
    const away = normalizeForMatch(game.away_team);
    const homeCanonical = canonicalizeTeamName(home);
    const awayCanonical = canonicalizeTeamName(away);

    // Check if any team name fragment is in the bet description
    const homeWords = home.split(' ');
    const awayWords = away.split(' ');

    const homeWordMatch = homeWords.some(w => w.length > 3 && containsPhrase(desc, w));
    const awayWordMatch = awayWords.some(w => w.length > 3 && containsPhrase(desc, w));
    const homeAmbiguousMatch = [...ambiguousAliases].some((alias) => {
      const options = filterTeamsBySport([...(ALIAS_TO_TEAMS[alias] || [])], sportContext);
      return options.includes(homeCanonical) && !options.includes(awayCanonical);
    });
    const awayAmbiguousMatch = [...ambiguousAliases].some((alias) => {
      const options = filterTeamsBySport([...(ALIAS_TO_TEAMS[alias] || [])], sportContext);
      return options.includes(awayCanonical) && !options.includes(homeCanonical);
    });

    const homeAliasMatch = matchedTeams.has(homeCanonical) || homeAmbiguousMatch;
    const awayAliasMatch = matchedTeams.has(awayCanonical) || awayAmbiguousMatch;
    const homeMatch = homeAliasMatch || homeWordMatch;
    const awayMatch = awayAliasMatch || awayWordMatch;

    if (homeMatch || awayMatch) {
      const homeScore = game.scores?.find(s => s.name === game.home_team)?.score;
      const awayScore = game.scores?.find(s => s.name === game.away_team)?.score;

      if (homeScore != null && awayScore != null) {
        console.log(`[AutoGrade] ✅ MATCHED: "${bet.description?.slice(0, 50)}" → ${game.home_team} vs ${game.away_team} (${homeScore}-${awayScore})`);
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

  // No match found — log the failure with available API teams for debugging
  const availableApiTeams = scores.map(g => `${g.home_team} vs ${g.away_team}`);
  console.log(`[AutoGrade] ⚠️ FAILED TO MATCH: "${bet.description?.slice(0, 60)}" (sport: ${bet.sport}) | Matched aliases: [${[...findMentionedTeams(bet.description, normalizeSportContext(bet.sport)).matchedTeams].join(', ')}] | API had: ${availableApiTeams.join(', ') || 'NO GAMES'}`);
  return null;
}

function evaluateMarketSegment(segment, matchData) {
  const { homeScore, awayScore, isHome } = matchData;
  const desc = segment.toLowerCase().trim();

  // Moneyline
  if (/\bml\b/.test(desc) || desc.includes('moneyline') || desc.includes('money line')) {
    const teamWon = isHome ? homeScore > awayScore : awayScore > homeScore;
    if (homeScore === awayScore) return 'push';
    return teamWon ? 'win' : 'loss';
  }

  // Over/Under
  const ouMatch = desc.match(/\b(over|under)\s*(\d+\.?\d*)\b/i)
    || desc.match(/\b([ou])\s*([2-9]\d{1,2}(?:\.\d+)?)\b/i);
  if (ouMatch) {
    const direction = ouMatch[1].toLowerCase();
    const total = parseFloat(ouMatch[2]);
    const gameTotal = homeScore + awayScore;

    if (gameTotal === total) return 'push';
    const isOver = direction === 'over' || direction === 'o';
    if (isOver) return gameTotal > total ? 'win' : 'loss';
    return gameTotal < total ? 'win' : 'loss';
  }

  // Spread — prefer realistic line values and avoid treating odds (-110) as spread.
  const spreadCandidates = [...desc.matchAll(/([+-]\d{1,2}(?:\.\d+)?)(?!\d)/g)]
    .map(m => parseFloat(m[1]))
    .filter(n => Number.isFinite(n) && Math.abs(n) <= 40);
  const spread = spreadCandidates.length > 0 ? spreadCandidates[0] : null;
  if (spread != null && (desc.includes('spread') || /\b([a-z]{2,})\s*[+-]\d/.test(desc))) {
    const teamScore = isHome ? homeScore : awayScore;
    const oppScore = isHome ? awayScore : homeScore;
    const covered = teamScore + spread - oppScore;
    if (covered > 0) return 'win';
    if (covered === 0) return 'push';
    return 'loss';
  }

  // Can't determine — might be a prop, let AI handle
  return null;
}

function aggregateParlayResults(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  if (results.some(r => r == null)) return null;
  if (results.includes('loss')) return 'loss';
  if (results.every(r => r === 'push')) return 'push';
  return 'win';
}

// ── Try to determine W/L from score ─────────────────────────
function determineResult(bet, matchData) {
  if (!matchData) return null;
  const desc = bet.description.toLowerCase();
  const isParlay = (bet.bet_type || '').toLowerCase() === 'parlay' || desc.includes('parlay');

  if (isParlay && desc.includes('+')) {
    const legs = bet.description.split('+').map(s => s.trim()).filter(Boolean);
    const legResults = legs.map(leg => evaluateMarketSegment(leg, matchData));
    return aggregateParlayResults(legResults);
  }

  return evaluateMarketSegment(bet.description, matchData);
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

  // ── Hardened Gemini Grading Loop with retry + backoff ──
  const delay = ms => new Promise(res => setTimeout(res, ms));

  for (const bet of pending) {
    const betAgeHours = (Date.now() - new Date(bet.created_at).getTime()) / (1000 * 60 * 60);
    if (betAgeHours < 4) continue;

    console.log(`[AutoGrade] Processing: "${bet.description?.slice(0, 50)}" | ${bet.sport} | Age: ${betAgeHours.toFixed(1)}h`);

    let retries = 3;
    let aiResult = null;

    while (retries > 0) {
      try {
        aiResult = await gradePropWithAI(bet);
        break;
      } catch (error) {
        if (error.status === 429 || error.message?.includes('429')) {
          const waitSec = (4 - retries) * 10;
          console.warn(`[Rate Limit] Gemini 429. Retrying in ${waitSec}s... (${retries - 1} left)`);
          await delay(waitSec * 1000);
          retries--;
        } else {
          console.error(`[AutoGrade] Non-retryable error: ${error.message}`);
          break;
        }
      }
    }

    if (aiResult && ['WIN', 'LOSS', 'PUSH', 'VOID'].includes(aiResult.status)) {
      const finalResult = await finalizeBetGrading(client, bet, aiResult.status, aiResult.evidence);
      if (finalResult) {
        gradedBets.push(finalResult);
        gradedCount++;
      }
      await delay(2000); // Discord API spacing
    }
  }

  // ── 7-Day Smart Sweeper: only sweep standard bets, props handled by AI Grader ──
  const SWEEP_DAYS = 7;
  const sweepCutoff = SWEEP_DAYS * 24 * 60 * 60 * 1000;
  const expiredBets = pending.filter(bet => {
    const age = Date.now() - new Date(bet.created_at).getTime();
    if (age <= sweepCutoff) return false;
    // Skip props — AI Grader handles them independently
    const betType = (bet.bet_type || '').toLowerCase();
    const desc = (bet.description || '').toLowerCase();
    if (betType === 'prop' || PROP_KEYWORDS.test(desc)) return false;
    return true;
  });

  for (const bet of expiredBets) {
    if (gradedBets.some(g => g.bet.id === bet.id)) continue;

    const profitUnits = calcProfit(bet.odds || -110, bet.units || 1, 'loss');
    await gradeBet(bet.id, 'loss', profitUnits, 'F', `Auto-swept: pending >${SWEEP_DAYS} days with no score/confirmation`);

    if (bet.capper_id) {
      const bankroll = getBankroll(bet.capper_id);
      if (bankroll) {
        const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
        updateBankroll(bet.capper_id, dollarAmount);
      }
      saveDailySnapshot(bet.capper_id);
    }

    gradedBets.push({ bet, result: 'loss', profitUnits, grade: { grade: 'F', reason: `Expired (${SWEEP_DAYS}-day sweep)` } });
    gradedCount++;
    console.log(`[Sweeper] Auto-graded as loss: "${bet.description?.slice(0, 40)}" (${SWEEP_DAYS} days expired)`);
  }

  console.log(`[AutoGrade] Graded ${gradedCount} bets total (${expiredBets.length} swept).`);
  return { graded: gradedCount, bets: gradedBets };
}

// ── Contextual Victory Grading ──────────────────────────────
// Called by the message handler when AI detects a celebration.
// Matches celebration subject to pending bets from the same capper.
async function gradeFromCelebration(client, capperId, outcome, subjects) {
  if (!capperId || !subjects || subjects.length === 0) return null;

  // Find oldest pending bet from this capper that matches any subject
  const pendingBets = db.prepare(
    "SELECT * FROM bets WHERE capper_id = ? AND result = 'pending' AND review_status = 'confirmed' ORDER BY created_at ASC",
  ).all(capperId);

  if (pendingBets.length === 0) return null;

  const result = outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : null;
  if (!result) return null;

  for (const bet of pendingBets) {
    const desc = (bet.description || '').toLowerCase();

    for (const subject of subjects) {
      const term = subject.toLowerCase().trim();
      if (!term || term.length < 3) continue;

      // Fuzzy match: subject words appear in description
      const words = term.split(/\s+/);
      const match = words.some(w => w.length >= 3 && desc.includes(w));

      if (match) {
        const profitUnits = calcProfit(bet.odds || -110, bet.units || 1, result);
        await gradeBet(bet.id, result, profitUnits, result === 'win' ? 'B' : 'D', `Auto-graded from capper celebration: ${subject}`);

        if (bet.capper_id) {
          const bankroll = getBankroll(bet.capper_id);
          if (bankroll) {
            const dollarAmount = profitUnits * parseFloat(bankroll.unit_size);
            updateBankroll(bet.capper_id, dollarAmount);
          }
          saveDailySnapshot(bet.capper_id);
        }

        console.log(`[ContextGrade] ${result.toUpperCase()}: "${bet.description?.slice(0, 40)}" matched "${subject}"`);

        // Send War Room notification
        try {
          const { sendStagingEmbed } = require('./warRoom');
          const channelId = process.env.WAR_ROOM_CHANNEL_ID;
          if (client && channelId) {
            const { EmbedBuilder } = require('discord.js');
            const { COLORS } = require('../utils/embeds');
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
              const color = result === 'win' ? COLORS.success : COLORS.danger;
              const icon = result === 'win' ? '✅' : '❌';
              const embed = new EmbedBuilder()
                .setTitle(`${icon} Auto-Graded ${result.toUpperCase()}`)
                .setColor(color)
                .setDescription(`**${bet.description}**`)
                .addFields(
                  { name: 'Capper', value: bet.capper_name || 'Unknown', inline: true },
                  { name: 'P/L', value: `${profitUnits >= 0 ? '+' : ''}${profitUnits.toFixed(2)}u`, inline: true },
                  { name: 'Source', value: `Celebration matched: "${subject}"`, inline: false },
                )
                .setTimestamp();
              await channel.send({ embeds: [embed] });
            }
          }
        } catch (err) {
          console.log(`[ContextGrade] War Room notification error: ${err.message}`);
        }

        return { bet, result, profitUnits };
      }
    }
  }

  return null; // No matching bet found
}

// ── AI Prop Grader (Gemini with Google Search) ──────────────
// ── Pure AI Brain — returns ONLY { status, evidence }. No DB updates. ──
async function gradePropWithAI(bet) {
  if (!process.env.GEMINI_API_KEY) {
    console.log(`[AI Grader] Skipped — no GEMINI_API_KEY`);
    return null;
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    tools: [{ googleSearch: {} }],
  });

  const prompt = `Grade this sports bet. Search the web for the box score.
Bet: "${bet.description}" | Sport: ${bet.sport || 'Unknown'} | Date: ${bet.created_at}

Return JSON format: { "status": "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING", "evidence": "..." }
NOTE: Use "VOID" if the player did not play (late scratch) or the game was canceled.
If the game has not been played yet, return "PENDING".`;

  const result = await model.generateContent(prompt);
  const cleanJson = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleanJson);
  console.log(`[AI Grader] ${bet.id?.slice(0, 8)}: ${parsed.status} — ${parsed.evidence?.slice(0, 80)}`);
  return parsed; // { status, evidence } — caller handles DB
}

// ── Finalize: DB update + capper bankroll + tailer payouts + ticker ──
async function finalizeBetGrading(client, bet, status, evidence) {
  const resultLower = status.toLowerCase();
  const profitUnits = (resultLower === 'void') ? 0 : calcProfit(bet.odds || -110, bet.units || 1, resultLower);

  await gradeBet(bet.id, resultLower, profitUnits,
    resultLower === 'win' ? 'B' : resultLower === 'void' ? 'N/A' : 'D',
    `AI Grader: ${evidence || 'Graded via Gemini Search'}`);

  // Update capper bankroll
  if (bet.capper_id && resultLower !== 'void') {
    const bankroll = getBankroll(bet.capper_id);
    if (bankroll) {
      updateBankroll(bet.capper_id, profitUnits * parseFloat(bankroll.unit_size));
    }
    saveDailySnapshot(bet.capper_id);
  }

  // Pay out community tailers (void = refund)
  const tailerCount = payoutTailers(bet.id, bet.odds || -110, resultLower === 'void' ? 'push' : resultLower);

  // Post ticker
  if (tailerCount > 0 && client) {
    await postResultTicker(client, bet, resultLower, tailerCount);
  }

  console.log(`[AutoGrade] Finalized ${bet.id?.slice(0, 8)} → ${resultLower} (${profitUnits >= 0 ? '+' : ''}${profitUnits.toFixed(2)}u) | ${tailerCount} tailers paid`);
  return { bet, result: resultLower, profitUnits, grade: { grade: resultLower === 'win' ? 'B' : 'D', reason: evidence } };
}

// ── Result Ticker — announce graded bets to dashboard ────────
async function postResultTicker(client, bet, status, tailerCount) {
  try {
    const dashId = process.env.PUBLIC_CHANNEL_ID || process.env.DASHBOARD_CHANNEL_ID;
    if (!dashId) return;
    const channel = await client.channels.fetch(dashId).catch(() => null);
    if (!channel) return;

    const isWin = status === 'win';
    const color = isWin ? 0x00FF00 : (status === 'loss' ? 0xFF0000 : 0x808080);
    const emoji = isWin ? 'WIN!' : (status === 'loss' ? 'LOSS' : 'PUSH');

    const odds = bet.odds || -110;
    const riskAmount = 1.0;
    let perPayout = 0;
    if (status === 'win') {
      perPayout = odds > 0 ? riskAmount + (riskAmount * odds / 100) : riskAmount + (riskAmount * 100 / Math.abs(odds));
    } else if (status === 'push') {
      perPayout = riskAmount;
    }
    const totalDistributed = perPayout * tailerCount;

    await channel.send({ embeds: [{
      color,
      title: `${emoji} ${(bet.sport || 'Unknown').toUpperCase()} Play Graded`,
      description: `**Pick:** ${bet.description?.substring(0, 100) || 'Unknown'}\n**Capper:** ${bet.capper_name || 'Unknown'}`,
      fields: [
        { name: 'Odds', value: `${odds > 0 ? '+' : ''}${odds}`, inline: true },
        { name: 'Community', value: `Paid out ${tailerCount} tailer${tailerCount === 1 ? '' : 's'} (${totalDistributed.toFixed(2)}u total)`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }] });
  } catch (err) {
    console.error('[Ticker Error]', err.message);
  }
}

module.exports = {
  runAutoGrade,
  gradeFromCelebration,
  gradePropWithAI,
  calcProfit,
  fetchScores,
  determineResult,
  aggregateParlayResults,
  matchBetToGame,
  findMentionedTeams,
  canonicalizeTeamName,
};
