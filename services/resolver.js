// ═══════════════════════════════════════════════════════════
// MLB StatsAPI Resolver Client
//
// Thin client for the sidecar resolver service
// (zonetracker-resolver.fly.dev). Used as a PRE-CHECK before the
// ESPN + AI grading waterfall for MLB player props.
//
// Constraints:
//   - 2.5s timeout per call (Fly internal DNS can stall briefly)
//   - Graceful fallthrough on any non-decisive result — callers
//     MUST treat { graded: false } as "keep going with ESPN/AI"
//   - Circuit breaker: 3 consecutive failures → trip open for 2min
//   - Node 20 native fetch; no new HTTP client dependencies
// ═══════════════════════════════════════════════════════════

const { mapToResolverStat } = require('./resolverStatMap');

const RESOLVER_URL = process.env.RESOLVER_URL
  || (process.env.FLY_APP_NAME ? 'http://zonetracker-resolver.internal:8080' : 'http://localhost:8080');
const TIMEOUT_MS = Number(process.env.RESOLVER_TIMEOUT_MS || 2500);

// Supported-stats cache
let supportedStats = null;
let supportedStatsFetchedAt = 0;
const SUPPORTED_TTL_MS = 60 * 60 * 1000; // 1h

// Circuit breaker
let circuitOpenUntil = 0;
const CIRCUIT_OPEN_MS = 2 * 60 * 1000;
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;

// Lightweight stats — exposed via /admin resolver-health
const stats = { hits: 0, pending: 0, unknown: 0, fell_through: 0, errors: 0 };

async function fetchWithTimeout(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'bettracker-discord-bot' } });
  } finally {
    clearTimeout(t);
  }
}

async function loadSupportedStats() {
  const now = Date.now();
  if (supportedStats && now - supportedStatsFetchedAt < SUPPORTED_TTL_MS) return supportedStats;
  if (circuitOpen()) return new Set();
  try {
    const res = await fetchWithTimeout(`${RESOLVER_URL}/mlb/stats`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    supportedStats = new Set(json.supported || []);
    supportedStatsFetchedAt = now;
    recordSuccess();
    return supportedStats;
  } catch (_) {
    // Don't cache failures — next call retries. Count the failure so a
    // fully unreachable resolver eventually trips the circuit.
    recordFailure();
    return new Set();
  }
}

function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    consecutiveFailures = 0;
  }
}
function recordSuccess() { consecutiveFailures = 0; }
function circuitOpen() { return Date.now() < circuitOpenUntil; }
function resetCircuitForTests() {
  circuitOpenUntil = 0;
  consecutiveFailures = 0;
  supportedStats = null;
  supportedStatsFetchedAt = 0;
}

/**
 * Resolve a single MLB player prop.
 *
 * @param {Object} p
 * @param {string} p.player     player name (free text; resolver fuzzy-matches)
 * @param {string} p.stat       already-mapped resolver stat key (use mapToResolverStat first)
 * @param {number} p.threshold  numeric threshold from the slip (e.g. 1.5, 2.5)
 * @param {'over'|'under'} p.direction
 * @param {string} p.date       YYYY-MM-DD game date
 * @returns {Promise<{graded: true, result: 'WIN'|'LOSS'|'PUSH', actual: number, source: string, player: any, game: any}
 *                  | {graded: false, reason: string, detail?: string}>}
 */
async function resolvePlayerProp({ player, stat, threshold, direction, date }) {
  if (circuitOpen()) {
    stats.fell_through += 1;
    return { graded: false, reason: 'circuit_open' };
  }

  const supported = await loadSupportedStats();
  if (supported.size === 0) {
    stats.errors += 1;
    return { graded: false, reason: 'error', detail: 'stats_unavailable' };
  }
  if (!supported.has(stat)) {
    stats.fell_through += 1;
    return { graded: false, reason: 'unsupported_stat', detail: stat };
  }

  const url = `${RESOLVER_URL}/mlb/player-prop?` + new URLSearchParams({
    player, stat, threshold: String(threshold), direction, date,
  }).toString();

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      recordFailure();
      stats.errors += 1;
      return { graded: false, reason: 'error', detail: `status ${res.status}` };
    }
    const json = await res.json();
    recordSuccess();

    if (json.result === 'win' || json.result === 'loss' || json.result === 'push') {
      stats.hits += 1;
      return {
        graded: true,
        result: json.result.toUpperCase(),
        actual: json.actual,
        source: json.source || 'mlb.statsapi',
        player: json.player,
        game: json.game,
      };
    }
    if (json.result === 'pending') stats.pending += 1;
    else if (json.result === 'unknown') stats.unknown += 1;
    else stats.fell_through += 1;
    return { graded: false, reason: json.result, detail: json.reason };
  } catch (err) {
    recordFailure();
    stats.errors += 1;
    return { graded: false, reason: 'error', detail: err.message };
  }
}

async function checkHealth() {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${RESOLVER_URL}/health`);
    const latency = Date.now() - start;
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: latency,
      body: parsed || body.slice(0, 200),
      resolver_url: RESOLVER_URL,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - start,
      error: err.message,
      resolver_url: RESOLVER_URL,
    };
  }
}

function getStats() {
  return {
    ...stats,
    circuit_open: circuitOpen(),
    circuit_open_until: circuitOpenUntil ? new Date(circuitOpenUntil).toISOString() : null,
    consecutive_failures: consecutiveFailures,
    resolver_url: RESOLVER_URL,
    supported_stats_loaded: supportedStats ? supportedStats.size : 0,
  };
}

module.exports = {
  resolvePlayerProp,
  mapToResolverStat,
  checkHealth,
  getStats,
  __internal: { circuitOpen, loadSupportedStats, resetCircuitForTests, RESOLVER_URL, TIMEOUT_MS },
};
