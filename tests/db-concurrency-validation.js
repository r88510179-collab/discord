const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  process.env.DB_PATH = workerData.dbPath;
  const database = require('../services/database');

  try {
    const bet = database.createBetWithLegs({
      capper_id: workerData.capperId,
      sport: 'NBA',
      league: 'NBA',
      bet_type: 'parlay',
      description: 'Lakers ML + Over 220.5',
      odds: 250,
      units: 1,
      source: 'discord',
      source_channel_id: 'channel_race',
      source_message_id: workerData.messageId,
      raw_text: 'Lakers ML + Over 220.5 +250 1u',
    }, [
      { description: 'Lakers ML', odds: -120 },
      { description: 'Over 220.5', odds: -110 },
    ]);

    parentPort.postMessage({ ok: true, betId: bet.id, deduped: !!bet._deduped });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  } finally {
    database.db.close();
  }
  return;
}

function runWorker(dbPath, capperId, messageId) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { dbPath, capperId, messageId } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

function initCapper(dbPath) {
  process.env.DB_PATH = dbPath;
  const dbModulePath = path.resolve(__dirname, '../services/database.js');
  delete require.cache[dbModulePath];
  // eslint-disable-next-line global-require
  const database = require('../services/database');
  const capper = database.getOrCreateCapper('race_user', 'Race User', null);
  database.db.close();
  return capper.id;
}

async function runIteration(iteration, workers = 10) {
  const dbPath = path.join(os.tmpdir(), `bettracker-race-${Date.now()}-${iteration}.db`);
  const capperId = initCapper(dbPath);
  const messageId = `message_race_${iteration}`;

  const results = await Promise.all(
    Array.from({ length: workers }, () => runWorker(dbPath, capperId, messageId)),
  );

  for (const [idx, result] of results.entries()) {
    assert.ok(result.ok, `worker ${idx} failed: ${result.error || 'unknown error'}`);
  }

  const dedupeCount = results.filter((r) => r.deduped).length;
  const nonDedupeCount = results.length - dedupeCount;
  assert.strictEqual(nonDedupeCount, 1, 'exactly one worker should perform the committed insert path');
  assert.strictEqual(dedupeCount, workers - 1, 'remaining workers should resolve through dedupe/constraint handling');

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);

  const betCount = db.prepare('SELECT COUNT(*) AS c FROM bets').get().c;
  const legCount = db.prepare('SELECT COUNT(*) AS c FROM parlay_legs').get().c;
  db.close();

  assert.strictEqual(betCount, 1, 'exactly one bet row should be committed');
  assert.strictEqual(legCount, 2, 'duplicate race should not create extra parlay leg rows');

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

async function run() {
  const iterations = 3;
  for (let i = 1; i <= iterations; i++) {
    await runIteration(i, 10);
  }
  console.log('DB concurrency validation passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
