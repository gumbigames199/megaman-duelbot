import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('chip')
  .setDescription('Show a chip card')
  .addStringOption(o => o.setName('id').setDescription('chip_id').setRequired(true));

export async function execute(ix: ChatInputCommandInteraction) {
  const id = ix.options.getString('id', true).trim();
  const b = getBundle();
  const c = b.chips[id];
  if (!c) { await ix.reply({ ephemeral:true, content:`❌ Unknown chip: ${id}` }); return; }

  const e = new EmbedBuilder()
    .setTitle(`${c.name} [${c.letters}]`)
    .setDescription(c.description || '')
    .addFields(
      { name: 'Element', value: c.element || 'Neutral', inline: true },
      { name: 'Power',   value: String(c.power ?? 0), inline: true },
      { name: 'Acc',     value: `${Math.round((c.acc ?? 0.95)*100)}%`, inline: true },
      { name: 'Hits',    value: String(c.hits ?? 1), inline: true },
      { name: 'MB',      value: String(c.mb_cost ?? 0), inline: true },
      { name: 'Category',value: c.category || '—', inline: true },
      { name: 'Effects', value: c.effects || '—', inline: false },
    )
    .setImage(c.image_url || null)
    .setFooter({ text: `id: ${id}` });

  await ix.reply({ embeds:[e], ephemeral:true });
}
