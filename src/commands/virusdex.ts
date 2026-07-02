import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, inlineCode } from 'discord.js';
import { listSeenViruses } from '../lib/db';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('virusdex')
  .setDescription('Seen viruses (dex)')
  .addStringOption(o => o.setName('id').setDescription('Optional virus_id for details'));

type MoveInfo = {
  name?: string;
  kind?: string;
  element?: string;
  power?: number | string;
  hits?: number | string;
  acc?: number | string;
  effects?: string;
  effect?: string;
  status?: string;
  weight?: number | string;
};

export async function execute(ix: ChatInputCommandInteraction) {
  const idRaw = ix.options.getString('id', false)?.trim();
  const b = getBundle() as any;
  const seen = new Set(listSeenViruses(ix.user.id).map(String));

  if (idRaw) {
    const id = resolveVirusId(idRaw, b.viruses);
    if (!id || !b.viruses[id]) {
      await ix.reply({ ephemeral: true, content: `❌ Unknown virus: ${idRaw}` });
      return;
    }

    if (!seen.has(id)) {
      await ix.reply({
        ephemeral: true,
        embeds: [
          new EmbedBuilder()
            .setTitle('🧾 VirusDex — Unknown Entry')
            .setDescription(`You have not encountered ${inlineCode(id)} yet. Defeat or encounter it to unlock its data.`),
        ],
      });
      return;
    }

    const v = b.viruses[id];
    const embed = new EmbedBuilder()
      .setTitle(`🦠 VirusDex — ${v.name || id}`)
      .setDescription(v.description || 'No description recorded.')
      .addFields(
        { name: '🧬 Element', value: String(v.element || 'Neutral'), inline: true },
        { name: '❤️ HP', value: String(v.hp || 0), inline: true },
        { name: '⭐ CR', value: String(v.cr || 1), inline: true },
        {
          name: '📊 Stats',
          value: [
            `ATK ${v.atk ?? 0}`,
            `DEF ${v.def ?? 0}`,
            `SPD ${v.spd ?? 0}`,
            `ACC ${formatAcc(v.acc)}`,
          ].join(' • '),
          inline: false,
        },
        { name: '⚔️ Moveset', value: formatMoves(v), inline: false },
        { name: '🎁 Possible Drops', value: formatDrops(v, b.dropTables), inline: false },
      )
      .setImage(v.anim_url || v.image_url || null)
      .setFooter({ text: `id: ${id}` });

    await ix.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const lines = Array.from(seen)
    .sort((a, bId) => String(b.viruses[a]?.name || a).localeCompare(String(b.viruses[bId]?.name || bId)))
    .map(sid => {
      const v = b.viruses[sid];
      const name = v?.name || sid;
      const elem = v?.element || 'Neutral';
      const hp = v?.hp ?? '?';
      return `• 🦠 **${name}** ${inlineCode(sid)} — ${elem} • HP ${hp}`;
    })
    .join('\n') || '—';

  await ix.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setTitle('🧾 VirusDex')
        .setDescription(lines)
        .setFooter({ text: 'Use /virusdex id:<virus_id> for moves, stats, and drops.' }),
    ],
  });
}

function resolveVirusId(input: string, viruses: Record<string, any>): string | null {
  if (viruses[input]) return input;
  const low = input.toLowerCase();
  for (const id of Object.keys(viruses || {})) {
    if (id.toLowerCase() === low) return id;
    if (String(viruses[id]?.name || '').toLowerCase() === low) return id;
  }
  return null;
}

function formatMoves(v: any): string {
  const rawMoves = [v.move_1json, v.move_2json, v.move_3json, v.move_4json]
    .map((raw, i) => parseMove(raw, i + 1))
    .filter((m): m is MoveInfo => !!m);

  if (!rawMoves.length) return '—';

  return rawMoves
    .map((m, i) => {
      const name = m.name || `Move ${i + 1}`;
      const kind = m.kind ? titleCase(String(m.kind)) : 'Move';
      const parts: string[] = [];

      if (m.element) parts.push(String(m.element));
      if (m.power !== undefined && String(m.power).trim() !== '') parts.push(`PWR ${m.power}`);
      if (m.hits !== undefined && Number(m.hits) > 1) parts.push(`${m.hits} hits`);
      if (m.acc !== undefined && String(m.acc).trim() !== '') parts.push(`${formatAcc(m.acc)} acc`);
      const fx = m.effects || m.effect || m.status;
      if (fx) parts.push(String(fx));

      return `**${i + 1}. ${name}** — ${kind}${parts.length ? ` • ${parts.join(' • ')}` : ''}`;
    })
    .join('\n');
}

function parseMove(raw: any, slot: number): MoveInfo | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as MoveInfo;
  } catch {
    // Fall through to plain-text display.
  }

  return { name: `Move ${slot}`, kind: text };
}

function formatDrops(v: any, dropTables: Record<string, any>): string {
  const tableId = String(v.drop_table_id || '').trim();
  if (!tableId) return '—';

  const table = dropTables?.[tableId];
  if (!table) return inlineCode(tableId);

  const entriesRaw = String(table.entries || table.item_ids || table.chip_ids || '').trim();
  if (!entriesRaw) return inlineCode(tableId);

  const entries = entriesRaw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 12);

  if (!entries.length) return inlineCode(tableId);

  return entries.map(e => `• ${displayDropToken(e)}`).join('\n');
}

function displayDropToken(token: string): string {
  const clean = token.trim();
  if (!clean) return '—';
  return clean.replace(/_STAR\b/g, ' [*]').replace(/_([A-Z])\b/g, ' [$1]');
}

function formatAcc(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v || '—');
  if (n <= 1) return `${Math.round(n * 100)}%`;
  return `${Math.round(n)}%`;
}

function titleCase(v: string): string {
  const s = v.trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
