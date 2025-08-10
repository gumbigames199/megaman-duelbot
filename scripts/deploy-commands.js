import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('navi_register')
    .setDescription('Register your Navi (creates your profile)'),
  new SlashCommandBuilder()
    .setName('navi_upgrade')
    .setDescription('Upgrade your Navi stats (you must use the MEE6 items to actually upgrade permanently)')
    .addStringOption(o => o.setName('stat').setDescription('hp | dodge | crit').setRequired(true)
      .addChoices(
        { name:'hp', value:'hp' },
        { name:'dodge', value:'dodge' },
        { name:'crit', value:'crit' }
      ))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('navi_stats')
    .setDescription('Show Navi stats')
    .addUserOption(o => o.setName('user').setDescription('User to inspect')),
  new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Start a duel in this channel')
    .addUserOption(o => o.setName('opponent').setDescription('Opponent to challenge').setRequired(true)),
  new SlashCommandBuilder()
    .setName('forfeit')
    .setDescription('Forfeit the active duel in this channel')
]
.map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const appId = process.env.APPLICATION_ID;
  const guildId = process.env.GUILD_ID;
  if (!appId || !guildId) {
    console.error('Set APPLICATION_ID and GUILD_ID in your .env before running this script.');
    process.exit(1);
  }
  try {
    console.log('Deploying guild commands...');
    await rest.put(
      Routes.applicationGuildCommands(appId, guildId),
      { body: commands }
    );
    console.log('✅ Commands deployed to guild ' + guildId);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
main();