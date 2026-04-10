// ═══════════════════════════════════════════════════════════
// Health Report Service — comprehensive bot monitoring
// Covers: Twitter, Bet Pipeline, AI Providers, AutoGrader,
// Database, Crons, Discord, Cappers, Users, System, Alerts
// ═══════════════════════════════════════════════════════════

const { EmbedBuilder } = require('discord.js');
const { db } = require('./database');
const path = require('path');
const fs = require('fs');
const v8 = require('v8');

const uid = () => require('crypto').randomBytes(8).toString('hex');
const startTime = Date.now();

// Track cron runs in memory
const cronRuns = {};
function logCronRun(name, durationMs) {
  if (!cronRuns[name]) cronRuns[name] = [];
  cronRuns[name].push({ at: Date.now(), duration: durationMs });
  // Keep last 100
  if (cronRuns[name].length > 100) cronRuns[name] = cronRuns[name].slice(-100);
}

function getCronRuns() { return cronRuns; }

// ── Section A: Twitter Ingestion Health ─────────────────────
function sectionTwitter(hours = 24) {
  // Credit tracking
  try {
    const { getTwitterCreditStats } = require('./twitter');
    const credits = getTwitterCreditStats();
    // Prepend credit info (will be added to lines below)
    sectionTwitter._creditLine = `💳 **API Credits:** ${credits.used}/${credits.budget} (${credits.pct}% used)`;
  } catch (_) { sectionTwitter._creditLine = null; }
  const since = `datetime('now', '-${hours} hours')`;
  const stages = db.prepare(`SELECT stage, COUNT(*) as c FROM twitter_audit_log WHERE created_at > ${since} GROUP BY stage`).all();
  const stageMap = {};
  for (const s of stages) stageMap[s.stage] = s.c;

  const perHandle = db.prepare(`SELECT handle, stage, COUNT(*) as c FROM twitter_audit_log WHERE created_at > ${since} GROUP BY handle, stage`).all();
  const handleStats = {};
  for (const r of perHandle) {
    if (!handleStats[r.handle]) handleStats[r.handle] = {};
    handleStats[r.handle][r.stage] = r.c;
  }

  const zeroSaves = Object.entries(handleStats).filter(([, s]) => !s.saved && (s.fetched || 0) > 0).map(([h]) => `@${h}`);
  const fullReject = Object.entries(handleStats).filter(([, s]) => s.bouncer_rejected && !s.saved && !s.bouncer_valid).map(([h]) => `@${h}`);

  const topReasons = db.prepare(`SELECT reason, COUNT(*) as c FROM twitter_audit_log WHERE stage = 'bouncer_rejected' AND created_at > ${since} GROUP BY reason ORDER BY c DESC LIMIT 5`).all();

  const errors = (stageMap.error || 0);
  const total = Object.values(stageMap).reduce((a, b) => a + b, 0);

  const lines = [
    `📥 Fetched: **${stageMap.fetched || 0}** | 🔁 RT: ${stageMap.filtered_rt || 0} | ↩️ Reply: ${stageMap.filtered_reply || 0} | ⏳ Age: ${stageMap.filtered_age || 0}`,
    `♻️ Deduped: **${stageMap.deduped || 0}** | 🚫 Rejected: **${stageMap.bouncer_rejected || 0}** | ✅ Valid: **${stageMap.bouncer_valid || 0}** | 💾 Saved: **${stageMap.saved || 0}**`,
    `❌ Errors: ${errors} | Total events: ${total}`,
  ];

  if (zeroSaves.length > 0) lines.push(`⚠️ 0 saves: ${zeroSaves.slice(0, 5).join(', ')}`);
  if (fullReject.length > 0) lines.push(`⚠️ 100% rejected: ${fullReject.slice(0, 5).join(', ')}`);
  if (topReasons.length > 0) lines.push(`**Top rejections:**\n${topReasons.map(r => `  • ${r.reason?.slice(0, 80)} (${r.c})`).join('\n')}`);

  if (sectionTwitter._creditLine) lines.unshift(sectionTwitter._creditLine);

  return { title: '🐦 Twitter Ingestion', lines, color: errors > 5 ? 0xE74C3C : (stageMap.saved || 0) > 0 ? 0x2ECC71 : 0xF1C40F };
}

