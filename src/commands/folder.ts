import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction,
  StringSelectMenuBuilder, StringSelectMenuInteraction, ActionRowBuilder,
} from 'discord.js';
import { getFolder, setFolder, validateFolder, MAX_FOLDER, maxCopiesForChip } from '../lib/folder';
import { getInventory } from '../lib/db';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('folder')
  .setDescription('View and edit your chip folder');

function formatFolder(chips: string[]) {
  const b = getBundle();
  if (!chips.length) return '— (empty)';
  const counts = new Map<string, number>();
  for (const id of chips) counts.set(id, (counts.get(id) || 0) + 1);
  const lines: string[] = [];
  for (const [id, qty] of counts) {
    const c: any = b.chips[id] || {};
    lines.push(`• ${c.name || id} ×${qty}`);
  }
  return lines.join('\n');
}

export async function execute(ix: ChatInputCommandInteraction) {
  const folder = getFolder(ix.user.id);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Your Folder')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER}` });

  const editBtn = new ButtonBuilder().setCustomId('folder:edit').setStyle(ButtonStyle.Primary).setLabel('Edit');

  await ix.reply({ ephemeral: true, embeds: [e], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn)] });
}

export async function onEdit(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Edit Folder')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} — Add or remove chips, then Save.` });

  const addBtn = new ButtonBuilder().setCustomId('folder:addOpen').setStyle(ButtonStyle.Secondary).setLabel('Add chips');
  const remBtn = new ButtonBuilder().setCustomId('folder:removeOpen').setStyle(ButtonStyle.Secondary).setLabel('Remove chips');
  const saveBtn = new ButtonBuilder().setCustomId('folder:save').setStyle(ButtonStyle.Success).setLabel('Save');

  await ix.reply({ ephemeral: true, embeds: [e],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, remBtn, saveBtn)] });
}

export async function onOpenAdd(ix: ButtonInteraction) {
  const inv = getInventory(ix.user.id);
  const b = getBundle();
  const options = inv
    .filter(row => !(b.chips[row.chip_id]?.is_upgrade)) // cannot add upgrades
    .map(row => {
      const c: any = b.chips[row.chip_id] || {};
      const name = c.name || row.chip_id;
      const cap = maxCopiesForChip(row.chip_id);
      return {
        label: `${name} (own ${row.qty}, cap ${cap})`,
        value: row.chip_id,
      };
    })
    .slice(0, 25);

  if (!options.length) {
    await ix.reply({ ephemeral: true, content: 'You have no chips to add.' });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('folder:addSelect')
    .setMinValues(1)
    .setMaxValues(Math.min(10, options.length))
    .setPlaceholder('Select chips to add')
    .addOptions(options);

  await ix.reply({
    ephemeral: true,
    content: 'Pick chips to add:',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

export async function onOpenRemove(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const b = getBundle();
  if (!folder.length) {
    await ix.reply({ ephemeral: true, content: 'Folder is empty.' });
    return;
  }

  // Present first 25 entries (with duplicates)
  const options = folder.slice(0, 25).map((id, i) => {
    const c: any = b.chips[id] || {};
    const name = c.name || id;
    return { label: `${i+1}. ${name}`, value: `${i}:${id}` };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId('folder:removeSelect')
    .setMinValues(1)
    .setMaxValues(Math.min(10, options.length))
    .setPlaceholder('Select chips to remove (by slot)')
    .addOptions(options);

  await ix.reply({
    ephemeral: true,
    content: 'Pick entries to remove:',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

export async function onAddSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const b = getBundle();
  let folder = getFolder(userId);

  // Apply additions
  for (const id of ix.values) {
    // Only add if not upgrade and within caps + inventory
    const c: any = b.chips[id] || {};
    if (c?.is_upgrade) continue;
    folder = [...folder, id];
  }

  const v = validateFolder(userId, folder);
  if (!v.ok) {
    await ix.reply({ ephemeral: true, content: `❌ ${v.error}` });
    return;
  }

  setFolder(userId, folder);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Folder updated')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER}` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}

export async function onRemoveSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  let folder = getFolder(userId);

  // values are like "12:heatshot"
  const indexes = ix.values
    .map(v => parseInt(v.split(':')[0], 10))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>b-a); // remove from end first

  for (const idx of indexes) {
    if (idx >= 0 && idx < folder.length) folder.splice(idx, 1);
  }

  const v = validateFolder(userId, folder);
  if (!v.ok) {
    await ix.reply({ ephemeral: true, content: `❌ ${v.error}` });
    return;
  }

  setFolder(userId, folder);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Folder updated')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER}` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}

export async function onSave(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const e = new EmbedBuilder()
    .setTitle('✅ Folder saved')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER}` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}
