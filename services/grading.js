const { getPendingBets, gradeBet, updateBankroll, saveDailySnapshot, getBankroll, db, payoutTailers } = require('./database');
const { gradeBetAI } = require('./ai');

const delay = ms => new Promise(res => setTimeout(res, ms));

// ── Supported sports for grading ──
// Bets outside this set get auto-voided at the top of gradePropWithAI
// (see the "AUTO-VOID UNSCOPED BETS" block). Keep in sync with the
// sport families we actually ingest from cappers.
const SUPPORTED_SPORTS = new Set([
  'MLB', 'NBA', 'NHL', 'NFL',
  'NCAAB', 'NCAAF', 'NCAAM', 'NCAAW',
  'TENNIS', 'GOLF',
  'SOCCER', 'UCL', 'UEL', 'MLS', 'EPL',
  'LA LIGA', 'SERIE A', 'BUNDESLIGA', 'LIGUE 1',
  'F1', 'NASCAR',
  'MMA', 'UFC', 'BOXING',
]);

function isSupportedSport(sport) {
  if (!sport) return false;
  const s = String(sport).trim().toUpperCase();
  if (!s || s === 'UNKNOWN' || s === 'N/A' || s === 'NA') return false;
  return SUPPORTED_SPORTS.has(s);
}

// ═══════════════════════════════════════════════════════════════════
// P0 grading state machine — gateway + claim + backoff helpers.
// ═══════════════════════════════════════════════════════════════════

/**
 * canFinalizeBet — policy gateway invoked before every terminal grade write.
 * Returns { ok, reason?, betType?, pendingLegs? }. Throws only on DB/IO errors.
 * Callers must log and short-circuit on !ok; denials must NOT increment
 * grading_attempts. For reason='pending_legs', callers should reschedule via
 * scheduleRecheckAfterDenial() so we don't spin.
 *
 * Shadow mode: env CAN_FINALIZE_ENFORCE=false logs OK/DENIED decisions but
 * always returns ok:true so no behavior change while we observe traffic.
 */
function canFinalizeBet({ db: conn, betId, requestedResult, source, force = false }) {
  const _db = conn || db;
  const bet = _db.prepare('SELECT id, bet_type, result FROM bets WHERE id = ?').get(betId);
  if (!bet) return _gateLog(false, 'bet_not_found', source, betId, { force });

  if (bet.result && bet.result !== 'pending') {
    return _gateLog(false, 'already_finalized', source, betId, { betType: bet.bet_type, force });
  }

  const bt = (bet.bet_type || '').toLowerCase();
  if (bt === 'parlay' || bt === 'sgp') {
    const row = _db.prepare(
      "SELECT COUNT(*) AS c FROM parlay_legs WHERE bet_id = ? AND result = 'pending'"
    ).get(betId);
    const pendingLegs = row?.c || 0;
    if (pendingLegs > 0) {
      return _gateLog(false, 'pending_legs', source, betId, { betType: bet.bet_type, pendingLegs, force });
    }
  }

  return _gateLog(true, 'ok', source, betId, { betType: bet.bet_type });
}

function _gateLog(ok, reason, source, betId, extras = {}) {
  const enforce = (process.env.CAN_FINALIZE_ENFORCE || 'true') !== 'false';
  const short = (betId || '').slice(0, 8);
  if (ok) {
    console.log(`[CanFinalize:OK source=${source} bet=${short}]`);
  } else if (extras.force) {
    console.log(`[CanFinalize:FORCE source=${source} bet=${short} reason=${reason}${extras.pendingLegs ? ` pendingLegs=${extras.pendingLegs}` : ''}]`);
  } else {
    console.log(`[CanFinalize:DENIED source=${source} bet=${short} reason=${reason}${extras.pendingLegs ? ` pendingLegs=${extras.pendingLegs}` : ''}${!enforce ? ' (shadow)' : ''}]`);
  }
  // Effective ok: true if actually ok, or force-overridden, or shadow mode.
  const effectiveOk = ok || !!extras.force || !enforce;
  return { ok: effectiveOk, reason: ok ? undefined : reason, betType: extras.betType, pendingLegs: extras.pendingLegs };
}

/**
 * Atomic claim — single conditional UPDATE. If rowcount===1, this worker
 * owns the bet for 10 minutes. If 0, another worker already claimed it.
 */
function claimBetForGrading(betId) {
  const info = db.prepare(`
    UPDATE bets SET
      grading_lock_until = datetime('now', '+10 minutes'),
      grading_attempts = grading_attempts + 1,
      grading_last_attempt_at = datetime('now')
    WHERE id = ?
      AND result = 'pending'
      AND grading_state IN ('ready','backoff')
      AND (grading_lock_until IS NULL OR grading_lock_until < datetime('now'))
      AND (grading_next_attempt_at IS NULL OR grading_next_attempt_at <= datetime('now'))
  `).run(betId);
  return info.changes > 0;
}

/** Exponential backoff ladder based on cumulative attempt count. */
function applyBackoff(betId, attempts, reason) {
  const ladder = ['+15 minutes', '+1 hour', '+4 hours', '+12 hours', '+24 hours'];
  const offset = ladder[Math.min(Math.max(attempts - 1, 0), ladder.length - 1)];
  const quarantined = attempts >= 20;
  db.prepare(`UPDATE bets
    SET grading_state = ?,
        grading_next_attempt_at = datetime('now', ?),
        grading_last_failure_reason = ?,
        grading_lock_until = NULL
    WHERE id = ?`).run(quarantined ? 'quarantined' : 'backoff', offset, String(reason).slice(0, 200), betId);
  if (quarantined) {
    console.warn(`[AutoGrade:QUARANTINED bet=${(betId || '').slice(0, 8)} attempts=${attempts} reason=${String(reason).slice(0, 80)}]`);
  }
}

/** Gateway-denial recheck: do not change state or touch attempts; just requeue. */
function scheduleRecheckAfterDenial(betId, reason, minutes = 30) {
  db.prepare(`UPDATE bets
    SET grading_next_attempt_at = datetime('now', ?),
        grading_last_failure_reason = ?,
        grading_lock_until = NULL
    WHERE id = ?`).run(`+${minutes} minutes`, String(reason).slice(0, 200), betId);
}

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

