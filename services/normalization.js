// ═══════════════════════════════════════════════════════════
// Team & Player Name Normalization
// Resolves aliases ("LAL", "Dubs", "Sixers") to canonical
// names ("Los Angeles Lakers", "Golden State Warriors",
// "Philadelphia 76ers") before database insertion.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TEAMS_PATH = path.join(__dirname, '..', 'data', 'mappings', 'teams.json');
const PLAYERS_PATH = path.join(__dirname, '..', 'data', 'mappings', 'players.json');

// ── Build lookup indices: alias (lowercase) → canonical name ──
let aliasIndex = {};
let playerIndex = {};

function loadTeamMappings() {
  const raw = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
  const index = {};
  const AMBIGUOUS = Symbol('ambiguous');

  for (const [league, teams] of Object.entries(raw)) {
    for (const [canonical, aliases] of Object.entries(teams)) {
      // Index the canonical name itself (full names never collide)
      index[canonical.toLowerCase()] = canonical;
      for (const alias of aliases) {
        const key = alias.toLowerCase();
        if (key in index && index[key] !== canonical && index[key] !== AMBIGUOUS) {
          // Cross-league collision — mark as ambiguous so it passes through
          index[key] = AMBIGUOUS;
        } else if (index[key] !== AMBIGUOUS) {
          index[key] = canonical;
        }
      }
    }
  }

  // Remove ambiguous entries so lookups fall through to passthrough
  for (const key of Object.keys(index)) {
    if (index[key] === AMBIGUOUS) delete index[key];
  }

  return index;
}

