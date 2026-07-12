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

// Escape regex metacharacters so an alias is matched literally (none of the 37 aliases
// currently contain one, but "a's"/"d-backs" are punctuation-adjacent and this keeps the
// word-boundary test correct if the alias table ever grows a metachar).
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalize(teamText) {
  if (!teamText) return null;
  const lower = teamText.toLowerCase().trim();
  // Exact alias hit
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  // Match an alias only as a WHOLE WORD, never a bare substring. Descriptions can be
  // "Atlanta Braves ML" (the alias is a *word* there), but a short alias must not be
  // matched inside a longer surname: "as" ⊂ "Ya-s-trzemski" / "Ma-s-yn" used to resolve
  // valid player names to "Athletics", which (a) made looksLikePlayerProp reject clean
  // props and (b) was the route by which "Masyn Winn" mis-fed the game-total grader (the
  // #130 false-WIN). \b anchors each alias to token boundaries; multi-word aliases
  // ("red sox", "blue jays", "white sox") and punctuation-adjacent ones ("a's", "d-backs")
  // boundary-match correctly.
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (new RegExp(`\\b${escapeRegex(alias)}\\b`).test(lower)) return canonical;
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
      gameDate: g.gameDate,   // statsapi ISO-UTC game start — authoritative event_date (§9 write-back)
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

// ── Matchup-prefixed player prop → canonical prop string (REROUTE; #130 follow-up) ──
//
// #130's guard REFUSES a leg shaped "Team vs Team Over N PLAYER [-] STAT" so the run-
// total grader can't read its "Over 0.5" as a run line and false-WIN. This is the
// inverse for the RECOGNIZED ones: strip the matchup prefix and rewrite to the canonical
// "<PLAYER> Over/Under <N> <stat>" form so the player-prop grader (gradeMlbPlayerProp)
// can settle it. The router (services/sportsdata/index.js) calls this BEFORE its team/
// total dispatch; a non-null result is graded via gradeMlbPlayerProp — which can only
// ever return a player result, a DNP VOID, or { resolved:false }, NEVER a game total.
// So a wrong extraction or an unresolvable name degrades to a SAFE refuse, never a false
// WIN (exactly the property #130 protects). gradeMlbPlayerProp looks the player up by
// SURNAME in the box score, so a name that merely canonicalizes to a team ("Masyn Winn"
// → 'as' → Athletics) — which broke the OLD team-total misroute — now resolves fine. The
// residual that still safely refuses: a SURNAME carrying a diacritic the slip spells in
// ASCII ("José Ramírez" vs "Jose Ramirez"), since the box-score match is ASCII-exact.
//
// Returns the canonical string, or null (→ routing unchanged) unless ALL hold:
//   • matchup-prefixed: "<teams> (vs|v|@) <teams> (Over|Under|O|U) <N> <rest>"
//   • <rest> names a NON-RUN player stat — the SAME PLAYER_STAT_TOKEN_RX signal #130
//     refuses on (so a real run total "… Under 8.5 Total Runs" → null → still a total)
//   • <rest> splits into a non-empty <player> AND a <stat> (so a bare game-stat market
//     "… Over 8.5 Total Bases" with no player → null → still refused by #130's guard)
const MATCHUP_PREFIXED_PROP_RX =
  /^.+?\s+(?:vs?\.?|@)\s+.+?\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i;

function rewriteMatchupPrefixedProp(description) {
  if (typeof description !== 'string' || !description) return null;
  const m = description.trim().match(MATCHUP_PREFIXED_PROP_RX);
  if (!m) return null;
  const [, dirRaw, num, restRaw] = m;
  const rest = restRaw.trim();
  // Only reroute a NON-RUN player stat (#130's signal, inverted). A run total ("Total
  // Runs") has no PLAYER_STAT_TOKEN_RX match → null → still grades as a game total.
  if (!PLAYER_STAT_TOKEN_RX.test(rest.toLowerCase())) return null;

  // Split <rest> into "<player> [-] <stat>".
  let player = null;
  let stat = null;
  const dash = rest.split(/\s+[-–—]\s+/); // slip convention "<player> - <stat>" (spaced dash;
  if (dash.length >= 2 && dash[0].trim()) { // an intra-name hyphen like "Saint-Denis" has no
    player = dash[0].trim();                //  surrounding spaces, so it survives the split)
    stat = dash.slice(1).join(' ').trim();
  } else {
    // No dash: the stat is the trailing recognized stat phrase, the player is the prefix.
    // Locate it with the SAME non-run signal (lowercase only to find the index; positions
    // align with the original, so the player slice keeps its real casing). Require the
    // inferred player to be a real first+last name (≥2 tokens): WITHOUT the explicit dash
    // delimiter a 1-token prefix is a game-market lead word, not a person — "… Over 8.5
    // Total Hits" → "Total", "… Over 8.5 Team Total Bases" → "Team". Rerouting those would
    // auto-VOID a game-stat market that #130 deliberately sends to manual review; rejecting
    // them (→ null → gradeMlbBet's refuse) preserves that intent. The dash form keeps its
    // single-name players ("Gorman - Hits") because the delimiter is explicit there.
    const hit = rest.toLowerCase().match(PLAYER_STAT_TOKEN_RX);
    if (hit && hit.index > 0) {
      const candidate = rest.slice(0, hit.index).trim();
      if (candidate.split(/\s+/).filter(Boolean).length >= 2) {
        player = candidate;
        stat = rest.slice(hit.index).trim();
      }
    }
  }
  if (!player || !stat) return null;

  const direction = dirRaw.toLowerCase().startsWith('o') ? 'Over' : 'Under';
  return `${player} ${direction} ${num} ${stat}`;
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
    return { resolved: true, status: 'PENDING', evidence: `Game scheduled but not final (${game.detailedState})`, source: 'mlb_statsapi', eventDate: game.gameDate };
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
      eventDate: game.gameDate,
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
      eventDate: game.gameDate,
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
      eventDate: game.gameDate,
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

// Collect every player whose SURNAME matches across both sides, applying first-name
// disambiguation when a first name is given. Shared by findPlayerInBoxscore (the public
// lookup) and findPlayerGame (which counts matches to distinguish a same-surname COLLISION
// from a true absence). lastLower/firstLower are pre-lowercased.
function collectSurnameMatches(boxscore, lastLower, firstLower) {
  const matches = [];
  for (const side of ['home', 'away']) {
    const team = boxscore?.teams?.[side];
    if (!team?.players) continue;
    for (const pdata of Object.values(team.players)) {
      const full = pdata?.person?.fullName?.toLowerCase() || '';
      const boxName = pdata?.person?.boxscoreName?.toLowerCase() || '';
      const fullWords = full.split(/\s+/);
      const lastNameMatches = fullWords[fullWords.length - 1] === lastLower || boxName === lastLower;
      if (!lastNameMatches) continue;
      // A first name disambiguates a surname collision — keep the existing filter so
      // multi-token legs ("Will Smith") stay safe and pick exactly their player.
      if (firstLower && fullWords[0] !== firstLower) continue;
      matches.push({
        player: pdata.person.fullName,
        team: team.team?.name,
        batting: pdata.stats?.batting || {},
        pitching: pdata.stats?.pitching || {},
      });
    }
  }
  return matches;
}

// Find a player's stats line across both teams.
// Returns: { player, team, batting, pitching } or null.
function findPlayerInBoxscore(boxscore, playerLastName, playerFirstName = null) {
  const firstLower = (playerFirstName || '').toLowerCase();
  const matches = collectSurnameMatches(boxscore, playerLastName.toLowerCase(), firstLower);
  if (matches.length === 0) return null;
  // Single-token leg (no first name) that matches 2+ different same-surname players on
  // the slate is unresolvable from a box score alone — refuse (return null) rather than
  // grade the wrong player with no signal. The caller (findPlayerGame) re-checks the
  // match count on a miss and flags the absence as AMBIGUOUS (not a provable DNP), so a
  // collision falls through to search instead of fabricating a "did not play" VOID. With
  // a first name present the filter above already narrowed it (multi-token legs are safe).
  if (!firstLower && matches.length > 1) return null;
  return matches[0];
}

// Parse a player-prop description. Returns { player, stat, direction, threshold } or null.
// Examples:
//   "Aaron Judge 2+ H+R+RBI" → { player: "Aaron Judge", stat: 'compound', fields: [hits,runs,rbi], direction: 'over', threshold: 1.5 (2+ → over 1.5) }
//   "Tarik Skubal O 17.5 Pitching Outs" → { player: "Tarik Skubal", stat: 'outs', direction: 'over', threshold: 17.5 }
//   "Aaron Judge 1+ Home Runs" → { player: "Aaron Judge", stat: 'homeRuns', direction: 'over', threshold: 0.5 }
// This is the V1 grammar — the live parser. PROP_PARSE_V2_MODE (below) wraps it:
// public parsePlayerProp delegates here first under every mode, and this body
// must stay byte-identical (off-mode behavior is pinned to it).
function parsePlayerPropV1(description) {
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
function looksLikePlayerProp(description, v2opts) {
  const parsed = parsePlayerProp(description, v2opts); // v2opts: test-only seam (see parsePlayerProp)
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

// ═══════════════════════════════════════════════════════════
// PROP_PARSE_V2 — flag-gated v2 prop grammar (Build 2 blocker 2, MLB slice)
//
// 51 live MLB rows sit in review_status='auto_void_no_searchable_data' with
// player-prop descriptions the v1 grammar above cannot USABLY parse: leading
// Over/Under ("Over 0.5 Yandy Diaz Hits"), verbose stat phrasing ("Aaron Judge
// To Record A Hit", "Nick Kurtz To Hit A Home Run"), trailing-direction ("IVAN
// HERRERA - HITS Over 0.5") and bare home-run nouns ("Mike Trout HR").
// looksLikePlayerProp delegates to parsePlayerProp AND gates live routing (the
// grading.js structured pre-check via sportsdata/index.js isPropBet), so ALL
// new grammar is flag-gated, shadow-first:
//
//   PROP_PARSE_V2_MODE = off | shadow | enforce   (unset/garbage → off; read
//   ONCE at module load, mirroring slateResplit.js resolveMode)
//     off      (default) — v1 parser only; the v2 code paths are unreachable.
//                          MERGING THIS CHANGES NOTHING.
//     shadow             — route/grade on v1: every routing decision is
//                          byte-identical to off. When v2 parses a description
//                          v1 could not, emit ONE `prop_parse_v2_shadow`
//                          pipeline event per DISTINCT description (per-process
//                          dedup — the parser is hit 2-3× per grading pass via
//                          looksLikePlayerProp / looksLikeMisroutedPlayerProp /
//                          gradeMlbPlayerProp, and re-hit on every recheck, so
//                          without dedup one description would flood the
//                          table). Emission is the ONLY side effect and can
//                          never throw into grading (try/caught, lazy-required
//                          sink so requiring this module never pulls in the DB).
//     enforce            — parse with v2 = v1 grammar + the additions below,
//                          tried only AFTER v1 misses; a v1-usable parse is
//                          returned UNTOUCHED under every mode (pinned by
//                          tests/mlb-prop-parse-v2.test.js).
//
// "v1 miss" deliberately includes v1 parses that MATCH a regex but can never
// grade: v1's lazy (.+?) captures leave separator/verbose debris in the player
// field for the live failing shapes ("Kyle Harrison - Over 6.5 Strikeouts" →
// player "Kyle Harrison -"; "Michael Harris II - TO RECORD 1+ HITS" → player
// "Michael Harris II - TO RECORD"), so the box-score lookup keys on lastName
// '-' / 'RECORD' and always falls through to search → auto-void. Those parses
// count as v1 MISSES for v2 gating (see v1ParseUsable); v1 parses with a clean
// player are the population the v1-identical invariant protects.
const PROP_PARSE_V2_VALID_MODES = new Set(['off', 'shadow', 'enforce']);
function resolvePropParseV2Mode(raw) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase();
  return PROP_PARSE_V2_VALID_MODES.has(m) ? m : 'off';
}
const PROP_PARSE_V2_MODE = resolvePropParseV2Mode(process.env.PROP_PARSE_V2_MODE);

// v2-ONLY stat aliases. Deliberately NOT merged into STAT_MAP: resolveStat is
// shared with the v1 patterns, so adding 'doubles' there would flip live
// routing under mode=off ("Aaron Judge O 1.5 Doubles" is pinned → false by
// tests/sportsdata-prop-routing.test.js), violating the off-is-byte-identical
// invariant. The v2 resolvers consult STAT_MAP first, then this table.
const V2_STAT_ALIASES = {
  'double': 'doubles',
  'doubles': 'doubles',
};

// Explicit v2 EXCLUSIONS — must return null from the v2 attempt (spec §4):
//   NRFI/NRSI    — game markets, not player props.
//   "HR / FS"    — compound-alternate leg ("Carter Jensen HR / FS"): two
//                  markets on one line; grading either alone would misgrade.
// The other spec'd exclusions (direction-less numerics, inning totals,
// headers/promo, SGP name-lists) fall out of the grammar naturally — no v2
// pattern admits them — and are pinned by negative tests instead of listed here.
const V2_EXCLUDE_RX = /\bnrfi\b|\bnrsi\b|\bhr\s*\/\s*fs\b/i;

// Pre-normalization, applied ONLY within the v2 attempt (the v1 path is
// untouched): strip leading bullets, collapse spaced-dash separators, strip the
// observed "Straight Bet" noise token ("Mark Vientos Straight Bet HR"),
// collapse whitespace. Case is PRESERVED (all v2 patterns match /i) so the
// extracted player keeps the slip's casing for evidence strings; an intra-name
// hyphen ("Smith-Njigba") has no surrounding spaces and survives. Known
// residual: an OCR artifact that SPACES a surname hyphen ("Pete Crow -
// Armstrong HR") is indistinguishable from a separator, collapses to "Crow
// Armstrong", and the lastName lookup then misses — the leg refuses into
// search unless the slate is provably final; accepted (needs the OCR artifact,
// and off-mode behavior for it is null → search anyway).
function v2Normalize(description) {
  return String(description == null ? '' : description)
    .replace(/^[\s•\-*]+/, '')
    .replace(/\s+[-–—]+\s+/g, ' ')
    .replace(/\bstraight bet\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Player-field plausibility — the SAME router guards v1's looksLikePlayerProp
// applies, enforced INSIDE every v2 pattern so v2 never emits/returns a parse
// the router would have to reject: non-empty, no digit-bearing token ("1st
// Inning..."), no direction/market vocabulary token, and the subject must not
// canonicalize to a team ("Over 8.5 Los Angeles Dodgers Runs" stays a team
// total → team grader).
// Rejection is deliberately ASYMMETRIC-SAFE: a false REJECT returns null and
// the bet falls through to the ESPN+AI/search chain — exactly today's
// behavior — while a false ACCEPT routes a junk subject to gradeMlbPlayerProp,
// whose provable-absence branch can mint a terminal FALSE VOID on a decided
// bet (and, under shadow, counts the junk parse as a successful rescue in the
// very metric that justifies the enforce flip). When unsure, REJECT.
const V2_PLAYER_STOP_TOKENS = new Set([
  // direction / market vocabulary
  'over', 'under', 'o', 'u',
  'total', 'totals', 'inning', 'innings', 'team', 'teams', 'game', 'alt',
  'combined', 'both', 'each', 'every',
  // conjunctions / matchup glue — a multi-player or matchup subject is never
  // gradeable as ONE box-score line ("Judge + Ohtani", "Trout and Judge")
  'and', 'or', 'plus', 'vs', 'v',
  // HR-market qualifiers — "Anytime HR" (adjacent market), "First Home Run"
  // (FIRST-to-homer, different market), "No HR" (opposite direction)
  'anytime', 'first', 'last', 'no',
  // MLB club place-name tokens: canonicalize() only knows NICKNAME aliases, so
  // a city-worded team total ("Tampa Bay Runs Over 4.5", "St. Louis Runs …")
  // slips past the team guard with a null canonicalize. Closed list covering
  // the 30 clubs' place names. Cost: a real player sharing one of these
  // tokens (e.g. a first name "Louis"/"Diego") is REJECTED into the search
  // path — the safe direction per the header note.
  'tampa', 'bay', 'seattle', 'boston', 'chicago', 'houston', 'atlanta',
  'arizona', 'colorado', 'cleveland', 'detroit', 'minnesota', 'milwaukee',
  'cincinnati', 'pittsburgh', 'philadelphia', 'washington', 'miami', 'texas',
  'kansas', 'city', 'oakland', 'sacramento', 'anaheim', 'vegas', 'toronto',
  'baltimore', 'york', 'angeles', 'francisco', 'diego', 'louis',
]);
// Name-shaped token: letters (incl. Latin-1 accents — statsapi fullNames carry
// them, so an accented slip name still matches the box score), apostrophes,
// periods, intra-token hyphens. Anything else ('+', '&', '/', digits) is not a
// name and marks a compound/junk subject.
const V2_NAME_TOKEN_RX = /^[A-Za-zÀ-ÖØ-öø-ÿ'’.\-]+$/;
function v2PlayerPlausible(player) {
  const p = String(player == null ? '' : player).trim();
  if (!p) return false;
  // Verbose noise is never part of a name — rejecting it here makes the v1ext
  // B-shape candidate for "Michael Harris II TO RECORD 1+ HITS" (whose lazy
  // capture swallows "TO RECORD") fall through to the verbose family, which
  // extracts the clean player.
  if (/\bto record\b|\bto hit a\b/i.test(p)) return false;
  for (const tok of p.split(/\s+/)) {
    if (!V2_NAME_TOKEN_RX.test(tok)) return false;
    if (V2_PLAYER_STOP_TOKENS.has(tok.toLowerCase().replace(/[.,]+$/, ''))) return false;
  }
  if (canonicalize(p)) return false;
  return true;
}

// Longest whole-word SUFFIX match against COMPOUND_STATS + STAT_MAP +
// V2_STAT_ALIASES. Deliberately NOT v1's resolveStat: its substring scan
// resolves a stray LETTER inside a name ('r' in "Tarik" → runs — see
// PLAYER_STAT_TOKEN_RX's header), which is unusable when the stat text sits at
// the END of a free remainder; requiring the alias to be the space-delimited
// tail is the tight form. Returns { key, stat, fields } or null.
function v2ResolveStatSuffix(text) {
  const s = String(text == null ? '' : text).toLowerCase().trim();
  let best = null;
  const consider = (key, stat, fields) => {
    if ((s === key || s.endsWith(' ' + key)) && (!best || key.length > best.key.length)) {
      best = { key, stat, fields: fields || null };
    }
  };
  for (const [key, fields] of Object.entries(COMPOUND_STATS)) consider(key, 'compound', fields);
  for (const [key, stat] of Object.entries(STAT_MAP)) consider(key, stat, null);
  for (const [key, stat] of Object.entries(V2_STAT_ALIASES)) consider(key, stat, null);
  return best;
}

// Exact-key stat resolution for the v1-shaped v2 patterns and verbose stat
// captures (the stat capture is the whole trailing text there). Spaced
// compounds are canonicalized first ("Hits + Runs + RBIs" → "hits+runs+rbis",
// a COMPOUND_STATS key), and any OTHER conjunction-bearing stat text is
// REFUSED outright: the suffix fallback would otherwise resolve only the LAST
// component ("… Hits + Runs + RBIs" → rbi) and grade a clean player on the
// wrong stat — a definite wrong WIN/LOSS, the worst failure class.
function v2ResolveStatText(statText) {
  const key = String(statText == null ? '' : statText).toLowerCase().trim();
  const compoundKey = key.replace(/\s*\+\s*/g, '+');
  if (COMPOUND_STATS[compoundKey]) return { key, stat: 'compound', fields: COMPOUND_STATS[compoundKey] };
  if (/[+&]|\band\b/i.test(key)) return null;
  if (STAT_MAP[key]) return { key, stat: STAT_MAP[key], fields: null };
  if (V2_STAT_ALIASES[key]) return { key, stat: V2_STAT_ALIASES[key], fields: null };
  return v2ResolveStatSuffix(key);
}

// Resolve a Pattern-D remainder ("<player> <stat phrase>") into player + stat.
// Verbose phrase families FIRST (so "JACKSON CHOURIO TO RECORD 1+ HITS" yields
// player "JACKSON CHOURIO", not "JACKSON CHOURIO TO RECORD 1+"), then the
// plain longest-suffix stat. Any threshold implied by a verbose phrase is
// DISCARDED here — under Pattern D the leading threshold WINS (spec §1).
function v2ResolveRemainder(remainder) {
  // Canonicalize spaced compounds ("Hits + Runs + RBIs" → "hits+runs+rbis") so
  // the suffix pass can hit a COMPOUND_STATS key; a junk '+' anywhere else
  // ends up in the player slice, where v2PlayerPlausible's name-token check
  // rejects it (never a partial-compound wrong-stat grade).
  // (letter-to-letter joins only, so an N+ threshold token "1+ HITS" keeps its space)
  const rem = String(remainder == null ? '' : remainder).trim().replace(/([A-Za-zÀ-ÖØ-öø-ÿ])\s*\+\s*(?=[A-Za-zÀ-ÖØ-öø-ÿ])/g, '$1+');
  let m = rem.match(/^(.+?)\s+to record (?:a hit|1\+ hits?)$/i);
  if (m) return { player: m[1], stat: 'hits', fields: null };
  m = rem.match(/^(.+?)\s+to record (\d+)\+\s+(.+)$/i);
  if (m) {
    const hit = v2ResolveStatText(m[3]);
    if (hit) return { player: m[1], stat: hit.stat, fields: hit.fields };
    return null;
  }
  m = rem.match(/^(.+?)\s+to hit a home run$/i);
  if (m) return { player: m[1], stat: 'homeRuns', fields: null };
  const hit = v2ResolveStatSuffix(rem);
  if (hit) {
    return {
      player: rem.slice(0, rem.length - hit.key.length).trim(),
      stat: hit.stat,
      fields: hit.fields,
    };
  }
  return null;
}

// The v2 additions, tried in order AFTER v1 misses (each candidate must pass
// v2PlayerPlausible or it falls through to the next pattern). Returns
// { parsed: { player, stat, fields, direction, threshold }, pattern } or null.
// Patterns:
//   'v1ext'   — the v1 B/C shapes re-run on the NORMALIZED text with the v2
//               stat table ("Kyle Harrison - Over 6.5 Strikeouts" → clean
//               player via dash-collapse; "Davis Schneider O 0.5 Doubles" via
//               the doubles alias). Not in the spec's D/verbose/bare_hr enum —
//               added because two positive fixtures are reachable no other way.
//   'D'       — leading Over/Under: "Over 0.5 Yandy Diaz Hits".
//   'verbose' — "To Record A Hit" / "To Record N+ <stat>" (N+ → over N-0.5,
//               v1's N+ semantics) / "To Hit A Home Run" / trailing-direction
//               "<player> <stat> Over N".
//   'bare_hr' — CLOSED bare-noun set, HR ONLY: "<player> HR(s)" / "<player>
//               1+ HR" / "<player> Home Run(s)" → homeRuns over 0.5 (the "HRs"
//               plural is a deliberate one-token widening of the spec set,
//               mirroring STAT_MAP's own hrs alias — still HR-only). The
//               string must contain NOTHING besides player tokens + the HR
//               token(s); single-token players allowed ("Drake HR"). DO NOT
//               extend to bare hits/doubles/Ks (spec §3). HR-market
//               qualifiers ("Anytime HR", "First Home Run", "No HR") are
//               DIFFERENT markets and are rejected by the player stop-tokens.
function parsePlayerPropV2(description) {
  const norm = v2Normalize(description);
  if (!norm || V2_EXCLUDE_RX.test(norm)) return null;

  const mk = (pattern, player, hit, direction, threshold) => ({
    parsed: {
      player: String(player).trim(),
      stat: hit.fields ? 'compound' : hit.stat,
      fields: hit.fields || null,
      direction,
      threshold,
    },
    pattern,
  });

  // v1ext — Pattern B shape: "<player> N+ <stat>"
  let m = norm.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/i);
  if (m && v2PlayerPlausible(m[1])) {
    const hit = v2ResolveStatText(m[3]);
    if (hit) return mk('v1ext', m[1], hit, 'over', parseFloat(m[2]) - 0.5);
  }
  // v1ext — Pattern C shape: "<player> O|U|Over|Under N <stat>"
  m = norm.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (m && v2PlayerPlausible(m[1])) {
    const hit = v2ResolveStatText(m[4]);
    if (hit) return mk('v1ext', m[1], hit, m[2].toLowerCase().startsWith('o') ? 'over' : 'under', parseFloat(m[3]));
  }
  // Pattern D — leading Over/Under: direction+threshold lead, remainder is
  // "<player> <stat phrase>". A remainder whose stat resolves but whose
  // subject is implausible (no player tokens left, digit/market tokens, or a
  // team) is REJECTED — "Under 0.5 1st Inning Total Runs" stays null.
  m = norm.match(/^(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (m) {
    const res = v2ResolveRemainder(m[3]);
    if (res && v2PlayerPlausible(res.player)) {
      return mk('D', res.player, res, m[1].toLowerCase().startsWith('o') ? 'over' : 'under', parseFloat(m[2]));
    }
  }
  // verbose — "<player> to record a hit" / "to record 1+ hits" → hits over 0.5
  m = norm.match(/^(.+?)\s+to record (?:a hit|1\+ hits?)$/i);
  if (m && v2PlayerPlausible(m[1])) {
    return mk('verbose', m[1], { stat: 'hits', fields: null }, 'over', 0.5);
  }
  // verbose — "<player> to record N+ <stat>" → that stat, over N-0.5
  m = norm.match(/^(.+?)\s+to record (\d+)\+\s+(.+)$/i);
  if (m && v2PlayerPlausible(m[1])) {
    const hit = v2ResolveStatText(m[3]);
    if (hit) return mk('verbose', m[1], hit, 'over', parseFloat(m[2]) - 0.5);
  }
  // verbose — "<player> to hit a home run" → homeRuns over 0.5
  m = norm.match(/^(.+?)\s+to hit a home run$/i);
  if (m && v2PlayerPlausible(m[1])) {
    return mk('verbose', m[1], { stat: 'homeRuns', fields: null }, 'over', 0.5);
  }
  // verbose — trailing-direction: "<player> <stat> Over N" (stat BEFORE the
  // O/U token, threshold at end-of-string): "IVAN HERRERA - HITS Over 0.5"
  m = norm.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)$/i);
  if (m) {
    const hit = v2ResolveStatSuffix(m[1]);
    if (hit) {
      const player = m[1].slice(0, m[1].length - hit.key.length).trim();
      if (v2PlayerPlausible(player)) {
        return mk('verbose', player, hit, m[2].toLowerCase().startsWith('o') ? 'over' : 'under', parseFloat(m[3]));
      }
    }
  }
  // bare_hr — closed enumeration, HR only
  m = norm.match(/^([A-Za-z][A-Za-z'’.\-]*(?:\s+[A-Za-z][A-Za-z'’.\-]*)*)\s+(?:1\+\s+)?(?:hrs?|home\s+runs?)$/i);
  if (m && v2PlayerPlausible(m[1])) {
    return mk('bare_hr', m[1], { stat: 'homeRuns', fields: null }, 'over', 0.5);
  }
  return null;
}

// A v1 parse is USABLE only when it resolved a stat (or compound fields) AND
// its player field is a plausible name: no separator debris (standalone or
// leading/trailing -/–/—/•/*), no digits, no direction word, no verbose-noise
// phrase. Anything else routes to the structured grader today only to fail the
// box-score lookup (lastName '-' / 'RECORD') — a v1 MISS for v2 purposes. A
// real working v1 parse ("Aaron Judge", "Tarik Skubal") never trips this.
const V1_PLAYER_DEBRIS_RX =
  /(?:^|\s)[-–—•*](?:\s|$)|^[-–—•*]|[-–—•*]$|\d|\b(?:over|under)\b|\bto record\b|\bstraight bet\b|\bto hit a\b/i;
function v1ParseUsable(parsed) {
  if (!parsed) return false;
  if (parsed.stat === null && !parsed.fields) return false;
  if (V1_PLAYER_DEBRIS_RX.test(String(parsed.player == null ? '' : parsed.player))) return false;
  return true;
}

// ── prop_parse_v2_shadow emitter ──
// Lazy-required sink (requiring pipeline-events pulls in database.js — tests
// require this module DB-free, and slateResplit sets the same precedent);
// injectable via the v2opts.recordStageFn test seam. sourceType 'grading' +
// stage 'GRADING_ENTER' because the parser runs inside grading passes and has
// no ingest identity (writeRow requires ingestId for every other sourceType);
// betId is unknown at parser level → NULL, the event is keyed by desc.
let _recordStageLazy = null;
function defaultRecordStage(evt) {
  if (!_recordStageLazy) _recordStageLazy = require('../pipeline-events').recordStage;
  return _recordStageLazy(evt);
}
// ONE event per distinct description per process (see the mode header).
const _v2ShadowSeen = new Set();
const V2_SHADOW_SEEN_MAX = 5000; // memory backstop; a clear() re-emits at worst one extra row per shape
function emitPropParseV2Shadow(description, v2, recordStageFn) {
  try {
    const key = String(description).trim();
    if (_v2ShadowSeen.has(key)) return;
    if (_v2ShadowSeen.size >= V2_SHADOW_SEEN_MAX) _v2ShadowSeen.clear();
    const r = (recordStageFn || defaultRecordStage)({
      sourceType: 'grading',
      stage: 'GRADING_ENTER',
      eventType: 'prop_parse_v2_shadow',
      payload: {
        where: 'mlb.parsePlayerProp',
        desc: key.slice(0, 90), // trimmed, consistent with the dedup key (its 90-char prefix)
        pattern: v2.pattern,
        player: v2.parsed.player,
        stat: v2.parsed.stat,
        threshold: v2.parsed.threshold,
        direction: v2.parsed.direction,
      },
    });
    // Consume the dedup key only AFTER the sink call returned: a sink that
    // throws (e.g. the lazy require failing) leaves the key unconsumed, so the
    // next parser hit of the same description retries instead of the shape
    // being silently suppressed for the process lifetime.
    _v2ShadowSeen.add(key);
    // The real recordStage is synchronous fire-and-forget, but the test seam
    // may hand us an async sink — swallow a late rejection so it can never
    // surface as an unhandledRejection.
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* observability must never break grading */ }
}

// Public parser — the PROP_PARSE_V2_MODE wrapper around the v1 grammar.
// v2opts is a TEST-ONLY seam ({ mode, recordStageFn }); production callers
// pass nothing and get the module-load mode + the real pipeline-events sink.
function parsePlayerProp(description, v2opts) {
  const mode = (v2opts && v2opts.mode) || PROP_PARSE_V2_MODE;
  const v1 = parsePlayerPropV1(description);
  if (mode !== 'shadow' && mode !== 'enforce') return v1; // off: v2 unreachable
  if (v1ParseUsable(v1)) return v1; // v1-parseable → identical under v2
  const v2 = parsePlayerPropV2(description);
  if (!v2) return v1;
  if (mode === 'shadow') {
    emitPropParseV2Shadow(description, v2, v2opts && v2opts.recordStageFn);
    return v1; // routing byte-identical to off — emission is the only side effect
  }
  return v2.parsed; // enforce
}

// Find the gamePk for a specific player on a date by checking the schedule for any game they played in.
// Strategy: pull all games for the date, fetch each game's boxscore until we find the player.
// On a hit, returns the player's stat line (shape unchanged). On a miss, returns a
// not-found record carrying the slate metadata the caller needs to decide whether
// the absence is PROVABLE (→ VOID) or merely indeterminate — see terminalState.js.
async function findPlayerGame(playerLastName, dateYMD, playerFirstName = null) {
  const data = await fetchJSON(`${BASE}/schedule?sportId=1&date=${dateYMD}`);
  const games = data?.dates?.[0]?.games || [];
  const lastLower = playerLastName.toLowerCase();
  const firstLower = (playerFirstName || '').toLowerCase();
  let allFinal = true;
  let anyFetchError = false;
  let anyAmbiguous = false;
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
          gameDate: g.gameDate,   // statsapi ISO-UTC game start — authoritative event_date (§9)
          finished: gameFinal,
          detailedState: g.status?.detailedState,
          ...found,
        };
      }
      // A surname COLLISION (no first name + 2+ same-surname players in this game) makes
      // findPlayerInBoxscore return null just like a true absence — but the player may well
      // BE one of them. Flag it so the caller treats the miss as INDETERMINATE, never a
      // provable DNP: voiding here would fabricate a "did not play" settle for a player who
      // played. (With a first name the collection is already disambiguated, so no flag.)
      if (!firstLower && collectSurnameMatches(bs, lastLower, '').length > 1) anyAmbiguous = true;
    } catch (_) { anyFetchError = true; /* skip game, try next */ }
  }
  return { notFound: true, gamesOnDate: games.length, allFinal, anyFetchError, anyAmbiguous };
}