// Complete alias table — ALL 124 teams across NBA/NFL/MLB/NHL
const TEAM_ALIAS_ROWS = [
  // ── NBA (30) ──
  { team: 'atlanta hawks', aliases: ['hawks', 'atl'], league: 'NBA' },
  { team: 'boston celtics', aliases: ['celtics', 'bos'], league: 'NBA' },
  { team: 'brooklyn nets', aliases: ['nets', 'bkn'], league: 'NBA' },
  { team: 'charlotte hornets', aliases: ['hornets', 'cha'], league: 'NBA' },
  { team: 'chicago bulls', aliases: ['bulls', 'chi'], league: 'NBA' },
  { team: 'cleveland cavaliers', aliases: ['cavaliers', 'cavs', 'cle'], league: 'NBA' },
  { team: 'dallas mavericks', aliases: ['mavericks', 'mavs', 'dal'], league: 'NBA' },
  { team: 'denver nuggets', aliases: ['nuggets', 'den'], league: 'NBA' },
  { team: 'detroit pistons', aliases: ['pistons', 'det'], league: 'NBA' },
  { team: 'golden state warriors', aliases: ['warriors', 'gsw', 'dubs'], league: 'NBA' },
  { team: 'houston rockets', aliases: ['rockets', 'hou'], league: 'NBA' },
  { team: 'indiana pacers', aliases: ['pacers', 'ind'], league: 'NBA' },
  { team: 'los angeles clippers', aliases: ['clippers', 'lac'], league: 'NBA' },
  { team: 'los angeles lakers', aliases: ['lakers', 'lal', 'lake show'], league: 'NBA' },
  { team: 'memphis grizzlies', aliases: ['grizzlies', 'grizz', 'mem'], league: 'NBA' },
  { team: 'miami heat', aliases: ['heat', 'mia'], league: 'NBA' },
  { team: 'milwaukee bucks', aliases: ['bucks', 'mil'], league: 'NBA' },
  { team: 'minnesota timberwolves', aliases: ['timberwolves', 'wolves', 'min'], league: 'NBA' },
  { team: 'new orleans pelicans', aliases: ['pelicans', 'pels', 'nop'], league: 'NBA' },
  { team: 'new york knicks', aliases: ['knicks', 'nyk'], league: 'NBA' },
  { team: 'oklahoma city thunder', aliases: ['thunder', 'okc'], league: 'NBA' },
  { team: 'orlando magic', aliases: ['magic', 'orl'], league: 'NBA' },
  { team: 'philadelphia 76ers', aliases: ['76ers', 'sixers', 'phi'], league: 'NBA' },
  { team: 'phoenix suns', aliases: ['suns', 'phx'], league: 'NBA' },
  { team: 'portland trail blazers', aliases: ['trail blazers', 'blazers', 'por'], league: 'NBA' },
  { team: 'sacramento kings', aliases: ['kings', 'sac'], league: 'NBA' },
  { team: 'san antonio spurs', aliases: ['spurs', 'sas'], league: 'NBA' },
  { team: 'toronto raptors', aliases: ['raptors', 'tor'], league: 'NBA' },
  { team: 'utah jazz', aliases: ['jazz', 'uta'], league: 'NBA' },
  { team: 'washington wizards', aliases: ['wizards', 'wsh'], league: 'NBA' },
  // ── MLB (30) ──
  { team: 'arizona diamondbacks', aliases: ['diamondbacks', 'dbacks', 'ari'], league: 'MLB' },
  { team: 'atlanta braves', aliases: ['braves', 'atl'], league: 'MLB' },
  { team: 'baltimore orioles', aliases: ['orioles', 'bal'], league: 'MLB' },
  { team: 'boston red sox', aliases: ['red sox', 'bos'], league: 'MLB' },
  { team: 'chicago cubs', aliases: ['cubs', 'chc'], league: 'MLB' },
  { team: 'chicago white sox', aliases: ['white sox', 'chw'], league: 'MLB' },
  { team: 'cincinnati reds', aliases: ['reds', 'cin'], league: 'MLB' },
  { team: 'cleveland guardians', aliases: ['guardians', 'cle'], league: 'MLB' },
  { team: 'colorado rockies', aliases: ['rockies', 'col'], league: 'MLB' },
  { team: 'detroit tigers', aliases: ['tigers', 'det'], league: 'MLB' },
  { team: 'houston astros', aliases: ['astros', 'hou'], league: 'MLB' },
  { team: 'kansas city royals', aliases: ['royals', 'kcr'], league: 'MLB' },
  { team: 'los angeles angels', aliases: ['angels', 'laa'], league: 'MLB' },
  { team: 'los angeles dodgers', aliases: ['dodgers', 'lad'], league: 'MLB' },
  { team: 'miami marlins', aliases: ['marlins', 'mia'], league: 'MLB' },
  { team: 'milwaukee brewers', aliases: ['brewers', 'mil'], league: 'MLB' },
  { team: 'minnesota twins', aliases: ['twins', 'min'], league: 'MLB' },
  { team: 'new york mets', aliases: ['mets', 'nym'], league: 'MLB' },
  { team: 'new york yankees', aliases: ['yankees', 'nyy'], league: 'MLB' },
  { team: 'oakland athletics', aliases: ['athletics', 'as', 'oak'], league: 'MLB' },
  { team: 'philadelphia phillies', aliases: ['phillies', 'phi'], league: 'MLB' },
  { team: 'pittsburgh pirates', aliases: ['pirates', 'pit'], league: 'MLB' },
  { team: 'san diego padres', aliases: ['padres', 'sd'], league: 'MLB' },
  { team: 'san francisco giants', aliases: ['giants', 'sf'], league: 'MLB' },
  { team: 'seattle mariners', aliases: ['mariners', 'sea'], league: 'MLB' },
  { team: 'st louis cardinals', aliases: ['cardinals', 'cards', 'stl'], league: 'MLB' },
  { team: 'tampa bay rays', aliases: ['rays', 'tb'], league: 'MLB' },
  { team: 'texas rangers', aliases: ['rangers', 'tex'], league: 'MLB' },
  { team: 'toronto blue jays', aliases: ['blue jays', 'jays', 'tor'], league: 'MLB' },
  { team: 'washington nationals', aliases: ['nationals', 'nats', 'wsh'], league: 'MLB' },
  // ── NFL (32) ──
  { team: 'arizona cardinals', aliases: ['cardinals', 'ari'], league: 'NFL' },
  { team: 'atlanta falcons', aliases: ['falcons', 'atl'], league: 'NFL' },
  { team: 'baltimore ravens', aliases: ['ravens', 'bal'], league: 'NFL' },
  { team: 'buffalo bills', aliases: ['bills', 'buf'], league: 'NFL' },
  { team: 'carolina panthers', aliases: ['panthers', 'car'], league: 'NFL' },
  { team: 'chicago bears', aliases: ['bears', 'chi'], league: 'NFL' },
  { team: 'cincinnati bengals', aliases: ['bengals', 'cin'], league: 'NFL' },
  { team: 'cleveland browns', aliases: ['browns', 'cle'], league: 'NFL' },
  { team: 'dallas cowboys', aliases: ['cowboys', 'dal'], league: 'NFL' },
  { team: 'denver broncos', aliases: ['broncos', 'den'], league: 'NFL' },
  { team: 'detroit lions', aliases: ['lions', 'det'], league: 'NFL' },
  { team: 'green bay packers', aliases: ['packers', 'gb'], league: 'NFL' },
  { team: 'houston texans', aliases: ['texans', 'hou'], league: 'NFL' },
  { team: 'indianapolis colts', aliases: ['colts', 'ind'], league: 'NFL' },
  { team: 'jacksonville jaguars', aliases: ['jaguars', 'jags', 'jax'], league: 'NFL' },
  { team: 'kansas city chiefs', aliases: ['chiefs', 'kc'], league: 'NFL' },
  { team: 'las vegas raiders', aliases: ['raiders', 'lvr'], league: 'NFL' },
  { team: 'los angeles chargers', aliases: ['chargers', 'lac'], league: 'NFL' },
  { team: 'los angeles rams', aliases: ['rams', 'lar'], league: 'NFL' },
  { team: 'miami dolphins', aliases: ['dolphins', 'mia'], league: 'NFL' },
  { team: 'minnesota vikings', aliases: ['vikings', 'min'], league: 'NFL' },
  { team: 'new england patriots', aliases: ['patriots', 'pats', 'ne'], league: 'NFL' },
  { team: 'new orleans saints', aliases: ['saints', 'no'], league: 'NFL' },
  { team: 'new york giants', aliases: ['giants', 'nyg'], league: 'NFL' },
  { team: 'new york jets', aliases: ['jets', 'nyj'], league: 'NFL' },
  { team: 'philadelphia eagles', aliases: ['eagles', 'phi'], league: 'NFL' },
  { team: 'pittsburgh steelers', aliases: ['steelers', 'pit'], league: 'NFL' },
  { team: 'san francisco 49ers', aliases: ['49ers', 'niners', 'sf'], league: 'NFL' },
  { team: 'seattle seahawks', aliases: ['seahawks', 'sea'], league: 'NFL' },
  { team: 'tampa bay buccaneers', aliases: ['buccaneers', 'bucs', 'tb'], league: 'NFL' },
  { team: 'tennessee titans', aliases: ['titans', 'ten'], league: 'NFL' },
  { team: 'washington commanders', aliases: ['commanders', 'wsh'], league: 'NFL' },
  // ── NHL (32) ──
  { team: 'anaheim ducks', aliases: ['ducks', 'ana'], league: 'NHL' },
  { team: 'arizona coyotes', aliases: ['coyotes', 'ari'], league: 'NHL' },
  { team: 'boston bruins', aliases: ['bruins', 'bos'], league: 'NHL' },
  { team: 'buffalo sabres', aliases: ['sabres', 'buf'], league: 'NHL' },
  { team: 'calgary flames', aliases: ['flames', 'cgy'], league: 'NHL' },
  { team: 'carolina hurricanes', aliases: ['hurricanes', 'canes', 'car'], league: 'NHL' },
  { team: 'chicago blackhawks', aliases: ['blackhawks', 'hawks', 'chi'], league: 'NHL' },
  { team: 'colorado avalanche', aliases: ['avalanche', 'avs', 'col'], league: 'NHL' },
  { team: 'columbus blue jackets', aliases: ['blue jackets', 'cbj'], league: 'NHL' },
  { team: 'dallas stars', aliases: ['stars', 'dal'], league: 'NHL' },
  { team: 'detroit red wings', aliases: ['red wings', 'det'], league: 'NHL' },
  { team: 'edmonton oilers', aliases: ['oilers', 'edm'], league: 'NHL' },
  { team: 'florida panthers', aliases: ['panthers', 'fla'], league: 'NHL' },
  { team: 'los angeles kings', aliases: ['kings', 'lak'], league: 'NHL' },
  { team: 'minnesota wild', aliases: ['wild', 'min'], league: 'NHL' },
  { team: 'montreal canadiens', aliases: ['canadiens', 'habs', 'mtl'], league: 'NHL' },
  { team: 'nashville predators', aliases: ['predators', 'preds', 'nsh'], league: 'NHL' },
  { team: 'new jersey devils', aliases: ['devils', 'njd'], league: 'NHL' },
  { team: 'new york islanders', aliases: ['islanders', 'isles', 'nyi'], league: 'NHL' },
  { team: 'new york rangers', aliases: ['rangers', 'nyr'], league: 'NHL' },
  { team: 'ottawa senators', aliases: ['senators', 'sens', 'ott'], league: 'NHL' },
  { team: 'philadelphia flyers', aliases: ['flyers', 'phi'], league: 'NHL' },
  { team: 'pittsburgh penguins', aliases: ['penguins', 'pens', 'pit'], league: 'NHL' },
  { team: 'san jose sharks', aliases: ['sharks', 'sjs'], league: 'NHL' },
  { team: 'seattle kraken', aliases: ['kraken', 'sea'], league: 'NHL' },
  { team: 'st louis blues', aliases: ['blues', 'stl'], league: 'NHL' },
  { team: 'tampa bay lightning', aliases: ['lightning', 'bolts', 'tbl'], league: 'NHL' },
  { team: 'toronto maple leafs', aliases: ['maple leafs', 'leafs', 'tor'], league: 'NHL' },
  { team: 'vancouver canucks', aliases: ['canucks', 'van'], league: 'NHL' },
  { team: 'vegas golden knights', aliases: ['golden knights', 'knights', 'vgk'], league: 'NHL' },
  { team: 'washington capitals', aliases: ['capitals', 'caps', 'wsh'], league: 'NHL' },
  { team: 'winnipeg jets', aliases: ['jets', 'wpg'], league: 'NHL' },
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
// P0: state-machine aware. Atomic claim + exponential backoff + daily cap guard.
// Removed dead `let retries = 3; while(retries>0)` loop — never decremented,
// effectively always did a single attempt. Backoff now lives in the state
// machine (grading_state='backoff' + grading_next_attempt_at ladder).
async function runAutoGrade(client) {
  if (process.env.AUTOGRADER_DISABLED === 'true') {
    console.log('[AutoGrade] DISABLED via env var — skipping cycle');
    return { graded: 0 };
  }

  // Daily attempt cap (global safety). Uses grading_audit.timestamp (INTEGER ms).
  // If exceeded, pause WITHOUT auto-recovery — admin must investigate via
  // /admin grading-unstick or flip AUTOGRADER_DISABLED. Log every cycle while
  // paused so the condition is visible in logs (not indistinguishable from
  // a dead cron).
  const DAILY_CAP = 10_000;
  try {
    const r = db.prepare('SELECT COUNT(*) AS c FROM grading_audit WHERE timestamp > (unixepoch() - 86400) * 1000').get();
    const attempts24h = r?.c || 0;
    if (attempts24h > DAILY_CAP) {
      console.warn(`[AutoGrade:PAUSED daily_cap_exceeded attempts_24h=${attempts24h} cap=${DAILY_CAP}] — admin action required (/admin grading-unstick)`);
      return { graded: 0, paused: true, attempts24h };
    }
  } catch (e) {
    console.error(`[AutoGrade] Daily cap check error (non-fatal): ${e.message}`);
  }

  console.log('[AutoGrade] Starting grading cycle...');
  const pending = await getPendingBets();
  if (pending.length === 0) {
    console.log('[AutoGrade] No pending bets in queue (state-machine selector).');
    return { graded: 0 };
  }
  console.log(`[AutoGrade] ${pending.length} bet(s) eligible this cycle`);

  let gradedCount = 0;
  const gradedBets = [];

  for (const bet of pending) {
    const betAgeHours = (Date.now() - new Date(bet.created_at).getTime()) / (1000 * 60 * 60);
    console.log(`[AutoGrade] Processing: "${bet.description?.slice(0, 50)}" | ${bet.sport} | Age: ${betAgeHours.toFixed(1)}h`);

    // Atomic claim — if another worker or a concurrent /grade retry-all
    // already grabbed this bet, skip without touching state.
    if (!claimBetForGrading(bet.id)) {
      console.log(`[AutoGrade:SKIP race-lost bet=${bet.id.slice(0, 8)}]`);
      continue;
    }
    const attemptsNow = db.prepare('SELECT grading_attempts FROM bets WHERE id = ?').get(bet.id)?.grading_attempts || 1;

    let aiResult = null;
    let hit429 = false;
    try {
      aiResult = await gradePropWithAI(bet);
    } catch (error) {
      if (error.status === 429 || /429/.test(error.message || '')) {
        hit429 = true;
        console.warn(`[Rate Limit] 429 — aborting cycle, will resume next cron`);
        applyBackoff(bet.id, attemptsNow, 'rate_limit_429');
      } else {
        console.error(`[AutoGrade] Non-retryable error: ${error.message}`);
        applyBackoff(bet.id, attemptsNow, `provider_error:${String(error.message || 'unknown').slice(0, 80)}`);
      }
    }
    if (hit429) break;

    if (aiResult && ['WIN', 'LOSS', 'PUSH', 'VOID'].includes(aiResult.status)) {
      if (aiResult.source_url) {
        try { db.prepare('UPDATE bets SET grading_source_url = ? WHERE id = ?').run(aiResult.source_url, bet.id); } catch (_) {}
      }
      const finalResult = await finalizeBetGrading(client, bet, aiResult.status, aiResult.evidence);
      if (finalResult && finalResult.graded !== false) {
        gradedBets.push(finalResult);
        gradedCount++;
      }
      // If graded===false, finalizeBetGrading already handled the state
      // transition (pending_legs → scheduleRecheckAfterDenial; race-lost → skip).
      await delay(2000);
    } else if (aiResult && aiResult.status === 'PENDING') {
      applyBackoff(bet.id, attemptsNow, aiResult.evidence || 'ai_pending');
    } else if (!aiResult) {
      // Providers all failed / no response; treat as backoff
      applyBackoff(bet.id, attemptsNow, 'no_result');
    }

    const dripMs = pending.length > 20 ? 10000 : pending.length > 5 ? 20000 : 30000;
    console.log(`[AutoGrade] Drip: ${dripMs / 1000}s (${pending.length} pending)`);
    await delay(dripMs);
  }

  // ── 7-Day Smart Sweeper ──
  const SWEEP_DAYS = 7;
  const sweepCutoff = SWEEP_DAYS * 24 * 60 * 60 * 1000;
  const expiredBets = pending.filter(bet => {
    const age = Date.now() - new Date(bet.created_at).getTime();
    if (age <= sweepCutoff) return false;
    const betType = (bet.bet_type || '').toLowerCase();
    const desc = (bet.description || '').toLowerCase();
    if (betType === 'prop' || PROP_KEYWORDS.test(desc)) return false;
    return true;
  });

  for (const bet of expiredBets) {
    if (gradedBets.some(g => g.bet.id === bet.id)) continue;

    const gate = canFinalizeBet({ db, betId: bet.id, requestedResult: 'loss', source: 'sweeper_7d' });
    if (!gate.ok) {
      if (gate.reason === 'pending_legs') scheduleRecheckAfterDenial(bet.id, 'sweeper_pending_legs', 30);
      continue;
    }

    const profitUnits = calcProfit(bet.odds || -110, bet.units || 1, 'loss');
    const sweepResult = gradeBet(bet.id, 'loss', profitUnits, 'F', `Auto-swept: pending >${SWEEP_DAYS} days with no score/confirmation`, true);
    if (!sweepResult.graded) continue;

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
    "SELECT * FROM bets WHERE capper_id = ? AND result = 'pending' AND review_status IN ('confirmed', 'needs_review') ORDER BY created_at ASC",
  ).all(capperId);

  if (pendingBets.length === 0) return null;

  const result = outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : null;
  if (!result) return null;

  for (const bet of pendingBets) {
    // Defensive: skip if somehow already graded between query and now
    if (bet.result && bet.result !== 'pending') continue;
    const desc = (bet.description || '').toLowerCase();

    for (const subject of subjects) {
      const term = subject.toLowerCase().trim();
      if (!term || term.length < 3) continue;

      // Fuzzy match: subject words appear in description
      const words = term.split(/\s+/);
      const match = words.some(w => w.length >= 3 && desc.includes(w));

      if (match) {
        const gate = canFinalizeBet({ db, betId: bet.id, requestedResult: result, source: 'celebration' });
        if (!gate.ok) {
          if (gate.reason === 'pending_legs') {
            scheduleRecheckAfterDenial(bet.id, `celebration_pending_legs_${gate.pendingLegs}`, 30);
          }
          continue;
        }
        const profitUnits = calcProfit(bet.odds || -110, bet.units || 1, result);
        const gradeResult = gradeBet(bet.id, result, profitUnits, result === 'win' ? 'B' : 'D',
          `Auto-graded from capper celebration: ${subject}`,
          true); // allowAutoConfirm = true (recap is trusted)

        if (!gradeResult.graded) {
          console.log(`[ContextGrade] SKIP race-lost bet ${bet.id?.slice(0, 8)} (${gradeResult.reason})`);
          continue;
        }

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

// ── Extract the subject (player or team name) from a bet description ──
// Aggressively strips EVERYTHING except the entity name.
// "Manny Machado Less 1.5 Hits+Runs+RBIs" → "Manny Machado"
function extractSubject(description) {
  const firstLeg = (description || '')
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0)[0] || description || '';

  return firstLeg
    .replace(/•/g, '')                          // bullet points
    .replace(/\+/g, ' ')                        // "Hits+Runs+RBIs" → "Hits Runs RBIs"
    .replace(/\b(over|under|less|more|o|u|alt)\b/gi, '') // direction words
    .replace(/\d+\.?\d*/g, '')                  // ALL numbers (lines, odds, stats)
    .replace(/\b(pts?|points?|reb|rebounds?|ast|assists?|stl|steals?|blk|blocks?|yds|yards?|tds?|touchdowns?|hr|home\s*runs?|hits?|runs?|rbis?|ks?|strikeouts?|sog|shots?|saves?|aces?|goals?|sacks?|receptions?|completions?|pass\s*yds|rush\s*yds|rec\s*yds)\b/gi, '') // ALL stat categories
    .replace(/\b(ml|moneyline|spread|rl|pk|parlay|teaser|to win|to lose|1q|2q|3q|4q|1h|2h|fg|ft|prop|anytime|first|last|td|scorer)\b/gi, '') // market types
    .replace(/[()[\]{}<>•·–—@#,;:/\\]/g, '')   // symbols
    .replace(/\s+/g, ' ')                       // collapse whitespace
    .trim();
}

// ── Search chain: DDG (free) → Brave (free tier) → Serper (if budget remains) ──

function sanitizeQuery(query) {
  return query
    .replace(/\b([A-Z])\.\s*/g, '$1 ')  // "C. Flagg" → "C Flagg"
    .replace(/\bOR\b/g, '')
    .replace(/[,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// User-Agent rotation to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const decodeHTML = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ── Search backend health registry ──
// In-memory state; resets on deploy (that's intentional — quotas typically
// reset daily and we don't want a sticky "OPEN" carrying across a restart
// if the quota window rolled over).
//
// Circuit policy is per-backend via BACKEND_CONFIG:
//   - HTTP 402/401/403 → open for config.quotaCooldownMs (quota/auth exhaustion)
//   - config.maxFails consecutive other failures → open for config.failCooldownMs
//   - A single success resets failCount + clears openUntil
//
// Backends consulted by searchWeb(): brave, ddg, bing, serper.
// DDG uses a 30min fail cooldown because DDG Lite rate-limits by IP and
// 5min doesn't give the IP enough cool-down before re-triggering the ban.
// Everyone else uses 5min.
const BACKEND_CONFIG = {
  brave:  { failCooldownMs:  5 * 60 * 1000, quotaCooldownMs: 60 * 60 * 1000, maxFails: 3 },
  ddg:    { failCooldownMs: 30 * 60 * 1000, quotaCooldownMs: 60 * 60 * 1000, maxFails: 3 },
  bing:   { failCooldownMs:  5 * 60 * 1000, quotaCooldownMs: 60 * 60 * 1000, maxFails: 3 },
  serper: { failCooldownMs:  5 * 60 * 1000, quotaCooldownMs: 60 * 60 * 1000, maxFails: 3 },
};

const backendHealth = {
  brave:  { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null },
  ddg:    { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null },
  bing:   { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null },
  serper: { lastSuccess: null, lastFailure: null, failCount: 0, openUntil: null, lastError: null },
};

function isBackendHealthy(name) {
  const h = backendHealth[name];
  if (!h?.openUntil) return true;
  if (Date.now() > h.openUntil) {
    h.openUntil = null;
    h.failCount = 0;
    return true;
  }
  return false;
}

function recordBackendResult(name, ok, errorCode = null) {
  const h = backendHealth[name];
  if (!h) return;
  const cfg = BACKEND_CONFIG[name];
  if (ok) {
    h.lastSuccess = Date.now();
    h.failCount = 0;
    h.openUntil = null;
    h.lastError = null;
  } else {
    h.lastFailure = Date.now();
    h.failCount++;
    h.lastError = errorCode;
    if (errorCode === 'HTTP_402' || errorCode === 'HTTP_401' || errorCode === 'HTTP_403') {
      h.openUntil = Date.now() + (cfg?.quotaCooldownMs ?? 60 * 60 * 1000);
    } else if (h.failCount >= (cfg?.maxFails ?? 3)) {
      h.openUntil = Date.now() + (cfg?.failCooldownMs ?? 5 * 60 * 1000);
    }
  }
}

// DDG Lite with retry
async function searchDDG(query) {
  // Circuit breaker via backendHealth. Cooldown is driven by BACKEND_CONFIG.ddg
  // (30min after 3 consecutive failures — DDG Lite rate-limits by IP and
  // 5min doesn't give the IP enough cool-down before re-triggering the ban).
  if (!isBackendHealthy('ddg')) {
    const remaining = Math.round((backendHealth.ddg.openUntil - Date.now()) / 60000);
    console.log(`[DDG] Circuit breaker OPEN — skipping (${remaining}m remaining, last error: ${backendHealth.ddg.lastError || 'unknown'})`);
    return [];
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const start = Date.now();
    try {
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': randomUA() },
        body: `q=${encodeURIComponent(query)}`,
      });
      const duration = Date.now() - start;

      if (!res.ok) {
        console.log(`[Search] Backend=DDG | Result=HTTP_${res.status} | Duration=${duration}ms`);
        recordBackendResult('ddg', false, `HTTP_${res.status}`);
        return [];
      }

      const html = await res.text();
      const results = [];
      const rows = html.split('<tr>');
      let currentTitle = '';
      for (const row of rows) {
        const linkMatch = row.match(/class="result-link"[^>]*>([^<]+)<\/a>/) || row.match(/href="[^"]*uddg[^"]*"[^>]*>([^<]+)<\/a>/);
        const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
        if (linkMatch) currentTitle = decodeHTML(linkMatch[1]).trim();
        if (snippetMatch) {
          const snippet = decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '')).trim();
          if (currentTitle || snippet) { results.push({ title: currentTitle, snippet }); currentTitle = ''; }
        }
        if (results.length >= 5) break;
      }
      if (results.length === 0) {
        const links = [...html.matchAll(/<a[^>]*class="[^"]*result[^"]*"[^>]*>([^<]+)<\/a>/g)];
        for (const m of links.slice(0, 5)) results.push({ title: decodeHTML(m[1]).trim(), snippet: '' });
      }

      console.log(`[Search] Backend=DDG | Result=SUCCESS | Duration=${duration}ms | Hits=${results.length}`);
      recordBackendResult('ddg', true);
      return results;
    } catch (err) {
      const duration = Date.now() - start;
      console.log(`[Search] Backend=DDG | Result=TIMEOUT | Duration=${duration}ms | Attempt=${attempt}/2`);
      if (attempt < 2) await delay(3000); // Retry after 3s
    }
  }

  recordBackendResult('ddg', false, 'TIMEOUT');
  return [];
}

// Bing scrape with increased timeout.
// NOTE: Bing is the workhorse backend — tracked but NOT gated by a breaker
// so snapshot can show its state without risking a breaker tripping and
// killing grading entirely.
async function searchBing(query) {
  const start = Date.now();
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': randomUA() },
    });
    const duration = Date.now() - start;
    if (!res.ok) {
      console.log(`[Search] Backend=Bing | Result=HTTP_${res.status} | Duration=${duration}ms`);
      recordBackendResult('bing', false, `HTTP_${res.status}`);
      return [];
    }

    const html = await res.text();
    const results = [];
    const blocks = html.split('class="b_algo"');
    for (const block of blocks.slice(1, 6)) {
      const titleMatch = block.match(/<a[^>]*>([^<]+)<\/a>/);
      const snippetMatch = block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
      const title = titleMatch ? decodeHTML(titleMatch[1]).trim() : '';
      const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '')).trim() : '';
      if (title || snippet) results.push({ title, snippet });
    }
    console.log(`[Search] Backend=Bing | Result=SUCCESS | Duration=${duration}ms | Hits=${results.length}`);
    recordBackendResult('bing', true);
    return results;
  } catch (err) {
    console.log(`[Search] Backend=Bing | Result=TIMEOUT | Duration=${Date.now() - start}ms`);
    recordBackendResult('bing', false, 'TIMEOUT');
    return [];
  }
}

