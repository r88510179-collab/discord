const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getAllPendingBets, deleteBetById } = require('../services/database');
const { COLORS } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('active')
    .setDescription('View and manage all pending bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const pending = getAllPendingBets();
    if (pending.length === 0) {
      return interaction.editReply({ content: 'No active pending bets.' });
    }

    // Build numbered list (max 25 for select menu)
    const bets = pending.slice(0, 25);
    const lines = bets.map((b, i) => {
      const desc = (b.description || 'Unknown').slice(0, 50);
      const odds = b.odds != null ? (b.odds > 0 ? `+${b.odds}` : `${b.odds}`) : 'N/A';
      const capper = b.capper_name || 'Unknown';
      const age = Math.round((Date.now() - new Date(b.created_at).getTime()) / 3600000);
      return `**${i + 1}.** ${desc}\n   └ ${capper} | ${odds} | ${b.units || 1}u | ${age}h ago`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Active Bets (${pending.length})`)
      .setColor(COLORS.info)
      .setDescription(lines.join('\n\n') || 'None.')
      .setFooter({ text: 'Select a bet below and click Delete to remove it.' })
      .setTimestamp();

    // Dropdown select menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('active_select')
      .setPlaceholder('Select a bet to delete...')
      .addOptions(
        bets.map((b, i) => ({
          label: `${i + 1}. ${(b.description || 'Unknown').slice(0, 90)}`,
          description: `${b.capper_name || 'Unknown'} | ${b.odds || 'N/A'} | ${b.units || 1}u`,
          value: b.id,
        })),
      );

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('active_delete')
        .setLabel('Delete Selected Bet')
        .setStyle(ButtonStyle.Danger),
    );

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [selectRow, buttonRow],
    });

    // Collect interactions for 60 seconds
    let selectedBetId = null;

    const collector = reply.createMessageComponentCollector({ time: 60_000 });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
      }

      if (i.isStringSelectMenu() && i.customId === 'active_select') {
        selectedBetId = i.values[0];
        const selected = bets.find(b => b.id === selectedBetId);
        const desc = selected ? (selected.description || 'Unknown').slice(0, 60) : selectedBetId.slice(0, 8);
        await i.reply({ content: `Selected: **${desc}** — click the red button to delete.`, flags: MessageFlags.Ephemeral });
      }

      if (i.isButton() && i.customId === 'active_delete') {
        if (!selectedBetId) {
          return i.reply({ content: 'Please select a bet from the dropdown first.', flags: MessageFlags.Ephemeral });
        }

        const deleted = deleteBetById(selectedBetId);
        if (!deleted) {
          return i.reply({ content: 'Bet not found or already deleted.', flags: MessageFlags.Ephemeral });
        }

        // Refresh the list
        const remaining = getAllPendingBets();
        const refreshLines = remaining.slice(0, 25).map((b, idx) => {
          const d = (b.description || 'Unknown').slice(0, 50);
          const o = b.odds != null ? (b.odds > 0 ? `+${b.odds}` : `${b.odds}`) : 'N/A';
          return `**${idx + 1}.** ${d}\n   └ ${b.capper_name || 'Unknown'} | ${o} | ${b.units || 1}u`;
        });

        const refreshEmbed = new EmbedBuilder()
          .setTitle(`Active Bets (${remaining.length})`)
          .setColor(remaining.length > 0 ? COLORS.info : COLORS.success)
          .setDescription(refreshLines.join('\n\n') || 'All clear — no pending bets.')
          .setFooter({ text: `Deleted: ${(deleted.description || '').slice(0, 50)}` })
          .setTimestamp();

        // Remove components if no bets left
        const components = [];
        if (remaining.length > 0) {
          const newMenu = new StringSelectMenuBuilder()
            .setCustomId('active_select')
            .setPlaceholder('Select a bet to delete...')
            .addOptions(
              remaining.slice(0, 25).map((b, idx) => ({
                label: `${idx + 1}. ${(b.description || 'Unknown').slice(0, 90)}`,
                description: `${b.capper_name || 'Unknown'} | ${b.odds || 'N/A'}`,
                value: b.id,
              })),
            );
          components.push(new ActionRowBuilder().addComponents(newMenu));
          components.push(buttonRow);
        }

        selectedBetId = null;
        await i.update({ embeds: [refreshEmbed], components });
      }
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch { /* message may be gone */ }
    });
  },
};
