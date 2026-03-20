// ═══════════════════════════════════════════════════════════
// Multi-LLM AI Service — rotates between providers
// Priority: Groq (fastest) → Gemini → Mistral → OpenRouter
// ═══════════════════════════════════════════════════════════

const { normalizeDescription: normalizeTeamNames } = require('./normalization');

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    format: 'openai',
    supportsImages: false,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-2.5-flash-lite',
    keyEnv: 'GEMINI_API_KEY',
    format: 'gemini',
    supportsImages: true,
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    keyEnv: 'MISTRAL_API_KEY',
    format: 'openai',
    supportsImages: false,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    format: 'openai',
    supportsImages: false,
  },
};

// Get available providers (ones that have API keys set)
function getProviders(needsImages = false) {
  return Object.entries(PROVIDERS)
    .filter(([_, p]) => {
      const key = process.env[p.keyEnv];
      if (!key) return false;
      if (needsImages && !p.supportsImages) return false;
      return true;
    })
    .map(([name, p]) => ({ name, ...p, key: process.env[p.keyEnv] }));
}

// Rate limiting per provider
const lastCall = {};
async function waitSlot(provider) {
  const gap = provider === 'groq' ? 2100 : 4200;
  const elapsed = Date.now() - (lastCall[provider] || 0);
  if (elapsed < gap) await new Promise(r => setTimeout(r, gap - elapsed));
  lastCall[provider] = Date.now();
}