// Brave Search API — free tier 2K queries/month
async function searchBrave(query) {
  if (!process.env.BRAVE_API_KEY) return [];
  // Circuit breaker: skip entirely when quota/auth is exhausted so we don't
  // burn 200-300ms per grading attempt on a guaranteed 402.
  if (!isBackendHealthy('brave')) {
    const remaining = Math.round((backendHealth.brave.openUntil - Date.now()) / 60000);
    console.log(`[Brave] Circuit breaker OPEN — skipping (${remaining}m remaining, last error: ${backendHealth.brave.lastError || 'unknown'})`);
    return [];
  }
  const start = Date.now();
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    const duration = Date.now() - start;
    if (!res.ok) {
      console.log(`[Search] Backend=Brave | Result=HTTP_${res.status} | Duration=${duration}ms`);
      recordBackendResult('brave', false, `HTTP_${res.status}`);
      return [];
    }
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5).map(r => ({ title: r.title || '', snippet: r.description || '' }));
    console.log(`[Search] Backend=Brave | Result=SUCCESS | Duration=${duration}ms | Hits=${results.length}`);
    recordBackendResult('brave', true);
    return results;
  } catch (err) {
    console.log(`[Search] Backend=Brave | Result=ERROR | Duration=${Date.now() - start}ms | ${err.message}`);
    recordBackendResult('brave', false, 'ERROR');
    return [];
  }
}

