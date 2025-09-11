// commands/chip.ts
// Slash command: /chip index
// - Browse chips with optional search & paging
// - Shows price from chips.tsv (zenny_cost) and marks upgrades
//
// Usage:
//   /chip index
//   /chip index search:<text> page:<n>

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';

import { listChips } from '../lib/data';

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
          .setDescription('Filter by name/element/effects')
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

export async function executeIndex(interaction: ChatInputCommandInteraction) {
  const q = (interaction.options.getString('search') ?? '').trim().toLowerCase();
  const page = interaction.options.getInteger('page') ?? 1;
  const perPage = 10;

  // Fetch chips and filter
  let chips = listChips();

  if (q) {
    chips = chips.filter((c) => {
      const name = (c.name ?? '').toLowerCase();
      const elem = ((c as any).element ?? '').toLowerCase();
      const eff  = ((c as any).effects ?? '').toLowerCase();
      return name.includes(q) || elem.includes(q) || eff.includes(q);
    });
  }

  // Stable sort by name then id
  chips.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));

  const total = chips.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const pageClamped = Math.min(Math.max(1, page), pages);

  const start = (pageClamped - 1) * perPage;
  const slice = chips.slice(start, start + perPage);

  const lines = slice.map((c) => {
    const parts: string[] = [];
    parts.push(`**${c.name}** (${inlineCode(c.id)})`);

    const element = (c as any).element ? ` ${inlineCode(String((c as any).element))}` : '';
    const power   = Number.isFinite((c as any).power) ? ` P${(c as any).power}` : '';
    const hits    = Number.isFinite((c as any).hits) && (c as any).hits > 1 ? ` x${(c as any).hits}` : '';
    const eff     = (c as any).effects ? ` • ${String((c as any).effects)}` : '';

    const price   = Number.isFinite((c as any).zenny_cost) ? `${(c as any).zenny_cost}z` : `0z`;
    const upgrade = (c as any).is_upgrade ? ' • Upgrade' : '';

    parts.push(`– ${price}${upgrade}${element}${power}${hits}${eff}`);
    return parts.join(' ');
  });

  const header = q
    ? `Results for ${inlineCode(q)}`
    : 'All chips';

  const embed = new EmbedBuilder()
    .setTitle('📦 Chip Index')
    .setDescription(
      [
        `**${header}**`,
        total ? `Page ${inlineCode(`${pageClamped}/${pages}`)} • ${inlineCode(`${total}`)} result(s)` : 'No results.',
        '',
        ...(lines.length ? lines : ['—']),
      ].join('\n')
    )
    .setFooter({ text: 'Tip: /chip index search:<text> page:<n>' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
