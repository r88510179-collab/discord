// ═══════════════════════════════════════════════════════════
// AdapterResult contract — every LLM adapter call returns this
// shape so errors become first-class data and the fallback ladder
// can switch on a typed errorClass.
//
// No throws across adapter boundaries. A 429 from Gemini becomes
// fail(RATE_LIMIT) — the caller can decide whether to retry, fall
// back to Gemma, or surface the failure. AUTH and HTTP_4XX are
// reserved for misconfiguration that Gemma cannot fix.
//
// Background: prior to migration 018-style observability, callLLM
// would throw on 429 and the !raw || placeholder || noLegsFound
// fallback branch never fired. Typed errorClass is what the Gemma
// ladder hangs off now.
// ═══════════════════════════════════════════════════════════

'use strict';

const AdapterError = Object.freeze({
  RATE_LIMIT:       'rate_limit',       // 429
  QUOTA_EXHAUSTED:  'quota_exhausted',  // 402
  AUTH:             'auth',             // 401 / 403
  NO_CONTENT:       'no_content',       // empty / null body
  TIMEOUT:          'timeout',          // ETIMEDOUT, ECONNRESET, AbortError
  HTTP_4XX:         'http_4xx',         // other 4xx
  HTTP_5XX:         'http_5xx',         // 5xx
  PARSE_FAIL:       'parse_fail',       // JSON parse / schema invalid
  UNKNOWN:          'unknown',
});

// errorClasses that mean "primary path was unhealthy, try the cheap
// local fallback (Gemma on Surface Pro)". AUTH/HTTP_4XX/UNKNOWN are
// excluded — Gemma cannot fix a misconfigured API key.
const FALLBACK_ELIGIBLE = Object.freeze(new Set([
  AdapterError.RATE_LIMIT,
  AdapterError.QUOTA_EXHAUSTED,
  AdapterError.NO_CONTENT,
  AdapterError.PARSE_FAIL,
  AdapterError.TIMEOUT,
  AdapterError.HTTP_5XX,
]));

const ok   = (value, meta)        => ({ ok: true,  value, ...(meta ? { meta } : {}) });
const fail = (errorClass, error)  => ({
  ok: false,
  errorClass,
  error: error == null ? '' : (error.message != null ? String(error.message) : String(error)),
});

/**
 * Map a thrown error or an HTTP status code to an AdapterError class.
 * Accepts any combination of `{ status, code, name, message }` shapes
 * that the underlying fetch / SDK clients produce.
 */
function classifyError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  if (status === 429) return AdapterError.RATE_LIMIT;
  if (status === 402) return AdapterError.QUOTA_EXHAUSTED;
  if (status === 401 || status === 403) return AdapterError.AUTH;
  if (typeof status === 'number' && status >= 500) return AdapterError.HTTP_5XX;
  const code = err?.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return AdapterError.TIMEOUT;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return AdapterError.TIMEOUT;
  }
  if (typeof err?.message === 'string' && /timeout|timed out/i.test(err.message)) {
    return AdapterError.TIMEOUT;
  }
  if (typeof status === 'number' && status >= 400) return AdapterError.HTTP_4XX;
  return AdapterError.UNKNOWN;
}

/**
 * Map an HTTP response status (success-or-failure code) to an error
 * class. Used by adapters that detect non-OK responses without
 * throwing — e.g. fetch with `if (!res.ok)`.
 */
function classifyHttpStatus(status) {
  if (status === 429) return AdapterError.RATE_LIMIT;
  if (status === 402) return AdapterError.QUOTA_EXHAUSTED;
  if (status === 401 || status === 403) return AdapterError.AUTH;
  if (typeof status === 'number' && status >= 500) return AdapterError.HTTP_5XX;
  if (typeof status === 'number' && status >= 400) return AdapterError.HTTP_4XX;
  return AdapterError.UNKNOWN;
}

module.exports = {
  AdapterError,
  FALLBACK_ELIGIBLE,
  ok,
  fail,
  classifyError,
  classifyHttpStatus,
};
