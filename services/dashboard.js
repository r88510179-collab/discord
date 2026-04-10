const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getBetProps, getCapperStats, getLeaderboard, getPendingBets, getSentimentCounts, db, getSetting, setSetting } = require('./database');

function formatPropsLine(props) {
  if (!props || props.length === 0) return null;
  return props.map(p => {
    const dir = p.direction === 'over' ? 'O' : 'U';
    const odds = p.odds ? ` (${p.odds > 0 ? '+' : ''}${p.odds})` : '';
    const cat = p.stat_category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `${p.player_name} — ${cat}: ${dir} ${p.line}${odds}`;
  }).join('\n');
}

const fmtOdds = (o) => o == null ? 'N/A' : (o > 0 ? `+${o}` : `${o}`);

// ═══════════════════════════════════════════════════════════════
// CHANNEL 1: #slip-feed — New picks with interactive buttons
// ═══════════════════════════════════════════════════════════════
async function postNewPick(client, bet, capperName, sourceUrl) {
  const chId = process.env.SLIP_FEED_CHANNEL_ID;
  if (!chId) return;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;

  const stats = bet.capper_id ? getCapperStats(bet.capper_id) : null;
  const record = stats
    ? `${stats.wins}W-${stats.losses}L (${stats.roi_pct >= 0 ? '+' : ''}${stats.roi_pct}% ROI)`
    : 'New capper';

  const props = getBetProps(bet.id);
  const propsLine = formatPropsLine(props);
  const desc = propsLine ? `**${bet.description}**\n\n${propsLine}` : `**${bet.description}**`;

  const isLadder = bet.is_ladder === 1 || bet.is_ladder === true;
  const ladderBadge = isLadder ? ` — 🪜 STEP ${bet.ladder_step || 1}` : '';

  // Detect stale bets (older than 2 hours, still pending)
  const betAge = bet.created_at ? (Date.now() - new Date(bet.created_at).getTime()) : 0;
  const isStale = betAge > 2 * 60 * 60 * 1000 && bet.result === 'pending';
  const staleBadge = isStale ? ' — ⏰ AWAITING GRADE' : '';

  const embedColor = isStale ? 0xE67E22 : (isLadder ? 0xFFA500 : 0x3498DB);
  const embedIcon = isStale ? '⏰' : (isLadder ? '🪜' : '📋');
  const embedTitle = isStale ? 'Awaiting Grade' : (isLadder ? 'LADDER CHALLENGE' : 'New Pick');

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(`${embedIcon} ${embedTitle}${ladderBadge}${staleBadge}`)
    .setDescription(desc)
    .addFields(
      { name: 'Capper', value: capperName || 'Unknown', inline: true },
      { name: 'Record', value: record, inline: true },
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Odds', value: fmtOdds(bet.odds), inline: true },
      { name: 'Units', value: `${bet.units || 1}u`, inline: true },
      { name: 'Type', value: bet.bet_type || 'straight', inline: true },
    )
    .setFooter({ text: `Bet ID: ${bet.id?.slice(0, 8)}` })
    .setTimestamp();

  // Row 1: Community buttons (everyone)
  const communityRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`slipfeed:tail:${bet.id}`).setLabel('Tail').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`slipfeed:fade:${bet.id}`).setLabel('Fade').setStyle(ButtonStyle.Danger),
  );

  // Row 2: Owner management buttons
  const mgmtButtons = [
    new ButtonBuilder().setCustomId(`slipfeed:edit:${bet.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`slipfeed:delete:${bet.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
  ];
  if (sourceUrl && sourceUrl.startsWith('https://')) {
    mgmtButtons.push(new ButtonBuilder().setLabel('View Original').setStyle(ButtonStyle.Link).setURL(sourceUrl));
  }
  const mgmtRow = new ActionRowBuilder().addComponents(mgmtButtons);

  try {
    console.log(`[BetPost] Bet ${bet.id?.slice(0, 8)} → #slip-feed (${chId})`);
    const sent = await ch.send({ embeds: [embed], components: [communityRow, mgmtRow] });
    db.prepare('UPDATE bets SET slipfeed_message_id = ? WHERE id = ?').run(sent.id, bet.id);
  } catch (e) {
    console.error('[SlipFeed] Post error:', e.message);
  }

  updateScoreboard(client).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL 2: #slip-receipts — Graded results with tail/fade stats
// ═══════════════════════════════════════════════════════════════
async function postGradedResult(client, bet, result, profitUnits, evidence) {
  const chId = process.env.RECEIPTS_CHANNEL_ID;
  if (!chId) return;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;

  const emoji = { win: '✅', loss: '❌', push: '🟰', void: '⚪' };
  const label = { win: 'WIN', loss: 'LOSS', push: 'PUSH', void: 'VOID' };
  const color = result === 'win' ? 0x2ECC71 : result === 'loss' ? 0xE74C3C : 0x95A5A6;
  const pl = parseFloat(profitUnits || 0);

  const stats = bet.capper_id ? getCapperStats(bet.capper_id) : null;
  const record = stats ? `${stats.wins}W-${stats.losses}L (${stats.roi_pct >= 0 ? '+' : ''}${stats.roi_pct}% ROI)` : '';

  // Tail/fade summary
  const sentiment = getSentimentCounts(bet.id);
  const tailCount = sentiment?.tail || 0;
  const fadeCount = sentiment?.fade || 0;
  let sentimentLine = '';
  if (tailCount > 0 || fadeCount > 0) {
    const tailPL = result === 'win' ? `+${(pl * tailCount).toFixed(1)}u` : `${(pl * tailCount).toFixed(1)}u`;
    const fadePL = result === 'win' ? `${(-pl * fadeCount).toFixed(1)}u` : `+${(-pl * fadeCount).toFixed(1)}u`;
    sentimentLine = `${tailCount} tailer(s) ${tailPL} | ${fadeCount} fader(s) ${fadePL}`;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji[result] || '⏳'} ${label[result] || result.toUpperCase()}`)
    .setDescription(`**${bet.description}**`)
    .addFields(
      { name: 'Capper', value: bet.capper_name || 'Unknown', inline: true },
      { name: 'P/L', value: `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}u`, inline: true },
      { name: 'Updated Record', value: record || 'N/A', inline: true },
    )
    .setTimestamp();

  if (sentimentLine) embed.addFields({ name: 'Community', value: sentimentLine, inline: false });
  if (evidence) embed.setFooter({ text: evidence });

  // Also post to #slip-feed as a settled result
  const slipCh = process.env.SLIP_FEED_CHANNEL_ID ? await client.channels.fetch(process.env.SLIP_FEED_CHANNEL_ID).catch(() => null) : null;

  // Delete the original slip-feed message if it exists
  if (slipCh && bet.slipfeed_message_id) {
    try {
      const oldMsg = await slipCh.messages.fetch(bet.slipfeed_message_id);
      await oldMsg.delete();
    } catch (_) {}
    db.prepare('UPDATE bets SET slipfeed_message_id = NULL WHERE id = ?').run(bet.id);
  }

  try {
    console.log(`[BetPost] Grade result → #slip-receipts (${chId})`);
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error('[Receipts] Post error:', e.message); }

  // Post settled result to slip-feed with View Original only
  if (slipCh) {
    const sourceUrl = bet.source_url;
    const settledEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${emoji[result] || '⏳'} ${label[result] || result.toUpperCase()} — ${bet.description?.slice(0, 60)}`)
      .addFields(
        { name: 'Capper', value: bet.capper_name || 'Unknown', inline: true },
        { name: 'P/L', value: `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}u`, inline: true },
      )
      .setTimestamp();
    if (sentimentLine) settledEmbed.addFields({ name: 'Community', value: sentimentLine, inline: false });

    const components = [];
    if (sourceUrl && sourceUrl.startsWith('https://')) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('View Original').setStyle(ButtonStyle.Link).setURL(sourceUrl),
      ));
    }
    try { await slipCh.send({ embeds: [settledEmbed], components }); }
    catch (_) {}
  }

  updateScoreboard(client).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL 3: #bettracker-dashboard — ONLY persistent scoreboard
// No individual picks or results posted here.
// ═══════════════════════════════════════════════════════════════
let scoreboardMessageId = getSetting('scoreboard_message_id') || null;
let lastScoreboardHash = null;

function buildScoreboardData() {
  const allCappers = getLeaderboard('roi_pct', 50);
  const qualified = allCappers.filter(c => (c.wins + c.losses) >= 3);
  const hot = qualified.slice(0, 3);
  const cold = [...qualified].sort((a, b) => a.roi_pct - b.roi_pct).slice(0, 3);

  const hotLines = hot.length > 0
    ? hot.map((c, i) => {
        const medals = ['🥇', '🥈', '🥉'];
        const pl = parseFloat(c.total_profit_units || 0);
        return `${medals[i]} **${c.display_name}** — ${c.wins}W-${c.losses}L | ${pl >= 0 ? '+' : ''}${pl.toFixed(1)}u | ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}% ROI`;
      }).join('\n')
    : '_No cappers with 3+ graded bets yet_';

  const coldLines = cold.length > 0
    ? cold.map((c, i) => {
        const pl = parseFloat(c.total_profit_units || 0);
        return `**${i + 1}.** ${c.display_name} — ${c.wins}W-${c.losses}L | ${pl >= 0 ? '+' : ''}${pl.toFixed(1)}u | ${c.roi_pct >= 0 ? '+' : ''}${c.roi_pct}% ROI`;
      }).join('\n')
    : '_No cappers with 3+ graded bets yet_';

  const pending = getPendingBets();
  const descCounts = {};
  for (const bet of pending) {
    const key = (bet.description || '').toLowerCase().slice(0, 40).trim();
    if (!key) continue;
    if (!descCounts[key]) descCounts[key] = { desc: bet.description, sport: bet.sport, count: 0, cappers: [] };
    descCounts[key].count++;
    if (bet.capper_name && !descCounts[key].cappers.includes(bet.capper_name)) {
      descCounts[key].cappers.push(bet.capper_name);
    }
  }

  const consensus = Object.values(descCounts)
    .filter(c => c.cappers.length >= 2)
    .sort((a, b) => b.cappers.length - a.cappers.length)
    .slice(0, 3);

  const consensusLines = consensus.length > 0
    ? consensus.map(c => `🔥 **${c.desc.slice(0, 60)}** (${c.sport || '?'}) — ${c.cappers.length} cappers: ${c.cappers.join(', ')}`).join('\n')
    : '_No overlapping picks right now_';

  return { hotLines, coldLines, consensusLines, pendingCount: pending.length, capperCount: allCappers.length };
}

async function updateScoreboard(client, { force = false } = {}) {
  const chId = process.env.DASHBOARD_CHANNEL_ID;
  if (!chId) return;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;

  try {
    const data = buildScoreboardData();
    const dataHash = `${data.hotLines}|${data.coldLines}|${data.consensusLines}|${data.pendingCount}|${data.capperCount}`;
    if (!force && dataHash === lastScoreboardHash && scoreboardMessageId) {
      return;
    }
    lastScoreboardHash = dataHash;

    const now = new Date();
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('📊 ZoneTracker — Live Scoreboard')
      .addFields(
        { name: '🏆 Hot Cappers (Top 3 ROI)', value: data.hotLines, inline: false },
        { name: '🥶 Cold Cappers (Bottom 3 ROI)', value: data.coldLines, inline: false },
        { name: '🔥 Consensus Picks', value: data.consensusLines, inline: false },
        { name: '📈 Pending', value: `${data.pendingCount} bet(s) in play`, inline: true },
        { name: '👥 Cappers', value: `${data.capperCount} tracked`, inline: true },
      )
      .setFooter({ text: `Last updated ${now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })} ET` })
      .setTimestamp();

    if (scoreboardMessageId) {
      try {
        const msg = await ch.messages.fetch(scoreboardMessageId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (_) { scoreboardMessageId = null; }
    }

    const sent = await ch.send({ embeds: [embed] });
    scoreboardMessageId = sent.id;
    setSetting('scoreboard_message_id', sent.id);
  } catch (err) {
    console.error('[Scoreboard] Error:', err.message);
  }
}

// Legacy compat
async function postPickTracked(client, bet, capperName) { await postNewPick(client, bet, capperName); }
async function postBetGraded(client, bet, result, profitUnits, grade) { await postGradedResult(client, bet, result, profitUnits, grade?.reason); }
async function postGradeSummary() {}
async function postDailyLeaderboard(client) { await updateScoreboard(client, { force: true }); }

module.exports = { postNewPick, postGradedResult, updateScoreboard, postPickTracked, postBetGraded, postGradeSummary, postDailyLeaderboard };
