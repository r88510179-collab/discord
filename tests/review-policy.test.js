// ═══════════════════════════════════════════════════════════
// Review-gate auto-confirm policy (PR-3) — services/reviewPolicy.js.
//
// Pure, no DB: reviewPolicy is a leaf module with zero requires, so this
// test never opens a database and never touches the network.
//
// The headline pin: with REVIEW_AUTO_CONFIRM unset (or set to anything
// unknown), reviewStatusFor returns the call site's legacyStatus
// unchanged — both ingest paths are byte-identical to pre-PR behavior.
//
// Run:  node tests/review-policy.test.js
// ═══════════════════════════════════════════════════════════
'use strict';

const assert = require('assert');
const { resolveAutoConfirmMode, parseTrustedCappers, isTrustedCapper, reviewStatusFor } = require('../services/reviewPolicy');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}\n     ${e.message}`);
  }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

console.log('review-policy: resolveAutoConfirmMode');

t('unset → off', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: undefined }, () => assert.strictEqual(resolveAutoConfirmMode(), 'off'));
});
t("'trusted' → trusted, 'all' → all", () => {
  assert.strictEqual(resolveAutoConfirmMode('trusted'), 'trusted');
  assert.strictEqual(resolveAutoConfirmMode('all'), 'all');
});
t('anything else → off (strict compare, repo mode-flag convention)', () => {
  for (const raw of ['', 'on', 'TRUSTED', 'All', ' trusted', 'enforce', '1', null, undefined]) {
    assert.strictEqual(resolveAutoConfirmMode(raw), 'off', `raw=${JSON.stringify(raw)}`);
  }
});

console.log('review-policy: parseTrustedCappers');

t('trims, lowercases, strips leading @, drops empties', () => {
  const set = parseTrustedCappers(' @BigHammer , dan123,  ,TWITTER_cody, ');
  assert.deepStrictEqual([...set].sort(), ['bighammer', 'dan123', 'twitter_cody']);
});
t('unset/empty → empty set', () => {
  assert.strictEqual(parseTrustedCappers(undefined).size, 0);
  assert.strictEqual(parseTrustedCappers('').size, 0);
});

console.log('review-policy: reviewStatusFor — off/unset passthrough');

const CAPPER = { id: 'abc123', discord_id: 'twitter_bighammer', twitter_handle: 'bighammer', display_name: 'Big Hammer' };

t('mode unset → legacyStatus passthrough (needs_review)', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: undefined, TRUSTED_CAPPER_IDS: 'bighammer' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: undefined, legacyStatus: 'needs_review' }), 'needs_review');
  });
});
t('mode unset → legacyStatus passthrough (confirmed)', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: undefined }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'high', legacyStatus: 'confirmed' }), 'confirmed');
  });
});
t('unknown mode value behaves as off', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'yes-please', TRUSTED_CAPPER_IDS: 'bighammer' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: undefined, legacyStatus: 'needs_review' }), 'needs_review');
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: undefined, legacyStatus: 'confirmed' }), 'confirmed');
  });
});

console.log('review-policy: reviewStatusFor — all');

t("mode 'all' confirms", () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'all' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'high', legacyStatus: 'needs_review' }), 'confirmed');
    assert.strictEqual(reviewStatusFor({ capper: null, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
});
t("mode 'all' with confidence:'low' still holds", () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'all' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'low', legacyStatus: 'confirmed' }), 'needs_review');
  });
});

console.log('review-policy: reviewStatusFor — trusted');

t('trusted matches by capper id', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'abc123' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'high', legacyStatus: 'needs_review' }), 'confirmed');
  });
});
t('trusted matches by discord_id, with and without twitter_ prefix', () => {
  // List holds the bare handle; the twitter-handler capper row stores
  // discord_id='twitter_<handle>' (services/twitter-handler.js getOrCreateCapper call).
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'bighammer' }, () => {
    const twitterRow = { id: 'x', discord_id: 'twitter_bighammer', twitter_handle: null, display_name: '@bighammer' };
    assert.strictEqual(reviewStatusFor({ capper: twitterRow, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'twitter_bighammer' }, () => {
    const twitterRow = { id: 'x', discord_id: 'twitter_bighammer', twitter_handle: null, display_name: 'zz' };
    assert.strictEqual(reviewStatusFor({ capper: twitterRow, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: '998877665544' }, () => {
    const discordRow = { id: 'y', discord_id: '998877665544', twitter_handle: null, display_name: 'Dan' };
    assert.strictEqual(reviewStatusFor({ capper: discordRow, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
});
t('trusted matches twitter_handle listed with leading @', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: '@BigHammer' }, () => {
    const row = { id: 'x', discord_id: null, twitter_handle: 'bighammer', display_name: 'zz' };
    assert.strictEqual(reviewStatusFor({ capper: row, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
});
t('trusted matches display_name case-insensitively', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'big hammer' }, () => {
    const row = { id: 'x', discord_id: null, twitter_handle: null, display_name: 'Big Hammer' };
    assert.strictEqual(reviewStatusFor({ capper: row, confidence: undefined, legacyStatus: 'needs_review' }), 'confirmed');
  });
});
t("trusted with confidence:'low' still holds", () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'abc123' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'low', legacyStatus: 'confirmed' }), 'needs_review');
  });
});
t('trusted with unlisted capper → legacyStatus', () => {
  withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: 'someoneelse' }, () => {
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: undefined, legacyStatus: 'needs_review' }), 'needs_review');
    assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: 'high', legacyStatus: 'confirmed' }), 'confirmed');
  });
});
t('trusted with empty TRUSTED_CAPPER_IDS → legacyStatus', () => {
  for (const raw of [undefined, '', ' , ,']) {
    withEnv({ REVIEW_AUTO_CONFIRM: 'trusted', TRUSTED_CAPPER_IDS: raw }, () => {
      assert.strictEqual(reviewStatusFor({ capper: CAPPER, confidence: undefined, legacyStatus: 'needs_review' }), 'needs_review', `raw=${JSON.stringify(raw)}`);
    });
  }
});

console.log('review-policy: isTrustedCapper edge cases');

t('null/undefined capper or empty set → false', () => {
  const set = parseTrustedCappers('bighammer');
  assert.strictEqual(isTrustedCapper(null, set), false);
  assert.strictEqual(isTrustedCapper(undefined, set), false);
  assert.strictEqual(isTrustedCapper(CAPPER, new Set()), false);
  assert.strictEqual(isTrustedCapper(CAPPER, null), false);
});
t('capper with all-null identity fields → false', () => {
  const set = parseTrustedCappers('bighammer');
  assert.strictEqual(isTrustedCapper({ id: null, discord_id: null, twitter_handle: null, display_name: null }, set), false);
});

console.log(`\nreview-policy: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