// ── Section B: Bet Pipeline Health ──────────────────────────
function sectionBetPipeline(hours = 24) {
  const since = `datetime('now', '-${hours} hours')`;
  const total = db.prepare(`SELECT COUNT(*) as c FROM bets WHERE created_at > ${since}`).get().c;
  const byStatus = db.prepare(`SELECT review_status, COUNT(*) as c FROM bets WHERE created_at > ${since} GROUP BY review_status`).all();
  const bySource = db.prepare(`SELECT source, COUNT(*) as c FROM bets WHERE created_at > ${since} GROUP BY source ORDER BY c DESC`).all();
  const byType = db.prepare(`SELECT bet_type, COUNT(*) as c FROM bets WHERE created_at > ${since} GROUP BY bet_type ORDER BY c DESC`).all();
  const stuck = db.prepare(`SELECT COUNT(*) as c FROM bets WHERE result = 'pending' AND review_status = 'confirmed' AND created_at < datetime('now', '-24 hours')`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) as c FROM bets WHERE result = 'pending'`).get().c;

  const statusMap = {};
  for (const s of byStatus) statusMap[s.review_status] = s.c;

  const lines = [
    `Total: **${total}** | Confirmed: ${statusMap.confirmed || 0} | Needs Review: ${statusMap.needs_review || 0} | Pending: ${pending}`,
    `**By source:** ${bySource.map(s => `${s.source}: ${s.c}`).join(' | ') || 'none'}`,
    `**By type:** ${byType.map(s => `${s.bet_type}: ${s.c}`).join(' | ') || 'none'}`,
  ];
  if (stuck > 0) lines.push(`🚨 **${stuck}** bet(s) stuck pending >24h`);

  return { title: '📊 Bet Pipeline', lines, color: stuck > 3 ? 0xE74C3C : 0x2ECC71 };
}

// ── Section C: AI Provider Health ───────────────────────────
function sectionAI() {
  // This is runtime-tracked, so we pull what we can from audit logs
  const lines = [
    'AI provider stats are logged to console.',
    'Check `flyctl logs` for `[AI] Winner:` and `[AI] Error:` entries.',
    'Provider order: Gemini → Groq → OpenRouter → Cerebras → Mistral',
  ];
  return { title: '🤖 AI Providers', lines, color: 0x3498DB };
}

// ── Section D: AutoGrader Health ────────────────────────────
function sectionGrader(hours = 24) {
  const since = `datetime('now', '-${hours} hours')`;
  const graded = db.prepare(`SELECT result, COUNT(*) as c FROM bets WHERE graded_at > ${since} AND result IN ('win','loss','push','void') GROUP BY result`).all();
  const total = graded.reduce((s, r) => s + r.c, 0);
  const resultMap = {};
  for (const r of graded) resultMap[r.result] = r.c;

  const lines = [
    `Graded: **${total}** | ✅ ${resultMap.win || 0}W | ❌ ${resultMap.loss || 0}L | 🟰 ${resultMap.push || 0}P | ⚫ ${resultMap.void || 0}V`,
  ];

  return { title: '⚡ AutoGrader', lines, color: total > 0 ? 0x2ECC71 : 0xF1C40F };
}

// ── Section E: Database Health ──────────────────────────────
function sectionDatabase() {
  const tables = ['bets', 'cappers', 'parlay_legs', 'bankrolls', 'tracked_twitter', 'daily_snapshots', 'bet_props', 'users', 'user_bets', 'processed_tweets', 'twitter_audit_log', 'bot_health_log', 'settings'];
  const counts = [];
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
      counts.push(`${t}: ${c}`);
    } catch (_) { counts.push(`${t}: ⚠️`); }
  }

  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'bettracker.db');
  let dbSize = '?';
  try { dbSize = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1) + 'MB'; } catch (_) {}

  const lines = [
    `**DB size:** ${dbSize}`,
    counts.join(' | '),
  ];

  return { title: '🗄️ Database', lines, color: 0x3498DB };
}

// ── Section F: Cron Job Health ──────────────────────────────
function sectionCrons() {
  const lines = [];
  for (const [name, runs] of Object.entries(cronRuns)) {
    if (runs.length === 0) continue;
    const last = runs[runs.length - 1];
    const ago = Math.round((Date.now() - last.at) / 60000);
    const avgDuration = Math.round(runs.reduce((s, r) => s + r.duration, 0) / runs.length);
    const status = ago > 120 ? '🚨' : ago > 60 ? '⚠️' : '✅';
    lines.push(`${status} **${name}** — last: ${ago}m ago | avg: ${avgDuration}ms | runs: ${runs.length}`);
  }
  if (lines.length === 0) lines.push('_No cron data yet (accumulates after first cycle)_');

  return { title: '⏰ Cron Jobs', lines, color: 0x3498DB };
}

// ── Section H: Capper Performance ───────────────────────────
function sectionCappers() {
  const { getLeaderboard } = require('./database');
  const all = getLeaderboard('roi_pct', 50);
  const active = all.filter(c => c.total_bets > 0);
  const top5 = active.slice(0, 5);
  const bottom5 = [...active].sort((a, b) => a.roi_pct - b.roi_pct).slice(0, 5);

  const lines = [
    `Active: **${active.length}** cappers`,
    `**Top 5 ROI:**\n${top5.map(c => `  🏆 ${c.display_name} — ${c.wins}W-${c.losses}L | ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}% ROI`).join('\n') || '_none_'}`,
    `**Bottom 5 ROI:**\n${bottom5.map(c => `  🥶 ${c.display_name} — ${c.wins}W-${c.losses}L | ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}% ROI`).join('\n') || '_none_'}`,
  ];

  return { title: '👥 Capper Performance', lines, color: 0x9B59B6 };
}

// ── Section I: User Engagement ──────────────────────────────
function sectionEngagement(hours = 24) {
  const since = `datetime('now', '-${hours} hours')`;
  let tailFade = { tail: 0, fade: 0 };
  try {
    tailFade = db.prepare(`SELECT action, COUNT(*) as c FROM user_bets WHERE created_at > ${since} GROUP BY action`).all()
      .reduce((m, r) => { m[r.action] = r.c; return m; }, { tail: 0, fade: 0 });
  } catch (_) {}

  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0;

  return { title: '📱 User Engagement', lines: [`Tails: **${tailFade.tail || 0}** | Fades: **${tailFade.fade || 0}** | Total users: ${totalUsers}`], color: 0x1ABC9C };
}

// ── Section J: System Health ────────────────────────────────
let lastHeapUsed = 0;
function sectionSystem() {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const uptime = Math.round((Date.now() - startTime) / 60000);
  // Use V8 heap_size_limit (400MB) not heapTotal (dynamic, often tiny)
  const heapPct = (heapStats.used_heap_size / heapStats.heap_size_limit * 100).toFixed(0);
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  // Track heap growth between checks
  const heapDelta = lastHeapUsed > 0 ? heapStats.used_heap_size - lastHeapUsed : 0;
  lastHeapUsed = heapStats.used_heap_size;
  const leakSignal = heapDelta > 20 * 1024 * 1024 ? ` ⚠️ +${mb(heapDelta)}MB since last check` : '';

  const lines = [
    `**Uptime:** ${Math.floor(uptime / 60)}h ${uptime % 60}m`,
    `**RSS:** ${mb(mem.rss)}MB | **Heap:** ${mb(heapStats.used_heap_size)}/${mb(heapStats.heap_size_limit)}MB (${heapPct}%)${leakSignal}`,
    `**External:** ${mb(mem.external)}MB | **Buffers:** ${mb(mem.arrayBuffers || 0)}MB`,
    `**Node:** ${process.version} | **PID:** ${process.pid}`,
  ];

  // Discord.js cache sizes
  const discordClient = global._discordClient;
  if (discordClient) {
    const guilds = discordClient.guilds.cache.size;
    const channels = discordClient.channels.cache.size;
    let totalMsgCache = 0;
    discordClient.channels.cache.forEach(ch => { if (ch.messages) totalMsgCache += ch.messages.cache.size; });
    lines.push(`**Discord cache:** ${guilds} guild(s) | ${channels} channel(s) | ${totalMsgCache} cached msg(s)`);
  }

  // Per-component breakdown
  try {
    const handles = process._getActiveHandles?.()?.length || '?';
    const requests = process._getActiveRequests?.()?.length || '?';
    lines.push(`**Active handles:** ${handles} | **Active requests:** ${requests}`);
  } catch (_) {}

  // V8 heap detail (already shown in main line above)

  return { title: '💻 System', lines, color: heapPct > 80 ? 0xE74C3C : heapPct > 60 ? 0xF1C40F : 0x2ECC71 };
}

// ── Heap snapshot for debugging ──
function writeHeapSnapshot() {
  try {
    const snapshotPath = v8.writeHeapSnapshot('/data/');
    console.log(`[Health] Heap snapshot written: ${snapshotPath}`);
    return snapshotPath;
  } catch (err) {
    console.error('[Health] Heap snapshot failed:', err.message);
    return null;
  }
}

// ── Section K: Alerts ───────────────────────────────────────
function sectionAlerts() {
  const alerts = [];

  // Stuck bets
  const stuck = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'pending' AND review_status = 'confirmed' AND created_at < datetime('now', '-24 hours')").get().c;
  if (stuck > 0) alerts.push(`🚨 **${stuck}** bet(s) stuck pending >24h`);

  // Twitter handles with 0 saves in 7 days
  const deadHandles = db.prepare(`
    SELECT t.twitter_handle FROM tracked_twitter t
    WHERE t.active = 1 AND t.twitter_handle NOT IN (
      SELECT DISTINCT handle FROM twitter_audit_log WHERE stage = 'saved' AND created_at > datetime('now', '-7 days')
    )
  `).all();
  if (deadHandles.length > 0) alerts.push(`⚠️ ${deadHandles.length} handle(s) with 0 saves in 7 days: ${deadHandles.slice(0, 5).map(h => `@${h.twitter_handle}`).join(', ')}`);

  // Grader stale
  const lastGrade = db.prepare("SELECT MAX(graded_at) as last FROM bets WHERE graded_at IS NOT NULL").get()?.last;
  if (lastGrade) {
    const hoursAgo = (Date.now() - new Date(lastGrade).getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 3) alerts.push(`⚠️ AutoGrader hasn't graded in ${hoursAgo.toFixed(1)}h`);
  }

  // Memory — use V8 heap_size_limit (400MB), NOT heapTotal
  try {
    const hs = v8.getHeapStatistics();
    const pct = hs.used_heap_size / hs.heap_size_limit;
    if (pct > 0.85) alerts.push(`🚨 Heap memory ${(pct * 100).toFixed(0)}% (${(hs.used_heap_size / 1024 / 1024).toFixed(0)}/${(hs.heap_size_limit / 1024 / 1024).toFixed(0)}MB)`);
  } catch (_) {}

  // Bouncer rejection rate spike
  const recent = db.prepare("SELECT COUNT(*) as c FROM twitter_audit_log WHERE stage = 'bouncer_rejected' AND created_at > datetime('now', '-6 hours')").get().c;
  const recentValid = db.prepare("SELECT COUNT(*) as c FROM twitter_audit_log WHERE stage = 'bouncer_valid' AND created_at > datetime('now', '-6 hours')").get().c;
  if (recent + recentValid > 10 && recent / (recent + recentValid) > 0.7) {
    alerts.push(`⚠️ Bouncer rejection rate ${Math.round(recent / (recent + recentValid) * 100)}% in last 6h — review prompt`);
  }

  if (alerts.length === 0) alerts.push('✅ All systems nominal');

  return { title: '🚨 Alerts & Action Items', lines: alerts, color: alerts.some(a => a.startsWith('🚨')) ? 0xE74C3C : alerts.some(a => a.startsWith('⚠️')) ? 0xF1C40F : 0x2ECC71 };
}

