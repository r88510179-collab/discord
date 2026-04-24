// pull-batch.template.js
// Pulls the next 25 pending bets from bettracker.db, excluding IDs already graded
// across prior batches. Uploaded to /tmp/pull-batch.js on Fly and run via:
//   fly ssh console -a bettracker-discord-bot -C 'bash -c "NODE_PATH=/app/node_modules node /tmp/pull-batch.js"' > batch_NN.json
//
// Before using: paste all already-graded bet_ids (32-char hex) into EXCLUDED_IDS below.
// One ID per line, inside the array. Keep this list synced with the final JSONs.

const Database = require('better-sqlite3');
const db = new Database('/data/bettracker.db', { readonly: true });

const EXCLUDED_IDS = [
  // Paste all bet_ids from graded_batch_01_final.json through graded_batch_NN_final.json here.
  // Example:
  // '204a6fcf64c3e3d7746d95a59f9dc832',
  // 'b1c149222f1ee1e9841646d6c280c371',
  // ...
];

const placeholders = EXCLUDED_IDS.length > 0
  ? EXCLUDED_IDS.map(() => '?').join(',')
  : null;

const sql = placeholders
  ? `SELECT id, description, created_at, event_date, odds, units, sport, league, capper_id, source, source_url
     FROM bets
     WHERE result = 'pending' AND id NOT IN (${placeholders})
     ORDER BY created_at ASC
     LIMIT 25`
  : `SELECT id, description, created_at, event_date, odds, units, sport, league, capper_id, source, source_url
     FROM bets
     WHERE result = 'pending'
     ORDER BY created_at ASC
     LIMIT 25`;

const rows = placeholders
  ? db.prepare(sql).all(...EXCLUDED_IDS)
  : db.prepare(sql).all();

console.log(JSON.stringify(rows, null, 2));