function loadPlayerMappings() {
  if (!fs.existsSync(PLAYERS_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf-8'));
  const index = {};
  const AMBIGUOUS = Symbol('ambiguous');

  for (const [league, players] of Object.entries(raw)) {
    for (const [canonical, aliases] of Object.entries(players)) {
      index[canonical.toLowerCase()] = canonical;
      for (const alias of aliases) {
        const key = alias.toLowerCase();
        if (key in index && index[key] !== canonical && index[key] !== AMBIGUOUS) {
          index[key] = AMBIGUOUS;
        } else if (index[key] !== AMBIGUOUS) {
          index[key] = canonical;
        }
      }
    }
  }

  // Remove ambiguous entries so lookups fall through to passthrough
  for (const key of Object.keys(index)) {
    if (index[key] === AMBIGUOUS) delete index[key];
  }

  return index;
}

// ── Common-noun nickname guard (normalizeDescription only) ──
// A subset of team aliases whose dominant everyday-English (or betting-slang) meaning is
// NOT the team, so a bare \b…\b firing in prose splices the WRONG team —
// e.g. "the game was close" → "the game Washington Wizards close", "heat up" → "Miami
// Heat up", "matchup cards" → "St. Louis Cardinals". Unlike the bare-city / sf-la-sox
// aliases (commits 93cbe5e, 564a88a), these CANNOT be removed: the nickname IS the team's
// legitimate name, so "Heat ML" must still resolve. Instead, normalizeDescription only
// expands these when bet-context is present (see hasBetContext). normalizeTeam (whole-
// string exact lookup) and teams.json are untouched, so normalizeTeam("Boys")→Cowboys etc.
// are unaffected. NOT guarded: non-words that only ever mean the team in this domain
// (cavs, niners, sixers, knicks, spurs, thunder, wolves, padres, cubs, …) — guarding those
// would suppress legit prose expansions for no benefit.
const COMMON_NOUN_NICKNAMES = new Set([
  'was',   // Washington Wizards — English verb (worst offender: ~every "was" in prose)
  'wiz',   // Washington Wizards — "wiz/whiz kid"
  'heat',  // Miami Heat — "heat up"
  'magic', // Orlando Magic — "magic number"
  'jazz',  // Utah Jazz — "jazz it up"
  'kings', // Sacramento Kings — "kings of"; also LA Kings (NHL, not in map)
  'stars', // Dallas Stars — "star players", "stars are"
  'boys',  // Dallas Cowboys — "hop in boys"
  'cards', // St. Louis Cardinals — "matchup cards", "ripping cards"
  'bolts', // Tampa Bay Lightning — "lightning bolts"; also a Chargers nickname
  'bills', // Buffalo Bills — "pay the bills"
  'bucks', // Milwaukee Bucks — "big bucks"
  'nets',  // Brooklyn Nets — "safety nets"
  'jets',  // New York Jets — "private jets"
  'suns',  // Phoenix Suns
  'lions', // Detroit Lions
  'hawks', // Atlanta Hawks
  'dubs',  // Golden State Warriors — "get the dub(s)" = get the win(s)
]);

// City/abbrev tokens that, immediately before a guarded nickname, mark a DIFFERENT team
// than the nickname's canonical (so suppress regardless of odds). Kept tiny + explicit.
const WRONG_CITY_PREFIX = {
  kings: new Set(['la', 'l.a.', 'los angeles']), // "LA Kings" = NHL LA Kings, not Sacramento
};

/**
 * Decide whether a guarded common-noun nickname matched at [start,end) in `result` sits in
 * a PICK (expand) vs PROSE (suppress). Biased toward KEEP near any bet signal so real picks
 * are never dropped. By the time short nicknames are processed, longer team/player aliases
 * are already replaced with \x00N\x00 placeholder tokens, so an adjacent resolved entity
 * shows up as a token — treated as bet-context (matchup / parlay leg / prop).
 */
function hasBetContext(result, start, end, alias) {
  const W = 26;
  const zw = /[​‌‍﻿ ]/g;
  const before = result.slice(Math.max(0, start - W), start).replace(zw, ' ');
  const after = result.slice(end, end + W).replace(zw, ' ');

  // Wrong-city prefix (e.g. "LA Kings") → not this team → suppress regardless of odds.
  const wrong = WRONG_CITY_PREFIX[alias];
  if (wrong) {
    const m = before.match(/([a-z.]{2,12})\s+$/i);
    if (m && wrong.has(m[1].toLowerCase())) return false;
  }

  // Adjacent resolved team/player token (only separators between) → bet-context.
  if (/\x00\d+\x00[\s,./&@+\-–—|]{0,3}$/.test(before)) return true;
  if (/^[\s,./&@+\-–—|]{0,3}\x00\d+\x00/.test(after)) return true;

  // FOLLOW: bet token right after the nickname.
  const follow = new RegExp(
    '^[\\s,:.|\\-–—]*(' +
      '\\(?\\s*[+\\-]\\s?\\d' +                  // -1.5, +150, ( +550 )
      '|\\d+(\\.\\d+)?\\s*(u\\b|units?\\b|%)' +   // 2u, 1.5 units
      '|ml\\b|moneyline' +
      '|o/?u\\b|\\bover\\b|\\bunder\\b|o\\d|u\\d|\\btt\\b|team total|total\\b' +
      '|to (win|beat|cover|take|handle|advance|sweep|close)\\b' +
      '|in (5|6|7|five|six|seven|\\d)\\b' +       // "in Five", "in 7" (series)
      '|g[1-7]\\b|\\bgame\\b|\\bseries\\b|\\bsgp\\b|\\bsgpp?\\b' +
      '|\\dh\\b|\\d+\\s*min\\b|puck line|run line|\\bpl\\b|\\brl\\b' +
      '|\\bf5\\b|\\bnrfi\\b|\\byrfi\\b|\\breg\\b' +
      '|vs\\.?\\b|@|/|&' +
    ')',
    'i'
  ).test(after);
  if (follow) return true;

  // PRECEDE: bet token right before the nickname.
  return /(\bover\b|\bunder\b|\bvs\.?\b|@|\bo\b|\bu\b|\bml\b|[+\-]\d|\d+\s?u\b|\d+\s?units?\b|\bon\b)\s*$/i.test(before);
}

// Load once at module init
aliasIndex = loadTeamMappings();
playerIndex = loadPlayerMappings();

/**
 * Resolve a team name/abbreviation to its canonical form.
 * Returns the canonical name if found, otherwise returns the
 * input unchanged (trimmed).
 *
 * @param {string} name — e.g. "LAL", "Warriors", "dubs"
 * @returns {string} — e.g. "Los Angeles Lakers"
 */
function normalizeTeam(name) {
  if (!name || typeof name !== 'string') return name || '';
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  return aliasIndex[key] || trimmed;
}

/**
 * Scan a bet description and replace any known team aliases
 * with their canonical names. Preserves the rest of the text.
 *
 * Uses longest-match-first to avoid partial replacements
 * (e.g., "golden state" matches before "state").
 *
 * @param {string} text — e.g. "LAL -3.5 vs GSW"
 * @returns {string} — e.g. "Los Angeles Lakers -3.5 vs Golden State Warriors"
 */
function normalizeDescription(text) {
  if (!text || typeof text !== 'string') return text || '';

  // Merge team and player aliases, sorted by length descending
  const combined = { ...aliasIndex, ...playerIndex };
  const sortedAliases = Object.keys(combined).sort((a, b) => b.length - a.length);

  // Use placeholder tokens to prevent cascading replacements
  const replacements = [];
  let result = text;

  for (const alias of sortedAliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Common-noun nicknames only expand with bet-context; otherwise leave the prose word.
      if (COMMON_NOUN_NICKNAMES.has(alias) && !hasBetContext(result, offset, offset + match.length, alias)) {
        return match;
      }
      const token = `\x00${replacements.length}\x00`;
      replacements.push(combined[alias]);
      return token;
    });
  }

  // Restore tokens with canonical names
  for (let i = 0; i < replacements.length; i++) {
    result = result.replace(`\x00${i}\x00`, replacements[i]);
  }

  return result;
}

/**
 * Resolve a player name/nickname to its canonical form.
 * Handles case-insensitivity and punctuation normalization
 * (e.g., "A.J. Brown" vs "AJ Brown").
 *
 * @param {string} name — e.g. "LeBron", "LBJ", "CP3"
 * @returns {string} — e.g. "LeBron James"
 */
function normalizePlayer(name) {
  if (!name || typeof name !== 'string') return name || '';
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const key = trimmed.toLowerCase();
  if (playerIndex[key]) return playerIndex[key];
  // Try stripping periods for punctuation variants (A.J. -> AJ)
  const noDots = key.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  if (noDots !== key && playerIndex[noDots]) return playerIndex[noDots];
  return trimmed;
}

/**
 * Reload mappings from disk (useful if teams.json is updated).
 */
function reloadMappings() {
  aliasIndex = loadTeamMappings();
  playerIndex = loadPlayerMappings();
}

module.exports = { normalizeTeam, normalizeDescription, normalizePlayer, reloadMappings };