// ── Build full report as embeds ─────────────────────────────
function buildReport(type = 'full', hours = 24) {
  const sections = type === 'pulse'
    ? [sectionTwitter(1), sectionBetPipeline(1), sectionGrader(1), sectionSystem(), sectionAlerts()]
    : [sectionTwitter(hours), sectionBetPipeline(hours), sectionAI(), sectionGrader(hours), sectionDatabase(), sectionCrons(), sectionCappers(), sectionEngagement(hours), sectionSystem(), sectionAlerts()];

  const embeds = sections.map(s => {
    const embed = new EmbedBuilder()
      .setTitle(s.title)
      .setColor(s.color)
      .setDescription(s.lines.join('\n').slice(0, 4000));
    return embed;
  });

  // Header embed
  const header = new EmbedBuilder()
    .setTitle(`📋 ZoneTracker Health Report — ${type === 'pulse' ? 'Hourly Pulse' : type === 'weekly' ? '7-Day Audit' : '24h Full Report'}`)
    .setColor(0x3498DB)
    .setTimestamp()
    .setFooter({ text: `Period: ${hours}h | Generated at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET` });

  return [header, ...embeds];
}

function buildReportMarkdown(hours = 24) {
  const sections = [sectionTwitter(hours), sectionBetPipeline(hours), sectionAI(), sectionGrader(hours), sectionDatabase(), sectionCrons(), sectionCappers(), sectionEngagement(hours), sectionSystem(), sectionAlerts()];
  let md = `# ZoneTracker Health Report\n**Generated:** ${new Date().toISOString()}\n**Period:** ${hours}h\n\n`;
  for (const s of sections) {
    md += `## ${s.title}\n${s.lines.join('\n')}\n\n`;
  }
  return md;
}

