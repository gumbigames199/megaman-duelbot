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
    .setTitle(opts.displayName || opts.virusId);

  if (art.image) e.setThumbnail(String(art.image));
  else if (art.sprite) e.setThumbnail(String(art.sprite));
  else e.setDescription(`${art.fallbackEmoji} ${opts.displayName || opts.virusId}`);

  return e;
}

/** First screen of a battle with a single multi-select (max 3) + Lock/Run buttons. */
export function renderBattleScreen(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  hand: Array<{ id: string; name: string; power?: number; hits?: number; element?: string; effects?: string; description?: string }>;
  selectedIds: string[];
}) {
  const { battleId, enemy, hp, hand } = args;

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      `**Your HP:** ${hp.playerHP}/${hp.playerHPMax}`,
      `**Enemy HP:** ${hp.enemyHP}/${hp.enemyHPMax}`,
      '',
      hand.length ? '**Choose up to 3 chips**' : '📁 Your hand is empty.',
    ].join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder('Select up to 3 chips…')
    .setMinValues(0)
    .setMaxValues(Math.min(3, hand.length));

  const opts = hand.map((c) => {
    const bits: string[] = [];
    if (c.element) bits.push(c.element);
    if (c.power)  bits.push(`P${c.power}${c.hits && c.hits > 1 ? `×${c.hits}` : ''}`);
    if (c.effects) bits.push(String(c.effects).replace(/\s+/g, ' ').trim());
    const description = bits.join(' • ').slice(0, 100);
    const label = `${c.name}${c.element ? ` [${c.element}]` : ''}`.slice(0, 100);
    return { label, description, value: c.id };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run'),
  );

  return { embed, components: [rowSel, rowBtns] as const };
}

/** Round result embed + NEW hand picker (single multi-select) with buttons. */
export function renderRoundResultWithNextHand(args: {
  battleId: string;
  enemy: EnemyRef;
  hp: { playerHP: number; playerHPMax: number; enemyHP: number; enemyHPMax: number };
  round: { playerLogLines: string[]; enemyLogLines: string[] };
  nextHand: Array<{ id: string; name: string; power?: number; hits?: number; element?: string; effects?: string; description?: string }>;
  selectedIds: string[];
}) {
  const { battleId, enemy, hp, round, nextHand } = args;

  const embed = buildBattleHeaderEmbed({ virusId: enemy.virusId, displayName: enemy.displayName }).setDescription(
    [
      `**Your HP:** ${hp.playerHP}/${hp.playerHPMax}`,
      `**Enemy HP:** ${hp.enemyHP}/${hp.enemyHPMax}`,
      '',
      round.playerLogLines.length ? '🟦 **Your turn**' : undefined,
      round.playerLogLines.join('\n'),
      round.enemyLogLines.length ? '\n🟥 **Enemy turn**' : undefined,
      round.enemyLogLines.join('\n'),
      '\n**Next hand:** pick up to 3',
    ].filter(Boolean).join('\n')
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder('Select up to 3 chips…')
    .setMinValues(0)
    .setMaxValues(Math.min(3, nextHand.length));

  const opts = nextHand.map((c) => {
    const bits: string[] = [];
    if (c.element) bits.push(c.element);
    if (c.power)  bits.push(`P${c.power}${c.hits && c.hits > 1 ? `×${c.hits}` : ''}`);
    if (c.effects) bits.push(String(c.effects).replace(/\s+/g, ' ').trim());
    const description = bits.join(' • ').slice(0, 100);
    const label = `${c.name}${c.element ? ` [${c.element}]` : ''}`.slice(0, 100);
    return { label, description, value: c.id };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run'),
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

  const embed = new EmbedBuilder()
    .setTitle(`${victory.title} — ${enemy.displayName || enemy.virusId}`)
    .setDescription(victory.rewardLines.length ? victory.rewardLines.join('\n') : ' ')
    .setFooter({ text: 'Use /jack_in to continue.' });

  if (art.image) embed.setThumbnail(String(art.image));
  else if (art.sprite) embed.setThumbnail(String(art.sprite));

  // No buttons here; index/jack_in will render the HUD next.
  return { embed, components: [] as const };
}
