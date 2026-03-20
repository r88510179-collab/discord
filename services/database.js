const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db');

const db = new Database(DB_PATH);

// ── Enable WAL mode for better performance ──────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ── Initialize schema ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cappers (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    discord_id    TEXT UNIQUE,
    twitter_handle TEXT UNIQUE,
    display_name  TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bets (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    capper_id     TEXT REFERENCES cappers(id) ON DELETE CASCADE,
    sport         TEXT NOT NULL DEFAULT 'Unknown',
    league        TEXT,
    bet_type      TEXT NOT NULL DEFAULT 'straight',
    description   TEXT NOT NULL,
    odds          INTEGER,
    units         REAL DEFAULT 1.0,
    result        TEXT DEFAULT 'pending',
    profit_units  REAL DEFAULT 0,
    grade         TEXT,
    grade_reason  TEXT,
    event_date    TEXT,
    graded_at     TEXT,
    source        TEXT DEFAULT 'manual',
    source_url    TEXT,
    source_channel_id TEXT,
    source_message_id TEXT,
    fingerprint   TEXT,
    raw_text      TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parlay_legs (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    bet_id        TEXT REFERENCES bets(id) ON DELETE CASCADE,
    description   TEXT NOT NULL,
    odds          INTEGER,
    result        TEXT DEFAULT 'pending',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bankrolls (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    capper_id     TEXT UNIQUE REFERENCES cappers(id) ON DELETE CASCADE,
    starting      REAL NOT NULL DEFAULT 1000,
    current       REAL NOT NULL DEFAULT 1000,
    unit_size     REAL NOT NULL DEFAULT 25,
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracked_twitter (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    twitter_handle  TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    last_tweet_id   TEXT,
    guild_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    active          INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    capper_id     TEXT REFERENCES cappers(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    total_bets    INTEGER DEFAULT 0,
    wins          INTEGER DEFAULT 0,
    losses        INTEGER DEFAULT 0,
    pushes        INTEGER DEFAULT 0,
    profit_units  REAL DEFAULT 0,
    bankroll      REAL,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(capper_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_bets_capper     ON bets(capper_id);
  CREATE INDEX IF NOT EXISTS idx_bets_result     ON bets(result);
  CREATE INDEX IF NOT EXISTS idx_bets_created    ON bets(created_at);
  CREATE INDEX IF NOT EXISTS idx_bets_sport      ON bets(sport);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_fingerprint_unique ON bets(fingerprint) WHERE fingerprint IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_snapshots_date  ON daily_snapshots(capper_id, date);

  CREATE TABLE IF NOT EXISTS scan_state (
    channel_id    TEXT PRIMARY KEY,
    last_message_id TEXT NOT NULL,
    updated_at    TEXT DEFAULT (datetime('now'))
  );
`);

// ── Lightweight additive migrations for older SQLite files ──
const betColumns = db.prepare("PRAGMA table_info('bets')").all().map(c => c.name);
if (!betColumns.includes('source_url')) db.exec('ALTER TABLE bets ADD COLUMN source_url TEXT');
if (!betColumns.includes('source_channel_id')) db.exec('ALTER TABLE bets ADD COLUMN source_channel_id TEXT');
if (!betColumns.includes('source_message_id')) db.exec('ALTER TABLE bets ADD COLUMN source_message_id TEXT');
if (!betColumns.includes('fingerprint')) db.exec('ALTER TABLE bets ADD COLUMN fingerprint TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_fingerprint_unique ON bets(fingerprint) WHERE fingerprint IS NOT NULL');

// ── Prepared statements (fast) ──────────────────────────────
const stmts = {
  getCapper:         db.prepare('SELECT * FROM cappers WHERE discord_id = ?'),
  getCapperById:     db.prepare('SELECT * FROM cappers WHERE id = ?'),
  getCapperTwitter:  db.prepare('SELECT * FROM cappers WHERE lower(twitter_handle) = lower(?)'),
  insertCapper:      db.prepare('INSERT INTO cappers (id, discord_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'),
  insertCapperTwitter: db.prepare('INSERT INTO cappers (id, twitter_handle, display_name) VALUES (?, ?, ?)'),

  insertBet: db.prepare(`INSERT INTO bets (id, capper_id, sport, league, bet_type, description, odds, units, event_date, source, source_url, source_channel_id, source_message_id, fingerprint, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertLeg: db.prepare('INSERT INTO parlay_legs (id, bet_id, description, odds) VALUES (?, ?, ?, ?)'),
  gradeBet:  db.prepare('UPDATE bets SET result = ?, profit_units = ?, grade = ?, grade_reason = ?, graded_at = datetime(\'now\') WHERE id = ?'),
  getBet:    db.prepare('SELECT * FROM bets WHERE id = ?'),
  getBetByFingerprint: db.prepare('SELECT * FROM bets WHERE fingerprint = ?'),

  pendingBets: db.prepare(`SELECT b.*, c.display_name AS capper_name, c.discord_id AS capper_discord_id
    FROM bets b LEFT JOIN cappers c ON b.capper_id = c.id WHERE b.result = 'pending' ORDER BY b.created_at DESC`),
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
    parseFloat(process.env.DEFAULT_BANKROLL || 1000),
    parseFloat(process.env.DEFAULT_BANKROLL || 1000),
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
  return { ...stmts.getBet.get(id), _deduped: false };
}

function createBetWithLegs(betData, legs) {
  const fingerprint = buildFingerprint(betData);
  if (fingerprint) {
    const existing = stmts.getBetByFingerprint.get(fingerprint);
    if (existing) return { ...existing, _deduped: true };
  }

  const bet = createBet(betData);
  if (bet?._deduped) return bet;
  if (legs && legs.length > 0) {
    for (const leg of legs) {
      if (!leg.description) continue; // skip legs with no description
      stmts.insertLeg.run(uid(), bet.id, leg.description, leg.odds || null);
    }
  }
  return bet;
}

function gradeBetRecord(betId, result, profitUnits, grade, gradeReason) {
  stmts.gradeBet.run(result, profitUnits, grade, gradeReason, betId);
  return stmts.getBet.get(betId);
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
      COALESCE(SUM(b.profit_units), 0) AS total_profit_units,
      ROUND(
        COALESCE(SUM(b.profit_units), 0) /
        MAX(SUM(CASE WHEN b.result IN ('win','loss') THEN b.units ELSE 0 END), 1) * 100, 1
      ) AS roi_pct
    FROM cappers c
    LEFT JOIN bets b ON b.capper_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(capperId);
  return row || null;
}

function getLeaderboard(sortBy = 'total_profit_units', limit = 10) {
  // Whitelist sort columns to prevent SQL injection
  const allowed = ['total_profit_units', 'roi_pct', 'win_pct', 'total_bets'];
  const col = allowed.includes(sortBy) ? sortBy : 'total_profit_units';

  return db.prepare(`
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
      COALESCE(SUM(b.profit_units), 0) AS total_profit_units,
      ROUND(
        COALESCE(SUM(b.profit_units), 0) /
        MAX(SUM(CASE WHEN b.result IN ('win','loss') THEN b.units ELSE 0 END), 1) * 100, 1
      ) AS roi_pct
    FROM cappers c
    LEFT JOIN bets b ON b.capper_id = c.id
    GROUP BY c.id
    HAVING COUNT(b.id) > 0
    ORDER BY ${col} DESC
    LIMIT ?
  `).all(limit);
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
  const clean = handle.replace('@', '').toLowerCase();
  stmts.insertTracked.run(uid(), clean, `@${clean}`, guildId, channelId);
  return { twitter_handle: clean, guild_id: guildId, channel_id: channelId };
}

function getTrackedTwitterAccounts() {
  return stmts.getTracked.all();
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

// ── Export everything (same interface as old supabase.js) ────
module.exports = {
  db,
  getOrCreateCapper,
  getCapperByTwitter,
  getOrCreateCapperByTwitter,
  createBet,
  createBetWithLegs,
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
  updateLastTweetId,
  saveDailySnapshot,
  getLastScannedMessage,
  setLastScannedMessage,
  isDuplicateBet,
};
