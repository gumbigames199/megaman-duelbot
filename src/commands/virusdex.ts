import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { listSeenViruses } from '../lib/db';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('virusdex')
  .setDescription('Seen viruses (dex)')
  .addStringOption(o=>o.setName('id').setDescription('Optional virus_id for details'));

export async function execute(ix: ChatInputCommandInteraction) {
  const id = ix.options.getString('id', false)?.trim();
  const b = getBundle();

  if (id) {
    const v = b.viruses[id];
    if (!v) { await ix.reply({ ephemeral:true, content:`❌ Unknown virus: ${id}` }); return; }
    const e = new EmbedBuilder()
      .setTitle(`🦠 ${v.name}`)
      .setDescription(v.description || '')
      .addFields(
        { name:'Element', value: v.element || 'Neutral', inline:true },
        { name:'HP', value: String(v.hp || 0), inline:true },
        { name:'CR', value: String(v.cr || 1), inline:true },
      )
      .setImage(v.anim_url || v.image_url || null)
      .setFooter({ text:`id: ${id}` });
    await ix.reply({ embeds:[e], ephemeral:true });
    return;
  }

  const seen = listSeenViruses(ix.user.id);
  const lines = seen.map(sid => `• ${b.viruses[sid]?.name || sid}`).join('\n') || '—';
  await ix.reply({ ephemeral:true, embeds:[ new EmbedBuilder().setTitle('🧾 VirusDex').setDescription(lines) ] });
}