// Grade a single player prop.
// opts.absenceVoidAllowed (default true): the caller may forbid the provable-
// absence VOID when the bet's date is ambiguous (see tryStructured date gate).
async function gradeMlbPlayerProp(description, dateYMD, opts = {}) {
  const parsed = parsePlayerProp(description, opts.propParseV2); // opts.propParseV2: test-only seam
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
    // result.anyAmbiguous (a same-surname collision on a surname-only leg) is ALSO
    // indeterminate — the player is likely one of the collided names — so it must fall
    // through, never VOID (a DNP void there would be a fabricated settle for a player
    // who actually played).
    if (!result.anyAmbiguous && opts.absenceVoidAllowed !== false && isProvableAbsence(result)) {
      return voidPlayerDidNotPlay(parsed.player, dateYMD, result.gamesOnDate, 'MLB', 'mlb_statsapi');
    }
    return { resolved: false, reason: 'player_not_found_in_games_on_date' };
  }
  if (!result.finished) {
    return { resolved: true, status: 'PENDING', evidence: `${result.player}'s game not yet final (${result.detailedState})`, source: 'mlb_statsapi', eventDate: result.gameDate };
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
    eventDate: result.gameDate,
  };
}

module.exports = {
  gradeMlbBet,
  gradeMlbPlayerProp,
  getGameForTeam,
  findPlayerGame,
  findPlayerInBoxscore,
  parsePlayerProp,
  looksLikePlayerProp,
  looksLikeMisroutedPlayerProp,
  rewriteMatchupPrefixedProp,
  canonicalize,
  resolvePropParseV2Mode,
  _internal: {
    TEAM_ALIASES, STAT_MAP, COMPOUND_STATS,
    // PROP_PARSE_V2 test seams
    V2_STAT_ALIASES,
    PROP_PARSE_V2_MODE,
    parsePlayerPropV1,
    parsePlayerPropV2,
    v1ParseUsable,
    resetPropParseV2ShadowDedup() { _v2ShadowSeen.clear(); },
  },
};