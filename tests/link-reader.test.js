// ═══════════════════════════════════════════════════════════
// services/linkReader.js — Phase A shadow detection tests.
//
// Covers:
//   • detectShareLink positives: HRB share text+URL, FanDuel addToBetslip,
//     DraftKings (both hosts), bit.ly shortlink.
//   • detectShareLink negatives: promo (dubclub/whop), Discord message links,
//     social (x.com), plain text, scheme-less domain text, junk input.
//   • off-vs-shadow payload behavior (attachShareLink) with mocked
//     LINK_READER_MODE — off must be byte-identical (no share_link); shadow
//     adds the additive field. MODE is bound at module load, so each case
//     re-requires the module under a different env via require.cache.
//
// Run:  node tests/link-reader.test.js
// ═══════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const path = require('path');

const MOD = path.resolve(__dirname, '../services/linkReader.js');

// Re-require linkReader with LINK_READER_MODE set to `mode` (undefined → unset).
// MODE is frozen at load time, so we bust the cache each call and restore env.
function loadFresh(mode) {
  const prev = process.env.LINK_READER_MODE;
  if (mode === undefined) delete process.env.LINK_READER_MODE;
  else process.env.LINK_READER_MODE = mode;
  delete require.cache[MOD];
  const m = require(MOD);
  if (prev === undefined) delete process.env.LINK_READER_MODE;
  else process.env.LINK_READER_MODE = prev;
  return m;
}

// detectShareLink is mode-independent (pure); any load works. Use a 'shadow'
// load so MODE-coupled helpers are also exercised against the same module.
const lr = loadFresh('shadow');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  }
}

console.log('linkReader.detectShareLink — positives (allow-listed book/shortlink):');

run('HRB share text + share.hardrock.bet URL → book', () => {
  const r = lr.detectShareLink('Check out this bet I placed on Hard Rock Bet! https://share.hardrock.bet/abc123');
  assert.deepStrictEqual(r, { url: 'https://share.hardrock.bet/abc123', domain: 'share.hardrock.bet', kind: 'book' });
});

run('FanDuel addToBetslip → book', () => {
  const r = lr.detectShareLink('Load it up: https://sportsbook.fanduel.com/addToBetslip?marketId=42.123&selectionId=99');
  assert.ok(r, 'matched');
  assert.strictEqual(r.kind, 'book');
  assert.strictEqual(r.domain, 'sportsbook.fanduel.com');
  assert.ok(r.url.startsWith('https://sportsbook.fanduel.com/addToBetslip'));
});

run('DraftKings sportsbook host → book', () => {
  const r = lr.detectShareLink('tail me https://sportsbook.draftkings.com/event/12345');
  assert.deepStrictEqual(r, { url: 'https://sportsbook.draftkings.com/event/12345', domain: 'sportsbook.draftkings.com', kind: 'book' });
});

run('DraftKings dkng.co short host → book', () => {
  const r = lr.detectShareLink('here https://dkng.co/abcdef');
  assert.deepStrictEqual(r, { url: 'https://dkng.co/abcdef', domain: 'dkng.co', kind: 'book' });
});

run('bit.ly shortlink → shortlink', () => {
  const r = lr.detectShareLink('Load here: https://bit.ly/Dinger0519');
  assert.deepStrictEqual(r, { url: 'https://bit.ly/Dinger0519', domain: 'bit.ly', kind: 'shortlink' });
});

run('tinyurl.com shortlink → shortlink', () => {
  const r = lr.detectShareLink('https://tinyurl.com/sgp-417');
  assert.strictEqual(r.kind, 'shortlink');
  assert.strictEqual(r.domain, 'tinyurl.com');
});

run('subdomain of a book host suffix-matches → book', () => {
  const r = lr.detectShareLink('https://eu.sportsbook.fanduel.com/x');
  assert.ok(r && r.kind === 'book');
  assert.strictEqual(r.domain, 'eu.sportsbook.fanduel.com');
});

