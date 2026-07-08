// src/commands/folder.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
} from 'discord.js';

import {
  getFolder,
  setFolder,
  validateFolder,
  validateFolderMinimum,
  MAX_FOLDER,
  MIN_FOLDER,
  maxCopiesForChip,
  getMaxRemovableFolderSlots,
} from '../lib/folder';
import { getInventory, grantChip } from '../lib/db';
import { getChipById, chipIsUpgrade, formatChipName, resolveChipForGrant } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('folder')
  .setDescription('View and edit your chip folder');

function formatFolder(chips: string[]) {
  if (!chips.length) return '— (empty)';
  const counts = new Map<string, number>();
  for (const id of chips) counts.set(String(id), (counts.get(String(id)) || 0) + 1);
  const lines: string[] = [];
  for (const [id, qty] of counts) {
    const c: any = getChipById(id) || {};
    lines.push(`• ${formatChipName(c || String(id))}${c?.element ? ` — ${c.element}` : ''} ×${qty}`);
  }
  return lines.join('\n');
}

function folderCounts(chips: string[]) {
  const out = new Map<string, number>();
  for (const id of chips) out.set(String(id), (out.get(String(id)) || 0) + 1);
  return out;
}

function availableOutsideFolder(row: any, counts: Map<string, number>): number {
  const owned = Math.max(0, Number(row?.qty ?? 0) || 0);
  const inFolder = Math.max(0, counts.get(String(row?.chip_id)) || 0);
  return Math.max(0, owned - inFolder);
}

export async function execute(ix: ChatInputCommandInteraction) {
  const folder = getFolder(ix.user.id);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Your Folder')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` });

  const editBtn = new ButtonBuilder().setCustomId('folder:edit').setStyle(ButtonStyle.Primary).setLabel('Edit');
  await ix.reply({ ephemeral: true, embeds: [e], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn)] });
}

