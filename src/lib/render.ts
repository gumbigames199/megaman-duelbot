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
  targets?: number;
  acc?: number;
  element?: string;
  effects?: string;
  description?: string;
};

type ProgramAdvanceRenderInfo = {
  name: string;
  resultChipId?: string;
};

type EnemyRenderItem = {
  id: string;
  name: string;
  hp: number;
  hpMax: number;
  status?: string;
  active?: boolean;
  targeted?: boolean;
  defeated?: boolean;
};

function petEmoji(): string {
  const full = String(process.env.PET_EMOJI || '').trim();
  if (full) return full;

  const id = String(process.env.PET_EMOJI_ID || '').trim();
  const name = String(process.env.PET_EMOJI_NAME || 'PET').trim() || 'PET';
  if (id) return `<:${name}:${id}>`;

  return ':PET:';
}

function hpBar(cur: number, max: number): string {
  const safeMax = Math.max(1, Math.floor(Number(max) || 1));
  const safeCur = Math.max(0, Math.floor(Number(cur) || 0));
  const ratio = Math.max(0, Math.min(1, safeCur / safeMax));
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  const empty = 10 - filled;
  const block = ratio > 0.5 ? '🟩' : ratio > 0.25 ? '🟨' : '🟥';
  return `${block.repeat(filled)}${'⬛'.repeat(empty)} ${safeCur}/${safeMax}`;
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

function targetsLabel(c: BattleHandRenderItem): string {
  const n = Math.max(1, Math.trunc(Number(c.targets || 1)));
  return n > 1 ? `${n} targets` : '1 target';
}

function accuracyLabel(c: BattleHandRenderItem): string | null {
  const raw = Number(c.acc);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const pct = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  return `${pct}% ACC`;
}

function chipRole(c: BattleHandRenderItem): string {
  const eff = String(c.effects || '').toLowerCase();
  const bits: string[] = [];

  if (eff.includes('atk+') || eff.includes('attack+')) bits.push('Boosts previous chip');
  if (Number(c.power || 0) > 0) bits.push(`${c.power} PWR${c.hits && c.hits > 1 ? ` ×${c.hits}` : ''}`);
  if (eff.includes('heal')) bits.push('Heal');
  if (eff.includes('barrier') || eff.includes('aura')) bits.push('Defense');
  if (c.element) bits.push(c.element);
  bits.push(targetsLabel(c));
  const acc = accuracyLabel(c);
  if (acc) bits.push(acc);
  if (c.effects) bits.push(String(c.effects).replace(/\s+/g, ' ').trim());

  return bits.length ? bits.join(' • ') : 'Support';
}

function selectedChipLines(hand: BattleHandRenderItem[], selectedIds: string[]): string[] {
  const selected = (selectedIds || [])
    .map((id) => hand.find((c) => c.id === id))
    .filter((c): c is BattleHandRenderItem => !!c);

  return selected.map((c, i) => `${i + 1}. **${c.name}** — ${chipRole(c)}`);
}

function chipQueueBlock(hand: BattleHandRenderItem[], selectedIds: string[]): string | undefined {
  const lines = selectedChipLines(hand, selectedIds);
  if (!lines.length) return undefined;
  return ['🎛️ **Selected Chips**', ...lines].join('\n');
}

function programAdvanceBlock(pa?: ProgramAdvanceRenderInfo): string | undefined {
  if (!pa) return undefined;
  return [
    `${petEmoji()} **PA ACTIVATE!**`,
    `Program Advance armed: **${pa.name}**`,
    'Lock Turn to unleash the sequence.',
  ].join('\n');
}

function optionText(c: BattleHandRenderItem): { label: string; description?: string } {
  const bits: string[] = [];
  if (c.element) bits.push(c.element);
  if (c.power) bits.push(`${c.power} PWR${c.hits && c.hits > 1 ? ` ×${c.hits}` : ''}`);
  bits.push(targetsLabel(c));
  const acc = accuracyLabel(c);
  if (acc) bits.push(acc);
  if (c.effects) bits.push(String(c.effects).replace(/\s+/g, ' ').trim());
  return {
    label: `${c.name}`.slice(0, 100),
    description: bits.join(' • ').slice(0, 100) || undefined,
  };
}

function buildTargetSelect(battleId: string, enemies?: EnemyRenderItem[], targetEnemyIndex?: number): StringSelectMenuBuilder | null {
  const living = (enemies || [])
    .map((e, idx) => ({ e, idx }))
    .filter(({ e }) => !e.defeated && Number(e.hp) > 0);
  if (living.length <= 1) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`target:${battleId}`)
    .setPlaceholder(`Target: Enemy ${(Number(targetEnemyIndex ?? living[0]?.idx ?? 0) + 1)}`)
    .setMinValues(1)
    .setMaxValues(1);

  select.addOptions(
    living.slice(0, 25).map(({ e, idx }) => ({
      label: `Enemy ${idx + 1}: ${e.name}`.slice(0, 100),
      description: `HP ${Math.max(0, Math.floor(Number(e.hp) || 0))}/${Math.max(1, Math.floor(Number(e.hpMax) || 1))}`.slice(0, 100),
      value: String(idx),
      default: idx === Number(targetEnemyIndex ?? living[0]?.idx ?? 0),
    })),
  );

  return select;
}

