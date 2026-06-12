// ═══════════════════════════════════════════════════════════
// Multi-LLM AI Service — rotates between providers
// Provider order (getProviders() iterates PROVIDERS object order): Gemini → Groq → OpenRouter → Cerebras → Mistral → Ollama
// ═══════════════════════════════════════════════════════════

const { normalizeDescription, normalizePlayer, declaresOnlyUnmodeledLeagues, isSportPlaceholder } = require('./normalization');
const sharp = require('sharp');
const crypto = require('crypto');
const { recordDrop } = require('./pipeline-events');
const { AdapterError, FALLBACK_ELIGIBLE, ok: adapterOk, fail: adapterFail, classifyError, classifyHttpStatus } = require('./adapters/types');

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
    get model() { return process.env.GROQ_TEXT_MODEL || 'llama-3.1-8b-instant'; },
    get visionModel() { return process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'; },
    keyEnv: 'GROQ_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    get model() { return process.env.OPENROUTER_TEXT_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'; },
    get visionModel() { return process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus-preview:free'; },
    keyEnv: 'OPENROUTER_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    get model() { return process.env.CEREBRAS_MODEL || 'gpt-oss-120b'; },
    keyEnv: 'CEREBRAS_API_KEY',
    format: 'openai',
    supportsImages: false,
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    get model() { return process.env.MISTRAL_TEXT_MODEL || 'mistral-small-latest'; },
    get visionModel() { return process.env.MISTRAL_MODEL || 'pixtral-12b-2409'; },
    keyEnv: 'MISTRAL_API_KEY',
    format: 'openai',
    supportsImages: true,
  },
  ollama: {
    get url() { return `${process.env.OLLAMA_URL}/v1/chat/completions`; },
    get model() { return process.env.OLLAMA_MODEL || 'llama3.2:3b'; },
    keyEnv: 'OLLAMA_URL',
    format: 'openai',
    supportsImages: false,
    isOllama: true,
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
    .map(([name, p]) => ({ name, ...p, key: p.isOllama ? 'ollama' : process.env[p.keyEnv] }));
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
//
// Returns AdapterResult: { ok: true, value: string } on success,
// { ok: false, errorClass, error } on any failure. Never throws.
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

  // Timeout: 25s for Ollama (CPU inference), 15s for cloud providers
  const timeoutMs = provider.isOllama ? 25000 : 15000;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`,
  };
  if (provider.isOllama && process.env.OLLAMA_PROXY_SECRET) {
    headers['x-ollama-secret'] = process.env.OLLAMA_PROXY_SECRET;
  }
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify(bodyPayload),
    });
    if (!res.ok) {
      const errBody = (await res.text()).substring(0, 200);
      console.error(`[${provider.name}] HTTP ${res.status} (model: ${model}): ${errBody}`);
      // 429 cooldown — give APIs breathing room before next provider attempt
      if (res.status === 429) await new Promise(r => setTimeout(r, 2000));
      const errorClass = classifyHttpStatus(res.status);
      return adapterFail(errorClass, new Error(`HTTP ${res.status}: ${errBody}`));
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) return adapterFail(AdapterError.NO_CONTENT, new Error(`${provider.name} empty content`));
    return adapterOk(content);
  } catch (err) {
    return adapterFail(classifyError(err), err);
  }
}

// ── Gemini-format call (supports images) ────────────────────
// Returns AdapterResult: { ok: true, value: string } on success,
// { ok: false, errorClass, error } on any failure. Never throws.
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = (await res.text()).substring(0, 200);
      console.error(`[gemini] HTTP ${res.status} (model: ${provider.model}): ${errText}`);
      if (res.status === 429) await new Promise(r => setTimeout(r, 2000));
      const errorClass = classifyHttpStatus(res.status);
      return adapterFail(errorClass, new Error(`HTTP ${res.status}: ${errText}`));
    }
    const data = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!content) return adapterFail(AdapterError.NO_CONTENT, new Error('gemini empty content'));
    return adapterOk(content);
  } catch (err) {
    return adapterFail(classifyError(err), err);
  }
}

// ── Universal call — tries providers in order ───────────────
// Vision-aware: tries image-capable providers first, then falls back to text-only
/**
 * callAdapterWithRetry — invoke an AdapterResult-returning adapter
 * with exponential backoff on transient errorClasses (rate_limit,
 * timeout). Returns the final AdapterResult — never throws. Replaces
 * the old throw-based withRetry helper.
 */
async function callAdapterWithRetry(fn, label, retries = 2) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    last = await fn();
    if (last && last.ok) return last;
    const cls = last && last.errorClass;
    const isTransient = cls === AdapterError.RATE_LIMIT || cls === AdapterError.TIMEOUT;
    if (!isTransient || i >= retries) return last;
    const delay = Math.pow(2, i) * 1000;
    console.log(`[RETRY] ${label} attempt ${i + 1} failed (${cls}). Retrying in ${delay}ms...`);
    await new Promise(res => setTimeout(res, delay));
  }
  return last;
}

/**
 * callLLMResult — multi-provider dispatch returning AdapterResult.
 *
 * Iterates configured providers (image-capable first when an image
 * is present). On the first ok(value), returns ok with metadata
 * { provider, latency, model, mode }. When every provider fails,
 * returns fail with the FIRST fallback-eligible errorClass observed
 * (rate_limit, quota_exhausted, no_content, parse_fail, timeout,
 * http_5xx) — that's the signal parseBetText uses to decide whether
 * to burn Gemma cycles. If no provider produced a fallback-eligible
 * class (everything was AUTH or 4xx misconfig), the first errorClass
 * is returned so callers can surface the failure without falling back.
 *
 * Never throws.
 */
async function callLLMResult(prompt, system, imageBase64, mediaType, opts = {}) {
  const hasImage = !!imageBase64;
  const requireImage = !!opts.requireImage;

  // Get ALL providers (not just image-capable ones) so we can fall back to text-only
  const allProviders = getProviders(false);
  if (allProviders.length === 0) {
    console.error('[AI] No providers configured!');
    return adapterFail(AdapterError.UNKNOWN, new Error('No providers configured'));
  }

  // Sort: image-capable providers first when we have an image
  const sorted = hasImage
    ? [...allProviders].sort((a, b) => (b.supportsImages ? 1 : 0) - (a.supportsImages ? 1 : 0))
    : allProviders;

  let firstError = null;
  let firstFallbackEligible = null;

  const recordFailure = (result) => {
    if (!result || result.ok) return;
    if (!firstError) firstError = result;
    if (!firstFallbackEligible && FALLBACK_ELIGIBLE.has(result.errorClass)) {
      firstFallbackEligible = result;
    }
  };

  for (let i = 0; i < sorted.length; i++) {
    const provider = sorted[i];
    const startTime = Date.now();
    // Determine if this provider can handle the image
    const canDoImage = hasImage && provider.supportsImages;
    const targetModel = canDoImage && provider.visionModel ? provider.visionModel : provider.model;
    console.log(`[AI] Trying ${provider.name} (${i + 1}/${sorted.length}) model=${targetModel} hasImage=${hasImage} canDoImage=${canDoImage}`);

    const result = await callAdapterWithRetry(async () => {
      if (provider.format === 'gemini') {
        return await callGemini(provider, prompt, system, canDoImage ? imageBase64 : null, mediaType);
      }
      return await callOpenAI(provider, prompt, system, canDoImage ? imageBase64 : null, mediaType);
    }, provider.name);

    if (result && result.ok) {
      const latency = Date.now() - startTime;
      const mode = canDoImage ? 'vision' : 'text-only';
      console.log(`[AI] Winner: ${provider.name} (${mode}) in ${latency}ms`);
      return adapterOk(result.value, { provider: provider.name, latency, model: targetModel, mode });
    }
    const latency = Date.now() - startTime;
    console.error(`[${provider.name}] AdapterResult fail (${latency}ms): errorClass=${result?.errorClass} error=${result?.error || 'n/a'}`);
    recordFailure(result);
  }

  // ── Last resort: if we had an image but ALL vision providers failed,
  // retry text-only providers with just the prompt (drop the image).
  // This lets Cerebras handle OCR text when Gemini/Groq/OpenRouter are all down.
  // Skipped when opts.requireImage is set — image-only callers (parseBetSlipImage)
  // can't use text-only output, which would return valid-looking empty-bets JSON
  // and mask the failure.
  if (hasImage && requireImage) {
    console.warn('[AI] requireImage=true; skipping text-only fallback after image providers failed');
  } else if (hasImage) {
    console.warn('[AI] All vision providers failed — retrying text-only (dropping image)...');
    for (const provider of sorted) {
      if (provider.supportsImages) continue; // already tried these with image
      console.log(`[AI] Text fallback: ${provider.name} model=${provider.model}`);
      const result = await callAdapterWithRetry(async () => {
        return await callOpenAI(provider, prompt, system, null, null);
      }, provider.name);
      if (result && result.ok) {
        console.log(`[AI] Text fallback winner: ${provider.name}`);
        return adapterOk(result.value, { provider: provider.name, mode: 'text-fallback', model: provider.model });
      }
      console.error(`[AI] Text fallback ${provider.name} failed: errorClass=${result?.errorClass}`);
      recordFailure(result);
    }
  }

  console.error(`[AI] All ${sorted.length} providers failed (hasImage: ${hasImage})`);
  // Prefer fallback-eligible class so parseBetText can switch on a
  // signal that Gemma can actually help with.
  const chosen = firstFallbackEligible || firstError;
  return chosen || adapterFail(AdapterError.UNKNOWN, new Error('All providers failed with no recorded error'));
}

/**
 * callLLM — backward-compatible string-or-null wrapper around
 * callLLMResult. Existing call sites (gradeBetAI, parseTwitterPick,
 * generateRecap, parseGemmaOutputWithCerebras, etc.) keep working
 * unchanged. parseBetText uses callLLMResult directly so it can
 * switch on errorClass.
 */
async function callLLM(prompt, system, imageBase64, mediaType) {
  const result = await callLLMResult(prompt, system, imageBase64, mediaType);
  return result.ok ? result.value : null;
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

    // Aggressively prune: every 20 images OR if cache exceeds 500 entries
    if (imageHashCache.size % 20 === 0 || imageHashCache.size > 500) {
      const now = Date.now();
      for (const [hash, ts] of imageHashCache) {
        if (now - ts > IMAGE_DEDUP_WINDOW) imageHashCache.delete(hash);
      }
      // Hard cap: if still over 500 after pruning, drop oldest half
      if (imageHashCache.size > 500) {
        const entries = [...imageHashCache.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < entries.length / 2; i++) imageHashCache.delete(entries[i][0]);
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

    const result = { base64: optimized.toString('base64'), mediaType: 'image/jpeg' };
    // Hint GC to free the raw buffer (can be 5-10MB per image)
    if (typeof global.gc === 'function') global.gc();
    return result;
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
  // Cap description length defensively. Parlays legitimately run long because
  // they contain N leg bullets — 250 truncated mid-bullet, causing leg-explosion
  // false positives (services/grading.js:1647 guard). See docs/BACKLOG.md
  // "Leg-explosion truncation root cause" (shipped 2026-05-18, services/ai.js:423).
  const isParlay = String(bet.bet_type || '').toLowerCase() === 'parlay';
  const descCap = isParlay ? 2000 : 250;
  const rawDescFull = String(bet.description || '').trim();
  const rawDesc = rawDescFull.slice(0, descCap);
  if (rawDescFull.length > descCap) {
    console.warn(`[normalizeBet] description truncated: raw_len=${rawDescFull.length} cap=${descCap} bet_type=${bet.bet_type || 'unknown'} preview="${rawDescFull.slice(0, 80)}..."`);
  }
  if (!rawDesc) return null;

  // Run team and player normalization on description before storing. Pass the
  // declared sport so unmodeled-league slips (KBO, KHL, …) are never rewritten
  // with a wrong same-nickname US team — see services/normalization.js
  // shouldExpandAliases (incident 2026-06-11, ingest disc_1514481735335805030).
  const declaredSport = bet.sport;
  const description = normalizeDescription(rawDesc, declaredSport);

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
            description: normalizeDescription(legDesc, declaredSport),
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

// ── City-aware disambiguation for shared team nicknames (P1 Bug 2) ──────────
// Six nicknames are shared across leagues (e.g. "Cardinals" = NFL Arizona +
// MLB St. Louis). Map-priority order alone mis-files a lone shared nickname,
// and the stored-sport path (detectSport, TEAM_MAP order NBA>NFL>MLB>NHL)
// disagrees with the grade-time paths (inferLegSport / reclassifySport, which
// scan SPORT_TEAM_MAP MLB-first). This table keys on (nickname, FULL city
// name) and is the single source of truth all three functions consult FIRST.
// FULL CITY NAMES ONLY — a bare nickname with no recognized city returns null
// (see disambiguateAmbiguousTeam) so unambiguous teams resolve normally.
const AMBIGUOUS_TEAMS = {
  cardinals: { 'st. louis': 'MLB', 'st louis': 'MLB', arizona: 'NFL' },
  giants:    { 'san francisco': 'MLB', 'new york': 'NFL' },
  rangers:   { 'new york': 'NHL', texas: 'MLB' },
  kings:     { 'los angeles': 'NHL', sacramento: 'NBA' },
  panthers:  { florida: 'NHL', carolina: 'NFL' },
  jets:      { winnipeg: 'NHL', 'new york': 'NFL' },
};

// Returns the mapped sport when `text` contains a franchise's contiguous
// "<city> <nickname>" phrase — or several phrases that all map to the same
// sport — else null. The matching unit is the WHOLE adjacent phrase
// ("new york rangers" -> NHL, "new york giants" -> NFL), NOT an independent
// nickname + that nickname's city found anywhere: "New York Rangers vs Giants"
// is NHL (bare "Giants" has no adjacent city), never NFL. When the text holds
// CONFLICTING franchises (e.g. "New York Rangers ML, San Francisco Giants ML"
// — NHL + MLB), it ABSTAINS (null) so each caller falls through to its own
// cross-sport handling. No-match also returns null — essential so the three
// callers fall through to their existing, unchanged resolution logic.
function disambiguateAmbiguousTeam(text) {
  const l = (text || '').toLowerCase();
  // Derive the (phrase regex -> sport) list once from AMBIGUOUS_TEAMS: every
  // (city, nickname) pair becomes the contiguous phrase "<city> <nickname>".
  // Each phrase is escaped (metachars), given flexible whitespace, and bounded
  // with \b so "kings" never matches "kingsford". The "st. louis"/"st louis"
  // period variants are both table keys, so both phrase spellings are generated
  // and each maps to MLB. Cached on the fn like detectSport._unambiguous.
  if (!disambiguateAmbiguousTeam._phrases) {
    const toRegex = (phrase) => {
      const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`\\b${esc}\\b`);
    };
    const phrases = [];
    for (const [nick, cities] of Object.entries(AMBIGUOUS_TEAMS))
      for (const [city, sport] of Object.entries(cities))
        phrases.push({ sport, re: toRegex(`${city} ${nick}`) });
    disambiguateAmbiguousTeam._phrases = phrases;
  }
  // Collect the sport of every franchise phrase actually present in the text.
  const sports = new Set();
  for (const { sport, re } of disambiguateAmbiguousTeam._phrases)
    if (re.test(l)) sports.add(sport);
  // One distinct sport (one or more phrases, all agreeing) -> force it. Zero
  // phrases (no recognized franchise) or >=2 distinct sports (conflicting
  // franchises) -> null: callers fall through to their own resolution / abstain.
  return sports.size === 1 ? [...sports][0] : null;
}

function detectSport(t) {
  const text = t || '';
  // P1 Bug 2: a recognized (nickname, full-city) pair forces the sport, ahead
  // of both the league-keyword scan and the map-priority fallback below.
  const forced = disambiguateAmbiguousTeam(text);
  if (forced) return forced;
  const l = text.toLowerCase();
  // 1. League/sport keyword is unambiguous — return immediately (unchanged).
  for (const [k, v] of Object.entries(SPORT_KEYWORDS)) if (l.includes(k)) return v;
  // 2. Collect ALL leagues whose team regex matches (not just the first).
  const matched = [];
  for (const [sport, regex] of Object.entries(TEAM_MAP)) if (regex.test(text)) matched.push(sport);
  // 3. Zero or one league — behavior unchanged.
  if (matched.length === 0) return 'Unknown';
  if (matched.length === 1) return matched[0];
  // 4. Ambiguous shared nickname (e.g. "Cardinals" = NFL+MLB). If the text also contains
  //    a nickname owned by exactly ONE league (e.g. "Cubs" -> MLB), prefer that league.
  //    Nickname->owner index is derived once from the *_TEAMS lists and cached on the fn.
  if (!detectSport._unambiguous) {
    const lists = { NBA: NBA_TEAMS, NFL: NFL_TEAMS, MLB: MLB_TEAMS, NHL: NHL_TEAMS };
    const owners = {};
    for (const [sport, list] of Object.entries(lists))
      for (const tok of list.split('|')) (owners[tok] = owners[tok] || []).push(sport);
    detectSport._unambiguous = Object.entries(owners)
      .filter(([, sports]) => sports.length === 1)
      .map(([tok, sports]) => ({ sport: sports[0], re: new RegExp(`\\b${tok}\\b`, 'i') }));
  }
  const pinned = new Set();
  for (const { sport, re } of detectSport._unambiguous) if (re.test(text)) pinned.add(sport);
  if (pinned.size === 1) return [...pinned][0];
  // 5. Still tied (no unambiguous nickname, or conflicting ones) — fall back to the
  //    original first-match priority order (NBA -> NFL -> MLB -> NHL). Never Unknown here.
  for (const sport of Object.keys(TEAM_MAP)) if (matched.includes(sport)) return sport;
  return matched[0];
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

// ═══════════════════════════════════════════════════════════
// GEMMA 3:4b VISION FALLBACK (via Ollama on Surface Pro)
//
// Triggered when the primary Vision provider (Gemini et al.) returns
// placeholder text ("missing legs: capper hid the picks") or empty
// legs — typically dense slip images it can't parse. Gemma reads the
// slip, Cerebras parses Gemma's text into JSON matching the primary
// output shape, and parseBetText resumes as if Gemini had succeeded.
//
// Chain:
//   Gemini   (primary)   → placeholder / empty / quota error
//   ↓ fallback
//   Gemma   (Ollama)     → raw slip text
//   ↓
//   Cerebras             → structured JSON {legs:[...], bet_type}
//
// Every failure at any stage is logged to vision_failures for later
// review. If the whole chain produces nothing, we return the original
// Gemini output (if any) — bouncer will still reject placeholders.
// ═══════════════════════════════════════════════════════════

// ── Gemma circuit breaker ──
// Same shape as services/grading.js backendHealth. If Ollama hangs or
// returns nothing, we trip the breaker for 30 min so subsequent vision
// tweets don't stack 90-second timeouts while Surface Pro is stuck.
// A successful call resets the breaker.
const GEMMA_CONFIG = {
  failCooldownMs: 30 * 60 * 1000, // 30 min — Ollama hangs tend to last a while
  maxFails: 3,
};
const gemmaHealth = {
  lastSuccess: null,
  lastFailure: null,
  failCount: 0,
  openUntil: null,
  lastError: null,
};

function isGemmaHealthy() {
  if (!gemmaHealth.openUntil) return true;
  if (Date.now() > gemmaHealth.openUntil) {
    gemmaHealth.openUntil = null;
    gemmaHealth.failCount = 0;
    return true;
  }
  return false;
}

function recordGemmaResult(ok, errorCode = null) {
  if (ok) {
    gemmaHealth.lastSuccess = Date.now();
    gemmaHealth.failCount = 0;
    gemmaHealth.openUntil = null;
    gemmaHealth.lastError = null;
    return;
  }
  gemmaHealth.lastFailure = Date.now();
  gemmaHealth.failCount++;
  gemmaHealth.lastError = errorCode;
  if (gemmaHealth.failCount >= GEMMA_CONFIG.maxFails) {
    gemmaHealth.openUntil = Date.now() + GEMMA_CONFIG.failCooldownMs;
    console.warn(`[Gemma] Circuit breaker OPEN — ${gemmaHealth.failCount} consecutive failures, cooldown ${GEMMA_CONFIG.failCooldownMs / 60000}m (last: ${errorCode})`);
  }
}

const GEMMA_SLIP_PROMPT = `You are reading a sports betting slip image. Extract every pick/leg exactly as written.

For each pick, output one line in this exact format:
PICK: <player or team name> | <stat or market> | <line or spread> | <odds>

If you cannot read a field, write UNKNOWN in its place. Do not invent values. If the image is not a betting slip, output NOT_A_SLIP.

DO NOT extract player statistics, win-loss records, or percentage win rates as picks. Lines like "C. Sanchez 5-1 (83.3%)" or "L. Webb 6-0 (100.0%)" are STAT DISPLAYS (pitcher records, hit rates), not legs — skip them. A real leg has a line/spread/odds being wagered on, not a historical record.

Example good output:
PICK: Aaron Judge | HOME RUNS | Over 0.5 | +320
PICK: Phoenix Suns | SPREAD | -3.5 | -110
PICK: Yankees Angels | TOTAL RUNS | Over 9.5 | -115

Output PICKs only, one per line, no commentary.`;

/**
 * Call Gemma 3:4b on Surface Pro Ollama via /api/generate with an image.
 *
 * Returns AdapterResult: { ok: true, value: rawText } on success,
 * { ok: false, errorClass, error } on any failure. Never throws.
 *
 * AUTH and HTTP_4XX errors trip the breaker too — they typically
 * mean OLLAMA_PROXY_SECRET is wrong, and we don't want to retry that
 * tight in a loop.
 */
async function tryVisionGemma(imageBase64, mediaType = 'image/png') {
  const url = process.env.OLLAMA_URL;
  const secret = process.env.OLLAMA_PROXY_SECRET;
  if (!url || !secret || !imageBase64) {
    return adapterFail(AdapterError.UNKNOWN, new Error('Gemma not configured (OLLAMA_URL/SECRET missing or no image)'));
  }

  // Circuit breaker — if Ollama has been hanging, skip the 90s wait.
  if (!isGemmaHealthy()) {
    const remaining = Math.round((gemmaHealth.openUntil - Date.now()) / 60000);
    console.log(`[Gemma] Circuit breaker OPEN — skipping (${remaining}m remaining, last: ${gemmaHealth.lastError || 'unknown'})`);
    return adapterFail(AdapterError.UNKNOWN, new Error(`circuit_open_${remaining}m`));
  }

  const model = process.env.OLLAMA_VISION_MODEL || 'gemma3:4b';
  const start = Date.now();
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'Content-Type': 'application/json',
        'x-ollama-secret': secret,
      },
      body: JSON.stringify({
        model,
        prompt: GEMMA_SLIP_PROMPT,
        images: [imageBase64],
        stream: false,
        options: { temperature: 0 },
      }),
    });
    const duration = Date.now() - start;
    if (!res.ok) {
      console.log(`[Gemma] Vision call FAILED: model=${model}, status=${res.status}, duration=${duration}ms`);
      recordGemmaResult(false, `HTTP_${res.status}`);
      return adapterFail(classifyHttpStatus(res.status), new Error(`HTTP ${res.status}`));
    }
    const data = await res.json();
    const output = (data.response || '').trim();
    console.log(`[Gemma] Vision call: model=${model}, url=${url}, duration=${duration}ms, output_chars=${output.length}`);
    if (output) {
      recordGemmaResult(true);
      return adapterOk(output);
    }
    recordGemmaResult(false, 'EMPTY_RESPONSE');
    return adapterFail(AdapterError.NO_CONTENT, new Error('Gemma empty response'));
  } catch (err) {
    const errorClass = classifyError(err);
    const code = errorClass === AdapterError.TIMEOUT ? 'TIMEOUT' : 'ERROR';
    console.log(`[Gemma] Vision call ${code}: ${err.message} (${Date.now() - start}ms)`);
    recordGemmaResult(false, code);
    return adapterFail(errorClass, err);
  }
}

/**
 * Feed Gemma's raw slip text into Cerebras to produce structured JSON
 * matching parseBetText's expected output shape.
 *
 * Returns:
 *   { json: string, parsed: object }  on success
 *   null                              on failure
 */
async function parseGemmaOutputWithCerebras(gemmaRaw) {
  if (!gemmaRaw) return null;
  if (/NOT_A_SLIP/i.test(gemmaRaw)) return { json: JSON.stringify({ type: 'ignore', is_bet: false, bets: [] }), parsed: { type: 'ignore', is_bet: false, bets: [] } };

  const sys = `You are a strict JSON normalizer. Convert the following betting slip picks (one PICK per line) into the exact JSON shape below. Return ONLY valid JSON — no markdown, no commentary.

Expected shape (copy exactly — NO other fields, NO other types):
{"type":"bet","is_bet":true,"ticket_status":"new","bets":[{"sport":"NBA","league":"NBA","bet_type":"parlay","description":"• Leg 1\\n• Leg 2","odds":null,"units":1,"wager":null,"payout":null,"event_date":null,"legs":[{"description":"Leg 1","odds":-110,"team":"Lakers","line":"-3.5","type":"spread"}],"props":[]}]}

Rules:
- bet_type: "straight" if 1 leg, "parlay" if 2+ legs.
- If a PICK line reads UNKNOWN for all fields, drop that leg entirely.
- DROP any PICK line that looks like a player stat display rather than a wager — specifically lines of shape "NAME N-N (NN%)" or "NAME N-N (NN.N%)" (pitcher win-loss records / hit rates). These are not betting legs.
- If 0 usable legs remain, return {"type":"ignore","is_bet":false,"bets":[]}.
- odds: parse American odds (+320, -110) as integer. Missing → null.
- For player props, populate "props" with {player_name, stat_category (snake_case), line (number), direction ("over"/"under"), odds}.
- description for parlays = bullet list, one line per leg.
- Sport: use specific league (MLB, NBA, NHL, NFL, UCL, EPL, etc).
- NEVER fabricate. If the PICK lines do not support a field, use null.`;

  const raw = await callLLM(gemmaRaw, sys, null, null);
  if (!raw) return null;
  const parsed = parseJSON(raw);
  if (!parsed) return null;

  // Accept ignore-shaped responses (not-a-slip / all-unknown) as valid
  if (parsed.type === 'ignore' || parsed.is_bet === false) {
    return { json: raw, parsed, cerebrasRaw: raw };
  }

  const bets = Array.isArray(parsed.bets) ? parsed.bets : [];
  const anyLegs = bets.some(b => Array.isArray(b.legs) && b.legs.length > 0);
  if (bets.length === 0 || !anyLegs) return null;

  return { json: raw, parsed, cerebrasRaw: raw };
}

/** Write a vision_failures row. Best-effort; never throws. */
function logVisionFailure({ tweetId, imageUrl, geminiResponse, gemmaResponse, cerebrasResponse, stage }) {
  try {
    const { db } = require('./database');
    const id = crypto.randomBytes(8).toString('hex');
    db.prepare(`INSERT INTO vision_failures
      (id, tweet_id, image_url, gemini_response, gemma_response, cerebras_response, failure_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      tweetId || null,
      imageUrl || null,
      (geminiResponse || '').slice(0, 4000),
      (gemmaResponse || '').slice(0, 4000),
      (cerebrasResponse || '').slice(0, 4000),
      stage,
    );
  } catch (e) {
    console.error(`[VisionFailure] log write error (non-fatal): ${e.message}`);
  }
}

