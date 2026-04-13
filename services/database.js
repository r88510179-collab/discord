const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { runMigrations } = require('./migrator');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db');


const db = new Database(DB_PATH);

// ── Enable WAL mode for better performance ──────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ── Run migrations (creates/updates schema) ─────────────────
runMigrations(db);

// ── Users table (community bankrolls for Tail/Fade) ──────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    username  TEXT,
    bankroll  REAL NOT NULL DEFAULT 100.0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Twitter audit log table ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS twitter_audit_log (
    id TEXT PRIMARY KEY,
    tweet_id TEXT, handle TEXT, tweet_text TEXT, tweet_url TEXT,
    has_media INTEGER DEFAULT 0, posted_at TEXT,
    stage TEXT, reason TEXT, bet_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_twitter_audit_handle ON twitter_audit_log(handle)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_twitter_audit_stage ON twitter_audit_log(stage)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_twitter_audit_created ON twitter_audit_log(created_at)'); } catch (_) {}

// ── Processed tweets dedup table ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_tweets (
    tweet_id TEXT PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Additive: risk_amount column on user_bets ────────────────
try {
  const ubCols = db.prepare("PRAGMA table_info('user_bets')").all().map(c => c.name);
  if (!ubCols.includes('risk_amount')) db.exec('ALTER TABLE user_bets ADD COLUMN risk_amount REAL DEFAULT 1.0');
} catch (_) { /* table may not exist yet */ }

// ── Additive: season column on bets ─────────────────────────
try {
  const betCols = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  if (!betCols.includes('season')) db.exec("ALTER TABLE bets ADD COLUMN season TEXT NOT NULL DEFAULT 'Beta'");
} catch (_) { /* table may not exist yet */ }

// ── Additive: ladder columns on bets ────────────────────────
try {
  const betCols2 = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  if (!betCols2.includes('is_ladder')) db.exec('ALTER TABLE bets ADD COLUMN is_ladder INTEGER DEFAULT 0');
  if (!betCols2.includes('ladder_step')) db.exec('ALTER TABLE bets ADD COLUMN ladder_step INTEGER DEFAULT 0');
} catch (_) { /* table may not exist yet */ }

// ── Additive: bot_health_log table ──────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS bot_health_log (id TEXT PRIMARY KEY, report_type TEXT, section TEXT, metric TEXT, value REAL, details TEXT, created_at TEXT DEFAULT (datetime('now')))`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_health_log_type ON bot_health_log(report_type)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_health_log_created ON bot_health_log(created_at)'); } catch (_) {}

// ── Additive: evidence/graded_at/sport on parlay_legs ───────
try {
  const legCols = db.prepare("PRAGMA table_info('parlay_legs')").all().map(c => c.name);
  if (!legCols.includes('evidence')) db.exec('ALTER TABLE parlay_legs ADD COLUMN evidence TEXT');
  if (!legCols.includes('graded_at')) db.exec('ALTER TABLE parlay_legs ADD COLUMN graded_at TEXT');
  if (!legCols.includes('sport')) db.exec('ALTER TABLE parlay_legs ADD COLUMN sport TEXT');
} catch (_) {}

// ── Additive: slipfeed_message_id on bets ───────────────────
try {
  const betCols3 = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  if (!betCols3.includes('slipfeed_message_id')) db.exec('ALTER TABLE bets ADD COLUMN slipfeed_message_id TEXT');
} catch (_) {}

// ── Additive: source tweet fields on bets ───────────────────
try {
  const betCols4 = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  if (!betCols4.includes('source_tweet_id')) db.exec('ALTER TABLE bets ADD COLUMN source_tweet_id TEXT');
  if (!betCols4.includes('source_tweet_handle')) db.exec('ALTER TABLE bets ADD COLUMN source_tweet_handle TEXT');
} catch (_) {}

// ── Additive: grading_audit table ────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS grading_audit (
  id TEXT PRIMARY KEY, bet_id TEXT NOT NULL, attempt_num INTEGER NOT NULL,
  timestamp INTEGER NOT NULL, sport_in TEXT, sport_out TEXT, reclassified INTEGER DEFAULT 0,
  is_parlay INTEGER DEFAULT 0, leg_index INTEGER, leg_count INTEGER,
  search_backend TEXT, search_query TEXT, search_hits INTEGER, search_duration_ms INTEGER,
  provider_used TEXT, raw_response TEXT, guards_passed TEXT, guards_failed TEXT,
  final_status TEXT, final_evidence TEXT
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_grading_audit_bet ON grading_audit(bet_id)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_grading_audit_timestamp ON grading_audit(timestamp)'); } catch (_) {}

// ── Additive: grading_source_url on bets ────────────────────
try {
  const betCols5 = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
  if (!betCols5.includes('grading_source_url')) db.exec('ALTER TABLE bets ADD COLUMN grading_source_url TEXT');
} catch (_) {}

// ── Additive: capper calibration columns ────────────────────
try {
  const capCols = db.prepare("PRAGMA table_info('cappers')").all().map(c => c.name);
  if (!capCols.includes('calibrated_unit_size')) {
    db.exec("ALTER TABLE cappers ADD COLUMN calibrated_unit_size REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_median REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_p25 REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_p75 REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_stddev REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_cv REAL");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_sample_size INTEGER DEFAULT 0");
    db.exec("ALTER TABLE cappers ADD COLUMN calibration_status TEXT DEFAULT 'insufficient_data'");
    db.exec("ALTER TABLE cappers ADD COLUMN calibrated_at TEXT");
  }
} catch (_) {}

// ── Active season helper ────────────────────────────────────
const ACTIVE_SEASON = process.env.ACTIVE_SEASON || 'Beta';

// ── Prepared statements (fast) ──────────────────────────────
const stmts = {
  getCapper:         db.prepare('SELECT * FROM cappers WHERE discord_id = ?'),
  getCapperById:     db.prepare('SELECT * FROM cappers WHERE id = ?'),
  getCapperTwitter:  db.prepare('SELECT * FROM cappers WHERE lower(twitter_handle) = lower(?)'),
  insertCapper:      db.prepare('INSERT INTO cappers (id, discord_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'),
  insertCapperTwitter: db.prepare('INSERT INTO cappers (id, twitter_handle, display_name) VALUES (?, ?, ?)'),

  insertBet: db.prepare(`INSERT INTO bets (id, capper_id, sport, league, bet_type, description, odds, units, event_date, source, source_url, source_channel_id, source_message_id, fingerprint, raw_text, review_status, wager, payout, season, is_ladder, ladder_step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertLeg: db.prepare('INSERT INTO parlay_legs (id, bet_id, description, odds) VALUES (?, ?, ?, ?)'),
  gradeBet:  db.prepare('UPDATE bets SET result = ?, profit_units = ?, grade = ?, grade_reason = ?, graded_at = datetime(\'now\') WHERE id = ?'),
  getBet:    db.prepare('SELECT * FROM bets WHERE id = ?'),
  getBetByFingerprint: db.prepare('SELECT * FROM bets WHERE fingerprint = ?'),

  pendingBets: db.prepare(`SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id WHERE b.result = 'pending' ORDER BY b.created_at DESC`),
  needsReviewBets: db.prepare(`SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id WHERE b.review_status = 'needs_review' ORDER BY b.created_at DESC`),
  recentBets:  db.prepare('SELECT * FROM bets WHERE capper_id = ? ORDER BY created_at DESC LIMIT ?'),
  recentBetsAll: db.prepare('SELECT * FROM bets ORDER BY created_at DESC LIMIT ?'),

  getBankroll:    db.prepare('SELECT * FROM bankrolls WHERE capper_id = ?'),
  insertBankroll: db.prepare('INSERT OR REPLACE INTO bankrolls (id, capper_id, starting, current, unit_size, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'),
  updateBankroll: db.prepare('UPDATE bankrolls SET current = ?, updated_at = datetime(\'now\') WHERE capper_id = ?'),

  insertTracked: db.prepare('INSERT OR REPLACE INTO tracked_twitter (id, twitter_handle, display_name, guild_id, channel_id, active) VALUES (?, ?, ?, ?, ?, 1)'),
  getTracked:    db.prepare('SELECT * FROM tracked_twitter WHERE active = 1'),
  updateTweetId: db.prepare('UPDATE tracked_twitter SET last_tweet_id = ? WHERE lower(twitter_handle) = lower(?)'),

  upsertSnapshot: db.prepare(`INSERT OR REPLACE INTO daily_snapshots (id, capper_id, date, total_bets, wins, losses, pushes, profit_units, bankroll)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),

  getLastScan:  db.prepare('SELECT last_message_id FROM scan_state WHERE channel_id = ?'),
  setLastScan:  db.prepare('INSERT OR REPLACE INTO scan_state (channel_id, last_message_id, updated_at) VALUES (?, ?, datetime(\'now\'))'),

  // Duplicate detection — find similar bets from same capper in last 10 min
  findRecentSimilar: db.prepare(`SELECT id, description FROM bets
    WHERE capper_id = ? AND created_at > datetime('now', '-10 minutes')
    AND description LIKE ? LIMIT 1`),

  // Settings
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  // Bet deletion (hard delete any bet by ID)
  deleteBet: db.prepare('DELETE FROM bets WHERE id = ?'),

  // Review queue management
  approveBet: db.prepare("UPDATE bets SET review_status = 'confirmed' WHERE id = ? AND review_status = 'needs_review'"),
  rejectBet:  db.prepare("DELETE FROM bets WHERE id = ? AND review_status = 'needs_review'"),
  updateBetFields: db.prepare("UPDATE bets SET description = ?, odds = ? WHERE id = ?"),
  getReviewBetWithCapper: db.prepare(`SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id WHERE b.id = ?`),

  // Parlay legs
  getLegsByBetId: db.prepare('SELECT * FROM parlay_legs WHERE bet_id = ? ORDER BY created_at'),

  // Prop bets
  getPropsByBetId: db.prepare('SELECT * FROM bet_props WHERE bet_id = ? ORDER BY created_at'),

  // Auto-grading: find oldest pending bet matching a search term
  findPendingBySubject: db.prepare(`SELECT b.*, c.display_name AS capper_name
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE b.result = 'pending' AND b.review_status = 'confirmed'
    AND LOWER(b.description) LIKE LOWER(?)
    ORDER BY b.created_at ASC LIMIT 1`),

  // Dashboard summary
  dashboardSummary: db.prepare(`SELECT
    COUNT(*) AS total_bets,
    COUNT(CASE WHEN result = 'pending' THEN 1 END) AS pending,
    COUNT(CASE WHEN result = 'win' THEN 1 END) AS wins,
    COUNT(CASE WHEN result = 'loss' THEN 1 END) AS losses,
    COUNT(CASE WHEN result = 'push' THEN 1 END) AS pushes,
    COALESCE(SUM(profit_units), 0) AS total_profit
    FROM bets WHERE review_status = 'confirmed'`),
  recentPendingBets: db.prepare(`SELECT b.*, c.display_name AS capper_name
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE b.result = 'pending' AND b.review_status = 'confirmed'
    ORDER BY b.created_at DESC LIMIT ?`),
  totalBankroll: db.prepare(`SELECT COALESCE(SUM(current), 0) AS total FROM bankrolls`),
  riskedCapital: db.prepare(`SELECT COALESCE(SUM(units), 0) AS risked FROM bets WHERE result = 'pending' AND review_status = 'confirmed'`),
  deleteAllPending: db.prepare(`DELETE FROM bets WHERE result = 'pending'`),

  // Capper analytics
  findCapperByName: db.prepare(`SELECT * FROM cappers WHERE LOWER(display_name) LIKE LOWER(?) LIMIT 1`),
  capperGradedBets: db.prepare(`SELECT b.* FROM bets b
    WHERE b.capper_id = ? AND b.result IN ('win', 'loss', 'push') AND b.review_status = 'confirmed'
    ORDER BY b.created_at DESC`),
  capperRecentResults: db.prepare(`SELECT b.result FROM bets b
    WHERE b.capper_id = ? AND b.result IN ('win', 'loss', 'push') AND b.review_status = 'confirmed'
    ORDER BY b.created_at DESC LIMIT 5`),
  capperSportBreakdown: db.prepare(`SELECT b.sport,
    COUNT(CASE WHEN b.result = 'win' THEN 1 END) AS wins,
    COUNT(CASE WHEN b.result = 'loss' THEN 1 END) AS losses,
    COUNT(*) AS total
    FROM bets b
    WHERE b.capper_id = ? AND b.result IN ('win', 'loss', 'push') AND b.review_status = 'confirmed'
    GROUP BY b.sport ORDER BY wins DESC`),
};

function uid() { return crypto.randomBytes(16).toString('hex'); }

function normalizeDescription(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFingerprint(betData) {
  if (betData.fingerprint) return betData.fingerprint;
  if (!betData.source_message_id) return null;

  const payload = [
    betData.capper_id || '',
    betData.source_channel_id || '',
    betData.source_message_id || '',
    (betData.bet_type || 'straight').toLowerCase(),
    normalizeDescription(betData.description),
    betData.odds == null ? '' : String(betData.odds),
    betData.units == null ? '1' : String(betData.units),
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── Capper Management ───────────────────────────────────────
function getOrCreateCapper(discordId, displayName, avatarUrl) {
  let capper = stmts.getCapper.get(discordId);
  if (capper) return capper;

  const id = uid();
  stmts.insertCapper.run(id, discordId, displayName, avatarUrl || null);
  stmts.insertBankroll.run(uid(), id,
    parseFloat(process.env.DEFAULT_BANKROLL || 0),
    parseFloat(process.env.DEFAULT_BANKROLL || 0),
    parseFloat(process.env.DEFAULT_UNIT_SIZE || 25),
  );
  return stmts.getCapperById.get(id);
}

function getCapperByTwitter(handle) {
  return stmts.getCapperTwitter.get(handle.replace('@', '')) || null;
}

function getOrCreateCapperByTwitter(handle) {
  const clean = handle.replace('@', '').toLowerCase();
  let capper = stmts.getCapperTwitter.get(clean);
  if (capper) return capper;

  const id = uid();
  stmts.insertCapperTwitter.run(id, clean, `@${clean}`);
  return stmts.getCapperById.get(id);
}

// ── Bet CRUD ────────────────────────────────────────────────
function createBet(betData) {
  const fingerprint = buildFingerprint(betData);
  if (fingerprint) {
    const existing = stmts.getBetByFingerprint.get(fingerprint);
    if (existing) return { ...existing, _deduped: true };
  }

  const id = uid();
  try {
    stmts.insertBet.run(id,
      betData.capper_id, betData.sport || 'Unknown', betData.league || null,
      betData.bet_type || 'straight', betData.description,
      betData.odds || null, betData.units || 1,
      betData.event_date || null, betData.source || 'manual',
      betData.source_url || null, betData.source_channel_id || null,
      betData.source_message_id || null, fingerprint, betData.raw_text || null,
      betData.review_status || 'confirmed',
      betData.wager || null, betData.payout || null,
      betData.season || ACTIVE_SEASON,
      betData.is_ladder ? 1 : 0, betData.ladder_step || 0,
    );
  } catch (err) {
    // Concurrent insert race: unique fingerprint already committed by another writer.
    const msg = String(err.message || '');
    if (fingerprint && (msg.includes('idx_bets_fingerprint_unique') || msg.includes('UNIQUE constraint failed: bets.fingerprint'))) {
      const existing = stmts.getBetByFingerprint.get(fingerprint);
      if (existing) return { ...existing, _deduped: true };
    }
    throw err;
  }
  // Store optional source tweet fields (not in the main INSERT for backward compat)
  if (betData.source_tweet_id || betData.source_tweet_handle) {
    try {
      db.prepare('UPDATE bets SET source_tweet_id = ?, source_tweet_handle = ? WHERE id = ?')
        .run(betData.source_tweet_id || null, betData.source_tweet_handle || null, id);
    } catch (_) {}
  }
  return { ...stmts.getBet.get(id), _deduped: false };
}

// Bug C: Deduplicate parlay legs before inserting
function dedupeParlayLegs(legs) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const leg of legs) {
    const key = (leg.description || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (seen.has(key)) { duplicates.push(leg.description); continue; }
    seen.add(key);
    unique.push(leg);
  }
  if (duplicates.length > 0) {
    console.log(`[Parser] DEDUPED ${duplicates.length} duplicate leg(s): ${duplicates.join(' | ')}`);
  }
  return unique;
}

function createBetWithLegs(betData, legs) {
  const fingerprint = buildFingerprint(betData);
  if (fingerprint) {
    const existing = stmts.getBetByFingerprint.get(fingerprint);
    if (existing) return { ...existing, _deduped: true };
  }

  const bet = createBet(betData);
  if (bet?._deduped) return bet;
  // Deduplicate legs before inserting
  const cleanLegs = dedupeParlayLegs(legs || []);
  for (const leg of cleanLegs) {
    if (!leg.description) continue;
    stmts.insertLeg.run(uid(), bet.id, leg.description, leg.odds || null);
  }
  return bet;
}

function gradeBetRecord(betId, result, profitUnits, grade, gradeReason, allowAutoConfirm = false) {
  // Atomic conditional update — only updates bets still in 'pending'
  const info = db.prepare(`
    UPDATE bets SET result = ?, profit_units = ?, grade = ?, grade_reason = ?, graded_at = datetime('now')
    WHERE id = ? AND (result = 'pending' OR result IS NULL)
  `).run(result, profitUnits, grade, gradeReason, betId);

  if (info.changes === 0) {
    return { graded: false, reason: 'already_graded' };
  }

  // Auto-confirm only on opt-in (trusted paths like capper celebration, manual grade)
  if (allowAutoConfirm && result && result !== 'pending') {
    db.prepare("UPDATE bets SET review_status = 'confirmed' WHERE id = ? AND review_status = 'needs_review'").run(betId);
  }

  return { graded: true };
}

function getPendingBets() {
  return stmts.pendingBets.all();
}

function getRecentBets(capperId, limit = 10) {
  if (capperId) return stmts.recentBets.all(capperId, limit);
  return stmts.recentBetsAll.all(limit);
}

// ── Stats & Leaderboard ─────────────────────────────────────
function getCapperStats(capperId) {
  const row = db.prepare(`
    SELECT
      c.id, c.display_name, c.discord_id,
      COUNT(b.id) AS total_bets,
      COUNT(CASE WHEN b.result = 'win' THEN 1 END) AS wins,
      COUNT(CASE WHEN b.result = 'loss' THEN 1 END) AS losses,
      COUNT(CASE WHEN b.result = 'push' THEN 1 END) AS pushes,
      COUNT(CASE WHEN b.result = 'pending' THEN 1 END) AS pending,
      ROUND(
        CAST(COUNT(CASE WHEN b.result = 'win' THEN 1 END) AS REAL) /
        MAX(COUNT(CASE WHEN b.result IN ('win','loss') THEN 1 END), 1) * 100, 1
      ) AS win_pct,
      COALESCE(SUM(CASE WHEN b.result IN ('win','loss','push') THEN b.profit_units ELSE 0 END), 0) AS total_profit_units,
      ROUND(
        COALESCE(SUM(CASE WHEN b.result IN ('win','loss','push') THEN b.profit_units ELSE 0 END), 0) /
        MAX(SUM(CASE WHEN b.result IN ('win','loss') THEN MAX(b.units, 1) ELSE 0 END), 1) * 100, 1
      ) AS roi_pct
    FROM cappers c
    LEFT JOIN bets b ON b.capper_id = c.id AND b.season = ?
    WHERE c.id = ?
    GROUP BY c.id
  `).get(ACTIVE_SEASON, capperId);

  // Log abnormal ROI but display real value (no cap)
  if (row && Math.abs(row.roi_pct) > 500) {
    console.warn(`[ROI Alert] Abnormal ROI for ${row.display_name}: ${row.roi_pct}% (${row.wins}W-${row.losses}L, ${row.total_profit_units}u)`);
  }

  return row || null;
}

function getLeaderboard(sortBy = 'total_profit_units', limit = 10) {
  // Whitelist sort columns to prevent SQL injection
  const allowed = ['total_profit_units', 'roi_pct', 'win_pct', 'total_bets'];
  const col = allowed.includes(sortBy) ? sortBy : 'total_profit_units';

  const rows = db.prepare(`
    SELECT
      c.id, c.display_name, c.discord_id,
      COUNT(b.id) AS total_bets,
      COUNT(CASE WHEN b.result = 'win' THEN 1 END) AS wins,
      COUNT(CASE WHEN b.result = 'loss' THEN 1 END) AS losses,
      COUNT(CASE WHEN b.result = 'push' THEN 1 END) AS pushes,
      ROUND(
        CAST(COUNT(CASE WHEN b.result = 'win' THEN 1 END) AS REAL) /
        MAX(COUNT(CASE WHEN b.result IN ('win','loss') THEN 1 END), 1) * 100, 1
      ) AS win_pct,
      COALESCE(SUM(CASE WHEN b.result IN ('win','loss','push') THEN b.profit_units ELSE 0 END), 0) AS total_profit_units,
      ROUND(
        COALESCE(SUM(CASE WHEN b.result IN ('win','loss','push') THEN b.profit_units ELSE 0 END), 0) /
        MAX(SUM(CASE WHEN b.result IN ('win','loss') THEN MAX(b.units, 1) ELSE 0 END), 1) * 100, 1
      ) AS roi_pct
    FROM cappers c
    LEFT JOIN bets b ON b.capper_id = c.id AND b.season = ?
    GROUP BY c.id
    HAVING COUNT(b.id) > 0
    ORDER BY ${col} DESC
    LIMIT ?
  `).all(ACTIVE_SEASON, limit);

  // Log abnormal ROI but display real value (no cap)
  for (const row of rows) {
    if (Math.abs(row.roi_pct) > 500) {
      console.warn(`[ROI Alert] Abnormal ROI: ${row.display_name} ${row.roi_pct}% (${row.wins}W-${row.losses}L)`);
    }
  }
  return rows;
}

// ── Bankroll ────────────────────────────────────────────────
function getBankroll(capperId) {
  return stmts.getBankroll.get(capperId) || null;
}

function updateBankroll(capperId, amount) {
  const bankroll = getBankroll(capperId);
  if (!bankroll) return null;
  const newCurrent = parseFloat(bankroll.current) + amount;
  stmts.updateBankroll.run(newCurrent, capperId);
  return getBankroll(capperId);
}

function setBankroll(capperId, starting, unitSize) {
  stmts.insertBankroll.run(uid(), capperId, starting, starting, unitSize);
  return getBankroll(capperId);
}

// ── Twitter Tracking ────────────────────────────────────────
function addTrackedTwitter(handle, guildId, channelId) {
  const clean = handle.replace(/<[^>]*>/g, '').replace(/@/g, '').trim().toLowerCase();
  if (!clean) return null;
  stmts.insertTracked.run(uid(), clean, clean, guildId, channelId);
  return { twitter_handle: clean, guild_id: guildId, channel_id: channelId };
}

function getTrackedTwitterAccounts() {
  return stmts.getTracked.all();
}

function removeTrackedTwitter(handle) {
  const clean = handle.replace(/<[^>]*>/g, '').replace(/@/g, '').trim().toLowerCase();
  if (!clean) return 0;
  const result = db.prepare('DELETE FROM tracked_twitter WHERE lower(twitter_handle) = ?').run(clean);
  return result.changes;
}

// ── Twitter Audit Log ─────────────────────────────────────────
const insertAudit = db.prepare(`INSERT INTO twitter_audit_log (id, tweet_id, handle, tweet_text, tweet_url, has_media, posted_at, stage, reason, bet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function logTweetAudit({ tweet_id, handle, tweet_text, tweet_url, has_media, posted_at, stage, reason, bet_id }) {
  try {
    insertAudit.run(uid(), tweet_id || '', handle || '', (tweet_text || '').slice(0, 500), tweet_url || '', has_media ? 1 : 0, posted_at || null, stage, reason || null, bet_id || null);
  } catch (_) {}
}

function getAuditRecent(limit = 20) {
  return db.prepare('SELECT * FROM twitter_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
function getAuditByHandle(handle, limit = 20) {
  return db.prepare('SELECT * FROM twitter_audit_log WHERE lower(handle) = lower(?) ORDER BY created_at DESC LIMIT ?').all(handle, limit);
}
function getAuditRejected(limit = 20) {
  return db.prepare("SELECT * FROM twitter_audit_log WHERE stage = 'bouncer_rejected' ORDER BY created_at DESC LIMIT ?").all(limit);
}
function getAuditStats() {
  return db.prepare(`
    SELECT stage, COUNT(*) as count FROM twitter_audit_log
    WHERE created_at > datetime('now', '-24 hours')
    GROUP BY stage ORDER BY count DESC
  `).all();
}
function searchAudit(keyword, limit = 20) {
  return db.prepare('SELECT * FROM twitter_audit_log WHERE tweet_text LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%${keyword}%`, limit);
}
function purgeOldAuditLogs() {
  return db.prepare("DELETE FROM twitter_audit_log WHERE created_at < datetime('now', '-7 days')").run().changes;
}

// ── Admin: purge tables (owner-only, called from /admin purge) ──
const PURGEABLE_TABLES = ['bets', 'tracked_twitter', 'processed_tweets'];
function purgeTable(tableName) {
  if (!PURGEABLE_TABLES.includes(tableName)) return 0;
  const result = db.prepare(`DELETE FROM ${tableName}`).run();
  return result.changes;
}

function updateLastTweetId(handle, tweetId) {
  stmts.updateTweetId.run(tweetId, handle.replace('@', ''));
}

// ── Snapshots ───────────────────────────────────────────────
function saveDailySnapshot(capperId) {
  const stats = getCapperStats(capperId);
  const bankroll = getBankroll(capperId);
  if (!stats) return;

  const today = new Date().toISOString().split('T')[0];
  stmts.upsertSnapshot.run(uid(), capperId, today,
    stats.total_bets, stats.wins, stats.losses, stats.pushes,
    stats.total_profit_units, bankroll?.current || null,
  );
}

// ── Scan State (track last processed message per channel) ───
function getLastScannedMessage(channelId) {
  const row = stmts.getLastScan.get(channelId);
  return row?.last_message_id || null;
}

function setLastScannedMessage(channelId, messageId) {
  stmts.setLastScan.run(channelId, messageId);
}

// ── Duplicate detection ─────────────────────────────────────
function getNeedsReviewBets() {
  return stmts.needsReviewBets.all();
}

// DEPRECATED 2026-04-11: fuzzy first-3-words matching causes false positives
// for similar-prefix bets (e.g. Hard Rock slips). Use createBetWithLegs fingerprint dedup instead.
// Kept for backward compatibility but no longer called from production paths.
function isDuplicateBet(capperId, description) {
  if (!description || description.length < 5) return false;
  // Extract key words (player name, team, line) for fuzzy matching
  const words = description.replace(/[^a-zA-Z0-9\s.+-]/g, '').trim().split(/\s+/);
  const keyWord = words.slice(0, 3).join('%');
  const result = stmts.findRecentSimilar.get(capperId, `%${keyWord}%`);
  if (result) {
    console.log(`[Dedup] Skipped duplicate: "${description}" matches "${result.description}"`);
    return true;
  }
  return false;
}

// ── Review queue management ──────────────────────────────────
function getPendingReviews() {
  return stmts.needsReviewBets.all();
}

function approveBet(betId) {
  const info = stmts.approveBet.run(betId);
  if (info.changes === 0) return null;
  return stmts.getReviewBetWithCapper.get(betId);
}

function rejectBet(betId) {
  const info = stmts.rejectBet.run(betId);
  return info.changes > 0;
}

function updateBetFields(betId, description, odds) {
  stmts.updateBetFields.run(description, odds, betId);
  return stmts.getBet.get(betId);
}

// ── Settings ──────────────────────────────────────────────
function getSetting(key) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  stmts.setSetting.run(key, String(value));
}

function isAuditMode() {
  return getSetting('audit_mode') === 'on';
}

function getBetLegs(betId) {
  return stmts.getLegsByBetId.all(betId);
}

function getBetProps(betId) {
  try {
    return stmts.getPropsByBetId.all(betId);
  } catch {
    // bet_props table may not exist yet on older DBs
    return [];
  }
}

function deleteBetById(betId) {
  const bet = stmts.getBet.get(betId);
  if (!bet) return null;
  stmts.deleteBet.run(betId);
  return bet;
}

function findPendingBetBySubject(searchTerms) {
  for (const term of searchTerms) {
    const match = stmts.findPendingBySubject.get(`%${term}%`);
    if (match) return match;
  }
  return null;
}

function getDashboardSummary() {
  return stmts.dashboardSummary.get();
}

function getRecentPendingBets(limit = 3) {
  return stmts.recentPendingBets.all(limit);
}

function getTotalBankroll() {
  const row = stmts.totalBankroll.get();
  return row ? row.total : 0;
}

function getRiskedCapital() {
  const row = stmts.riskedCapital.get();
  return row ? row.risked : 0;
}

function deleteAllPending() {
  const info = stmts.deleteAllPending.run();
  return info.changes;
}

function findCapperByName(name) {
  return stmts.findCapperByName.get(`%${name}%`) || null;
}

function getCapperAnalytics(capperId) {
  const graded = stmts.capperGradedBets.all(capperId);
  const recent5 = stmts.capperRecentResults.all(capperId);
  const sportBreakdown = stmts.capperSportBreakdown.all(capperId);

  const wins = graded.filter(b => b.result === 'win').length;
  const losses = graded.filter(b => b.result === 'loss').length;
  const pushes = graded.filter(b => b.result === 'push').length;
  const totalProfit = graded.reduce((sum, b) => sum + (b.profit_units || 0), 0);
  const avgOdds = graded.length > 0
    ? Math.round(graded.reduce((sum, b) => sum + (b.odds || 0), 0) / graded.length)
    : 0;
  const winRate = (wins + losses) > 0
    ? ((wins / (wins + losses)) * 100).toFixed(1)
    : '0.0';

  // Streak from most recent results
  let streak = '';
  if (recent5.length > 0) {
    const first = recent5[0].result;
    let count = 0;
    for (const r of recent5) {
      if (r.result === first) count++;
      else break;
    }
    const letter = first === 'win' ? 'W' : first === 'loss' ? 'L' : 'P';
    streak = `${letter}${count}`;
  }

  // Best sport
  const bestSport = sportBreakdown.length > 0 ? sportBreakdown[0] : null;

  return {
    total: graded.length, wins, losses, pushes,
    totalProfit, avgOdds, winRate, streak,
    bestSport, sportBreakdown,
  };
}

// ── Export everything (same interface as old supabase.js) ────
// ── User Bets (Tail/Fade tracking) ───────────────────────────
function upsertUserBet(userId, betId, action, riskAmount = 1.0) {
  db.prepare('INSERT INTO user_bets (user_id, bet_id, action, risk_amount) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, bet_id) DO UPDATE SET action = excluded.action, risk_amount = excluded.risk_amount')
    .run(userId, betId, action, riskAmount);
}

function getSentimentCounts(betId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN action = 'tail' THEN 1 ELSE 0 END) as tails,
      SUM(CASE WHEN action = 'fade' THEN 1 ELSE 0 END) as fades
    FROM user_bets WHERE bet_id = ?
  `).get(betId);
  return { tails: row?.tails || 0, fades: row?.fades || 0 };
}

function ensureUserExists(userId, username) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, bankroll) VALUES (?, ?, 100.0)').run(userId, username || 'Unknown');
}

function getUserBankroll(userId) {
  const row = db.prepare('SELECT bankroll FROM users WHERE id = ?').get(userId);
  return row ? row.bankroll : null;
}

function payoutTailers(betId, betOdds, result) {
  const tailers = db.prepare("SELECT user_id, COALESCE(risk_amount, 1.0) as risk FROM user_bets WHERE bet_id = ? AND action = 'tail'").all(betId);
  if (tailers.length === 0) return 0;

  const txn = db.transaction(() => {
    for (const t of tailers) {
      ensureUserExists(t.user_id, null);
      const risk = t.risk;
      let payout = 0;
      if (result === 'win') {
        if (betOdds > 0) payout = risk + (risk * (betOdds / 100));
        else if (betOdds < 0) payout = risk + (risk * (100 / Math.abs(betOdds)));
        else payout = risk * 2;
      } else if (result === 'push') {
        payout = risk;
      }
      db.prepare('UPDATE users SET bankroll = bankroll - ? WHERE id = ?').run(risk, t.user_id);
      db.prepare('UPDATE users SET bankroll = bankroll + ? WHERE id = ?').run(payout, t.user_id);
    }
  });
  txn();

  console.log(`[Bankroll] Paid out ${tailers.length} tailers for bet ${betId} (result: ${result})`);
  return tailers.length;
}

function getUserBets(userId) {
  return db.prepare(`
    SELECT ub.*, b.description, b.sport, b.odds, b.units, b.result, b.profit_units,
           c.display_name AS capper_name
    FROM user_bets ub
    JOIN bets b ON ub.bet_id = b.id
    LEFT JOIN cappers c ON b.capper_id = c.id
    WHERE ub.user_id = ?
    ORDER BY ub.created_at DESC
    LIMIT 25
  `).all(userId);
}

module.exports = {
  db,
  ACTIVE_SEASON,
  getOrCreateCapper,
  getCapperByTwitter,
  getOrCreateCapperByTwitter,
  createBet,
  createBetWithLegs,
  dedupeParlayLegs,
  gradeBet: gradeBetRecord,
  getPendingBets,
  getRecentBets,
  getCapperStats,
  getLeaderboard,
  getBankroll,
  updateBankroll,
  setBankroll,
  addTrackedTwitter,
  getTrackedTwitterAccounts,
  removeTrackedTwitter,
  purgeTable,
  logTweetAudit,
  getAuditRecent,
  getAuditByHandle,
  getAuditRejected,
  getAuditStats,
  searchAudit,
  purgeOldAuditLogs,
  updateLastTweetId,
  saveDailySnapshot,
  getLastScannedMessage,
  setLastScannedMessage,
  isDuplicateBet,
  getNeedsReviewBets,
  getPendingReviews,
  approveBet,
  rejectBet,
  getSetting,
  setSetting,
  isAuditMode,
  updateBetFields,
  getBetLegs,
  getBetProps,
  deleteBetById,
  getDashboardSummary,
  getRecentPendingBets,
  getTotalBankroll,
  getRiskedCapital,
  deleteAllPending,
  findPendingBetBySubject,
  findCapperByName,
  getCapperAnalytics,
  upsertUserBet,
  getSentimentCounts,
  ensureUserExists,
  getUserBankroll,
  payoutTailers,
  getUserBets,
};
