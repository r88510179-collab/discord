// ═══════════════════════════════════════════════════════════
// Multi-LLM AI Service — rotates between providers
// Priority: Gemini → Groq → Mistral → OpenRouter (all free tiers)
// ═══════════════════════════════════════════════════════════

const { normalizeDescription, normalizePlayer } = require('./normalization');
const sharp = require('sharp');
const crypto = require('crypto');

// ── Image dedup cache (SHA-256 hash → timestamp, 12h window) ──
const imageHashCache = new Map();
const IMAGE_DEDUP_WINDOW = 12 * 60 * 60 * 1000; // 12 hours

// Models are read from env vars so they can be hot-swapped via `fly secrets set`
// without redeploying. Falls back to sensible defaults.
const PROVIDERS = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    get model() { return process.env.GEMINI_MODEL || 'gemini-2.0-flash'; },
    keyEnv: 'GEMINI_API_KEY',
    format: 'gemini',
    supportsImages: true,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    get model() { return process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile'; },
    get visionModel() { return process.env.GROQ_MODEL || 'llama-3.2-11b-vision-preview'; },
    keyEnv: 'GROQ_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    get model() { return process.env.MISTRAL_TEXT_MODEL || 'mistral-small-latest'; },
    get visionModel() { return process.env.MISTRAL_MODEL || 'pixtral-12b-2409'; },
    keyEnv: 'MISTRAL_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    get model() { return process.env.OPENROUTER_TEXT_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'; },
    get visionModel() { return process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-lite-preview-02-05:free'; },
    keyEnv: 'OPENROUTER_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
};

// Get available providers (ones that have API keys set)
function getProviders(needsImages = false) {
  return Object.entries(PROVIDERS)
    .filter(([name, p]) => {
      const key = process.env[p.keyEnv];
      if (!key) {
        console.log(`[${name}] Skipped: Missing API Key (${p.keyEnv})`);
        return false;
      }
      if (needsImages && !p.supportsImages) {
        console.log(`[${name}] Skipped: Does not support images`);
        return false;
      }
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
// Supports multimodal for OpenRouter when imageBase64 + visionModel are available
async function callOpenAI(provider, prompt, system, imageBase64, mediaType) {
  await waitSlot(provider.name);

  // Build user content: multimodal array for vision, plain string for text-only
  let userContent;
  const useVision = imageBase64 && provider.supportsImages && provider.visionModel;
  const model = useVision ? provider.visionModel : provider.model;

  if (useVision) {
    // OpenAI-compatible vision format (works for Groq, Mistral, OpenRouter)
    userContent = [
      { type: 'image_url', image_url: { url: `data:${mediaType || 'image/png'};base64,${imageBase64}` } },
      { type: 'text', text: prompt },
    ];
    console.log(`[${provider.name}] Using vision model: ${model} (image: ${(imageBase64.length / 1024).toFixed(0)}KB b64)`);
  } else {
    userContent = prompt;
  }

  // Some vision models (OpenRouter free, Groq Llama 4) don't support response_format
  // Only include it for text-only calls to avoid 400 errors
  const bodyPayload = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system + '\nYou MUST respond with valid JSON only.' }] : []),
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  };
  if (!useVision) {
    bodyPayload.response_format = { type: 'json_object' };
  }

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`,
    },
    body: JSON.stringify(bodyPayload),
  });
  if (!res.ok) {
    const errBody = (await res.text()).substring(0, 200);
    console.error(`[${provider.name}] HTTP ${res.status} (model: ${model}): ${errBody}`);
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
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024, responseMimeType: 'application/json' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = (await res.text()).substring(0, 200);
    console.error(`[gemini] HTTP ${res.status} (model: ${provider.model}): ${errText}`);
    return null;
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Universal call — tries providers in order ───────────────
// Vision-aware: tries image-capable providers first, then falls back to text-only
/**
 * withRetry — wraps an async fn with exponential backoff for transient errors.
 */
async function withRetry(fn, label, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.response?.status;
      const isTransient = err.code === 'ETIMEDOUT' || status === 408 || status === 429;
      if (isTransient && i < retries) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`[RETRY] ${label} attempt ${i + 1} failed (${status || err.code}). Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
}