/**
 * Run the Gemma → Cerebras fallback. Returns a JSON string (same shape
 * callers expect from callLLM) on success, or null on failure.
 *
 * tryVisionGemma now returns AdapterResult — unwrap to the raw text
 * here. Gemma's adapter-level errorClass is logged but not surfaced
 * upward; the caller already knows it took the fallback path.
 */
async function runGemmaVisionFallback({ imageBase64, mediaType, geminiResponse, tweetId, imageUrl }) {
  const gemmaResult = await tryVisionGemma(imageBase64, mediaType);
  if (!gemmaResult.ok) {
    console.log(`[Gemma→Cerebras] Gemma adapter fail (errorClass=${gemmaResult.errorClass})`);
    logVisionFailure({ tweetId, imageUrl, geminiResponse, stage: 'gemma' });
    return null;
  }
  const gemmaRaw = gemmaResult.value;
  console.log(`[Gemma→Cerebras] Gemma produced ${gemmaRaw.length} chars — parsing...`);

  const parsed = await parseGemmaOutputWithCerebras(gemmaRaw);
  if (!parsed) {
    logVisionFailure({ tweetId, imageUrl, geminiResponse, gemmaResponse: gemmaRaw, stage: 'cerebras_parse' });
    return null;
  }
  if (parsed.parsed.type === 'ignore') {
    console.log('[Gemma→Cerebras] Cerebras flagged as non-bet/empty — returning ignore');
    return parsed.json;
  }
  console.log(`[Gemma→Cerebras] success: ${parsed.parsed.bets?.length || 0} bet(s)`);
  return parsed.json;
}

