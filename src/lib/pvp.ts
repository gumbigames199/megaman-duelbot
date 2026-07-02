// src/lib/pvp.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  User,
} from 'discord.js';

import {
  chipBaseId,
  chipCode,
  formatChipName,
  getChipById,
} from './data';
import { ensurePlayer, getPlayer, listFolder as listFolderQty } from './db';
import { resolveDamageRoll } from './damage';
import {
  type ParsedEffect,
  type StatusState,
  addAura,
  addBarrier,
  absorbDamage,
  applyStatusEffect,
  buffValue,
  canActFromStatus,
  parseEffects,
  statusSummary,
  tickEnd,
  tickStart,
  tryChance,
} from './effects';
import { validateLetterRule } from './rules';
import type { Element } from './types';

const ACCEPT_SECONDS = toInt(process.env.PVP_ACCEPT_SECONDS, 30);
const ROUND_SECONDS = toInt(process.env.PVP_ROUND_SECONDS, 30);

type ChipRef = { id: string };
type SideKey = 'p1' | 'p2';

type PvpPlayerState = {
  userId: string;
  username: string;
  avatarUrl: string;
  hp: number;
  hpMax: number;
  deck: ChipRef[];
  discard: ChipRef[];
  hand: ChipRef[];
  selected: string[];
  locked: boolean;
  missedTurns: number;
  status: StatusState;
  panelInteraction?: any;
};

type PvpChallenge = {
  id: string;
  challengerId: string;
  challengerName: string;
  targetId?: string;
  targetName?: string;
  channelId?: string;
  messageId?: string;
  timer?: NodeJS.Timeout;
  message?: any;
};

type PvpBattle = {
  id: string;
  challengeId: string;
  channelId?: string;
  messageId?: string;
  round: number;
  p1: PvpPlayerState;
  p2: PvpPlayerState;
  isOver: boolean;
  deadlineAt: number;
  timer?: NodeJS.Timeout;
  lastLog: string[];
  message?: any;
  client?: any;
  cleanupTimer?: NodeJS.Timeout;
};

const challenges = new Map<string, PvpChallenge>();
const battles = new Map<string, PvpBattle>();

export async function createPvpChallenge(ix: ChatInputCommandInteraction) {
  const target = ix.options.getUser('user', true);
  if (target.id === ix.user.id) {
    await ix.reply({ ephemeral: true, content: 'You cannot challenge yourself.' });
    return;
  }
  if (target.bot) {
    await ix.reply({ ephemeral: true, content: 'You cannot challenge a bot.' });
    return;
  }

  ensurePlayer(ix.user.id);
  ensurePlayer(target.id);

  const id = nextId('pc');
  const ch: PvpChallenge = {
    id,
    challengerId: ix.user.id,
    challengerName: ix.user.username,
    targetId: target.id,
    targetName: target.username,
    channelId: ix.channelId ?? undefined,
  };
  challenges.set(id, ch);

  ch.timer = setTimeout(() => expireChallenge(id).catch(console.error), ACCEPT_SECONDS * 1000);

  const embed = new EmbedBuilder()
    .setTitle('⚔️ PvP Challenge')
    .setDescription([
      `**${ix.user.username}.EXE** has challenged **${target.username}.EXE** to a NetBattle.`,
      '',
      `<@${target.id}> has **${ACCEPT_SECONDS} seconds** to accept.`,
    ].join('\n'))
    .setThumbnail(ix.user.displayAvatarURL())
    .setFooter({ text: 'PvP alpha: no rewards are granted.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pvp:accept:${id}`).setStyle(ButtonStyle.Success).setLabel('Accept Duel'),
    new ButtonBuilder().setCustomId(`pvp:decline:${id}`).setStyle(ButtonStyle.Secondary).setLabel('Decline'),
  );

  await ix.reply({ embeds: [embed], components: [row] });
  const msg = await ix.fetchReply();
  ch.messageId = msg.id;
  ch.message = msg;
}


export async function createOpenPvpChallenge(ix: ButtonInteraction) {
  ensurePlayer(ix.user.id);

  const id = nextId('pc');
  const ch: PvpChallenge = {
    id,
    challengerId: ix.user.id,
    challengerName: ix.user.username,
    channelId: ix.channelId ?? undefined,
  };
  challenges.set(id, ch);

  ch.timer = setTimeout(() => expireChallenge(id).catch(console.error), ACCEPT_SECONDS * 1000);

  const embed = new EmbedBuilder()
    .setTitle('⚔️ Open NetBattle Challenge')
    .setDescription([
      `**${ix.user.username}.EXE** is looking for a NetBattle.`,
      '',
      `Any other player has **${ACCEPT_SECONDS} seconds** to accept.`,
    ].join('\n'))
    .setThumbnail(ix.user.displayAvatarURL())
    .setFooter({ text: 'PvP alpha: no rewards are granted.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pvp:accept:${id}`).setStyle(ButtonStyle.Success).setLabel('Accept Duel'),
    new ButtonBuilder().setCustomId(`pvp:decline:${id}`).setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
  );

  const channel = ix.channel;
  if (!channel?.isTextBased?.()) {
    await ix.reply({ ephemeral: true, content: 'Cannot create a PvP challenge in this channel.' });
    return;
  }

  const msg = await (channel as any).send({ embeds: [embed], components: [row] });
  ch.messageId = msg.id;
  ch.message = msg;

  await ix.update({
    embeds: [new EmbedBuilder()
      .setTitle('⚔️ PvP Challenge Posted')
      .setDescription('Your open NetBattle challenge was posted in this channel.')
      .setImage(getSafeImageForOpenChallenge())],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('jackin:back').setStyle(ButtonStyle.Secondary).setLabel('Back')
    )],
  });
}

