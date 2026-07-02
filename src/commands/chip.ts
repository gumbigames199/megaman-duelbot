// commands/chip.ts
// Slash command: /chip index
// - Groups generated code-variant chip IDs back into one base-chip view.
// - Exact searches show one detailed chip card with codes, stats, and image.
// - Broad searches show grouped rows instead of one row per code variant.

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';

import { listChips, chipCode, chipIsUpgrade } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('chip')
  .setDescription('Browse Net Battler chips')
  .addSubcommand((sc) =>
    sc
      .setName('index')
      .setDescription('List chips (with optional search)')
      .addStringOption((opt) =>
        opt
          .setName('search')
          .setDescription('Filter by name, code, element, category, or effect')
          .setRequired(false)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('page')
          .setDescription('Page number (1-based)')
          .setMinValue(1)
          .setRequired(false)
      )
  );

// index.ts calls execute(ix, sub) with a default of "index"
export async function execute(interaction: ChatInputCommandInteraction, sub?: string) {
  const subcmd = sub ?? interaction.options.getSubcommand(true);
  if (subcmd === 'index') {
    return executeIndex(interaction);
  }
  return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

type ChipGroup = {
  key: string;
  name: string;
  baseId: string;
  variants: any[];
  codes: string[];
  sample: any;
};

export async function executeIndex(interaction: ChatInputCommandInteraction) {
  const rawSearch = (interaction.options.getString('search') ?? '').trim();
  const q = rawSearch.toLowerCase();
  const page = interaction.options.getInteger('page') ?? 1;
  const perPage = 8;

  let groups = groupChips(listChips() as any[]);

  if (q) {
    const exact = groups.filter((g) =>
      g.name.toLowerCase() === q ||
      g.baseId.toLowerCase() === q ||
      g.key.toLowerCase() === q
    );

    groups = exact.length ? exact : groups.filter((g) => groupMatches(g, q));
  }

  groups.sort((a, b) => a.name.localeCompare(b.name) || a.baseId.localeCompare(b.baseId));

  if (groups.length === 1) {
    const embed = buildDetailedChipEmbed(groups[0], rawSearch);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const total = groups.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const pageClamped = Math.min(Math.max(1, page), pages);
  const start = (pageClamped - 1) * perPage;
  const slice = groups.slice(start, start + perPage);

  const header = rawSearch
    ? `Results for ${inlineCode(rawSearch)}`
    : 'All chips';

  const lines = slice.map(formatGroupLine);

  const embed = new EmbedBuilder()
    .setTitle('📦 Chip Index')
    .setDescription(
      [
        `**${header}**`,
        total ? `Page ${inlineCode(`${pageClamped}/${pages}`)} • ${inlineCode(`${total}`)} chip(s)` : 'No results.',
        '',
        ...(lines.length ? lines : ['—']),
        '',
        rawSearch ? 'Search an exact chip name to open its detailed card.' : 'Tip: /chip index search:<chip name>',
      ].join('\n')
    )
    .setFooter({ text: 'Grouped by chip name; codes are listed together.' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

function groupChips(chips: any[]): ChipGroup[] {
  const byKey = new Map<string, any[]>();

  for (const c of chips) {
    if (!c) continue;
    const name = norm(c.name ?? c.id);
    const baseId = norm(c.base_id ?? c.baseId ?? c.base ?? name);
    const key = (baseId || name || norm(c.id)).toLowerCase();
    if (!key) continue;

    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }

  const groups: ChipGroup[] = [];
  for (const [key, variants] of byKey) {
    variants.sort((a, b) => codeSortValue(codeOf(a)) - codeSortValue(codeOf(b)) || norm(a.id).localeCompare(norm(b.id)));
    const sample = pickSample(variants);
    const name = norm(sample?.name ?? sample?.base_id ?? sample?.id ?? key);
    const baseId = norm(sample?.base_id ?? sample?.baseId ?? sample?.base ?? name);
    const codes = collectCodes(variants);
    groups.push({ key, name, baseId, variants, codes, sample });
  }

  return groups;
}

function pickSample(variants: any[]): any {
  return variants.find((c) => imageUrl(c)) ?? variants[0] ?? {};
}

function groupMatches(g: ChipGroup, q: string): boolean {
  if (!q) return true;
  if (g.name.toLowerCase().includes(q)) return true;
  if (g.baseId.toLowerCase().includes(q)) return true;
  if (g.key.toLowerCase().includes(q)) return true;
  if (g.codes.some((c) => c.toLowerCase().includes(q))) return true;

  return g.variants.some((c) => {
    const haystack = [
      c.id,
      c.name,
      c.base_id,
      c.baseId,
      c.element,
      c.category,
      c.effects,
      c.description,
      c.rarity,
    ].map((x) => norm(x).toLowerCase());
    return haystack.some((x) => x.includes(q));
  });
}

function buildDetailedChipEmbed(group: ChipGroup, rawSearch: string): EmbedBuilder {
  const c = group.sample ?? {};
  const title = rawSearch
    ? `📦 Chip Index — ${group.name}`
    : `📦 ${group.name}`;

  const stats = [
    statLine('Element', c.element),
    statLine('Category', c.category),
    statLine('Power', numberText(c.power)),
    statLine('Hits', numberText(c.hits)),
    statLine('Accuracy', percentText(c.acc)),
    statLine('MB', numberText(c.mb_cost ?? c.mb)),
    statLine('Rarity', numberText(c.rarity)),
    statLine('Price', priceText(c.zenny_cost)),
    statLine('Max Copies', numberText(c.max_copies)),
    chipIsUpgrade(c) ? 'Upgrade: Yes' : '',
  ].filter(Boolean).join('\n') || '—';

  const variantIds = group.variants
    .map((v) => inlineCode(norm(v.id)))
    .join(' ');

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(norm(c.description) || '—')
    .addFields(
      { name: 'Codes', value: group.codes.length ? group.codes.map((x) => inlineCode(x)).join(' ') : '—', inline: false },
      { name: 'Stats', value: stats, inline: false },
      { name: 'Effects', value: norm(c.effects) || '—', inline: false },
      { name: 'Variant IDs', value: variantIds || '—', inline: false },
    )
    .setFooter({ text: `Base ID: ${group.baseId || group.key}` });

  const img = imageUrl(c);
  if (img) embed.setImage(img);

  return embed;
}

function formatGroupLine(group: ChipGroup): string {
  const c = group.sample ?? {};
  const parts: string[] = [];
  const codes = group.codes.length ? group.codes.join(', ') : '—';
  const element = norm(c.element);
  const power = numberText(c.power);
  const hits = toNum(c.hits);
  const price = priceText(c.zenny_cost);
  const upgrade = chipIsUpgrade(c) ? ' • Upgrade' : '';

  parts.push(`**${group.name}** — Codes: ${inlineCode(codes)}`);

  const statBits = [
    element && element !== 'Neutral' ? element : '',
    power ? `P${power}` : '',
    hits && hits > 1 ? `x${hits}` : '',
    price,
  ].filter(Boolean);

  parts.push(`${statBits.join(' • ') || '—'}${upgrade}`);
  return parts.join('\n');
}

function collectCodes(variants: any[]): string[] {
  const possible = norm(variants.find((c) => norm(c.possible_codes))?.possible_codes);
  const ordered = possible
    ? possible.split(/[,;| ]+/).map((x) => normalizeCode(x)).filter(Boolean)
    : [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const c of ordered) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }

  for (const v of variants) {
    const c = codeOf(v);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }

  return out.sort((a, b) => codeSortValue(a) - codeSortValue(b));
}

function codeOf(c: any): string {
  return normalizeCode(chipCode(c) || c?.code || c?.letter || c?.letters);
}

function normalizeCode(v: any): string {
  const s = norm(v);
  if (!s) return '';
  if (s === 'STAR' || s === '_STAR') return '*';
  return s;
}

function codeSortValue(code: string): number {
  if (!code) return 999;
  if (code === '*') return 900;
  const ch = code.toUpperCase().charCodeAt(0);
  return Number.isFinite(ch) ? ch : 800;
}

function statLine(label: string, value: string | number | null | undefined): string {
  const s = norm(value);
  return s ? `${label}: ${s}` : '';
}

function numberText(v: any): string {
  const n = toNum(v);
  return n === null ? '' : String(n);
}

function priceText(v: any): string {
  const n = toNum(v);
  return n === null ? '' : `${n}z`;
}

function percentText(v: any): string {
  const n = toNum(v);
  if (n === null) return '';
  if (n > 0 && n <= 1) return `${Math.round(n * 100)}%`;
  return `${n}%`;
}

function toNum(v: any): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function imageUrl(c: any): string | null {
  const raw = norm(c?.image_url ?? c?.image ?? c?.art_url ?? c?.icon_url);
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

function norm(v: any): string {
  return String(v ?? '').trim();
}
