const { EmbedBuilder } = require('discord.js');

// ── Color palette ───────────────────────────────────────────
const COLORS = {
  primary: 0x6C63FF,
  success: 0x2ECC71,
  danger: 0xE74C3C,
  warning: 0xF39C12,
  info: 0x3498DB,
  pending: 0x95A5A6,
  gold: 0xFFD700,
};

// ── Result emoji mapping ────────────────────────────────────
const RESULT_EMOJI = {
  win: '✅',
  loss: '❌',
  push: '➖',
  pending: '⏳',
  void: '🚫',
};

const GRADE_EMOJI = {
  'A+': '🏆', A: '🔥', B: '👍', C: '😐', D: '👎', F: '💀',
};

// ── Format odds for display ─────────────────────────────────
function fmtOdds(odds) {
  if (!odds) return 'N/A';
  return odds > 0 ? `+${odds}` : `${odds}`;
}

// ── Format units with sign ──────────────────────────────────
function fmtUnits(units) {
  if (units == null) return '0u';
  const n = parseFloat(units);
  return n >= 0 ? `+${n.toFixed(2)}u` : `${n.toFixed(2)}u`;
}

// ── Format currency ─────────────────────────────────────────
function fmtMoney(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

// ── Bet confirmation embed ──────────────────────────────────
function betEmbed(bet, capperName) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📝 Bet Logged')
    .setDescription(`**${bet.description}**`)
    .addFields(
      { name: 'Sport', value: bet.sport || 'Unknown', inline: true },
      { name: 'Odds', value: fmtOdds(bet.odds), inline: true },
      { name: 'Units', value: `${bet.units || 1}u`, inline: true },
      { name: 'Type', value: bet.bet_type || 'straight', inline: true },
      { name: 'Source', value: bet.source || 'manual', inline: true },
      { name: 'Status', value: `${RESULT_EMOJI.pending} Pending`, inline: true },
    )
    .setFooter({ text: `Capper: ${capperName}` })
    .setTimestamp();
}

// ── Stats embed ─────────────────────────────────────────────
function statsEmbed(stats, bankroll) {
  const color = (stats.total_profit_units || 0) >= 0 ? COLORS.success : COLORS.danger;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📊 Stats — ${stats.display_name}`)
    .addFields(
      { name: 'Record', value: `${stats.wins || 0}W - ${stats.losses || 0}L - ${stats.pushes || 0}P`, inline: true },
      { name: 'Win %', value: `${stats.win_pct || 0}%`, inline: true },
      { name: 'ROI', value: `${stats.roi_pct || 0}%`, inline: true },
      { name: 'Profit', value: fmtUnits(stats.total_profit_units), inline: true },
      { name: 'Total Bets', value: `${stats.total_bets || 0}`, inline: true },
      { name: 'Pending', value: `${stats.pending || 0}`, inline: true },
    )
    .setTimestamp();

  if (bankroll) {
    embed.addFields(
      { name: '💰 Bankroll', value: fmtMoney(bankroll.current), inline: true },
      { name: 'Unit Size', value: fmtMoney(bankroll.unit_size), inline: true },
      { name: 'Starting', value: fmtMoney(bankroll.starting), inline: true },
    );
  }

  return embed;
}

// ── Leaderboard embed ───────────────────────────────────────
function leaderboardEmbed(cappers, sortLabel = 'Profit') {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = cappers.map((c, i) => {
    const medal = medals[i] || `**${i + 1}.**`;
    const profit = fmtUnits(c.total_profit_units);
    const record = `${c.wins}W-${c.losses}L`;
    const roi = `${c.roi_pct || 0}% ROI`;
    return `${medal} **${c.display_name}** — ${profit} (${record} | ${roi})`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('🏆 Capper Leaderboard')
    .setDescription(lines.join('\n') || 'No data yet.')
    .setFooter({ text: `Sorted by ${sortLabel} • ${cappers.length} cappers tracked` })
    .setTimestamp();
}

// ── Graded bet embed ────────────────────────────────────────
function gradedEmbed(bet, result, profitUnits, grade) {
  const color = result === 'win' ? COLORS.success : result === 'loss' ? COLORS.danger : COLORS.pending;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${RESULT_EMOJI[result]} Bet Graded — ${result.toUpperCase()}`)
    .setDescription(`**${bet.description}**`)
    .addFields(
      { name: 'Result', value: `${RESULT_EMOJI[result]} ${result.toUpperCase()}`, inline: true },
      { name: 'P/L', value: fmtUnits(profitUnits), inline: true },
      { name: 'Grade', value: `${GRADE_EMOJI[grade?.grade] || ''} ${grade?.grade || 'N/A'}`, inline: true },
    )
    .setFooter({ text: grade?.reason || '' })
    .setTimestamp();
}

module.exports = {
  COLORS, RESULT_EMOJI, GRADE_EMOJI,
  fmtOdds, fmtUnits, fmtMoney,
  betEmbed, statsEmbed, leaderboardEmbed, gradedEmbed,
};
