const assert = require('assert');
const ai = require('../services/ai');

assert.strictEqual(typeof ai.extractPickFromTweet, 'function');
assert.strictEqual(typeof ai.parseBetText, 'function');

console.log('✅ bouncer-service.stub passed');
