// Cleanup: only auto-confirm bets graded via trusted paths (capper celebration, manual)
// AI-graded bets in needs_review stay for manual review
// Run via: fly ssh console -a bettracker-discord-bot -C "node /app/scripts/cleanup_stuck_needs_review.js"

const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/bettracker.db');

const stuck = db.prepare(`
  SELECT id, description, result, graded_at, grade_reason
  FROM bets
  WHERE review_status = 'needs_review'
    AND result IN ('win', 'loss', 'void', 'push')
    AND (grade_reason LIKE 'Auto-graded from capper celebration:%'
         OR grade_reason LIKE 'Manually graded%'
         OR grade_reason LIKE 'Auto-graded from capper graphic%'
         OR grade_reason LIKE 'Auto-swept:%')
`).all();

console.log(`Found ${stuck.length} trusted-graded bets stuck in needs_review`);
for (const bet of stuck) {
  console.log(`  ${bet.id.slice(0, 8)} | ${bet.result.toUpperCase().padEnd(5)} | ${(bet.grade_reason || '').slice(0, 40)} | ${bet.description?.slice(0, 40)}`);
}

if (stuck.length > 0) {
  const result = db.prepare(`
    UPDATE bets SET review_status = 'confirmed'
    WHERE review_status = 'needs_review'
      AND result IN ('win', 'loss', 'void', 'push')
      AND (grade_reason LIKE 'Auto-graded from capper celebration:%'
           OR grade_reason LIKE 'Manually graded%'
           OR grade_reason LIKE 'Auto-graded from capper graphic%'
           OR grade_reason LIKE 'Auto-swept:%')
  `).run();
  console.log(`\nAuto-confirmed ${result.changes} trusted-graded bets`);
} else {
  console.log('\nNo stuck trusted-graded bets found.');
}

// Show AI-graded needs_review bets (intentionally NOT auto-confirmed)
const aiGraded = db.prepare(`
  SELECT id, description, result, grade_reason
  FROM bets
  WHERE review_status = 'needs_review'
    AND result IN ('win', 'loss', 'void', 'push')
    AND grade_reason LIKE 'AI Grader:%'
`).all();
if (aiGraded.length > 0) {
  console.log(`\n${aiGraded.length} AI-graded bet(s) remain in needs_review (intentional — awaiting manual review):`);
  for (const b of aiGraded) console.log(`  ${b.id.slice(0, 8)} | ${b.result.toUpperCase().padEnd(5)} | ${b.description?.slice(0, 50)}`);
}

db.close();
