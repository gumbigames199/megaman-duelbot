// src/commands/virusdex.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { listSeenViruses } from '../lib/db';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('virusdex')
  .setDescription('Seen viruses (dex)')
  .addStringOption(o => o.setName('id').setDescription('Optional virus_id for details'));

export async function execute(ix: ChatInputCommandInteraction) {
  const id = ix.options.getString('id', false)?.trim();
  const b = getBundle() as any;

  if (id) {
    const v = b.viruses?.[id];
    if (!v) {
      await ix.reply({ ephemeral: true, content: `❌ Unknown virus: ${id}` });
      return;
    }

    const e = new EmbedBuilder()
      .setTitle(`🦠 ${v.name || id}`)
      .setDescription(v.description || '')
      .addFields(
        { name: 'Element', value: String(v.element || 'Neutral'), inline: true },
        { name: 'HP', value: String(v.hp || 0), inline: true },
        { name: 'CR', value: String(v.cr || 1), inline: true },
        { name: 'Location', value: formatVirusLocation(v, b.regions), inline: false },
        { name: 'Moveset', value: formatMoves(v), inline: false },
      )
      .setImage(v.anim_url || v.image_url || null)
      .setFooter({ text: `id: ${id}` });

    await ix.reply({ embeds: [e], ephemeral: true });
    return;
  }

  const seen = listSeenViruses(ix.user.id);
  const lines = seen.map(sid => {
    const v = b.viruses?.[sid];
    const location = v ? ` — ${formatVirusLocation(v, b.regions).replace(/\*\*/g, '')}` : '';
    return `• ${v?.name || sid}${location}`;
  }).join('\n') || '—';

  await ix.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('🧾 VirusDex').setDescription(lines)] });
}

function formatMoves(v: any): string {
  const rawMoves = [v.move_1json, v.move_2json, v.move_3json, v.move_4json]
    .map((raw, i) => parseMove(raw, i + 1))
    .filter((m): m is any => !!m);
  if (!rawMoves.length) return '—';

  return rawMoves.map((m, i) => {
    const name = safeMoveText(m.name) || `Move ${i + 1}`;
    const kind = safeMoveText(m.kind) ? titleCase(safeMoveText(m.kind)) : 'Move';
    const parts: string[] = [];

    const element = safeMoveText(m.element);
    if (element) parts.push(element);
    if (isScalarMoveValue(m.power) && String(m.power).trim() !== '') parts.push(`PWR ${m.power}`);
    if (isScalarMoveValue(m.hits) && Number(m.hits) > 1) parts.push(`${m.hits} hits`);
    if (isScalarMoveValue(m.acc) && String(m.acc).trim() !== '') parts.push(`${formatAcc(m.acc)} acc`);

    const fx = scalarMoveText(m.effects ?? m.effect ?? m.status);
    if (fx) parts.push(fx);

    return `**${i + 1}. ${name}** — ${kind}${parts.length ? ` • ${parts.join(' • ')}` : ''}`;
  }).join('\n');
}

function parseMove(raw: any, slot: number): any | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;

  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { name: `Move ${slot}`, kind: text };
}

function isScalarMoveValue(v: any): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function safeMoveText(v: any): string {
  if (!isScalarMoveValue(v)) return '';
  const text = String(v ?? '').trim();
  return text === '[object Object]' ? '' : text;
}

function scalarMoveText(v: any): string {
  return safeMoveText(v);
}

function formatAcc(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '?');
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

function formatVirusLocation(v: any, regions: Record<string, any>): string {
  const regionId = String(v.region_id ?? v.region ?? '').trim();
  const region = regionId ? regions?.[regionId] : null;
  const regionName = region?.name || region?.label || regionId || 'Unknown region';

  const zones = normalizeVirusZones(v.zones ?? v.zone);
  const zoneText = zones.length
    ? zones.map(z => `Zone ${z}`).join(', ')
    : 'All zones / unspecified';

  return `**${regionName}** — ${zoneText}`;
}

function normalizeVirusZones(raw: any): number[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map(n => Number(n)).filter(n => Number.isFinite(n)))).sort((a, b) => a - b);
  }

  const text = String(raw ?? '').trim();
  if (!text) return [];

  const out: number[] = [];
  for (const part of text.split(/[,;| ]+/).map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      for (let z = a; z <= b; z++) out.push(z);
    } else {
      const n = Number(part);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