/**
 * Decide whether to invoke the Gemma vision fallback after a primary
 * (multi-provider) LLM call. Byte-equivalent to parseBetText's prior
 * inline gate; lifted out so parseBetSlipImage can share it.
 *
 * @param {string|null|undefined} raw response string from callLLMResult
 *   (may be null/undefined)
 * @param {string|null} primaryErrorClass errorClass from the first failed
 *   provider (null when raw is non-null)
 * @param {Array|undefined} parsedLegs flat array of legs extracted from
 *   raw, OR undefined when the caller didn't compute it (e.g. response
 *   wasn't a bet shape) — undefined disables the no-legs signal,
 *   matching parseBetText's prior behavior on type:"ignore"/"result".
 * @param {string|undefined} verdictType `verdictType === 'ignore'` from a
 *   Gemini Vision response on an image-bearing message forces fallback to
 *   Gemma. This intentionally reverses the prior "ignore = no fallback"
 *   stance documented above. Empirical: Hard Rock Bet slips with promo
 *   text overlay cause Gemini to return `type:'ignore'` with a reason
 *   ("Check out this bet I placed on Hard Rock Bet!") that does not match
 *   the placeholder regex, so neither hasPlaceholder nor noLegsFound
 *   fires and a real slip silently drops at PRE_FILTER_NO_BET_CONTENT.
 *   Gemma 3:4b parses these correctly (validated 2026-04-15). Only
 *   `parseBetText` passes this param; `parseBetSlipImage` does not (its
 *   sys prompt has no `type` field, and its `bets:[]` path already
 *   triggers `noLegsFound` correctly).
 * @returns {boolean}
 */
function shouldFallbackToGemma(raw, primaryErrorClass, parsedLegs, verdictType) {
  if (process.env.GEMMA_FALLBACK_DISABLED === 'true') return false;
  const rawText = typeof raw === 'string' ? raw : '';
  const hasPlaceholder = !!raw && (
    FORBIDDEN_PLACEHOLDERS.some(p => rawText.toLowerCase().includes(p))
    || /missing legs|capper hid|cannot read|cannot parse|unable to/i.test(rawText)
  );
  const noLegsFound = !!raw
    && !hasPlaceholder
    && parsedLegs !== undefined
    && (!Array.isArray(parsedLegs) || parsedLegs.length === 0);
  const adapterFallbackEligible = !raw && !!primaryErrorClass && FALLBACK_ELIGIBLE.has(primaryErrorClass);
  const ignoreVerdictWithImage = verdictType === 'ignore';
  return Boolean(adapterFallbackEligible || hasPlaceholder || noLegsFound || ignoreVerdictWithImage);
}

