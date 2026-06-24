// services/preFilter.js
// Mode-gated pre-hold classifier for the two MANUAL_REVIEW_HOLD branches in
// handlers/messageHandler.js. PURE + side-effect-free: it only DECIDES; the
// caller records the drop / shadow marker and skips or keeps the hold. Default
// (PRE_FILTER_MODE unset → 'off') is a pure no-op: preFilterDecision returns
// action:'pass' for ANY text, so nothing is dropped and no new rows are written.
//
// Single source of truth for "what is this held non-bet?": it reuses the
// existing guessDisposition heuristic (services/replayHolds.js) — the SAME hints
// that color the admin replay-holds embed — so the would-drop buckets never
// diverge from the triage hints a human already sees.
//
// Modes (env PRE_FILTER_MODE, secrets-driven like OCR_FIRST_MODE — no redeploy):
//   off / anything not 'shadow'|'enforce' → always 'pass'  (pure no-op)
//   shadow  → matched non-bets → action:'shadow' (measure only, hold still fires)
//   enforce → matched non-bets whose bucket is in PRE_FILTER_ENFORCE_BUCKETS →
//             action:'drop' (skip the hold); buckets NOT opted in stay 'shadow'.

'use strict';

const { guessDisposition } = require('./replayHolds');

// Drop reason per bucket. These three are registered in
// services/pipeline-events.js DROP_REASONS so the warn-only enum tripwire stays
// quiet when an enforce drop is recorded.
const DROP_REASON = {
  promo: 'PRE_FILTER_PROMO_SHEET',
  recap: 'PRE_FILTER_RECAP',
  sweat: 'PRE_FILTER_SWEAT_COMMENTARY',
};

// Map a guessDisposition hint to a would-drop bucket, or null when the slip must
// NOT be flagged (image-only, or "likely a pick"). Matched on the hint's LEADING
// phrase — deliberately NOT a loose substring — because the likely-a-pick hint
// ("No obvious recap/promo markers — likely a pick") literally contains the
// words "recap" and "promo" and must still map to null.
function bucketFromHint(hint) {
  const h = hint || '';
  if (/^Looks like a recap/.test(h)) return 'recap';
  if (/^Looks like promo/.test(h)) return 'promo';
  if (/^Looks like sweat/.test(h)) return 'sweat';
  return null;
}

// Pure decision. Returns { bucket, reason, action } where action is one of:
//   'pass'   → do nothing new (mode off, or text is not a flagged non-bet)
//   'shadow' → matched a bucket but measure-only (record PRE_FILTER_WOULD_DROP,
//              then fall through to the existing hold — no behavior change)
//   'drop'   → matched a bucket AND enforce-opted-in (record the drop, skip hold)
// enforceBuckets may be an Array or a Set.
function preFilterDecision(text, mode, enforceBuckets) {
  if (mode !== 'shadow' && mode !== 'enforce') {
    return { bucket: null, reason: null, action: 'pass' };
  }
  const { hint } = guessDisposition(text);
  const bucket = bucketFromHint(hint);
  if (!bucket) {
    return { bucket: null, reason: null, action: 'pass' };
  }
  const reason = DROP_REASON[bucket];
  const enforced = enforceBuckets instanceof Set
    ? enforceBuckets.has(bucket)
    : Array.isArray(enforceBuckets) && enforceBuckets.includes(bucket);
  if (mode === 'enforce' && enforced) {
    return { bucket, reason, action: 'drop' };
  }
  return { bucket, reason, action: 'shadow' };
}

module.exports = { DROP_REASON, bucketFromHint, preFilterDecision };
