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
//   POST /holds/:ingestId/recover   body: { actor?: string }   (Phase 2b-2)
//     → recoverHold(ingestId, actor) — re-fetch the held (now-unfurled)
//       message and run the existing vision_slip extraction+create path.
//     200 recovered | 200 already_recovered | 409 already_resolved
//     404 not_found | 422 no_image_yet | 422 no_bet_found
//     502 message_unreachable | 400 malformed | 500 internal
//
//   POST /handles/:handle           body: { enabled: 0|1, note?: string }
//     → UPDATE scraper_handles SET enabled, note=COALESCE(note) WHERE handle
//     200 updated | 404 not_found | 400 malformed | 500 error
//     Toggles a SEEDED handle's enabled flag (+ optional note); it NEVER
//     creates rows (a missing handle is a 404). The scraper-facing
//     GET /api/scraper-handles (routes/api.js, WHERE enabled=1) picks up the
//     new flag on its next poll.
//
// `dismissHold` / `db` are lazy-required inside each handler (mirrors
// routes/admin.js) so merely requiring this module does not couple route
// loading to SQLite boot order.
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

// On-demand Unfurl Recovery (Phase 2b-2). Core status → HTTP status; only the
// post-core outcomes live in the map. `malformed` (400) and `error` (500) are
// returned inline at their guard / catch sites, like the dismiss handler.
const RECOVER_STATUS_CODE = {
  recovered: 200,
  already_recovered: 200,
  already_resolved: 409,
  in_flight: 409,
  not_found: 404,
  no_image_yet: 422,
  no_bet_found: 422,
  message_unreachable: 502,
};

// Exported for direct unit testing (the repo has no HTTP/supertest harness).
// `deps` is an injection seam for tests ONLY (Discord fetch + vision
// extraction); the production route registration below passes nothing, so
// recoverHold runs against global._discordClient + the real vision_slip path.
async function handleRecoverRoute(req, res, deps) {
  const raw = req.params && req.params.ingestId;
  const ingestId = typeof raw === 'string' ? raw.trim() : '';
  if (!ingestId) {
    return res.status(400).json({ ok: false, status: 'malformed', error: 'Missing or malformed ingestId' });
  }

  const bodyActor = req.body && typeof req.body.actor === 'string' ? req.body.actor.trim() : '';
  const actor = bodyActor || 'dashboard';

  let result;
  try {
    const { recoverHold } = require('../services/holdReview');
    result = await recoverHold(ingestId, actor, deps || {});
  } catch (err) {
    console.error(`[AdminAPI] recover error for ${ingestId}: ${err.message}`);
    return res.status(500).json({ ok: false, status: 'error', error: 'Internal error' });
  }

  const code = RECOVER_STATUS_CODE[result.status] || 500;
  console.log(`[AdminAPI] recover ${ingestId} by "${actor}" → ${result.status} (${code})`);
  return res.status(code).json(result);
}

router.post('/holds/:ingestId/recover', adminAuth, (req, res) => handleRecoverRoute(req, res));

// Outcome status → HTTP status for the scraper_handles toggle. Mirrors the
// dismiss handler's STATUS_CODE: only the post-UPDATE outcomes live in the
// map; `malformed` (400) and `error` (500) are returned inline at their
// guard / catch sites.
const HANDLE_STATUS_CODE = {
  updated: 200,
  not_found: 404,
};

// POST /handles/:handle  body { enabled: 0|1, note?: string }
// Toggles a SEEDED scraper_handles row's enabled flag (+ optional note).
// NEVER creates rows: an unknown handle is a 404, not an insert. Exported for
// direct unit testing (the repo has no HTTP/supertest harness).
function handleSetHandleRoute(req, res) {
  const raw = req.params && req.params.handle;
  const handle = typeof raw === 'string' ? raw.trim() : '';
  if (!handle) {
    return res.status(400).json({ ok: false, status: 'malformed', error: 'Missing or malformed handle' });
  }

  // enabled is REQUIRED. Accept integer 0/1 or boolean only; coerce
  // true→1 / false→0. Anything else (missing, 2, "yes", "1", null) → 400.
  const rawEnabled = req.body ? req.body.enabled : undefined;
  let enabled;
  if (rawEnabled === 1 || rawEnabled === true) enabled = 1;
  else if (rawEnabled === 0 || rawEnabled === false) enabled = 0;
  else {
    return res.status(400).json({ ok: false, status: 'malformed', error: 'enabled must be 0 or 1' });
  }

  // note is OPTIONAL. Omitted (or non-string) → null → COALESCE leaves the
  // existing note untouched. A provided string overwrites it.
  const note = req.body && typeof req.body.note === 'string' ? req.body.note : null;

  let updatedRow;
  try {
    const { db } = require('../services/database');
    const result = db
      .prepare('UPDATE scraper_handles SET enabled = ?, note = COALESCE(?, note) WHERE handle = ?')
      .run(enabled, note, handle);

    if (result.changes === 0) {
      // Handle does not exist — this endpoint only toggles seeded handles.
      console.log(`[AdminAPI] handle ${handle} enabled=${enabled} → not_found`);
      return res.status(HANDLE_STATUS_CODE.not_found).json({ ok: false, status: 'not_found' });
    }

    updatedRow = db
      .prepare('SELECT handle, enabled, added_at, note FROM scraper_handles WHERE handle = ?')
      .get(handle);
  } catch (err) {
    console.error(`[AdminAPI] handle ${handle} enabled=${enabled} → error: ${err.message}`);
    return res.status(500).json({ ok: false, status: 'error' });
  }

  console.log(`[AdminAPI] handle ${handle} enabled=${enabled} → updated`);
  return res.status(HANDLE_STATUS_CODE.updated).json({ ok: true, status: 'updated', handle: updatedRow });
}

router.post('/handles/:handle', adminAuth, handleSetHandleRoute);

module.exports = router;
module.exports.handleDismissRoute = handleDismissRoute;
module.exports.handleRecoverRoute = handleRecoverRoute;
module.exports.handleSetHandleRoute = handleSetHandleRoute;
