require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`🔄 Registering ${commands.length} slash commands...`);

    if (process.env.DISCORD_GUILD_ID) {
      // Guild-specific (instant, good for dev)
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body: commands },
      );
      console.log(`✅ Registered to guild ${process.env.DISCORD_GUILD_ID}`);
    } else {
      // Global (takes ~1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        { body: commands },
      );
      console.log('✅ Registered globally (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('❌ Error deploying commands:', err);
  }
})();