// ── Post report to channel and/or DM owner ──────────────────
async function postReport(client, type = 'full', hours = 24) {
  const embeds = buildReport(type, hours);
  // Discord max 10 embeds per message — split if needed
  const chunks = [];
  for (let i = 0; i < embeds.length; i += 10) chunks.push(embeds.slice(i, i + 10));

  // Post to audit channel
  const chId = process.env.AUDIT_REPORT_CHANNEL_ID;
  if (chId) {
    try {
      const ch = await client.channels.fetch(chId);
      for (const chunk of chunks) await ch.send({ embeds: chunk });
      console.log(`[Health] ${type} report posted to #bot-audits`);
    } catch (e) { console.error('[Health] Channel post error:', e.message); }
  }

  // DM owner for daily/weekly
  if ((type === 'full' || type === 'weekly') && process.env.OWNER_ID) {
    try {
      const owner = await client.users.fetch(process.env.OWNER_ID);
      for (const chunk of chunks) await owner.send({ embeds: chunk });
      console.log('[Health] Report DMed to owner');
    } catch (e) { console.error('[Health] DM error:', e.message); }
  }

  // Log to health table
  try {
    db.prepare('INSERT INTO bot_health_log (id, report_type, section, metric, value, details) VALUES (?, ?, ?, ?, ?, ?)').run(uid(), type, 'summary', 'sections', embeds.length, `${hours}h period`);
  } catch (_) {}
}

