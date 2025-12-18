// src/commands/folder.ts
import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction,
  StringSelectMenuBuilder, StringSelectMenuInteraction, ActionRowBuilder,
} from 'discord.js';
import { getFolder, setFolder, validateFolder, MAX_FOLDER, maxCopiesForChip } from '../lib/folder';
import { getInventory, grantChip } from '../lib/db';
import { getChipById, listChips, chipIsUpgrade } from '../lib/data';

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
    lines.push(`• ${c.name || String(id)} ×${qty}`);
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

  await ix.reply({
    ephemeral: true,
    embeds: [e],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, remBtn, saveBtn)],
  });
}

/* ---------------- Add flow (with starter backfill) ---------------- */

export async function onOpenAdd(ix: ButtonInteraction) {
  const userId = ix.user.id;

  // 1) Read inventory
  let inv = getInventory(userId);

  // 2) Backfill once if inventory is empty using STARTER_CHIPS
  if (!inv.length) {
    const granted = grantStartersFromEnvIfAny(userId);
    if (granted > 0) inv = getInventory(userId);
  }

  // 3) Build options (skip zero-qty and upgrades using robust helper)
  const options = inv
    .filter(row => row.qty > 0)
    .map(row => {
      const chipId = String(row.chip_id);
      const chip: any = getChipById(chipId) || {};
      return { row, chipId, chip };
    })
    .filter(({ chip }) => chip && !chipIsUpgrade(chip))
    .map(({ row, chipId, chip }) => {
      const name = chip.name || chipId;
      const cap = maxCopiesForChip(chipId);
      return { label: `${name} (own ${row.qty}, cap ${cap})`, value: chipId };
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
  if (!folder.length) {
    await ix.reply({ ephemeral: true, content: 'Folder is empty.' });
    return;
  }

  // Present first 25 entries (with duplicates)
  const options = folder.slice(0, 25).map((id, i) => {
    const chipId = String(id);
    const c: any = getChipById(chipId) || {};
    const name = c.name || chipId;
    return { label: `${i + 1}. ${name}`, value: `${i}:${chipId}` };
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
  let folder = getFolder(userId);

  // Apply additions (never allow upgrades)
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
    .sort((a, b) => b - a); // remove from end first

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

/* ---------------- internal: starter backfill helpers ---------------- */

function parseStarterTokens(text: string): string[] {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** resolve a token by exact id (any type), lowercase id, or case-insensitive name */
function resolveChipToken(token: string): string | null {
  if (!token) return null;

  // exact id hit
  const byId = getChipById(token);
  if (byId) return token;

  // lowercase id hit
  const low = String(token).toLowerCase();
  const byLow = getChipById(low);
  if (byLow) return low;

  // name match scan
  for (const c of listChips() as any[]) {
    if (String(c?.name || '').toLowerCase() === low) return c.id;
  }
  return null;
}

/** Grants starters from env ONLY if they resolve; returns number granted */
function grantStartersFromEnvIfAny(userId: string): number {
  const tokens = parseStarterTokens(process.env.STARTER_CHIPS || '');
  if (!tokens.length) return 0;
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
