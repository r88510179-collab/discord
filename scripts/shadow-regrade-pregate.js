#!/usr/bin/env node
// scripts/shadow-regrade-pregate.js
// ═══════════════════════════════════════════════════════════
// READ-ONLY shadow regrade of pre-gate AI-graded settled bets against the
// deterministic grading layer. Input: a JSON export (array of settled bet
// rows) passed as the first CLI arg. NO DB access, NO writes anywhere —
// output is a results JSON (via --out) consumed by a human-authored
// disagreement report. Corrections are a separate operator-gated step.
//
// Usage:
//   node scripts/shadow-regrade-pregate.js <export.json> [--out results.json]
//                                          [--only id1,id2] [--limit N]
//
// What is imported vs reimplemented (import-time side-effect audit):
//   • services/espn.js               — IMPORTED (pure at require: only the
//     teamTotal leaf). Supplies the real deterministic parse + grade engine
//     (parseBetDescription, gradeFromScore, teamMatches) and the ESPN
//     scoreboard fetch (getScore).
//   • services/sportsdata/{mlb,nba,nhl}.js — IMPORTED (pure at require:
//     teamTotal + terminalState leaves only). Supply the player-prop graders
//     and the per-sport alias tables (_internal.TEAM_ALIASES).
//   • services/sportsdata/index.js   — NOT imported: its shadow paths emit
//     pipeline_events at call time via a lazy require('../bets') that loads
//     database.js (opens/migrates a DB). The tiny prop-vs-team + slate-date
//     routing it provides is reimplemented inline below.
//   • services/eventDate.js          — IMPORTED (pure, zero requires) for
//     etParts (UTC instant → ET calendar day, the slate-date convention).
//
// All network access goes through a wrapped global.fetch that (a) caches by
// URL so each scoreboard/schedule/boxscore is fetched at most once per run,
// and (b) throttles real requests to ≤3/s.
//
// Verdict model: WIN | LOSS | PUSH | UNRESOLVED(reason). Provable-absence /
// DNP VOIDs are deliberately SUPPRESSED (absenceVoidAllowed:false) because
// 489/491 rows have NULL event_date, so the slate day is created_at-derived
// and a VOID would need date certainty this audit does not have; those rows
// surface as UNRESOLVED(player_not_found_* / dnp_date_unconfirmed) instead.
// ═══════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const espn = require('../services/espn');
const mlb = require('../services/sportsdata/mlb');
const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');
const { isTeamTotalBet } = require('../services/sportsdata/teamTotal');
const { etParts } = require('../services/eventDate');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith('--'));
function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const outPath = flagVal('--out');
const onlyIds = (flagVal('--only') || '').split(',').filter(Boolean);
const limit = parseInt(flagVal('--limit') || '0', 10) || 0;

if (!inputPath) {
  console.error('Usage: node scripts/shadow-regrade-pregate.js <export.json> [--out results.json] [--only id1,id2] [--limit N]');
  process.exit(2);
}

// ── Throttled + cached fetch wrapper ────────────────────────
// Cache key = URL. Responses are materialized to text once so a cached entry
// can be json()'d any number of times (a real Response body is single-read).
// Throttle: real network requests are serialized with a ≥350ms gap (≤3/s).
const REQUEST_GAP_MS = 350;
const realFetch = global.fetch;
const fetchCache = new Map();
const stats = { apiCalls: 0, cacheHits: 0, errors: 0, byHost: {} };
let throttleChain = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