function getSafeImageForOpenChallenge(): string | null {
  return null;
}

export async function handlePvpButton(ix: ButtonInteraction) {
  const parts = ix.customId.split(':');
  const action = parts[1];
  const id = parts[2];
  if (!action || !id) return;

  if (action === 'accept') return acceptChallenge(ix, id);
  if (action === 'decline') return declineChallenge(ix, id);
  if (action === 'hand') return openHand(ix, id);
  if (action === 'refresh') return refreshCombat(ix, id);
  if (action === 'lock') return lockPlayer(ix, id);
  if (action === 'forfeit') return forfeitPlayer(ix, id);
  if (action === 'resolve') return manualResolveRound(ix, id);
}

export async function handlePvpSelect(ix: StringSelectMenuInteraction) {
  const parts = ix.customId.split(':');
  const battleId = parts[2];
  if (!battleId) return;

  const bs = battles.get(battleId);
  if (!bs || bs.isOver) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }

  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }

  const actor = bs[side];
  if (actor.locked) {
    await ix.reply({ ephemeral: true, content: 'You already locked this round.' });
    return;
  }

  const selected = resolveToIndexValues(actor, ix.values.slice(0, 3));
  const rows = selected.map(v => {
    const idx = Number(v);
    const chipId = actor.hand[idx]?.id ?? '';
    const chip: any = getChipById(chipId) || {};
    return {
      id: String(chip?.id || chipId),
      name: String(chip?.name || chipId),
      base_id: chipBaseId(chip || chipId),
      code: chipCode(chip || chipId),
      letters: chipCode(chip || chipId),
    };
  });

  if (!validateLetterRule(rows)) {
    await ix.reply({
      ephemeral: true,
      content: '❌ Invalid combo. Chips must share a code, share the same chip name, or include *.',
    });
    return;
  }

  actor.selected = selected;
  rememberPrivatePanel(bs, side, ix);
  const controls = buildPrivateCombatControls(bs, side);
  await ix.update({ embeds: [controls.embed], components: controls.components });
}

async function acceptChallenge(ix: ButtonInteraction, challengeId: string) {
  const ch = challenges.get(challengeId);
  if (!ch) {
    await ix.reply({ ephemeral: true, content: 'This challenge has expired.' });
    return;
  }
  if (ix.user.id === ch.challengerId) {
    await ix.reply({ ephemeral: true, content: 'You cannot accept your own duel.' });
    return;
  }
  if (ch.targetId && ix.user.id !== ch.targetId) {
    await ix.reply({ ephemeral: true, content: 'Only the challenged player can accept this duel.' });
    return;
  }

  clearTimer(ch.timer);
  challenges.delete(challengeId);

  const p1 = buildPvpPlayerState(ix.client.users.cache.get(ch.challengerId), ch.challengerId, ch.challengerName);
  const p2 = buildPvpPlayerState(ix.user, ix.user.id, ix.user.username);

  if (p1.deck.length === 0 || p2.deck.length === 0) {
    await ix.update({
      embeds: [new EmbedBuilder().setTitle('PvP Challenge Canceled').setDescription('Both players need chips in their folder before dueling.')],
      components: [],
    });
    return;
  }

  shuffle(p1.deck);
  shuffle(p2.deck);
  drawHand(p1);
  drawHand(p2);

  const battleId = nextId('pv');
  const bs: PvpBattle = {
    id: battleId,
    challengeId,
    channelId: ch.channelId,
    messageId: ix.message.id,
    round: 1,
    p1,
    p2,
    isOver: false,
    deadlineAt: Date.now() + ROUND_SECONDS * 1000,
    lastLog: [],
    message: ix.message,
    client: ix.client,
  };
  battles.set(battleId, bs);
  startRoundTimer(bs);

  await ix.update({ embeds: [renderPublicDuelStatusEmbed(bs)], components: publicBattleComponents(bs) });
  await ix.followUp({
    ephemeral: false,
    content: `<@${ch.challengerId}> <@${ch.targetId ?? ix.user.id}> Duel accepted. Use **Open Combat** to choose your chips privately. You have ${ROUND_SECONDS} seconds this round.`,
  });
}

