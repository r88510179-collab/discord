const assert = require('assert');
const odds = require('../services/odds');

assert.strictEqual(typeof odds.shopLine, 'function');
assert.strictEqual(typeof odds.formatLineShop, 'function');
assert.strictEqual(typeof odds.extractTeamFromDescription, 'function');

console.log('✅ odds-service.stub passed');