global.fetch = function cachedThrottledFetch(url, opts) {
  const key = String(url);
  if (fetchCache.has(key)) {
    stats.cacheHits++;
    return fetchCache.get(key);
  }
  const work = throttleChain.then(async () => {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    stats.apiCalls++;
    const host = key.replace(/^https?:\/\//, '').split('/')[0];
    stats.byHost[host] = (stats.byHost[host] || 0) + 1;
    const res = await realFetch(key, opts);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  });
  // Keep the throttle chain unbreakable even when a fetch rejects.
  throttleChain = work.then(() => {}, () => {});
  const wrapped = work.then(r => ({
    ok: r.ok,
    status: r.status,
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  }));
  fetchCache.set(key, wrapped);
  wrapped.catch(() => { stats.errors++; fetchCache.delete(key); });
  return wrapped;
};

// ── Date helpers (ET slate convention) ──────────────────────
function parseUtcInstant(s) {
  if (!s) return null;
  const iso = String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function etYMD(d) {
  const p = etParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}
function shiftYMD(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Anchor = event_date if present, else created_at (TEXT UTC), both resolved
// to the ET calendar day (the day the sports-data slates are keyed by).
function anchorFor(bet) {
  const src = bet.event_date || bet.created_at;
  const from = bet.event_date ? 'event_date' : 'created_at';
  const d = parseUtcInstant(src);
  return d ? { ymd: etYMD(d), from } : null;
}

// ── Per-sport plumbing ───────────────────────────────────────
const SPORTS = ['MLB', 'NBA', 'NHL'];
const ADAPTER = { MLB: mlb, NBA: nba, NHL: nhl };
const ALIAS = {
  MLB: mlb._internal.TEAM_ALIASES,
  NBA: nba._internal.TEAM_ALIASES,
  NHL: nhl._internal.TEAM_ALIASES,
};
// 'as' (Athletics) is a common English word — the alias-table scan below
// skips it on bet text (same rationale as grading.js's STOPWORD_ALIASES,
// #149). "a's"/"athletics" still match Athletics bets.
const SCAN_STOPWORDS = new Set(['as']);

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// All alias-table teams named in the description for one sport, whole-word
// matched (the adapters' canonicalize convention), deduped by canonical name,
// ordered by first appearance (slips name the picked side first — that order
// is what parseBetDescription/gradeFromScore key off via betTeams[0]).
function extractTeams(desc, sport) {
  const hits = [];
  for (const [alias, canonical] of Object.entries(ALIAS[sport])) {
    if (SCAN_STOPWORDS.has(alias)) continue;
    const m = desc.match(new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i'));
    if (m && !hits.some(h => h.canonical === canonical)) {
      hits.push({ canonical, index: m.index });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map(h => h.canonical);
}

// ── Strict prop parse + routing ─────────────────────────────
// The adapters' resolveStat() falls back to substring includes(), which can
// mis-map a stat ("3PTs" → 'pts' → points; "Points" → 'po' → MLB outs). This
// audit only trusts a prop grade when the stat text resolves by EXACT key
// (allowing a trailing plural 's') in that sport's stat/compound map — the
// exact-key hit short-circuits the adapter's loose path, so the adapter and
// this router provably resolve the same field.
function strictStat(sport, statText) {
  const key = statText.toLowerCase().replace(/\s+/g, ' ').trim();
  const keys = [key, key.replace(/s$/, '')];
  const maps = {
    MLB: [mlb._internal.STAT_MAP, mlb._internal.COMPOUND_STATS],
    NBA: [nba._internal.STAT_FIELD_MAP, nba._internal.COMPOUND_DEFS],
    NHL: [nhl._internal.STAT_MAP],
  }[sport];
  for (const m of maps) for (const k of keys) if (m[k]) return m[k];
  return null;
}

// Parse "<subject> O/U N <stat>" / "<subject> N+ <stat>" / NHL ATGS. Returns
// { player, statText, sports } where sports = the sports whose stat map
// strictly resolves statText AND whose alias table does NOT canonicalize the
// subject to a team (a team subject means team total, not player prop).
function strictPropParse(desc) {
  const d = desc.trim();
  let player = null, statText = null;
  let m = d.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/);
  if (m) { player = m[1]; statText = m[3]; }
  if (!player) {
    m = d.match(/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
    if (m) { player = m[1]; statText = m[4]; }
  }
  if (!player && /anytime\s+goal\s*scorer|atgs|any\s+time\s+goal\s*scorer/i.test(d)) {
    m = d.match(/^(.+?)\s+(?:anytime|any\s+time|atgs)/i);
    if (m) { player = m[1]; statText = 'goals'; }
  }
  if (!player || !statText) return null;
  player = player.trim();
  // Strip a trailing odds tail from the stat text ("3PTs (-155)" / "Hits -120").
  statText = statText.trim()
    .replace(/\s*\([+-]?\d+\)\s*$/, '')
    .replace(/\s+[+-]\d{3,}\s*$/, '')
    .trim();
  const sports = [];
  for (const sp of SPORTS) {
    if (!strictStat(sp, statText)) continue;
    if (ADAPTER[sp].canonicalize(player)) continue; // subject is a team there
    sports.push(sp);
  }
  return { player, statText, sports };
}

// ── Market classification ────────────────────────────────────
// Enum (report axis): ML | spread | game_total | team_total |
// mlb_prop | nba_prop | nhl_prop | multi_market | other.
// The prompt's classifier named only mlb_prop; nba_prop/nhl_prop are added
// because the export contains NBA/NHL player props (documented deviation).

// One side of an "and"/"&" compound carries a market indicator (not just a
// team name) — used to refuse true multi-market strings while letting
// "Rangers & Islanders over 5.5" (one game total) through.
function sideHasMarketIndicator(side) {
  const s = side.trim();
  if (/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/.test(s)) return true;
  if (/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)(\s+.+)?$/i.test(s)) return true;
  if (/\bml\b/i.test(s)) return true;
  if (/[+-]\d/.test(s)) return true;
  return false;
}

// Score-unit vocabulary per sport (mirrors espn.js TEAM_TOTAL_UNITS).
const SCORE_UNIT_RX = {
  MLB: /\bruns?\b/i,
  NHL: /\bgoals?\b/i,
  NBA: /\b(points?|pts)\b/i,
};

// Segment / partial-game markets can't be graded off a final score.
// (espn.js applies this only inside its team-total branch; the structured
// adapters don't guard it at all — this audit refuses them outright.)
const SEGMENT_RX = /\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|inning|innings|inn|f5|1h|2h|first\s+half|second\s+half|halftime|half|quarter|qtr|1q|2q|3q|4q|period|1p|2p|3p|thru|through)\b/i;

// A line of a multi-line message that carries a full pick: a team (in any
// sport's alias table) or a prop shape, PLUS a market indicator. Header lines
// ("NBA Plays:", capper names) and bare stake/odds lines don't count.
function lineHasPick(line) {
  const s = line.trim();
  if (!s) return false;
  if (!sideHasMarketIndicator(s)) return false;
  if (SPORTS.some(sp => extractTeams(s, sp).length > 0)) return true;
  if (/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/.test(s)) return true;
  if (/^(.+?)\s+(over|under|o|u)\s+(\d+(?:\.\d+)?)\s+(.+)$/i.test(s)) return true;
  return false;
}

function classifyMarket(desc, sport, teams) {
  const d = desc.trim();
  const dlow = d.toLowerCase();

  // Multi-pick message stored as one bet ("NBA Plays:\nPistons -3.5\nRaptors
  // +6.5"): grading any single leg of it is meaningless — refuse.
  const lines = d.split(/\n+/);
  if (lines.length >= 2 && lines.filter(lineHasPick).length >= 2) {
    return { market: 'multi_market', unresolvable: 'multi_market' };
  }

  // Multi-market compound ("Clippers ML and Kawhi Leonard 3+ 3PTs").
  const sides = d.split(/\s+(?:and|&)\s+/i);
  if (sides.length >= 2 && sides.filter(sideHasMarketIndicator).length >= 2) {
    return { market: 'multi_market', unresolvable: 'multi_market' };
  }
  // SGP-labelled strings are parlays whatever bet_type says — refuse.
  if (/\bsgp\b/i.test(dlow)) return { market: 'other', unresolvable: 'sgp_description' };

  // Player prop (strict stat routing).
  const prop = strictPropParse(d);
  if (prop && prop.sports.length) return { market: 'prop', prop };

  if (SEGMENT_RX.test(dlow)) return { market: 'other', unresolvable: 'segment_market' };

  // The real deterministic parser.
  const parsed = espn.parseBetDescription(d, teams, sport);
  if (parsed.type === 'team_total') return { market: 'team_total', parsed };
  if (parsed.type === 'total') {
    // CRITICAL guard (b6065d701c class): an explicit team-total keyword must
    // NEVER be graded with game-total math. espn.parseBetDescription's TT
    // branch already returned team_total for the gradeable subset; reaching
    // 'total' with a TT keyword means the TT guards failed — refuse.
    if (isTeamTotalBet(d)) return { market: 'team_total', unresolvable: 'team_total_guard_refused' };
    return { market: 'game_total', parsed };
  }
  if (parsed.type === 'ml') return { market: 'ML', parsed };
  if (parsed.type === 'spread') return { market: 'spread', parsed };

  // espn parser bailed. Recover the cases the structured adapters grade:
  if (teams.length >= 1) {
    if (isTeamTotalBet(d)) return { market: 'team_total', unresolvable: 'team_total_unparseable' };
    // Game total written with the score unit ("Cubs Astros Over 7.5 Runs") —
    // espn's PROP_KEYWORDS bails on "runs", the structured layer grades it.
    const ou = dlow.match(/\b(over|under|o|u)\s*(\d+(?:\.\d+)?)/);
    if (ou) {
      const line = parseFloat(ou[2]);
      const unitRx = SCORE_UNIT_RX[sport];
      // Residual-token check: after removing teams / o-u / numbers / units /
      // connective noise, any leftover word means another market — refuse.
      let residue = ' ' + dlow + ' ';
      for (const t of teams) {
        for (const tok of t.toLowerCase().split(/\s+/)) {
          if (tok.length >= 2) residue = residue.replace(new RegExp(`\\b${escapeRegex(tok)}\\b`, 'g'), ' ');
        }
      }
      residue = residue
        .replace(/\b(over|under|o|u|vs?|at|total|totals|game|combined)\b/g, ' ')
        .replace(/[+-]?\d+(?:\.\d+)?/g, ' ')
        .replace(unitRx ? new RegExp(unitRx.source, 'gi') : /$^/, ' ')
        .replace(/[^a-z]+/g, ' ');
      const leftover = residue.split(/\s+/).filter(t => t.length >= 2);
      if (unitRx && unitRx.test(dlow) && leftover.length === 0 && Number.isFinite(line)) {
        const ttMax = { MLB: 5.5, NHL: 4.5, NBA: 150 }[sport];
        if (teams.length === 1 && line <= ttMax) {
          // One team + score unit + team-total-magnitude line: this is that
          // team's total (espn #146 semantics) but its TT branch refused it
          // (e.g. leftover-token guard) — don't game-total it.
          return { market: 'team_total', unresolvable: 'team_total_guard_refused' };
        }
        const direction = ou[1].startsWith('u') ? 'under' : 'over';
        return { market: 'game_total', parsed: { type: 'total', line, direction } };
      }
      return { market: 'other', unresolvable: `unparseable_ou:${parsed.reason || 'bail'}` };
    }
    // Bare team with no market indicator = implied ML (the structured
    // adapters' isML convention) — but only with exactly ONE distinct team;
    // a bare two-team matchup names no side.
    if (!/[+-]\d/.test(d) && !/\b(over|under)\b/i.test(dlow)) {
      if (teams.length === 1) return { market: 'ML', parsed: { type: 'ml', team: teams[0] } };
      return { market: 'other', unresolvable: 'no_side_named' };
    }
  }
  return { market: 'other', unresolvable: parsed.reason || 'unparseable' };
}

// ── Candidate-game collection (per sport, per ET slate day) ──
// Returns final games matching any bet team, each normalized to the
// espn.gradeFromScore competitors shape. matchCount = how many of the bet's
// named teams are in the game (matchup totals prefer 2-team matches).
async function candidateGames(sport, ymd, teams) {
  const out = [];
  if (!teams.length) return out;
  if (sport === 'MLB') {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${ymd}`;
    let data;
    try { data = await (await fetch(url)).json(); } catch (_) { return out; }
    for (const g of (data && data.dates && data.dates[0] && data.dates[0].games) || []) {
      const away = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.name;
      const home = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.name;
      const matchCount = teams.filter(t => t === away || t === home).length;
      if (!matchCount) continue;
      if (!(g.status && g.status.abstractGameState === 'Final')) continue;
      // statsapi marks POSTPONED/SUSPENDED games abstractGameState='Final' with
      // no scores; undefined scores would satisfy the ML tie check
      // (undefined === undefined) and mint a false PUSH. Require a real final.
      if (/postponed|suspended|cancelled/i.test((g.status && g.status.detailedState) || '')) continue;
      if (!Number.isFinite(g.teams.away.score) || !Number.isFinite(g.teams.home.score)) continue;
      out.push({
        url, date: ymd, matchCount,
        competitors: [
          { displayName: away, shortName: '', abbrev: '', score: g.teams.away.score, homeAway: 'away' },
          { displayName: home, shortName: '', abbrev: '', score: g.teams.home.score, homeAway: 'home' },
        ],
      });
    }
    return out;
  }
  if (sport === 'NHL') {
    const url = `https://api-web.nhle.com/v1/score/${ymd}`;
    let data;
    try { data = await (await fetch(url)).json(); } catch (_) { return out; }
    for (const g of (data && data.games) || []) {
      const away = g.awayTeam && g.awayTeam.name && g.awayTeam.name.default;
      const home = g.homeTeam && g.homeTeam.name && g.homeTeam.name.default;
      const matchCount = teams.filter(t => t === away || t === home).length;
      if (!matchCount) continue;
      if (!(g.gameState === 'OFF' || g.gameState === 'FINAL')) continue;
      if (!Number.isFinite(g.awayTeam.score) || !Number.isFinite(g.homeTeam.score)) continue;
      out.push({
        url, date: ymd, matchCount,
        competitors: [
          { displayName: away, shortName: '', abbrev: '', score: g.awayTeam.score, homeAway: 'away' },
          { displayName: home, shortName: '', abbrev: '', score: g.homeTeam.score, homeAway: 'home' },
        ],
      });
    }
    return out;
  }
  // NBA — ESPN scoreboard, matched with the real espn.js teamMatches.
  const url = `${espn.ESPN_ENDPOINTS.NBA}?dates=${ymd.replace(/-/g, '')}`;
  const events = await espn.getScore('NBA', ymd);
  for (const event of events || []) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    if (!(comp.status && comp.status.type && comp.status.type.completed)) continue;
    const competitors = (comp.competitors || []).map(c => ({
      displayName: (c.team && c.team.displayName) || '',
      shortName: (c.team && c.team.shortDisplayName) || '',
      abbrev: (c.team && c.team.abbreviation) || '',
      score: parseInt(c.score, 10),
      homeAway: c.homeAway,
    }));
    if (competitors.length !== 2) continue;
    if (!competitors.every(c => Number.isFinite(c.score))) continue;
    const matchCount = teams.filter(t => competitors.some(c => espn.teamMatches(t, c))).length;
    if (!matchCount) continue;
    out.push({ url, date: ymd, matchCount, competitors });
  }
  return out;
}

// ── Team-market verdict with anchor → ±1-day widening ───────
async function teamMarketVerdict(sport, parsed, teams, anchorYmd) {
  // A bet naming TWO teams is a specific matchup: a game containing only one
  // of them is guaranteed to be the WRONG game (a "Bulls Knicks Over 237.5"
  // must never grade a Knicks–Hawks final). Require every named matchup team
  // in the game; single-team bets need just their team.
  const required = Math.min(teams.length, 2);
  const forDate = async ymd => (await candidateGames(sport, ymd, teams)).filter(c => c.matchCount >= required);
  let cands = await forDate(anchorYmd);
  let dateShifted = false;
  if (!cands.length) {
    dateShifted = true;
    cands = [
      ...await forDate(shiftYMD(anchorYmd, -1)),
      ...await forDate(shiftYMD(anchorYmd, 1)),
    ];
  }
  if (!cands.length) return { verdict: 'UNRESOLVED', reason: 'no_game_found' };
  // gradeFromScore's evidence string hardcodes "(Final per ESPN)"; relabel to
  // the endpoint the score actually came from.
  const srcLabel = { MLB: 'statsapi.mlb.com', NHL: 'api-web.nhle.com', NBA: 'ESPN' }[sport];
  const graded = [];
  for (const c of cands) {
    const g = espn.gradeFromScore(parsed, { competitors: c.competitors }, teams);
    if (g && g.result) {
      graded.push({
        ...g,
        evidence: String(g.evidence || '').replace('Final per ESPN', `Final per ${srcLabel}`),
        url: c.url,
        date: c.date,
      });
    }
  }
  if (!graded.length) return { verdict: 'UNRESOLVED', reason: 'grade_failed' };
  const statuses = [...new Set(graded.map(g => g.result))];
  if (statuses.length > 1) {
    return {
      verdict: 'UNRESOLVED', reason: 'ambiguous_date',
      detail: graded.map(g => `${g.date}:${g.result}`).join(' | '),
    };
  }
  return {
    verdict: statuses[0],
    evidence: graded[0].evidence,
    url: graded[0].url,
    dateUsed: graded[0].date,
    dateShifted,
    multiGame: graded.length > 1,
  };
}

// ── Player-prop verdict (adapter graders, VOID suppressed) ──
async function propVerdictForSport(sport, desc, anchorYmd) {
  const grade = {
    MLB: (d, y) => mlb.gradeMlbPlayerProp(d, y, { absenceVoidAllowed: false }),
    NBA: (d, y) => nba.gradeNbaPlayerProp(d, y, { absenceVoidAllowed: false }),
    NHL: (d, y) => nhl.gradeNhlPlayerProp(d, y, { absenceVoidAllowed: false }),
  }[sport];
  const slateUrl = {
    MLB: y => `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${y}`,
    NBA: y => `${espn.ESPN_ENDPOINTS.NBA}?dates=${y.replace(/-/g, '')}`,
    NHL: y => `https://api-web.nhle.com/v1/score/${y}`,
  }[sport];

  async function onDate(ymd) {
    try {
      const r = await grade(desc, ymd);
      if (r && r.resolved && ['WIN', 'LOSS', 'PUSH'].includes(r.status)) {
        return { verdict: r.status, evidence: r.evidence, url: slateUrl(ymd), dateUsed: ymd, source: r.source };
      }
      if (r && r.resolved && r.status === 'VOID') {
        return { verdict: 'UNRESOLVED', reason: 'adapter_void_suppressed' };
      }
      if (r && r.resolved && r.status === 'PENDING') {
        return { verdict: 'UNRESOLVED', reason: 'game_not_final' };
      }
      return { verdict: 'UNRESOLVED', reason: (r && r.reason) || 'prop_unresolved' };
    } catch (err) {
      return { verdict: 'UNRESOLVED', reason: `adapter_error: ${err.message}` };
    }
  }

  const primary = await onDate(anchorYmd);
  if (primary.verdict !== 'UNRESOLVED') return primary;
  const alts = [];
  for (const ymd of [shiftYMD(anchorYmd, -1), shiftYMD(anchorYmd, 1)]) {
    const r = await onDate(ymd);
    if (r.verdict !== 'UNRESOLVED') alts.push(r);
  }
  if (!alts.length) return primary;
  const statuses = [...new Set(alts.map(a => a.verdict))];
  if (statuses.length > 1) {
    return { verdict: 'UNRESOLVED', reason: 'ambiguous_date', detail: alts.map(a => `${a.dateUsed}:${a.verdict}`).join(' | ') };
  }
  return { ...alts[0], dateShifted: true };
}

// ── One full attempt under one sport ─────────────────────────
async function attemptSport(bet, sport, anchor) {
  const desc = bet.description || '';
  const teams = extractTeams(desc, sport);
  const cls = classifyMarket(desc, sport, teams);

  if (cls.market === 'prop') {
    if (!cls.prop.sports.includes(sport)) {
      return { sport, market: 'prop', verdict: 'UNRESOLVED', reason: 'stat_not_in_sport_strict', structural: false };
    }
    const v = await propVerdictForSport(sport, desc, anchor.ymd);
    return { sport, market: `${sport.toLowerCase()}_prop`, ...v };
  }
  if (cls.unresolvable) {
    // multi_market / sgp / segment are description-structure refusals: no
    // other sport can rescue them. team_total guard refusals are per-sport.
    const structural = ['multi_market', 'sgp_description', 'segment_market', 'no_side_named'].includes(cls.unresolvable);
    return { sport, market: cls.market, verdict: 'UNRESOLVED', reason: cls.unresolvable, structural };
  }
  if (!teams.length) {
    return { sport, market: cls.market, verdict: 'UNRESOLVED', reason: 'no_team_found', structural: false };
  }
  const v = await teamMarketVerdict(sport, cls.parsed, teams, anchor.ymd);
  return { sport, market: cls.market, ...v };
}

// ── Cross-sport reroute ──────────────────────────────────────
// The stored sport label is path-dependent and sometimes wrong ("New York
// Yankees -1.5" labeled NBA; "Bam Adebayo Under 20.5 Points" labeled MLB).
// When the stored-sport attempt is UNRESOLVED for a non-structural reason,
// the other two sports are attempted; a terminal verdict is accepted only if
// every terminal-producing sport agrees. Rerouted rows are flagged.
async function shadowOne(bet) {
  const anchor = anchorFor(bet);
  if (!anchor) return { verdict: 'UNRESOLVED', reason: 'no_date', sport: bet.sport, market: 'other' };

  const stored = String(bet.sport || '').toUpperCase();
  const first = SPORTS.includes(stored) ? stored : 'NBA';
  const primary = await attemptSport(bet, first, anchor);
  let final = { ...primary, sportUsed: first, rerouted: false, anchor };
  if (primary.verdict === 'UNRESOLVED' && !primary.structural) {
    const terminals = [];
    for (const sp of SPORTS.filter(s => s !== first)) {
      const a = await attemptSport(bet, sp, anchor);
      if (a.verdict !== 'UNRESOLVED') terminals.push({ ...a, sportUsed: sp });
    }
    const statuses = [...new Set(terminals.map(t => t.verdict))];
    if (terminals.length && statuses.length === 1) {
      final = { ...terminals[0], rerouted: true, anchor };
    } else if (statuses.length > 1) {
      final = { ...primary, sportUsed: first, rerouted: false, anchor, verdict: 'UNRESOLVED', reason: 'cross_sport_conflict' };
    }
  }
  return final;
}

// ── Suggested P/L on disagreement ────────────────────────────
function suggestedPu(bet, shadowVerdict) {
  const units = Number(bet.units) || 0;
  if (shadowVerdict === 'PUSH') return { pu: 0, defaultOdds: false };
  if (shadowVerdict === 'LOSS') return { pu: -units, defaultOdds: false };
  // WIN → payout from stored American odds; empty odds → 0.909u default flag.
  const o = Number(bet.odds);
  if (bet.odds == null || bet.odds === '' || !Number.isFinite(o) || o === 0) {
    return { pu: +(0.909 * units).toFixed(4), defaultOdds: true };
  }
  const pu = o > 0 ? units * (o / 100) : units * (100 / Math.abs(o));
  return { pu: +pu.toFixed(4), defaultOdds: false };
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const startedAt = Date.now();
  const all = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  if (!Array.isArray(all)) { console.error('Input is not a JSON array'); process.exit(2); }

  let rows = all;
  if (onlyIds.length) rows = rows.filter(r => onlyIds.includes(r.id));
  if (limit) rows = rows.slice(0, limit);

  const nullProfitUnits = all.filter(r => r.profit_units == null).length;
  console.error(`[shadow] input=${all.length} selected=${rows.length} profit_units_null=${nullProfitUnits}`);

  // Date-confidence signals. Twitter batch imports share one created_at (the
  // scrape time, not the post time), and a 00:00–07:59 ET creation can be a
  // recap of the previous night — both weaken the created_at-derived anchor.
  const createdCounts = {};
  for (const r of all) createdCounts[r.created_at] = (createdCounts[r.created_at] || 0) + 1;

  const results = [];
  let done = 0;
  for (const bet of rows) {
    let r;
    try {
      r = await shadowOne(bet);
    } catch (err) {
      r = { verdict: 'UNRESOLVED', reason: `script_error: ${err.message}`, sportUsed: bet.sport, market: 'other' };
    }
    const storedResult = String(bet.result || '').toLowerCase();
    const agree = r.verdict === 'UNRESOLVED' ? null : r.verdict.toLowerCase() === storedResult;
    const createdInstant = parseUtcInstant(bet.created_at);
    const createdEtHour = createdInstant ? etParts(createdInstant).hour : null;
    const batchCreated = (createdCounts[bet.created_at] || 0) >= 3;
    // Anchor-confidence flag for operator triage: no event_date AND (batch
    // import / early-ET-morning creation / the slate had to shift ±1 day).
    const lowConfidenceDate = !bet.event_date &&
      (batchCreated || (createdEtHour != null && createdEtHour < 8) || !!r.dateShifted);
    const row = {
      id: bet.id,
      sport_stored: bet.sport,
      sport_used: r.sportUsed || r.sport || bet.sport,
      rerouted: !!r.rerouted,
      market: r.market || 'other',
      description: bet.description,
      units: bet.units,
      odds: bet.odds,
      stored_result: storedResult,
      stored_pu: bet.profit_units,
      shadow_verdict: r.verdict,
      reason: r.reason || null,
      detail: r.detail || null,
      agree,
      anchor_ymd: r.anchor ? r.anchor.ymd : null,
      anchor_source: r.anchor ? r.anchor.from : null,
      date_used: r.dateUsed || null,
      date_shifted: !!r.dateShifted,
      created_et_hour: createdEtHour,
      batch_created: batchCreated,
      low_confidence_date: lowConfidenceDate,
      evidence: r.evidence || null,
      evidence_url: r.url || null,
    };
    if (agree === false) {
      const s = suggestedPu(bet, r.verdict);
      row.suggested_pu = s.pu;
      row.default_odds = s.defaultOdds;
    }
    results.push(row);
    done++;
    if (done % 25 === 0) console.error(`[shadow] ${done}/${rows.length} (api=${stats.apiCalls} cache=${stats.cacheHits})`);
  }

  const summary = {
    input_rows: all.length,
    graded_rows: results.length,
    agree: results.filter(r => r.agree === true).length,
    disagree: results.filter(r => r.agree === false).length,
    unresolved: results.filter(r => r.agree === null).length,
    profit_units_null: nullProfitUnits,
    runtime_seconds: Math.round((Date.now() - startedAt) / 1000),
    api_calls: stats.apiCalls,
    cache_hits: stats.cacheHits,
    fetch_errors: stats.errors,
    by_host: stats.byHost,
  };

  const payload = { summary, results };
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 1));
    console.error(`[shadow] wrote ${outPath}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  for (const r of results.filter(x => x.agree === false)) {
    console.log(`DISAGREE ${r.id} ${r.sport_used}/${r.market} stored=${r.stored_result} shadow=${r.shadow_verdict} | ${String(r.description).slice(0, 60)}`);
  }
})().catch(err => { console.error('[shadow] fatal:', err); process.exit(1); });
