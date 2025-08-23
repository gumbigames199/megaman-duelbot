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

function padTo30(ids: string[]): string[] {
  const b = getBundle();
  const fallback = Object.keys(b.chips)[0] || '';
  const out = ids.slice();
  while (out.length < 30 && fallback) out.push(fallback);
  return out.slice(0, 30);
}

export const data = new SlashCommandBuilder()
  .setName('folder')
  .setDescription('Manage your 30‑chip folder')
  .addSubcommand(s => s.setName('list').setDescription('Show folder & inventory'))
  .addSubcommand(s => s.setName('setslot').setDescription('Set a slot to a chip id')
    .addIntegerOption(o => o.setName('slot').setDescription('0-29').setRequired(true).setMinValue(0).setMaxValue(29))
    .addStringOption(o => o.setName('chip_id').setDescription('Chip ID from TSV').setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear a slot (replaces with fallback chip)')
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
    const ids = getFolder(ix.user.id);
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

    const cur = padTo30(getFolder(ix.user.id));
    cur[slot] = chipId;

    const val = validateFolder(cur);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, cur);
    await ix.reply({ ephemeral: true, content: `✅ Slot #${slot} → ${chipId}` });
    return;
  }

  if (sub === 'clear') {
    const slot = ix.options.getInteger('slot', true);
    const cur = padTo30(getFolder(ix.user.id));
    const fallback = Object.keys(b.chips)[0];
    if (!fallback) { await ix.reply({ ephemeral: true, content: '❌ No fallback chip available.' }); return; }

    cur[slot] = fallback;

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
    const cur = padTo30(getFolder(ix.user.id));
    const next = cur.slice();

    for (const id of add) {
      if (!b.chips[id]) continue;
      // replace from the front to keep size at 30
      next.shift();
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
    const cur = padTo30(getFolder(ix.user.id)).filter(id => !rem.has(id));

    // pad back to 30 with a fallback chip
    const fallback = Object.keys(b.chips)[0] || '';
    const next = padTo30(cur.length ? cur : [fallback]);

    const val = validateFolder(next);
    if (!val.ok) { await ix.reply({ ephemeral: true, content: `❌ ${val.msg}` }); return; }

    setFolder(ix.user.id, next);
    await ix.reply({ ephemeral: true, content: `✅ Removed ${rem.size} chip(s).` });
    return;
  }
}