async function declineChallenge(ix: ButtonInteraction, challengeId: string) {
  const ch = challenges.get(challengeId);
  if (!ch) {
    await ix.reply({ ephemeral: true, content: 'This challenge has expired.' });
    return;
  }
  if (ix.user.id !== ch.targetId && ix.user.id !== ch.challengerId) {
    await ix.reply({ ephemeral: true, content: 'Only the challenged player or challenger can decline this duel.' });
    return;
  }
  clearTimer(ch.timer);
  challenges.delete(challengeId);
  await ix.update({
    embeds: [new EmbedBuilder().setTitle('PvP Challenge Declined').setDescription(`The duel between <@${ch.challengerId}> and <@${ch.targetId ?? ix.user.id}> was declined.`)],
    components: [],
  });
}

async function openHand(ix: ButtonInteraction, battleId: string) {
  const bs = battles.get(battleId);
  if (!bs || bs.isOver) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }
  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }

  const view = buildPrivateCombatControls(bs, side);
  await ix.reply({ ephemeral: true, embeds: [view.embed], components: view.components });
  rememberPrivatePanel(bs, side, ix);
}

async function refreshCombat(ix: ButtonInteraction, battleId: string) {
  const bs = battles.get(battleId);
  if (!bs) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }
  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }

  rememberPrivatePanel(bs, side, ix);
  const view = buildPrivateCombatControls(bs, side);
  try {
    await ix.update({ embeds: [view.embed], components: view.components });
  } catch {
    await ix.reply({ ephemeral: true, embeds: [view.embed], components: view.components });
  }
}

async function lockPlayer(ix: ButtonInteraction, battleId: string) {
  const bs = battles.get(battleId);
  if (!bs || bs.isOver) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }
  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }

  rememberPrivatePanel(bs, side, ix);

  const actor = bs[side];
  actor.locked = true;

  if (bs.p1.locked && bs.p2.locked) {
    clearTimer(bs.timer);
    try {
      resolveRoundAndAdvance(bs);
      await broadcastPrivateCombatPanels(bs, side, ix);
      await announcePublicIfComplete(bs).catch(console.error);
      return;
    } catch (err: any) {
      console.error('resolveRoundAndAdvance error:', err);
      await ix.reply({ ephemeral: true, content: `PvP round failed to resolve: ${err?.message || String(err)}` });
      return;
    }
  }

  const view = buildPrivateCombatControls(bs, side);
  await ix.update({ embeds: [view.embed], components: view.components });
}



async function manualResolveRound(ix: ButtonInteraction, battleId: string) {
  const bs = battles.get(battleId);
  if (!bs || bs.isOver) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }
  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }
  if (!bs.p1.locked || !bs.p2.locked) {
    await ix.reply({ ephemeral: true, content: 'Both players need to lock first, or wait for the round timer to expire.' });
    return;
  }

  try {
    rememberPrivatePanel(bs, side, ix);
    clearTimer(bs.timer);
    resolveRoundAndAdvance(bs);
    await broadcastPrivateCombatPanels(bs, side, ix);
    await announcePublicIfComplete(bs).catch(console.error);
  } catch (err: any) {
    console.error('manualResolveRound error:', err);
    await ix.reply({ ephemeral: true, content: `PvP round failed to resolve: ${err?.message || String(err)}` });
  }
}


async function forfeitPlayer(ix: ButtonInteraction, battleId: string) {
  const bs = battles.get(battleId);
  if (!bs || bs.isOver) {
    await ix.reply({ ephemeral: true, content: 'This PvP battle is no longer active.' });
    return;
  }
  const side = sideForUser(bs, ix.user.id);
  if (!side) {
    await ix.reply({ ephemeral: true, content: 'This is not your duel.' });
    return;
  }
  const loser = bs[side];
  const winner = side === 'p1' ? bs.p2 : bs.p1;
  loser.hp = 0;
  bs.isOver = true;
  clearTimer(bs.timer);
  bs.lastLog = [`${loser.username}.EXE forfeited.`];
  scheduleBattleCleanup(bs);
  await announcePublicIfComplete(bs).catch(console.error);

  if (ix.message?.id === bs.messageId) {
    await ix.update({
      embeds: [new EmbedBuilder().setTitle('PvP Duel Ended').setDescription(bs.lastLog.join('\n'))],
      components: [],
    });
    return;
  }

  const view = buildPrivateCombatControls(bs, side);
  await ix.update({ embeds: [view.embed], components: view.components });
}

