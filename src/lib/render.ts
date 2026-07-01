// src/lib/render.ts
import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { getVirusArt } from './data';

export type EnemyRef = { virusId: string; displayName?: string };

export function buildBattleHeaderEmbed(opts: { virusId: string; displayName?: string }) {
  const art = getVirusArt(opts.virusId);
  const e = new EmbedBuilder()
    .setTitle(`⚔️ ${opts.displayName || opts.virusId}`);

  if (art.image) e.setThumbnail(String(art.image));
  else if (art.sprite) e.setThumbnail(String(art.sprite));
  else e.setDescription(`${art.fallbackEmoji} ${opts.displayName || opts.virusId}`);

  return e;
}

type BattleHandRenderItem = {
  id: string;
  name: string;
  power?: number;
  hits?: number;
  element?: string;
  effects?: string;
  description?: string;
};

function hpBar(cur: number, max: number): string {
  const safeMax = Math.max(1, Number(max) || 1);
  const ratio = Math.max(0, Math.min(1, Number(cur) / safeMax));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const block = ratio > 0.5 ? '🟩' : ratio > 0.25 ? '🟨' : '🟥';
  return `${block.repeat(filled)}⬛`.repeat(0) + `${block.repeat(filled)}${'⬛'.repeat(empty)} ${Math.max(0, Math.floor(cur))}/${safeMax}`;
}

function statusBadges(text?: string): string {
  const raw = String(text || '').trim();
  if (!raw || raw === '—') return '—';
  return raw
    .replace(/burn/gi, '🔥 Burn')
    .replace(/poison/gi, '☠️ Poison')
    .replace(/freeze|frozen/gi, '❄️ Freeze')
    .replace(/paralyze|paralysis/gi, '⚡ Paralyze')
    .replace(/blind/gi, '🌫️ Blind')
    .replace(/barrier/gi, '🛡️ Barrier')
    .replace(/aura/gi, '✨ Aura');
}

function chipRole(c: BattleHandRenderItem): string {
  const eff = String(c.effects || '').toLowerCase();
  if (eff.includes('heal')) return '❤️ Heal';
  if (eff.includes('barrier') || eff.includes('aura')) return '🛡️ Defense';
  if (eff.includes('atk+') || eff.includes('attack+')) return '🔧 Boost';
  if (Number(c.power || 0) > 0) return `💥 ${c.power} PWR${c.hits && c.hits > 1 ? ` ×${c.hits}` : ''}`;
  return '⚙️ Support';
}

function selectedChipLines(hand: BattleHandRenderItem[], selectedIds: string[]): string[] {
  const selected = (selectedIds || [])
    .map((id) => hand.find((c) => c.id === id))
    .filter((c): c is BattleHandRenderItem => !!c);

  return selected.map((c, i) => `${i + 1}️⃣ **${c.name}** — ${chipRole(c)}`);
}

function chipQueueBlock(hand: BattleHandRenderItem[], selectedIds: string[]): string | undefined {
  const lines = selectedChipLines(hand, selectedIds);
  if (!lines.length) return undefined;
  return [`⚡ **Chip Queue (${lines.length}/3)**`, ...lines, '', '✅ Valid queue.'].join('\n');
}

function optionText(c: BattleHandRenderItem): { label: string; description?: string } {
  const bits: string[] = [];
  if (c.element) bits.push(c.element);
  if (c.power) bits.push(`${c.power} PWR${c.hits && c.hits > 1 ? ` ×${c.hits}` : ''}`);
  if (c.effects) bits.push(String(c.effects).replace(/\s+/g, ' ').trim());
  return {
    label: `${c.name}`.slice(0, 100),
    description: bits.join(' • ').slice(0, 100) || undefined,
  };
}

function combatStatusBlock(args: {
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  status?: { player?: string; enemy?: string };
}): string {
  const { hp, status } = args;
  return [
    '🟦 **You**',
    hpBar(hp.playerHP, hp.playerHPMax),
    `Status: ${statusBadges(status?.player)}`,
    '',
    '🟥 **Enemy**',
    hpBar(hp.enemyHP, hp.enemyHPMax),
    `Status: ${statusBadges(status?.enemy)}`,
  ].join('\n');
}

/** First screen of a battle with a single multi-select (max 3) + Lock/Run buttons. */
export function renderBattleScreen(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  hand: BattleHandRenderItem[];
  selectedIds: string[];
  status?: { player?: string; enemy?: string };
}) {
  const { battleId, enemy, hp, hand, selectedIds, status } = args;

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      '⚔️ **TURN CONSOLE**',
      combatStatusBlock({ hp, status }),
      '',
      chipQueueBlock(hand, selectedIds),
      hand.length ? '🎛️ **Choose up to 3 chips, then lock your turn.**' : '📁 Your hand is empty.',
    ].filter((line) => line !== undefined).join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder(`Select up to 3 chips (${selectedIds.length}/3)`)
    .setMinValues(0)
    .setMaxValues(Math.min(3, hand.length));

  const opts = hand.map((c) => {
    const text = optionText(c);
    return { ...text, value: c.id, default: selectedIds.includes(c.id) };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn').setEmoji('✅'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run').setEmoji('🏃'),
  );

  return { embed, components: [rowSel, rowBtns] as const };
}

/** Round result embed + NEW hand picker (single multi-select) with buttons. */
export function renderRoundResultWithNextHand(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  round: { playerLogLines: string[]; enemyLogLines: string[] };
  nextHand: BattleHandRenderItem[];
  selectedIds: string[];
  status?: { player?: string; enemy?: string };
}) {
  const { battleId, enemy, hp, round, nextHand, selectedIds, status } = args;

  const combinedLog = [
    ...round.playerLogLines.map(line => `🟦 ${line}`),
    ...round.enemyLogLines.map(line => `🟥 ${line}`),
  ];

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      '⚔️ **ROUND RESULT**',
      combatStatusBlock({ hp, status }),
      '',
      combinedLog.length ? `📜 **Combat Log**\n${combinedLog.join('\n')}` : '📜 **Combat Log**\n—',
      '',
      chipQueueBlock(nextHand, selectedIds),
      '🎛️ **Next hand:** pick up to 3 chips.',
    ].filter(Boolean).join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder(`Select up to 3 chips (${selectedIds.length}/3)`)
    .setMinValues(0)
    .setMaxValues(Math.min(3, nextHand.length));

  const opts = nextHand.map((c) => {
    const text = optionText(c);
    return { ...text, value: c.id, default: selectedIds.includes(c.id) };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn').setEmoji('✅'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run').setEmoji('🏃'),
  );

  return { embed, components: [rowSel, rowBtns] as const };
}

/** Final screen after victory/defeat; light wrapper so callers can update once. */
export function renderVictoryToHub(args: {
  enemy: EnemyRef;
  victory: { title: string; rewardLines: string[] };
}) {
  const { enemy, victory } = args;
  const art = getVirusArt(enemy.virusId);

  const icon = victory.title.toLowerCase().includes('victory') ? '🏆' : victory.title.toLowerCase().includes('defeat') ? '💀' : '🏁';
  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${victory.title} — ${enemy.displayName || enemy.virusId}`)
    .setDescription(victory.rewardLines.length ? victory.rewardLines.join('\n') : ' ')
    .setFooter({ text: 'Use /jack_in to continue.' });

  if (art.image) embed.setThumbnail(String(art.image));
  else if (art.sprite) embed.setThumbnail(String(art.sprite));

  return { embed, components: [] as const };
}
