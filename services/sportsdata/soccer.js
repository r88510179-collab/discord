// services/sportsdata/soccer.js
// ESPN soccer public API adapter — MATCH-LEVEL markets only — free, no auth.
// Endpoint family: site.api.espn.com/apis/site/v2/sports/soccer/<slug>/
//
// SCOPE (this pass): team ML (treated as the 3-way win — draw loses), draw,
// double chance, full-time totals O/U, half totals, team-total goals,
// spread/handicap (whole + half lines), BTTS. Slug is fifa.world ONLY (the
// 2026 World Cup backlog). EXCLUDED → fall through {resolved:false,...}, never
// error: ANY player prop (goalscorer / to score / assist / shots / saves /
// cards / corners), draw-no-bet, 2-Up / early-payout cashout overlays, quarter
// (Asian split) handicaps, and bare totals with no resolvable team.
//
// Contract (matches services/sportsdata/index.js):
//   { resolved:true, status, evidence, source:'espn_soccer', match_id }  |
//   { resolved:false, reason, match_id? }
//   status ∈ WIN | LOSS | PUSH | VOID
// A false grade is worse than a pending: on ANY ambiguity (unmatched team,
// missing score, >1 candidate match, unparseable line, unknown market) we fall
// through. We never grade a match that is not final (→ match_not_final).
//
// ── GOTCHA #1 (mandatory) ────────────────────────────────────────────────────
// Decide W/L/D from competitors[].winner + status.type, NEVER from score
// equality. A penalty-decided match shows EQUAL competitors[].score (the
// shootout is not folded into the score) but sets winner:true on the shootout
// winner. Score-equality would mis-call it a draw and flip ML / 3-way / double
// chance. Verified live (2022 WC final 633850: ARG score "3" winner:true,
// FRA score "3" winner:false, status STATUS_FINAL_PEN). Totals / team totals /
// BTTS use competitors[].score (regulation + ET, shootout excluded).

const TIMEOUT_MS = 8000;
const DEFAULT_SLUG = 'fifa.world';

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ESPN soccer API HTTP ${res.status}`);
  return res.json();
}

// ── text normalization ───────────────────────────────────────────────────────
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Strip diacritics so "Côte d'Ivoire" matches "cote divoire".
function deburr(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Collapse to lowercase alphanumerics + single spaces (for whole-word team
// matching). Punctuation/hyphens → spaces, so "Bosnia-Herzegovina" → "bosnia
// herzegovina". NOTE: this mangles decimal lines ("+0.5" → "0 5"), so LINES are
// always parsed from the raw lowercased description, never from this form.
function norm(s) {
  return deburr(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Whole-word / whole-phrase containment in a normalized haystack.
function hasToken(hayNorm, needleNorm) {
  if (!needleNorm) return false;
  return (` ${hayNorm} `).includes(` ${needleNorm} `);
}

// ── National-team aliases (bettor shorthand → ESPN displayName) ───────────────
// Supplements the direct displayName/shortDisplayName/abbreviation match for the
// nations whose common shorthand diverges from ESPN's label. Unlisted nations
// still match via their own ESPN names; an unmatched team → no_match_found (safe
// fall-through), never a guess.
const TEAM_ALIASES = {
  'usa': 'United States', 'us': 'United States', 'united states': 'United States',
  'usmnt': 'United States', 'america': 'United States',
  'south korea': 'Korea Republic', 'korea': 'Korea Republic', 's korea': 'Korea Republic',
  'north korea': 'Korea DPR', 'n korea': 'Korea DPR',
  'iran': 'IR Iran',
  'ivory coast': "Côte d'Ivoire", 'cote divoire': "Côte d'Ivoire",
  'bosnia': 'Bosnia-Herzegovina', 'bosnia and herzegovina': 'Bosnia-Herzegovina',
  'bosnia herzegovina': 'Bosnia-Herzegovina', 'herzegovina': 'Bosnia-Herzegovina',
  'czech republic': 'Czechia', 'czech': 'Czechia',
  'cape verde': 'Cabo Verde',
  'holland': 'Netherlands',
  'dr congo': 'DR Congo', 'congo dr': 'DR Congo', 'democratic republic of congo': 'DR Congo',
  'macedonia': 'North Macedonia',
  'saudi': 'Saudi Arabia', 'ksa': 'Saudi Arabia',
  'uae': 'United Arab Emirates',
  'turkey': 'Türkiye', 'turkiye': 'Türkiye',
  'trinidad': 'Trinidad and Tobago',
  'new zealand': 'New Zealand', 'nz': 'New Zealand',
  'south africa': 'South Africa', 'rsa': 'South Africa',
};
// Normalized alias → normalized canonical, precomputed.
const ALIAS_PAIRS = Object.entries(TEAM_ALIASES).map(([a, c]) => [norm(a), norm(c)]);

function ymdToEspnDate(ymd) {
  return ymd.replace(/-/g, ''); // 2026-06-12 → 20260612
}

function shiftYMD(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// All identity strings (normalized) for a team object: full names + abbreviation
// (≥3 chars, to avoid 2-letter collisions). Works for both scoreboard
// competitors (competitor.team) and summary rosters (roster.team).
function teamIdentity(t) {
  t = t || {};
  const out = new Set();
  for (const v of [t.displayName, t.shortDisplayName, t.name, t.location]) {
    const n = norm(v);
    if (n) out.add(n);
  }
  const ab = norm(t.abbreviation);
  if (ab && ab.length >= 3) out.add(ab);
  return [...out];
}
function competitorIdentity(competitor) {
  return teamIdentity(competitor.team || {});
}
// Does a (normalized) subject string name this team, whole-word, incl. aliases?
// Used by the goalkeeper-saves path to resolve "<Team> Goalkeeper" → that team's
// roster. subjNorm is the prop subject (e.g. "qatar"), already norm()'d.
function teamMatchesSubject(team, subjNorm) {
  const ids = teamIdentity(team);
  for (const s of ids) if (hasToken(subjNorm, s)) return true;
  for (const [aliasN, canonN] of ALIAS_PAIRS) {
    if (ids.includes(canonN) && hasToken(subjNorm, aliasN)) return true;
  }
  return false;
}

// Does this competitor's team appear (whole-word) in the description?
function competitorNamed(descNorm, competitor) {
  const ids = competitorIdentity(competitor);
  for (const s of ids) if (hasToken(descNorm, s)) return true;
  for (const [aliasN, canonN] of ALIAS_PAIRS) {
    if (ids.includes(canonN) && hasToken(descNorm, aliasN)) return true;
  }
  return false;
}

// How many times this competitor is named in the description (whole-word, across
// all identity strings + aliases). Used to pick the subject when BOTH teams are
// named: in "Paraguay vs USA, USA -1.5" the PICK team is the repeated one, so the
// team with the higher count is the subject; a tie (each named once) is ambiguous.
function competitorMentionCount(descNorm, competitor) {
  const ids = competitorIdentity(competitor).slice();
  for (const [aliasN, canonN] of ALIAS_PAIRS) {
    if (ids.includes(canonN)) ids.push(aliasN);
  }
  const padded = ` ${descNorm} `;
  const positions = new Set();
  for (const s of ids) {
    if (!s) continue;
    const needle = ` ${s} `;
    let i = padded.indexOf(needle);
    while (i !== -1) { positions.add(i); i = padded.indexOf(needle, i + 1); }
  }
  return positions.size;
}

function getCompetition(event) {
  return event && event.competitions && event.competitions[0];
}

// Fetch the day's slate of events across dateYMD ± 1 (TZ slack), de-duplicated by
// id. Returns { events, anyFetchError }. Shared by the match-level resolver and
// the player-prop resolver so both query the SAME slate (no duplication).
async function fetchSlateEvents(dateYMD, slug) {
  const seen = new Set();
  const events = [];
  let anyFetchError = false;
  for (const delta of [0, -1, 1]) {
    const day = shiftYMD(dateYMD, delta);
    let data;
    try {
      data = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymdToEspnDate(day)}`);
    } catch (_) { anyFetchError = true; continue; }
    for (const ev of (data && data.events) || []) {
      if (ev && ev.id != null && !seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
    }
  }
  return { events, anyFetchError };
}

