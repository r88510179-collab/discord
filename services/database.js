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

// ── Prepared statements (fast) ──────────────────────────────
const stmts = {
  getCapper:         db.prepare('SELECT * FROM cappers WHERE discord_id = ?'),
  getCapperById:     db.prepare('SELECT * FROM cappers WHERE id = ?'),
  getCapperTwitter:  db.prepare('SELECT * FROM cappers WHERE lower(twitter_handle) = lower(?)'),
  insertCapper:      db.prepare('INSERT INTO cappers (id, discord_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'),
  insertCapperTwitter: db.prepare('INSERT INTO cappers (id, twitter_handle, display_name) VALUES (?, ?, ?)'),

  insertBet: db.prepare(`INSERT INTO bets (id, capper_id, sport, league, bet_type, description, odds, units, event_date, source, source_url, source_channel_id, source_message_id, fingerprint, raw_text, review_status, wager, payout, season)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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

function getActiveSeason() {
  return String(process.env.ACTIVE_SEASON || 'Beta').trim() || 'Beta';
}

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
      betData.season || getActiveSeason(),
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
    LEFT JOIN bets b ON b.capper_id = c.id AND b.season = ?
    GROUP BY c.id
    HAVING COUNT(b.id) > 0
    ORDER BY ${col} DESC
    LIMIT ?
  `).all(getActiveSeason(), limit);
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
function getNeedsReviewBets() {
  return stmts.needsReviewBets.all();
}

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