// Serper — only if key set (exhausted free tier, paid only).
// Tracked for snapshot visibility; no breaker since searchWeb() reaches it
// only as last resort and a broken Serper is still cheap to attempt.
async function searchSerper(query) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      recordBackendResult('serper', false, `HTTP_${res.status}`);
      return [];
    }
    const data = await res.json();
    const results = [];
    if (data.answerBox?.answer) results.push({ title: 'Answer', snippet: data.answerBox.answer });
    for (const r of (data.organic || []).slice(0, 5)) results.push({ title: r.title || '', snippet: r.snippet || '' });
    recordBackendResult('serper', true);
    return results;
  } catch (err) {
    recordBackendResult('serper', false, 'ERROR');
    return [];
  }
}

// Master search: Brave (reliable API) → DDG (free, may timeout) → Bing → Serper
async function searchWeb(query) {
  const clean = sanitizeQuery(query);
  console.log(`[Search] Query: "${clean.slice(0, 80)}"`);

  // Brave first — most reliable, has free tier
  let results = await searchBrave(clean);
  if (results.length > 0) return results;

  // DDG second — free but often times out
  await delay(1000);
  results = await searchDDG(clean);
  if (results.length > 0) return results;

  // Bing third — free scrape
  await delay(1000);
  results = await searchBing(clean);
  if (results.length > 0) return results;

  // Serper last resort (exhausted free tier)
  results = await searchSerper(clean);
  return results;
}