async function parseBetText(text, imageUrl, options = {}) {
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
${imageBase64 ? `
VISION MODE ACTIVE: A betting slip image has been attached. You MUST read the attached image to extract the exact player names, props, and lines. Combine this with the tweet text to build a perfectly accurate, bulleted list for multi-leg bets. The image is the PRIMARY source of truth — the text is supplementary context. If the image and text conflict, trust the image.

CRITICAL MULTI-EXTRACTION RULE: This image may contain MULTIPLE betting slips or a single slip with many legs. You MUST extract EVERY SINGLE LEG visible — do NOT stop at the first one. If you see 10 green checkmarks, output ALL 10 legs in the legs array. If the image contains 2 separate tickets, output 2 bet objects in the bets array. Scan the ENTIRE image top to bottom. If the ticket shows it is a "winner" (green checkmarks, "Won", "Cashed", "Settled - Won"), set ticket_status to "winner" and still extract all legs so we can auto-grade them. If it shows a loss (red X, "Lost"), set ticket_status to "loser".

LADDER DETECTION: If the image says "LADDER", "CHALLENGE", "$X to $Y", "Step X", or "Day X", set is_ladder to true and ladder_step to the visible step number (default 1). BUT you MUST still verify there is a REAL BET present — a specific team, player, or line being wagered on (e.g., "Lakers -3", "Kawhi 6+ Rebounds", "Over 220.5"). If the image only shows payouts, ladder steps, promotional graphics, or challenge text with NO specific teams/players/lines to bet on, return type "ignore" with is_bet false. Never invent placeholder picks like "$50 Ladder Challenge" — a valid pick MUST name the entity being wagered on.` : ''}

RESPONSE TYPE 1 — New Bet:
If the text contains a clear actionable bet (team/player + line/odds + prediction):

PARLAY example (multiple legs):
{"type":"bet","is_bet":true,"ticket_status":"new","bets":[{"sport":"NCAAB","league":"March Madness","bet_type":"parlay","description":"• Gonzaga -6.5\\n• Houston ML","odds":180,"units":2.0,"wager":50,"payout":90.06,"event_date":null,"legs":[{"description":"Gonzaga -6.5","odds":-110,"team":"Gonzaga","line":"-6.5","type":"spread"},{"description":"Houston ML","odds":-150,"team":"Houston","line":"ML","type":"moneyline"}],"props":[]}]}

STRAIGHT example (single bet — still use legs array with 1 entry):
{"type":"bet","is_bet":true,"ticket_status":"new","bets":[{"sport":"NBA","league":"NBA","bet_type":"straight","description":"Lakers -3.5","odds":-110,"units":1.0,"wager":null,"payout":null,"event_date":null,"legs":[{"description":"Lakers -3.5","odds":-110,"team":"Lakers","line":"-3.5","type":"spread"}],"props":[]}]}

TICKET STATUS DETECTION (CRITICAL for images):
Every response MUST include "ticket_status": "new" | "winner" | "loser".
- "new" = a standard ungraded/pending bet slip (no result indicators).
- "winner" = the image/text shows a COMPLETED WINNING bet — look for: green checkmarks (✅), "Won", "Winner", "Cashed", "Returned $", "Settled - Won", "Finished", payout amounts, green highlighting.
- "loser" = the image/text shows a COMPLETED LOSING bet — look for: red X marks (❌), "Lost", "Settled - Lost", "Loser", red highlighting.
If the ticket is "winner" or "loser", still extract ALL legs/bets from the image so we can match and grade them. Extract ALL slips if the image contains multiple tickets.

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
- STAT LINES ≠ LEGS: Pitcher win-loss records (e.g., "C. Sanchez 5-1 (83.3%)", "L. Webb 6-0 (100.0%)"), team standings, season averages, hit rates, and percentage probabilities shown in graphics are CONTEXT, NOT betting legs. A leg requires an explicit prediction with line/spread/total/odds being wagered on. NRFI/YRFI free-play graphics often show pitcher records as supporting stats — the actual bet may be a single NRFI line ("NRFI -110"), NOT the pitcher records. Never extract a leg whose description matches the shape "NAME N-N (NN%)" or "NAME N-N (NN.N%)" — that is a record display.
- If the text is a retweet (starts with "RT" or contains "Retweeted @"), a reply to a fan, or a capper celebrating someone else's win, return type "ignore".
- If you see "[Quoted]" or "Quoted @", you MUST ignore the quoted text entirely. Only evaluate the capper's original text above it.
- bet_type: straight, parlay, teaser, prop, future, ladder.
- SHEET vs PARLAY DETECTION (CRITICAL): A PARLAY is ONE wager combining multiple legs into a single outcome (all hit = win, any miss = loss) — typically shown with text like "Parlay", "X Leg Parlay", "X-Pick Parlay", combined odds (+1500), or a sportsbook ticket layout with one wager/payout total. A SHEET (or BOARD/LIST) is multiple INDEPENDENT picks shown together for convenience — typically headed with text like "MAG7", "MAGNIFICENT 7", "TOP PLAYS", "DAILY PICKS", "BOARD", "TODAY'S LOCKS", "SHEET", "PICKS OF THE DAY", or shown as a vertical list of separate lines each with their own odds and no combined parlay total. Sheet rows often span MULTIPLE SPORTS (NFL team + MLB team + NHL team in the same list) — a real parlay almost never does. If the image is a SHEET (header word like MAG7/MAGNIFICENT/BOARD/LIST OR legs span 2+ different sports), return EACH PICK as its own bet object with bet_type "straight" in the bets array — do NOT combine them into one parlay. Each straight bet gets the correct sport for ITS pick. Only use bet_type "parlay" when you can see clear ticket-style parlay framing (single wager combining legs).
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
  // Use the AdapterResult variant so we can switch on errorClass for
  // the Gemma fallback decision (P0 fix: Gemini 429 → Gemma fallback).
  const primary = await callLLMResult(text, sys, imageBase64, mediaType);
  let raw = primary.ok ? primary.value : null;
  const primaryErrorClass = primary.ok ? null : primary.errorClass;

  // ── VISION FALLBACK: Gemma 3:4b on Surface Pro ──
  // Trigger when primary failed with a fallback-eligible errorClass
  // (rate_limit, quota_exhausted, no_content, parse_fail, timeout,
  // http_5xx) OR when primary "succeeded" but content is unusable
  // (placeholder text, zero legs). Skip Gemma on AUTH/HTTP_4XX —
  // a bad API key won't be fixed by a local model and we don't want
  // to burn Surface Pro cycles on misconfig.
  if (imageBase64) {
    const rawText = typeof raw === 'string' ? raw : '';
    const hasPlaceholder = !!raw && (
      FORBIDDEN_PLACEHOLDERS.some(p => rawText.toLowerCase().includes(p))
      || /missing legs|capper hid|cannot read|cannot parse|unable to/i.test(rawText)
    );
    // Pre-parse legs only when the response is a bet shape; leave
    // undefined for type:"ignore"/"result" so the no-legs signal is
    // suppressed (matches prior behavior — those types intentionally
    // returned empty bets and must NOT trigger Gemma).
    // verdictType is captured separately so the gate can force fallback
    // on type:"ignore" with an image (HRB slip case — see gate JSDoc).
    let verdictType = undefined;
    let parsedLegs = undefined;
    if (raw && !hasPlaceholder) {
      try {
        const quick = parseJSON(raw);
        verdictType = quick?.type;
        if (quick && (quick.type === 'bet' || quick.is_bet === true)) {
          const bets = Array.isArray(quick.bets) ? quick.bets : [];
          parsedLegs = [];
          for (const b of bets) {
            if (Array.isArray(b.legs)) parsedLegs.push(...b.legs);
          }
        }
      } catch (_) {}
    }
    const adapterFallbackEligible = !raw && primaryErrorClass && FALLBACK_ELIGIBLE.has(primaryErrorClass);
    const adapterNoFallback = !raw && primaryErrorClass && !FALLBACK_ELIGIBLE.has(primaryErrorClass);
    const shouldFallback = shouldFallbackToGemma(raw, primaryErrorClass, parsedLegs, verdictType);

    if (shouldFallback) {
      const reason = adapterFallbackEligible
        ? primaryErrorClass
        : (hasPlaceholder ? 'placeholder' : (verdictType === 'ignore' ? 'ignore_verdict' : 'no_legs'));
      console.log(`[AI/slip] slip.fallback_to_gemma reason=${reason} primary_error=${primary.error || 'n/a'}`);
      const gemmaJson = await runGemmaVisionFallback({
        imageBase64,
        mediaType,
        geminiResponse: rawText,
        tweetId: options.tweetId || null,
        imageUrl: imageUrl || null,
      });
      if (gemmaJson) {
        console.log('[AI/slip] slip.fallback_to_gemma succeeded — substituting primary output');
        raw = gemmaJson;
      } else {
        console.log(`[AI/slip] slip.fallback_failed primary_reason=${reason}`);
      }
    } else if (adapterNoFallback) {
      // AUTH / HTTP_4XX / UNKNOWN — primary failed in a way Gemma can't help with.
      console.log(`[AI/slip] slip.failed_no_fallback reason=${primaryErrorClass} error=${primary.error || 'n/a'}`);
    }
  }

  if (!raw) {
    if (options.ingestId) {
      recordDrop({
        ingestId: options.ingestId,
        sourceType: options.sourceType || 'discord',
        sourceRef: options.sourceRef || null,
        stage: 'DROPPED',
        dropReason: 'TEXT_EXTRACTION_FAILED',
        payload: {
          where: 'parseBetText',
          reason: 'AI unavailable',
          errorClass: primaryErrorClass || 'unknown',
          hasImage: !!imageBase64,
        },
      });
    }
    return { bets: [], error: 'AI unavailable' };
  }
  const parsed = parseJSON(raw);
  if (!parsed) {
    if (options.ingestId) {
      recordDrop({
        ingestId: options.ingestId,
        sourceType: options.sourceType || 'discord',
        sourceRef: options.sourceRef || null,
        stage: 'DROPPED',
        dropReason: 'TEXT_EXTRACTION_FAILED',
        payload: {
          where: 'parseBetText',
          reason: 'Parse failed',
          hasImage: !!imageBase64,
        },
      });
    }
    return { bets: [], error: 'Parse failed' };
  }

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

  // Type 4: Ignore (not a bet) — handle string "false" from AI
  const isBet = parsed.is_bet === true || String(parsed.is_bet).toLowerCase() === 'true';
  if (!isBet || parsed.type === 'ignore') {
    return { type: 'ignore', is_bet: false, bets: [] };
  }

  // Type 1: Bet
  const result = applyConfidenceGating(normalizeParsedBets(parsed), text);
  result.type = 'bet';
  return result;
}