async function expireChallenge(challengeId: string) {
  const ch = challenges.get(challengeId);
  if (!ch) return;
  challenges.delete(challengeId);
  clearTimer(ch.timer);
  const embed = new EmbedBuilder()
    .setTitle('PvP Challenge Expired')
    .setDescription(ch.targetId ? `The duel challenge from <@${ch.challengerId}> to <@${ch.targetId}> expired.` : `The open duel challenge from <@${ch.challengerId}> expired.`);
  await ch.message?.edit?.({ embeds: [embed], components: [] }).catch(() => {});
}

function startRoundTimer(bs: PvpBattle) {
  clearTimer(bs.timer);
  bs.deadlineAt = Date.now() + ROUND_SECONDS * 1000;
  bs.timer = setTimeout(() => {
    try {
      resolveRoundAndAdvance(bs);
      broadcastPrivateCombatPanelsFromTimer(bs).catch(console.error);
      announcePublicIfComplete(bs).catch(console.error);
    } catch (err) {
      console.error('PvP timed round resolution failed:', err);
    }
  }, ROUND_SECONDS * 1000);
}

function resolveRoundAndAdvance(bs: PvpBattle) {
  if (bs.isOver) return;
  clearTimer(bs.timer);

  if (!bs.p1.locked) {
    bs.p1.selected = [];
    bs.p1.locked = true;
    bs.p1.missedTurns += 1;
  }
  if (!bs.p2.locked) {
    bs.p2.selected = [];
    bs.p2.locked = true;
    bs.p2.missedTurns += 1;
  }

  bs.lastLog = resolvePvpRound(bs);

  if (bs.p1.hp <= 0 || bs.p2.hp <= 0) {
    bs.isOver = true;
    scheduleBattleCleanup(bs);

    return;
  }

  prepareNextRound(bs);
  startRoundTimer(bs);
}


function resolvePvpRound(bs: PvpBattle): string[] {
  const log: string[] = [];

  applyStartTicks(bs.p1, log);
  applyStartTicks(bs.p2, log);
  if (bs.p1.hp <= 0 || bs.p2.hp <= 0) return log;

  const p1Spd = Number(getPlayer(bs.p1.userId)?.spd ?? 0);
  const p2Spd = Number(getPlayer(bs.p2.userId)?.spd ?? 0);
  const order: SideKey[] = p1Spd === p2Spd
    ? (Math.random() < 0.5 ? ['p1', 'p2'] : ['p2', 'p1'])
    : (p1Spd > p2Spd ? ['p1', 'p2'] : ['p2', 'p1']);

  for (const side of order) {
    const actor = bs[side];
    const defender = bs[side === 'p1' ? 'p2' : 'p1'];
    if (actor.hp <= 0 || defender.hp <= 0) continue;

    const canAct = canActFromStatus(actor.status, Math.random);
    if (!canAct.canAct) {
      log.push(`${actor.username}.EXE is ${canAct.reason} and could not act.`);
      continue;
    }

    if (!actor.selected.length) {
      log.push(`${actor.username}.EXE did not select chips.`);
      continue;
    }

    executeSelectedChips(actor, defender, log);
  }

  discardSelected(bs.p1);
  discardSelected(bs.p2);

  tickEnd(bs.p1.status);
  tickEnd(bs.p2.status);
  return log;
}

function executeSelectedChips(actor: PvpPlayerState, defender: PvpPlayerState, log: string[]) {
  const idxs = selectedIndices(actor);
  const planned = planAttackPlus(actor, idxs, log);

  for (const item of planned) {
    if (defender.hp <= 0) break;
    executeChip(actor, defender, item.chipId, log, item.powerBonus);
  }
}

function planAttackPlus(actor: PvpPlayerState, idxs: number[], log: string[]): Array<{ chipId: string; powerBonus: number }> {
  const planned: Array<{ chipId: string; powerBonus: number }> = [];
  let lastAttackIndex = -1;

  for (const idx of idxs) {
    const chipId = actor.hand[idx]?.id;
    const chip: any = chipId ? getChipById(chipId) : null;
    if (!chipId || !chip) continue;

    const effects = parseEffects(String(chip.effects ?? ''));
    const attackPlus = effects.reduce((sum, e) => sum + Number(e.attackPlus ?? 0), 0);
    const isAttack = !isSupportOnlyChip(chip, effects) && Number(chip.power ?? 0) > 0;

    if (attackPlus > 0 && !isAttack) {
      if (lastAttackIndex >= 0) {
        planned[lastAttackIndex].powerBonus += attackPlus;
        const target = getChipById(planned[lastAttackIndex].chipId);
        log.push(`${actor.username}.EXE attached **${formatChipName(chip)}** to **${formatChipName(target || planned[lastAttackIndex].chipId)}**.`);
      } else {
        log.push(`${actor.username}.EXE used **${formatChipName(chip)}**, but it had no prior attack chip to boost.`);
      }
      continue;
    }

    planned.push({ chipId, powerBonus: 0 });
    if (isAttack) lastAttackIndex = planned.length - 1;
  }

  return planned;
}

