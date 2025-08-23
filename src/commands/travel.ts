import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { listUnlocked } from '../lib/unlock';
import { getBundle } from '../lib/data';
import { setRegion } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('travel')
  .setDescription('Travel to an unlocked region')
  .addStringOption(o=>o.setName('region_id').setDescription('Region TSV id').setRequired(true));

export async function execute(ix: ChatInputCommandInteraction) {
  const id = ix.options.getString('region_id', true).trim();
  const unlocked = new Set(listUnlocked(ix.user.id));
  if (!unlocked.has(id)) { await ix.reply({ ephemeral:true, content:`🔒 Region not unlocked: ${id}` }); return; }

  const r = getBundle().regions[id];
  if (!r) { await ix.reply({ ephemeral:true, content:`❌ Unknown region: ${id}` }); return; }

  setRegion(ix.user.id, id);
  const e = new EmbedBuilder()
    .setTitle(`🧭 Traveling to ${r.name}`)
    .setDescription(r.description || '')
    .setImage(r.background_url || null);
  await ix.reply({ embeds:[e], ephemeral:false });
}
