// One-shot migration: normalize human-readable event_date values to ISO format
// Run via: fly ssh console -a bettracker-discord-bot -C "node /app/scripts/normalize_event_dates.js"

const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db');

// Inline normalizer (avoid circular require issues)
function normalizeEventDate(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') raw = String(raw);
  const tryISO = new Date(raw);
  if (!isNaN(tryISO.getTime()) && raw.length > 8) return tryISO.toISOString();
  const now = new Date();
  const yr = now.getFullYear();
  let m;
  m = raw.match(/(\w{3})\s+(\w{3})\s+(\d{1,2})(?:\s*@\s*|\s+)(\d{1,2}):?(\d{0,2})\s*(am|pm)/i);
  if (m) { const a = new Date(`${m[2]} ${m[3]} ${yr} ${m[4]}:${m[5]||'00'} ${m[6]}`); if (!isNaN(a.getTime())) return a.toISOString(); }
  m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) { const a = new Date(); let h = parseInt(m[1]); if (m[3].toLowerCase()==='pm'&&h!==12) h+=12; if (m[3].toLowerCase()==='am'&&h===12) h=0; a.setHours(h, parseInt(m[2]), 0, 0); return a.toISOString(); }
  m = raw.match(/(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) { const days={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}; const t=days[m[1].toLowerCase().slice(0,3)]; const a=new Date(); const d=(t-a.getDay()+7)%7; a.setDate(a.getDate()+(d===0?7:d)); let h=parseInt(m[2]); if(m[4].toLowerCase()==='pm'&&h!==12) h+=12; if(m[4].toLowerCase()==='am'&&h===12) h=0; a.setHours(h,parseInt(m[3]),0,0); return a.toISOString(); }
  m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) { let y=parseInt(m[3]); if(y<100) y+=2000; const a=new Date(y,parseInt(m[1])-1,parseInt(m[2])); let h=parseInt(m[4]); if(m[6].toLowerCase()==='pm'&&h!==12) h+=12; if(m[6].toLowerCase()==='am'&&h===12) h=0; a.setHours(h,parseInt(m[5]),0,0); return a.toISOString(); }
  return null;
}

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

const rows = db.prepare(`
  SELECT id, event_date FROM bets
  WHERE event_date IS NOT NULL
  AND (event_date LIKE '%@%' OR event_date LIKE '%AM%' OR event_date LIKE '%PM%'
       OR event_date LIKE '%am%' OR event_date LIKE '%pm%'
       OR event_date LIKE '%MON%' OR event_date LIKE '%TUE%' OR event_date LIKE '%WED%'
       OR event_date LIKE '%THU%' OR event_date LIKE '%FRI%' OR event_date LIKE '%SAT%' OR event_date LIKE '%SUN%')
`).all();

let fixed = 0, failed = 0;
for (const row of rows) {
  const normalized = normalizeEventDate(row.event_date);
  if (normalized) {
    db.prepare('UPDATE bets SET event_date=? WHERE id=?').run(normalized, row.id);
    console.log(`[FIXED] ${row.id.slice(0, 8)}: "${row.event_date}" → "${normalized}"`);
    fixed++;
  } else {
    console.log(`[FAILED] ${row.id.slice(0, 8)}: "${row.event_date}"`);
    failed++;
  }
}
console.log(`\nSummary: fixed ${fixed}, failed ${failed} (of ${rows.length} total)`);
db.close();
