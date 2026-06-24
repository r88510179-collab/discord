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

// All identity strings (normalized) for a competitor: full names + abbreviation
// (≥3 chars, to avoid 2-letter collisions).
function competitorIdentity(competitor) {
  const t = competitor.team || {};
  const out = new Set();
  for (const v of [t.displayName, t.shortDisplayName, t.name, t.location]) {
    const n = norm(v);
    if (n) out.add(n);
  }
  const ab = norm(t.abbreviation);
  if (ab && ab.length >= 3) out.add(ab);
  return [...out];
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

// Resolve the single match the description refers to, across dateYMD ± 1 (TZ
// slack). Returns { event, comp, matched } or a { reason } fall-through.
// `matched` is the list of competitors named in the description.
async function resolveMatch(descNorm, dateYMD, slug) {
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

  const candidates = [];
  for (const ev of events) {
    const comp = getCompetition(ev);
    const competitors = (comp && comp.competitors) || [];
    if (competitors.length !== 2) continue; // match-level needs exactly two sides
    const matched = competitors.filter(c => competitorNamed(descNorm, c));
    if (matched.length >= 1) candidates.push({ event: ev, comp, matched });
  }

  if (candidates.length === 0) {
    return { reason: anyFetchError && events.length === 0 ? 'fetch_error' : 'no_match_found' };
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

/**
 * Grade a single match-level soccer leg/bet.
 * @param {string} description  one pick string ("USA ML", "Over 2.5 Goals - USA vs Paraguay")
 * @param {string} dateYMD      slate date (YYYY-MM-DD); the adapter also checks ±1 day
 * @param {object} opts         { slug = 'fifa.world' }
 */
async function gradeSoccerBet(description, dateYMD, opts = {}) {
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
  // ANY player prop / unsupported side market. "both teams to score" contains
  // "to score", so BTTS is detected first and excluded here.
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
    return ok(won ? 'WIN' : 'LOSS', `${ftLine}. BTTS ${betNo ? 'No' : 'Yes'} → both scored=${bothScored}.`, matchId);
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
    return ok(won ? 'WIN' : 'LOSS', `${ftLine}. Double chance ${covered.join('/')} → ${actual}.`, matchId);
  }

  // ── 4) Draw (1X2 draw pick) ──
  if (/\bdraw\b|\btie\b/.test(descLower)) {
    return ok(isDrawn ? 'WIN' : 'LOSS', `${ftLine}. Result: ${isDrawn ? 'draw' : nameOf(winner) + ' win'}.`, matchId);
  }

  // ── 5) Half totals (1H/2H) — needs linescores ──
  const halfMatch = /\b(1h|first\s*half)\b/.test(descLower) ? 0
    : /\b(2h|second\s*half)\b/.test(descLower) ? 1 : null;
  if (halfMatch != null) {
    const total = parseTotalLine(descLower);
    if (!total) return no('unparseable_line', matchId);
    const hv = halfTotal(comp, halfMatch);
    if (hv == null) return no('no_linescores', matchId);
    return settleOverUnder(hv, total.direction, total.line, `${halfMatch === 0 ? '1H' : '2H'} goals`, matchId);
  }

  // ── 6) Team total (explicit phrasing) ──
  const total = parseTotalLine(descLower);
  if (total && /team\s*total|team\s*goals/.test(descLower)) {
    if (!subject) return no('no_subject_team', matchId);
    return settleOverUnder(subjectScore, total.direction, total.line, `${nameOf(subject)} team goals`, matchId);
  }

  // ── 7) Game total (over/under) — only when the match is unambiguous ──
  // Requires BOTH teams named (or an explicit matchup token). A single-team
  // "Team Over N" with no team-total phrasing is ambiguous (team vs game total)
  // → fall through.
  if (total) {
    if (matched.length === 2 || matchupToken) {
      return settleOverUnder(totalGoals, total.direction, total.line, 'Match goals', matchId);
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
    return ok(status, `${ftLine}. ${nameOf(subject)} ${subjectScore}-${oppScore}, line ${line > 0 ? '+' : ''}${line}.`, matchId);
  }

  // ── 9) Moneyline / to win (bare ML = 3-way win; draw loses) ──
  if (/\bml\b|money\s*line|\bto win\b/.test(descLower)) {
    if (!subject) return no('no_subject_team', matchId);
    return ok(subjectWon ? 'WIN' : 'LOSS', `${ftLine}. ${nameOf(subject)} ${subjectWon ? 'won' : (isDrawn ? 'drew' : 'lost')}.`, matchId);
  }

  return no('unsupported_market_soccer', matchId);
}

module.exports = {
  gradeSoccerBet,
  // exported for tests / inspection
  _internal: {
    TEAM_ALIASES, norm, competitorNamed, resolveMatch, parseTotalLine, shiftYMD,
  },
};
