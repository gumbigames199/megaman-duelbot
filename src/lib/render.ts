// src/lib/render.ts
// Centralized UI builders for Discord embeds & components.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';

import { getVirusArt, getVirusById, getBundle } from './data';

// -------------------------------
// Public Custom ID constants
// -------------------------------
export const HUB_IDS = {
  ENCOUNTER: 'hub:encounter',
  TRAVEL: 'hub:travel',
  SHOP: 'hub:shop',
} as const;

/**
 * Battle IDs (protocol used throughout)
 * - pick:<battleId>     → select chips (string select)
 * - lock:<battleId>     → lock in selections
 * - run:<battleId>      → attempt to escape
 */
export function battlePickId(battleId: string) { return `pick:${battleId}`; }
export function battleLockId(battleId: string) { return `lock:${battleId}`; }
export function battleRunId(battleId: string)  { return `run:${battleId}`; }

// -------------------------------
// Types used by render helpers
// -------------------------------
export type ChipHandItem = {
  id: string;
  name: string;
  power?: number;
  hits?: number;
  element?: string;
  effects?: string;
  description?: string;
};

export type BattleHP = {
  playerHP: number;
  playerHPMax: number;
  enemyHP: number;
  enemyHPMax: number;
};

export type EnemyHeader = {
  virusId: string;
  displayName: string;
};

export type RoundSummary = {
  playerLogLines: string[];
  enemyLogLines: string[];
};

export type VictorySummary = {
  title?: string;
  rewardLines: string[];
};

// -------------------------------
// Battle: Header with virus art
// -------------------------------
export function buildBattleHeaderEmbed(enemy: EnemyHeader): EmbedBuilder {
  const art = getVirusArt(enemy.virusId);
  const v = getVirusById(enemy.virusId) as any;

  const embed = new EmbedBuilder().setTitle(`${enemy.displayName} — VS — You`);

  // Prefer art helper; fall back to common TSV fields so we never show just an emoji.
  const thumb =
    (art && (art.image || art.sprite)) ||
    v?.image ||
    v?.image_url ||
    v?.sprite ||
    v?.sprite_url;

  if (thumb) embed.setThumbnail(thumb);

  return embed;
}

// -------------------------------
// Battle: HP block formatting
// -------------------------------
export function formatHP(hp: number, max: number): string {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const h = clamp(hp, 0, max);
  return `${h}/${max}`;
}

// -------------------------------
// Battle: Chip selection (3 from 5)
// -------------------------------
export function buildChipSelectionRows(
  battleId: string,
  hand: ChipHandItem[],
  selectedIds: string[] = []
) {
  // Single select that allows up to 3 choices
  const select = new StringSelectMenuBuilder()
    .setCustomId(battlePickId(battleId))
    .setPlaceholder('Select up to 3 chips…')
    .setMinValues(0)
    .setMaxValues(Math.min(3, hand.length))
    .addOptions(
      hand.map((c) => ({
        label: truncate(c.name, 75),
        description: truncate(describeChipBrief(c), 100),
        value: c.id,
        default: selectedIds.includes(c.id),
      }))
    );

  const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(battleLockId(battleId))
      .setStyle(ButtonStyle.Primary)
      .setLabel('Lock Turn'),
    new ButtonBuilder()
      .setCustomId(battleRunId(battleId))
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Run'),
  );

  return [rowSelect, rowButtons];
}

function describeChipBrief(c: ChipHandItem): string {
  const bits: string[] = [];
  if (c.element) bits.push(c.element);
  if (c.power) bits.push(`P${c.power}`);
  if (c.hits && c.hits > 1) bits.push(`${c.hits}x`);
  if (c.effects) bits.push(cleanOneLine(c.effects));
  return bits.join(' • ') || '—';
}

function cleanOneLine(s?: string) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// -------------------------------
// Battle: Full screen (HP + Hand)
// -------------------------------
export function renderBattleScreen(opts: {
  battleId: string;
  enemy: EnemyHeader;
  hp: BattleHP;
  hand: ChipHandItem[];
  selectedIds?: string[];
}) {
  const { battleId, enemy, hp, hand, selectedIds = [] } = opts;

  const header = buildBattleHeaderEmbed(enemy)
    .setDescription(
      [
        `**Your HP:** ${inlineCode(formatHP(hp.playerHP, hp.playerHPMax))}`,
        `**Enemy HP:** ${inlineCode(formatHP(hp.enemyHP, hp.enemyHPMax))}`,
        '',
        'Choose **up to 3** chips for this turn:',
      ].join('\n')
    );

  const rows = buildChipSelectionRows(battleId, hand, selectedIds);
  return { embed: header, components: rows };
}

