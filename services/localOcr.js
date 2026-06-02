// ═══════════════════════════════════════════════════════════
// localOcr — typed HTTP client for the Surface Pro RapidOCR service
// (zonetracker-ocr). Mirrors zonetracker-ocr/CONTRACT.md exactly.
//
// ISOLATION-ONLY: not wired into the slip-ingest path yet. See
// docs/specs/ocr-first.md. Never throws — every outcome is a typed
// result so callers (services/ocrFirst.js) can branch on a code.
//
//   callOcrService(imageBase64, mediaType, requestId) ->
//     { ok:true, text, lines, confidence, latencyMs, imageHash, width, height }
//     { ok:false, error:{ code, message } }
//       code ∈ TIMEOUT | UNREACHABLE | HTTP_4XX | HTTP_5XX | BAD_RESPONSE | CIRCUIT_OPEN
//
// Module-local circuit breaker: OCR_CIRCUIT_BREAKER_FAILS consecutive
// breaker-tripping failures (TIMEOUT/UNREACHABLE/HTTP_5XX) open it for
// OCR_CIRCUIT_BREAKER_COOLDOWN_MS; while open we return CIRCUIT_OPEN with
// no network attempt. A success — or a GET /healthz 200 — closes it.
// ═══════════════════════════════════════════════════════════

'use strict';

// Failure codes — closed enum (see CONTRACT.md + docs/specs/ocr-first.md §2).
const OcrErrorCode = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'UNREACHABLE',
  HTTP_4XX: 'HTTP_4XX',
  HTTP_5XX: 'HTTP_5XX',
  BAD_RESPONSE: 'BAD_RESPONSE',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
});

// Only these mean "the service itself is down/struggling" → count toward the breaker.
// HTTP_4XX (auth/too-large) and BAD_RESPONSE (incl. 200/ok:false decode failures) are
// config/input problems on a *healthy* service and must not flap the breaker.
const BREAKER_TRIPPING = new Set([
  OcrErrorCode.TIMEOUT,
  OcrErrorCode.UNREACHABLE,
  OcrErrorCode.HTTP_5XX,
]);

// ── Config getters (read env at call time so secrets can be hot-swapped) ──
function serviceUrl() {
  const u = process.env.OCR_SERVICE_URL;
  return u ? u.replace(/\/+$/, '') : null; // trim trailing slashes
}
function serviceToken() { return process.env.OCR_SERVICE_TOKEN || null; }
function timeoutMs() { return intEnv('OCR_TIMEOUT_MS', 8000); }
function breakerFails() { return intEnv('OCR_CIRCUIT_BREAKER_FAILS', 3); }
function breakerCooldownMs() { return intEnv('OCR_CIRCUIT_BREAKER_COOLDOWN_MS', 60000); }

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── Circuit breaker state (module-local) ──
const breaker = { consecutiveFails: 0, openUntil: 0 };

/** True if the breaker is currently open. Auto half-opens once cooldown elapses. */
function breakerIsOpen() {
  if (!breaker.openUntil) return false;
  if (Date.now() < breaker.openUntil) return true;
  // Cooldown elapsed — half-open: clean slate, let the next call hit the network.
  breaker.openUntil = 0;
  breaker.consecutiveFails = 0;
  return false;
}
function recordSuccess() {
  breaker.consecutiveFails = 0;
  breaker.openUntil = 0;
}
function recordFailure(code) {
  if (!BREAKER_TRIPPING.has(code)) return; // non-tripping: leave counter untouched
  breaker.consecutiveFails += 1;
  if (breaker.consecutiveFails >= breakerFails()) {
    breaker.openUntil = Date.now() + breakerCooldownMs();
    console.warn(`[localOcr] circuit breaker OPEN — ${breaker.consecutiveFails} consecutive failures, cooldown ${breakerCooldownMs()}ms (last: ${code})`);
  }
}

function fail(code, message) {
  return { ok: false, error: { code, message: String(message || code) } };
}

/** Map a thrown fetch error to a client error code. */
function classifyThrown(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ETIMEDOUT')) {
    return OcrErrorCode.TIMEOUT;
  }
  return OcrErrorCode.UNREACHABLE; // ECONNREFUSED / ENOTFOUND / ECONNRESET / generic
}

/**
 * POST {OCR_SERVICE_URL}/ocr. Never throws; returns a typed result.
 * @param {string} imageBase64 base64 of raw image bytes (no data: prefix)
 * @param {string} [mediaType] e.g. "image/webp" — informational
 * @param {string} [requestId] echoed into server logs for tracing
 */
