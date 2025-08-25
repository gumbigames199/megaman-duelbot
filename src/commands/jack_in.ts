import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getBundle } from '../lib/data';
import { getPlayer } from '../lib/db';
import { setRegion } from '../lib/regions';

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Enter a region')
  .addStringOption(o =>
    o.setName('region_id').setDescription('Region TSV id').setRequired(true)
  );

export async function execute(ix: ChatInputCommandInteraction) {
  const p = getPlayer(ix.user.id);
  if (!p) {
    await ix.reply({ ephemeral: true, content: '❌ No profile. Use /start.' });
    return;
  }

  const id = ix.options.getString('region_id', true).trim();
  const r = getBundle().regions[id];
  if (!r) {
    await ix.reply({ ephemeral: true, content: `❌ Unknown region: ${id}` });
    return;
  }

  setRegion(ix.user.id, id);

  const e = new EmbedBuilder()
    .setTitle(`🔌 Jacked into ${r.name}`)
    .setDescription(r.description || '');
  if (r.background_url) e.setImage(r.background_url);

  await ix.reply({ embeds: [e], ephemeral: false });
}
