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
// Leagues we actually carry team-name mappings for — the top-level keys of
// teams.json, upper-cased (today: {NBA, NFL, MLB, NHL}). normalizeDescription
// only expands nickname aliases when the bet's declared sport is one of these,
// so a KBO/KHL/NPB slip is never rewritten with a wrong same-nickname US team
// (see shouldExpandAliases). Populated by loadTeamMappings (init + reload).
let mappedLeagues = new Set();
// Regex matching any modeled league CODE as a whole word, derived from
// mappedLeagues. Used by shouldExpandAliases so a declared sport like "NBA",
// "NBA Basketball" or "MLB/NHL" qualifies while "KBO"/"Soccer"/"NCAAF" do not.
let modeledLeagueCodeRe = /(?!)/; // never-match until loadTeamMappings runs
// Generic sport NAMES + full league names that denote a modeled league in this
// system, keyed by league code so the set tracks mappedLeagues. detectSport/LLM
// usually emit CODES, but a non-canonical NAME like "Baseball" does reach
// bet.sport (it appears in the live pool — see tests/s1b-measure-fixture.test.js),
// and the exact-code gate alone would drop its canonicalization. Matched EXACTLY
// (upper-cased), so qualified FOREIGN variants ("Korean Baseball", "American
// Football") never match — only the bare US-major-league sense does.
// NOTE: bare "FOOTBALL" is deliberately OMITTED — globally it usually means
// soccer, which this system labels "Soccer"/"EPL"/… (never "Football"); mapping it
// to NFL would risk corrupting a soccer slip (the exact bug class we're fixing).
// The unambiguous full names ("American Football", "National Football League")
// are safe. "NFL Football" still expands via the whole-word \bNFL\b code match.
const LEAGUE_NAME_ALIASES = {
  NBA: ['BASKETBALL', 'NATIONAL BASKETBALL ASSOCIATION'],
  NFL: ['AMERICAN FOOTBALL', 'NATIONAL FOOTBALL LEAGUE'],
  MLB: ['BASEBALL', 'MAJOR LEAGUE BASEBALL'],
  NHL: ['HOCKEY', 'ICE HOCKEY', 'NATIONAL HOCKEY LEAGUE'],
};
let modeledLeagueNames = new Set(); // built from LEAGUE_NAME_ALIASES ∩ mappedLeagues