async function callOcrService(imageBase64, mediaType, requestId) {
  const url = serviceUrl();
  if (!url) return fail(OcrErrorCode.UNREACHABLE, 'OCR_SERVICE_URL not configured');

  // Breaker gate — return immediately, NO network, while open.
  if (breakerIsOpen()) {
    const remaining = Math.max(0, breaker.openUntil - Date.now());
    return fail(OcrErrorCode.CIRCUIT_OPEN, `circuit open for ${remaining}ms`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${url}/ocr`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceToken() || ''}`,
      },
      body: JSON.stringify({
        imageBase64,
        mediaType: mediaType || undefined,
        requestId: requestId || undefined,
        source: 'ocrFirst',
      }),
    });
    clearTimeout(timer);

    if (res.status >= 500) {
      recordFailure(OcrErrorCode.HTTP_5XX);
      return fail(OcrErrorCode.HTTP_5XX, `HTTP ${res.status}`);
    }
    if (res.status >= 400) {
      // 401 auth / 413 too-large / 404 — client/config issue, not "service down".
      return fail(OcrErrorCode.HTTP_4XX, `HTTP ${res.status}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return fail(OcrErrorCode.BAD_RESPONSE, `invalid JSON body: ${e.message}`);
    }
    if (!data || typeof data.ok !== 'boolean') {
      return fail(OcrErrorCode.BAD_RESPONSE, 'response missing boolean "ok"');
    }
    if (data.ok === false) {
      // 200/ok:false = service healthy but couldn't read THIS image (decode/OCR
      // failure). Preserve the server code; do NOT trip the breaker.
      const serverCode = (data.error && data.error.code) || 'unknown';
      return fail(OcrErrorCode.BAD_RESPONSE, `service ok:false (${serverCode})`);
    }
    if (typeof data.text !== 'string') {
      return fail(OcrErrorCode.BAD_RESPONSE, 'ok:true but "text" missing');
    }

    recordSuccess();
    return {
      ok: true,
      text: data.text,
      lines: Array.isArray(data.lines) ? data.lines : [],
      confidence: numberOr(data.confidence, 0),
      latencyMs: numberOr(data.latencyMs, null),
      imageHash: data.imageHash || null,
      width: data.width == null ? null : data.width,
      height: data.height == null ? null : data.height,
    };
  } catch (err) {
    clearTimeout(timer);
    const code = classifyThrown(err);
    recordFailure(code);
    return fail(code, err.message);
  }
}

/**
 * GET {OCR_SERVICE_URL}/healthz. A 200 (model loaded, per contract) closes the
 * circuit breaker. Never throws; returns a typed result. Observational — a
 * healthz failure does NOT trip the breaker (the breaker tracks /ocr calls).
 */
async function checkHealth(requestId) {
  const url = serviceUrl();
  if (!url) return fail(OcrErrorCode.UNREACHABLE, 'OCR_SERVICE_URL not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const headers = {};
    if (serviceToken()) headers['Authorization'] = `Bearer ${serviceToken()}`;
    if (requestId) headers['X-Request-Id'] = String(requestId);
    const res = await fetch(`${url}/healthz`, { method: 'GET', signal: controller.signal, headers });
    clearTimeout(timer);
    if (res.status === 200) {
      recordSuccess(); // close the breaker
      let body = null;
      try { body = await res.json(); } catch { /* body optional */ }
      return { ok: true, modelLoaded: !!(body && body.modelLoaded), status: 200 };
    }
    if (res.status >= 500) return fail(OcrErrorCode.HTTP_5XX, `HTTP ${res.status}`);
    return fail(OcrErrorCode.HTTP_4XX, `HTTP ${res.status}`);
  } catch (err) {
    clearTimeout(timer);
    return fail(classifyThrown(err), err.message);
  }
}

// Test-only: reset module-local breaker state between cases.
function _resetCircuitBreaker() {
  breaker.consecutiveFails = 0;
  breaker.openUntil = 0;
}
// Test-only: inspect breaker state.
function _getCircuitState() {
  return { consecutiveFails: breaker.consecutiveFails, openUntil: breaker.openUntil, open: breakerIsOpen() };
}

module.exports = {
  callOcrService,
  checkHealth,
  OcrErrorCode,
  _resetCircuitBreaker,
  _getCircuitState,
};