function executeChip(actor: PvpPlayerState, defender: PvpPlayerState, chipId: string, log: string[], powerBonus = 0) {
  const chip: any = getChipById(chipId);
  if (!chip) return;

  const chipName = formatChipName(chip);
  const effects = parseEffects(String(chip.effects ?? ''));

  for (const eff of effects) {
    if (eff.heal) {
      const before = actor.hp;
      actor.hp = Math.min(actor.hpMax, actor.hp + eff.heal.amount);
      log.push(`${actor.username}.EXE used **${chipName}** and healed **${actor.hp - before}** HP.`);
    }
    if (eff.barrier) {
      addBarrier(actor.status, eff.barrier.hp);
      log.push(`${actor.username}.EXE gained Barrier ${eff.barrier.hp}.`);
    }
    if (eff.aura) {
      addAura(actor.status, eff.aura.element, eff.aura.hp);
      log.push(`${actor.username}.EXE gained ${eff.aura.element} Aura.`);
    }
  }

  const basePower = Math.max(0, Number(chip.power ?? 0));
  const supportOnly = isSupportOnlyChip(chip, effects);
  if (!supportOnly && basePower + powerBonus > 0) {
    const aStats: any = getPlayer(actor.userId) || {};
    const dStats: any = getPlayer(defender.userId) || {};
    const element = toElement(chip.element);
    const roll = resolveDamageRoll({
      chip_pow: basePower + powerBonus,
      hits: Math.max(1, Number(chip.hits ?? 1)),
      navi_atk: Number(aStats.atk ?? 0) + buffValue(actor.status, 'atk'),
      target_def: Number(dStats.def ?? 0) + buffValue(defender.status, 'def'),
      chip_element: element,
      navi_element: toElement(aStats.element),
      def_element: toElement(dStats.element),
      acc: normalizeAcc(chip.acc, 0.95),
      navi_acc: Number(aStats.acc ?? 100) + buffValue(actor.status, 'acc'),
      target_evasion: Number(dStats.evasion ?? 0) + buffValue(defender.status, 'evasion'),
      crit_chance: (Number(aStats.crit ?? 0) + buffValue(actor.status, 'crit')) / 100,
      blind: actor.status.blind,
      rng: Math.random,
    });

    if (!roll.hit) {
      log.push(`${actor.username}.EXE used **${chipName}** but missed.`);
    } else {
      const absorbed = absorbDamage(defender.status, roll.total, element);
      defender.hp = Math.max(0, defender.hp - absorbed.damage);
      const boost = powerBonus > 0 ? ` +${powerBonus}` : '';
      const tags = [boost ? `boost${boost}` : '', roll.crit ? 'crit' : '', roll.multiplier > 1 ? 'super effective' : roll.multiplier < 1 ? 'resisted' : ''].filter(Boolean);
      log.push(`${actor.username}.EXE used **${chipName}** for **${absorbed.damage}** dmg${tags.length ? ` (${tags.join(', ')})` : ''}.`);
      for (const note of absorbed.notes) log.push(note);
    }
  }

  for (const eff of effects) applyOffensiveEffects(actor, chipName, eff, defender.status, log);
}

function applyOffensiveEffects(actor: PvpPlayerState, chipName: string, eff: ParsedEffect, target: StatusState, log: string[]) {
  const entries: Array<[
    'burn' | 'poison' | 'freeze' | 'paralyze' | 'blind',
    { chance: number; turns: number } | undefined,
    string,
  ]> = [
    ['burn', eff.burn, 'Burn'],
    ['poison', eff.poison, 'Poison'],
    ['freeze', eff.freeze, 'Freeze'],
    ['paralyze', eff.paralyze, 'Paralyze'],
    ['blind', eff.blind, 'Blind'],
  ];

  for (const [key, value, label] of entries) {
    if (!value) continue;
    if (tryChance(value.chance, Math.random)) {
      applyStatusEffect(target, key, value.turns);
      log.push(`${actor.username}.EXE's **${chipName}** applied ${label} (${value.turns}t).`);
    }
  }
}

function prepareNextRound(bs: PvpBattle) {
  bs.round += 1;
  for (const p of [bs.p1, bs.p2]) {
    p.selected = [];
    p.locked = false;
    drawHand(p);
  }
}

function buildPvpPlayerState(user: User | undefined, userId: string, fallbackName: string): PvpPlayerState {
  const p = ensurePlayer(userId);
  const hpMax = Math.max(1, Number(p.hp_max ?? 100));
  return {
    userId,
    username: user?.username || fallbackName || userId,
    avatarUrl: user?.displayAvatarURL() || '',
    hp: hpMax,
    hpMax,
    deck: buildDeckFromFolder(userId),
    discard: [],
    hand: [],
    selected: [],
    locked: false,
    missedTurns: 0,
    status: {},
  };
}

