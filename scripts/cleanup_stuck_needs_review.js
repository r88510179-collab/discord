// One-time cleanup: bets that were graded but stuck in needs_review
// Run via: fly ssh console -a bettracker-discord-bot -C "node /app/scripts/cleanup_stuck_needs_review.js"

const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/bettracker.db');

const stuck = db.prepare(`
  SELECT id, description, result, graded_at
  FROM bets
  WHERE review_status = 'needs_review'
    AND result IN ('win', 'loss', 'void', 'push')
`).all();

console.log(`Found ${stuck.length} graded bets stuck in needs_review`);
for (const bet of stuck) {
  console.log(`  ${bet.id.slice(0, 8)} | ${bet.result.toUpperCase().padEnd(5)} | ${bet.description?.slice(0, 50)}`);
}

if (stuck.length > 0) {
  const result = db.prepare(`
    UPDATE bets SET review_status = 'confirmed'
    WHERE review_status = 'needs_review'
      AND result IN ('win', 'loss', 'void', 'push')
  `).run();
  console.log(`\nAuto-confirmed ${result.changes} bets`);
} else {
  console.log('\nNo stuck bets found — all clean.');
}
db.close();
