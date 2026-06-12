'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// services/linkReader.js — Phase A: sportsbook share-link SHADOW detection.
//
// Detects sportsbook share/betslip URLs (and the two shortlink hosts that front
// them) inside the body of a message that is about to be staged as
// MANUAL_REVIEW_HOLD, so reviewers can see *why* a held slip carries no usable
// bet text — the legs live behind a book share link the text-parser can't read.
//
// Phase plan (see docs/BACKLOG.md "Playwright shortlink expander"):
//   A — shadow: detect + annotate the existing hold event only (THIS FILE).
//   B — Surface Pro `zonetracker-link-reader` service renders the link.
//   C — cutover: screenshot the share page → parseBetSlipImage.
//
// LINK_READER_MODE gating:
//   unset / off / anything-but-'shadow' → MODE='off'. `attachShareLink` is a
//     no-op: it never calls detectShareLink and never mutates the payload, so
//     the hold event is unchanged by this feature (off-mode short-circuit).
//   'shadow' → adds an additive `share_link` field to the hold payload when the
//     message body contains an allow-listed book/shortlink URL.
//   'cutover' ships in Phase C; treated as off here (strict 'shadow' compare).
//
// detectShareLink is a PURE, allow-list-only, never-throwing function: any input
// that isn't a string carrying an allow-listed http(s) URL returns null. Promo
// domains (dubclub/whop/linktr/gamescript), social (x.com), and Discord's own
// message links are deliberately NOT on the list and return null.
// ═══════════════════════════════════════════════════════════════════════════

// Strict compare — Phase C's 'cutover' is intentionally NOT live yet.
const MODE = process.env.LINK_READER_MODE === 'shadow' ? 'shadow' : 'off';

// Sportsbook share / betslip hosts (the legs are rendered client-side here).
const BOOK_HOSTS = [
  'share.hardrock.bet',
  'sportsbook.fanduel.com',
  'sportsbook.draftkings.com',
  'dkng.co',
];

// URL shorteners that cappers use to front the book share links above.
const SHORTLINK_HOSTS = ['bit.ly', 'tinyurl.com'];

// http(s) URLs, stopping at whitespace, angle brackets, and parens (so a URL
// inside markdown `[t](https://…)` or `<https://…>` is captured without the
// surrounding punctuation).
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

// Trailing punctuation that commonly trails a URL in prose / markdown / quotes.
const TRAILING_PUNCT_RE = /[.,!?;:'"\]]+$/;

// Suffix match: the host IS a listed host, or is a sub-domain of one. The
// leading-dot guard means `notshare.hardrock.bet` / `share.hardrock.bet.evil.com`
// do NOT match `share.hardrock.bet` — allow-list precision, not substring.
function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * Detect the first allow-listed sportsbook book/shortlink URL in `text`.
 *
 * @param {*} text  message body (anything; non-strings → null)
 * @returns {null | { url: string, domain: string, kind: 'book'|'shortlink' }}
 *          url is the matched URL truncated to ≤200 chars; domain is the actual
 *          lower-cased hostname; kind is 'book' for a sportsbook host, or
 *          'shortlink' for bit.ly / tinyurl.com. Never throws.
 */
function detectShareLink(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let matches;
  try {
    matches = text.match(URL_RE);
  } catch (_) {
    return null;
  }
  if (!matches) return null;

  for (let raw of matches) {
    raw = raw.replace(TRAILING_PUNCT_RE, '');
    if (!raw) continue;

    let host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch (_) {
      continue; // unparseable URL → skip, never throw
    }
    if (host.endsWith('.')) host = host.slice(0, -1); // tolerate trailing-dot FQDN

    if (hostMatches(host, BOOK_HOSTS)) {
      return { url: raw.slice(0, 200), domain: host, kind: 'book' };
    }
    if (hostMatches(host, SHORTLINK_HOSTS)) {
      return { url: raw.slice(0, 200), domain: host, kind: 'shortlink' };
    }
  }
  return null;
}

/**
 * Wiring helper for the MANUAL_REVIEW_HOLD sites. OFF-MODE SHORT-CIRCUIT: when
 * MODE !== 'shadow' this returns `payload` untouched and never invokes
 * detectShareLink — the hold event is byte-identical to pre-feature behavior.
 * In shadow mode it adds an additive `share_link` field when (and only when) the
 * message body carries an allow-listed URL. Mutates and returns `payload`.
 *
 * @param {object} payload  the hold event payload (mutated in place)
 * @param {*} text          the source message body to scan
 * @returns {object}        the same payload object
 */
function attachShareLink(payload, text) {
  if (MODE !== 'shadow') return payload; // ← off-mode guard, top of the wiring
  const share = detectShareLink(text);
  if (share) payload.share_link = share;
  return payload;
}

module.exports = { MODE, BOOK_HOSTS, SHORTLINK_HOSTS, detectShareLink, attachShareLink };