async function callLLM(prompt, system, imageBase64, mediaType) {
  const hasImage = !!imageBase64;

  // Get ALL providers (not just image-capable ones) so we can fall back to text-only
  const allProviders = getProviders(false);
  if (allProviders.length === 0) {
    console.error('[AI] No providers configured!');
    return null;
  }

  // Sort: image-capable providers first when we have an image
  const sorted = hasImage
    ? [...allProviders].sort((a, b) => (b.supportsImages ? 1 : 0) - (a.supportsImages ? 1 : 0))
    : allProviders;

  for (let i = 0; i < sorted.length; i++) {
    const provider = sorted[i];
    const startTime = Date.now();
    try {
      // Determine if this provider can handle the image
      const canDoImage = hasImage && provider.supportsImages;
      const targetModel = canDoImage && provider.visionModel ? provider.visionModel : provider.model;
      console.log(`[AI] Trying ${provider.name} (${i + 1}/${sorted.length}) model=${targetModel} hasImage=${hasImage} canDoImage=${canDoImage}`);

      const result = await withRetry(async () => {
        if (provider.format === 'gemini') {
          return await callGemini(provider, prompt, system, canDoImage ? imageBase64 : null, mediaType);
        }
        return await callOpenAI(provider, prompt, system, canDoImage ? imageBase64 : null, mediaType);
      }, provider.name);

      if (result) {
        const latency = Date.now() - startTime;
        const mode = canDoImage ? 'vision' : 'text-only';
        console.log(`[AI] Winner: ${provider.name} (${mode}) in ${latency}ms`);
        // Attach metadata to the result string for downstream tracking
        result._provider = provider.name;
        result._latency = latency;
        result._model = targetModel;
        result._mode = mode;
        return result;
      }
    } catch (err) {
      const latency = Date.now() - startTime;
      console.error(`[${provider.name}] Error (${latency}ms): ${err.message}${err.cause ? ` (cause: ${err.cause})` : ''}`);
      console.error(`[${provider.name}] Stack: ${err.stack?.split('\n')[1]?.trim() || 'n/a'}`);
    }
  }
  console.error(`[AI] All ${sorted.length} providers failed (hasImage: ${hasImage})`);
  return null;
}

/**
 * processImageForAI — download, resize, grayscale, compress via Sharp.
 * Returns { base64, mediaType } optimized for AI vision models.
 */
