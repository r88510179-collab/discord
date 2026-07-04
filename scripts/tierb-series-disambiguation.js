#!/usr/bin/env node
// scripts/tierb-series-disambiguation.js
// ═══════════════════════════════════════════════════════════
// TIER B series-disambiguation REPORT DATA — READ-ONLY snowflake-HOUR pin of
// the 8 same-opponent-series rows the Tier B day-level re-anchor
// (scripts/tierb-reanchor.js, docs/audits/2026-07-03-pregate-tierb-reanchor.md)
// could NOT anchor by ET slate DAY alone. Those rows each name a team that
// played the *same opponent* twice inside a 1–3-day playoff series with the
// OPPOSITE grade, so the day-pin (which lands on the snowflake ET day) is a
// disambiguator only in aggregate — for any single row the intended series
// game is unproven.
//
// This script recovers the true tweet-post instant to the MINUTE from each
// row's X/Twitter snowflake id and pins the intended game by the pre-game-post
// model: cappers post BEFORE the game, so the intended game is the earliest
// same-opponent game whose scheduled START is AFTER the post — provided that
// start is within a plausible lead (≤24h) and unambiguous. When the post lands
// after every same-opponent start, or the nearest following start is >24h out,
// or two same-opponent games both start within 24h of the post, the row is
// UNRESOLVED — the post instant alone cannot disambiguate it and it stays
// pending for operator external verification (tweet text / screenshot /
// capper grading history), NOT corrected.
//
// READ-ONLY: no DB access, no writes to the DB, no correction script, no
// deploy. Network is limited to the same public score APIs the engine already
// uses (statsapi.mlb.com, api-web.nhle.com, ESPN). Output is a results JSON
// (via --out) consumed by the human-authored report
// docs/audits/2026-07-03-pregate-series-disambig.md.
//
// Reuse: the grade engine (espn.parseBetDescription / gradeFromScore /
// teamMatches / getScore) and the alias tables are IMPORTED verbatim from the
// same services shadow-regrade-pregate.js uses; the throttled+cached fetch
// wrapper, the ET-slate date helpers, extractTeams, and suggestedPu are copied
// verbatim from scripts/shadow-regrade-pregate.js (cited per block); the
// snowflake constants + statusId/snowflakeMs are copied verbatim from
// scripts/tierb-reanchor.js. Zero grading-logic changes. The only NEW code is
// the per-candidate scheduled-START fetch (the engine's candidateGames returns
// finals but not start times) and the snowflake-hour pin rule.
//
// Usage:
//   node scripts/tierb-series-disambiguation.js [export.json] [--out results.json]
//   (export defaults to prompts/pregate-export-v2.json)
// ═══════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const espn = require('../services/espn');
const mlb = require('../services/sportsdata/mlb');
const nba = require('../services/sportsdata/nba');
const nhl = require('../services/sportsdata/nhl');
const { etParts } = require('../services/eventDate');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith('--')) ||
  path.join(__dirname, '..', 'prompts', 'pregate-export-v2.json');
function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const outPath = flagVal('--out');

// ── The 8 series-bucket rows (docs/audits/2026-07-03-pregate-tierb-reanchor.md)
// The 7 rows flagged conf="series" in the NEW-candidates table (rows 1,2,4,5,
// 7,8,12) PLUS 2c12a667 (report row 6), reclassified out of the pinned set
// per §"2c12a667 DROPPED from the pinned set" (LAA faced CIN on BOTH 04-11 and
// 04-12). Matched by id prefix against the export.
const TARGET_IDS = [
  'aef0b95b', // NHL ML  Canadiens ML (+170) 2u        day-pin 05-21 loss→win  ΔPU +13.5000
  'e949537b', // NBA spr San Antonio Spurs -6.5 (-110) day-pin 05-04 win→loss  ΔPU  −9.5455
  'f754713d', // NBA spr Timberwolves +6.5             day-pin 04-18 win→loss  ΔPU  −5.7273
  'af6e2ca4', // NHL ML  Wild ML                       day-pin 04-18 loss→win  ΔPU  +5.7270
  'b1418864', // NHL ML  Flyers ML                     day-pin 04-25 win→loss  ΔPU  −3.8182
  'd61d4559', // NBA spr New York Knicks -5.5          day-pin 04-18 loss→win  ΔPU  +3.8180
  '3a2b1755', // NHL spr Colorado Avalanche +1.5 (-135) 3u day-pin 05-26 loss→win ΔPU +1.7407
  '2c12a667', // MLB ML  Los Angeles Angels ML         day-pin 04-12 loss→win  ΔPU  +3.9048 (reclassified)
];

