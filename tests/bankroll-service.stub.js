const assert = require('assert');
const bankroll = require('../services/bankroll');

assert.strictEqual(typeof bankroll.calculateOptimalBet, 'function');
assert.strictEqual(typeof bankroll.americanToDecimal, 'function');
assert.strictEqual(typeof bankroll.impliedProbability, 'function');

console.log('✅ bankroll-service.stub passed');
