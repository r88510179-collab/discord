// ═══════════════════════════════════════════════════════════
// ocrFirst — OCR-first slip extraction orchestration.
//
// extractViaOcr(imageBase64, mediaType, requestId, deps?) ALWAYS returns a
// decision object — NEVER null, NEVER throws. The ingest path (wired in a
// separate prompt) uses USE_OCR to skip Gemini, or FALLBACK_GEMINI to route
// to the existing Vision path. FALLBACK_GEMINI is a route, not a drop.
//
// Flow:  OCR  →  empty/garbage check  →  SGP gate  →  Groq parse (retry once)
//        →  two-tier validate  →  { action, reason, parsedBet, … }
//
// ISOLATION-ONLY: not imported by ai.js / messageHandler yet. See
// docs/specs/ocr-first.md. `deps` lets unit tests mock the network with no
// live calls; production callers omit it.
// ═══════════════════════════════════════════════════════════

'use strict';

const localOcr = require('./localOcr');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Reused verbatim from prompts/groq-parse-test.md (the proven go/no-go parse
// test). The "1(middot)HITS" token is intentional — that is how the proven
// system prompt reads.
const OCR_PARSE_SYSTEM = `You are a sports-betting slip parser. The input is raw OCR text from a Hard Rock Bet slip; token order may be jumbled and there may be OCR artifacts (O for 0, middot for +, merged words — e.g. 9:4OpmEDT becomes 9:40pm EDT, 1(middot)HITS becomes 1+ Hits, O0ver0.5 becomes Over 0.5, Glants becomes Giants). Extract by PATTERN, not position. Output ONLY valid JSON in the schema below — no commentary, no markdown fences. Do not invent legs or values; use null for missing fields.

Schema (JSON):
{
  "book": string,
  "bet_type": "single|parlay|sgp|sgpmax",
  "total_odds": string,
  "stake": string,
  "payout": string,
  "legs": [
    { "matchup": string, "player": string-or-null, "market": string,
      "selection": string, "odds": string-or-null, "start_time": string-or-null }
  ]
}`;

// SGP gate — same-game parlays route to Vision (run BEFORE Groq).
const SGP_RE = /\b(?:SGP|SGPMAX|SAME\s+GAME(?:\s+PARLAY)?)\b/i;
// Advisory N-Bet header, e.g. "3-Bet Parlay", "5-BetParlay", "4-Bet Parlay".
const HEADER_RE = /(\d{1,2})\s*-?\s*bet\b/i;
// OCR-artifact residue a correct parse would have cleaned.
const ARTIFACT_RES = [
  /O0/,        // capital-O glued to zero: "O0ver0.5"
  /\bO\d/,     // stray leading capital-O before a digit
  /·/,    // middot · (U+00B7) where a + / digit belongs: "1·HITS"
];

const ReasonCode = Object.freeze({
  PARSE_OK: 'OCR_PARSE_OK',
  EMPTY: 'OCR_EMPTY',
  GARBAGE: 'OCR_GARBAGE',
  SGP_GATE: 'OCR_SGP_GATE',
  PARSE_FAIL: 'OCR_PARSE_FAIL',
  VALIDATE_FAIL: 'OCR_VALIDATE_FAIL',
});

const ValidationCode = Object.freeze({
  MISSING_BET_TYPE: 'MISSING_BET_TYPE',
  MISSING_SELECTION: 'MISSING_SELECTION',
  MISSING_ENTITY: 'MISSING_ENTITY',
  MISSING_COMBINED_ODDS: 'MISSING_COMBINED_ODDS',
  ARTIFACT_RESIDUE: 'ARTIFACT_RESIDUE',
  LEG_COUNT_MISMATCH: 'LEG_COUNT_MISMATCH',
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Tolerant JSON extraction (mirrors services/ai.js parseJSON): strip fences,
// then fall back to the outermost {…}.
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

function str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Parse OCR text into a structured bet with Groq. Retries once on invalid JSON.
 * Returns { ok:true, parsed, raw } or { ok:false }. Never throws.
 */
async function callGroqParse(ocrText, requestId) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, parsed: null, raw: null };
  const model = process.env.OCR_PARSE_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const temperature = num(process.env.OCR_PARSE_TEMPERATURE, 0);
  const body = {
    model,
    temperature,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: OCR_PARSE_SYSTEM },
      { role: 'user', content: ocrText },
    ],
  };

  // Initial attempt + one retry on invalid-JSON / transient failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(`[ocrFirst] Groq HTTP ${res.status} (attempt ${attempt + 1}, model ${model}, req ${requestId || 'n/a'})`);
        continue;
      }
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || '' : '';
      const parsed = parseJSON(content);
      if (parsed && typeof parsed === 'object') return { ok: true, parsed, raw: content };
      console.warn(`[ocrFirst] Groq invalid JSON (attempt ${attempt + 1}, req ${requestId || 'n/a'})`);
    } catch (err) {
      console.warn(`[ocrFirst] Groq call error (attempt ${attempt + 1}): ${err.message}`);
    }
  }
  return { ok: false, parsed: null, raw: null };
}