// ── Throttled + cached fetch wrapper ────────────────────────
// VERBATIM from scripts/shadow-regrade-pregate.js lines 68–109. Cache key =
// URL; responses materialized to text once so a cached entry can be json()'d
// repeatedly; real requests serialized with a ≥350ms gap (≤3/s).
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
// VERBATIM from scripts/shadow-regrade-pregate.js lines 112–127.
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
function etStamp(d) {
  const p = etParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} ET`;
}

// ── Snowflake re-anchor ──────────────────────────────────────
// VERBATIM from scripts/tierb-reanchor.js lines 63, 113–119. post_ms =
// (id >> 22) + epoch, in BigInt (ids exceed 2^53).
const TW_EPOCH_MS = 1288834974657n;
function statusId(url) {
  const m = /\/status\/(\d+)/.exec(String(url || ''));
  return m ? m[1] : null;
}
function snowflakeMs(idStr) {
  return Number((BigInt(idStr) >> 22n) + TW_EPOCH_MS);
}

// ── Team extraction (alias-table, whole-word) ───────────────
// VERBATIM from scripts/shadow-regrade-pregate.js lines 138–167.
const SPORTS = ['MLB', 'NBA', 'NHL'];
const ADAPTER = { MLB: mlb, NBA: nba, NHL: nhl };
const ALIAS = {
  MLB: mlb._internal.TEAM_ALIASES,
  NBA: nba._internal.TEAM_ALIASES,
  NHL: nhl._internal.TEAM_ALIASES,
};
const SCAN_STOPWORDS = new Set(['as']);
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
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

// ── Suggested P/L (stored American odds, else 0.909×units default-odds) ─────
// VERBATIM from scripts/shadow-regrade-pregate.js lines 580–591.
function suggestedPu(bet, verdict) {
  const units = Number(bet.units) || 0;
  if (verdict === 'PUSH') return { pu: 0, defaultOdds: false };
  if (verdict === 'LOSS') return { pu: -units, defaultOdds: false };
  const o = Number(bet.odds);
  if (bet.odds == null || bet.odds === '' || !Number.isFinite(o) || o === 0) {
    return { pu: +(0.909 * units).toFixed(4), defaultOdds: true };
  }
  const pu = o > 0 ? units * (o / 100) : units * (100 / Math.abs(o));
  return { pu: +pu.toFixed(4), defaultOdds: false };
}

// ── Candidate-game collection WITH scheduled start (the only new fetch) ─────
// Mirrors shadow-regrade-pregate.js candidateGames (final games matching a bet
// team, normalized to the gradeFromScore competitors shape) but ALSO captures
// the scheduled START instant per sport — the field the pin rule keys off,
// which candidateGames drops:
//   MLB  g.gameDate      NHL  g.startTimeUTC     NBA  event.date
// Each returned game carries a stable id (for cross-day dedup), the opponent
// display name of the FIRST named team (for same-opponent series grouping),
// and the competitors array for grading.
async function candidateGamesWithStart(sport, ymd, teams) {
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
      if (/postponed|suspended|cancelled/i.test((g.status && g.status.detailedState) || '')) continue;
      if (!Number.isFinite(g.teams.away.score) || !Number.isFinite(g.teams.home.score)) continue;
      out.push(mkGame(url, ymd, matchCount, g.gamePk, g.gameDate, teams[0], away, home, [
        { displayName: away, shortName: '', abbrev: '', score: g.teams.away.score, homeAway: 'away' },
        { displayName: home, shortName: '', abbrev: '', score: g.teams.home.score, homeAway: 'home' },
      ]));
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
      out.push(mkGame(url, ymd, matchCount, g.id, g.startTimeUTC, teams[0], away, home, [
        { displayName: away, shortName: '', abbrev: '', score: g.awayTeam.score, homeAway: 'away' },
        { displayName: home, shortName: '', abbrev: '', score: g.homeTeam.score, homeAway: 'home' },
      ]));
    }
    return out;
  }
  // NBA — ESPN scoreboard, matched with the real espn.js teamMatches.
  const events = await espn.getScore('NBA', ymd);
  const url = `${espn.ESPN_ENDPOINTS.NBA}?dates=${ymd.replace(/-/g, '')}`;
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
    const mine = competitors.find(c => espn.teamMatches(teams[0], c));
    const opp = competitors.find(c => c !== mine);
    out.push(mkGame(url, ymd, matchCount, event.id, event.date, teams[0],
      (competitors[0] || {}).displayName, (competitors[1] || {}).displayName, competitors,
      opp ? opp.displayName : null));
  }
  return out;
}

// Normalize a candidate; derive the opponent of the FIRST named team so
// single-team bets can be grouped into their same-opponent series.
function mkGame(url, ymd, matchCount, id, startRaw, firstTeam, away, home, competitors, nbaOpp) {
  const startD = startRaw ? new Date(startRaw) : null;
  let opponent = nbaOpp || null;
  if (opponent == null) {
    // MLB/NHL exact-name match: opponent = the side that is NOT the first team.
    if (firstTeam === away) opponent = home;
    else if (firstTeam === home) opponent = away;
  }
  return {
    key: `${ymd}:${id != null ? id : `${away}@${home}`}`,
    date: ymd,
    matchCount,
    startISO: startD && !isNaN(startD.getTime()) ? startD.toISOString() : null,
    startMs: startD && !isNaN(startD.getTime()) ? startD.getTime() : null,
    opponent,
    competitors,
  };
}

// ── Snowflake-hour pin rule ─────────────────────────────────
// Cappers post BEFORE the game. Over the same-opponent series candidates
// (sorted by start), the intended game is the EARLIEST whose start is after
// the post, if that lead is plausible and unambiguous.
const POST_LEAD_MAX_MS = 24 * 60 * 60 * 1000; // implausibly-early cutoff
function pinBySnowflake(postMs, series) {
  const sorted = series.filter(c => c.startMs != null).slice().sort((a, b) => a.startMs - b.startMs);
  const following = sorted.filter(c => c.startMs > postMs);
  if (!following.length) {
    return { pinned: null, reason: 'post_after_all_series_starts' };
  }
  const withinLead = following.filter(c => c.startMs - postMs <= POST_LEAD_MAX_MS);
  if (!withinLead.length) {
    return { pinned: null, reason: 'next_start_gt_24h' };
  }
  if (withinLead.length >= 2) {
    return { pinned: null, reason: 'ambiguous_two_within_24h' };
  }
  return { pinned: withinLead[0], reason: 'pinned' };
}

// ── Grade one pinned game with the engine (verbatim call pattern) ───────────
// Same parse + score-grade path as shadow-regrade-pregate.js teamMarketVerdict;
// the score source label mirrors that function's relabel.
function gradePinnedGame(desc, teams, sport, game) {
  const srcLabel = { MLB: 'statsapi.mlb.com', NHL: 'api-web.nhle.com', NBA: 'ESPN' }[sport];
  const parsed = espn.parseBetDescription(desc, teams, sport);
  const g = espn.gradeFromScore(parsed, { competitors: game.competitors }, teams);
  if (!g || !g.result) return { verdict: 'UNRESOLVED', reason: 'grade_failed', parsed };
  return {
    verdict: g.result,
    evidence: String(g.evidence || '').replace('Final per ESPN', `Final per ${srcLabel}`),
    parsed,
  };
}

// ── Per-row disambiguation ──────────────────────────────────
async function disambiguate(bet) {
  const desc = bet.description || '';
  const sport = String(bet.sport || '').toUpperCase();
  const teams = extractTeams(desc, sport);
  const sid = statusId(bet.source_url);
  const postMs = sid ? snowflakeMs(sid) : null;
  const postD = postMs != null ? new Date(postMs) : null;

  const base = {
    id: bet.id,
    sport,
    description: desc,
    units: bet.units,
    odds: bet.odds,
    stored_result: String(bet.result || '').toLowerCase(),
    stored_pu: bet.profit_units,
    status_id: sid,
    post_ms: postMs,
    post_iso: postD ? postD.toISOString() : null,
    post_et: postD ? etStamp(postD) : null,
    snowflake_date: postD ? etYMD(postD) : null,
    teams,
  };

  if (postMs == null) return { ...base, outcome: 'ERROR', reason: 'no_status_id' };
  if (!teams.length) return { ...base, outcome: 'ERROR', reason: 'no_team_found' };

  // Enumerate every team game in the ±3-day window around the snowflake ET day.
  const snowDay = etYMD(postD);
  const days = [-3, -2, -1, 0, 1, 2, 3].map(n => shiftYMD(snowDay, n));
  const byKey = new Map();
  for (const ymd of days) {
    for (const g of await candidateGamesWithStart(sport, ymd, teams)) {
      if (!byKey.has(g.key)) byKey.set(g.key, g);
    }
  }
  const windowGames = [...byKey.values()].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  // Same-opponent series scope:
  //  • 2 named teams (matchup total) → games containing BOTH (matchCount≥2).
  //  • 1 named team → the opponent faced on the snowflake day defines the
  //    series (the game the day-pin would land on); games vs that opponent.
  let seriesOpp = null;
  let series;
  if (teams.length >= 2) {
    series = windowGames.filter(g => g.matchCount >= 2);
  } else {
    const onDay = windowGames.filter(g => g.date === snowDay);
    const ref = onDay[0] || windowGames.slice().sort((a, b) =>
      Math.abs(new Date(`${a.date}T12:00:00Z`) - new Date(`${snowDay}T12:00:00Z`)) -
      Math.abs(new Date(`${b.date}T12:00:00Z`) - new Date(`${snowDay}T12:00:00Z`)))[0];
    seriesOpp = ref ? ref.opponent : null;
    series = seriesOpp ? windowGames.filter(g => g.opponent === seriesOpp) : windowGames;
  }

  const candLine = g => ({
    date: g.date,
    opponent: g.opponent,
    start_iso: g.startISO,
    start_et: g.startMs != null ? etStamp(new Date(g.startMs)) : null,
    hours_after_post: g.startMs != null ? +(((g.startMs - postMs) / 3600000)).toFixed(2) : null,
    score: `${g.competitors[0].displayName} ${g.competitors[0].score} @ ${g.competitors[1].displayName} ${g.competitors[1].score}`,
  });

  const pin = pinBySnowflake(postMs, series);
  const row = {
    ...base,
    series_opponent: seriesOpp,
    window: `${days[0]}..${days[days.length - 1]}`,
    window_games: windowGames.map(candLine),
    series_candidates: series.map(candLine),
    pin_reason: pin.reason,
  };

  if (!pin.pinned) {
    row.outcome = 'UNRESOLVED';
    return row;
  }

  const g = gradePinnedGame(desc, teams, sport, pin.pinned);
  row.pinned_game = candLine(pin.pinned);
  row.engine_verdict = g.verdict;
  row.engine_evidence = g.evidence || null;
  if (g.verdict === 'UNRESOLVED') { row.outcome = 'UNRESOLVED'; row.pin_reason = g.reason; return row; }

  const agree = g.verdict.toLowerCase() === row.stored_result;
  row.agree = agree;
  const s = suggestedPu(bet, g.verdict);
  row.new_result = g.verdict.toLowerCase();
  row.new_pu = s.pu;
  row.default_odds = s.defaultOdds;
  row.delta_pu = +((s.pu - (Number(bet.profit_units) || 0))).toFixed(4);
  row.outcome = agree ? 'PINNED_AGREE' : 'PINNED_DISAGREE';
  return row;
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const startedAt = Date.now();
  const all = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  if (!Array.isArray(all)) { console.error('Input is not a JSON array'); process.exit(2); }

  const rows = [];
  for (const prefix of TARGET_IDS) {
    const bet = all.find(b => String(b.id).startsWith(prefix));
    if (!bet) { console.error(`[series] MISSING row for prefix ${prefix}`); continue; }
    rows.push(bet);
  }
  console.error(`[series] resolved ${rows.length}/${TARGET_IDS.length} target rows`);

  const results = [];
  for (const bet of rows) {
    let r;
    try { r = await disambiguate(bet); }
    catch (err) { r = { id: bet.id, outcome: 'ERROR', reason: `script_error: ${err.message}` }; }
    results.push(r);
    console.error(`[series] ${String(r.id).slice(0, 8)} ${r.outcome} ${r.pin_reason || r.reason || ''} ` +
      `${r.engine_verdict ? `verdict=${r.engine_verdict}` : ''} ${r.delta_pu != null ? `ΔPU=${r.delta_pu}` : ''}`);
  }

  const disagree = results.filter(r => r.outcome === 'PINNED_DISAGREE');
  const summary = {
    input_rows: all.length,
    target_rows: TARGET_IDS.length,
    resolved_rows: results.length,
    pinned_disagree: disagree.length,
    pinned_agree: results.filter(r => r.outcome === 'PINNED_AGREE').length,
    unresolved: results.filter(r => r.outcome === 'UNRESOLVED').length,
    errors: results.filter(r => r.outcome === 'ERROR').length,
    net_delta_if_all_pinned_disagree_applied: +disagree.reduce((s, r) => s + (r.delta_pu || 0), 0).toFixed(4),
    runtime_seconds: Math.round((Date.now() - startedAt) / 1000),
    api_calls: stats.apiCalls,
    cache_hits: stats.cacheHits,
    fetch_errors: stats.errors,
    by_host: stats.byHost,
  };

  const payload = { summary, results };
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 1));
    console.error(`[series] wrote ${outPath}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  for (const r of results) {
    const games = (r.series_candidates || []).map(c => `${c.date}(${c.opponent},${c.hours_after_post}h)`).join(' ');
    console.log(`${String(r.id).slice(0, 8)} ${r.outcome.padEnd(16)} post=${r.post_et} | series[${games}] ` +
      `${r.pinned_game ? `PIN ${r.pinned_game.date} ${r.engine_verdict} stored=${r.stored_result} ΔPU=${r.delta_pu}` : `(${r.pin_reason})`}`);
  }
})().catch(err => { console.error('[series] fatal:', err); process.exit(1); });
