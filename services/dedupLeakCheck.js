// ===========================================================
// F-12 follow-up -- dedup leak check (read-only, daily safety net).
//
// F-12 (services/twitter-handler.js -> findRecentRepost) drops a same-capper,
// same-content, same-odds Twitter repost inside a 12h window as
// DUPLICATE_REPOST *at ingest time*. This module is the SAFETY NET: a daily
// read-only scan that detects reposts which SLIPPED PAST that gate -- two saved
// twitter bets that satisfy the F-12 dedup criteria within 12h, where the later
// one should have been dropped as a repost but was saved anyway. It NEVER writes
// to bets; it only reads, and on a hit posts ONE compact alert to #admin-log.
//
// The match logic MIRRORS findRecentRepost EXACTLY, and reuses its
// normalizeForDedup so the detector can never drift from the gate:
//   same capper_id + same bet_type + source IN ('twitter_text','twitter_vision')
//   + normalizeForDedup(description) equal + null-aware odds ((odds||null) equal)
//   + the two created_at within the 12h window.
// ===========================================================

'use strict';

// REUSE the gate's own normalizer -- importing it (vs re-implementing) is what
// keeps the leak check and findRecentRepost from silently diverging.
const { normalizeForDedup } = require('./twitter-handler');

// Find Twitter reposts that slipped past the F-12 ingest-time dedup gate.
//
//   findDedupLeaks({ db, lookbackHours = 24, windowHours = 12 })
//
// ONE query pulls every twitter bet from the last (lookbackHours + windowHours):
// a later bet inside `lookbackHours` can have a matching partner up to
// `windowHours` earlier, so that partner may be as old as the sum. Then, per
// (capper_id, bet_type) group, every bet B whose created_at is inside the last
// `lookbackHours` that has an EARLIER same-content / same-odds bet A within
// `windowHours` is a leak -- B is the repost F-12 should have dropped. One leak
// per offending later bet, paired with the NEAREST such A; a pair is never
// reported twice.
//
// `db` is injectable so tests can pass a temp DB; it defaults to the live handle.
function findDedupLeaks({ db = require('./database').db, lookbackHours = 24, windowHours = 12 } = {}) {
  const lookback = Math.max(0, Math.floor(Number(lookbackHours) || 0));
  const windowH = Math.max(0, Math.floor(Number(windowHours) || 0));
  const totalHours = lookback + windowH;
  const windowSec = windowH * 3600;

  // The DB clock is the single source of truth for "now" so the JS recency
  // cutoff can't skew against the SQL window or the strftime epochs read back.
  const nowEpoch = Number(db.prepare("SELECT strftime('%s','now') AS n").get().n);
  const recentCutoff = nowEpoch - lookback * 3600;

  // Bind the window modifier (`-36 hours`) rather than interpolate it. Mirrors
  // findRecentRepost's `created_at >= datetime('now','-12 hours')`, widened to
  // lookback+window so a recent B's older partner is still in range.
  const rows = db.prepare(`
    SELECT id, capper_id, bet_type, description, odds,
           CAST(strftime('%s', created_at) AS INTEGER) AS created_epoch
    FROM bets
    WHERE source IN ('twitter_text', 'twitter_vision')
      AND created_at >= datetime('now', ?)
    ORDER BY created_epoch ASC, id ASC
  `).all(`-${totalHours} hours`);

  // Group by (capper_id, bet_type) -- the F-12 match scope. The key joins the
  // two with a tab; neither a capper_id nor a bet_type contains a tab, so no
  // two distinct (capper, bet_type) pairs can collide into one group.
  const groups = new Map();
  for (const r of rows) {
    if (r.created_epoch == null) continue;          // unparseable created_at -- skip
    const norm = normalizeForDedup(r.description);
    if (!norm) continue;                            // F-12 never matches empty-normalized text
    const betType = r.bet_type || 'straight';       // coalesce mirrors F-12's `betType || 'straight'`
    const key = `${r.capper_id}\t${betType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id: r.id,
      capperId: r.capper_id,
      betType,
      norm,
      oddsKey: r.odds || null,                       // mirrors F-12's `odds || null` storage semantics
      epoch: r.created_epoch,
    });
  }

  const leaks = [];
  for (const group of groups.values()) {
    // group is already ascending by epoch (query ORDER BY).
    for (let i = 0; i < group.length; i++) {
      const B = group[i];
      if (B.epoch < recentCutoff) continue;          // B must sit inside lookbackHours
      // Walk backwards for the NEAREST earlier A that matches content + odds and
      // sits within the window. Ascending order means once the gap exceeds the
      // window, every still-earlier A is further away -- so stop.
      let nearest = null;
      for (let j = i - 1; j >= 0; j--) {
        const A = group[j];
        if (A.epoch >= B.epoch) continue;            // tie => not strictly EARLIER -- skip
        if (B.epoch - A.epoch > windowSec) break;    // outside window, and only widens from here
        if (A.norm !== B.norm) continue;
        if (A.oddsKey !== B.oddsKey) continue;
        nearest = A;                                 // first match walking back = nearest in time
        break;
      }
      if (nearest) {
        leaks.push({
          capper_id: B.capperId,
          bet_type: B.betType,
          normDesc: B.norm,
          odds: B.oddsKey,
          earlier: { id: nearest.id, created_epoch: nearest.epoch },
          later: { id: B.id, created_epoch: B.epoch },
          gapMinutes: Math.round((B.epoch - nearest.epoch) / 60),
        });
      }
    }
  }
  return leaks;
}

// Daily cron entrypoint: scan the last 24h and, ONLY if a leak exists, post one
// compact alert to #admin-log. Reuses the same env-driven channel resolution as
// the hold embeds (sendHoldReviewEmbed) -- never a hardcoded channel id. Silent
// (console-only) when clean. Self-contained: any failure is logged, not thrown,
// so a bad scan can never take down the cron tick.
async function reportDedupLeaks(client) {
  let leaks;
  try {
    leaks = findDedupLeaks(); // defaults: live db, 24h lookback / 12h window
  } catch (err) {
    console.error('[DedupLeak] scan failed:', err.message);
    return;
  }

  if (!leaks.length) {
    console.log('[DedupLeak] scan clean (0, 24h)');
    return;
  }

  console.log(`[DedupLeak] ${leaks.length} leak pair(s) detected, last 24h`);

  const adminLogId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogId || !client) return; // count already logged; nowhere to post
  const adminLog = await client.channels.fetch(adminLogId).catch(() => null);
  if (!adminLog) return;

  // Cheap per-capper display-name lookup (indexed PK; leaks are rare) -> id fallback.
  const db = require('./database').db;
  const nameOf = (capperId) => {
    try {
      const row = db.prepare('SELECT display_name FROM cappers WHERE id = ?').get(capperId);
      return (row && row.display_name) || capperId;
    } catch (_) { return capperId; }
  };

  const fmtOdds = (o) => (o == null ? 'no-odds' : o > 0 ? `+${o}` : `${o}`);
  const header = `⚠️ F-12 dedup leak: ${leaks.length} pair(s), last 24h`;
  const lines = leaks.map((lk) => {
    const desc = lk.normDesc.length > 80 ? `${lk.normDesc.slice(0, 79)}…` : lk.normDesc;
    return `• **${nameOf(lk.capper_id)}** [${lk.bet_type}] "${desc}" @ ${fmtOdds(lk.odds)} -- ` +
      `later \`${lk.later.id}\` vs earlier \`${lk.earlier.id}\`, gap ${lk.gapMinutes}m`;
  });

  // Stay under Discord's 2000-char message cap -- truncate the list, never split.
  let kept = lines;
  let body = [header, ...lines].join('\n');
  if (body.length > 1900) {
    kept = [];
    let len = header.length;
    for (const line of lines) {
      if (len + line.length + 1 > 1850) break;
      kept.push(line);
      len += line.length + 1;
    }
    body = [header, ...kept, `…(+${leaks.length - kept.length} more -- query drop-side via created_at scan)`].join('\n');
  }

  await adminLog.send(body);
}

module.exports = { findDedupLeaks, reportDedupLeaks };
