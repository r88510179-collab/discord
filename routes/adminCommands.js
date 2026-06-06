// ═══════════════════════════════════════════════════════════
// Admin Write-API — token-guarded MUTATION endpoints under /api/admin/*
// (Phase 2b). Deliberately SEPARATE from routes/admin.js, which is
// hard-constrained read-only and forbids write routes in-file ("Mutations
// arrive in Phase 2b via a separate adminCommands layer").
//
// Mounted at /api/admin in bot.js BEFORE the read router, so the read
// router's catch-all 404 never intercepts these POSTs. Reuses the exact same
// fail-closed bearer middleware (routes/adminAuth.js) applied per-route, so
// read-router behaviour is untouched.
//
// Endpoints:
//   POST /holds/:ingestId/dismiss   body: { actor?: string }
//     → dismissHold(ingestId, actor)  (actor defaults to 'dashboard')
//     200 dismissed | 200 already_dismissed | 409 already_released
//     404 not_found  | 400 malformed     | 500 internal
//
// `dismissHold` is lazy-required inside the handler (mirrors routes/admin.js)
// so merely requiring this module does not couple route loading to SQLite
// boot order.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');

// Core status → HTTP status. Anything unmapped is a 500 (defensive; the core
// only ever returns one of these four statuses).
const STATUS_CODE = {
  dismissed: 200,
  already_dismissed: 200,
  already_released: 409,
  not_found: 404,
};

// Exported for direct unit testing (the repo has no HTTP/supertest harness).
function handleDismissRoute(req, res) {
  const raw = req.params && req.params.ingestId;
  const ingestId = typeof raw === 'string' ? raw.trim() : '';
  if (!ingestId) {
    return res.status(400).json({ ok: false, status: 'malformed', error: 'Missing or malformed ingestId' });
  }

  const bodyActor = req.body && typeof req.body.actor === 'string' ? req.body.actor.trim() : '';
  const actor = bodyActor || 'dashboard';

  let result;
  try {
    const { dismissHold } = require('../services/holdReview');
    result = dismissHold(ingestId, actor);
  } catch (err) {
    console.error(`[AdminAPI] dismiss error for ${ingestId}: ${err.message}`);
    return res.status(500).json({ ok: false, status: 'error', error: 'Internal error' });
  }

  const code = STATUS_CODE[result.status] || 500;
  console.log(`[AdminAPI] dismiss ${ingestId} by "${actor}" → ${result.status} (${code})`);
  return res.status(code).json(result);
}

router.post('/holds/:ingestId/dismiss', adminAuth, handleDismissRoute);

module.exports = router;
module.exports.handleDismissRoute = handleDismissRoute;