// Resolve the single match the description refers to, across dateYMD ± 1 (TZ
// slack). Returns { event, comp, matched } or a { reason } fall-through.
// `matched` is the list of competitors named in the description.
async function resolveMatch(descNorm, dateYMD, slug) {
  const { events, anyFetchError } = await fetchSlateEvents(dateYMD, slug);

  const candidates = [];
  for (const ev of events) {
    const comp = getCompetition(ev);
    const competitors = (comp && comp.competitors) || [];
    if (competitors.length !== 2) continue; // match-level needs exactly two sides
    const matched = competitors.filter(c => competitorNamed(descNorm, c));
    if (matched.length >= 1) candidates.push({ event: ev, comp, matched });
  }

  if (candidates.length === 0) {
    // Build 1c — distinguish an EMPTY slate (ESPN returned nothing across dateYMD±1:
    // transient empty-200, genuinely empty day, or an out-of-window advance bet) from
    // a populated slate where no event names the team. Only the truly-empty case gets
    // the distinct `slate_empty`; a populated-but-unmatched slate stays `no_match_found`.
    // Relabel only — the fall-through outcome (which bets resolve) is unchanged.
    if (events.length === 0) return { reason: anyFetchError ? 'fetch_error' : 'slate_empty' };
    return { reason: 'no_match_found' };
  }
  if (candidates.length > 1) return { reason: 'no_match_found' }; // ambiguous → never guess
  return candidates[0];
}

// ── outcome primitives from a resolved competition ───────────────────────────
function readScores(comp) {
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1];
  const homeScore = parseInt(home && home.score, 10);
  const awayScore = parseInt(away && away.score, 10);
  // GOTCHA #1: winner is the competitor flagged winner:true, NOT the higher
  // score (penalty shootouts have equal scores). null ⇒ a genuine draw.
  const winner = competitors.find(c => c.winner === true) || null;
  return { home, away, homeScore, awayScore, winner };
}