function enemyLine(e: EnemyRenderItem, originalIndex: number): string {
  const hp = Math.max(0, Math.floor(Number(e.hp) || 0));
  const hpMax = Math.max(1, Math.floor(Number(e.hpMax) || 1));
  const deleted = e.defeated || hp <= 0;
  const marker = e.targeted && !deleted ? '🎯' : `${originalIndex + 1}.`;
  const status = statusBadges(e.status);

  if (deleted) {
    return [
      `~~${originalIndex + 1}. ${e.name} — DELETED~~`,
      `~~${hpBar(0, hpMax)}~~`,
    ].join('\n');
  }

  return [
    `${marker} **${originalIndex + 1}. ${e.name}**`,
    hpBar(hp, hpMax),
    status !== '—' ? `Status: ${status}` : '',
  ].filter(Boolean).join('\n');
}

function enemiesStatusBlock(enemies?: EnemyRenderItem[], fallback?: { hp: { enemyHP: number; enemyHPMax: number }; status?: string }): string {
  if (enemies && enemies.length) {
    return ['🟥 **Enemies**', ...enemies.map((e, idx) => enemyLine(e, idx))].join('\n');
  }
  if (fallback) {
    const status = statusBadges(fallback.status);
    return ['🟥 **Enemy**', hpBar(fallback.hp.enemyHP, fallback.hp.enemyHPMax), status !== '—' ? `Status: ${status}` : ''].filter(Boolean).join('\n');
  }
  return '🟥 **Enemy**\n—';
}

function combatStatusBlock(args: {
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  status?: { player?: string; enemy?: string };
  enemies?: EnemyRenderItem[];
  turn?: number;
}): string {
  const { hp, status, enemies, turn } = args;
  const playerStatus = statusBadges(status?.player);
  return [
    turn ? `**Turn ${turn}**` : '',
    '🟦 **You**',
    hpBar(hp.playerHP, hp.playerHPMax),
    playerStatus !== '—' ? `Status: ${playerStatus}` : '',
    '',
    enemiesStatusBlock(enemies, { hp: { enemyHP: hp.enemyHP, enemyHPMax: hp.enemyHPMax }, status: status?.enemy }),
  ].filter(line => line !== '').join('\n');
}

function logBlock(title: string, lines: string[]): string {
  if (!lines.length) return `${title}\n—`;
  return `${title}\n${lines.map(line => `• ${line}`).join('\n')}`;
}

