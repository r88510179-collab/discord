const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { buildReport, writeHeapSnapshot, sectionTwitter, sectionBetPipeline, sectionGrader, sectionDatabase, sectionCrons, sectionCappers, sectionEngagement, sectionSystem, sectionAlerts } = require('../services/healthReport');

const SECTION_MAP = {
  a: { fn: sectionTwitter, name: 'Twitter' },
  b: { fn: sectionBetPipeline, name: 'Bet Pipeline' },
  d: { fn: sectionGrader, name: 'AutoGrader' },
  e: { fn: sectionDatabase, name: 'Database' },
  f: { fn: sectionCrons, name: 'Cron Jobs' },
  h: { fn: sectionCappers, name: 'Cappers' },
  i: { fn: sectionEngagement, name: 'Engagement' },
  j: { fn: sectionSystem, name: 'System' },
  k: { fn: sectionAlerts, name: 'Alerts' },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('health')
    .setDescription('Bot health reports')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('report').setDescription('Full 24h health report'))
    .addSubcommand(sub => sub.setName('quick').setDescription('Hourly pulse — key counts + alerts'))
    .addSubcommand(sub => sub.setName('alerts').setDescription('Current active alerts only'))
    .addSubcommand(sub => sub.setName('snapshot').setDescription('Capture V8 heap snapshot for debugging'))
    .addSubcommand(sub =>
      sub.setName('section')
        .setDescription('Run one section of the report')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Section: a=Twitter, b=Pipeline, d=Grader, e=DB, f=Crons, h=Cappers, i=Users, j=System, k=Alerts')
            .setRequired(true)
            .addChoices(
              { name: 'A: Twitter Ingestion', value: 'a' },
              { name: 'B: Bet Pipeline', value: 'b' },
              { name: 'D: AutoGrader', value: 'd' },
              { name: 'E: Database', value: 'e' },
              { name: 'F: Cron Jobs', value: 'f' },
              { name: 'H: Cappers', value: 'h' },
              { name: 'I: Engagement', value: 'i' },
              { name: 'J: System', value: 'j' },
              { name: 'K: Alerts', value: 'k' },
            ))),

  async execute(interaction) {
    if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
      return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (sub === 'report') {
      const embeds = buildReport('full', 24);
      // Discord limits: 10 embeds per message
      for (let i = 0; i < embeds.length; i += 10) {
        if (i === 0) await interaction.editReply({ embeds: embeds.slice(0, 10) });
        else await interaction.followUp({ embeds: embeds.slice(i, i + 10), ephemeral: true });
      }
      return;
    }

    if (sub === 'quick') {
      const embeds = buildReport('pulse', 1);
      return interaction.editReply({ embeds: embeds.slice(0, 10) });
    }

    if (sub === 'alerts') {
      const data = sectionAlerts();
      const embed = new EmbedBuilder().setTitle(data.title).setColor(data.color).setDescription(data.lines.join('\n')).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'snapshot') {
      const snapshotPath = writeHeapSnapshot();
      const mem = process.memoryUsage();
      return interaction.editReply(snapshotPath
        ? `📸 Heap snapshot saved: \`${snapshotPath}\`\nHeap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`
        : '❌ Snapshot failed — check logs.');
    }

    if (sub === 'section') {
      const id = interaction.options.getString('id');
      const sec = SECTION_MAP[id];
      if (!sec) return interaction.editReply('Invalid section.');
      const data = typeof sec.fn === 'function' ? sec.fn(24) : sec.fn;
      const embed = new EmbedBuilder().setTitle(data.title).setColor(data.color).setDescription(data.lines.join('\n').slice(0, 4000)).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
  },
};