run('trailing punctuation is stripped from the matched URL', () => {
  const r = lr.detectShareLink('bet: https://bit.ly/abc123. nice');
  assert.strictEqual(r.url, 'https://bit.ly/abc123');
});

run('URL inside markdown parens is captured without the paren', () => {
  const r = lr.detectShareLink('[slip](https://share.hardrock.bet/xyz)');
  assert.strictEqual(r.url, 'https://share.hardrock.bet/xyz');
  assert.strictEqual(r.kind, 'book');
});

run('first allow-listed URL wins when multiple present', () => {
  const r = lr.detectShareLink('promo https://dubclub.win/x then https://bit.ly/real');
  assert.strictEqual(r.domain, 'bit.ly');
});

run('url field is truncated to ≤200 chars', () => {
  const long = 'https://bit.ly/' + 'a'.repeat(500);
  const r = lr.detectShareLink(long);
  assert.ok(r);
  assert.ok(r.url.length <= 200, `url length ${r.url.length} should be ≤200`);
});

console.log('linkReader.detectShareLink — negatives (allow-list only):');

run('dubclub.win promo → null', () => {
  assert.strictEqual(lr.detectShareLink('New plays! https://dubclub.win/c/capper'), null);
});

run('whop.com → null', () => {
  assert.strictEqual(lr.detectShareLink('join https://whop.com/picks'), null);
});

run('linktr.ee → null', () => {
  assert.strictEqual(lr.detectShareLink('https://linktr.ee/capper'), null);
});

run('discord.com message link (the messageUrl shape) → null', () => {
  assert.strictEqual(lr.detectShareLink('https://discord.com/channels/123/456/789'), null);
});

run('x.com social link → null', () => {
  assert.strictEqual(lr.detectShareLink('https://x.com/capper/status/123'), null);
});

run('plain text with no URL → null', () => {
  assert.strictEqual(lr.detectShareLink('$10 to win $413 if these two guys go yard'), null);
});

run('scheme-less domain text → null (requires http/https)', () => {
  assert.strictEqual(lr.detectShareLink('go to share.hardrock.bet/abc for the slip'), null);
});

run('look-alike host does NOT substring-match a book host → null', () => {
  assert.strictEqual(lr.detectShareLink('https://share.hardrock.bet.evil.com/x'), null);
  assert.strictEqual(lr.detectShareLink('https://notshare.hardrock.bet/x'), null);
});

run('bare hardrock.bet (no share. prefix) is not on the list → null', () => {
  assert.strictEqual(lr.detectShareLink('https://hardrock.bet/promo'), null);
});

run('non-string / empty input → null, never throws', () => {
  assert.strictEqual(lr.detectShareLink(null), null);
  assert.strictEqual(lr.detectShareLink(undefined), null);
  assert.strictEqual(lr.detectShareLink(42), null);
  assert.strictEqual(lr.detectShareLink({}), null);
  assert.strictEqual(lr.detectShareLink(''), null);
});

console.log('linkReader.attachShareLink — off vs shadow payload behavior:');

const BOOK_TEXT = 'Check out this bet I placed on Hard Rock Bet! https://share.hardrock.bet/abc123';

run('MODE off (env unset) → no-op: payload byte-identical, no share_link', () => {
  const off = loadFresh(undefined);
  assert.strictEqual(off.MODE, 'off');
  const payload = { reason: 'ai_is_bet_false', sample: 'x'.repeat(120) };
  const before = JSON.stringify(payload);
  const out = off.attachShareLink(payload, BOOK_TEXT);
  assert.strictEqual(out, payload, 'returns the same object');
  assert.ok(!('share_link' in out), 'off-mode adds no share_link');
  assert.strictEqual(JSON.stringify(out), before, 'payload unchanged byte-for-byte');
});

run('MODE off for an explicit non-shadow value (e.g. "cutover") → no-op', () => {
  const cut = loadFresh('cutover');
  assert.strictEqual(cut.MODE, 'off', 'cutover is treated as off in Phase A');
  const payload = { reason: 'ai_is_bet_false' };
  cut.attachShareLink(payload, BOOK_TEXT);
  assert.ok(!('share_link' in payload), 'cutover adds no share_link in Phase A');
});