async function processImageForAI(imageUrl) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      console.log(`[AI] Image download failed: ${res.status}`);
      return null;
    }
    const rawBuffer = Buffer.from(await res.arrayBuffer());

    // SHA-256 dedup: reject identical images within 12h window
    const fileHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');
    const cached = imageHashCache.get(fileHash);
    if (cached && (Date.now() - cached) < IMAGE_DEDUP_WINDOW) {
      throw new Error('DUPLICATE_IMAGE_DETECTED');
    }
    imageHashCache.set(fileHash, Date.now());

    // Prune expired entries periodically (every 100 new images)
    if (imageHashCache.size % 100 === 0) {
      const now = Date.now();
      for (const [hash, ts] of imageHashCache) {
        if (now - ts > IMAGE_DEDUP_WINDOW) imageHashCache.delete(hash);
      }
    }

    const originalKB = (rawBuffer.length / 1024).toFixed(0);

    // Sharp pipeline: resize → grayscale → JPEG compress
    const optimized = await sharp(rawBuffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .grayscale()
      .jpeg({ quality: 80 })
      .toBuffer();

    const optimizedKB = (optimized.length / 1024).toFixed(0);
    console.log(`[AI] Image optimized: ${originalKB}KB → ${optimizedKB}KB (${((1 - optimized.length / rawBuffer.length) * 100).toFixed(0)}% reduction)`);

    // Gemini has a ~4MB inline limit
    if (optimized.length > 4 * 1024 * 1024) {
      console.log(`[AI] Image still too large after optimization: ${(optimized.length / 1024 / 1024).toFixed(1)}MB`);
      return null;
    }

    return { base64: optimized.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    console.log(`[AI] Image processing error: ${err.message}`);
    return null;
  }
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

  // Run team and player normalization on description before storing
  const description = normalizeDescription(rawDesc);

  const rawOdds = toSafeNumber(bet.odds, -110);
  const odds = Math.abs(rawOdds) > 9999 ? -110 : Math.trunc(rawOdds);
  const units = Math.min(Math.max(toSafeNumber(bet.units, 1), 0.01), 100);
  const betType = String(bet.bet_type || 'straight').toLowerCase();
  const allowedTypes = new Set(['straight', 'parlay', 'teaser', 'prop', 'future', 'ladder']);

  let legs = Array.isArray(bet.legs)
    ? bet.legs
        .map((leg) => {
          const legDesc = String(leg?.description || '').trim().slice(0, 200);
          if (!legDesc) return null;
          return {
            description: normalizeDescription(legDesc),
            odds: toSafeNumber(leg?.odds, null),
            team: leg?.team ? String(leg.team).trim() : null,
            line: leg?.line ? String(leg.line).trim() : null,
            type: leg?.type ? String(leg.type).toLowerCase().trim() : null,
          };
        })
        .filter(Boolean)
    : [];

  // Standardize: even straights get a single-entry legs array
  // Inherit team/line/type from top-level bet when synthesizing
  if (legs.length === 0) {
    // Try to extract team and line from description (e.g., "Lakers -3.5")
    const descMatch = description.match(/^(.+?)\s*([+-]\d+\.?\d*|ML|moneyline|over|under)\s*/i);
    const inheritedTeam = bet.team ? String(bet.team).trim() : (descMatch?.[1]?.trim() || null);
    const inheritedLine = bet.line ? String(bet.line).trim() : (descMatch?.[2]?.trim() || null);
    const inheritedType = bet.market_type || bet.type || (inheritedLine?.match(/^[+-]\d/) ? 'spread' : inheritedLine?.match(/^(ML|moneyline)$/i) ? 'moneyline' : null);
    legs = [{ description, odds, team: inheritedTeam, line: inheritedLine, type: inheritedType }];
  }

  return {
    sport: String(bet.sport || 'Unknown').trim().slice(0, 50) || 'Unknown',
    league: bet.league ? String(bet.league).trim().slice(0, 80) : null,
    bet_type: allowedTypes.has(betType) ? betType : 'straight',
    description,
    odds,
    units,
    wager: toSafeNumber(bet.wager, null),
    payout: toSafeNumber(bet.payout, null),
    event_date: bet.event_date || null,
    legs,
    props: Array.isArray(bet.props) ? bet.props : [],
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

async function parseBetText(text, imageUrl) {
  // If no image, try regex fast-path first
  if (!imageUrl) {
    const quick = regexParseBet(text);
    if (quick?.bets?.length > 0) {
      const sourceText = quick._sourceText || text;
      return applyConfidenceGating(normalizeParsedBets(quick), sourceText);
    }
  }

  // Download image for Gemini Vision if provided
  let imageBase64 = null;
  let mediaType = null;
  if (imageUrl) {
    const img = await processImageForAI(imageUrl);
    if (img) {
      imageBase64 = img.base64;
      mediaType = img.mediaType;
      console.log(`[AI] Image downloaded for Gemini Vision (${(Buffer.from(imageBase64, 'base64').length / 1024).toFixed(0)}KB)`);
    }
  }

  const sys = `You are a STRICT sports betting parser. Return ONLY valid JSON.
${imageBase64 ? '\nVISION MODE ACTIVE: A betting slip image has been attached. You MUST read the attached image to extract the exact player names, props, and lines. Combine this with the tweet text to build a perfectly accurate, bulleted list for multi-leg bets. The image is the PRIMARY source of truth — the text is supplementary context. If the image and text conflict, trust the image.' : ''}

RESPONSE TYPE 1 — New Bet:
If the text contains a clear actionable bet (team/player + line/odds + prediction):

PARLAY example (multiple legs):
{"type":"bet","is_bet":true,"bets":[{"sport":"NCAAB","league":"March Madness","bet_type":"parlay","description":"• Gonzaga -6.5\\n• Houston ML","odds":180,"units":2.0,"wager":50,"payout":90.06,"event_date":null,"legs":[{"description":"Gonzaga -6.5","odds":-110,"team":"Gonzaga","line":"-6.5","type":"spread"},{"description":"Houston ML","odds":-150,"team":"Houston","line":"ML","type":"moneyline"}],"props":[]}]}

STRAIGHT example (single bet — still use legs array with 1 entry):
{"type":"bet","is_bet":true,"bets":[{"sport":"NBA","league":"NBA","bet_type":"straight","description":"Lakers -3.5","odds":-110,"units":1.0,"wager":null,"payout":null,"event_date":null,"legs":[{"description":"Lakers -3.5","odds":-110,"team":"Lakers","line":"-3.5","type":"spread"}],"props":[]}]}

CRITICAL FORMAT RULES:
- EVERY bet MUST have a "legs" array, even single straight bets (1 leg).
- If the slip shows "Parlay", "X Leg", "X Pick", multiple teams/players, or 2+ distinct lines, it is a PARLAY — return ONE bet object with bet_type "parlay" and ALL picks inside the "legs" array. Do NOT split into multiple separate bet objects.
- Each leg MUST include: description, odds (or null), team (or player name), line, type (spread/moneyline/total/prop).
- "odds" on the top-level bet = total parlay odds. Individual leg odds go inside each leg.
- "description" for parlays = bulleted list (one line per leg). For straights = the single pick.

RESPONSE TYPE 2 — Result/Grading Event:
If the text celebrates a WIN or reports a LOSS (e.g., "WINNER", "CASHED", "CASH IT", "HIT!", "BANG", or loss indicators like "took an L", "tough loss"):
{"type":"result","is_bet":false,"outcome":"win","subject":["Real Madrid","Gonzaga"]}
The "subject" array should contain the team names or player names mentioned. "outcome" must be "win" or "loss".

RESPONSE TYPE 3 — Untracked Winner:
If the capper is celebrating their OWN winning bet (e.g., "BOOM", "Cash it!", green checkmarks, "another W") AND you can identify what team/player/event they won on, but it looks like a result not a new pick:
{"type":"untracked_win","is_bet":false,"description":"Lakers ML","outcome":"win","subject":["Lakers"]}
Use this ONLY when the capper is clearly celebrating their own win with identifiable details. If you can't identify the bet, use "result" instead.

RESPONSE TYPE 4 — Not a Bet:
If the text is sports news, commentary, game recaps, opinions, retweets, fan replies, or celebrating someone ELSE's win (e.g., "Look at this hit!", "Great call by @someone"):
{"type":"ignore","is_bet":false,"bets":[]}

STRICT RULES:
- CRITICAL: If the text contains ANY actionable betting lines, spreads, odds, or totals (e.g., "Lakers -2", "Dodgers -140", "O229.5", "+150"), you MUST classify it as type "bet" and extract ALL the picks. Do NOT classify it as "ignore" or "result" just because the capper is also complaining about previous losses, venting, or adding commentary in the same message. The presence of betting lines ALWAYS overrides recap/complaining text.
- ANTI-PROMO / ANTI-SPAM: If the text OR image contains marketing, promotional, or spam content — including but not limited to: "1 MONTH VIP", "RT & REPLY", "Discount", "Promo", "FREE PICK", "Join VIP", "Giveaway", "Link in bio", "Use code", "Subscribe", "Follow for picks", promoting a tool, software, VIP group, Discord server, algorithm, "AI agent", "private beta", subscription service, or discussing general betting strategy without a specific actionable pick — you MUST return {"type":"ignore"}. Do NOT hallucinate bets from promotional graphics. Words like "EV props" or "sharp lines" alone do NOT make it a bet.
- STRICT ENTITY REQUIREMENT: Do NOT hallucinate odds or units. To classify as a bet, there MUST be a clear, specific team name, player name, or betting line being backed. If you cannot confidently identify WHO or WHAT is being bet on, you MUST return {"type":"ignore"}.
- If the text is a retweet (starts with "RT" or contains "Retweeted @"), a reply to a fan, or a capper celebrating someone else's win, return type "ignore".
- If you see "[Quoted]" or "Quoted @", you MUST ignore the quoted text entirely. Only evaluate the capper's original text above it.
- bet_type: straight, parlay, teaser, prop, future, ladder.
- PARLAY / DFS DETECTION: If the text mentions multiple legs, multiple player props, "X-Pick", "Power Play", "Flex Play", "PrizePicks", "Underdog Fantasy", "Sleeper", or lists 2+ distinct player stats, you MUST classify bet_type as "parlay" — NEVER "straight". A slip with 6 players is a 6-leg parlay.
- BULLET POINT FORMATTING: For parlays, the description MUST be a clean bulleted list using newlines (one line per leg), e.g.: "• LeBron James O 22.5 Pts\\n• Steph Curry O 5.5 Ast\\n• Jokic O 11.5 Reb". Do NOT mash multiple legs into a single paragraph.
- For parlays, ALWAYS populate the "legs" array. Each leg MUST have: description, odds (or null), team (or player name), line (spread/total/stat line), type (spread/moneyline/total/prop).
- If the capper mentions a parlay or multiple legs but does NOT list the actual teams/players in the text or OCR data (e.g., they just say "Tap link to load", "Link in bio", or the picks are hidden behind a URL), you MUST set the description to: "MISSING LEGS: Capper hid the picks in a link or missing image." Do NOT fabricate leg details.
- NO HALLUCINATIONS: If it is a DFS slip (PrizePicks, Underdog, Sleeper) or the specific moneyline/spread odds are missing from the text/OCR, do NOT invent -110 or any default odds. Set odds to null. If units/wager are not visible, set units to 1 but do NOT fabricate a wager amount. For DFS slips, set the sport to the primary league of the players involved.
- If wager amount or payout/to-pay is visible, include "wager" (number) and "payout" (number) on the bet.
- Sport: Use specific league — UCL not Soccer, EPL not Soccer, March Madness not NCAAB. If units not specified default 1.
- Parse ALL bets. For player props, include a "props" array: player_name, stat_category (snake_case), line (number), direction ("over"/"under"), odds (integer or null).
- Raw OCR text may contain typos and garbage chars. Do your best (e.g., "0ver"="over", "und3r"="under", "Lebr0n"="LeBron").
Output strictly valid JSON. Do not include markdown formatting, do not include \`\`\`json backticks, and do not include any conversational text.`;
  const raw = await callLLM(text, sys, imageBase64, mediaType);
  if (!raw) return { bets: [], error: 'AI unavailable' };
  const parsed = parseJSON(raw);
  if (!parsed) return { bets: [], error: 'Parse failed' };

  // Type 2: Result/grading event
  if (parsed.type === 'result' && parsed.outcome) {
    return {
      type: 'result',
      is_bet: false,
      outcome: parsed.outcome,
      subject: Array.isArray(parsed.subject) ? parsed.subject : [parsed.subject].filter(Boolean),
      bets: [],
    };
  }

  // Type 3: Untracked winner
  if (parsed.type === 'untracked_win') {
    return {
      type: 'untracked_win',
      is_bet: false,
      description: parsed.description || 'Unknown bet',
      outcome: parsed.outcome || 'win',
      subject: Array.isArray(parsed.subject) ? parsed.subject : [parsed.subject].filter(Boolean),
      bets: [],
    };
  }

  // Type 4: Ignore (not a bet)
  if (parsed.is_bet === false || parsed.type === 'ignore') {
    return { type: 'ignore', is_bet: false, bets: [] };
  }

  // Type 1: Bet
  const result = applyConfidenceGating(normalizeParsedBets(parsed), text);
  result.type = 'bet';
  return result;
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

// ── Tweet Bouncer: extract a pick from raw tweet text or return null ──
async function extractPickFromTweet(tweetText, capperName) {
  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `You are a sports betting parser. Read this tweet from @${capperName}: "${tweetText}"

1. If it does NOT contain a clear sports pick, return exactly: {"status": "NULL"}
2. If it's marketing/promo ("VIP", "RT", "Discount", "LIVE NOW"), return: {"status": "NULL"}
3. If it DOES contain a pick, extract it into this JSON format:
{
  "status": "VALID",
  "sport": "NBA/NFL/MLB/etc",
  "type": "straight/parlay/prop",
  "description": "Cleaned up pick",
  "odds": "-110 or N/A",
  "units": 1,
  "legs": [{"description": "Leg text", "odds": -110}]
}
For parlays, populate legs. For straights, use a single-entry legs array.`;

    const response = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const jsonResponse = JSON.parse(response.choices[0]?.message?.content);

    if (jsonResponse.status === 'NULL') {
      return null;
    }

    delete jsonResponse.status;
    return jsonResponse;
  } catch (err) {
    console.error('[Groq TweetBouncer Error]', err.message);
    return null;
  }
}

module.exports = { parseBetText, parseBetSlipImage, gradeBetAI, parseTwitterPick, generateRecap, assessParseConfidence, extractPickFromTweet, AMBIGUITY_THRESHOLD };