async function parseBetSlipImage(imageBase64, mediaType = 'image/png', opts = {}) {
  const sys = `Bet slip OCR expert. Recognize Hard Rock Bet, DraftKings, FanDuel, BetMGM, Caesars, Onyx.
Return ONLY JSON: {"sportsbook":"Hard Rock Bet","bets":[{"sport":"UCL","league":"Champions League","bet_type":"straight","description":"Over 1.5 1H Goals - Corum vs Erokspor","odds":130,"units":1.0,"stake_amount":14.85,"potential_payout":34.15,"legs":[]}]}
Use specific league names (UCL, EPL, La Liga, etc) not generic Soccer.
Transcribe team and player names EXACTLY as printed on the slip. Never expand a nickname to a fuller or more "official" name, and never add a city, region, or country that is not visible in the image (e.g. keep "Hanwha Eagles" — do NOT write "Hanwha Philadelphia Eagles"; keep "Samsung Lions" — do NOT write "Samsung Detroit Lions").`;

  // Image-only call: require image-capable providers. Text-only fallback
  // returns valid-looking empty-bets JSON ({"sportsbook":null,"bets":[]})
  // that makes `raw` truthy and masks the failure (P0 — 2026-05 silent-drop
  // incident). With requireImage=true, callLLMResult returns the image-tier
  // failure directly so the shared gate can route to Gemma.
  const primary = await callLLMResult('Extract all bets from this bet slip.', sys, imageBase64, mediaType, { requireImage: true });
  let raw = primary.ok ? primary.value : null;
  const primaryErrorClass = primary.ok ? null : primary.errorClass;

  // Best-effort pre-parse so the gate can detect empty-bets shapes when
  // raw is non-null (e.g. a vision provider returned {bets:[]}).
  const rawText = typeof raw === 'string' ? raw : '';
  const hasPlaceholder = !!raw && (
    FORBIDDEN_PLACEHOLDERS.some(p => rawText.toLowerCase().includes(p))
    || /missing legs|capper hid|cannot read|cannot parse|unable to/i.test(rawText)
  );
  let parsedLegs = undefined;
  if (raw && !hasPlaceholder) {
    try {
      const quick = parseJSON(raw);
      // parseBetSlipImage's sys prompt returns {sportsbook, bets:[...]} —
      // no type/is_bet field. Any shape with a bets array counts.
      if (quick && Array.isArray(quick.bets)) {
        parsedLegs = quick.bets;
      }
    } catch (_) {}
  }

  const adapterFallbackEligible = !raw && primaryErrorClass && FALLBACK_ELIGIBLE.has(primaryErrorClass);
  const adapterNoFallback = !raw && primaryErrorClass && !FALLBACK_ELIGIBLE.has(primaryErrorClass);
  // 4th arg explicitly undefined: parseBetSlipImage's sys prompt has no
  // `type` field, so ignore_verdict is unreachable here. See gate JSDoc.
  const shouldFallback = shouldFallbackToGemma(raw, primaryErrorClass, parsedLegs, undefined);

  if (shouldFallback) {
    const reason = adapterFallbackEligible ? primaryErrorClass : (hasPlaceholder ? 'placeholder' : 'no_legs');
    console.log(`[AI/slip] slip.fallback_to_gemma reason=${reason} primary_error=${primary.error || 'n/a'} where=parseBetSlipImage`);
    const gemmaJson = await runGemmaVisionFallback({
      imageBase64,
      mediaType,
      geminiResponse: rawText,
      tweetId: opts.tweetId || null,
      imageUrl: opts.imageUrl || null,
    });
    if (gemmaJson) {
      console.log('[AI/slip] slip.fallback_to_gemma succeeded (parseBetSlipImage)');
      raw = gemmaJson;
    } else {
      console.log(`[AI/slip] slip.fallback_failed primary_reason=${reason} where=parseBetSlipImage`);
    }
  } else if (adapterNoFallback) {
    // AUTH / HTTP_4XX / UNKNOWN — Gemma can't help with misconfig.
    console.log(`[AI/slip] slip.failed_no_fallback reason=${primaryErrorClass} error=${primary.error || 'n/a'} where=parseBetSlipImage`);
  }

  if (!raw) {
    if (opts.ingestId) {
      recordDrop({
        ingestId: opts.ingestId,
        sourceType: opts.sourceType || 'discord',
        sourceRef: opts.sourceRef || null,
        stage: 'DROPPED',
        dropReason: 'VISION_EXTRACTION_FAILED',
        payload: { where: 'parseBetSlipImage', reason: 'AI unavailable', errorClass: primaryErrorClass || 'unknown' },
      });
    }
    return { bets: [], error: 'AI unavailable' };
  }
  const parsed = parseJSON(raw);
  if (!parsed) {
    if (opts.ingestId) {
      recordDrop({
        ingestId: opts.ingestId,
        sourceType: opts.sourceType || 'discord',
        sourceRef: opts.sourceRef || null,
        stage: 'DROPPED',
        dropReason: 'VISION_EXTRACTION_FAILED',
        payload: { where: 'parseBetSlipImage', reason: 'Could not read slip' },
      });
    }
    return { bets: [], error: 'Could not read slip' };
  }
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

DECISION LOGIC (follow this exact order):

STEP 1 — CHECK FOR BETTING STRUCTURE FIRST:
Does the tweet contain ANY of these explicit betting signals?
  - Team/player + spread + odds (e.g., "Nuggets -3.5 (-105)")
  - Team + ML + odds (e.g., "Celtics ML +145")
  - Player + stat line with over/under (e.g., "Jokic over 28.5 -110")
  - Parlay with 2+ legs that have lines or odds (e.g., "+1009 NRFI Parlay")
  - Sportsbook odds format (e.g., "+5097 odds", "(+210)")
  - Units stated (e.g., "5u", "3 units")
If YES → this is a VALID pick. Parse it. Do NOT reject just because celebration words like "LOCK", "BANG", "BOOM", "Dinger", "let's go", "keep rolling" are also present. Cappers commonly mix hype language with real picks.

STEP 2 — ONLY if no betting structure found, check for rejection:
  - Pure celebration with NO odds/line/spread: "Nice W on X!", "BOOM another cash!" → NULL
  - Past results/recaps: "X/Y record", "win rate", "this week" → NULL
  - Marketing: "VIP", "RT & reply", "Discount", "Subscribe" → NULL
  - Motivational only: "Let's have fun", "Happy Monday", "Foot on the gas" → NULL
  - Player name with NO line, NO odds → NULL

STEP 3 — SETTLED CHECK:
  - If ALL picks have ✅ checkmarks next to them → NULL (settled recap, not new picks)
  - If SOME picks have no checkmarks → VALID (parse the unsettled ones)

Return {"status": "NULL"} if rejected, or extract into this JSON if valid:
{
  "status": "VALID",
  "sport": "NBA/NFL/MLB/etc",
  "type": "straight/parlay/prop",
  "description": "Cleaned up pick",
  "odds": "-110 or N/A",
  "units": 1,
  "legs": [{"description": "Leg text", "odds": -110}],
  "is_ladder": false,
  "ladder_step": 0
}
For parlays, populate legs. For straights, use a single-entry legs array.

LADDER DETECTION: A ladder is multiple INDEPENDENT straight bets on the same player at escalating lines (e.g., "Player 5+ Ks (-195) 4u, Player 6+ Ks (+115) 3u, Player 7+ Ks (+210) 2u"). A ladder is NOT a parlay — each step stands alone.

If the tweet contains "Ladder", "🪜", or lists the same player at multiple escalating stat lines with different odds/units, return:
{
  "status": "VALID",
  "is_ladder": true,
  "sport": "MLB",
  "ladder_steps": [
    {"description": "Bubba Chandler 5+ Ks", "odds": -195, "units": 4, "ladder_step": 1},
    {"description": "Bubba Chandler 6+ Ks", "odds": 115, "units": 3, "ladder_step": 2},
    {"description": "Bubba Chandler 7+ Ks", "odds": 210, "units": 2, "ladder_step": 3}
  ]
}
Each step MUST have its own description, odds, and units. Extract ALL steps visible — do not stop at the first one. If it's a simple challenge ("$25 to $1000 Step 3") with only one pick, use the normal single-bet format with is_ladder: true and ladder_step: 3.`;

    const response = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
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

// ── Centralized pre-filter: reject settled recaps before hitting AI ──
// Returns 'valid', 'reject_settled', or 'reject_recap'
// CRITICAL: Settled check runs FIRST, before structure check
function evaluateTweet(text) {
  const STRUCTURE = [
    /[+-]\d{3,}/,                          // odds: +150, -110, +5097
    /\b\d+\.?\d*\s*u\b/i,                 // units: 5u
    /\b\d+\s*units?\b/i,                  // "3 units"
    /\b(over|under|o|u)\s*\d+\.?\d*/i,    // over/under
    /[+-]\d+\.?\d*\s*\(/,                 // spread with parens: -3.5 (-110)
    /\b\w+\s+(ml|moneyline)\b/i,          // team ML
    /\b(parlay|sgp|same game|nrfi|yrfi)\b/i, // parlay/prop types
    /\(\s*[+-]\d{3,}\s*\)/,               // odds in parens: (+145)
    /\b[A-Z][a-z]+\s+[+-]\d+\.?\d*/,      // "Lakers -3.5"
    /\bML\s*[+-]\d+/i,                    // "ML +145"
    /\d+\.5\b/,                            // half-point lines: 22.5, 3.5
  ];

  console.log(`[evaluateTweet] Called | len=${text.length} | "${text.slice(0, 80)}..."`);

  // ── STEP 0: Junk/promo pattern rejection (no AI cost) ──
  const JUNK_PATTERNS = [
    /\d+\s+PASSES?\s+LEFT/i,              // "5 PASSES LEFT" — subscription sales
    /\bcard\s+break\b/i,                   // Whatnot card break streams
    /premium\s+social\s+sportsbook/i,      // LockedIn promo template
    /\bonyx\s+odds\b/i,                    // Onyx Odds promo
    /\btwo\s+independent\s+picks\b/i,      // vague placeholder
    /MISSING LEGS|hid the picks/i,         // AI placeholder text
  ];
  if (JUNK_PATTERNS.some(p => p.test(text))) {
    console.log(`[evaluateTweet] JUNK REJECTED: "${text.slice(0, 60)}..."`);
    return 'reject_recap';
  }
  // Reject tweets that are >50% URL by character count
  const urlChars = (text.match(/https?:\/\/\S+/g) || []).join('').length;
  if (text.length > 10 && urlChars / text.length > 0.5) {
    console.log(`[evaluateTweet] URL-HEAVY REJECTED: ${Math.round(urlChars / text.length * 100)}% URLs`);
    return 'reject_recap';
  }

  // Settled markers — emoji + word forms. Word forms protect against scrapers
  // that strip emoji (mobile-ingest dropped ✅🔨 from bobby__tracker tweet 2049590413560893485).
  // `(?!')` on `won` avoids matching "won't".
  const SETTLED_MARKERS = /✅|❌|⚪|✔|✓|☑|🔨|\bwon\b(?!')|\blost\b|\bpush(?:ed)?\b|\bcashed\b/i;

  // Celebration headers that indicate this is a recap of settled bets
  const WIN_HEADERS = [
    /^WAY\s+TOO\s+EASY\b/i,                // "WAY TOO EASY"
    /^TOO\s+EASY\b/i,                      // "TOO EASY"
    /^\d+-\d+\s+(ON|on)\s+\w+/,            // "1-0 ON UCL"
    /^STOP\s+PLAYING/i,                    // "STOP PLAYING WITH ME"
    /^BAANGG+|^BANG\b/i,                   // "BAANGGGG" / "BANG"
    /^CASH(ED)?\b/i,                       // "CASHED"
    /^WHAT\s+A\s+(NIGHT|DAY|WIN)/i,        // "What a night"
    /^EASY\s+(W|MONEY|WIN)/i,              // "Easy W"
    /^BOOM+/i,                             // "BOOOM"
    /^LET'?S\s+(GO|F+ING\s+GO)/i,          // "LET'S GO" / "LFG"
    /^HUGE\s+(W|WIN)/i,                    // "HUGE W"
    /^TRUST\s+ME\b/i,                      // "TRUST ME"
    /\d+\s+(for|of)\s+\d+\s+(today|tonight|yesterday)/i, // "4 for 5 today"
  ];

  // Strong recap headers — unambiguously retrospective phrases.
  // Trigger reject_settled even WITHOUT an explicit settled marker, because
  // the production scraper strips emoji. Conservative subset of WIN_HEADERS:
  // pre-bet hype phrases (BANG, LET'S GO, TRUST ME, HUGE W, EASY W) are NOT here.
  const STRONG_RECAP_HEADERS = [
    /^WAY\s+TOO\s+EASY\b/i,
    /^TOO\s+EASY\b/i,
    /^STOP\s+PLAYING/i,
    /^CASH(ED)?\b/i,
    /^\d+-\d+\s+(ON|on)\s+\w+/,
    /^WHAT\s+A\s+(NIGHT|DAY|WIN)/i,
    /\d+\s+(for|of)\s+\d+\s+(today|tonight|yesterday)/i,
    // P1a-ext (rbssportsplays "GOOD MORNING!!!! WAKE & CASH IT!!!!" class) —
    // ✅ markers stripped by scraper, so we lean on celebration verbiage.
    /\bWAKE\s*[&+]?\s*CASH\b/i,                  // "WAKE & CASH" / "WAKE CASH" / "WAKE+CASH"
    /\bDELIVER(?:S|ED|ING)?\s+GREATNESS\b/i,      // "DELIVERS GREATNESS" / "DELIVERED GREATNESS"
    /\bKING\s+DELIVERS\b/i,                       // "KING DELIVERS"
    /^ATP\s+KING\b/i,                              // "ATP KING"
    /^GOOD\s+MORNING\b.*!{2,}/i,                  // "GOOD MORNING!!" — generic alone, retrospective with multiple !s
    /^LET'?S\s+(?:F\W*\w*\s+)?DANCE\b.*!{2,}/i,  // "LET'S DANCE!!" / "LET'S F*CKING DANCE!!"
  ];

  const lines = text.split(/[\n]+/).map(l => l.trim()).filter(l => l.length > 0);
  const bettingLines = lines.filter(l => STRUCTURE.some(p => p.test(l)));
  const settledLines = bettingLines.filter(l => SETTLED_MARKERS.test(l));

  // ── STEP 1: SETTLED CHECK (runs before structure check) ──
  if (bettingLines.length > 0 && settledLines.length === bettingLines.length) {
    console.log(`[evaluateTweet] REJECT SETTLED: all ${bettingLines.length} betting line(s) have settled markers | "${text.slice(0, 60)}..."`);
    return 'reject_settled';
  }

  // Celebration header + ANY settled marker = settled recap
  const firstLine = lines[0] || '';
  const hasWinHeader = WIN_HEADERS.some(p => p.test(firstLine));
  if (hasWinHeader && settledLines.length > 0) {
    console.log(`[evaluateTweet] REJECT SETTLED (celebration header + ✅): "${firstLine.slice(0, 40)}..." | ${settledLines.length} settled`);
    return 'reject_settled';
  }

  // Strong retrospective header alone (covers scraper-stripped emoji) = settled recap
  const hasStrongRecapHeader = STRONG_RECAP_HEADERS.some(p => p.test(firstLine));
  if (hasStrongRecapHeader && bettingLines.length > 0) {
    console.log(`[evaluateTweet] REJECT SETTLED (strong recap header alone): "${firstLine.slice(0, 40)}..." | bettingLines=${bettingLines.length}`);
    return 'reject_settled';
  }

  // ── STEP 2: STRUCTURE CHECK ──
  const hasBettingStructure = bettingLines.length > 0;
  if (hasBettingStructure) {
    console.log(`[evaluateTweet] ✅ VALID: ${bettingLines.length} betting line(s), ${settledLines.length} settled | "${text.slice(0, 60)}..."`);
    return 'valid';
  }

  console.log(`[evaluateTweet] ❌ NO STRUCTURE: "${text.slice(0, 60)}..."`);
  return 'reject_recap';
}

// ═══════════════════════════════════════════════════════════════
// Anti-hallucination post-parse validation
// ═══════════════════════════════════════════════════════════════

const SPORT_SEASONS = {
  'NFL':   { start: [9, 1], end: [2, 15] },
  'NCAAF': { start: [8, 15], end: [1, 15] },
  'NBA':   { start: [10, 15], end: [6, 30] },
  'NCAAB': { start: [11, 1], end: [4, 10] },
  'MLB':   { start: [3, 20], end: [11, 5] },
  'NHL':   { start: [10, 1], end: [6, 30] },
  'WNBA':  { start: [5, 1], end: [10, 31] },
};

function isInSeason(sport) {
  const season = SPORT_SEASONS[sport?.toUpperCase()];
  if (!season) return true; // Unknown/year-round sports pass
  const now = new Date();
  const m = now.getMonth() + 1, d = now.getDate();
  const [sm, sd] = season.start, [em, ed] = season.end;
  // Handle year-wrap (e.g., NFL Sep→Feb)
  if (sm <= em) return (m > sm || (m === sm && d >= sd)) && (m < em || (m === em && d <= ed));
  return (m > sm || (m === sm && d >= sd)) || (m < em || (m === em && d <= ed));
}

const FORBIDDEN_PLACEHOLDERS = [
  'missing legs', 'capper hid the picks', 'in a link or missing image',
  'unknown pick', 'tbd', 'placeholder', 'no picks found',
];

// Sport reclassification — catch misclassified sports at intake
const SPORT_TEAM_MAP = {
  'MLB': ['yankees','red sox','dodgers','cubs','pirates','reds','brewers','phillies','mets','braves','astros','rangers','mariners','angels','royals','tigers','twins','white sox','guardians','blue jays','rays','orioles','rockies','padres','diamondbacks','cardinals','nationals','marlins','giants'],
  'NBA': ['lakers','celtics','warriors','heat','knicks','bulls','nets','rockets','spurs','suns','clippers','thunder','nuggets','jazz','blazers','kings','cavaliers','cavs','pistons','pacers','bucks','sixers','hawks','hornets','magic','wizards','raptors','timberwolves','grizzlies','mavs','mavericks','pelicans'],
  'NFL': ['chiefs','rams','eagles','cowboys','giants','jets','patriots','dolphins','bills','steelers','ravens','browns','bengals','colts','titans','jaguars','texans','broncos','raiders','chargers','vikings','packers','bears','lions','seahawks','49ers','saints','falcons','panthers','buccaneers','bucs','commanders','cardinals'],
  'NHL': ['rangers','islanders','devils','bruins','canadiens','maple leafs','senators','sabres','panthers','lightning','capitals','penguins','flyers','blue jackets','red wings','blackhawks','wild','blues','predators','stars','avalanche','golden knights','kings','ducks','sharks','kraken','oilers','flames','canucks','hurricanes','jets'],
  'SOCCER': ['manchester united','man utd','manchester city','man city','liverpool','chelsea','arsenal','tottenham','spurs','real madrid','barcelona','atletico madrid','bayern munich','dortmund','psg','paris saint-germain','juventus','inter milan','ac milan','napoli','roma','lafc','la galaxy','inter miami','nycfc','goalie saves','goal scorer','anytime scorer','both teams to score','btts','corners','yellow cards','clean sheet'],
  'TENNIS': ['australian open','french open','wimbledon','us open','atp','wta','masters 1000','total games','sets won','aces','double faults','break points','straight sets','fantasy score'],
  'GOLF': ['masters','pga championship','open championship','ryder cup','top 5 finish','top 10 finish','top 20 finish','make the cut','miss the cut','hole-in-one','tournament winner','first-round leader'],
  'MMA': ['wins by ko','wins by tko','wins by submission','wins by decision','fight goes the distance','round over','round under','ufc'],
};

// Market / wager-type phrases that are NOT teams. Some of these also live inside
// SPORT_TEAM_MAP (e.g. SOCCER's "both teams to score", "btts", "corners", "clean
// sheet") because they are useful *sport* signals for inferLegSport /
// reclassifySport — a "both teams to score" leg is almost certainly soccer. But
// the cross-sport contradiction check in validateLegSportConsistency must NEVER
// treat a market phrase as a TEAM: a leg like "USA / Paraguay both teams to
// score NO" has no real team token, so matching the market phrase as a "soccer
// team" and then DROPPING the leg because the declared parlay sport is "Unknown"
// is a false positive (live drop 2026-06-12, pipeline_events 71398, GNP —
// fired 5× on 06-12, 1× on 06-11).
//
// isMarketPhrase is checked against a *matched SPORT_TEAM_MAP keyword*, so only
// entries that ALSO appear in SPORT_TEAM_MAP are load-bearing today — those are
// the SOCCER prop phrases (the live-drop class). The remaining generic wager
// types ("moneyline"/"spread"/"over"/… ) are NOT in SPORT_TEAM_MAP, so they
// never produce a team match and are currently INERT — kept as the spec's
// required vocabulary and as a guard if any are later added to SPORT_TEAM_MAP.
// (TENNIS/GOLF/MMA prop phrases in SPORT_TEAM_MAP are intentionally left as
// sport signals — out of this fix's soccer scope; see PR "known limitations".)
const MARKET_PHRASE_EXCLUSIONS = new Set([
  // ── load-bearing: also in SPORT_TEAM_MAP's SOCCER list (markets, not clubs) ──
  'both teams to score', 'btts', 'corners', 'clean sheet',
  'goalie saves', 'goal scorer', 'anytime scorer', 'yellow cards',
  // ── spec-required market vocabulary; inert today (not in SPORT_TEAM_MAP), kept
  //    for completeness + forward-compatibility ──
  'moneyline', 'spread', 'total', 'over', 'under',
  'double chance', 'total goals', 'draw no bet', 'tie no bet',
  'anytime goalscorer', '1st half', 'cards',
]);

function isMarketPhrase(token) {
  return MARKET_PHRASE_EXCLUSIONS.has(String(token == null ? '' : token).toLowerCase());
}

// SPORT_TEAM_MAP keys are upper-cased ('SOCCER'); detectSport and the rest of
// the pipeline use the canonical mixed-case label ('Soccer'). Map an adopted
// sport to that canonical form so an Unknown→adopted bet stores the same sport
// string a directly-detected one would. NBA/NFL/MLB/NHL are identical in both;
// the `|| key` fallback keeps adoption safe if a new SPORT_TEAM_MAP key is added.
const SPORT_TEAM_MAP_CANONICAL = {
  MLB: 'MLB', NBA: 'NBA', NFL: 'NFL', NHL: 'NHL',
  SOCCER: 'Soccer', TENNIS: 'Tennis', GOLF: 'Golf', MMA: 'MMA',
};

// Action / prop keywords that uniquely identify a sport when no team name
// is present in the leg description. Lowercase, substring-matched. Keep
// this list conservative: keywords here must NOT appear in other sports.
// Multi-sport ambiguous terms (e.g. "saves" — NHL goalies AND soccer
// goalkeepers) are intentionally excluded. If a leg description would
// match multiple sports here, the iteration order picks the first sport
// listed in the map, so order entries by specificity.
//
// Added 2026-05-13 in response to cross-sport contamination in slip-
// receipts: Karl-Anthony Towns / Jaylen Brown / Bam Adebayo / Evan Mobley
// legs in an MLB parlay (Dan, 2026-04-10). Each leg was a "Double Double"
// or "PRA" prop that inferLegSport could not classify because the strings
// contain no team names. With this map, those legs route to NBA evidence
// search instead of falling back to the parlay's declared sport.
const SPORT_ACTION_MAP = {
  'NBA': [
    'double double',
    'triple double',
    'pra',
    'pras',
    'pts + reb + ast',
    'pts+reb+ast',
    'points + rebounds + assists',
    'rebounds + assists',
    'reb + ast',
    'three-pointers',
    'three pointers',
    '3-pointers',
    '3pt made',
    '3ptm',
  ],
  'MLB': [
    'hits+runs+rbis',
    'hits + runs + rbis',
    'hits+runs+rbi',
    'hits + runs + rbi',
    'h+r+rbi',
    'h + r + rbi',
    'total bases',
    'pitching outs',
    'pitches thrown',
    'strikeouts thrown',
    'hitter fs',
    'pitcher fs',
    'rbis',
    'home runs',
    'hit a home run',
  ],
  'NHL': [
    'shots on goal',
    'sog',
    'any time goal scorer',
    'anytime goal scorer',
    'shots on net',
  ],
};

function reclassifySport(parsedSport, description) {
  // P1 Bug 2: a recognized (nickname, full-city) pair forces the sport. This
  // overrides the multi-sport "keep original" no-op below (a shared nickname
  // matches >=2 sports in SPORT_TEAM_MAP, so without this it never reclassed).
  const forced = disambiguateAmbiguousTeam(description);
  if (forced) return forced;
  console.log(`[Guard:Reclassify] Checking sport=${parsedSport} desc="${(description || '').slice(0, 60)}"`);
  const desc = (description || '').toLowerCase();
  const matchedSports = new Set();

  for (const [sport, keywords] of Object.entries(SPORT_TEAM_MAP)) {
    for (const kw of keywords) {
      if (desc.includes(kw)) { matchedSports.add(sport); break; }
    }
  }

  // Multi-sport parlay — never reclassify, keep original
  if (matchedSports.size > 1) {
    console.log(`[Guard:Reclassify] Multi-sport detected: [${[...matchedSports].join(',')}] — keeping ${parsedSport}`);
    return parsedSport;
  }

  // Single different sport detected — reclassify
  if (matchedSports.size === 1) {
    const detected = [...matchedSports][0];
    if (detected !== (parsedSport || '').toUpperCase()) {
      console.log(`[Guard:Reclassify] Reclassified: ${parsedSport} → ${detected}`);
      return detected;
    }
  }

  return parsedSport;
}

// Infer sport from a single leg description
function inferLegSport(legDescription) {
  // P1 Bug 2: city-aware disambiguation precedes the (oppositely-ordered)
  // SPORT_TEAM_MAP scan below, so a lone shared nickname + a known city
  // resolves consistently with detectSport instead of MLB-first.
  const forced = disambiguateAmbiguousTeam(legDescription);
  if (forced) return forced;
  const desc = (legDescription || '').toLowerCase();
  // Team-name keywords first — these are the strongest signal (whole
  // franchise names rarely false-match).
  for (const [sport, keywords] of Object.entries(SPORT_TEAM_MAP)) {
    for (const kw of keywords) {
      if (desc.includes(kw)) return sport;
    }
  }
  // Action / prop keywords as a secondary signal for player-only legs
  // that have no team name in the description (e.g. "Karl-Anthony Towns
  // To Record A Double Double"). Iteration order in SPORT_ACTION_MAP
  // determines tie-breaking.
  for (const [sport, keywords] of Object.entries(SPORT_ACTION_MAP)) {
    for (const kw of keywords) {
      if (desc.includes(kw)) return sport;
    }
  }
  return null;
}

// ── KBO (Korean Baseball Organization) awareness ────────────────────────────
// KBO is NOT modeled in SPORT_TEAM_MAP (which holds only NBA/NFL/MLB/NHL/…), and
// six of its ten clubs share a nickname with a US franchise — Eagles/Tigers/
// Twins/Lions/Giants/Bears. So a perfectly clean "Hanwha Eagles +1.5" leg in a
// declared-KBO parlay would mis-fire leg_sport_mismatch ("eagles" → NFL ∉ {KBO})
// and the whole slip would be dropped (incident 2026-06-11, ingest
// disc_1514481735335805030). The corporate SPONSOR that prefixes every KBO club
// name (Hanwha/Kia/LG/SSG/Samsung/KT/Lotte/Kiwoom/Doosan/NC — mirrors
// services/normalization.js KBO_SPONSOR_PREFIX) is the decisive signal that the
// club is Korean, not American.
//
// This also defends the observed Vision corruption where a US city is injected
// between the sponsor and the nickname ("Hanwha Philadelphia Eagles", "Samsung
// Detroit Lions"): the sponsor still wins, and normalizeKboLeg strips the
// injected city so the stored description is the verbatim Korean club name.
const KBO_TEAMS = [
  { sponsor: 'hanwha',  nickname: 'eagles'  },
  { sponsor: 'kia',     nickname: 'tigers'  },
  { sponsor: 'lg',      nickname: 'twins'   },
  { sponsor: 'ssg',     nickname: 'landers' },
  { sponsor: 'samsung', nickname: 'lions'   },
  { sponsor: 'kt',      nickname: 'wiz'     },
  { sponsor: 'lotte',   nickname: 'giants'  },
  { sponsor: 'kiwoom',  nickname: 'heroes'  },
  { sponsor: 'doosan',  nickname: 'bears'   },
  { sponsor: 'nc',      nickname: 'dinos'   },
];

// Per-club regex: the sponsor, then 0–2 intervening words (an injected US city
// such as "Philadelphia" or "San Francisco"), then the club's own nickname. The
// pairing of sponsor + matching nickname is what makes this safe — a bare 2-char
// sponsor token like "NC" or "KT" never matches on its own (it must be followed
// by "Dinos"/"Wiz"), so US strings like "NC State" can't false-positive. The
// intervening group is captured so normalizeKboLeg can drop exactly the injected
// city while preserving the rest of the leg (line/odds). Cached on the fn.
function _kboTeamMatchers() {
  if (!_kboTeamMatchers._cache) {
    _kboTeamMatchers._cache = KBO_TEAMS.map(({ sponsor, nickname }) => ({
      sponsor,
      nickname,
      re: new RegExp(`\\b(${sponsor})\\b((?:\\s+[A-Za-z.]+){0,2}?)\\s+(${nickname})\\b`, 'i'),
    }));
  }
  return _kboTeamMatchers._cache;
}

// True when the description names a KBO club (clean "Hanwha Eagles" OR the
// city-injected corruption "Hanwha Philadelphia Eagles"). Used by the
// leg-sport-consistency validator to pass a KBO leg under a declared-KBO parlay
// before the US-league nickname scan can mis-fire.
function matchesKboTeam(description) {
  const d = String(description == null ? '' : description);
  return _kboTeamMatchers().some(({ re }) => re.test(d));
}

// Strip a US city/region that Vision (or any upstream) injected between a KBO
// sponsor and its nickname: "Hanwha Philadelphia Eagles +1.5" → "Hanwha Eagles
// +1.5". Casing of the real sponsor/nickname tokens is preserved verbatim; only
// the intervening words are dropped. A description that names no KBO club, or a
// clean KBO club with nothing injected, is returned BYTE-IDENTICAL.
function normalizeKboLeg(description) {
  let out = String(description == null ? '' : description);
  for (const { re } of _kboTeamMatchers()) {
    out = out.replace(re, (full, sponsor, mid, nickname) =>
      (mid && mid.trim()) ? `${sponsor} ${nickname}` : full);
  }
  return out;
}

// The declared parlay sport is treated as a SET (split on / & ,) exactly like
// validateLegSportConsistency, so a compound declaration like "MLB/KBO" counts
// as KBO too. Used to gate KBO leg-cleanup so non-KBO parlays are untouched.
function declaredSportIncludesKbo(parlaySport) {
  return String(parlaySport || '')
    .toUpperCase()
    .split(/[\/&,]/)
    .map((s) => s.trim())
    .includes('KBO');
}

function validateParsedBet(pick, sourceText, opts = {}) {
  const issues = [];
  const desc = (pick.description || '').toLowerCase();
  const src = (sourceText || '').toLowerCase();
  const hasMedia = !!opts.hasMedia;

  // Slip-share exemption: image attachments OR slip-shape patterns mean the
  // actual bet content lives outside the message text. Source-text-based
  // entity and brand checks would false-positive in those cases. Apply
  // consistently to both checks below.
  const slipShape = looksLikeSlipShare(pick.description) || looksLikeSlipShare(sourceText);
  const slipExempt = slipShape || hasMedia;

  // Emit a DROP when callers supply an ingestId so observability can
  // attribute the rejection without duplicating logic upstream.
  const maybeDrop = (reason, dropReason, extra = {}) => {
    if (!opts.ingestId) return;
    recordDrop({
      ingestId: opts.ingestId,
      sourceType: opts.sourceType || 'discord',
      sourceRef: opts.sourceRef || null,
      stage: 'DROPPED',
      dropReason,
      payload: { validator: reason, issues, description: (pick.description || '').slice(0, 120), ...extra },
    });
  };

  // Check forbidden placeholders
  if (FORBIDDEN_PLACEHOLDERS.some(p => desc.includes(p))) {
    issues.push(`Placeholder text: "${desc.slice(0, 60)}"`);
    maybeDrop('placeholder', 'BOUNCER_REJECTED');
    return { valid: false, issues, reason: 'placeholder' };
  }

  // Check sport seasonality
  if (pick.sport && !isInSeason(pick.sport)) {
    issues.push(`${pick.sport} is out of season`);
    maybeDrop('offseason', 'BOUNCER_REJECTED', { sport: pick.sport });
    return { valid: false, issues, reason: 'offseason' };
  }

  // P1c: pitcher-record / stat-line legs — vision misread NAME N-N (NN%)
  // displays as betting legs. Live repro: bet 7d96e21d1b1870f0ddb854613a417a77,
  // @NRFIAnalytics 2026-04-30, "• C. Sanchez 5-1 (83.3%)\n• L. Webb 6-0 (100.0%)".
  // Runs before entity_mismatch so its more-specific telemetry wins.
  if (pick.legs && pick.legs.length > 0) {
    for (const leg of pick.legs) {
      const shapeCheck = validateLegShape(leg);
      if (!shapeCheck.valid) {
        issues.push(shapeCheck.reason);
        maybeDrop('leg_shape_invalid', 'VALIDATOR_LEG_SHAPE_INVALID', { leg: leg?.description?.slice(0, 80) });
        return { valid: false, issues, reason: 'leg_shape_invalid' };
      }
    }
  }
  {
    const descCheck = validateLegShape({ description: pick.description });
    if (!descCheck.valid) {
      issues.push(descCheck.reason);
      maybeDrop('leg_shape_invalid', 'VALIDATOR_LEG_SHAPE_INVALID', { description: (pick.description || '').slice(0, 120) });
      return { valid: false, issues, reason: 'leg_shape_invalid' };
    }
  }

  // Cross-reference: check that key entities in parsed bet appear in source.
  // Skipped under slipExempt — for image-bearing or slip-shape posts the bet
  // content lives outside sourceText, so vision-extracted entities won't be
  // present and this check would false-positive (VALIDATOR_ENTITY_MISMATCH
  // was the largest "missed slips" bucket — 98 hits/7d before this fix).
  if (!slipExempt && src.length > 10 && desc.length > 10) {
    // Extract significant words from description (4+ chars, not common betting terms)
    const betWords = desc.match(/\b[a-z]{4,}\b/g) || [];
    const NOISE = new Set(['over', 'under', 'moneyline', 'spread', 'parlay', 'straight', 'units', 'pick', 'lock', 'play', 'game', 'total', 'points', 'tonight', 'today', 'first', 'half', 'quarter', 'goal', 'assist', 'score', 'more', 'less', 'with']);
    const keyWords = betWords.filter(w => !NOISE.has(w) && w.length >= 4);

    // At least one key entity word should appear in source
    if (keyWords.length >= 2) {
      const matchCount = keyWords.filter(w => src.includes(w)).length;
      if (matchCount === 0) {
        issues.push(`No key entities from bet found in source text. Bet words: [${keyWords.slice(0, 5).join(', ')}]`);
        maybeDrop('entity_mismatch', 'VALIDATOR_ENTITY_MISMATCH', { keyWords: keyWords.slice(0, 5) });
        return { valid: false, issues, reason: 'entity_mismatch' };
      }
    }
  }

  // Bug B: Sportsbook brand names parsed as bets.
  //
  // EXEMPTION: slip-share tweets ("PrizePicks 40x slip", "Betr 10x slip")
  // and image-only slip shares mention the brand but are real bets. Skip
  // the brand rejection under slipExempt (slip-shape pattern OR has_media).
  // Brand-only promo tweets without slip indicators and without media still
  // reject.
  if (isSportsbookBrand(pick.description)) {
    if (slipExempt) {
      const exemptSample = sourceText || pick.description || '';
      console.log(`[validateParsedBet] BRAND EXEMPT: ${slipShape ? 'slip pattern' : 'has_media'} detected — passing to extraction | "${String(exemptSample).slice(0, 60)}..."`);
    } else {
      issues.push(`Description matches sportsbook brand name`);
      maybeDrop('sportsbook_brand', 'BOUNCER_REJECTED');
      return { valid: false, issues, reason: 'sportsbook_brand' };
    }
  }
  if ((pick.sport === 'Unknown' || !pick.sport) && /sportsbook/i.test(desc)) {
    if (slipExempt) {
      const exemptSample = sourceText || pick.description || '';
      console.log(`[validateParsedBet] BRAND EXEMPT: ${slipShape ? 'slip pattern' : 'has_media'} detected — passing to extraction | "${String(exemptSample).slice(0, 60)}..."`);
    } else {
      issues.push(`Unknown sport with sportsbook keyword`);
      maybeDrop('sportsbook_brand', 'BOUNCER_REJECTED');
      return { valid: false, issues, reason: 'sportsbook_brand' };
    }
  }

  // KBO defensive normalization: when the parlay declares KBO, strip any US city
  // that Vision injected between a KBO sponsor and its (US-shared) nickname so
  // the STORED description/legs carry the verbatim Korean club name ("Hanwha
  // Philadelphia Eagles" → "Hanwha Eagles"). Gated on declared-KBO so non-KBO
  // parlays are byte-identical (a real "Philadelphia Eagles" NFL pick is never
  // touched). Runs before the leg-sport loop, which is itself KBO-aware below.
  if (declaredSportIncludesKbo(pick.sport)) {
    if (typeof pick.description === 'string') {
      const cleanedDesc = normalizeKboLeg(pick.description);
      if (cleanedDesc !== pick.description) pick.description = cleanedDesc;
    }
    if (pick.legs && pick.legs.length > 0) {
      for (const leg of pick.legs) {
        if (!leg || typeof leg.description !== 'string') continue;
        const cleanedLeg = normalizeKboLeg(leg.description);
        if (cleanedLeg !== leg.description) leg.description = cleanedLeg;
      }
    }
  }

  // Bug A: Wrong-sport team contamination in parlay legs
  if (pick.legs && pick.legs.length > 0 && pick.sport) {
    const adoptedSports = new Set();
    for (const leg of pick.legs) {
      const legCheck = validateLegSportConsistency(leg, pick.sport);
      if (!legCheck.valid) {
        issues.push(legCheck.reason);
        maybeDrop('leg_sport_mismatch', 'VALIDATOR_SPORT_MISMATCH', { leg: leg?.description?.slice(0, 80) });
        return { valid: false, issues, reason: 'leg_sport_mismatch' };
      }
      if (legCheck.adoptedSport) adoptedSports.add(legCheck.adoptedSport);
    }
    // Unknown-sport adoption: a placeholder declaration ("Unknown"/"N/A"/…) whose
    // legs unanimously signal ONE sport adopts it, so the bet grades under the
    // right sport instead of as Unknown (and is no longer dropped as a wrong-sport
    // mismatch). In-place reassignment mirrors the twitter path's reclassifySport
    // (services/twitter-handler.js:246); the value flows to storage via
    // createBetWithLegs({ sport: bet.sport }). Mixed/empty signals leave it as-is.
    if (isSportPlaceholder(pick.sport) && adoptedSports.size === 1) {
      pick.sport = [...adoptedSports][0];
    }
  }

  return { valid: true, issues };
}

// P1c: Pitcher win-loss records and stat-line displays misread as betting legs.
// Shape: "NAME N-N (NN%)" or "NAME N-N (NN.N%)" — distinctive because real
// betting markers (American odds, units, ML, spread, over/under) never combine
// digit-dash-digit with a parenthesized percentage.
const PITCHER_RECORD_PATTERN = /\b\d+-\d+\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/;

function validateLegShape(leg) {
  const desc = leg?.description || '';
  if (!desc) return { valid: true };
  if (PITCHER_RECORD_PATTERN.test(desc)) {
    console.log(`[Parser] PITCHER-RECORD LEG REJECTED: "${desc.slice(0, 80)}"`);
    return { valid: false, reason: `Leg looks like a pitcher win-loss / stat-line display ("N-N (NN%)"), not a betting leg: "${desc.slice(0, 80)}"` };
  }
  return { valid: true };
}

// Bug A: Validate that parlay legs don't contain teams from wrong sports.
// Multi-sport team names (Giants, Cardinals, Rangers, Panthers, Jets, Kings) live in
// multiple sport lists — fire only when NONE of the matched sports is the declared sport.
function validateLegSportConsistency(leg, parlaySport) {
  const desc = (leg.description || '').toLowerCase();
  // A declared sport may be COMPOUND for multi-sport parlays, e.g. "MLB/NHL"
  // (also seen with "&" or "," separators). Treat the declaration as a SET of
  // sports: a leg is consistent if its team's sport is ANY one of the declared
  // sports. A single-sport declaration splits to a one-element set, so its
  // behavior is identical to the previous exact-key match. Live drop fixed:
  // ingest twit_2064504565593219458 (7-leg LockedIn parlay, sport "MLB/NHL",
  // marlins leg) was self-contradictorily rejected because "MLB/NHL" never
  // equalled the single key "MLB".
  const declaredSet = new Set(
    (parlaySport || '')
      .toUpperCase()
      .split(/[\/&,]/)
      .map(s => s.trim())
      .filter(Boolean)
  );
  // Unmodeled-league declarations: when EVERY declared element names a league
  // we don't model (KBO, KHL, NPB, Soccer, … — complement of teams.json keys,
  // same canonicalization as shouldExpandAliases/#85), skip leg-team matching
  // entirely. SPORT_TEAM_MAP covers only the modeled US leagues, so a nickname
  // hit under such a declaration can only be a same-nickname foreign club, not
  // cross-sport contamination — the scan below can ONLY false-positive there;
  // war-room review is the gate for unmodeled slips. Live repro: ingest
  // disc_1514481735335805030 (declared "KBO", "Hanwha Eagles +1.5 / SSG Landers
  // +1.5 / Samsung Lions ML") re-dropped VALIDATOR_SPORT_MISMATCH on every
  // hold-recovery retry because "eagles" resolves to NFL ∉ {KBO}. Placeholders
  // ("Unknown") and declarations with ANY modeled element ("MLB/KBO",
  // generic "Baseball") keep full validation — nothing else is loosened.
  if (declaresOnlyUnmodeledLeagues(parlaySport)) return { valid: true };
  // KBO awareness: KBO clubs aren't in SPORT_TEAM_MAP and six of them share a US
  // nickname (Eagles/Tigers/Twins/Lions/Giants/Bears). When the parlay declares
  // KBO and the leg names a KBO club (sponsor prefix is decisive), pass BEFORE
  // the US-league scan below can mis-fire on the shared nickname. Tolerates the
  // city-injected corruption "Hanwha Philadelphia Eagles" directly, so this is
  // correct even if the description hasn't been run through normalizeKboLeg.
  // (With the unmodeled-declaration skip above, this carve-out now matters only
  // for COMPOUND declarations mixing KBO with a modeled league, e.g. "MLB/KBO" —
  // a pure-KBO declaration already passed.)
  if (declaredSet.has('KBO') && matchesKboTeam(desc)) return { valid: true };
  // Scan SPORT_TEAM_MAP, but separate REAL-TEAM hits from MARKET-PHRASE hits. A
  // market phrase ("both teams to score", "btts", …) is only a soft *sport*
  // signal: it may ADOPT a sport under an Unknown declaration, but it must never
  // fire a wrong-sport DROP. `teamMatches` drives the contradiction check;
  // `signalMatches` (teams ∪ market phrases) drives sport adoption. A sport keeps
  // scanning past a market-phrase hit so a real team behind it still registers
  // (e.g. "Inter Miami both teams to score" → SOCCER team, not just a signal).
  const teamMatches = new Map();   // sport → first real-team keyword
  const signalMatches = new Map(); // sport → first keyword of any kind
  for (const [sport, keywords] of Object.entries(SPORT_TEAM_MAP)) {
    for (const keyword of keywords) {
      if (!desc.includes(keyword)) continue;
      if (!signalMatches.has(sport)) signalMatches.set(sport, keyword);
      if (!isMarketPhrase(keyword)) { teamMatches.set(sport, keyword); break; }
    }
  }

  // Unknown / placeholder declaration ("Unknown", "N/A", null, …): there is no
  // declared sport for a leg to contradict, so this branch NEVER drops. It ADOPTS
  // a sport (returned up to validateParsedBet, which writes it onto the bet) only
  // on a CONFIDENT single-sport signal — and otherwise passes WITHOUT adopting,
  // so a weak/coincidental match never stamps a confidently-wrong sport:
  //   • exactly one REAL TEAM  → adopt that sport (a club name is strong), or
  //   • no real team but exactly one CURATED market-phrase sport → adopt it
  //     (the GNP fix: "both teams to score" + Unknown → adopt Soccer).
  // Anything ambiguous (a shared nickname spanning 2 sports) or signal-less
  // passes untouched (sport stays the placeholder).
  if (isSportPlaceholder(parlaySport)) {
    if (teamMatches.size === 1) {
      const key = [...teamMatches.keys()][0];
      return { valid: true, adoptedSport: SPORT_TEAM_MAP_CANONICAL[key] || key };
    }
    if (teamMatches.size === 0 && signalMatches.size === 1) {
      const [key, keyword] = [...signalMatches.entries()][0];
      if (isMarketPhrase(keyword)) {
        return { valid: true, adoptedSport: SPORT_TEAM_MAP_CANONICAL[key] || key };
      }
    }
    return { valid: true };
  }

  // Known declared sport: only a REAL TEAM from a non-declared sport is a genuine
  // cross-sport contradiction. Market-phrase-only hits never drop (downgraded
  // above). Pass when a real team confirms the declared set (intersection
  // non-empty); otherwise it is the preserved wrong-sport reject.
  if (teamMatches.size === 0) return { valid: true };
  for (const sport of teamMatches.keys()) {
    if (declaredSet.has(sport)) return { valid: true };
  }
  const sports = [...teamMatches.keys()];
  const teams = [...teamMatches.values()];
  const sportsStr = sports.length === 1 ? sports[0] : `{${sports.join(',')}}`;
  const teamsStr = teams.length === 1 ? `"${teams[0]}"` : `{${teams.map(t => `"${t}"`).join(',')}}`;
  console.log(`[Parser] WRONG-SPORT LEG REJECTED: parlay sport=${parlaySport}, leg="${desc.slice(0, 80)}", matched=${sportsStr}`);
  return { valid: false, reason: `Leg references team(s) ${teamsStr} which exist in ${sportsStr} but not in declared parlay sport ${parlaySport}` };
}

// Bug B: Detect sportsbook brand names that aren't bets
const SPORTSBOOK_BRAND_PATTERNS = [
  /america['']s premium social sportsbook/i,
  /hard ?rock( bet)?/i,
  /draftkings/i,
  /fanduel/i,
  /betmgm/i,
  /caesars/i,
  /fanatics( sportsbook)?/i,
  /prizepicks/i,
  /underdog( fantasy)?/i,
  /pointsbet/i,
  /barstool sportsbook/i,
  /wynnbet/i,
  /bet365/i,
  /unibet/i,
  /betrivers/i,
  /sportsbook$/i,
  /^social sportsbook/i,
  /betr/i,
  /espn bet/i,
  /pinnacle/i,
];

// Slip-share shape patterns — legitimate bet tweets that mention a
// sportsbook brand in passing (e.g. "PrizePicks 40x slip", "Betr 10x slip",
// "5-leg parlay", "SGP"). If either the description or the source tweet
// matches, the sportsbook_brand rejection is bypassed.
const SLIP_SHAPE_PATTERNS = [
  /\d+x\s+(slip|leg|pick|parlay)/i,
  /\d+[-\s]leg/i,
  /\bparlay\b/i,
  /pick\s*(of|#)\s*\d+/i,
  /\bsgp\b/i,
  /(picks?|legs?):\s*\d+/i,
];

function isSportsbookBrand(text) {
  if (!text) return false;
  for (const pattern of SPORTSBOOK_BRAND_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function looksLikeSlipShare(text) {
  if (!text) return false;
  for (const pattern of SLIP_SHAPE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ── Event date normalization — handles sportsbook formats ──────
function normalizeEventDate(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') raw = String(raw);

  const tryISO = new Date(raw);
  if (!isNaN(tryISO.getTime()) && raw.length > 8) return tryISO.toISOString();

  const now = new Date();
  const yr = now.getFullYear();
  let m;

  // "Thu Apr 2 @ 10:30pm" / "Mon Apr 2 10:30pm"
  m = raw.match(/(\w{3})\s+(\w{3})\s+(\d{1,2})(?:\s*@\s*|\s+)(\d{1,2}):?(\d{0,2})\s*(am|pm)/i);
  if (m) {
    const attempt = new Date(`${m[2]} ${m[3]} ${yr} ${m[4]}:${m[5] || '00'} ${m[6]}`);
    if (!isNaN(attempt.getTime())) {
      if (attempt.getTime() < now.getTime() - 7 * 24 * 3600000) attempt.setFullYear(yr + 1);
      return attempt.toISOString();
    }
  }

  // "3:10PM ET" / "3:10 PM ET"
  m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    const attempt = new Date();
    let h = parseInt(m[1]);
    if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
    attempt.setHours(h, parseInt(m[2]), 0, 0);
    return attempt.toISOString();
  }

  // "THU 6:29AM ET"
  m = raw.match(/(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const target = days[m[1].toLowerCase().slice(0, 3)];
    const attempt = new Date();
    const diff = (target - attempt.getDay() + 7) % 7;
    attempt.setDate(attempt.getDate() + (diff === 0 ? 7 : diff));
    let h = parseInt(m[2]);
    if (m[4].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[4].toLowerCase() === 'am' && h === 12) h = 0;
    attempt.setHours(h, parseInt(m[3]), 0, 0);
    return attempt.toISOString();
  }

  // "4/12/26 5:00 PM"
  m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    let year = parseInt(m[3]);
    if (year < 100) year += 2000;
    const attempt = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    let h = parseInt(m[4]);
    if (m[6].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[6].toLowerCase() === 'am' && h === 12) h = 0;
    attempt.setHours(h, parseInt(m[5]), 0, 0);
    return attempt.toISOString();
  }

  console.warn(`[normalizeEventDate] Could not parse: "${raw}"`);
  return null;
}

module.exports = { parseBetText, parseBetSlipImage, gradeBetAI, parseTwitterPick, generateRecap, assessParseConfidence, extractPickFromTweet, evaluateTweet, validateParsedBet, validateLegSportConsistency, validateLegShape, isSportsbookBrand, reclassifySport, inferLegSport, disambiguateAmbiguousTeam, matchesKboTeam, normalizeKboLeg, declaredSportIncludesKbo, isInSeason, normalizeEventDate, AMBIGUITY_THRESHOLD, tryVisionGemma, parseGemmaOutputWithCerebras, runGemmaVisionFallback, logVisionFailure, GEMMA_SLIP_PROMPT, gemmaHealth, isGemmaHealthy, recordGemmaResult, callLLM, callLLMResult, callGemini, callOpenAI, AdapterError, FALLBACK_ELIGIBLE };