// ── Parlay dispatcher — routes to leg-by-leg or single-bet grading ──
async function gradePropWithAI(bet) {
  // Reclassify sport FIRST (before any search or team extraction)
  const { reclassifySport } = require('./ai');
  const origSport = bet.sport;
  if (bet.sport && bet.description) {
    bet.sport = reclassifySport(bet.sport, bet.description);
    if (bet.sport !== origSport) {
      console.log(`[AI Grader] RECLASSIFIED: ${origSport} → ${bet.sport} for "${bet.description?.slice(0, 50)}"`);
    }
  }

  // ── AUTO-VOID UNSCOPED BETS ──
  // If the sport is null / Unknown / N/A / outside the supported set,
  // void the bet immediately and skip BOTH ESPN and AI. With Brave dead
  // and search quality degraded, AI hallucinates positive grades on
  // promo captions like "MLB Wednesday picks" or garbage descriptions.
  // Runs AFTER reclassifySport() so bets with a recoverable sport
  // (e.g. description mentions "Yankees" despite sport='Unknown') are
  // still rescued. Applies before parlay/single dispatch, so both
  // paths inherit the guard.
  if (!isSupportedSport(bet.sport)) {
    console.log(`[AutoGrade] Auto-void unscoped: ${bet.id} | sport=${bet.sport} | "${(bet.description || '').slice(0, 80)}"`);
    try {
      db.prepare(`UPDATE bets SET
        result = 'void',
        profit_units = 0,
        graded_at = datetime('now'),
        grade = 'VOID',
        grade_reason = ?,
        review_status = 'auto_void_unscoped_bet',
        grading_state = 'done',
        grading_lock_until = NULL
      WHERE id = ? AND (result = 'pending' OR result IS NULL)`).run(
        `Auto-voided: sport=${bet.sport || 'null'} not in supported set`,
        bet.id
      );
    } catch (e) {
      console.error(`[AutoGrade] Auto-void write error: ${e.message}`);
    }
    // Return sentinel that runAutoGrade's if/else won't match → silent no-op.
    // (The DB write above is the real finalize; no need for finalizeBetGrading.)
    return { status: 'AUTO_VOIDED', evidence: `Auto-voided: sport=${bet.sport || 'null'} not in supported set` };
  }

  // Load legs if this is a parlay
  const betType = (bet.bet_type || '').toLowerCase();
  if (betType === 'parlay' || betType === 'sgp') {
    const legs = db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ? ORDER BY created_at').all(bet.id);

    // Guard: parlay missing leg data — prevent hallucinated single-grader results
    if (!legs || legs.length <= 1) {
      console.log(`[Grader] SKIP parlay missing legs: ${bet.id?.slice(0, 8)} (bet_type=${betType}, legs=${legs?.length || 0})`);
      return { status: 'PENDING', evidence: `Parlay has ${legs?.length || 0} recorded legs — cannot grade without leg data. Manual review required.` };
    }

    console.log(`[AI Grader] Parlay detected: ${legs.length} legs for bet ${bet.id?.slice(0, 8)}`);
    return await gradeParlay(bet, legs);
  }
  return await gradeSingleBet(bet);
}

