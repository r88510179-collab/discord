// ═══════════════════════════════════════════════════════════
// Team & Player Name Normalization
// Resolves aliases ("LAL", "Dubs", "Sixers") to canonical
// names ("Los Angeles Lakers", "Golden State Warriors",
// "Philadelphia 76ers") before database insertion.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TEAMS_PATH = path.join(__dirname, '..', 'data', 'mappings', 'teams.json');

// ── Build lookup index: alias (lowercase) → canonical name ──
let aliasIndex = {};

function loadTeamMappings() {
  const raw = JSON.parse(fs.readFileSync(TEAMS_PATH, 'utf-8'));
  const index = {};

  for (const [league, teams] of Object.entries(raw)) {
    for (const [canonical, aliases] of Object.entries(teams)) {
      // Index the canonical name itself
      index[canonical.toLowerCase()] = canonical;
      for (const alias of aliases) {
        index[alias.toLowerCase()] = canonical;
      }
    }
  }

  return index;
}

// Load once at module init
aliasIndex = loadTeamMappings();

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

  // Sort aliases by length descending so longer matches take priority
  const sortedAliases = Object.keys(aliasIndex).sort((a, b) => b.length - a.length);

  let result = text;
  for (const alias of sortedAliases) {
    // Only replace whole-word matches (word boundary)
    // Escape regex special chars in alias
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (regex.test(result)) {
      result = result.replace(regex, aliasIndex[alias]);
    }
  }

  return result;
}

/**
 * Normalize a player name. Currently a pass-through with
 * basic cleanup — can be extended with a player mappings file.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizePlayer(name) {
  if (!name || typeof name !== 'string') return name || '';
  // Basic cleanup: trim, collapse whitespace, title-case
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Reload mappings from disk (useful if teams.json is updated).
 */
function reloadMappings() {
  aliasIndex = loadTeamMappings();
}

module.exports = { normalizeTeam, normalizeDescription, normalizePlayer, reloadMappings };