// Half goals from competitors[].linescores[period].value. The fifa.world
// scoreboard endpoint omits linescores in production, so half markets fall
// through there; this path is exercised by tests and stays correct if ESPN ever
// includes them. period 0 = 1st half, 1 = 2nd half.
function halfTotal(comp, period) {
  const competitors = comp.competitors || [];
  let sum = 0;
  for (const c of competitors) {
    const ls = c.linescores;
    if (!Array.isArray(ls) || !ls[period] || ls[period].value == null) return null;
    const v = Number(ls[period].value);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

function ok(status, evidence, matchId) {
  return { resolved: true, status, evidence, source: 'espn_soccer', match_id: matchId };
}
function no(reason, matchId) {
  const r = { resolved: false, reason };
  if (matchId != null) r.match_id = matchId;
  return r;
}

// §9 event_date write-back: attach the matched ESPN event's OWN authoritative date
// (event.date / found.ev.date, ISO-UTC — distinct from the queried slate day) to a
// RESOLVED verdict so the grader can heal a NULL event_date. Additive + null-safe:
// only decorates {resolved:true} results, never the {resolved:false} no() fall-throughs.
function withEventDate(result, isoDate) {
  if (result && result.resolved === true && isoDate) return { ...result, eventDate: isoDate };
  return result;
}

// Build 1c — additive market-class tag. The mode router (index.js routeSoccer)
// gates the MATCH-LEVEL path and the PROP path independently, so every result must
// carry which path produced it. Default-tag the result `cls` unless it already
// self-identified (the prop path tags itself 'prop' at the fork). Pure + additive:
// the existing {resolved,status,reason,source,evidence,match_id} shape is preserved
// — only the marketClass field is added. ok()/no()/settleOverUnder are shared by
// both paths, so the tag is applied at the gradeSoccerBet boundary, never inside
// the settlement helpers.
function tagClass(result, cls) {
  if (!result || typeof result !== 'object') return result;
  if (result.marketClass) return result;
  return { ...result, marketClass: cls };
}

// Parse an over/under line: direction + numeric threshold. Reads the RAW lower
// description (norm() would destroy the decimal).
function parseTotalLine(descLower) {
  const m = descLower.match(/\b(over|under|o|u)\b\s*(\d*\.?\d+)/i)
        || descLower.match(/\b(over|under|o|u)(\d*\.?\d+)/i);
  if (!m) return null;
  const direction = m[1].toLowerCase().startsWith('o') ? 'over' : 'under';
  const line = parseFloat(m[2]);
  if (!Number.isFinite(line)) return null;
  return { direction, line };
}

function settleOverUnder(value, direction, line, label, matchId) {
  let status;
  if (value === line) status = 'PUSH';
  else if (direction === 'over') status = value > line ? 'WIN' : 'LOSS';
  else status = value < line ? 'WIN' : 'LOSS';
  return ok(status, `${label}: ${value}, ${direction} ${line}.`, matchId);
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER PROPS (additive — Build 1b, SHADOW-gated by the same SOCCER_GRADER_MODE)
// ───────────────────────────────────────────────────────────────────────────
// CONFIRMED ESPN summary fields (recon vs live 2026 WC, 44 completed matches):
//   shots → totalShots, shots-on-target → shotsOnTarget, GK saves → saves
//   (present only on goalkeepers), goalscorer/assist → keyEvents[].scoringPlay
//   + participants[0]=scorer / participants[1]=assist (both invariants 44/44 &
//   22/22). Own goals have scoringPlay==true (type.id 97) → MUST be excluded;
//   penalties (type.id 98) DO count. keyEvents are complete vs the scoreline
//   (44/44) — we still guard on a mismatch (data gap → fall through).
//
// Player props need the SUMMARY endpoint, not the scoreboard. Most prop legs
// (graded independently, see grading.js gradeParlay) name ONLY the player, so we
// resolve the match player-first: scan the day's completed events for a UNIQUE
// roster match. A named opponent ("... (vs Austria)") narrows the scan but the
// safety guarantee is GLOBAL UNIQUENESS — a player/surname matching >1 athlete
// (or 0) falls through, never guesses (PR #135 surname-collision lesson).
//
// A false grade is worse than a pending: every ambiguity → {resolved:false}.
// ═══════════════════════════════════════════════════════════════════════════

const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const MAX_SLATE_SUMMARIES = 16; // bound the player-first scan (WC daily slate is small)
// Trailing generational suffixes stripped before name comparison so "Vinicius
// Jr" ↔ ESPN "Vinícius Júnior" and "Edmilson Junior" ↔ "...Júnior" match.
const NAME_SUFFIXES = new Set(['jr', 'jnr', 'junior', 'sr', 'snr', 'senior', 'ii', 'iii', 'iv']);

async function fetchSummary(eventId, slug, cache) {
  const key = String(eventId);
  if (cache && cache.has(key)) return cache.get(key);
  let data = null;
  try { data = await fetchJSON(`${SUMMARY_BASE}/${slug}/summary?event=${eventId}`); } catch (_) { data = null; }
  if (cache) cache.set(key, data);
  return data;
}

// Accent-folded, lowercased name tokens with a single trailing generational
// suffix dropped. Returns [] for empty input.
function nameTokens(s) {
  const toks = norm(s).split(' ').filter(Boolean);
  while (toks.length > 1 && NAME_SUFFIXES.has(toks[toks.length - 1])) toks.pop();
  return toks;
}

// Conservative athlete match: the query and the athlete's displayName/fullName
// must be token-subsets of one another (so "Erling Braut Haaland" ⊇ ESPN "Erling
// Haaland"), share a substantive (≥3-char) token, and agree on a surname anchor.
// A bare surname matches but is disambiguated by GLOBAL uniqueness at the call
// site (two athletes sharing it → no_unique_player), per the PR #135 lesson.
function athleteNameMatches(qTokens, athlete) {
  if (!qTokens.length || !athlete) return false;
  const qSet = new Set(qTokens);
  for (const src of [athlete.displayName, athlete.fullName]) {
    const a = nameTokens(src);
    if (!a.length) continue;
    const aSet = new Set(a);
    if (!qTokens.some(t => t.length >= 3 && aSet.has(t))) continue; // substantive overlap
    const qSubsetA = qTokens.every(t => aSet.has(t));
    const aSubsetQ = a.every(t => qSet.has(t));
    if (!qSubsetA && !aSubsetQ) continue;                            // one contains the other
    if (aSet.has(qTokens[qTokens.length - 1]) || qSet.has(a[a.length - 1])) return true; // surname anchor
  }
  return false;
}

// Numeric stat value for a roster player by ESPN stat `name`, or null if absent
// (outfield players have no `saves` stat → null → can't grade a saves prop).
function readStatRaw(player, name) {
  const stats = (player && player.stats) || [];
  for (const s of stats) {
    if (s && s.name === name) {
      const v = Number(s.value);
      return Number.isFinite(v) ? v : null;
    }
  }
  return null;
}

// Did this player take the field? appearances stat is 1 when they played, 0 for
// an unused sub; starter/subbedIn flags are the backup signal.
function playerAppeared(player) {
  if (!player) return false;
  if (player.starter === true || player.subbedIn === true) return true;
  const app = readStatRaw(player, 'appearances');
  return app != null && app >= 1;
}

function isKeeper(player) {
  const pos = (player && player.position) || {};
  if (pos.abbreviation === 'G' || pos.name === 'Goalkeeper') return true;
  return readStatRaw(player, 'saves') != null; // only goalkeepers carry the saves stat
}

// ── prop parser ──────────────────────────────────────────────────────────────
// Returns { market, threshold, subject, isTeamKeeper } for a CONFIRMED prop, or
// null (→ caller leaves the existing unsupported_market_soccer fall-through to
// catch cards/corners/bookings/bare "to score"/last-scorer). market ∈
// shots | sot | saves | anytime | first | scoreassist.
function parseSoccerProp(descRaw) {
  if (!descRaw) return null;
  // Drop parentheticals (opponent context — kept for team-filtering via descNorm)
  // and leading bullets; strip bare ±NNN odds.
  const raw = String(descRaw).replace(/\([^)]*\)/g, ' ').replace(/^[\s•*▪◦\-–—]+/, ' ');
  const low = raw.toLowerCase().replace(/[+-]\d{3,}(?![.\d])/g, ' ');

  const isTeamKeeper = /\bgoal\s*keeper\b|\bkeeper\b/.test(low);

  let market = null;
  if (/\bsaves?\b/.test(low)) market = 'saves';
  else if (/shots?\s*on\s*(?:target|goal)\b|\bsot\b|\bsog\b/.test(low)) market = 'sot';
  else if (/\bshots?\b/.test(low)) market = 'shots';
  else if (/to\s+score\s+or\s+(?:give\s+)?assist|\bscore\s+or\s+assist\b/.test(low)) market = 'scoreassist';
  else if (/first\s+goal\s*scorer/.test(low)) market = 'first';
  else if (/any\s*time\s+goal\s*scorer/.test(low)) market = 'anytime';
  if (!market) return null;

  let threshold = null;
  const ou = low.match(/\b(over|under)\s+(\d+(?:\.\d+)?)/);
  if (ou) {
    threshold = { kind: 'ou', direction: ou[1] === 'over' ? 'over' : 'under', line: parseFloat(ou[2]) };
  } else {
    const plus = low.match(/(\d+)\s*\+/) || low.match(/(\d+)\s+or\s+more/);
    if (plus) threshold = { kind: 'plus', n: parseInt(plus[1], 10) };
  }

  // Subject = the leg with every market phrase / threshold token removed.
  let name = raw
    .replace(/\b(?:over|under)\s+\d+(?:\.\d+)?/ig, ' ')
    .replace(/\d+\s*\+/g, ' ')
    .replace(/\d+\s+or\s+more/ig, ' ')
    .replace(/player\s+to\s+(?:have|record|make|get)/ig, ' ')
    .replace(/\bto\s+(?:make|have|record|get)\b/ig, ' ')
    .replace(/to\s+score\s+or\s+give\s+assist|to\s+score\s+or\s+assist|score\s+or\s+assist/ig, ' ')
    .replace(/any\s*time\s+goal\s*scorer|first\s+goal\s*scorer|goal\s*scorer/ig, ' ')
    .replace(/shots?\s*on\s*(?:target|goal)|\bsot\b|\bsog\b|total\s+shots?|shots?/ig, ' ')
    .replace(/total\s+saves?|saves?/ig, ' ')
    .replace(/\bgoal\s*keeper\b|\bkeeper\b/ig, ' ')
    .replace(/\bplayer\b/ig, ' ')
    .replace(/[•*▪◦]/g, ' ')
    .replace(/\s*[-–—:]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // No subject left (e.g. a team/match "Over 9.5 Shots on Target" total, not a
  // player prop) → return null so the unsupported fall-through handles it.
  if (!name) return null;

  return { market, threshold, subject: name, isTeamKeeper };
}

// ── summary readers ──────────────────────────────────────────────────────────
function summaryHeaderComp(summary) {
  const comps = (summary && summary.header && summary.header.competitions) || [];
  return comps[0] || null;
}
function summaryCompleted(summary) {
  const c = summaryHeaderComp(summary);
  const st = (c && c.status && c.status.type) || {};
  return st.completed === true;
}
function scorelineTotal(summary) {
  const c = summaryHeaderComp(summary);
  const cs = (c && c.competitors) || [];
  if (cs.length < 2) return null;
  let total = 0;
  for (const x of cs) {
    const v = parseInt(x && x.score, 10);
    if (!Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}
function isOwnGoalEvent(e) {
  const t = (e && e.type) || {};
  return t.id === '97' || t.type === 'own-goal' || /own\s*goal/i.test(t.text || '');
}
function participantAthleteId(e, i) {
  const p = (e && e.participants) || [];
  return p[i] && p[i].athlete && p[i].athlete.id != null ? p[i].athlete.id : null;
}
function clockValue(e) {
  const v = Number(e && e.clock && e.clock.value);
  return Number.isFinite(v) ? v : Infinity;
}

// Find the unique roster player a prop names within ONE event's rosters.
// Returns { player } | { ambiguous:true } | {} (not found here).
function findPlayerInRosters(prop, rosters) {
  rosters = rosters || [];
  if (prop.isTeamKeeper) {
    const subjNorm = norm(prop.subject);
    if (!subjNorm) return {};
    const teamRosters = rosters.filter(r => r && teamMatchesSubject(r.team, subjNorm));
    if (teamRosters.length !== 1) return {};                       // team not uniquely on this card
    const keepers = (teamRosters[0].roster || []).filter(p => isKeeper(p) && playerAppeared(p));
    if (keepers.length > 1) return { ambiguous: true };            // ≥2 keepers played → don't guess
    if (keepers.length === 1) return { player: keepers[0] };
    return {};
  }
  const qTokens = nameTokens(prop.subject);
  if (!qTokens.length) return {};
  const hits = [];
  for (const r of rosters) {
    for (const p of (r.roster || [])) {
      if (athleteNameMatches(qTokens, p.athlete)) hits.push(p);
    }
  }
  const ids = new Set(hits.map(h => h.athlete && h.athlete.id));
  if (ids.size > 1) return { ambiguous: true };
  if (ids.size === 1) return { player: hits[0] };
  return {};
}

// Scan a list of events for the prop's player. Returns { ambiguous:eventId } on a
// within-event collision, else { found, foundCount, summaryFetchError }. fetchSummary
// caches per call so a re-scan over a superset re-fetches nothing.
async function scanSlateForPlayer(prop, eventList, slug, cache) {
  let found = null, foundCount = 0, summaryFetchError = false;
  for (const ev of eventList) {
    const summary = await fetchSummary(ev.id, slug, cache);
    if (!summary) { summaryFetchError = true; continue; } // a failed fetch could HIDE the player
    const res = findPlayerInRosters(prop, summary.rosters);
    if (res.ambiguous) return { ambiguous: ev.id };       // collision within one event
    if (res.player) { foundCount++; found = { ev, summary, player: res.player }; }
  }
  return { found, foundCount, summaryFetchError };
}

// Player-first match resolution + settle, for a CONFIRMED prop.
async function gradeSoccerProp(prop, descNorm, dateYMD, slug, cache) {
  const { events, anyFetchError } = await fetchSlateEvents(dateYMD, slug);
  // Build 1c — empty slate is `slate_empty`, NOT `no_match_found`: it means ESPN
  // gave us nothing (transient empty-200 / empty day / out-of-window advance bet),
  // which is categorically different from "match resolved but the player didn't
  // match." Keeping them distinct is what makes the shadow prop metric readable.
  if (events.length === 0) return no(anyFetchError ? 'fetch_error' : 'slate_empty');

  // Narrow to events naming a competitor in the leg (e.g. the "(vs Austria)"
  // opponent) — this both cuts fetches and lets an annotation disambiguate a
  // cross-match name collision. A named subset that resolves the player is
  // TRUSTED (the bettor's opponent tag picks that fixture).
  const named = events.filter(ev => {
    const comp = getCompetition(ev);
    const cs = (comp && comp.competitors) || [];
    return cs.length === 2 && cs.some(c => competitorNamed(descNorm, c));
  });

  let scan;
  if (named.length) {
    scan = await scanSlateForPlayer(prop, named, slug, cache);
    // The narrowing can MISFIRE: a player-name token may coincidentally equal a
    // team name/abbrev on the slate, excluding the player's real match. If the
    // narrowed subset matched ZERO, fall back to the full slate (cache dedups
    // the already-fetched summaries) so we don't false-report player_not_found.
    if (!scan.ambiguous && scan.foundCount === 0 && events.length > named.length) {
      if (events.length > MAX_SLATE_SUMMARIES) return no('slate_too_large');
      scan = await scanSlateForPlayer(prop, events, slug, cache);
    }
  } else {
    if (events.length > MAX_SLATE_SUMMARIES) return no('slate_too_large');
    scan = await scanSlateForPlayer(prop, events, slug, cache);
  }

  if (scan.ambiguous) return no('no_unique_player', scan.ambiguous);
  const { found, foundCount, summaryFetchError } = scan;
  if (foundCount > 1) return no('no_unique_player');               // same name across two events
  if (foundCount === 0) return no(summaryFetchError ? 'fetch_error' : 'player_not_found');
  if (!summaryCompleted(found.summary)) return no('match_not_final', found.ev.id);
  // §9: decorate every prop verdict (graded + DNP-VOID, all real matched events) with
  // the matched event's authoritative date at this single boundary.
  return withEventDate(settleSoccerProp(prop, found), found.ev && found.ev.date);
}

function settleSoccerProp(prop, found) {
  const { player, summary } = found;
  const matchId = found.ev.id;
  const pname = (player.athlete && (player.athlete.displayName || player.athlete.fullName)) || prop.subject;

  // DNP → VOID. Smokke's rule (PR #128/#129): a player who did not play had NO
  // ACTION, so the prop VOIDs (stake returned), NEVER a LOSS. A VOID leg REDUCES
  // a parlay. (This is a deliberate deviation from the build prompt's literal
  // "LOSS for confirmed-in-squad-0", to stay consistent with the rest of the
  // codebase; flagged in the PR for sign-off before enforce.)
  if (!playerAppeared(player)) {
    return ok('VOID', `${pname} did not play (DNP) — no action, void.`, matchId);
  }

  if (prop.market === 'shots' || prop.market === 'sot' || prop.market === 'saves') {
    const statName = prop.market === 'shots' ? 'totalShots' : prop.market === 'sot' ? 'shotsOnTarget' : 'saves';
    const v = readStatRaw(player, statName);
    if (v == null) return no('player_stat_missing', matchId);      // e.g. saves prop on an outfielder
    if (!prop.threshold) return no('no_threshold', matchId);       // "X Shots on Target" w/ no number
    const label = `${pname} ${statName}`;
    if (prop.threshold.kind === 'plus') {
      return ok(v >= prop.threshold.n ? 'WIN' : 'LOSS', `${label}=${v}, needed ${prop.threshold.n}+.`, matchId);
    }
    return settleOverUnder(v, prop.threshold.direction, prop.threshold.line, label, matchId);
  }

  // goalscorer / score-or-assist — keyEvents.
  const scoring = (summary.keyEvents || []).filter(e => e && e.scoringPlay === true);
  const total = scorelineTotal(summary);
  if (total != null && scoring.length !== total) return no('keyevents_incomplete', matchId); // data gap
  const pid = player.athlete && player.athlete.id;
  const nonOwn = scoring.filter(e => !isOwnGoalEvent(e)); // own goals never credit a scorer/assister
  const goals = nonOwn.filter(e => participantAthleteId(e, 0) === pid).length;

  if (prop.market === 'anytime') {
    return ok(goals >= 1 ? 'WIN' : 'LOSS', `${pname} scored ${goals} goal(s) — anytime goalscorer.`, matchId);
  }
  if (prop.market === 'first') {
    if (!nonOwn.length) return no('no_regular_scorer', matchId);   // 0-0 / all own goals → don't guess
    const first = nonOwn.slice().sort((a, b) => clockValue(a) - clockValue(b))[0];
    const won = participantAthleteId(first, 0) === pid;
    return ok(won ? 'WIN' : 'LOSS', `${pname} ${won ? 'was' : 'was not'} the first goalscorer.`, matchId);
  }
  // scoreassist (default threshold 1 = binary "to score or assist")
  const assists = nonOwn.filter(e => participantAthleteId(e, 1) === pid).length;
  const n = prop.threshold && prop.threshold.kind === 'plus' ? prop.threshold.n : 1;
  const combined = goals + assists;
  return ok(combined >= n ? 'WIN' : 'LOSS', `${pname} goals=${goals}+assists=${assists}=${combined}, needed ${n}+ — score or assist.`, matchId);
}

/**
 * Grade a single match-level soccer leg/bet (untagged core).
 * @param {string} description  one pick string ("USA ML", "Over 2.5 Goals - USA vs Paraguay")
 * @param {string} dateYMD      slate date (YYYY-MM-DD); the adapter also checks ±1 day
 * @param {object} opts         { slug = 'fifa.world' }
 */
async function gradeSoccerBetImpl(description, dateYMD, opts = {}) {
  if (!description || !dateYMD) return no('bad_input');
  const slug = opts.slug || DEFAULT_SLUG;
  // Strip American/decimal odds FIRST so a price can never be parsed as a goal
  // line or total — e.g. "USA ML (-150)" / "USA ML -150" must NOT become a -150
  // handicap (which would false-LOSS every winning ML pick carrying odds). Removes
  // parenthesized prices "(-150)"/"(+120)"/"(1.91)" and bare ±NNN (3+ digits, not
  // part of a decimal); real goal lines (≤ ~9.5 — 1-2 digits or decimals like
  // -1.5) are untouched, so "USA -1.5 (-150)" still parses the -1.5 handicap.
  const descLower = String(description).toLowerCase()
    .replace(/\([+-]?\d+(?:\.\d+)?\)/g, ' ')
    .replace(/[+-]\d{3,}(?![.\d])/g, ' ');
  const descNorm = norm(description);

  // ── markets we never grade — reject BEFORE any fetch (cheap, fall through) ──
  // 2-Up / early-payout cashout overlays: the settled price ≠ the match result.
  if (/\b2[\s-]?up\b|early\s*payout|cash[\s-]?out/.test(descLower)) {
    return no('unsupported_market_soccer');
  }
  const isBtts = /both teams to score|\bbtts\b|\bgg\b\/?\bng\b/.test(descLower);

  // ── Player props (CONFIRMED markets only — Build 1b) ──
  // parseSoccerProp returns non-null ONLY for shots / shots-on-target /
  // goalkeeper-saves / anytime|first goalscorer / to-score-or-assist — the prop
  // types whose backing ESPN summary field was recon-verified present. Those get
  // real grading (player-first match resolution + summary fetch). "both teams to
  // score" contains "to score" so BTTS is detected first and skips this. Every
  // other player/side market (cards, corners, bookings, bare "to score", last
  // scorer, standalone assists) returns null here and falls through unsupported
  // below — UNCHANGED behavior.
  if (!isBtts) {
    const prop = parseSoccerProp(description);
    // Self-tag the prop path 'prop' at the fork (the only place that knows the path);
    // the public wrapper defaults everything else to 'match_level'.
    if (prop) return tagClass(await gradeSoccerProp(prop, descNorm, dateYMD, slug, new Map()), 'prop');
  }
  if (!isBtts && /(goal\s*scorer|anytime scorer|first scorer|last scorer|to score|to score or assist|\bassists?\b|shots?\s*on\s*(target|goal)|\bsot\b|\bsog\b|\bsaves?\b|\bcards?\b|booking|\bcorners?\b)/.test(descLower)) {
    return no('unsupported_market_soccer');
  }

  // ── resolve the match ──
  const resolved = await resolveMatch(descNorm, dateYMD, slug);
  if (resolved.reason) return no(resolved.reason);
  const { event, comp, matched } = resolved;
  const matchId = event.id;

  // If the description spells out a matchup ("TeamA vs TeamB") but only ONE side
  // is in the resolved event, the intended fixture is not on this slate (the
  // named opponent differs) — never grade against the wrong opponent.
  const matchupToken = /\bvs\b|\bv\b|@/.test(descLower);
  if (matchupToken && matched.length < 2) return no('no_match_found');

  // ── finality gate — never grade a match that is not final ──
  const statusType = (comp.status && comp.status.type) || (event.status && event.status.type) || {};
  if (statusType.completed !== true) return no('match_not_final', matchId);

  const { home, away, homeScore, awayScore, winner } = readScores(comp);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return no('missing_score', matchId);
  const totalGoals = homeScore + awayScore;
  const nameOf = c => (c && c.team && (c.team.displayName || c.team.shortDisplayName)) || 'team';
  const ftLine = `${nameOf(home)} ${homeScore}-${awayScore} ${nameOf(away)} (FT)`;

  // Subject = the team a single-team (asymmetric: ML / spread / team-total)
  // market is ON. One named team → it. Both named → the team mentioned MORE often
  // (the repeated pick in "Paraguay vs USA, USA -1.5"); a tie (each named once,
  // e.g. "USA vs Paraguay ML") is genuinely ambiguous → null, and the asymmetric
  // branches below fall through rather than guess (a false grade is worse than a
  // pending). Symmetric markets (draw / BTTS / game total / DC-by-code) ignore it.
  let subject;
  if (matched.length === 1) {
    subject = matched[0];
  } else {
    const ranked = matched
      .map(c => ({ c, n: competitorMentionCount(descNorm, c) }))
      .sort((a, b) => b.n - a.n);
    subject = ranked[0].n > ranked[1].n ? ranked[0].c : null;
  }
  const subjectIsHome = subject && subject.homeAway === 'home';
  const subjectScore = subjectIsHome ? homeScore : awayScore;
  const oppScore = subjectIsHome ? awayScore : homeScore;
  const subjectWon = winner != null && subject != null && winner === subject;
  const isDrawn = winner == null;
  const subjectOutcome = isDrawn ? 'draw' : (winner.homeAway === 'home' ? 'home' : 'away');

  // ── 1) BTTS ──
  if (isBtts) {
    const bothScored = homeScore >= 1 && awayScore >= 1;
    const betNo = /\bno\b/.test(descLower);
    const won = betNo ? !bothScored : bothScored;
    return withEventDate(ok(won ? 'WIN' : 'LOSS', `${ftLine}. BTTS ${betNo ? 'No' : 'Yes'} → both scored=${bothScored}.`, matchId), event.date);
  }

  // ── 2) Draw No Bet — explicitly OUT of this pass's scope → fall through ──
  if (/draw\s*no\s*bet|\bdnb\b/.test(descLower)) return no('unsupported_market_soccer', matchId);

  // ── 3) Double chance ──
  // "<Team> or Draw" / "Draw or <Team>" → covered { subjectOutcome, draw };
  // "1X"/"X2"/"12" → home-draw / draw-away / home-away codes.
  const hasDcPhrase = /double\s*chance|\bdc\b/.test(descLower);
  const dcOrDraw = /\bor\s+draw\b|\bdraw\s+or\b/.test(descLower);
  // 1X / X2 are letter-anchored codes (no collision with stray numbers). The bare
  // "12" code is pure digits → it collides with dates ("Jun 12") and stray numbers
  // (and double chance runs before ML/total/spread, so it would HIJACK them into a
  // false WIN). Honor "12" ONLY alongside an explicit "double chance"/"DC" phrase.
  let dcCode = (descLower.match(/(?:^|\s)(1x|x2)(?:\s|$)/) || [])[1] || null;
  if (!dcCode && hasDcPhrase && /(?:^|\s)12(?:\s|$)/.test(descLower)) dcCode = '12';
  if (hasDcPhrase || dcCode || dcOrDraw) {
    let covered = null;
    if (dcCode) {
      covered = dcCode === '1x' ? ['home', 'draw'] : dcCode === 'x2' ? ['draw', 'away'] : ['home', 'away'];
    } else if (dcOrDraw && subject) {
      // team-anchored double chance ("USA or Draw")
      covered = [subjectIsHome ? 'home' : 'away', 'draw'];
    }
    if (!covered) return no('ambiguous_double_chance', matchId);
    const actual = isDrawn ? 'draw' : (winner.homeAway === 'home' ? 'home' : 'away');
    const won = covered.includes(actual);
    return withEventDate(ok(won ? 'WIN' : 'LOSS', `${ftLine}. Double chance ${covered.join('/')} → ${actual}.`, matchId), event.date);
  }

  // ── 4) Draw (1X2 draw pick) ──
  if (/\bdraw\b|\btie\b/.test(descLower)) {
    return withEventDate(ok(isDrawn ? 'WIN' : 'LOSS', `${ftLine}. Result: ${isDrawn ? 'draw' : nameOf(winner) + ' win'}.`, matchId), event.date);
  }

  // ── 5) Half totals (1H/2H) — needs linescores ──
  const halfMatch = /\b(1h|first\s*half)\b/.test(descLower) ? 0
    : /\b(2h|second\s*half)\b/.test(descLower) ? 1 : null;
  if (halfMatch != null) {
    const total = parseTotalLine(descLower);
    if (!total) return no('unparseable_line', matchId);
    const hv = halfTotal(comp, halfMatch);
    if (hv == null) return no('no_linescores', matchId);
    return withEventDate(settleOverUnder(hv, total.direction, total.line, `${halfMatch === 0 ? '1H' : '2H'} goals`, matchId), event.date);
  }

  // ── 6) Team total (explicit phrasing) ──
  const total = parseTotalLine(descLower);
  if (total && /team\s*total|team\s*goals/.test(descLower)) {
    if (!subject) return no('no_subject_team', matchId);
    return withEventDate(settleOverUnder(subjectScore, total.direction, total.line, `${nameOf(subject)} team goals`, matchId), event.date);
  }

  // ── 7) Game total (over/under) — only when the match is unambiguous ──
  // Requires BOTH teams named (or an explicit matchup token). A single-team
  // "Team Over N" with no team-total phrasing is ambiguous (team vs game total)
  // → fall through.
  if (total) {
    if (matched.length === 2 || matchupToken) {
      return withEventDate(settleOverUnder(totalGoals, total.direction, total.line, 'Match goals', matchId), event.date);
    }
    return no('ambiguous_total', matchId);
  }

  // ── 8) Spread / handicap (+/- line) ──
  const spreadMatch = descLower.match(/([+-])\s*(\d*\.?\d+)/);
  if (spreadMatch) {
    if (!subject) return no('no_subject_team', matchId);
    const line = (spreadMatch[1] === '-' ? -1 : 1) * parseFloat(spreadMatch[2]);
    if (!Number.isFinite(line)) return no('unparseable_line', matchId);
    // Whole + half lines only; quarter (Asian split) lines fall through.
    if (Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) return no('unsupported_line', matchId);
    const adj = (subjectScore - oppScore) + line;
    const status = Math.abs(adj) < 1e-9 ? 'PUSH' : (adj > 0 ? 'WIN' : 'LOSS');
    return withEventDate(ok(status, `${ftLine}. ${nameOf(subject)} ${subjectScore}-${oppScore}, line ${line > 0 ? '+' : ''}${line}.`, matchId), event.date);
  }

  // ── 9) Moneyline / to win (bare ML = 3-way win; draw loses) ──
  if (/\bml\b|money\s*line|\bto win\b/.test(descLower)) {
    if (!subject) return no('no_subject_team', matchId);
    return withEventDate(ok(subjectWon ? 'WIN' : 'LOSS', `${ftLine}. ${nameOf(subject)} ${subjectWon ? 'won' : (isDrawn ? 'drew' : 'lost')}.`, matchId), event.date);
  }

  return no('unsupported_market_soccer', matchId);
}

/**
 * Public entry. Runs the grader, then tags the result with its market class so the
 * mode router (index.js routeSoccer) can gate match-level vs prop independently
 * (Build 1c). The prop path self-tags 'prop' at its fork; everything else — including
 * the bad_input guard and every match-level fall-through/verdict — defaults here to
 * 'match_level'. Additive only: no settlement, parsing, or guard logic is touched.
 */
async function gradeSoccerBet(description, dateYMD, opts = {}) {
  return tagClass(await gradeSoccerBetImpl(description, dateYMD, opts), 'match_level');
}

module.exports = {
  gradeSoccerBet,
  // exported for tests / inspection
  _internal: {
    TEAM_ALIASES, norm, competitorNamed, resolveMatch, parseTotalLine, shiftYMD,
    // player props (Build 1b)
    parseSoccerProp, nameTokens, athleteNameMatches, findPlayerInRosters,
    playerAppeared, isOwnGoalEvent, settleSoccerProp,
  },
};