// ── Parlay grader — grades each leg independently then computes result ──
async function gradeParlay(parlayBet, legs) {
  const { inferLegSport } = require('./ai');
  const legResults = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const legSport = inferLegSport(leg.description) || parlayBet.sport || 'Unknown';
    console.log(`[AI Grader] Parlay leg ${i + 1}/${legs.length}: "${leg.description?.slice(0, 50)}" | Sport: ${legSport}`);

    const legBet = {
      id: `${parlayBet.id}-leg${i + 1}`,
      description: leg.description,
      sport: legSport,
      event_date: parlayBet.event_date,
      created_at: parlayBet.created_at,
      bet_type: 'straight',
    };

    const result = await gradeSingleBet(legBet, { is_parlay: 1, leg_index: i, leg_count: legs.length });
    const status = result?.status || 'PENDING';
    const evidence = result?.evidence || 'No result';
    legResults.push({ leg, status, evidence });

    // Save per-leg result
    try {
      db.prepare('UPDATE parlay_legs SET result = ?, evidence = ?, graded_at = datetime(\'now\') WHERE id = ?')
        .run(status.toLowerCase(), evidence.slice(0, 500), leg.id);
    } catch (_) {}

    // 5s drip between legs
    if (i < legs.length - 1) await delay(5000);
  }

  // Compute parlay result
  const statuses = legResults.map(lr => lr.status);
  const losses = statuses.filter(s => s === 'LOSS').length;
  const pendings = statuses.filter(s => s === 'PENDING').length;
  const wins = statuses.filter(s => s === 'WIN').length;
  const voids = statuses.filter(s => s === 'VOID' || s === 'PUSH').length;

  const summary = legResults.map((lr, i) =>
    `Leg ${i + 1}: ${lr.status} — ${lr.leg.description?.slice(0, 50)} (${lr.evidence?.slice(0, 60)})`
  ).join('\n');

  if (losses > 0) return { status: 'LOSS', evidence: `Parlay LOSS — ${losses} leg(s) lost.\n${summary}` };
  if (pendings > 0) return { status: 'PENDING', evidence: `Parlay PENDING — ${pendings} leg(s) unresolved.\n${summary}` };
  if (wins === legResults.length) return { status: 'WIN', evidence: `Parlay WIN — all ${wins} legs hit.\n${summary}` };
  if (voids === legResults.length) return { status: 'VOID', evidence: `Parlay VOID — all legs voided.\n${summary}` };
  return { status: 'WIN', evidence: `Parlay WIN (reduced) — ${wins} won, ${voids} voided.\n${summary}` };
}