// ── Critical alert checker (runs continuously) ──────────────
let highMemCount = 0;
async function checkCriticalAlerts(client) {
  if (!process.env.OWNER_ID) return;
  const alerts = [];

  // Use V8 heap_size_limit (400MB), NOT heapTotal (dynamic, often ~21MB)
  const hs = v8.getHeapStatistics();
  const heapPct = hs.used_heap_size / hs.heap_size_limit;
  const usedMB = (hs.used_heap_size / 1024 / 1024).toFixed(0);
  const limitMB = (hs.heap_size_limit / 1024 / 1024).toFixed(0);

  // Try GC if available and heap is above 70% of the 400MB limit
  if (heapPct > 0.7 && typeof global.gc === 'function') {
    global.gc();
  }

  if (heapPct > 0.85) {
    highMemCount++;
    alerts.push(`🚨 Heap ${(heapPct * 100).toFixed(0)}% (${usedMB}/${limitMB}MB) — sustained ${highMemCount * 5}min`);

    // Auto-restart after 15 min sustained >85% of 400MB limit
    if (highMemCount >= 3) {
      try {
        const owner = await client.users.fetch(process.env.OWNER_ID);
        await owner.send(`🚨 **AUTO-RESTART:** Heap >${(heapPct * 100).toFixed(0)}% (${usedMB}/${limitMB}MB) sustained 15+ min.`);
      } catch (_) {}
      console.error('[HEALTH] Auto-restart triggered: sustained high memory');
      process.exit(1);
    }
  } else {
    highMemCount = 0;
  }

  // DB accessible
  try { db.prepare('SELECT 1').get(); } catch (e) { alerts.push(`🚨 Database error: ${e.message}`); }

  if (alerts.length > 0) {
    try {
      const owner = await client.users.fetch(process.env.OWNER_ID);
      await owner.send(`**🚨 ZoneTracker Critical Alert**\n${alerts.join('\n')}`);
    } catch (_) {}
  }
}

module.exports = { buildReport, buildReportMarkdown, postReport, checkCriticalAlerts, logCronRun, getCronRuns, writeHeapSnapshot, sectionTwitter, sectionBetPipeline, sectionGrader, sectionDatabase, sectionCrons, sectionCappers, sectionEngagement, sectionSystem, sectionAlerts };
