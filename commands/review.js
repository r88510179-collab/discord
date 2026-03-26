const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { getPendingReviews, approveBet, rejectBet } = require('../services/database');
const { COLORS } = require('../utils/embeds');
const { postPickTracked } = require('../services/dashboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Mass-action review queue for pending bets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const pending = getPendingReviews();

    if (pending.length === 0) {
      return interaction.editReply('✅ Review queue is empty — no bets need attention.');
    }

    // Build numbered list (max 25 for dropdown limit)
    const bets = pending.slice(0, 25);
    const lines = bets.map((bet, i) => {
      const capper = bet.capper_name || 'Unknown';
      const desc = (bet.description || '').slice(0, 60);
      const odds = bet.odds != null ? (bet.odds > 0 ? `+${bet.odds}` : `${bet.odds}`) : 'N/A';
      return `**${i + 1}.** \`${bet.id.slice(0, 8)}\` — **${capper}**: ${desc} (${odds})`;
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle(`Review Queue — ${pending.length} bet(s)`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Use the dropdown to select specific bets, or mass-action with the buttons below.' })
      .setTimestamp();

    // Row 1: Selective dropdown
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('review_select')
      .setPlaceholder('Select bets to approve...')
      .setMinValues(1)
      .setMaxValues(bets.length)
      .addOptions(
        bets.map((bet, i) => ({
          label: `${i + 1}. ${(bet.capper_name || 'Unknown').slice(0, 15)} — ${(bet.description || '').slice(0, 50)}`,
          description: `ID: ${bet.id.slice(0, 8)} | ${bet.sport || 'Unknown'}`,
          value: bet.id,
        })),
      );
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Row 2: Mass action buttons
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('review_approve_selected')
        .setLabel('Approve Selected')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('review_approve_all')
        .setLabel('Approve All')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('review_reject_all')
        .setLabel('Reject All')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await interaction.editReply({
      embeds: [embed],
      components: [selectRow, buttonRow],
    });

    // Collect interactions (60 second window)
    let selectedIds = [];

    const collector = msg.createMessageComponentCollector({ time: 60_000 });

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'review_select') {
          selectedIds = i.values;
          await i.reply({
            content: `Selected **${selectedIds.length}** bet(s). Now click **Approve Selected** or pick again.`,
            ephemeral: true,
          });
          return;
        }

        if (i.customId === 'review_approve_selected') {
          if (selectedIds.length === 0) {
            await i.reply({ content: 'No bets selected. Use the dropdown first.', ephemeral: true });
            return;
          }

          let approved = 0;
          for (const betId of selectedIds) {
            const bet = approveBet(betId);
            if (bet) {
              approved++;
              await postPickTracked(
                interaction.client, bet, bet.capper_name || 'Unknown',
                bet.source_channel_id || 'review', bet.source || 'manual',
              ).catch(() => {});
            }
          }

          const doneEmbed = new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle(`✅ Approved ${approved} bet(s)`)
            .setDescription(`Selected bets moved to active. Approved by ${interaction.user.displayName}.`)
            .setTimestamp();

          await i.update({ embeds: [doneEmbed], components: [] });
          collector.stop();
          return;
        }

        if (i.customId === 'review_approve_all') {
          let approved = 0;
          for (const bet of bets) {
            const result = approveBet(bet.id);
            if (result) {
              approved++;
              await postPickTracked(
                interaction.client, result, result.capper_name || 'Unknown',
                result.source_channel_id || 'review', result.source || 'manual',
              ).catch(() => {});
            }
          }

          const doneEmbed = new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle(`✅ Approved All — ${approved} bet(s)`)
            .setDescription(`All review bets moved to active. Approved by ${interaction.user.displayName}.`)
            .setTimestamp();

          await i.update({ embeds: [doneEmbed], components: [] });
          collector.stop();
          return;
        }

        if (i.customId === 'review_reject_all') {
          let rejected = 0;
          for (const bet of bets) {
            if (rejectBet(bet.id)) rejected++;
          }

          const doneEmbed = new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle(`🗑️ Rejected All — ${rejected} bet(s)`)
            .setDescription(`All review bets permanently deleted. Rejected by ${interaction.user.displayName}.`)
            .setTimestamp();

          await i.update({ embeds: [doneEmbed], components: [] });
          collector.stop();
          return;
        }
      } catch (err) {
        console.error('[Review] Interaction error:', err.message);
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        const expiredEmbed = new EmbedBuilder()
          .setColor(COLORS.pending)
          .setTitle('Review session expired')
          .setDescription('Run `/review` again to manage the queue.')
          .setTimestamp();
        await interaction.editReply({ embeds: [expiredEmbed], components: [] }).catch(() => {});
      }
    });
  },
};
