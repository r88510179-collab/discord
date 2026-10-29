// REVIEW_POLICY_V1
// ═══════════════════════════════════════════════════════════
// Review-gate auto-confirm policy (PR-3).
//
// Decides whether a freshly ingested bet lands as 'needs_review'
// (today's behavior) or 'confirmed' (visible to the grader). Opt-in:
// with REVIEW_AUTO_CONFIRM unset the call site's legacyStatus passes
// through byte-identical to today (test-pinned).
//
// REVIEW_AUTO_CONFIRM and TRUSTED_CAPPER_IDS are read per call, like
// the other mode flags, so they flip without a restart.
//
// Leaf module: no requires. audit_mode stays a call-site concern —
// the Discord path folds it into legacyStatus — so this module never
// touches the DB and the pure test runs with no DB.
// ═══════════════════════════════════════════════════════════
'use strict';

// Mirrors the repo's mode-flag convention (strict compare, anything
// else including unset → 'off').
function resolveAutoConfirmMode(raw = process.env.REVIEW_AUTO_CONFIRM) {
  if (raw === 'trusted') return 'trusted';
  if (raw === 'all') return 'all';
  return 'off';
}

// '@Handle , foo' → Set { 'handle', 'foo' }
function parseTrustedCappers(raw = process.env.TRUSTED_CAPPER_IDS) {
  const out = new Set();
  for (const tok of String(raw || '').split(',')) {
    const t = tok.trim().toLowerCase().replace(/^@/, '');
    if (t) out.add(t);
  }
  return out;
}

const normToken = (v) => String(v).trim().toLowerCase().replace(/^@/, '');

// cappers columns: id, discord_id, twitter_handle, display_name (mig 001).
// Twitter-sourced capper rows store a synthetic discord_id of the form
// 'twitter_<handle>', so a trusted-list handle must match it with or
// without that prefix.
function isTrustedCapper(capper, trustedSet) {
  if (!capper || !trustedSet || trustedSet.size === 0) return false;
  const candidates = [];
  if (capper.id) candidates.push(normToken(capper.id));
  if (capper.discord_id) {
    const d = normToken(capper.discord_id);
    candidates.push(d);
    if (d.startsWith('twitter_')) candidates.push(d.slice('twitter_'.length));
  }
  if (capper.twitter_handle) candidates.push(normToken(capper.twitter_handle));
  if (capper.display_name) candidates.push(normToken(capper.display_name));
  return candidates.some((c) => trustedSet.has(c));
}

// The single decision point. Precedence:
//   1. low-confidence parse holds for review ALWAYS — the weak-parse
//      hold is a parse-quality question, not a trust question.
//   2. mode 'all' confirms.
//   3. mode 'trusted' confirms listed cappers.
//   4. otherwise the call site's legacy computation stands (mode 'off'
//      therefore returns legacyStatus unchanged).
function reviewStatusFor({ capper, confidence, legacyStatus }) {
  if (confidence === 'low') return 'needs_review';
  const mode = resolveAutoConfirmMode();
  if (mode === 'all') return 'confirmed';
  if (mode === 'trusted' && isTrustedCapper(capper, parseTrustedCappers())) return 'confirmed';
  return legacyStatus;
}

module.exports = { resolveAutoConfirmMode, parseTrustedCappers, isTrustedCapper, reviewStatusFor };
