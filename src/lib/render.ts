import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';
import { getVirusArt } from './data';

export const HUB_IDS = {
  ENCOUNTER: 'hub:encounter',
  TRAVEL: 'hub:travel',
  SHOP: 'hub:shop',
} as const;

export function battlePickId(battleId: string) { return `pick:${battleId}`; }
export function battleLockId(battleId: string) { return `lock:${battleId}`; }
export function battleRunId(battleId: string)  { return `run:${battleId}`; }

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

export function buildBattleHeaderEmbed(enemy: EnemyHeader): EmbedBuilder {
  const art = getVirusArt(enemy.virusId);
  const embed = new EmbedBuilder().setTitle(`${enemy.displayName} — VS — You`);
  if (art.image) {
    embed.setImage(art.image);
  } else if (art.sprite) {
    embed.setImage(art.sprite);
  }
  return embed;
}

export function formatHP(hp: number, max: number): string {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const h = clamp(hp, 0, max);
  return `${h}/${max}`;
}

export function buildChipSelectionRows(
  battleId: string,
  hand: ChipHandItem[],
  selectedIds: string[] = []
) {
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
      .setLabel('Run')
  );

  return [rowSelect, rowButtons] as const;
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
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim();
}

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

export function renderVictoryToHub(opts: {
  enemy: EnemyHeader;
  victory: VictorySummary;
}) {
  const { enemy, victory } = opts;

  const header = buildBattleHeaderEmbed(enemy);

  const title = victory.title !== undefined ? victory.title : '🏆 Victory!';
  const desc: string[] = [ `**${title}**`, '' ];
  for (const l of victory.rewardLines) desc.push(`• ${l}`);
  desc.push('');
  desc.push('What next? Choose an option below.');
  header.setDescription(desc.join('\n'));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(HUB_IDS.ENCOUNTER).setStyle(ButtonStyle.Primary).setLabel('Encounter'),
    new ButtonBuilder().setCustomId(HUB_IDS.TRAVEL).setStyle(ButtonStyle.Secondary).setLabel('Travel'),
    new ButtonBuilder().setCustomId(HUB_IDS.SHOP).setStyle(ButtonStyle.Secondary).setLabel('Shop'),
  );

  return { embed: header, components: [row] };
}

export function renderJackInHub(regionLabel: string) {
  const embed = new EmbedBuilder()
    .setTitle('🔌 Jack-In')
    .setDescription(
      [
        `**Region:** ${inlineCode(regionLabel)}`,
        'Choose an action:',
      ].join('\n')
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(HUB_IDS.ENCOUNTER).setStyle(ButtonStyle.Primary).setLabel('Encounter'),
    new ButtonBuilder().setCustomId(HUB_IDS.TRAVEL).setStyle(ButtonStyle.Secondary).setLabel('Travel'),
    new ButtonBuilder().setCustomId(HUB_IDS.SHOP).setStyle(ButtonStyle.Secondary).setLabel('Shop'),
  );

  return { embed, components: [row] };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
