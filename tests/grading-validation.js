const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aliasFixtures = require('./grading-alias-fixtures.json');

const { determineResult, matchBetToGame } = require('../services/grading');

function runMarketClassificationChecks() {
  const matchData = { homeScore: 108, awayScore: 102, isHome: true };

  // 1) Totals should not be misclassified as spread when odds are present.
  const totalBet = { description: 'Over 210.5 -110', bet_type: 'straight' };
  assert.strictEqual(determineResult(totalBet, matchData), 'loss', 'totals should evaluate by game total, not spread/odds tokens');

  // 2) Odds values alone should not be mistaken for lines.
  const oddsOnlyBet = { description: 'Lakers -110', bet_type: 'straight' };
  assert.strictEqual(determineResult(oddsOnlyBet, matchData), null, 'odds-only text should not be auto-graded as spread');
}

function runParlayAggregationChecks() {
  const matchData = { homeScore: 120, awayScore: 110, isHome: true };

  const parlayWin = { description: 'Lakers ML + Over 210.5', bet_type: 'parlay' };
  assert.strictEqual(determineResult(parlayWin, matchData), 'win', 'simple parlay should aggregate leg wins');

  const parlayLoss = { description: 'Lakers ML + Under 210.5', bet_type: 'parlay' };
  assert.strictEqual(determineResult(parlayLoss, matchData), 'loss', 'simple parlay should settle loss if any leg loses');
}

function runAliasMatchChecks() {
  for (const fixture of aliasFixtures) {
    const scores = [{
      home_team: fixture.home_team,
      away_team: fixture.away_team,
      completed: true,
      scores: [
        { name: fixture.home_team, score: '100' },
        { name: fixture.away_team, score: '95' },
      ],
    }];

    const matched = matchBetToGame({ description: fixture.description, sport: fixture.bet_sport || null }, scores);
    if (!fixture.should_match) {
      assert.strictEqual(matched, null, `expected ambiguous alias not to over-match for "${fixture.description}"`);
      continue;
    }

    assert.ok(matched, `expected alias to match game for "${fixture.description}"`);
    if (fixture.expect_home === true) {
      assert.strictEqual(matched.isHome, true, `expected home-team alias match for "${fixture.description}"`);
    }
  }
}

function runAlreadyGradedCheck() {
  const dbFile = path.join(os.tmpdir(), `bettracker-grade-validation-${Date.now()}.db`);
  process.env.DB_PATH = dbFile;

  const dbModulePath = path.resolve(__dirname, '../services/database.js');
  delete require.cache[dbModulePath];
  // eslint-disable-next-line global-require
  const database = require('../services/database');

  try {
    const capper = database.getOrCreateCapper('grader_user', 'Grader User', null);
    const bet = database.createBet({
      capper_id: capper.id,
      sport: 'NBA',
      bet_type: 'straight',
      description: 'Celtics ML',
      odds: -120,
      units: 1,
      source: 'manual',
    });

    assert.ok(database.getPendingBets().some((b) => b.id === bet.id), 'new bet should be pending');
    database.gradeBet(bet.id, 'win', 0.83, 'B', 'ok');
    assert.ok(!database.getPendingBets().some((b) => b.id === bet.id), 'graded bets should not be re-queued for grading');
  } finally {
    database.db.close();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
}

runMarketClassificationChecks();
runParlayAggregationChecks();
runAliasMatchChecks();
runAlreadyGradedCheck();
console.log('Grading validation passed.');
