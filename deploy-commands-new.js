require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Log a bet using natural language')
    .addStringOption(opt =>
      opt.setName('pick')
        .setDescription('e.g. "Lakers -3.5 (-110) 2u" or "Parlay: Chiefs ML + Over 45.5"')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View betting stats and analytics')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Check another user (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the capper leaderboard')
    .addStringOption(opt =>
      opt.setName('sort').setDescription('Sort by').setRequired(false)
        .addChoices(
          { name: '💰 Profit (units)', value: 'total_profit_units' },
          { name: '📈 ROI %', value: 'roi_pct' },
          { name: '🎯 Win %', value: 'win_pct' },
          { name: '📊 Total Bets', value: 'total_bets' },
        )),

  new SlashCommandBuilder()
    .setName('bankroll')
    .setDescription('View or set your bankroll')
    .addSubcommand(sub =>
      sub.setName('view').setDescription('View your current bankroll'))
    .addSubcommand(sub =>
      sub.setName('set').setDescription('Set bankroll and unit size')
        .addNumberOption(o => o.setName('amount').setDescription('Starting bankroll ($)').setRequired(true))
        .addNumberOption(o => o.setName('unit').setDescription('Unit size ($)').setRequired(true))),

  new SlashCommandBuilder()
    .setName('grade')
    .setDescription('Grade bets — auto or manual')
    .addSubcommand(sub =>
      sub.setName('auto').setDescription('Run auto-grader on all pending bets'))
    .addSubcommand(sub =>
      sub.setName('manual').setDescription('Manually grade your latest pending bet')
        .addStringOption(o => o.setName('result').setDescription('Result').setRequired(true)
          .addChoices(
            { name: '✅ Win', value: 'win' },
            { name: '❌ Loss', value: 'loss' },
            { name: '➖ Push', value: 'push' },
            { name: '🚫 Void', value: 'void' },
          ))),

  new SlashCommandBuilder()
    .setName('recap')
    .setDescription('AI-generated recap of your betting performance'),

  new SlashCommandBuilder()
    .setName('slip')
    .setDescription('Info on how to scan bet slips'),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const body = commands.map(c => c.toJSON());
    console.log(`🔄 Registering ${body.length} slash commands...`);

    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body },
      );
      console.log(`✅ Registered to guild ${process.env.DISCORD_GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body });
      console.log('✅ Registered globally');
    }
  } catch (err) {
    console.error('❌ Error:', err);
  }
})();