// ── Single-bet grader — ANTI-HALLUCINATION HARDENED ────────────
async function gradeSingleBet(bet, _auditCtx = {}) {
  const today = new Date().toISOString().split('T')[0];
  const betDate = bet.created_at ? new Date(bet.created_at).toISOString().split('T')[0] : today;

  // Audit context — populated throughout, written at end
  const audit = {
    bet_id: bet.id || 'unknown',
    sport_in: bet.sport || null,
    sport_out: null,
    reclassified: 0,
    is_parlay: _auditCtx.is_parlay || 0,
    leg_index: _auditCtx.leg_index ?? null,
    leg_count: _auditCtx.leg_count ?? null,
    search_backend: null,
    search_query: null,
    search_hits: 0,
    search_duration_ms: 0,
    provider_used: null,
    raw_response: null,
    guards_passed: [],
    guards_failed: [],
    final_status: null,
    final_evidence: null,
  };

  function writeAudit() {
    try {
      console.log(`[GradeAudit] Writing audit for bet=${audit.bet_id?.slice(0, 12)} status=${audit.final_status} provider=${audit.provider_used}`);
      const uid = require('crypto').randomBytes(8).toString('hex');
      const attemptNum = db.prepare('SELECT COUNT(*) as c FROM grading_audit WHERE bet_id = ?').get(audit.bet_id)?.c || 0;
      db.prepare(`INSERT INTO grading_audit (id, bet_id, attempt_num, timestamp, sport_in, sport_out, reclassified, is_parlay, leg_index, leg_count, search_backend, search_query, search_hits, search_duration_ms, provider_used, raw_response, guards_passed, guards_failed, final_status, final_evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          uid, audit.bet_id, attemptNum + 1, Date.now(),
          audit.sport_in || null, audit.sport_out || null, audit.reclassified || 0,
          audit.is_parlay || 0, audit.leg_index ?? null, audit.leg_count ?? null,
          audit.search_backend || null, audit.search_query || null,
          audit.search_hits || 0, audit.search_duration_ms || 0,
          audit.provider_used || null, (audit.raw_response || '').slice(0, 1000),
          JSON.stringify(audit.guards_passed || []), JSON.stringify(audit.guards_failed || []),
          audit.final_status || null, (audit.final_evidence || '').slice(0, 500)
        );
      console.log(`[GradeAudit] Written successfully: attempt ${attemptNum + 1}`);
    } catch (e) { console.error(`[GradeAudit] Write FAILED: ${e.message}`); }
  }

  function earlyReturn(result) {
    audit.final_status = result.status;
    audit.final_evidence = result.evidence;
    audit.sport_out = bet.sport;
    writeAudit();
    return result;
  }

  // ── GUARD 1: No event date ──
  if (!bet.event_date && !bet.created_at) {
    console.log(`[AI Grader] SKIP no date: ${bet.id?.slice(0, 8)}`);
    return earlyReturn({ status: 'PENDING', evidence: 'No event date — cannot determine if game has occurred' });
  }

  // ── GUARD 2: Parse and validate event date (with normalization) ──
  const { normalizeEventDate } = require('./ai');
  const rawEventDate = bet.event_date || bet.created_at;
  const eventDate = normalizeEventDate(rawEventDate) || rawEventDate;
  const eventTime = new Date(eventDate).getTime();
  if (!eventTime || isNaN(eventTime)) {
    console.log(`[AI Grader] SKIP bad date: ${bet.id?.slice(0, 8)} event_date="${rawEventDate}" normalized="${eventDate}"`);
    return earlyReturn({ status: 'PENDING', evidence: `Invalid event date: ${rawEventDate}` });
  }

  const eventDay = new Date(eventDate).toISOString().split('T')[0];
  if (eventDay > today) {
    console.log(`[AI Grader] SKIP future: ${bet.id?.slice(0, 8)} event=${eventDay} today=${today}`);
    return earlyReturn({ status: 'PENDING', evidence: 'Game has not started yet' });
  }

  // ── GUARD 3: Too recent — game may still be in progress ──
  const hoursSinceEvent = (Date.now() - eventTime) / (1000 * 60 * 60);
  console.log(`[AI Grader] Time check: ${bet.id?.slice(0, 8)} event=${eventDate} hours_since=${hoursSinceEvent.toFixed(2)}`);
  if (hoursSinceEvent < 3) {
    console.log(`[AI Grader] SKIP too recent: ${bet.id?.slice(0, 8)} ${hoursSinceEvent.toFixed(1)}h ago`);
    return earlyReturn({ status: 'PENDING', evidence: `Event was ${hoursSinceEvent.toFixed(1)}h ago — too soon to grade` });
  }

  // Sport reclassification already done in gradePropWithAI dispatcher
  audit.sport_out = bet.sport;
  audit.reclassified = (audit.sport_in !== bet.sport) ? 1 : 0;

  // ── Extract teams from bet for validation later ──
  const sportContext = normalizeSportContext(bet.sport);
  const { matchedTeams: betTeams } = findMentionedTeams(bet.description, sportContext);
  const betTeamList = [...betTeams];
  console.log(`[AI Grader] Bet teams: [${betTeamList.join(', ')}] | Sport: ${sportContext || '?'}`);

  // ── ESPN PRE-CHECK: deterministic grading for standard MLB/NBA/NHL/NFL bets ──
  // Runs BEFORE the expensive searchWeb + AI chain. Skips props, parlays,
  // and unparseable descriptions — those fall through to the existing path.
  if (['MLB', 'NBA', 'NHL', 'NFL'].includes((bet.sport || '').toUpperCase())) {
    try {
      const { tryGradeViaESPN } = require('./espn');
      const espnResult = await tryGradeViaESPN(bet, betTeamList);
      if (espnResult.ok) {
        audit.search_backend = 'espn';
        audit.search_hits = 1;
        audit.provider_used = 'espn';
        return earlyReturn({ status: espnResult.result, evidence: espnResult.evidence });
      }
      // ESPN couldn't grade — fall through to searchWeb + AI
      console.log(`[ESPN→AI] Falling through: ${espnResult.reason || 'unknown'} | "${(bet.description || '').slice(0, 50)}"`);
    } catch (err) {
      console.error(`[ESPN] Error (non-fatal, falling through to AI): ${err.message}`);
    }
  }

  // ── Step 1: Web search — use "team1 vs team2" format for precision ──
  let searchResults = [];
  let searchSnippets = '';
  try {
    const dateObj = new Date(eventDate);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const sport = bet.sport || '';

    // Build precise query
    let query;
    if (betTeamList.length >= 2) {
      const t1 = betTeamList[0].split(' ').pop();
      const t2 = betTeamList[1].split(' ').pop();
      query = `${t1} vs ${t2} ${sport} final score ${dateStr}`;
    } else if (betTeamList.length === 1) {
      // Single-team bet: "Cavs -1.5" — search for the team's game on that date
      const teamName = betTeamList[0].split(' ').pop();
      query = `${teamName} ${sport} game ${dateStr} final score`;
    } else {
      const subject = extractSubject(bet.description);
      query = `${subject} ${sport} final score ${dateStr}`;
    }
    console.log(`[AI Grader] Searching: "${query.slice(0, 80)}"`);
    audit.search_query = query;
    const searchStart = Date.now();
    searchResults = await searchWeb(query);
    audit.search_duration_ms = Date.now() - searchStart;
    audit.search_hits = searchResults.length;
    // Determine which backend was used (first one that returned results)
    audit.search_backend = searchResults.length > 0 ? 'chain' : 'none';

    const snippets = [];
    for (const r of searchResults) {
      if (r.title) snippets.push(r.title);
      if (r.snippet) snippets.push(`  ${r.snippet}`);
    }
    if (snippets.length > 0) {
      searchSnippets = snippets.join('\n');
      console.log(`[AI Grader] Got ${searchResults.length} result(s)`);
    }
  } catch (err) {
    console.warn(`[AI Grader] Search failed: ${err.message}`);
  }

  // ── GUARD 4: NO SEARCH RESULTS = PENDING. NEVER call AI without evidence. ──
  if (searchResults.length === 0 || !searchSnippets) {
    console.log(`[AI Grader] NO SEARCH RESULTS for ${bet.id?.slice(0, 8)} — returning PENDING (will not call AI)`);
    return earlyReturn({ status: 'PENDING', evidence: 'No search results available — game may not have completed yet' });
  }

  // ── Step 2: Provider chain — ordered by hallucination rate (lowest first) ──
  // cerebras 3.5% → groq-qwen unknown → openrouter unknown → groq-kimi 7.6% →
  // mistral unknown → ollama local → groq-llama8b 39% (last resort)
  const providers = [];
  if (process.env.CEREBRAS_API_KEY) {
    providers.push({ name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: process.env.CEREBRAS_API_KEY, model: 'llama3.1-8b' });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ name: 'groq-qwen', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'qwen/qwen3-32b' });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({ name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, model: 'meta-llama/llama-3.3-70b-instruct:free' });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ name: 'groq-kimi', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'moonshotai/kimi-k2-instruct' });
  }
  if (process.env.MISTRAL_API_KEY) {
    providers.push({ name: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: process.env.MISTRAL_API_KEY, model: 'mistral-small-latest' });
  }
  if (process.env.OLLAMA_URL) {
    providers.push({ name: 'ollama-llama3.2-3b', url: `${process.env.OLLAMA_URL}/v1/chat/completions`, key: 'ollama', model: process.env.OLLAMA_MODEL || 'llama3.2:3b', isOllama: true });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ name: 'groq-llama8b', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'llama-3.1-8b-instant' });
  }

  if (providers.length === 0) return earlyReturn({ status: 'PENDING', evidence: 'No AI providers configured' });

  const prompt = `You MUST respond with valid JSON only. No prose, no markdown, no code fences.
Grade this bet ONLY using the search results below. Today: ${today}. Bet placed: ${betDate}.
Bet: "${bet.description}" | Sport: ${bet.sport || '?'}

Search results:
${searchSnippets.slice(0, 1500)}

Required JSON format:
{"status": "WIN", "evidence": "Final score Lakers 118 Nuggets 112 per ESPN"}

status must be exactly one of: "WIN", "LOSS", "PUSH", "VOID", "PENDING"
evidence must reference specific scores or stats from the search results above.

CRITICAL RULES:
- Cite specific numbers from search results. If no final score found for this game on ${betDate}, return PENDING.
- DO NOT invent scores. If unsure, return PENDING.`;

  let raw = null;
  let winnerProvider = null;
  let backoffMs = 3000;

  for (const provider of providers) {
    try {
      console.log(`[AI Grader] Trying ${provider.name} (${provider.model})...`);
      const gradeTimeoutMs = provider.isOllama ? 25000 : 20000;
      const gradeHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` };
      if (provider.isOllama && process.env.OLLAMA_PROXY_SECRET) {
        gradeHeaders['x-ollama-secret'] = process.env.OLLAMA_PROXY_SECRET;
      }
      const res = await fetch(provider.url, {
        method: 'POST',
        signal: AbortSignal.timeout(gradeTimeoutMs),
        headers: gradeHeaders,
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 200,
        }),
      });

      if (res.status === 429) {
        console.warn(`[AI Grader] ${provider.name} 429 — backoff ${backoffMs}ms`);
        await delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200);
        console.warn(`[AI Grader] ${provider.name} HTTP ${res.status}: ${errText}`);
        continue;
      }

      const data = await res.json();
      raw = data.choices?.[0]?.message?.content || null;
      if (raw) {
        winnerProvider = provider.name;
        audit.provider_used = provider.name;
        audit.raw_response = raw;
        console.log(`[AI Grader] Winner: ${provider.name} | Raw (${raw.length} chars): ${raw.slice(0, 500)}`);
        break;
      }
    } catch (err) {
      console.warn(`[AI Grader] ${provider.name} error: ${err.message}`);
    }
  }

  if (!raw) {
    console.error(`[AI Grader] All providers failed for bet ${bet.id?.slice(0, 8)}`);
    return earlyReturn({ status: 'PENDING', evidence: 'All AI providers failed' });
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error(`[AI Grader] JSON parse error: ${e.message} | raw: ${raw?.slice(0, 100)}`);
    return earlyReturn({ status: 'PENDING', evidence: `JSON parse error: ${e.message}` });
  }

  const guardsLog = [];
  console.log(`[AI Grader] Running post-AI guards on ${bet.id?.slice(0, 8)} | status=${parsed.status} | sport=${bet.sport}`);

  if (parsed.status === 'WIN' || parsed.status === 'LOSS') {
    // ── GUARD 5: Score hallucination — fabricated scores ──
    const scorePattern = /\b(\d{2,3})\s*[-–]\s*(\d{2,3})\b/;
    const evidenceScore = parsed.evidence?.match(scorePattern);
    if (evidenceScore) {
      const s1 = evidenceScore[1], s2 = evidenceScore[2];
      if (!searchSnippets.includes(s1) && !searchSnippets.includes(s2)) {
        console.warn(`[AI Grader] GUARD5 FAIL: ${bet.id?.slice(0, 8)} | score ${s1}-${s2} NOT in snippets`);
        audit.guards_failed.push('G5:score_hallucination');
        return earlyReturn({ status: 'PENDING', evidence: `HALLUCINATION: AI claimed ${s1}-${s2} but not in search results` });
      }
      guardsLog.push('G5:score_ok');
    }

    // ── GUARD 6: Soft hallucination phrases ──
    const SOFT_HALLUCINATIONS = ['can be inferred', 'cannot be determined', 'not specified', 'unclear from', 'not explicitly', 'unable to find', 'based on context', 'reasonable to assume', 'likely won', 'likely lost', 'probably', 'appears to have', 'seems to have', 'i believe', 'my assessment'];
    const evidenceLower = (parsed.evidence || '').toLowerCase();
    const softMatch = SOFT_HALLUCINATIONS.find(p => evidenceLower.includes(p));
    if (softMatch) {
      console.warn(`[AI Grader] GUARD6 FAIL: ${bet.id?.slice(0, 8)} | soft hallucination: "${softMatch}"`);
      audit.guards_failed.push('G6:soft_hallucination');
      return earlyReturn({ status: 'PENDING', evidence: `Soft hallucination: AI said "${softMatch}" — refusing to grade without concrete evidence` });
    }
    guardsLog.push('G6:no_soft_halluc');

    // ── GUARD 7: Team-name verification (team sports) ──
    if (betTeamList.length >= 1) {
      const combinedEvidence = `${parsed.evidence || ''} ${searchSnippets}`;
      const { matchedTeams: evidenceTeams } = findMentionedTeams(combinedEvidence, sportContext);
      const evidenceTeamList = [...evidenceTeams];
      const missingTeams = betTeamList.filter(bt => !evidenceTeamList.includes(bt));
      if (missingTeams.length > 0) {
        console.warn(`[AI Grader] GUARD7 FAIL: ${bet.id?.slice(0, 8)} | Missing: [${missingTeams.map(t => t.split(' ').pop()).join(', ')}]`);
        audit.guards_failed.push('G7:team_mismatch');
        return earlyReturn({ status: 'PENDING', evidence: `Team mismatch: [${missingTeams.map(t => t.split(' ').pop()).join(', ')}] not in evidence` });
      }
      guardsLog.push('G7:teams_ok');
    }

    // ── GUARD 8: Player-name verification (individual sports) ──
    const INDIVIDUAL_SPORTS = ['TENNIS', 'GOLF', 'MMA', 'UFC', 'BOXING'];
    if (INDIVIDUAL_SPORTS.includes((bet.sport || '').toUpperCase())) {
      // Extract player names: capitalized words before betting keywords
      const words = (bet.description || '').split(/\s+/);
      const players = [];
      let name = [];
      for (const w of words) {
        if (/^[A-Z][a-z]+/.test(w) && !/^(ML|Over|Under|Win|Lose)$/.test(w)) { name.push(w); }
        else if (name.length > 0) { players.push(name.join(' ')); name = []; }
      }
      if (name.length > 0) players.push(name.join(' '));

      const missingPlayers = players.filter(p => {
        const last = p.split(' ').pop().toLowerCase();
        return last.length >= 4 && !evidenceLower.includes(last) && !searchSnippets.toLowerCase().includes(last);
      });
      if (missingPlayers.length > 0) {
        console.warn(`[AI Grader] GUARD8 FAIL: ${bet.id?.slice(0, 8)} | Player(s) [${missingPlayers.join(', ')}] not in evidence`);
        audit.guards_failed.push('G8:player_mismatch');
        return earlyReturn({ status: 'PENDING', evidence: `Player [${missingPlayers.join(', ')}] not in evidence — likely wrong match` });
      }
      guardsLog.push('G8:players_ok');
    }

    // ── GUARD 9: Cross-sport contamination ──
    // If bet sport is Tennis but evidence mentions NBA/MLB teams, wrong match
    if (bet.sport && betTeamList.length === 0) {
      const { matchedTeams: evidenceTeams } = findMentionedTeams(parsed.evidence || '', null);
      const evidenceTeamList = [...evidenceTeams];
      if (evidenceTeamList.length > 0) {
        // Evidence has team names but bet has no teams — likely cross-sport contamination
        const teamSports = evidenceTeamList.map(t => TEAM_TO_LEAGUE[t]).filter(Boolean);
        const betSportUpper = (bet.sport || '').toUpperCase();
        if (teamSports.length > 0 && !teamSports.includes(betSportUpper)) {
          console.warn(`[AI Grader] GUARD9 FAIL: ${bet.id?.slice(0, 8)} | Bet sport=${betSportUpper} but evidence has ${teamSports[0]} teams`);
          audit.guards_failed.push('G9:cross_sport');
          return earlyReturn({ status: 'PENDING', evidence: `Cross-sport: bet is ${betSportUpper} but evidence references ${teamSports[0]} teams` });
        }
      }
      guardsLog.push('G9:sport_ok');
    }
  }

  audit.guards_passed = guardsLog;
  console.log(`[AI Grader] Guards passed: [${guardsLog.join(', ')}]`);

  // Ensure evidence is never empty
  if (!parsed.evidence || parsed.evidence.trim().length === 0) {
    if (parsed.status === 'PENDING') {
      parsed.evidence = 'AI returned PENDING with no explanation — insufficient data in search results';
    } else {
      parsed.evidence = `AI graded ${parsed.status} via ${winnerProvider || 'unknown'} but provided no evidence`;
    }
  }

  console.log(`[AI Grader] Bet ID ${bet.id?.slice(0, 8)} | Status: ${parsed.status} | Evidence: ${parsed.evidence?.slice(0, 120)}`);
  return earlyReturn(parsed);
}