function loadTeamMappings() {
  const raw = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
  // Capture the set of leagues we model (teams.json keys) so normalizeDescription
  // can refuse to rewrite team text for leagues we DON'T model, whose nicknames
  // collide with these (e.g. KBO "Hanwha Eagles" vs NFL "Philadelphia Eagles").
  mappedLeagues = new Set(Object.keys(raw).map((k) => k.trim().toUpperCase()));
  const codes = [...mappedLeagues].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  modeledLeagueCodeRe = codes.length ? new RegExp(`\\b(?:${codes.join('|')})\\b`) : /(?!)/;
  modeledLeagueNames = new Set(
    [...mappedLeagues].flatMap((code) => LEAGUE_NAME_ALIASES[code] || [])
  );
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

// KBO corporate sponsors that prefix a club's nickname: "Hanwha Eagles",
// "Samsung Lions", "KT Wiz", "SSG Landers", "NC Dinos", "Doosan Bears", etc.
// A team nickname immediately preceded by one of these (sponsor + horizontal
// whitespace) is the Korean club, NEVER the same-named US team — so we suppress
// its expansion regardless of the declared sport. This is the sport-INDEPENDENT
// backstop for the bare-text path, where detectSport mislabels "Hanwha Eagles" as
// NFL (because "eagles" is an NFL nickname) and shouldExpandAliases would
// otherwise let it through. "[^\S\n]+$" requires SAME-LINE whitespace (space/tab,
// but NOT a newline), so the guard binds a sponsor only to a nickname on its own
// line — a bare sponsor token ending one leg never reaches across a line break to
// guard the next leg's US team ("KT\nLions ML" → Lions still expands). A
// comma-separated "NC, Kings" is likewise not guarded.
const KBO_SPONSOR_PREFIX = /\b(?:hanwha|samsung|lg|lotte|doosan|kia|ssg|kt|nc|kiwoom)[^\S\n]+$/i;
const ZERO_WIDTH = /[​‌‍﻿ ]/g;

/**
 * True when the alias match starting at `offset` in `result` is immediately
 * preceded by a KBO sponsor corporate name (so it's a Korean club, not a US team).
 */
function hasSponsorPrefix(result, offset) {
  const before = result.slice(Math.max(0, offset - 16), offset).replace(ZERO_WIDTH, ' ');
  return KBO_SPONSOR_PREFIX.test(before);
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

// Non-committal sport labels: the parser couldn't (or didn't) commit to a league.
// detectSport (services/ai.js) returns the literal 'Unknown' for abbreviation /
// slang / player-prop text ("LAL -3.5 vs GSW", "SGA over 30"), and missing values
// arrive null/empty. These carry NO league signal, so we keep main's behavior and
// EXPAND — suppressing here would silently drop canonicalization for that very
// common class (a real regression vs main). Only a CONFIDENTLY non-modeled league
// string (KBO, KHL, NPB, Soccer, Tennis, NCAAF, …) suppresses.
const SPORT_PLACEHOLDERS = new Set([
  'UNKNOWN', 'UNK', 'N/A', 'NA', '?', 'TBD', 'NONE', 'NULL', '-', 'PENDING', 'UNDETERMINED',
]);

// Per-element check shared by shouldExpandAliases and
// declaresOnlyUnmodeledLeagues: true when a single declared-sport element
// CONFIDENTLY names a league/sport we do NOT model — it is not a non-committal
// placeholder, not a generic/full NAME for a modeled league, and contains no
// modeled league CODE as a whole word. "KBO"/"KHL"/"SOCCER"/"KOREAN BASEBALL"
// are unmodeled; "UNKNOWN", "BASEBALL", "MLB", "NBA BASKETBALL" are not.
function isUnmodeledSportPart(p) {
  return !(SPORT_PLACEHOLDERS.has(p) || modeledLeagueNames.has(p) || modeledLeagueCodeRe.test(p));
}

/**
 * Decide whether normalizeDescription may expand nickname aliases for a bet
 * whose declared/contextual sport is `declaredSport`.
 *
 * We only carry team-name mappings for the leagues in teams.json (NBA/NFL/MLB/
 * NHL). When a slip declares a league we DON'T model (KBO, KHL, NPB, soccer,
 * tennis, …), a bare nickname like "Eagles" / "Lions" / "Twins" / "Giants" is a
 * club in THAT league (Hanwha Eagles, Samsung Lions — KBO), not the Philadelphia
 * Eagles / Detroit Lions — so expanding it splices a real, wrong US team into the
 * description (incident 2026-06-11, ingest disc_1514481735335805030). For those
 * leagues we suppress expansion entirely and leave the raw text for the validator
 * and graders downstream.
 *
 * The gate is conservative — it only SUPPRESSES, never adds, expansion, and only
 * when CONFIDENT the sport is a real league we don't model. It EXPANDS (preserving
 * main's behavior) when:
 *   • declaredSport is absent/empty/null (no context), OR
 *   • it is a non-committal placeholder ('Unknown', 'N/A', … — detectSport's
 *     'Unknown' is the dominant real value and must keep expanding), OR
 *   • it names a modeled league — either a teams.json league CODE appears as a
 *     whole word ("NBA", "NBA Basketball", "MLB" all qualify; "WNBA"/"NCAAF"/
 *     "NCAAB" do NOT, since those teams aren't in teams.json and collide), or it
 *     is a generic/full league NAME for a modeled league ("Baseball", "Major
 *     League Baseball" — see LEAGUE_NAME_ALIASES; foreign-qualified variants like
 *     "Korean Baseball" do not match).
 *
 * Compound declarations (e.g. "MLB/NHL", mirroring validateLegSportConsistency
 * which treats the declared sport as a set split on / & ,) expand only when EVERY
 * part qualifies; a mix like "MLB/KBO" suppresses so the KBO leg can't be corrupted.
 *
 * @param {string} [declaredSport]
 * @returns {boolean}
 */
function shouldExpandAliases(declaredSport) {
  if (declaredSport == null) return true;
  const whole = String(declaredSport).trim().toUpperCase();
  if (!whole) return true;
  // Check the whole label against placeholders / multi-word league names BEFORE
  // splitting, so "N/A" (which contains the compound separator "/") and
  // "MAJOR LEAGUE BASEBALL" aren't split into meaningless parts.
  if (SPORT_PLACEHOLDERS.has(whole) || modeledLeagueNames.has(whole)) return true;
  const parts = whole.split(/[/&,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return !parts.some(isUnmodeledSportPart);
}

/**
 * True when the declared sport CONFIDENTLY names ONLY leagues/sports we don't
 * model — every element of the declaration (split on / & , exactly like
 * validateLegSportConsistency's declared-sport set) is a real league label
 * that maps to no teams.json league ("KBO", "KHL", "NPB", "Soccer",
 * "Korean Baseball", compounds like "KBO/KHL", …).
 *
 * Used by validateLegSportConsistency (services/ai.js) to SKIP leg-team
 * validation for such declarations: our team data covers only modeled leagues,
 * so a nickname hit under an unmodeled declaration can only be a same-nickname
 * collision with a foreign club ("Eagles" → NFL vs KBO Hanwha Eagles) — a
 * structural false positive. Live repro: ingest disc_1514481735335805030
 * (declared "KBO", "Hanwha Eagles +1.5 / SSG Landers +1.5 / Samsung Lions ML")
 * was re-dropped VALIDATOR_SPORT_MISMATCH on every hold-recovery retry.
 *
 * Deliberately conservative — false (validation proceeds) when:
 *   • declaredSport is absent/empty (no signal), or
 *   • any element is a non-committal placeholder ("Unknown", "N/A", … — the
 *     same set shouldExpandAliases treats as no-signal), or
 *   • any element names a modeled league by CODE or NAME ("MLB/KBO";
 *     generic "Baseball" counts as modeled, mirroring shouldExpandAliases).
 *
 * Quantifier duality with shouldExpandAliases (same canonicalization, same
 * per-element predicate): alias expansion is suppressed when ANY element is
 * unmodeled; leg-team validation is skipped only when EVERY element is.
 *
 * @param {string} [declaredSport]
 * @returns {boolean}
 */
function declaresOnlyUnmodeledLeagues(declaredSport) {
  if (declaredSport == null) return false;
  const whole = String(declaredSport).trim().toUpperCase();
  if (!whole) return false;
  // Whole-label pre-check BEFORE splitting (mirrors shouldExpandAliases): "N/A"
  // contains the separator "/" and "MAJOR LEAGUE BASEBALL" is a single name.
  if (SPORT_PLACEHOLDERS.has(whole) || modeledLeagueNames.has(whole)) return false;
  const parts = whole.split(/[/&,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(isUnmodeledSportPart);
}

/**
 * True when the declared sport carries NO league signal — it is null/empty or a
 * non-committal placeholder (one of SPORT_PLACEHOLDERS: 'Unknown', 'N/A', 'TBD',
 * …). detectSport (services/ai.js) emits the literal 'Unknown' for abbreviation/
 * slang/player-prop text, so this is the dominant "no declared sport" value.
 *
 * Used by validateLegSportConsistency to decide when a single-sport leg signal
 * may be ADOPTED as the parlay's sport rather than dropped: a placeholder has no
 * declared sport X for a leg's team to contradict, so the wrong-sport DROP path
 * is structurally inapplicable. NARROWER than `!declaresOnlyUnmodeledLeagues`: a
 * real unmodeled league ("Soccer", "KBO") is not a placeholder (it already
 * short-circuits to valid earlier), nor is a modeled league ("MLB").
 *
 * @param {string} [declaredSport]
 * @returns {boolean}
 */
function isSportPlaceholder(declaredSport) {
  if (declaredSport == null) return true;
  const whole = String(declaredSport).trim().toUpperCase();
  if (!whole) return true;
  return SPORT_PLACEHOLDERS.has(whole);
}

/**
 * Scan a bet description and replace any known team aliases
 * with their canonical names. Preserves the rest of the text.
 *
 * Uses longest-match-first to avoid partial replacements
 * (e.g., "golden state" matches before "state").
 *
 * @param {string} text — e.g. "LAL -3.5 vs GSW"
 * @param {string} [declaredSport] — the bet's declared/contextual sport. When it
 *   names a league we don't model (KBO, KHL, …) alias expansion is suppressed and
 *   `text` is returned byte-identical (see shouldExpandAliases). Omitted/empty →
 *   expand as before.
 * @returns {string} — e.g. "Los Angeles Lakers -3.5 vs Golden State Warriors"
 */
function normalizeDescription(text, declaredSport) {
  if (!text || typeof text !== 'string') return text || '';
  // Unmodeled-league slip → never rewrite team text; leave it raw for downstream.
  if (!shouldExpandAliases(declaredSport)) return text;

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
      // Sponsor-prefix guard (sport-independent): a nickname right after a KBO
      // sponsor name ("Hanwha Eagles", "Samsung Lions", "KT Wiz") is the Korean
      // club, never the US team — never expand it, even if detectSport mislabeled
      // the bet as a modeled US league on the bare-text path.
      if (hasSponsorPrefix(result, offset)) return match;
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

module.exports = { normalizeTeam, normalizeDescription, normalizePlayer, reloadMappings, declaresOnlyUnmodeledLeagues, isSportPlaceholder };