run('MODE shadow + book link → additive share_link field', () => {
  const sh = loadFresh('shadow');
  assert.strictEqual(sh.MODE, 'shadow');
  const payload = { reason: 'ai_is_bet_false', sample: 'x' };
  const out = sh.attachShareLink(payload, BOOK_TEXT);
  assert.strictEqual(out, payload, 'mutates and returns the same object');
  assert.deepStrictEqual(out.share_link, { url: 'https://share.hardrock.bet/abc123', domain: 'share.hardrock.bet', kind: 'book' });
  assert.strictEqual(out.reason, 'ai_is_bet_false', 'existing fields untouched');
});

run('MODE shadow but no link in text → no share_link added', () => {
  const sh = loadFresh('shadow');
  const payload = { reason: 'ai_indeterminate_no_bets' };
  sh.attachShareLink(payload, 'just some plain text, no url');
  assert.ok(!('share_link' in payload), 'shadow + no link → field absent');
});

console.log('linkReader.attachShareLink — sportsbook_brand reject payload (Phase A.1):');

// The exact payload shape the BOUNCER_REJECTED drop sites build for a
// sportsbook_brand rejection (handlers/messageHandler.js dropAll site ~1370).
// Phase A.1 calls attachShareLink on it so a share-wrapper whose text the parser
// hallucinated into a bet is counted in shadow, the same as the hold sites.
const brandRejectPayload = () => ({
  validator: 'sportsbook_brand',
  issues: ['Description matches sportsbook brand name'],
  description: 'DraftKings Sportsbook',
});
const BRAND_WRAPPER_TEXT = 'Tail my slip 👉 https://dkng.co/abcdef';

run('brand-reject payload gains share_link in shadow when text carries an allow-listed URL', () => {
  const sh = loadFresh('shadow');
  const payload = brandRejectPayload();
  const out = sh.attachShareLink(payload, BRAND_WRAPPER_TEXT);
  assert.strictEqual(out, payload, 'mutates and returns the same payload object');
  assert.deepStrictEqual(out.share_link, { url: 'https://dkng.co/abcdef', domain: 'dkng.co', kind: 'book' });
  // Existing payload fields are untouched.
  assert.strictEqual(out.validator, 'sportsbook_brand');
  assert.deepStrictEqual(out.issues, ['Description matches sportsbook brand name']);
  assert.strictEqual(out.description, 'DraftKings Sportsbook');
});

run('brand-reject payload is byte-identical in off mode (no share_link)', () => {
  const off = loadFresh(undefined);
  assert.strictEqual(off.MODE, 'off');
  const payload = brandRejectPayload();
  const before = JSON.stringify(payload);
  const out = off.attachShareLink(payload, BRAND_WRAPPER_TEXT);
  assert.strictEqual(out, payload, 'returns the same object');
  assert.ok(!('share_link' in out), 'off-mode adds no share_link to a brand-reject payload');
  assert.strictEqual(JSON.stringify(out), before, 'payload unchanged byte-for-byte');
});

run('brand-reject payload gets no share_link in shadow when text carries no allow-listed URL', () => {
  const sh = loadFresh('shadow');
  const payload = brandRejectPayload();
  // Brand name in the text, but no book/shortlink URL — the common promo-brand case.
  sh.attachShareLink(payload, 'DraftKings Sportsbook best ball promo, no link here');
  assert.ok(!('share_link' in payload), 'shadow + no allow-listed URL → field absent');
});

run('brand-reject payload: promo / social URLs are NOT annotated (allow-list only)', () => {
  const sh = loadFresh('shadow');
  const payload = brandRejectPayload();
  sh.attachShareLink(payload, 'FanDuel picks here https://dubclub.win/c/x and https://x.com/y/status/1');
  assert.ok(!('share_link' in payload), 'non-allow-listed URLs leave a brand-reject payload unannotated');
});

console.log(`\nlink-reader: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
