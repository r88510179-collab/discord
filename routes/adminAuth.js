// ═══════════════════════════════════════════════════════════
// Admin API auth — shared, token-guarded bearer middleware.
//
// Extracted verbatim from routes/admin.js (Phase 2a-1) so both the
// READ-ONLY read router (routes/admin.js) and the Phase 2b write router
// (routes/adminCommands.js) enforce the exact same fail-closed bearer
// check. Behaviour is byte-identical to the original inline copy.
//
// AUTH contract (unchanged):
//   - Bearer token in the Authorization header, timing-safe compared to
//     process.env.ADMIN_API_SECRET.
//   - FAIL CLOSED: if ADMIN_API_SECRET is unset/empty, every request 503s.
//   - 401 missing/malformed header, 403 token mismatch. Failures are logged
//     ([AdminAPI] auth fail) WITHOUT echoing the presented token.
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');

// Timing-safe string compare. crypto.timingSafeEqual throws when the two
// buffers differ in length, so guard equal length first and treat a length
// mismatch as a (constant-time-irrelevant) non-match.
function safeEqual(presented, expected) {
  const a = Buffer.from(String(presented), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Applied to every /api/admin/* route.
function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_API_SECRET;

  // FAIL CLOSED — never serve when no secret is configured.
  if (!secret) {
    console.warn('[AdminAPI] auth fail — ADMIN_API_SECRET unset (fail-closed 503)');
    return res.status(503).json({ error: 'Admin API unavailable (no secret configured)' });
  }

  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    console.warn(`[AdminAPI] auth fail — missing/malformed Authorization header (${req.method} ${req.path})`);
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  if (!safeEqual(match[1], secret)) {
    // Never log the presented token.
    console.warn(`[AdminAPI] auth fail — token mismatch (${req.method} ${req.path})`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  return next();
}

module.exports = { adminAuth, safeEqual };
