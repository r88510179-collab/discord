// ═══════════════════════════════════════════════════════════
// Line Shopper — fetches live odds from The Odds API
// Compares capper's line to DraftKings, FanDuel, BetMGM
// ═══════════════════════════════════════════════════════════

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4/sports';
const TARGET_BOOKS = ['draftkings', 'fanduel', 'betmgm'];
const BOOK_LABELS = {
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
};

// Map our sport names to Odds API sport keys
const SPORT_MAP = {
  nba: 'basketball_nba',
  ncaab: 'basketball_ncaab',
  'march madness': 'basketball_ncaab',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  epl: 'soccer_epl',
  ucl: 'soccer_uefa_champions_league',
  mls: 'soccer_usa_mls',
  liga: 'soccer_spain_la_liga',
};

function resolveApiSport(sport) {
  if (!sport) return null;
  const key = sport.toLowerCase().trim();
  return SPORT_MAP[key] || null;
}

/**
 * Fetch odds for a given sport from The Odds API.
 * Returns raw bookmaker data for all upcoming events.
 */
async function fetchOdds(apiSport) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;

  const url = `${ODDS_API_BASE}/${apiSport}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&bookmakers=${TARGET_BOOKS.join(',')}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[Odds] API error: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.log(`[Odds] Fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Find the best available line for a team across target sportsbooks.
 *
 * @param {string} teamName — team or description to search for
 * @param {string} sport — our internal sport name (e.g., "NBA", "NFL")
 * @returns {object|null} { book, market, price, point, team } or null
 */
async function shopLine(teamName, sport) {
  const apiSport = resolveApiSport(sport);
  if (!apiSport) return null;

  const events = await fetchOdds(apiSport);
  if (!events || events.length === 0) return null;

  const searchTerm = teamName.toLowerCase();

  // Find matching event
  const event = events.find(e =>
    e.home_team.toLowerCase().includes(searchTerm) ||
    e.away_team.toLowerCase().includes(searchTerm),
  );
  if (!event) return null;

  // Determine which side is "our" team
  const isHome = event.home_team.toLowerCase().includes(searchTerm);
  const ourTeam = isHome ? event.home_team : event.away_team;

  let bestOffer = null;

  for (const bookmaker of event.bookmakers) {
    const bookKey = bookmaker.key;
    if (!TARGET_BOOKS.includes(bookKey)) continue;

    for (const market of bookmaker.markets) {
      for (const outcome of market.outcomes) {
        if (outcome.name.toLowerCase() !== ourTeam.toLowerCase()) continue;

        const offer = {
          book: BOOK_LABELS[bookKey] || bookKey,
          market: market.key, // h2h, spreads, totals
          price: outcome.price,
          point: outcome.point ?? null,
          team: ourTeam,
        };

        // Best = highest moneyline price, or best spread point
        if (!bestOffer) {
          bestOffer = offer;
        } else if (market.key === 'h2h' && offer.price > bestOffer.price) {
          bestOffer = offer;
        } else if (market.key === 'spreads' && offer.point != null && bestOffer.point != null && offer.point > bestOffer.point) {
          bestOffer = offer;
        }
      }
    }
  }

  return bestOffer;
}

/**
 * Format a line shop result for embed display.
 * @param {object} offer — from shopLine()
 * @returns {string} formatted string
 */
function formatLineShop(offer) {
  if (!offer) return null;

  const priceStr = offer.price > 0 ? `+${offer.price}` : `${offer.price}`;
  const pointStr = offer.point != null ? ` ${offer.point > 0 ? '+' : ''}${offer.point}` : '';
  const marketLabel = offer.market === 'h2h' ? 'ML' : offer.market === 'spreads' ? 'Spread' : 'Total';

  return `**${offer.book}** — ${marketLabel}${pointStr} (${priceStr})`;
}

/**
 * Extract a searchable team name from a bet description.
 * Tries to pull the first recognizable team/player name.
 */
function extractTeamFromDescription(description) {
  if (!description) return null;
  // Remove common betting suffixes
  const cleaned = description
    .replace(/\s*(ML|moneyline|spread|over|under|[+-]\d+\.?\d*)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Take the first 2-3 words as the team name
  const words = cleaned.split(' ');
  return words.slice(0, Math.min(words.length, 3)).join(' ');
}

/**
 * Fetch live scores for a sport from The Odds API.
 * Returns an array of { home, away, homeScore, awayScore, completed, commenceTime }.
 */
async function getLiveScores(sport) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;

  const apiSport = resolveApiSport(sport);
  if (!apiSport) return null;

  const url = `${ODDS_API_BASE}/${apiSport}/scores/?apiKey=${apiKey}&daysFrom=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[Odds] Scores API error: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();

    return data.map(game => {
      const homeScore = game.scores?.find(s => s.name === game.home_team);
      const awayScore = game.scores?.find(s => s.name === game.away_team);
      return {
        home: game.home_team,
        away: game.away_team,
        homeScore: homeScore?.score ?? null,
        awayScore: awayScore?.score ?? null,
        completed: game.completed || false,
        commenceTime: game.commence_time || null,
      };
    });
  } catch (err) {
    console.log(`[Odds] Scores fetch failed: ${err.message}`);
    return null;
  }
}

module.exports = { shopLine, formatLineShop, extractTeamFromDescription, getLiveScores };
