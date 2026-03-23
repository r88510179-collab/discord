/**
 * ── Migrate SQLite → Supabase ───────────────────────────────
 *
 * Run this when you're ready to connect to ZoneTracker.
 *
 * Usage:
 *   1. Add SUPABASE_URL and SUPABASE_KEY to your .env
 *   2. Run the supabase-setup.sql in your Supabase SQL Editor
 *   3. npm run migrate
 *
 * This copies all data from bettracker.db → Supabase and
 * leaves the SQLite file intact as a backup.
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bettracker.db');

async function migrate() {
  // ── Validate env ────────────────────────────────────────
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('❌ Set SUPABASE_URL and SUPABASE_KEY in .env first.');
    console.error('   Also make sure you\'ve run supabase-setup.sql in Supabase SQL Editor.');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const tables = ['cappers', 'bets', 'parlay_legs', 'bankrolls', 'tracked_twitter', 'daily_snapshots'];

  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) {
      console.log(`⏭️  ${table}: empty, skipping`);
      continue;
    }

    // Insert in batches of 100
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await supabase.from(table).upsert(batch, { onConflict: 'id' });
      if (error) {
        console.error(`❌ ${table} batch ${i}: ${error.message}`);
      }
    }
    console.log(`✅ ${table}: migrated ${rows.length} rows`);
  }

  db.close();
  console.log('\n🎉 Migration complete! Your SQLite file is still intact as a backup.');
  console.log('   To switch the bot to Supabase, swap services/database.js back to the Supabase version.');
}

migrate().catch(console.error);
