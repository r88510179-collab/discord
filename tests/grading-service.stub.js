const assert = require('assert');
const grading = require('../services/grading');

assert.strictEqual(typeof grading.runAutoGrade, 'function');
assert.strictEqual(typeof grading.calcProfit, 'function');
assert.strictEqual(typeof grading.determineResult, 'function');

console.log('✅ grading-service.stub passed');