function buildDeckFromFolder(userId: string): ChipRef[] {
  const folder = listFolderQty(userId);
  const deck: ChipRef[] = [];
  for (const f of folder) {
    const chipId = String((f as any).chip_id);
    const qty = Math.max(0, toInt((f as any).qty, 0));
    if (!getChipById(chipId)) continue;
    for (let i = 0; i < qty; i++) deck.push({ id: chipId });
  }
  return deck;
}

function drawHand(p: PvpPlayerState) {
  p.discard.push(...p.hand);
  p.hand = [];
  if (p.deck.length < 5 && p.discard.length) {
    shuffle(p.discard);
    p.deck.push(...p.discard);
    p.discard = [];
  }
  while (p.hand.length < 5 && p.deck.length) p.hand.push(p.deck.shift()!);
}

function discardSelected(p: PvpPlayerState) {
  const idxs = selectedIndices(p);
  if (!idxs.length) return;
  const sel = new Set(idxs);
  p.discard.push(...idxs.map(i => p.hand[i]).filter(Boolean));
  p.hand = p.hand.filter((_, i) => !sel.has(i));
}

function renderPublicDuelStatusEmbed(bs: PvpBattle): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${bs.p1.username}.EXE  VS  ${bs.p2.username}.EXE`)
    .setDescription([
      '**Duel accepted.**',
      '',
      `**${bs.p1.username}.EXE** vs **${bs.p2.username}.EXE**`,
      '',
      'Use **Open Combat** to manage your private PvP combat panel.',
      'Combat results and next hands are shown privately to each duelist.',
    ].join('\n'))
    .setFooter({ text: 'PvP alpha: no rewards are granted.' });

  if (bs.p1.avatarUrl) embed.setThumbnail(bs.p1.avatarUrl);
  return embed;
}

function publicBattleComponents(bs: PvpBattle) {
  if (bs.isOver) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pvp:hand:${bs.id}`).setStyle(ButtonStyle.Primary).setLabel('Open Combat'),
      new ButtonBuilder().setCustomId(`pvp:forfeit:${bs.id}`).setStyle(ButtonStyle.Danger).setLabel('Forfeit'),
    ),
  ];
}


