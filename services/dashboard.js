const { EmbedBuilder } = require('discord.js');

// Dashboard channel ID from env
function getDashboardChannel(client) {
  const id = process.env.DASHBOARD_CHANNEL_ID;
  if (!id) return null;
  return client.channels.cache.get(id) || null;
}

// ── Post a tracked pick to the dashboard ────────────────────
async function postPickTracked(client, bet, capperName, channelName, source) {
  const ch = getDashboardChannel(client);
  if (!ch) return;

  const sourceEmoji = { discord: '💬', twitter: '🐦', slip: '📸', manual: '📝' };
  const embed = new EmbedBuilder()
    .setColor(0x6C63FF)
    .setTitle(`${sourceEmoji[source] || '📝'} Pick Tracked`)
    .setDescription(`**${bet.description}**`)
    .addFields(
      { name: 'Capper', value: capperName, inline: true },
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Odds', value: `${bet.odds > 0 ? '+' : ''}${bet.odds || -110}`, inline: true },
      { name: 'Units', value: `${bet.units || 1}u`, inline: true },
      { name: 'Type', value: bet.bet_type || 'straight', inline: true },
      { name: 'Source', value: `#${channelName}`, inline: true },
    )
    .setTimestamp();

  try { await ch.send({ embeds: [embed] }); }
  catch (e) { console.error('[Dashboard] Post error:', e.message); }
}

// ── Post a graded bet to the dashboard ──────────────────────
async function postBetGraded(client, bet, result, profitUnits, grade) {
  const ch = getDashboardChannel(client);
  if (!ch) return;

  const emoji = { win: '✅', loss: '❌', push: '➖', void: '🚫' };
  const gradeEmoji = { 'A+': '🏆', A: '🔥', B: '👍', C: '😐', D: '👎', F: '💀' };
  const color = result === 'win' ? 0x2ECC71 : result === 'loss' ? 0xE74C3C : 0x95A5A6;

  const pl = parseFloat(profitUnits);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji[result] || '⏳'} Bet Graded — ${result.toUpperCase()}`)
    .setDescription(`**${bet.description}**`)
    .addFields(
      { name: 'Capper', value: bet.capper_name || 'Unknown', inline: true },
      { name: 'P/L', value: `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}u`, inline: true },
      { name: 'Grade', value: `${gradeEmoji[grade?.grade] || ''} ${grade?.grade || 'N/A'}`, inline: true },
    )
    .setFooter({ text: grade?.reason || '' })
    .setTimestamp();

  try { await ch.send({ embeds: [embed] }); }
  catch (e) { console.error('[Dashboard] Grade post error:', e.message); }
}

// ── Post auto-grade summary ─────────────────────────────────
async function postGradeSummary(client, results) {
  const ch = getDashboardChannel(client);
  if (!ch) return;
  if (results.graded === 0) return; // don't spam empty runs

  const wins = results.bets?.filter(b => b.result === 'win').length || 0;
  const losses = results.bets?.filter(b => b.result === 'loss').length || 0;
  const totalPL = results.bets?.reduce((s, b) => s + (b.profitUnits || 0), 0) || 0;

  const embed = new EmbedBuilder()
    .setColor(wins > losses ? 0x2ECC71 : 0xE74C3C)
    .setTitle('⚡ Auto-Grade Cycle Complete')
    .setDescription(`Graded **${results.graded}** bet(s)`)
    .addFields(
      { name: 'Wins', value: `${wins}`, inline: true },
      { name: 'Losses', value: `${losses}`, inline: true },
      { name: 'Net P/L', value: `${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}u`, inline: true },
    )
    .setTimestamp();

  try { await ch.send({ embeds: [embed] }); }
  catch (e) { console.error('[Dashboard] Summary error:', e.message); }
}

// ── Post daily leaderboard update ───────────────────────────
async function postDailyLeaderboard(client) {
  const ch = getDashboardChannel(client);
  if (!ch) return;

  const db = require('./database');
  const cappers = db.getLeaderboard('total_profit_units', 10);
  if (cappers.length === 0) return;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = cappers.map((c, i) => {
    const m = medals[i] || `**${i + 1}.**`;
    const pl = parseFloat(c.total_profit_units || 0);
    return `${m} **${c.display_name}** — ${pl >= 0 ? '+' : ''}${pl.toFixed(2)}u (${c.wins}W-${c.losses}L | ${c.roi_pct || 0}% ROI)`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🏆 Daily Leaderboard Update')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${cappers.length} cappers tracked` })
    .setTimestamp();

  try { await ch.send({ embeds: [embed] }); }
  catch (e) { console.error('[Dashboard] Leaderboard error:', e.message); }
}

module.exports = { postPickTracked, postBetGraded, postGradeSummary, postDailyLeaderboard };
