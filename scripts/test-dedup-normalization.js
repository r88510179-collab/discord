#!/usr/bin/env node
/* eslint-disable */
// scripts/test-dedup-normalization.js
//
// Cat D Phase 1.5 smoke test of the *production* dedup normalization.
// Imports normalizeLeg directly from services/database.js so any future
// regression in the production helper is caught here.
//
// Required pass rates (Phase 1.5 baseline reproduced in main checkout):
//   KNOWN_BAD            >= 15/16   (case 11 V. Wembanyama is out of scope)
//   SHOULD_STAY_SEPARATE >= 10/10   (zero false positives)
//
// Exits 1 if either threshold drops. Safe to run repeatedly — uses a temp
// DB_PATH so services/database.js's startup migrations do not touch prod.

const fs = require('fs');

process.env.DB_PATH = process.env.DB_PATH || '/tmp/cat-d-smoke-test.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const { normalizeLeg } = require('../services/database');

// Mirror of the legacy production key for diagnostic output.
function currentNormalize(description) {
  return (description || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

const KNOWN_BAD_CASES = [
  ['Evan Mobley TO RECORD 25+ PTS + REB + AST', 'EVAN MOBLEY 25+ PTS + REB + AST'],
  ['Cade Cunningham TO RECORD 35+ PTS + AST', 'CADE CUNNINGHAM 35+ PTS + AST'],
  ['Paul Reed TO SCORE 5+ POINTS', 'PAUL REED 5+ POINTS'],
  ['Dylan Harper TO SCORE 10+ POINTS', 'DYLAN HARPER 10+ POINTS'],
  ['Naz Reid TO SCORE 10+ POINTS', 'NAZ REID 10+ POINTS'],
  ['Victor Wembanyama TO RECORD 12+ REBOUNDS', 'VICTOR WEMBANYAMA 12+ REBOUNDS'],
  ['VJ Edgecombe TO SCORE 10+ POINTS', 'VJ EDGECOMBE 10+ POINTS'],
  ['Tyrese Maxey TO RECORD 6+ ASSISTS', 'TYRESE MAXEY 6+ ASSISTS'],
  ['Jalen Brunson TO RECORD 30+ PTS + AST', 'JALEN BRUNSON 30+ PTS + AST'],
  ['30+ Anthony Edwards Points + Rebounds + Assists', 'ANTHONY EDWARDS 30+ PRAS'],
  ['10+ Victor Wembanyama Rebounds', 'V. WEMBANYAMA 10+ REBOUNDS'],
  ["5+ De'Aaron Fox Assists", "DE'AARON FOX 5+ ASSISTS"],
  ['5+ Naz Reid Rebounds', 'NAZ REID 5+ REBOUNDS'],
  ['25+ Tobias Harris Points + Rebounds + Assists', 'TOBIAS HARRIS 25+ PRAS'],
  ['2+ Cade Cunningham Three Pointers Made', 'CADE CUNNINGHAM 2+ THREES MADE'],
  ['6+ James Harden Assists', 'JAMES HARDEN 6+ ASSISTS'],
];

const SHOULD_STAY_SEPARATE_CASES = [
  ['LeBron James Over 25.5 Points', 'LeBron James Over 8.5 Rebounds'],
  ['Bobby Witt Jr 1+ Hits', 'Bobby Witt Jr 2+ Hits'],
  ['Stephen Curry 4+ Three Pointers Made', 'Stephen Curry 5+ Three Pointers Made'],
  ['Aaron Judge To Hit A Home Run', 'Aaron Judge 2+ Total Bases'],
  ['Tarik Skubal Over 5.5 Strikeouts', 'Tarik Skubal Over 17.5 Pitching Outs'],
  ['Anthony Edwards 30+ PRAs', 'Anthony Edwards Over 5.5 Assists'],
  ['Lakers -5', 'Lakers ML'],
  ['Dodgers -1.5', 'Dodgers Over 8.5'],
  ['Mookie Betts 1+ Home Runs', 'Mookie Betts 2+ Total Bases'],
  ['Connor McDavid Any Time Goal Scorer', 'Connor McDavid 3+ Shots on Goal'],
];

function compareCases(label, cases, expectDedup) {
  console.log(`\n=== ${label} ===`);
  let passed = 0;
  const fails = [];
  cases.forEach((pair, i) => {
    const [left, right] = pair;
    const curMatch = currentNormalize(left) === currentNormalize(right);
    const newL = normalizeLeg(left);
    const newR = normalizeLeg(right);
    const newMatch = newL === newR;
    const pass = expectDedup ? newMatch : !newMatch;

    console.log(`[${i + 1}/${cases.length}] left:  "${left}"`);
    console.log(`       right: "${right}"`);
    if (expectDedup) {
      console.log(`       currentNormalize: keys ${curMatch ? 'match  (already deduped)' : 'differ (FAILS pre-fix — bad)'}`);
      console.log(`       normalizeLeg:     keys ${newMatch ? 'match  (PASSES — good)' : 'differ (FAILS — still bad)'}`);
    } else {
      console.log(`       normalizeLeg: keys ${newMatch ? 'match  (INCORRECTLY COLLAPSED — false positive)' : 'differ (correct — kept separate)'}`);
    }
    console.log(`       L: "${newL}"`);
    console.log(`       R: "${newR}"`);
    console.log(`       Pass: ${pass ? 'YES' : 'NO'}\n`);
    if (pass) passed++;
    else fails.push({ i: i + 1, left, right, newL, newR });
  });
  return { passed, total: cases.length, fails };
}

const knownBadResult = compareCases('KNOWN_BAD_CASES (must dedup)', KNOWN_BAD_CASES, true);
const stayResult = compareCases('SHOULD_STAY_SEPARATE_CASES (must NOT dedup)', SHOULD_STAY_SEPARATE_CASES, false);

console.log('\n=== SUMMARY ===');
console.log(`KNOWN_BAD pass rate: ${knownBadResult.passed}/${knownBadResult.total}`);
console.log(`SHOULD_STAY_SEPARATE pass rate: ${stayResult.passed}/${stayResult.total}`);

console.log('\n=== FAILURES ===');
if (knownBadResult.fails.length === 0 && stayResult.fails.length === 0) {
  console.log('none');
} else {
  if (knownBadResult.fails.length > 0) {
    console.log('KNOWN_BAD cases that normalizeLeg did NOT catch:');
    knownBadResult.fails.forEach((f) => {
      console.log(`  [${f.i}] "${f.left}" vs "${f.right}"`);
      console.log(`        L: "${f.newL}"`);
      console.log(`        R: "${f.newR}"`);
    });
  }
  if (stayResult.fails.length > 0) {
    console.log('SHOULD_STAY_SEPARATE cases that normalizeLeg INCORRECTLY collapsed:');
    stayResult.fails.forEach((f) => {
      console.log(`  [${f.i}] "${f.left}" vs "${f.right}"`);
      console.log(`        both → "${f.newL}"`);
    });
  }
}

const REQUIRED_KB = 15;
const REQUIRED_SS = 10;
const ok = knownBadResult.passed >= REQUIRED_KB && stayResult.passed >= REQUIRED_SS;
if (!ok) {
  console.error(`\nFAIL: required KNOWN_BAD>=${REQUIRED_KB} (got ${knownBadResult.passed}), SHOULD_STAY_SEPARATE>=${REQUIRED_SS} (got ${stayResult.passed})`);
  process.exit(1);
}
console.log('\nPASS: production normalizeLeg matches Phase 1.5 validation.');
process.exit(0);