// -------------------------------
// Battle: Round result + next hand
// -------------------------------
export function renderRoundResultWithNextHand(opts: {
  battleId: string;
  enemy: EnemyHeader;
  hp: BattleHP;
  round: RoundSummary;
  nextHand: ChipHandItem[];
  selectedIds?: string[];
}) {
  const { battleId, enemy, hp, round, nextHand, selectedIds = [] } = opts;

  const header = buildBattleHeaderEmbed(enemy);

  const lines: string[] = [];
  lines.push(`**Your HP:** ${inlineCode(formatHP(hp.playerHP, hp.playerHPMax))}`);
  lines.push(`**Enemy HP:** ${inlineCode(formatHP(hp.enemyHP, hp.enemyHPMax))}`);
  lines.push('');

  if (round.playerLogLines.length) {
    lines.push('**Your actions**');
    for (const l of round.playerLogLines) lines.push(`• ${l}`);
    lines.push('');
  }
  if (round.enemyLogLines.length) {
    lines.push('**Enemy actions**');
    for (const l of round.enemyLogLines) lines.push(`• ${l}`);
    lines.push('');
  }

  lines.push('**Select your next turn chips:**');
  header.setDescription(lines.join('\n'));

  const rows = buildChipSelectionRows(battleId, nextHand, selectedIds);
  return { embed: header, components: rows };
}

// -------------------------------
// Battle: Victory + Hub buttons
// -------------------------------
export function renderVictoryToHub(opts: {
  enemy: EnemyHeader;
  victory: VictorySummary;
}) {
  const { enemy, victory } = opts;

  const header = buildBattleHeaderEmbed(enemy);

  const title = victory.title ?? '🏆 Victory!';
  const desc = [`**${title}**`, ''];
  for (const l of victory.rewardLines) desc.push(`• ${l}`);
  desc.push('', 'What next? Choose an option below.');
  header.setDescription(desc.join('\n'));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(HUB_IDS.ENCOUNTER).setStyle(ButtonStyle.Primary).setLabel('Encounter'),
    new ButtonBuilder().setCustomId(HUB_IDS.TRAVEL).setStyle(ButtonStyle.Secondary).setLabel('Travel'),
    new ButtonBuilder().setCustomId(HUB_IDS.SHOP).setStyle(ButtonStyle.Secondary).setLabel('Shop'),
  );

  return { embed: header, components: [row] };
}

// -------------------------------
// Hub only (Jack-in screen)
// -------------------------------
export function renderJackInHub(regionLabel: string) {
  const embed = new EmbedBuilder()
    .setTitle('🔌 Jack-In')
    .setDescription([`**Region:** ${inlineCode(regionLabel)}`, 'Choose an action:'].join('\n'));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(HUB_IDS.ENCOUNTER).setStyle(ButtonStyle.Primary).setLabel('Encounter'),
    new ButtonBuilder().setCustomId(HUB_IDS.TRAVEL).setStyle(ButtonStyle.Secondary).setLabel('Travel'),
    new ButtonBuilder().setCustomId(HUB_IDS.SHOP).setStyle(ButtonStyle.Secondary).setLabel('Shop'),
  );

  return { embed, components: [row] };
}

// -------------------------------
// Compatibility: battleEmbed(state, opts)
// -------------------------------
export function battleEmbed(
  state: any,
  opts: { playerName?: string; playerAvatar?: string; regionId?: string } = {}
): EmbedBuilder {
  const virusId = String(state?.enemy_id || state?.virus_id || '');
  const virus = getVirusById(virusId);
  const enemy = { virusId, displayName: virus?.name || virusId };

  const embed = buildBattleHeaderEmbed(enemy);

  // Region background as the large image (keeps virus art in thumbnail)
  const regionId = opts.regionId || '';
  if (regionId) {
    const bundle = getBundle();
    const bg = (bundle as any)?.regions?.[regionId]?.background_url;
    if (bg) embed.setImage(bg);
  }

  if (opts.playerName) {
    embed.setAuthor({ name: opts.playerName, iconURL: opts.playerAvatar || undefined });
  }

  const playerHP = Number(state?.player_hp ?? 0);
  const playerHPMax = Number((state?.player_hp_max ?? playerHP) || 1); // parentheses avoid mixing ?? and ||
  const enemyHP = Number(state?.enemy_hp ?? 0);
  const enemyHPMax = Number(((virus as any)?.hp ?? enemyHP) || 1);     // parentheses avoid mixing ?? and ||
  const turn = Number(state?.turn ?? 1);

  embed.setDescription(
    [
      `**Your HP:** ${inlineCode(formatHP(playerHP, playerHPMax))}`,
      `**Enemy HP:** ${inlineCode(formatHP(enemyHP, enemyHPMax))}`,
      '',
      `**Turn ${turn}**`,
    ].join('\n')
  );

  return embed;
}

// -------------------------------
// Small helpers
// -------------------------------
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