// ── OpenAI-format call (Groq, Mistral, OpenRouter) ──────────
async function callOpenAI(provider, prompt, system) {
  await waitSlot(provider.name);
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    console.error(`[${provider.name}] ${res.status}: ${(await res.text()).substring(0, 100)}`);
    return null;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Gemini-format call (supports images) ────────────────────
async function callGemini(provider, prompt, system, imageBase64, mediaType) {
  await waitSlot(provider.name);
  const url = `${provider.url}/${provider.model}:generateContent?key=${provider.key}`;
  const parts = [];
  if (imageBase64) parts.push({ inlineData: { mimeType: mediaType || 'image/png', data: imageBase64 } });
  parts.push({ text: prompt });
  const body = {
    contents: [{ parts }],
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[gemini] ${res.status}: ${(await res.text()).substring(0, 100)}`);
    return null;
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Universal call — tries providers in order ───────────────
async function callLLM(prompt, system, imageBase64, mediaType) {
  const needsImages = !!imageBase64;
  const providers = getProviders(needsImages);
  if (providers.length === 0) {
    console.error('[AI] No providers configured!');
    return null;
  }

  for (const provider of providers) {
    try {
      let result;
      if (provider.format === 'gemini') {
        result = await callGemini(provider, prompt, system, imageBase64, mediaType);
      } else {
        result = await callOpenAI(provider, prompt, system);
      }
      if (result) {
        console.log(`[AI] Used ${provider.name}`);
        return result;
      }
    } catch (err) {
      console.log(`[AI] ${provider.name} failed: ${err.message}, trying next...`);
    }
  }
  console.error('[AI] All providers failed');
  return null;
}

function parseJSON(t) {
  if (!t || typeof t !== 'string') return null;
  const cleaned = t.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); }
      catch { return null; }
    }
    return null;
  }
}

function toSafeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBet(bet) {
  if (!bet || typeof bet !== 'object') return null;
  const rawDesc = String(bet.description || '').trim().slice(0, 250);
  if (!rawDesc) return null;

  // Run team/alias normalization on description before storing
  const description = normalizeTeamNames(rawDesc);

  const rawOdds = toSafeNumber(bet.odds, -110);
  const odds = Math.abs(rawOdds) > 9999 ? -110 : Math.trunc(rawOdds);
  const units = Math.min(Math.max(toSafeNumber(bet.units, 1), 0.01), 100);
  const betType = String(bet.bet_type || 'straight').toLowerCase();
  const allowedTypes = new Set(['straight', 'parlay', 'teaser', 'prop', 'future', 'ladder']);

  const legs = Array.isArray(bet.legs)
    ? bet.legs
        .map((leg) => {
          const legDesc = String(leg?.description || '').trim().slice(0, 200);
          if (!legDesc) return null;
          // Normalize leg descriptions too
          return { description: normalizeTeamNames(legDesc), odds: toSafeNumber(leg?.odds, null) };
        })
        .filter(Boolean)
    : [];

  return {
    sport: String(bet.sport || 'Unknown').trim().slice(0, 50) || 'Unknown',
    league: bet.league ? String(bet.league).trim().slice(0, 80) : null,
    bet_type: allowedTypes.has(betType) ? betType : 'straight',
    description,
    odds,
    units,
    event_date: bet.event_date || null,
    legs,
  };
}

function normalizeParsedBets(payload) {
  const bets = Array.isArray(payload?.bets) ? payload.bets : [];
  const clean = bets.map(normalizeBet).filter(Boolean);
  return { bets: clean };
}

// ── Fast regex parser (no AI needed for simple bets) ────────
const NBA_TEAMS = 'hawks|celtics|nets|hornets|bulls|cavaliers|cavs|mavericks|mavs|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|heat|bucks|timberwolves|wolves|pelicans|knicks|thunder|magic|76ers|sixers|suns|blazers|kings|spurs|raptors|jazz';
const NFL_TEAMS = 'cardinals|falcons|ravens|bills|panthers|bears|bengals|browns|cowboys|broncos|lions|packers|texans|colts|jaguars|jags|chiefs|raiders|chargers|rams|dolphins|vikings|patriots|pats|saints|giants|jets|eagles|steelers|49ers|niners|seahawks|commanders|titans|bucs|buccaneers';
const MLB_TEAMS = 'diamondbacks|dbacks|braves|orioles|red sox|cubs|white sox|reds|guardians|rockies|tigers|astros|royals|angels|dodgers|marlins|brewers|twins|mets|yankees|athletics|phillies|pirates|padres|mariners|cardinals|rays|rangers|blue jays|nationals';
const NHL_TEAMS = 'ducks|coyotes|bruins|sabres|flames|hurricanes|blackhawks|avalanche|blue jackets|stars|red wings|oilers|panthers|kings|wild|canadiens|habs|predators|devils|islanders|rangers|senators|flyers|penguins|sharks|kraken|blues|lightning|maple leafs|leafs|canucks|golden knights|capitals|jets';

const TEAM_MAP = {
  NBA: new RegExp(`\\b(${NBA_TEAMS})\\b`, 'i'),
  NFL: new RegExp(`\\b(${NFL_TEAMS})\\b`, 'i'),
  MLB: new RegExp(`\\b(${MLB_TEAMS})\\b`, 'i'),
  NHL: new RegExp(`\\b(${NHL_TEAMS})\\b`, 'i'),
};

const SPORT_KEYWORDS = {
  'nba':'NBA','nfl':'NFL','mlb':'MLB','nhl':'NHL',
  'ncaa':'NCAAF','cfb':'NCAAF','cbb':'NCAAB','college':'NCAAB',
  'march madness':'NCAAB',
  'ucl':'UCL','champions league':'UCL','europa league':'Europa League',
  'premier league':'EPL','epl':'EPL','la liga':'La Liga','serie a':'Serie A',
  'bundesliga':'Bundesliga','ligue 1':'Ligue 1',
  'soccer':'Soccer','futbol':'Soccer','mls':'MLS',
  'world cup':'World Cup','copa':'Copa America',
  'ufc':'MMA','mma':'MMA','boxing':'Boxing','bellator':'MMA',
  'golf':'Golf','pga':'Golf','masters':'Golf','open championship':'Golf',
  'tennis':'Tennis','atp':'Tennis','wta':'Tennis',
  'f1':'F1','nascar':'NASCAR','formula 1':'F1',
};

function detectSport(t) {
  const l = t.toLowerCase();
  // Check keywords first
  for (const [k, v] of Object.entries(SPORT_KEYWORDS)) if (l.includes(k)) return v;
  // Then check team names
  for (const [sport, regex] of Object.entries(TEAM_MAP)) if (regex.test(t)) return sport;
  return 'Unknown';
}

// ── Confidence assessment for parsed bets ───────────────────
// Additive weighted scoring — each signal contributes a weight.
// Total score >= AMBIGUITY_THRESHOLD → low confidence.
// Returns { confidence: 'high'|'low', score: number, reasons: string[] }
const AMBIGUITY_THRESHOLD = 3;

function assessParseConfidence(text, bet) {
  const reasons = [];
  let score = 0;
  const t = (text || '').trim();

  // 1. Very short input is inherently ambiguous (weight: 1.5)
  if (t.length < 10) { reasons.push('input_too_short'); score += 1.5; }

  // 2. Sport couldn't be identified (weight: 1)
  if (!bet.sport || bet.sport === 'Unknown') { reasons.push('sport_unknown'); score += 1; }

  // 3. No explicit odds found — defaulted to -110 (weight: 0.5)
  if (!text.match(/[+-]\d{3,4}/)) { reasons.push('no_explicit_odds'); score += 0.5; }

  // 4. No explicit units found (weight: 0.5)
  if (!text.match(/\d+\.?\d*\s*u(?:nits?)?\b/i)) { reasons.push('no_explicit_units'); score += 0.5; }

  // 5. Description is very short or generic (weight: 1)
  const desc = (bet.description || '').trim();
  if (desc.length < 8) { reasons.push('description_too_short'); score += 1; }

  // 6. Conflicting signals — text has both pick and celebration patterns (weight: 2)
  const hasCelebration = /✅|❌|\bBANG+\b|\b(WINNER|CASHED|HIT|BOOM)\b/i.test(t);
  const hasPick = /\b(lock|potd|play|bet|hammer|tail)\b/i.test(t);
  if (hasCelebration && hasPick) { reasons.push('conflicting_signals'); score += 2; }

  // 7. Text is mostly emojis or non-alphanumeric (weight: 1.5)
  const alphaCount = (t.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphaCount < t.length * 0.3 && t.length > 5) { reasons.push('low_alpha_content'); score += 1.5; }

  // 8. Ambiguous line value — a bare number like "+3" could be spread or odds (weight: 1)
  const bareNumberMatch = t.match(/^[^a-zA-Z]*([+-]?\d{1,2}(?:\.5)?)\s*$/);
  if (bareNumberMatch && !t.match(/[+-]\d{3,4}/)) { reasons.push('ambiguous_line'); score += 1; }

  // 9. Uncertain / hedging language — not a firm pick (weight: 1.5)
  if (/\b(maybe|might|thinking about|considering|leaning|not sure|idk|unsure)\b/i.test(t)) {
    reasons.push('uncertain_language'); score += 1.5;
  }

  // 10. Multiple sports detected — conflicting context (weight: 1)
  let sportsFound = 0;
  for (const regex of Object.values(TEAM_MAP)) { if (regex.test(t)) sportsFound++; }
  if (sportsFound >= 2) { reasons.push('multiple_sports'); score += 1; }

  // 11. Question mark suggests uncertainty, not a firm play (weight: 0.5)
  if (/\?/.test(t)) { reasons.push('contains_question'); score += 0.5; }

  // Additive threshold: score >= AMBIGUITY_THRESHOLD → low confidence
  const confidence = score >= AMBIGUITY_THRESHOLD ? 'low' : 'high';
  return { confidence, score, reasons };
}

function regexParseBet(text) {
  // Parlays, ladders, and multi-leg bets are too complex for regex — send to AI
  if (/parlay|ladder|(\+.*\+.*\+)|(\d+\s*leg)|step\s*\d|tier/i.test(text)) return null;

  const oddsMatch = text.match(/([+-]\d{3,4})/);
  const odds = oddsMatch ? parseInt(oddsMatch[1]) : -110;
  const unitsMatch = text.match(/(\d+\.?\d*)\s*u(?:nits?)?\b/i);
  let units = unitsMatch ? parseFloat(unitsMatch[1]) : 1;
  // Cap units at 50 — anything higher is probably a parsing error
  if (units > 50) units = 1;
  let desc = text.replace(/(\d+\.?\d*)\s*u(?:nits?)?\b/gi, '').trim();
  if (desc.length > 200) desc = desc.substring(0, 200);
  if (desc.length < 3) return null;

  const bet = {
    sport: detectSport(text), league: null,
    bet_type: 'straight',
    description: desc, odds, units, event_date: null, legs: [],
  };

  return { bets: [bet], _sourceText: text };
}

// ── Shared post-normalization confidence gating ─────────────
function applyConfidenceGating(result, sourceText) {
  for (const bet of result.bets) {
    const { confidence, score, reasons } = assessParseConfidence(sourceText, bet);
    bet._confidence = confidence;
    bet._confidence_score = score;
    bet._confidence_reasons = reasons;
  }
  return result;
}

async function parseBetText(text) {
  const quick = regexParseBet(text);
  if (quick?.bets?.length > 0) {
    const sourceText = quick._sourceText || text;
    return applyConfidenceGating(normalizeParsedBets(quick), sourceText);
  }
  const sys = `Sports betting parser. Return ONLY JSON: {"bets":[{"sport":"UCL","league":"Champions League","bet_type":"ladder","description":"Osimhen Shots 2+/4+/6+","odds":950,"units":1.0,"event_date":null,"legs":[{"description":"Osimhen 2+ Shots","odds":-200},{"description":"Osimhen 4+ Shots","odds":170}]}]}
bet_type: straight, parlay, teaser, prop, future, ladder. Ladder = escalating thresholds on same player.
Sport: Use specific league — UCL not Soccer, EPL not Soccer, March Madness not NCAAB. If units not specified default 1. Parse ALL bets.`;
  const raw = await callLLM(text, sys);
  if (!raw) return { bets: [], error: 'AI unavailable' };
  const parsed = parseJSON(raw);
  if (!parsed) return { bets: [], error: 'Parse failed' };
  return applyConfidenceGating(normalizeParsedBets(parsed), text);
}

async function parseBetSlipImage(imageBase64, mediaType = 'image/png') {
  const sys = `Bet slip OCR expert. Recognize Hard Rock Bet, DraftKings, FanDuel, BetMGM, Caesars, Onyx.
Return ONLY JSON: {"sportsbook":"Hard Rock Bet","bets":[{"sport":"UCL","league":"Champions League","bet_type":"straight","description":"Over 1.5 1H Goals - Corum vs Erokspor","odds":130,"units":1.0,"stake_amount":14.85,"potential_payout":34.15,"legs":[]}]}
Use specific league names (UCL, EPL, La Liga, etc) not generic Soccer.`;
  const raw = await callLLM('Extract all bets from this bet slip.', sys, imageBase64, mediaType);
  if (!raw) return { bets: [], error: 'AI unavailable' };
  const parsed = parseJSON(raw);
  if (!parsed) return { bets: [], error: 'Could not read slip' };
  return {
    sportsbook: parsed.sportsbook ? String(parsed.sportsbook).slice(0, 80) : null,
    ...normalizeParsedBets(parsed),
  };
}

async function gradeBetAI(bet, result) {
  const sys = `Grade this bet. Return ONLY JSON: {"grade":"B","reason":"1-2 sentences"} A+/A=strong value, B=solid, C=average, D=questionable, F=terrible`;
  const raw = await callLLM(`${bet.description} | ${bet.odds} | ${result}`, sys);
  if (!raw) return { grade: 'C', reason: 'Grading unavailable' };
  const parsed = parseJSON(raw);
  const grade = String(parsed?.grade || 'C').toUpperCase();
  const reason = String(parsed?.reason || 'Could not analyze').slice(0, 300);
  if (!['A+', 'A', 'B', 'C', 'D', 'F'].includes(grade)) return { grade: 'C', reason };
  return { grade, reason };
}

async function parseTwitterPick(tweetText, author) {
  const sys = `Does this tweet contain sports picks? Return ONLY JSON: {"contains_picks":true,"bets":[{"sport":"NBA","bet_type":"straight","description":"Lakers -3.5","odds":-110,"units":1.0}]}`;
  const raw = await callLLM(`@${author}: ${tweetText}`, sys);
  if (!raw) return { contains_picks: false, bets: [] };
  return parseJSON(raw) || { contains_picks: false, bets: [] };
}

async function generateRecap(stats, recentBets) {
  const sys = `Witty sports betting recap writer. Emojis. Max 200 words.`;
  return (await callLLM(`Stats: ${JSON.stringify(stats)}\nBets: ${JSON.stringify(recentBets)}`, sys)) || 'Recap unavailable.';
}

module.exports = { parseBetText, parseBetSlipImage, gradeBetAI, parseTwitterPick, generateRecap, assessParseConfidence, AMBIGUITY_THRESHOLD };