function hpBar(cur: number, max: number): string {
  const safeMax = Math.max(1, Math.floor(Number(max) || 1));
  const safeCur = Math.max(0, Math.floor(Number(cur) || 0));
  const ratio = Math.max(0, Math.min(1, safeCur / safeMax));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const block = ratio > 0.5 ? '🟩' : ratio > 0.25 ? '🟨' : '🟥';
  return `${block.repeat(filled)}${'⬛'.repeat(empty)} **${safeCur}/${safeMax} HP**`;
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

function chipRole(chip: any): string {
  const eff = String(chip?.effects || '').toLowerCase();
  if (eff.includes('heal')) return '❤️ Heal';
  if (eff.includes('barrier') || eff.includes('aura')) return '🛡️ Defense';
  if (eff.includes('atk+') || eff.includes('attack+')) return '🔧 Boost';
  if (Number(chip?.power || 0) > 0) return `💥 ${chip.power} PWR${Number(chip.hits ?? 1) > 1 ? ` ×${chip.hits}` : ''}`;
  return '⚙️ Support';
}

function queuedChipLines(p: PvpPlayerState): string[] {
  return p.selected.map((raw, i) => {
    const idx = Number(raw);
    const chipId = p.hand[idx]?.id;
    const chip: any = chipId ? getChipById(chipId) : null;
    return `${i + 1}️⃣ **${chip ? formatChipName(chip) : chipId || '?'}** — ${chipRole(chip)}`;
  });
}

function formatCombatLog(lines: string[]): string[] {
  return lines.map((line) => {
    let out = String(line || '').trim();
    if (!out) return out;
    if (/missed|could not act|did not select|forfeited/i.test(out)) return `⚠️ ${out}`;
    if (/healed|recover/i.test(out)) return `❤️ ${out}`;
    if (/barrier|aura/i.test(out)) return `🛡️ ${out}`;
    if (/burn|poison|freeze|paralyze|blind/i.test(out)) return `✨ ${out}`;
    if (/dmg|damage|used|attached/i.test(out)) return `💥 ${out}`;
    return `• ${out}`;
  }).filter(Boolean);
}

function buildPrivateCombatControls(bs: PvpBattle, side: SideKey): { embed: EmbedBuilder; components: any[] } {
  const actor = bs[side];
  const opponent = bs[side === 'p1' ? 'p2' : 'p1'];
  const timer = Math.max(0, Math.ceil((bs.deadlineAt - Date.now()) / 1000));
  const statusLine = bs.isOver
    ? '🏁 **BATTLE END**'
    : `⚔️ **ROUND ${bs.round}** • ${timer}s to lock`;

  const logBlock = bs.lastLog.length
    ? `📜 **Combat Log**\n${formatCombatLog(bs.lastLog).slice(-18).join('\n')}`
    : '📜 **Combat Log**\nNo combat has resolved yet.';

  const queueBlock = !bs.isOver && !actor.locked && actor.selected.length
    ? `\n\n⚡ **Chip Queue (${actor.selected.length}/3)**\n${queuedChipLines(actor).join('\n')}\n✅ Valid queue.`
    : '';

  const footerText = bs.isOver
    ? 'PvP duel complete.'
    : actor.locked
      ? 'Locked in. Waiting for opponent.'
      : 'Select up to 3 chips, then lock your turn.';

  const embed = new EmbedBuilder()
    .setTitle(`PvP Combat — ${actor.username}.EXE`)
    .setDescription([
      statusLine,
      '',
      `🟦 **${actor.username}.EXE**`,
      hpBar(actor.hp, actor.hpMax),
      `Status: ${statusBadges(statusSummary(actor.status))}`,
      `Lock: ${actor.locked ? '✅ Locked' : '⏳ Choosing'}`,
      '',
      '**VS**',
      '',
      `🟥 **${opponent.username}.EXE**`,
      hpBar(opponent.hp, opponent.hpMax),
      `Status: ${statusBadges(statusSummary(opponent.status))}`,
      `Lock: ${opponent.locked ? '✅ Locked' : '⏳ Choosing'}`,
      '',
      logBlock,
      queueBlock,
      bs.isOver ? `\n\n${finalResultBanner(bs)}` : '',
    ].filter(line => line !== '').join('\n'))
    .setFooter({ text: footerText });

  if (actor.avatarUrl) embed.setThumbnail(actor.avatarUrl);

  if (bs.isOver) return { embed, components: [] };

  const components: any[] = [];

  if (!actor.locked) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`pvp:pick:${bs.id}`)
      .setPlaceholder(`Select up to 3 chips (${actor.selected.length}/3)`)
      .setMinValues(0)
      .setMaxValues(Math.min(3, actor.hand.length));

    const options = actor.hand.map((c, idx) => {
      const chip: any = getChipById(c.id) || {};
      const bits: string[] = [];
      if (chip.element && String(chip.element).toLowerCase() !== 'neutral') bits.push(String(chip.element));
      if (Number(chip.power ?? 0) > 0) bits.push(`${chip.power} PWR${Number(chip.hits ?? 1) > 1 ? ` ×${chip.hits}` : ''}`);
      if (chip.effects) bits.push(String(chip.effects).replace(/\s+/g, ' ').trim());
      return {
        label: formatChipName(chip || c.id).slice(0, 100),
        description: bits.join(' • ').slice(0, 100) || undefined,
        value: String(idx),
        default: actor.selected.includes(String(idx)),
      };
    });
    if (options.length) select.addOptions(options);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  const buttons: ButtonBuilder[] = [];
  if (!actor.locked) {
    buttons.push(new ButtonBuilder().setCustomId(`pvp:lock:${bs.id}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn').setEmoji('✅'));
  }
  buttons.push(new ButtonBuilder().setCustomId(`pvp:refresh:${bs.id}`).setStyle(ButtonStyle.Secondary).setLabel('Refresh Combat').setEmoji('🔄'));
  buttons.push(new ButtonBuilder().setCustomId(`pvp:forfeit:${bs.id}`).setStyle(ButtonStyle.Danger).setLabel('Forfeit').setEmoji('🏳️'));
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

  return { embed, components };
}


function finalResultBanner(bs: PvpBattle): string {
  const winner = winnerForBattle(bs);
  if (winner) return `**WINNER: ${winner.username.toUpperCase()}.EXE**`;
  return '**DOUBLE DELETION — DRAW**';
}

function rememberPrivatePanel(bs: PvpBattle, side: SideKey, ix: any) {
  bs[side].panelInteraction = ix;
}

async function broadcastPrivateCombatPanels(bs: PvpBattle, triggerSide: SideKey, triggerIx: ButtonInteraction | StringSelectMenuInteraction) {
  for (const side of ['p1', 'p2'] as SideKey[]) {
    const view = buildPrivateCombatControls(bs, side);
    if (side === triggerSide) {
      try {
        await triggerIx.update({ embeds: [view.embed], components: view.components });
      } catch {
        try { await triggerIx.editReply({ embeds: [view.embed], components: view.components }); } catch {}
      }
      continue;
    }

    const panel = bs[side].panelInteraction;
    if (!panel) continue;
    try {
      await panel.editReply({ embeds: [view.embed], components: view.components });
    } catch (err) {
      console.error(`PvP private panel update failed for ${side}:`, err);
    }
  }
}


async function broadcastPrivateCombatPanelsFromTimer(bs: PvpBattle) {
  for (const side of ['p1', 'p2'] as SideKey[]) {
    const panel = bs[side].panelInteraction;
    if (!panel) continue;
    const view = buildPrivateCombatControls(bs, side);
    try {
      await panel.editReply({ embeds: [view.embed], components: view.components });
    } catch (err) {
      console.error(`PvP timed private panel update failed for ${side}:`, err);
    }
  }
}

async function announcePublicIfComplete(bs: PvpBattle) {
  if (!bs.isOver) return;

  const winner = winnerForBattle(bs);
  const summary = bs.lastLog.slice(-10).join('\n') || 'PvP duel complete.';
  const embed = new EmbedBuilder()
    .setTitle(winner ? `🏆 Winner: ${winner.username}.EXE` : '🏁 PvP Duel Complete — Draw')
    .setDescription([
      winner ? `**${winner.username}.EXE** wins the NetBattle.` : '**Double deletion.** The duel ends in a draw.',
      '',
      '**Final Combat Log**',
      summary,
    ].join('\n'))
    .setFooter({ text: 'PvP alpha: no rewards are granted.' });

  if (winner?.avatarUrl) embed.setThumbnail(winner.avatarUrl);

  try {
    if (bs.message?.reply) {
      await bs.message.reply({ embeds: [embed], components: [] });
      return;
    }
  } catch (err) {
    console.error('PvP public completion reply failed:', err);
  }

  try {
    if (bs.client && bs.channelId) {
      const channel = await bs.client.channels.fetch(bs.channelId);
      if (channel?.isTextBased?.()) await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('PvP public completion send failed:', err);
  }
}

function winnerForBattle(bs: PvpBattle): PvpPlayerState | null {
  if (bs.p1.hp > 0 && bs.p2.hp <= 0) return bs.p1;
  if (bs.p2.hp > 0 && bs.p1.hp <= 0) return bs.p2;

  return null;
}

function scheduleBattleCleanup(bs: PvpBattle) {
  if (bs.cleanupTimer) return;
  bs.cleanupTimer = setTimeout(() => battles.delete(bs.id), 10 * 60 * 1000);
}


async function updatePublicBattleMessage(_bs: PvpBattle, _ix?: ButtonInteraction) {
  // Phase 5.3 intentionally does not use the public message for combat progression.
  // PvP combat advances through each player's private ephemeral combat panel.
}

async function tryEditMessage(_message: any, _payload: any): Promise<boolean> {
  return false;
}


function applyStartTicks(p: PvpPlayerState, log: string[]) {
  const tick = tickStart(p.hp, p.hpMax, p.status);
  p.hp = tick.hp;
  if (tick.notes.length) log.push(`${p.username}.EXE took ${tick.notes.join(' + ')}.`);
}

function selectedIndices(p: PvpPlayerState): number[] {
  return resolveToIndexValues(p, p.selected).map(Number).filter(n => Number.isFinite(n));
}

function resolveToIndexValues(p: PvpPlayerState, chosen: string[]): string[] {
  const out: string[] = [];
  const used = new Set<number>();
  for (const raw of chosen.slice(0, 3)) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    if (/^\d+$/.test(v)) {
      const idx = Number(v);
      if (idx >= 0 && idx < p.hand.length && !used.has(idx)) {
        used.add(idx);
        out.push(String(idx));
        continue;
      }
    }
    const idx = p.hand.findIndex((c, i) => !used.has(i) && c.id === v);
    if (idx >= 0) {
      used.add(idx);
      out.push(String(idx));
    }
  }
  return out;
}

function isSupportOnlyChip(chip: any, effects: ParsedEffect[]): boolean {
  const category = String(chip?.category ?? '').toLowerCase();
  const power = Number(chip?.power ?? 0);
  if (power > 0) return false;
  if (category.includes('support') || category.includes('barrier') || category.includes('recovery')) return true;
  return effects.some(e => e.heal || e.barrier || e.aura || e.attackPlus) &&
    !effects.some(e => e.burn || e.poison || e.freeze || e.paralyze || e.blind);
}

function sideForUser(bs: PvpBattle, userId: string): SideKey | null {
  if (bs.p1.userId === userId) return 'p1';
  if (bs.p2.userId === userId) return 'p2';
  return null;
}

function toElement(x: unknown): Element {
  const s = String(x ?? '').toLowerCase();
  if (s === 'fire') return 'Fire';
  if (s === 'aqua' || s === 'water') return 'Aqua';
  if (s === 'elec' || s === 'electric') return 'Elec';
  if (s === 'wood' || s === 'grass') return 'Wood';
  return 'Neutral';
}

function normalizeAcc(v: any, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n > 1 ? n / 100 : n;
}

function nextId(prefix: string) {
  return `${prefix}${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

function toInt(v: any, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

function clearTimer(t?: NodeJS.Timeout) {
  if (t) clearTimeout(t);
}