// ── Finalize: DB update + capper bankroll + tailer payouts + ticker ──
async function finalizeBetGrading(client, bet, status, evidence) {
  const resultLower = status.toLowerCase();
  const profitUnits = (resultLower === 'void') ? 0 : calcProfit(bet.odds || -110, bet.units || 1, resultLower);

  // P0 gateway — log policy decision, short-circuit on denial. Note the
  // hardened gradeBetRecord will also refuse if pending_legs is present, so
  // even if this gate is bypassed somewhere, the write itself is safe.
  const gate = canFinalizeBet({ db, betId: bet.id, requestedResult: resultLower, source: 'ai' });
  if (!gate.ok) {
    if (gate.reason === 'pending_legs') {
      scheduleRecheckAfterDenial(bet.id, `ai_pending_legs_${gate.pendingLegs}`, 30);
    }
    return { bet, result: bet.result || 'unknown', profitUnits: 0, grade: { grade: '?', reason: `gate:${gate.reason}` }, graded: false };
  }

  // ATOMIC GRADE: returns {graded: false} if another worker already finalized
  // AI grader is NOT a trusted path — does NOT auto-confirm needs_review bets
  const gradeResult = gradeBet(bet.id, resultLower, profitUnits,
    resultLower === 'win' ? 'B' : resultLower === 'void' ? 'N/A' : 'D',
    `AI Grader: ${evidence || 'Graded via search'}`,
    false);

  if (!gradeResult.graded) {
    console.log(`[Grader] SKIP race-lost bet ${bet.id?.slice(0, 8)} (${gradeResult.reason})`);
    return { bet, result: bet.result || 'unknown', profitUnits: 0, grade: { grade: '?', reason: 'Already graded — race lost' }, graded: false };
  }

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

  // Post to #slip-receipts
  if (client) {
    const { postGradedResult } = require('./dashboard');
    await postGradedResult(client, bet, resultLower, profitUnits, evidence);
  }

  // Post ticker (community tailers)
  if (tailerCount > 0 && client) {
    await postResultTicker(client, bet, resultLower, tailerCount);
  }

  console.log(`[AutoGrade] Finalized ${bet.id?.slice(0, 8)} → ${resultLower} (${profitUnits >= 0 ? '+' : ''}${profitUnits.toFixed(2)}u) | ${tailerCount} tailers paid`);
  return { bet, result: resultLower, profitUnits, grade: { grade: resultLower === 'win' ? 'B' : 'D', reason: evidence } };
}

// ── Result Ticker — announce graded bets to #slip-receipts ──
async function postResultTicker(client, bet, status, tailerCount) {
  try {
    // Route to receipts channel (dashboard is scoreboard-only)
    const tickerId = process.env.RECEIPTS_CHANNEL_ID || process.env.SLIP_FEED_CHANNEL_ID;
    if (!tickerId) return;
    const channel = await client.channels.fetch(tickerId).catch(() => null);
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
  finalizeBetGrading,
  gradePropWithAI,
  gradeBet: finalizeBetGrading,
  canFinalizeBet,
  claimBetForGrading,
  applyBackoff,
  scheduleRecheckAfterDenial,
  backendHealth,
  isBackendHealthy,
  recordBackendResult,
  SUPPORTED_SPORTS,
  isSupportedSport,
  calcProfit,
  delay,
  findMentionedTeams,
  normalizeSportContext,
  fetchScores,
  determineResult,
  aggregateParlayResults,
  matchBetToGame,
  canonicalizeTeamName,
};