export async function onEdit(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const e = new EmbedBuilder()
    .setTitle('🗂️ Edit Folder')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER} — Add/remove, then Save at exactly 30.` });

  const addBtn = new ButtonBuilder().setCustomId('folder:addOpen').setStyle(ButtonStyle.Secondary).setLabel('Add chips');
  const maxRemovable = getMaxRemovableFolderSlots(ix.user.id, folder.length);
  const remBtn = new ButtonBuilder().setCustomId('folder:removeOpen').setStyle(ButtonStyle.Secondary).setLabel('Remove chips').setDisabled(maxRemovable <= 0);
  const saveBtn = new ButtonBuilder().setCustomId('folder:save').setStyle(ButtonStyle.Success).setLabel('Save');

  await ix.reply({
    ephemeral: true,
    embeds: [e],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, remBtn, saveBtn)],
  });
}

export async function onOpenAdd(ix: ButtonInteraction) {
  const userId = ix.user.id;
  let inv = getInventory(userId);

  if (!inv.length) {
    const granted = grantStartersFromEnvIfAny(userId);
    if (granted > 0) inv = getInventory(userId);
  }

  const counts = folderCounts(getFolder(userId));

  const options = inv
    .filter(row => row.qty > 0)
    .map(row => {
      const chipId = String(row.chip_id);
      const chip: any = getChipById(chipId) || {};
      return { row, chipId, chip };
    })
    .map(({ row, chipId, chip }) => ({ row, chipId, chip, available: availableOutsideFolder(row, counts) }))
    .filter(({ chip, available }) => chip && !chipIsUpgrade(chip) && available > 0)
    .map(({ row, chipId, chip, available }) => {
      const name = formatChipName(chip || chipId);
      const cap = maxCopiesForChip(chipId);
      return { label: `${name} (available ${available}/${row.qty}, cap ${cap})`.slice(0, 100), description: `${chip.element || 'Neutral'}${chip.power ? ` • ${chip.power} PWR` : ''}${chip.effects ? ` • ${String(chip.effects)}` : ''}`.slice(0, 100), value: chipId };
    })
    .slice(0, 25);

  if (!options.length) {
    await ix.reply({ ephemeral: true, content: 'You have no available chip copies outside your folder to add.' });
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
  const message = buildRemovePageMessage(ix.user.id, 0);
  if (!message.ok) {
    await ix.reply({ ephemeral: true, content: message.error });
    return;
  }

  await ix.reply({
    ephemeral: true,
    content: message.content,
    components: message.components,
  });
}

export async function onRemovePage(ix: ButtonInteraction, page: number) {
  const message = buildRemovePageMessage(ix.user.id, page);
  if (!message.ok) {
    await ix.reply({ ephemeral: true, content: message.error });
    return;
  }

  await ix.update({
    content: message.content,
    components: message.components,
  });
}

function buildRemovePageMessage(userId: string, rawPage: number):
  | { ok: true; content: string; components: any[] }
  | { ok: false; error: string } {
  const folder = getFolder(userId);
  if (!folder.length) return { ok: false, error: 'Folder is empty.' };

  const maxRemovable = getMaxRemovableFolderSlots(userId, folder.length);
  if (maxRemovable <= 0) {
    return { ok: false, error: 'No folder entries can be removed right now.' };
  }

  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(folder.length / pageSize));
  const page = Math.min(Math.max(0, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 0), totalPages - 1);
  const start = page * pageSize;
  const end = Math.min(folder.length, start + pageSize);
  const options = buildRemoveOptions(folder, start, end);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`folder:removeSelect:${page}`)
    .setMinValues(1)
    .setMaxValues(Math.min(10, options.length, maxRemovable))
    .setPlaceholder(`Remove chips ${start + 1}–${end}`)
    .addOptions(options);

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`folder:removePage:${page - 1}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Prev')
    .setDisabled(page <= 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`folder:removePage:${page + 1}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Next')
    .setDisabled(page >= totalPages - 1);

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn);

  return {
    ok: true,
    content: `Pick entries to remove. Page **${page + 1}/${totalPages}** — showing slots **${start + 1}–${end}**.`,
    components: totalPages > 1 ? [selectRow, navRow] : [selectRow],
  };
}

function buildRemoveOptions(folder: string[], start: number, end: number) {
  return folder.slice(start, end).map((id, offset) => {
    const i = start + offset;
    const chipId = String(id);
    const c: any = getChipById(chipId) || {};
    const name = formatChipName(c || chipId);
    return {
      label: `${i + 1}. ${name}`.slice(0, 100),
      description: `${c.element || 'Neutral'}${c.power ? ` • ${c.power} PWR` : ''}`.slice(0, 100),
      value: `${i}:${chipId}`,
    };
  });
}

export async function onAddSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  let folder = getFolder(userId);

  for (const rawId of ix.values) {
    const id = String(rawId);
    const chip: any = getChipById(id) || {};
    if (!chip || chipIsUpgrade(chip)) continue;
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
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}

export async function onRemoveSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const folder = getFolder(userId);

  const indexes = ix.values
    .map(v => parseInt(v.split(':')[0], 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a);

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
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}

export async function onSave(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const v = validateFolderMinimum(ix.user.id, folder);
  if (!v.ok) {
    await ix.reply({ ephemeral: true, content: `❌ ${v.error}` });
    return;
  }

  const e = new EmbedBuilder()
    .setTitle('✅ Folder saved')
    .setDescription(formatFolder(folder))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Valid folder` });
  await ix.reply({ ephemeral: true, embeds: [e] });
}

function parseStarterTokens(text: string): string[] {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}

function resolveChipToken(token: string): string | null {
  return resolveChipForGrant(token);
}

function grantStartersFromEnvIfAny(userId: string): number {
  const tokens = parseStarterTokens(process.env.STARTER_CHIPS || 'Cannon,Cannon,Cannon');
  let granted = 0;
  for (const t of tokens) {
    const id = resolveChipToken(t);
    if (id) {
      grantChip(userId, id, 1);
      granted++;
    }
  }
  return granted;
}
