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
 * Fetch from The Odds API with automatic key rotation.
 * Tries primary key first; on 401/429, retries with backup key.
 */
async function fetchWithKeyRotation(urlTemplate) {
  const primaryKey = process.env.ODDS_API_KEY;
  const backupKey = process.env.ODDS_API_KEY_BACKUP;
  if (!primaryKey && !backupKey) return null;

  const keys = [primaryKey, backupKey].filter(Boolean);

  for (let i = 0; i < keys.length; i++) {
    const url = urlTemplate.replace('{API_KEY}', keys[i]);
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();

      if ((res.status === 401 || res.status === 429) && i < keys.length - 1) {
        console.log(`[Odds] Primary key failed (${res.status}), trying backup...`);
        continue;
      }
      console.log(`[Odds] API error: ${res.status} ${res.statusText}`);
      return null;
    } catch (err) {
      if (i < keys.length - 1) {
        console.log(`[Odds] Primary key fetch failed: ${err.message}, trying backup...`);
        continue;
      }
      console.log(`[Odds] Fetch failed: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Fetch odds for a given sport from The Odds API.
 * Returns raw bookmaker data for all upcoming events.
 */
async function fetchOdds(apiSport) {
  const urlTemplate = `${ODDS_API_BASE}/${apiSport}/odds/?apiKey={API_KEY}&regions=us&markets=h2h,spreads,totals&bookmakers=${TARGET_BOOKS.join(',')}`;
  return fetchWithKeyRotation(urlTemplate);
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
  if (!apiSport) {
    console.log(`[Odds] No API sport mapping for: "${sport}"`);
    return null;
  }

  const events = await fetchOdds(apiSport);
  if (!events || events.length === 0) {
    console.log(`[Odds] API returned 0 events for ${apiSport}`);
    return null;
  }

  console.log(`[Odds] Searching for: "${teamName}" in ${apiSport} (${events.length} events)`);

  const searchTerm = teamName.toLowerCase().trim();

  // Fuzzy match: check both directions (our term in API name, or API name words in our term)
  function fuzzyMatch(apiName) {
    const api = apiName.toLowerCase();
    // Direct substring match either direction
    if (api.includes(searchTerm) || searchTerm.includes(api)) return true;
    // Split both into words and check if any significant word matches
    const apiWords = api.split(/\s+/);
    const searchWords = searchTerm.split(/\s+/);
    // Check if any search word (3+ chars) matches any API word
    for (const sw of searchWords) {
      if (sw.length < 3) continue;
      for (const aw of apiWords) {
        if (aw.length < 3) continue;
        if (aw.includes(sw) || sw.includes(aw)) return true;
      }
    }
    return false;
  }

  // Find matching event
  const event = events.find(e => fuzzyMatch(e.home_team) || fuzzyMatch(e.away_team));
  if (!event) {
    const teamList = events.slice(0, 5).map(e => `${e.away_team} @ ${e.home_team}`).join(', ');
    console.log(`[Odds] No match for "${searchTerm}". Sample events: ${teamList}`);
    return null;
  }

  console.log(`[Odds] Matched: ${event.away_team} @ ${event.home_team} (bookmakers: ${event.bookmakers?.length || 0})`);

  // Note: player props (player_points etc.) require separate API markets.
  // Current setup only checks h2h, spreads, totals.
  if (!event.bookmakers || event.bookmakers.length === 0) {
    console.log('[Odds] No bookmaker data for this event.');
    return null;
  }

  // Determine which side is "our" team
  const isHome = fuzzyMatch(event.home_team);
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

  if (!bestOffer) {
    console.log(`[Odds] No matching outcome for "${ourTeam}" across ${TARGET_BOOKS.join(', ')}`);
  } else {
    console.log(`[Odds] Best offer: ${bestOffer.book} ${bestOffer.market} ${bestOffer.price}`);
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
  // For bulleted parlays, take the first leg
  const firstLine = description.split('\n')[0].replace(/^[•\-*]\s*/, '');
  // Remove common betting suffixes, numbers, and odds
  const cleaned = firstLine
    .replace(/\s*(ML|moneyline|spread|over|under|o\d|u\d)\b/gi, ' ')
    .replace(/[+-]\d+\.?\d*/g, ' ')           // spreads/odds like -3.5, +150
    .replace(/\b\d+\.?\d*\s*(pts?|reb|ast|stl|blk|yds|tds?|ks?|hits?|runs?)\b/gi, ' ') // stat lines
    .replace(/\b(points|rebounds|assists|strikeouts|passing_yards)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  // Take up to 3 words as the team/player name
  const words = cleaned.split(' ').filter(w => w.length > 1);
  return words.slice(0, Math.min(words.length, 3)).join(' ');
}

/**
 * Fetch live scores for a sport from The Odds API.
 * Returns an array of { home, away, homeScore, awayScore, completed, commenceTime }.
 */
async function getLiveScores(sport) {
  const apiSport = resolveApiSport(sport);
  if (!apiSport) return null;

  const urlTemplate = `${ODDS_API_BASE}/${apiSport}/scores/?apiKey={API_KEY}&daysFrom=1`;
  const data = await fetchWithKeyRotation(urlTemplate);
  if (!data) return null;

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
}

module.exports = { shopLine, formatLineShop, extractTeamFromDescription, getLiveScores };
