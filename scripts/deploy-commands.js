import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const APPLICATION_ID = (process.env.APPLICATION_ID || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();

const commands = [
  new SlashCommandBuilder().setName('navi_register').setDescription('Register your Navi (creates your profile)'),
  new SlashCommandBuilder()
    .setName('navi_upgrade')
    .setDescription('Upgrade your Navi stats (you must use the MEE6 items to actually upgrade permanently)')
    .addStringOption(o => o.setName('stat').setDescription('hp | dodge | crit').setRequired(true)
      .addChoices({ name:'hp', value:'hp' }, { name:'dodge', value:'dodge' }, { name:'crit', value:'crit' }))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true)),
  new SlashCommandBuilder().setName('navi_stats').setDescription('Show Navi stats').addUserOption(o => o.setName('user').setDescription('User to inspect')),
  new SlashCommandBuilder().setName('duel').setDescription('Start a duel in this channel').addUserOption(o => o.setName('opponent').setDescription('Opponent to challenge').setRequired(true)),
  new SlashCommandBuilder().setName('forfeit').setDescription('Forfeit the active duel in this channel')
].map(c => c.toJSON());

async function main() {
  if (!DISCORD_TOKEN) {
    console.warn('⚠️ DISCORD_TOKEN missing; skipping command deploy.');
    return;
  }
  if (!APPLICATION_ID) {
    console.warn('⚠️ APPLICATION_ID missing; skipping command deploy.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    if (GUILD_ID) {
      console.log(`Deploying GUILD commands to ${GUILD_ID}...`);
      await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID), { body: commands });
      console.log('✅ Guild commands deployed.');
    } else {
      console.log('GUILD_ID missing; deploying GLOBAL commands (can take up to ~1 hour to appear)...');
      await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
      console.log('✅ Global commands deployed.');
    }
  } catch (err) {
    console.error('Command deploy failed:', err?.data ?? err?.message ?? err);
    // Do NOT throw — let the bot still start.
  }
}
main();
