// src/commands/folder.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getBundle } from '../lib/data';
import { listInventory } from '../lib/db';
import { getFolder, setFolder, validateFolder } from '../lib/folder';

function parseList(raw?: string): string[] {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Pad to 30 chips without violating the duplicate cap and trying to keep memory low.
 * Strategy:
 *  - Start from current ids
 *  - Count per-chip occurrences
 *  - Sort all chips by mb_cost asc (stable)
 *  - Fill with next cheapest chips whose count < maxDup
 */
function padTo30Smart(ids: string[]): string[] {
  const b = getBundle();
  const cap = Math.max(1, Number(process.env.FOLDER_MAX_DUP || 4));

  const out = ids.slice(0, 30);
  const counts: Record<string, number> = {};
  for (const id of out) counts[id] = (counts[id] || 0) + 1;

  // sortable list of available chips (cheapest first; deterministic fallback to id)
  const all = Object.values(b.chips)
    .map(c => ({ id: c.id, cost: Number(c.mb_cost || 0) }))
    .sort((a, b) => (a.cost - b.cost) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let i = 0;
  while (out.length < 30 && all.length) {
    const cand = all[i % all.length];
    i++;

    // skip if already at duplicate cap
    if ((counts[cand.id] || 0) >= cap) continue;

    // only add real chips
    if (!b.chips[cand.id]) continue;

    out.push(cand.id);
    counts[cand.id] = (counts[cand.id] || 0) + 1;

    // safety valve in case data is tiny
    if (i > all.length * 10) break;
  }

  // If we somehow still didn't reach 30 (tiny dataset), just trim/pad with unique ids we have.
  while (out.length < 30) out.push(all[(out.length) % all.length]?.id || out[out.length - 1]);

  return out.slice(0, 30);
}

export const data = new SlashCommandBuilder()
  .setName('folder')
  .setDescription('Manage your 30-chip folder')
  .addSubcommand(s => s.setName('list').setDescription('Show folder & inventory'))
  .addSubcommand(s => s.setName('setslot').setDescription('Set a slot to a chip id')
    .addIntegerOption(o => o.setName('slot').setDescription('0-29').setRequired(true).setMinValue(0).setMaxValue(29))
    .addStringOption(o => o.setName('chip_id').setDescription('Chip ID from TSV').setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear a slot (replaces with a valid filler chip)')
    .addIntegerOption(o => o.setName('slot').setDescription('0-29').setRequired(true).setMinValue(0).setMaxValue(29)))
  .addSubcommand(s => s.setName('setall').setDescription('Set all 30 by list (validates memory & dup caps)')
    .addStringOption(o => o.setName('ids').setDescription('exactly 30 ids, comma/space sep').setRequired(true)))
  .addSubcommand(s => s.setName('addmany').setDescription('Add many chips (fills from front; validates)')
    .addStringOption(o => o.setName('ids').setDescription('chip ids, comma/space sep').setRequired(true)))
  .addSubcommand(s => s.setName('removemany').setDescription('Remove many chips (validates & pads)')
    .addStringOption(o => o.setName('ids').setDescription('chip ids, comma/space sep').setRequired(true)));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();
  const b = getBundle();

  if (sub === 'list') {
    const ids = padTo30Smart(getFolder(ix.user.id));
    const mem = ids.reduce((m, id) => m + Number(b.chips[id]?.mb_cost || 0), 0);
    const inv = listInventory(ix.user.id);

    const slots = ids
      .map((id, i) => `${String(i).padStart(2, '0')}: ${b.chips[id]?.name || id}`)
      .join('\n') || '—';
    const invStr = inv.length
      ? inv.slice(0, 30).map(x => `${x.chip_id}×${x.qty}`).join(' • ')
      : '—';

    const e = new EmbedBuilder()
      .setTitle('📁 Folder (slots 0–29)')
      .addFields(
        { name: 'Slots', value: '```' + slots + '```' },
        { name: 'Inventory (top)', value: invStr },
      )
      .setFooter({
        text: `Memory: ${mem}/${Number(process.env.FOLDER_MEM_CAP || 80)} • Duplicates ≤ ${Number(process.env.FOLDER_MAX_DUP || 4)}`
      });
    await ix.reply({ ephemeral: true, embeds: [e] });
    return;
  }

  if (sub === 'setslot') {
    const slot = ix.options.getInteger('slot', true);
    const chipId = ix.options.getString('chip_id', true).trim();
    if (!b.chips[chipId]) { await ix.reply({ ephemeral: true, content: `❌ Unknown chip id: ${chipId}` }); return; }

    const cur = padTo30Smart(getFolder(ix.user.id));
    cur[slot] = chipId;

    const val = validateFolder(cur);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, cur);
    await ix.reply({ ephemeral: true, content: `✅ Slot #${slot} → ${chipId}` });
    return;
  }

  if (sub === 'clear') {
    const slot = ix.options.getInteger('slot', true);
    const cur = padTo30Smart(getFolder(ix.user.id));

    // Replace this slot with a valid filler chip (cheapest available that won't break dup cap)
    const cap = Math.max(1, Number(process.env.FOLDER_MAX_DUP || 4));
    const counts: Record<string, number> = {};
    for (const id of cur) counts[id] = (counts[id] || 0) + 1;

    const fillers = Object.values(b.chips)
      .map(c => ({ id: c.id, cost: Number(c.mb_cost || 0) }))
      .sort((a, b) => (a.cost - b.cost) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let replacement = cur[slot]; // default to what was there
    for (const f of fillers) {
      if ((counts[f.id] || 0) < cap) { replacement = f.id; break; }
    }

    cur[slot] = replacement;

    const val = validateFolder(cur);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, cur);
    await ix.reply({ ephemeral: true, content: `🧹 Cleared slot #${slot}` });
    return;
  }

  if (sub === 'setall') {
    const ids = parseList(ix.options.getString('ids', true));
    if (ids.length !== 30) { await ix.reply({ ephemeral: true, content: '❌ Provide exactly 30 chip ids.' }); return; }

    const val = validateFolder(ids);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, ids);
    await ix.reply({ ephemeral: true, content: `✅ Folder set (${ids.length} chips).` });
    return;
  }

  if (sub === 'addmany') {
    const add = parseList(ix.options.getString('ids', true));
    const cur = padTo30Smart(getFolder(ix.user.id));
    const next = cur.slice();

    for (const id of add) {
      if (!b.chips[id]) continue;
      next.shift();     // maintain length 30
      next.push(id);
    }

    const val = validateFolder(next);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, next);
    await ix.reply({ ephemeral: true, content: `✅ Added ${add.length} chip(s).` });
    return;
  }

  if (sub === 'removemany') {
    const rem = new Set(parseList(ix.options.getString('ids', true)));
    const cur = getFolder(ix.user.id).filter(id => !rem.has(id));

    const next = padTo30Smart(cur);

    const val = validateFolder(next);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, next);
    await ix.reply({ ephemeral: true, content: `✅ Removed ${rem.size} chip(s).` });
    return;
  }
}