/** First screen of a battle with chip multi-select, target select, and Lock/Run buttons. */
export function renderBattleScreen(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  hand: BattleHandRenderItem[];
  selectedIds: string[];
  status?: { player?: string; enemy?: string };
  enemies?: EnemyRenderItem[];
  programAdvance?: ProgramAdvanceRenderInfo;
  targetEnemyIndex?: number;
  turn?: number;
}) {
  const { battleId, enemy, hp, hand, selectedIds, status, enemies, programAdvance, targetEnemyIndex, turn } = args;

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      '⚔️ **TURN CONSOLE**',
      combatStatusBlock({ hp, status, enemies, turn }),
      '',
      chipQueueBlock(hand, selectedIds),
      programAdvanceBlock(programAdvance),
      hand.length ? 'Choose chips, choose a target, then lock your turn.' : 'Your hand is empty.',
    ].filter((line) => line !== undefined).join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder(`Select up to 5 chips (${selectedIds.length}/5)`)
    .setMinValues(0)
    .setMaxValues(Math.min(5, hand.length));

  const opts = hand.map((c) => {
    const text = optionText(c);
    return { ...text, value: c.id, default: selectedIds.includes(c.id) };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const targetSelect = buildTargetSelect(battleId, enemies, targetEnemyIndex);
  const rowTarget = targetSelect ? new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(targetSelect) : null;
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn').setEmoji('✅'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run').setEmoji('🏃'),
  );

  return { embed, components: [rowSel, ...(rowTarget ? [rowTarget] : []), rowBtns] as const };
}

/** Round result embed + next hand picker. */
export function renderRoundResultWithNextHand(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  round: { playerLogLines: string[]; enemyLogLines: string[] };
  nextHand: BattleHandRenderItem[];
  selectedIds: string[];
  status?: { player?: string; enemy?: string };
  enemies?: EnemyRenderItem[];
  programAdvance?: ProgramAdvanceRenderInfo;
  targetEnemyIndex?: number;
  turn?: number;
}) {
  const { battleId, enemy, hp, round, nextHand, selectedIds, status, enemies, programAdvance, targetEnemyIndex, turn } = args;

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      '⚔️ **ROUND RESULT**',
      combatStatusBlock({ hp, status, enemies, turn }),
      '',
      logBlock('📜 **Your Actions**', round.playerLogLines || []),
      '',
      logBlock('📜 **Enemy Actions**', round.enemyLogLines || []),
      '',
      chipQueueBlock(nextHand, selectedIds),
      programAdvanceBlock(programAdvance),
      'Next hand: pick up to 5 chips and choose a target.',
    ].filter(Boolean).join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder(`Select up to 5 chips (${selectedIds.length}/5)`)
    .setMinValues(0)
    .setMaxValues(Math.min(5, nextHand.length));

  const opts = nextHand.map((c) => {
    const text = optionText(c);
    return { ...text, value: c.id, default: selectedIds.includes(c.id) };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const targetSelect = buildTargetSelect(battleId, enemies, targetEnemyIndex);
  const rowTarget = targetSelect ? new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(targetSelect) : null;
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn').setEmoji('✅'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run').setEmoji('🏃'),
  );

  return { embed, components: [rowSel, ...(rowTarget ? [rowTarget] : []), rowBtns] as const };
}

/** Final screen after victory/defeat; light wrapper so callers can update once. */
export function renderVictoryToHub(args: {
  enemy: EnemyRef;
  victory: { title: string; rewardLines: string[] };
}) {
  const { enemy, victory } = args;
  const icon = victory.title.toLowerCase().includes('victory') ? '🏆' : victory.title.toLowerCase().includes('defeat') ? '💀' : '🏁';
  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${victory.title} — ${enemy.displayName || enemy.virusId}`)
    .setDescription(victory.rewardLines.length ? victory.rewardLines.join('\n') : ' ')
    .setFooter({ text: 'Use /jack_in to continue.' });

  return { embed, components: [] as const };
}
