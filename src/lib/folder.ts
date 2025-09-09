// src/commands/folder.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  EmbedBuilder,
} from 'discord.js';

import { db, getInventory } from '../lib/db';
import { getBundle } from '../lib/data';

const MAX_FOLDER = 30;
const DEFAULT_MAX_COPIES = 4;

const SINGLE_COPY_IDS = new Set(
  String(process.env.SINGLE_COPY_CHIPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// ---------------- DB helpers ----------------
function readFolder(userId: string): string[] {
  const rows = db
    .prepare(`SELECT slot, chip_id FROM folder WHERE user_id=? ORDER BY slot ASC`)
    .all(userId) as any[];
  return rows.map(r => r.chip_id).filter(Boolean);
}

function writeFolder(userId: string, chips: string[]) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM folder WHERE user_id=?`).run(userId);
    const ins = db.prepare(`INSERT INTO folder (user_id, slot, chip_id) VALUES (?,?,?)`);
    chips.slice(0, MAX_FOLDER).forEach((id, i) => ins.run(userId, i + 1, id));
  });
  tx();
}

// ---------------- Rules ----------------
function maxCopiesForChip(chipId: string): number {
  const c: any = getBundle().chips[chipId] || {};
  // Prefer explicit max_copies if present in TSV
  const tsvMax = Number(c.max_copies);
  if (Number.isFinite(tsvMax) && tsvMax > 0) return Math.min(4, Math.max(1, tsvMax));

  // Heuristics
  const cat = String(c.category || '').toLowerCase();
  if (cat.includes('boss')) return 1;
  if (SINGLE_COPY_IDS.has(chipId)) return 1;

  return DEFAULT_MAX_COPIES;
}

// ---------------- UI helpers ----------------
function renderFolderList(ids: string[]): string {
  const chips = getBundle().chips;
  const lines: string[] = [];
  for (let i = 0; i < MAX_FOLDER; i++) {
    const cid = ids[i];
    if (!cid) {
      lines.push(`${String(i + 1).padStart(2, ' ')}. —`);
      continue;
    }
    const c: any = chips[cid] || {};
    const name = c.name || cid;
    const code = c.letters || c.code || '';
    const pow  = c.power ? ` ${c.power}${c.hits && c.hits > 1 ? `×${c.hits}` : ''}` : '';
    lines.push(`${String(i + 1).padStart(2, ' ')}. ${name}${code ? ` [${code}]` : ''}${pow}`);
  }
  return lines.join('\n');
}

function folderEmbed(userId: string, editMode = false): EmbedBuilder {
  const ids = readFolder(userId);
  return new EmbedBuilder()
    .setTitle(`📁 Folder (${ids.length}/${MAX_FOLDER})${editMode ? ' — Edit' : ''}`)
    .setDescription(renderFolderList(ids));
}

function viewButtons(): ActionRowBuilder<ButtonBuilder> {
  const edit = new ButtonBuilder().setCustomId('folder:edit').setLabel('Edit').setStyle(ButtonStyle.Primary);
  const save = new ButtonBuilder().setCustomId('folder:save').setLabel('Save').setStyle(ButtonStyle.Success).setDisabled(true);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(edit, save);
}

function editButtons(): ActionRowBuilder<ButtonBuilder> {
  const add = new ButtonBuilder().setCustomId('folder:addOpen').setLabel('Add From Inventory').setStyle(ButtonStyle.Secondary);
  const remove = new ButtonBuilder().setCustomId('folder:removeOpen').setLabel('Remove From Folder').setStyle(ButtonStyle.Secondary);
  const save = new ButtonBuilder().setCustomId('folder:save').setLabel('Save').setStyle(ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(add, remove, save);
}

function backToEditButtons(): ActionRowBuilder<ButtonBuilder> {
  const back = new ButtonBuilder().setCustomId('folder:edit').setLabel('⬅ Back').setStyle(ButtonStyle.Secondary);
  const save = new ButtonBuilder().setCustomId('folder:save').setLabel('Save').setStyle(ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(back, save);
}

// ---------------- Slash ----------------
export const data = new SlashCommandBuilder()
  .setName('folder')
  .setDescription('View and edit your Navi folder (up to 30 chips).');

export async function execute(ix: ChatInputCommandInteraction) {
  const embed = folderEmbed(ix.user.id, false);
  await ix.reply({ embeds: [embed], components: [viewButtons()], ephemeral: true });
}

// ---------------- Buttons ----------------
export async function onEdit(ix: ButtonInteraction) {
  const embed = folderEmbed(ix.user.id, true);
  await ix.update({ embeds: [embed], components: [editButtons()] });
}

export async function onSave(ix: ButtonInteraction) {
  const embed = folderEmbed(ix.user.id, false);
  await ix.update({ embeds: [embed], components: [viewButtons()] });
}

export async function onOpenAdd(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const bundle = getBundle();
  const folderIds = readFolder(userId);
  const curCounts = countBy(folderIds);
  const remainSlots = Math.max(0, MAX_FOLDER - folderIds.length);

  // Inventory map: chip_id -> qty
  const invRows = getInventory(userId) as any[]; // expect [{chip_id, qty}]
  const invMap = new Map<string, number>();
  for (const r of invRows) invMap.set(r.chip_id, (invMap.get(r.chip_id) || 0) + (Number(r.qty) || 0));

  // Build aggregated options: one option per chip with "×N" available to add now.
  type Opt = { id: string; canAdd: number; label: string };
  const opts: Opt[] = [];
  for (const [id, qty] of invMap.entries()) {
    if (!id) continue;
    const have = curCounts.get(id) || 0;
    const cap = maxCopiesForChip(id);
    const byCap = Math.max(0, cap - have);
    const byInv = Math.max(0, qty - have);
    const canAdd = Math.min(byCap, byInv, remainSlots);
    if (canAdd <= 0) continue;

    const c: any = bundle.chips[id] || {};
    const name = c.name || id;
    const code = c.letters || c.code || '';
    const label = `${name}${code ? ` [${code}]` : ''} ×${canAdd}`;
    opts.push({ id, canAdd, label: label.slice(0, 100) });
  }

  // Sort for sanity
  opts.sort((a, b) => a.label.localeCompare(b.label));

  const select = new StringSelectMenuBuilder()
    .setCustomId('folder:addSelect')
    .setPlaceholder(opts.length ? 'Select chips to add (adds up to shown ×N)' : 'No eligible chips to add')
    .setMinValues(0)
    .setMaxValues(Math.min(25, opts.length));
  if (opts.length) {
    select.addOptions(
      opts.slice(0, 25).map(o => ({ label: o.label, value: `${o.id}|${o.canAdd}` }))
    );
  }

  const embed = folderEmbed(userId, true);
  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      backToEditButtons(),
    ],
  });
}

export async function onOpenRemove(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const bundle = getBundle();
  const ids = readFolder(userId);

  const options = ids.map((cid, i) => {
    const c: any = bundle.chips[cid] || {};
    const label = `${String(i + 1).padStart(2, ' ')}. ${c.name || cid}${c.letters ? ` [${c.letters}]` : ''}`.slice(0, 100);
    return { label, value: String(i + 1) }; // remove by slot number to target exact duplicate
  }).slice(0, 25);

  const sel = new StringSelectMenuBuilder()
    .setCustomId('folder:removeSelect')
    .setPlaceholder(options.length ? 'Select chip(s) to remove' : 'Folder is empty')
    .setMinValues(0)
    .setMaxValues(options.length || 1);
  if (options.length) sel.addOptions(options);

  const embed = folderEmbed(userId, true);
  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel),
      backToEditButtons(),
    ],
  });
}

// ---------------- Select handlers ----------------
export async function onAddSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const selections = (ix.values || []).slice(0, 25); // safety
  if (!selections.length) {
    await onEdit(ix as unknown as ButtonInteraction);
    return;
  }

  const bundle = getBundle();
  const invRows = getInventory(userId) as any[];
  const invMap = new Map<string, number>();
  for (const r of invRows) invMap.set(r.chip_id, (invMap.get(r.chip_id) || 0) + (Number(r.qty) || 0));

  let next = readFolder(userId);

  // Apply additions, clamped by inventory, per-chip cap, and remaining slots.
  for (const raw of selections) {
    const [id, countStr] = String(raw).split('|');
    let req = Math.max(1, parseInt(countStr, 10) || 1);

    while (req > 0 && next.length < MAX_FOLDER) {
      const invQty = invMap.get(id) || 0;
      const haveNow = next.filter(x => x === id).length;
      const cap = maxCopiesForChip(id);
      if (haveNow >= cap) break;                   // cap reached
      if (haveNow >= invQty) break;                // not enough inventory left
      next.push(id);
      req -= 1;
    }
  }

  writeFolder(userId, next);
  const embed = folderEmbed(userId, true);
  // Keep them in edit mode so they can continue tweaking
  await ix.update({ embeds: [embed], components: [editButtons()] });
}

export async function onRemoveSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const slots = (ix.values || []).map(v => parseInt(v, 10)).filter(n => Number.isFinite(n));
  const cur = readFolder(userId);
  if (!slots.length || !cur.length) {
    await onEdit(ix as unknown as ButtonInteraction);
    return;
  }
  const toRemove = new Set(slots);
  const next = cur.filter((_cid, idx) => !toRemove.has(idx + 1));
  writeFolder(userId, next);
  const embed = folderEmbed(userId, true);
  await ix.update({ embeds: [embed], components: [editButtons()] });
}

// ---------------- util ----------------
function countBy(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}