/** Extract the advisory N-Bet header leg count, or null if absent/unconfident. */
function extractHeaderLegCount(ocrText) {
  const m = ocrText.match(HEADER_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : null;
}

/** True if any critical field carries un-cleaned OCR artifact residue. */
function hasArtifactResidue(parsed) {
  const fields = [];
  const legs = Array.isArray(parsed.legs) ? parsed.legs : [];
  for (const leg of legs) {
    if (!leg) continue;
    fields.push(leg.selection, leg.player, leg.matchup, leg.market, leg.odds);
  }
  fields.push(parsed.total_odds);
  return fields.some(f => f != null && ARTIFACT_RES.some(re => re.test(String(f))));
}

/**
 * Two-tier hard validation. Returns an array of validation sub-codes (empty =
 * pass). NICE-TO-HAVE fields (stake, per-leg odds, full matchup) are never
 * required and never fabricated.
 */
function validateOcrBet(parsed, headerLegCount) {
  const errors = [];
  const legs = Array.isArray(parsed.legs) ? parsed.legs : [];

  if (!str(parsed.bet_type)) errors.push(ValidationCode.MISSING_BET_TYPE);

  // every leg has a selection (and there is ≥1 leg)
  if (legs.length === 0 || legs.some(l => !l || !str(l.selection))) {
    errors.push(ValidationCode.MISSING_SELECTION);
  }
  // every leg has ≥1 of player / team / matchup
  if (legs.length === 0 || legs.some(l => !l || !(str(l.player) || str(l.team) || str(l.matchup)))) {
    errors.push(ValidationCode.MISSING_ENTITY);
  }
  // combined odds OR payout present
  if (!str(parsed.total_odds) && !str(parsed.payout)) {
    errors.push(ValidationCode.MISSING_COMBINED_ODDS);
  }
  // no artifact residue in critical fields
  if (hasArtifactResidue(parsed)) errors.push(ValidationCode.ARTIFACT_RESIDUE);
  // confident header → leg count must match (advisory: skipped if header null)
  if (headerLegCount != null && legs.length !== headerLegCount) {
    errors.push(ValidationCode.LEG_COUNT_MISMATCH);
  }

  return [...new Set(errors)];
}

/**
 * extractViaOcr — orchestrate OCR → parse → validate into a decision object.
 * ALWAYS returns a decision object (never null), NEVER throws.
 *
 * @param {string} imageBase64
 * @param {string} [mediaType]
 * @param {string} [requestId]
 * @param {{callOcrService?:Function, callGroqParse?:Function}} [deps] test injection
 */
async function extractViaOcr(imageBase64, mediaType, requestId, deps = {}) {
  const callOcr = deps.callOcrService || localOcr.callOcrService;
  const groqParse = deps.callGroqParse || callGroqParse;

  const t0 = Date.now();
  const timings = { ocr: 0, parse: 0, validate: 0, total: 0 };
  const evidence = { sgpToken: null, headerLegCount: null, parsedLegCount: null, ocrChars: 0 };
  let ocrText = '';
  let imageHash = null;

  const finalize = (action, reason, extra = {}) => {
    timings.total = Date.now() - t0;
    return {
      action,
      reason,
      parsedBet: extra.parsedBet != null ? extra.parsedBet : null,
      ocrText,
      validationErrors: extra.validationErrors || [],
      evidence: { ...evidence },
      timingsMs: { ...timings },
      imageHash,
    };
  };

  // 1. OCR
  const ocrStart = Date.now();
  let ocr;
  try {
    ocr = await callOcr(imageBase64, mediaType, requestId);
  } catch (err) {
    // callOcrService is contractually no-throw; stay defensive anyway.
    ocr = { ok: false, error: { code: localOcr.OcrErrorCode.UNREACHABLE, message: err.message } };
  }
  timings.ocr = Date.now() - ocrStart;

  if (!ocr || ocr.ok !== true) {
    const code = (ocr && ocr.error && ocr.error.code) || localOcr.OcrErrorCode.UNREACHABLE;
    return finalize('FALLBACK_GEMINI', `OCR_${code}`);
  }

  ocrText = typeof ocr.text === 'string' ? ocr.text : '';
  imageHash = ocr.imageHash || null;
  evidence.ocrChars = ocrText.length;

  const trimmed = ocrText.trim();
  if (!trimmed) return finalize('FALLBACK_GEMINI', ReasonCode.EMPTY);
  // Clearly non-slip: too short AND no digit (no line/odds/price to bet on).
  if (trimmed.length < 20 && !/\d/.test(trimmed)) return finalize('FALLBACK_GEMINI', ReasonCode.GARBAGE);

  // 2. SGP gate — BEFORE Groq.
  const sgpMatch = ocrText.match(SGP_RE);
  if (sgpMatch) {
    evidence.sgpToken = sgpMatch[0];
    return finalize('FALLBACK_GEMINI', ReasonCode.SGP_GATE);
  }

  // Advisory header (captured for evidence + leg-count validation).
  evidence.headerLegCount = extractHeaderLegCount(ocrText);

  // 3. Groq parse (retry-once is internal to groqParse).
  const parseStart = Date.now();
  let parseRes;
  try {
    parseRes = await groqParse(ocrText, requestId);
  } catch (err) {
    console.warn(`[ocrFirst] groqParse threw (defensive): ${err.message}`);
    parseRes = { ok: false, parsed: null };
  }
  timings.parse = Date.now() - parseStart;

  if (!parseRes || parseRes.ok !== true || !parseRes.parsed) {
    return finalize('FALLBACK_GEMINI', ReasonCode.PARSE_FAIL);
  }
  const parsed = parseRes.parsed;
  evidence.parsedLegCount = Array.isArray(parsed.legs) ? parsed.legs.length : null;

  // 4. Two-tier validation.
  const valStart = Date.now();
  const validationErrors = validateOcrBet(parsed, evidence.headerLegCount);
  timings.validate = Date.now() - valStart;

  if (validationErrors.length > 0) {
    return finalize('FALLBACK_GEMINI', ReasonCode.VALIDATE_FAIL, { validationErrors });
  }
  return finalize('USE_OCR', ReasonCode.PARSE_OK, { parsedBet: parsed });
}

module.exports = {
  extractViaOcr,
  callGroqParse,
  validateOcrBet,
  hasArtifactResidue,
  extractHeaderLegCount,
  ReasonCode,
  ValidationCode,
  OCR_PARSE_SYSTEM,
  SGP_RE,
};
