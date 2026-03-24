require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}
if (!guildId) {
  console.error('Missing DISCORD_GUILD_ID in .env — needed for guild-only deploy');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, '..', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
    console.log(`  Registered: /${command.data.name}`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    // Step 1: Wipe all global commands
    console.log('\n[1/3] Wiping global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('  Global commands cleared.');

    // Step 2: Wipe all guild commands
    console.log('[2/3] Wiping guild commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log('  Guild commands cleared.');

    // Step 3: Register current commands to guild (instant update)
    console.log(`[3/3] Deploying ${commands.length} commands to guild ${guildId}...`);
    const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`\nDone — ${data.length} guild commands deployed.`);
  } catch (err) {
    console.error('Deploy failed:', err.message);
    process.exit(1);
  }
})();
