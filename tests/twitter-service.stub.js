const assert = require('assert');
const twitter = require('../services/twitter');

assert.strictEqual(typeof twitter.pollCappers, 'function');
assert.strictEqual(typeof twitter.loginTwitter, 'function');

console.log('✅ twitter-service.stub passed');
