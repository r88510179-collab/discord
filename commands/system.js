const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('system')
    .setDescription('Show ZoneTracker system status and monitored channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const warRoomId = process.env.WAR_ROOM_CHANNEL_ID;
    const slipFeedId = process.env.SLIP_FEED_CHANNEL_ID;
    const picksRaw = process.env.PICKS_CHANNEL_IDS || '';
    const picksIds = picksRaw.split(',').map(s => s.trim()).filter(Boolean);

    const resolve = (id) => id ? `<#${id}>` : '*Not set*';

    const picksLines = picksIds.length > 0
      ? picksIds.map(id => `  ${resolve(id)}`).join('\n')
      : '  *None configured*';

    // Check env vars for AI providers
    const providers = [];
    if (process.env.GROQ_API_KEY) providers.push('Groq');
    if (process.env.GEMINI_API_KEY) providers.push('Gemini');
    if (process.env.MISTRAL_API_KEY) providers.push('Mistral');
    if (process.env.OPENROUTER_API_KEY) providers.push('OpenRouter');

    const embed = new EmbedBuilder()
      .setTitle('ZoneTracker System Status')
      .setColor(COLORS.info)
      .addFields(
        { name: 'War Room', value: resolve(warRoomId), inline: true },
        { name: 'Slip Feed', value: resolve(slipFeedId), inline: true },
        { name: 'Picks Channels', value: picksLines },
        { name: 'AI Providers', value: providers.length > 0 ? providers.join(' > ') : '*None*', inline: true },
        { name: 'OCR', value: process.env.OCR_SPACE_API_KEY ? 'Active' : 'Disabled', inline: true },
        { name: 'Odds API', value: process.env.ODDS_API_KEY ? 'Active' : 'Disabled', inline: true },
        { name: 'Audit Mode', value: process.env.AUDIT_MODE_DEFAULT || 'DB-controlled', inline: true },
      )
      .setFooter({ text: `Uptime: ${formatUptime(process.uptime())}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}
