// src/lib/battle.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuInteraction,
} from "discord.js";

import { getBundle, getChipById, getVirusById, listChips, chipBaseId, chipCode, formatChipName } from "./data";
import {
  renderBattleScreen,
  renderRoundResultWithNextHand,
  renderVictoryToHub,
} from "./render";
import {
  ensurePlayer,
  getPlayer,
  listFolder as listFolderQty,
  markSeenVirus,
  addStyleProgress,
  getPendingStyleElement,
  getStyleProgress,
  STYLE_CHANGE_THRESHOLD,
} from "./db";
import { grantVirusRewards } from "./rewards";
import { validateLetterRule } from "./rules";
import { progressDefeat } from "./missions";
import { diffNewlyUnlockedRegions } from "./unlock";
import { detectPAResult } from "./pas";
import { resolveDamageRoll } from "./damage";
import {
  type StatusState,
  addAura,
  addBarrier,
  applyBuff,
  applyStatusEffect,
  absorbDamage,
  buffValue,
  canActFromStatus,
  parseEffects,
  statusSummary,
  tickEnd,
  tickStart,
  tryChance,
} from "./effects";
import type { Element } from "./types";

const DEFAULT_PLAYER_HP = 100;
const MAX_CHIPS_PER_TURN = Math.max(1, Math.min(5, Number(process.env.MAX_CHIPS_PER_TURN ?? 5) || 5));
const FOLDER_REFRESH_MIN_UNUSED = Math.max(1, Math.min(30, Number(process.env.FOLDER_REFRESH_MIN_UNUSED ?? MAX_CHIPS_PER_TURN) || MAX_CHIPS_PER_TURN));

type EnemyKind = "virus" | "boss";
type ChipRef = { id: string; uid: string };

type BattleEnemy = {
  uid: string;
  virus_id: string;
  enemy_kind: EnemyKind;
  hp: number;
  hp_max: number;
  status: StatusState;
};

type BattleHandItem = {
  id: string;
  name: string;
  power?: number;
  hits?: number;
  element?: string;
  effects?: string;
  description?: string;
};

type BattleReturnMode = "standalone" | "jackin";

type BattleState = {
  id: string;
  user_id: string;
  virus_id: string;
  enemy_kind: EnemyKind;
  region_id: string;
  enemies: BattleEnemy[];
  active_enemy_index: number;
  target_enemy_index: number;

  player_hp: number;
  player_hp_max: number;
  enemy_hp: number;
  enemy_hp_max: number;

  turn: number;
  full_deck: ChipRef[];
  deck: ChipRef[];
  discard: ChipRef[];
  hand: ChipRef[];
  selected: string[];
  used_pa_ids: string[];
  reflector_pool: number;
  reflector_prevented: number;
  is_over: boolean;
  return_mode: BattleReturnMode;

  player_status: StatusState;
  enemy_status: StatusState;
};

type BattleActor = "player" | "enemy";

type EnemyMove = {
  name: string;
  kind?: "attack" | "support" | string;
  element?: string;
  power?: number;
  hits?: number;
  acc?: number;
  weight?: number;
  barrier?: number;
  crit?: number;
  status?: { apply?: string; chance?: number; turns?: number };
  selfBuff?: Record<string, number>;
};

const battles = new Map<string, BattleState>();

export function startBattle(
  user_id: string,
  virus_id: string,
  enemy_kind: EnemyKind = "virus",
  opts: { returnMode?: BattleReturnMode; enemies?: Array<{ virus_id: string; enemy_kind?: EnemyKind }> } = {},
) {
  ensurePlayer(user_id);

  const player = getPlayer(user_id)!;
  const requestedEnemies = (opts.enemies && opts.enemies.length)
    ? opts.enemies
    : [{ virus_id, enemy_kind }];
  const enemies: BattleEnemy[] = requestedEnemies
    .map((e, i) => {
      const id = String(e.virus_id || '').trim();
      const virus = getVirusById(id) as any;
      if (!virus) return null;
      markSeenVirus(user_id, id);
      addStyleProgress(user_id, virus?.element, 1);
      const hpMax = Math.max(1, toInt(virus?.hp, 100));
      return {
        uid: `${id}:${i}`,
        virus_id: id,
        enemy_kind: e.enemy_kind || enemy_kind,
        hp: hpMax,
        hp_max: hpMax,
        status: {},
      } as BattleEnemy;
    })
    .filter((e): e is BattleEnemy => !!e);

  if (!enemies.length) throw new Error('No valid enemies for battle.');

  const virus = getVirusById(enemies[0].virus_id);
  const enemyHP = enemies[0].hp;

  const fullDeck = buildDeckFromFolder(user_id);
  if (fullDeck.length === 0) fullDeck.push(...fallbackDeck());
  const deck = cloneDeck(fullDeck);
  shuffle(deck);

  const id = nextBattleId();
  const hpMax = Math.max(1, toInt((player as any)?.hp_max, DEFAULT_PLAYER_HP));

  const bs: BattleState = {
    id,
    user_id,
    virus_id: enemies[0].virus_id,
    enemy_kind: enemies[0].enemy_kind,
    region_id: String(
      (player as any)?.region_id || (virus as any)?.region_id || "",
    ),
    enemies,
    active_enemy_index: 0,
    target_enemy_index: 0,
    player_hp: hpMax,
    player_hp_max: hpMax,
    enemy_hp: enemyHP,
    enemy_hp_max: enemyHP,
    turn: 1,
    full_deck: cloneDeck(fullDeck),
    deck,
    discard: [],
    hand: [],
    selected: [],
    used_pa_ids: [],
    reflector_pool: 0,
    reflector_prevented: 0,
    is_over: false,
    return_mode: opts.returnMode ?? "standalone",
    player_status: {},
    enemy_status: {},
  };

  drawHand(bs);
  battles.set(id, bs);

  const view = renderBattle(bs);
  return { ...view, battleId: id };
}

export async function handlePick(ix: StringSelectMenuInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== "pick") return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeRespond(ix, {
      content: "⚠️ This battle is no longer active.",
      components: [],
      embeds: [],
      ephemeral: true,
    });
    return;
  }
  if (bs.user_id !== ix.user.id) {
    await safeRespond(ix, {
      content: "This is not your battle.",
      ephemeral: true,
    });
    return;
  }

  const selected = resolveToIndexValues(bs, (ix.values ?? []).slice(0, MAX_CHIPS_PER_TURN));
  const chipRows = selected.map((idxText) => {
    const idx = Number(idxText);
    const chipId = bs.hand[idx]?.id ?? "";
    const chip: any = getChipById(chipId) || {};
    return {
      id: String(chip?.id || chipId),
      name: String(chip?.name || chipId),
      base_id: chipBaseId(chip),
      code: chipCode(chip),
      letters: chipCode(chip),
    };
  });

  if (!validateLetterRule(chipRows)) {
    await ix.reply({
      ephemeral: true,
      content:
        "❌ Invalid combo. Non-* chips must share one code or the same chip name.",
    });
    return;
  }

  bs.selected = selected;
  ensureValidTarget(bs);
  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleTarget(ix: StringSelectMenuInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== "target") return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeRespond(ix, {
      content: "⚠️ This battle is no longer active.",
      components: [],
      embeds: [],
      ephemeral: true,
    });
    return;
  }
  if (bs.user_id !== ix.user.id) {
    await safeRespond(ix, { content: "This is not your battle.", ephemeral: true });
    return;
  }

  const raw = String(ix.values?.[0] ?? "auto").trim();
  if (raw === "auto") {
    bs.target_enemy_index = firstLivingEnemyIndex(bs);
  } else {
    const idx = Number(raw);
    if (Number.isFinite(idx) && idx >= 0 && idx < bs.enemies.length && bs.enemies[idx]?.hp > 0) {
      bs.target_enemy_index = idx;
    } else {
      bs.target_enemy_index = firstLivingEnemyIndex(bs);
    }
  }
  ensureValidTarget(bs);

  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleLock(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== "lock") return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeRespond(ix, {
      content: "⚠️ This battle is no longer active.",
      components: [],
      embeds: [],
      ephemeral: true,
    });
    return;
  }
  if (bs.user_id !== ix.user.id) {
    await safeRespond(ix, {
      content: "This is not your battle.",
      ephemeral: true,
    });
    return;
  }

  const round = _resolveRoundInternal(bs);
  const won = allEnemiesDefeated(bs) && bs.player_hp > 0;

  if (bs.player_hp <= 0 || won) {
    bs.is_over = true;

    if (won) {
      const defeated = bs.enemies.slice();
      let totalZenny = 0;
      let totalXp = 0;
      let leveledUp = 0;
      const drops: string[] = [];
      const missionDone = new Set<string>();

      for (const enemy of defeated) {
        const rewards = grantVirusRewards(bs.user_id, enemy.virus_id);
        totalZenny += rewards.zenny_gained || 0;
        totalXp += rewards.xp_gained || 0;
        leveledUp += rewards.leveledUp || 0;
        for (const d of rewards.drops || []) drops.push(`${d.item_id} x${d.qty}`);
        for (const m of progressDefeat(bs.user_id, enemy.virus_id) || []) missionDone.add(m);
      }

      const hasBoss = defeated.some(e => e.enemy_kind === 'boss');
      const rewardTitle = hasBoss ? "Battle Rewards" : "Rewards";
      const rewardLines = [
        `${rewardTitle}: +${totalZenny}z${totalXp ? ` • +${totalXp} XP` : ""}`,
        drops.length ? `Drops: ${drops.map(d => `**${d}**`).join(", ")}` : "",
        leveledUp ? `🆙 Level Up x${leveledUp}` : "",
        missionDone.size ? `Mission completed: ${Array.from(missionDone).join(", ")}` : "",
      ].filter(Boolean);

      const newly = diffNewlyUnlockedRegions(bs.user_id);
      if (newly.length) {
        rewardLines.push(`🔓 New region${newly.length > 1 ? "s" : ""}: ${newly.join(", ")}`);
      }

      const victoryView = renderVictoryToHub({
        enemy: { virusId: bs.enemies[0]?.virus_id || bs.virus_id, displayName: enemySummaryTitle(bs) },
        victory: { title: "Victory!", rewardLines },
      });
      const view = endBattleView(bs, victoryView, {
        title: `Deleted ${enemySummaryTitle(bs)}`,
        lines: rewardLines,
      });

      await ix.update({ embeds: [view.embed], components: view.components });
      battles.delete(battleId);
      return;
    }

    const title = bs.player_hp <= 0 ? "☠️ Navi Deleted" : "Battle End";
    const lossView = renderVictoryToHub({
      enemy: { virusId: bs.enemies[0]?.virus_id || bs.virus_id, displayName: enemySummaryTitle(bs) },
      victory: { title, rewardLines: [] },
    });
    const view = endBattleView(bs, lossView, {
      title: `${title} vs ${enemySummaryTitle(bs)}`,
      lines: [],
    });

    await ix.update({ embeds: [view.embed], components: view.components });
    battles.delete(battleId);
    return;
  }

  drawHand(bs);
  const view = renderRoundResultWithNextHand({
    battleId,
    enemy: { virusId: bs.virus_id, displayName: enemySummaryTitle(bs) },
    enemies: enemyRenderItems(bs),
    hp: {
      playerHP: bs.player_hp,
      playerHPMax: bs.player_hp_max,
      enemyHP: bs.enemy_hp,
      enemyHPMax: bs.enemy_hp_max,
    },
    round,
    nextHand: toHandItems(bs.hand),
    selectedIds: [],
    targetEnemyIndex: bs.target_enemy_index,
    ...statusPayload(bs),
  });

  bs.selected = [];
  bs.turn += 1;

  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleRun(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== "run") return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeRespond(ix, {
      content: "⚠️ This battle is no longer active.",
      components: [],
      embeds: [],
      ephemeral: true,
    });
    return;
  }
  if (bs.user_id !== ix.user.id) {
    await safeRespond(ix, {
      content: "This is not your battle.",
      ephemeral: true,
    });
    return;
  }

  const escaped = randInt(1, 100) <= runChancePct(bs);
  if (escaped) {
    bs.is_over = true;
    const escapedView = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: { title: "Escaped", rewardLines: [] },
    });
    const view = endBattleView(bs, escapedView, {
      title: `Escaped from ${enemySummaryTitle(bs)}`,
      lines: [],
    });
    await ix.update({ embeds: [view.embed], components: view.components });
    battles.delete(battleId);
    return;
  }

  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}


function jackInTravelImage(): string | null {
  const raw = process.env.JACK_IN_GIF_URL || process.env.JACKIN_GIF_URL || null;
  const text = String(raw ?? '').trim();
  return text || null;
}

function jackInRegionImage(region: any): string | null {
  const raw =
    region?.gif_url ||
    region?.anim_url ||
    region?.animation_url ||
    region?.background_url ||
    region?.image_url ||
    region?.art_url ||
    null;
  const text = String(raw ?? '').trim();
  return text || null;
}

function renderJackInReturnView(bs: BattleState, result: { title: string; lines?: string[] }) {
  const player = getPlayer(bs.user_id) as any;
  const bundle: any = getBundle();
  const regionsArr = Object.values(bundle.regions || {}) as any[];
  const region = (bundle.regions || {})[player?.region_id] || regionsArr.find((r: any) => String(r?.id) === String(player?.region_id));
  const zone = Number((player as any)?.region_zone || 1);
  const regionName = region?.name || region?.label || player?.region_id || '—';
  const lastLines = [
    `**${result.title}**`,
    ...(result.lines || []),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle('✅ Jacked In')
    .setDescription([
      `Region: **${regionName}**, Zone: **${zone}**`,
      '',
      '📌 **Last Result**',
      lastLines.length ? lastLines.join('\n') : '—',
    ].join('\n'))
    .setFooter({ text: 'Encounter, Travel, Shop, Data, BBS, PET, or PvP from this same screen.' });

  const bg = jackInRegionImage(region) || jackInTravelImage();
  if (bg) embed.setImage(String(bg));

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('jackin:encounter').setStyle(ButtonStyle.Primary).setLabel('Encounter'),
    new ButtonBuilder().setCustomId('jackin:openTravel').setStyle(ButtonStyle.Secondary).setLabel('Travel'),
    new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Success).setLabel('Shop'),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('jackin:openData').setStyle(ButtonStyle.Secondary).setLabel('Data'),
    new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS'),
    new ButtonBuilder().setCustomId('jackin:openConfig').setStyle(ButtonStyle.Secondary).setLabel('PET'),
    new ButtonBuilder().setCustomId('jackin:openPvp').setStyle(ButtonStyle.Danger).setLabel('PvP'),
  );

  return { embed, components: [row1, row2] as any[] };
}

function endBattleView(bs: BattleState, standalone: { embed: any; components: readonly any[] }, jackin: { title: string; lines?: string[] }) {
  if (bs.return_mode !== 'jackin') return standalone;

  const pending = getPendingStyleElement(bs.user_id);
  if (pending) return renderStyleChangePromptView(bs, pending, jackin);

  return renderJackInReturnView(bs, jackin);
}

function renderStyleChangePromptView(
  bs: BattleState,
  element: "Fire" | "Aqua" | "Elec" | "Wood",
  result: { title: string; lines?: string[] },
) {
  const player = getPlayer(bs.user_id) as any;
  const progress = getStyleProgress(bs.user_id) as any;
  const points = Number(progress[`${String(element).toLowerCase()}_points`] ?? 0);

  const lines = [
    `${styleEmoji(element)} **${element} Style Change Available**`,
    '',
    `Your Navi has absorbed enough **${element}** battle data to change styles.`,
    `Current Style: **${String(player?.element || 'Neutral')}**`,
    `Progress: **${points}/${STYLE_CHANGE_THRESHOLD}**`,
    '',
    '**Last Result**',
    `**${result.title}**`,
    ...(result.lines || []),
    '',
    'Accepting changes your Navi element and resets Style Change progress.',
    'Keeping your current style clears this prompt and preserves your progress record.',
  ];

  const embed = new EmbedBuilder()
    .setTitle('🧬 Style Change')
    .setDescription(lines.filter(Boolean).join('\n'));

  const bundle: any = getBundle();
  const regionsArr = Object.values(bundle.regions || {}) as any[];
  const region = (bundle.regions || {})[player?.region_id] || regionsArr.find((r: any) => String(r?.id) === String(player?.region_id));
  const bg = jackInRegionImage(region) || jackInTravelImage();
  if (bg) embed.setImage(String(bg));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`jackin:styleAccept:${element}`).setStyle(ButtonStyle.Success).setLabel(`Accept ${element} Style`),
    new ButtonBuilder().setCustomId(`jackin:styleDecline:${element}`).setStyle(ButtonStyle.Secondary).setLabel('Keep Current Style'),
  );

  return { embed, components: [row] as any[] };
}

function styleEmoji(element: string): string {
  switch (String(element)) {
    case 'Fire': return '🔥';
    case 'Aqua': return '💧';
    case 'Elec': return '⚡';
    case 'Wood': return '🌿';
    default: return '🧬';
  }
}


function saveActiveEnemy(bs: BattleState) {
  const e = bs.enemies[bs.active_enemy_index];
  if (!e) return;
  e.virus_id = bs.virus_id;
  e.enemy_kind = bs.enemy_kind;
  e.hp = bs.enemy_hp;
  e.hp_max = bs.enemy_hp_max;
  e.status = bs.enemy_status;
}

function activateEnemy(bs: BattleState, idx: number) {
  const e = bs.enemies[idx];
  if (!e) return false;
  bs.active_enemy_index = idx;
  bs.virus_id = e.virus_id;
  bs.enemy_kind = e.enemy_kind;
  bs.enemy_hp = e.hp;
  bs.enemy_hp_max = e.hp_max;
  bs.enemy_status = e.status;
  return true;
}

function advanceToNextEnemy(bs: BattleState): boolean {
  saveActiveEnemy(bs);
  const idx = bs.enemies.findIndex(e => e.hp > 0);
  if (idx < 0) return false;
  if (!bs.enemies[bs.target_enemy_index] || bs.enemies[bs.target_enemy_index].hp <= 0) bs.target_enemy_index = idx;
  return activateEnemy(bs, idx);
}

function allEnemiesDefeated(bs: BattleState): boolean {
  saveActiveEnemy(bs);
  return bs.enemies.every(e => e.hp <= 0);
}

function livingEnemyIndexes(bs: BattleState): number[] {
  saveActiveEnemy(bs);
  const out: number[] = [];
  bs.enemies.forEach((e, i) => { if (e.hp > 0) out.push(i); });
  return out;
}

function firstLivingEnemyIndex(bs: BattleState): number {
  saveActiveEnemy(bs);
  const idx = bs.enemies.findIndex(e => e.hp > 0);
  return idx >= 0 ? idx : 0;
}

function ensureValidTarget(bs: BattleState) {
  saveActiveEnemy(bs);
  const cur = bs.enemies[bs.target_enemy_index];
  if (!cur || cur.hp <= 0) bs.target_enemy_index = firstLivingEnemyIndex(bs);
}

function enemySummaryTitle(bs: BattleState): string {
  saveActiveEnemy(bs);
  const names = bs.enemies.map(e => getVirusName(e.virus_id));
  const unique = Array.from(new Set(names));
  if (bs.enemies.length <= 1) return unique[0] || getVirusName(bs.virus_id);
  if (unique.length === 1) return `${unique[0]} x${bs.enemies.length}`;
  return unique.slice(0, 3).join(' + ') + (unique.length > 3 ? ` +${unique.length - 3}` : '');
}

function enemyRenderItems(bs: BattleState) {
  saveActiveEnemy(bs);
  return bs.enemies.map((e, i) => ({
    id: e.virus_id,
    name: getVirusName(e.virus_id),
    hp: e.hp,
    hpMax: e.hp_max,
    status: statusSummary(e.status),
    active: i === bs.active_enemy_index && e.hp > 0,
    targeted: i === bs.target_enemy_index && e.hp > 0,
    defeated: e.hp <= 0,
  }));
}

// ---------------- Compatibility API ----------------
export function startEncounterBattle(init: {
  user_id: string;
  enemy_kind: EnemyKind;
  enemy_id: string;
  region_id?: string;
  zone?: number;
}): { battleId: string; state: any } {
  const { battleId } = startBattle(
    init.user_id,
    init.enemy_id,
    init.enemy_kind,
  );
  const bs = battles.get(battleId)!;
  return { battleId, state: toCompatState(bs) };
}

export function load(battleId: string): any | null {
  const bs = battles.get(battleId);
  return bs ? toCompatState(bs) : null;
}

export function save(s: any): void {
  if (!s?.id) return;
  const bs = battles.get(s.id);
  if (!bs) return;
  const locked = Array.isArray(s.locked)
    ? s.locked.filter(Boolean).slice(0, MAX_CHIPS_PER_TURN)
    : [];
  bs.selected = resolveToIndexValues(bs, locked);
}

export function end(battleId: string): void {
  battles.delete(battleId);
}

export function tryRun(s: any): boolean {
  return Math.random() * 100 < runChancePctFromCompat(s);
}

export function resolveTurn(s: any, chosenIds: string[]) {
  if (!s?.id) throw new Error("battle state missing id");
  const bs = battles.get(s.id);
  if (!bs) throw new Error("battle not found");

  bs.selected = resolveToIndexValues(
    bs,
    (chosenIds ?? []).filter(Boolean).slice(0, MAX_CHIPS_PER_TURN),
  );
  const round = _resolveRoundInternal(bs);

  let outcome: "ongoing" | "victory" | "defeat" = "ongoing";
  if (allEnemiesDefeated(bs) && bs.player_hp > 0) outcome = "victory";
  else if (bs.player_hp <= 0) outcome = "defeat";

  if (outcome === "ongoing") {
    drawHand(bs);
    bs.selected = [];
    bs.turn += 1;
  }

  s.enemy_hp = bs.enemy_hp;
  s.enemies = bs.enemies.map(e => ({ virus_id: e.virus_id, hp: e.hp, hp_max: e.hp_max, enemy_kind: e.enemy_kind }));
  s.player_hp = bs.player_hp;
  s.hand = bs.hand.map((c) => c.id);
  s.locked = [];

  return {
    log: [...round.playerLogLines, ...round.enemyLogLines].join(" • ") || "—",
    enemy_hp: bs.enemy_hp,
    player_hp: bs.player_hp,
    outcome,
  };
}

// ---------------- Render helpers ----------------
function renderBattle(bs: BattleState) {
  const playerStatus = statusSummary(bs.player_status);
  const enemyStatus = statusSummary(bs.enemy_status);
  const activePA = activeProgramAdvance(bs);

  return renderBattleScreen({
    battleId: bs.id,
    enemy: { virusId: bs.virus_id, displayName: enemySummaryTitle(bs) },
    enemies: enemyRenderItems(bs),
    hp: {
      playerHP: bs.player_hp,
      playerHPMax: bs.player_hp_max,
      enemyHP: bs.enemy_hp,
      enemyHPMax: bs.enemy_hp_max,
    },
    hand: toHandItems(bs.hand),
    selectedIds: bs.selected.slice(),
    targetEnemyIndex: bs.target_enemy_index,
    ...(playerStatus || enemyStatus
      ? { status: { player: playerStatus, enemy: enemyStatus } }
      : {}),
    ...(activePA
      ? { programAdvance: { name: activePA.name, resultChipId: activePA.result_chip_id } }
      : {}),
  });
}

function activeProgramAdvance(bs: BattleState) {
  const ids = selectedIndices(bs)
    .map((i) => bs.hand[i]?.id)
    .filter(Boolean) as string[];
  const pa = detectPAResult(ids);
  if (!pa) return null;
  return bs.used_pa_ids.includes(pa.id) ? null : pa;
}

function toHandItems(hand: ChipRef[]): BattleHandItem[] {
  return hand.map((c, idx) => {
    const chip = getChipById(c.id) as any;
    const elem = toElement(chip?.element);

    return {
      id: String(idx),
      name: formatChipName(chip || c.id),
      power: asNum(chip?.power),
      hits: asNum(chip?.hits),
      element: elem !== "Neutral" ? elem : undefined,
      effects: chip?.effects,
      description: chip?.description,
    };
  });
}

function getVirusName(virus_id: string) {
  const v = getVirusById(virus_id);
  return v?.name ?? virus_id;
}

// ---------------- Deck / hand ----------------
function buildDeckFromFolder(user_id: string): ChipRef[] {
  const folder = listFolderQty(user_id);
  const deck: ChipRef[] = [];
  let seq = 0;
  for (const f of folder) {
    const chipId = String((f as any).chip_id);
    const qty = Math.max(0, toInt((f as any).qty, 0));
    if (!getChipById(chipId)) continue;
    for (let i = 0; i < qty; i++) deck.push({ id: chipId, uid: `${chipId}:${seq++}` });
  }
  return deck;
}

function fallbackDeck(): ChipRef[] {
  const id =
    resolveChipIdLoose("Cannon") ||
    resolveChipIdLoose("Guard") ||
    firstUsableChipId();
  return id ? Array.from({ length: 10 }, (_, i) => ({ id, uid: `fallback:${i}` })) : [];
}

function drawHand(bs: BattleState) {
  // Unselected chips remain unused and go back into the available cycle.
  if (bs.hand.length) {
    bs.deck.push(...bs.hand);
    bs.hand = [];
    shuffle(bs.deck);
  }

  // Once fewer than the configured minimum unused chip instances remain, refresh the entire folder.
  if (bs.deck.length < FOLDER_REFRESH_MIN_UNUSED) {
    refreshChipCycle(bs);
  }

  while (bs.hand.length < 5 && bs.deck.length > 0) {
    bs.hand.push(bs.deck.shift()!);
  }
}

function refreshChipCycle(bs: BattleState) {
  bs.deck = cloneDeck(bs.full_deck);
  bs.discard = [];
  bs.hand = [];
  shuffle(bs.deck);
}

function cloneDeck(deck: ChipRef[]): ChipRef[] {
  return deck.map(c => ({ id: c.id, uid: c.uid }));
}

// ---------------- Selection mapping ----------------
function resolveToIndexValues(bs: BattleState, chosen: string[]): string[] {
  const out: string[] = [];
  const used = new Set<number>();

  for (const raw of chosen.slice(0, MAX_CHIPS_PER_TURN)) {
    const v = String(raw ?? "").trim();
    if (!v) continue;

    if (/^\d+$/.test(v)) {
      const idx = Number(v);
      if (
        Number.isFinite(idx) &&
        idx >= 0 &&
        idx < bs.hand.length &&
        !used.has(idx)
      ) {
        used.add(idx);
        out.push(String(idx));
        continue;
      }
    }

    const idx = bs.hand.findIndex((c, i) => !used.has(i) && c.id === v);
    if (idx >= 0) {
      used.add(idx);
      out.push(String(idx));
    }
  }

  return out;
}

function selectedIndices(bs: BattleState): number[] {
  return resolveToIndexValues(bs, bs.selected)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

// ---------------- Combat resolution ----------------
function _resolveRoundInternal(bs: BattleState) {
  const playerLog: string[] = [];
  const enemyLog: string[] = [];

  bs.reflector_pool = 0;
  bs.reflector_prevented = 0;

  applyStartTicks(bs, playerLog, enemyLog);
  if (allEnemiesDefeated(bs)) {
    return {
      playerLogLines: playerLog,
      enemyLogLines: [...enemyLog, "Enemy deleted."],
    };
  }
  if (bs.player_hp <= 0) {
    return { playerLogLines: playerLog, enemyLogLines: enemyLog };
  }

  const playerFirst = playerActsFirst(bs);

  if (playerFirst) {
    resolvePlayerActionPhase(bs, playerLog);
    discardSelected(bs);

    if (allEnemiesDefeated(bs)) {
      enemyLog.push("Enemy deleted.");
      tickEndAllEnemyStatuses(bs);
      tickEnd(bs.player_status);
      return { playerLogLines: playerLog, enemyLogLines: enemyLog };
    }

    resolveAllEnemyActions(bs, enemyLog);
    applyReflectorDamage(bs, enemyLog);
  } else {
    enemyLog.push("Enemy moved first on SPD advantage.");
    resolveAllEnemyActions(bs, enemyLog);
    applyReflectorDamage(bs, enemyLog);

    if (bs.player_hp > 0) {
      resolvePlayerActionPhase(bs, playerLog);
    }
    discardSelected(bs);

    if (allEnemiesDefeated(bs)) enemyLog.push("Enemy deleted.");
  }

  if (bs.enemy_hp <= 0) advanceToNextEnemy(bs);
  expireTurnBarriers(bs, playerLog, enemyLog);

  tickEndAllEnemyStatuses(bs);
  tickEnd(bs.player_status);

  advanceToNextEnemy(bs);
  return { playerLogLines: playerLog, enemyLogLines: enemyLog };
}

function resolvePlayerActionPhase(bs: BattleState, playerLog: string[]) {
  const playerCanAct = canActFromStatus(bs.player_status, Math.random);
  if (!playerCanAct.canAct) {
    playerLog.push(`You are ${playerCanAct.reason} and could not act.`);
    return;
  }

  ensureValidTarget(bs);
  activateEnemy(bs, bs.target_enemy_index);
  resolvePlayerChips(bs, selectedIndices(bs), playerLog);
}

function applyStartTicks(
  bs: BattleState,
  playerLog: string[],
  enemyLog: string[],
) {
  saveActiveEnemy(bs);
  for (let i = 0; i < bs.enemies.length; i++) {
    const e = bs.enemies[i];
    if (!e || e.hp <= 0) continue;
    const tick = tickStart(e.hp, e.hp_max, e.status);
    e.hp = tick.hp;
    if (tick.notes.length) enemyLog.push(`${getVirusName(e.virus_id)} took ${tick.notes.join(" + ")}.`);
  }
  advanceToNextEnemy(bs);

  const playerTick = tickStart(
    bs.player_hp,
    bs.player_hp_max,
    bs.player_status,
  );
  bs.player_hp = playerTick.hp;
  if (playerTick.notes.length)
    playerLog.push(`You took ${playerTick.notes.join(" + ")}.`);
}

function tickEndAllEnemyStatuses(bs: BattleState) {
  saveActiveEnemy(bs);
  for (const e of bs.enemies) tickEnd(e.status);
  advanceToNextEnemy(bs);
}

function resolvePlayerChips(
  bs: BattleState,
  idxs: number[],
  playerLog: string[],
) {
  const selectedChipIds = idxs
    .map((i) => bs.hand[i]?.id)
    .filter(Boolean) as string[];
  const pa = detectPAResult(selectedChipIds);

  if (pa && !bs.used_pa_ids.includes(pa.id)) {
    bs.used_pa_ids.push(pa.id);
    playerLog.push(
      `Program Advance **${pa.name}** activated → **${pa.result_chip_id}**.`,
    );
    executeChip(bs, pa.result_chip_id, playerLog, {
      displayName: pa.name,
      forceAttackPlusReset: true,
    });
    if (bs.enemy_hp <= 0) {
      playerLog.push(`${getVirusName(bs.virus_id)} deleted.`);
      advanceToNextEnemy(bs);
    }
    return;
  }

  let pendingAttackPlus = 0;
  for (const idx of idxs) {
    if (allEnemiesDefeated(bs)) break;
    const chipId = bs.hand[idx]?.id;
    if (!chipId) continue;
    pendingAttackPlus = executeChip(bs, chipId, playerLog, {
      pendingAttackPlus,
    });
    if (bs.enemy_hp <= 0) {
      playerLog.push(`${getVirusName(bs.virus_id)} deleted.`);
      if (!advanceToNextEnemy(bs)) break;
    }
  }
}

function executeChip(
  bs: BattleState,
  chipId: string,
  playerLog: string[],
  opts: {
    pendingAttackPlus?: number;
    displayName?: string;
    forceAttackPlusReset?: boolean;
  } = {},
): number {
  const player = getPlayer(bs.user_id) as any;
  const virus = getVirusById(bs.virus_id) as any;
  const chip = getChipById(chipId) as any;

  if (!chip) {
    playerLog.push(`Used ${chipId} (unknown) — no effect.`);
    return opts.pendingAttackPlus ?? 0;
  }

  addStyleProgress(bs.user_id, chip.element, 1);

  const chipName = String(opts.displayName || formatChipName(chip) || chip.name || chipId);
  const effects = parseEffects(String(chip.effects ?? ""));
  const supportOnly = isSupportOnlyChip(chip, effects);
  let pendingAttackPlus = opts.pendingAttackPlus ?? 0;

  for (const eff of effects) {
    if (eff.attackPlus) {
      pendingAttackPlus += eff.attackPlus;
      playerLog.push(`**${chipName}** queued Attack+${eff.attackPlus}.`);
    }
    if (eff.heal) {
      const before = bs.player_hp;
      bs.player_hp = Math.min(bs.player_hp_max, bs.player_hp + eff.heal.amount);
      playerLog.push(`**${chipName}** healed **${bs.player_hp - before}** HP.`);
    }
    if (eff.barrier) {
      addBarrier(bs.player_status, eff.barrier.hp);
      if (isReflectorChip(chip)) {
        bs.reflector_pool += Math.max(0, Number(eff.barrier.hp) || 0);
        playerLog.push(`**${chipName}** armed a Reflector barrier (${eff.barrier.hp}).`);
      } else {
        playerLog.push(`**${chipName}** gave you Barrier ${eff.barrier.hp}.`);
      }
    }
    if (eff.aura) {
      addAura(bs.player_status, eff.aura.element, eff.aura.hp);
      playerLog.push(`**${chipName}** gave you ${eff.aura.element} Aura.`);
    }
  }

  const basePower = Math.max(0, asNum(chip.power, 0));
  if (!supportOnly && basePower + pendingAttackPlus > 0) {
    const element = toElement(chip.element);
    const roll = resolveDamageRoll({
      chip_pow: basePower + pendingAttackPlus,
      hits: Math.max(1, asNum(chip.hits, 1)),
      navi_atk: asNum(player?.atk, 0) + buffValue(bs.player_status, "atk"),
      target_def: asNum(virus?.def, 0) + buffValue(bs.enemy_status, "def"),
      chip_element: element,
      navi_element: toElement(player?.element),
      def_element: toElement(virus?.element),
      acc: normalizeAcc(chip.acc, 0.95),
      navi_acc: asNum(player?.acc, 100) + buffValue(bs.player_status, "acc"),
      target_evasion:
        asNum(virus?.evasion ?? virus?.eva, 0) +
        buffValue(bs.enemy_status, "evasion"),
      crit_chance:
        (asNum(player?.crit, 0) + buffValue(bs.player_status, "crit")) / 100,
      blind: bs.player_status.blind,
      rng: Math.random,
    });

    pendingAttackPlus = opts.forceAttackPlusReset ? 0 : 0;

    if (!roll.hit) {
      playerLog.push(`**${chipName}** missed.`);
    } else {
      const absorbed = absorbDamage(bs.enemy_status, roll.total, element);
      bs.enemy_hp = Math.max(0, bs.enemy_hp - absorbed.damage);
      const tags = [
        roll.crit ? "crit" : "",
        roll.multiplier > 1
          ? "super effective"
          : roll.multiplier < 1
            ? "resisted"
            : "",
      ].filter(Boolean);
      playerLog.push(
        `**${chipName}** dealt **${absorbed.damage}** dmg${tags.length ? ` (${tags.join(", ")})` : ""}.`,
      );
      for (const note of absorbed.notes) playerLog.push(note);
    }
  }

  for (const eff of effects)
    applyOffensiveEffects(chipName, eff, bs.enemy_status, playerLog);
  return pendingAttackPlus;
}

function isReflectorChip(chip: any): boolean {
  const base = String((chip as any)?.base_id || (chip as any)?.baseId || (chip as any)?.name || (chip as any)?.id || '').toLowerCase();
  return /^reflector[123]$/.test(base);
}

function trackReflectorPrevention(bs: BattleState, incoming: number, damageAfterBarrier: number) {
  const prevented = Math.max(0, Math.trunc((Number(incoming) || 0) - (Number(damageAfterBarrier) || 0)));
  if (prevented > 0) bs.reflector_prevented += prevented;
}

function applyReflectorDamage(bs: BattleState, enemyLog: string[]) {
  const reflected = Math.min(
    Math.max(0, Math.trunc(bs.reflector_pool || 0)),
    Math.max(0, Math.trunc(bs.reflector_prevented || 0)),
  );
  if (reflected <= 0) return;
  bs.enemy_hp = Math.max(0, bs.enemy_hp - reflected);
  enemyLog.push(`🪞 Reflector returned **${reflected}** dmg.`);
  bs.reflector_pool = 0;
  bs.reflector_prevented = 0;
}

function expireTurnBarriers(bs: BattleState, playerLog: string[], enemyLog: string[]) {
  if ((bs.player_status.barrier ?? 0) > 0) {
    delete bs.player_status.barrier;
    playerLog.push('Barrier expired.');
  }
  saveActiveEnemy(bs);
  let expired = 0;
  for (const e of bs.enemies) {
    if ((e.status.barrier ?? 0) > 0) {
      delete e.status.barrier;
      expired += 1;
    }
  }
  if (expired > 0) enemyLog.push(expired === 1 ? 'Enemy barrier expired.' : `${expired} enemy barriers expired.`);
  advanceToNextEnemy(bs);
}

function applyOffensiveEffects(
  chipName: string,
  eff: ReturnType<typeof parseEffects>[number],
  target: StatusState,
  log: string[],
) {
  const entries: Array<
    [
      "burn" | "poison" | "freeze" | "paralyze" | "blind",
      { chance: number; turns: number } | undefined,
      string,
    ]
  > = [
    ["burn", eff.burn, "Burn"],
    ["poison", eff.poison, "Poison"],
    ["freeze", eff.freeze, "Freeze"],
    ["paralyze", eff.paralyze, "Paralyze"],
    ["blind", eff.blind, "Blind"],
  ];

  for (const [key, value, label] of entries) {
    if (!value) continue;
    if (tryChance(value.chance, Math.random)) {
      applyStatusEffect(target, key, value.turns);
      log.push(`**${chipName}** applied ${label} (${value.turns}t).`);
    }
  }
}

function discardSelected(bs: BattleState) {
  const idxs = selectedIndices(bs);
  if (!idxs.length) return;
  const sel = new Set(idxs);
  bs.discard.push(...idxs.map((i) => bs.hand[i]).filter(Boolean));
  bs.hand = bs.hand.filter((_, i) => !sel.has(i));
}


function resolveAllEnemyActions(bs: BattleState, enemyLog: string[]) {
  const idxs = livingEnemyIndexes(bs);
  for (const idx of idxs) {
    if (bs.player_hp <= 0) break;
    activateEnemy(bs, idx);
    const enemyCanAct = canActFromStatus(bs.enemy_status, Math.random);
    if (!enemyCanAct.canAct) {
      enemyLog.push(`${getVirusName(bs.virus_id)} is ${enemyCanAct.reason} and could not act.`);
      saveActiveEnemy(bs);
      continue;
    }
    resolveEnemyAction(bs, enemyLog);
    saveActiveEnemy(bs);
  }
  advanceToNextEnemy(bs);
}

function resolveEnemyAction(bs: BattleState, enemyLog: string[]) {
  const virus = getVirusById(bs.virus_id) as any;
  const move = chooseEnemyMove(virus);
  if (!move) {
    resolveFallbackEnemyAttack(bs, enemyLog);
    return;
  }

  const name = String(move.name || "Attack");
  const kind = String(move.kind || "attack").toLowerCase();

  if (move.barrier && Number(move.barrier) > 0) {
    addBarrier(bs.enemy_status, Number(move.barrier));
    enemyLog.push(
      `${virus?.name ?? "Virus"} used **${name}** and gained Barrier ${Number(move.barrier)}.`,
    );
  }

  if (move.selfBuff && typeof move.selfBuff === "object") {
    applyBuff(bs.enemy_status, { ...move.selfBuff, turns: 3 });
    enemyLog.push(`${virus?.name ?? "Virus"} used **${name}** and powered up.`);
  }

  if (kind !== "attack" || Number(move.power ?? 0) <= 0) return;

  const player = getPlayer(bs.user_id) as any;
  const element = toElement(move.element);
  const roll = resolveDamageRoll({
    chip_pow: Math.max(0, asNum(move.power, asNum(virus?.atk, 10))),
    hits: Math.max(1, asNum(move.hits, 1)),
    navi_atk: asNum(virus?.atk, 0) + buffValue(bs.enemy_status, "atk"),
    target_def: asNum(player?.def, 0) + buffValue(bs.player_status, "def"),
    chip_element: element,
    navi_element: toElement(virus?.element),
    def_element: toElement(player?.element),
    acc: normalizeAcc(move.acc, normalizeAcc(virus?.acc, 0.9)),
    navi_acc: asNum(virus?.acc, 95) + buffValue(bs.enemy_status, "acc"),
    target_evasion:
      asNum(player?.evasion, 0) + buffValue(bs.player_status, "evasion"),
    crit_chance: normalizeCrit(move.crit ?? virus?.cr),
    blind: bs.enemy_status.blind,
    rng: Math.random,
  });

  if (!roll.hit) {
    enemyLog.push(`${virus?.name ?? "Virus"} used **${name}** but missed.`);
    return;
  }

  const absorbed = absorbDamage(bs.player_status, roll.total, element);
  trackReflectorPrevention(bs, roll.total, absorbed.damage);
  bs.player_hp = Math.max(0, bs.player_hp - absorbed.damage);
  const tags = [
    roll.crit ? "crit" : "",
    roll.multiplier > 1
      ? "super effective"
      : roll.multiplier < 1
        ? "resisted"
        : "",
  ].filter(Boolean);
  enemyLog.push(
    `${virus?.name ?? "Virus"} used **${name}** for **${absorbed.damage}** dmg${tags.length ? ` (${tags.join(", ")})` : ""}.`,
  );
  for (const note of absorbed.notes) enemyLog.push(note);

  if (
    move.status?.apply &&
    tryChance(Number(move.status.chance ?? 1), Math.random)
  ) {
    const key = normalizeStatusKey(move.status.apply);
    if (key) {
      const turns = Math.max(1, toInt(move.status.turns ?? 1, 1));
      applyStatusEffect(bs.player_status, key, turns);
      enemyLog.push(`${name} applied ${move.status.apply} (${turns}t).`);
    }
  }
}

function resolveFallbackEnemyAttack(bs: BattleState, enemyLog: string[]) {
  const virus = getVirusById(bs.virus_id) as any;
  const player = getPlayer(bs.user_id) as any;
  const element = toElement(virus?.element);

  const roll = resolveDamageRoll({
    chip_pow: Math.max(5, asNum(virus?.atk, randInt(5, 15))),
    hits: 1,
    navi_atk: asNum(virus?.atk, 0) + buffValue(bs.enemy_status, "atk"),
    target_def: asNum(player?.def, 0) + buffValue(bs.player_status, "def"),
    chip_element: element,
    navi_element: element,
    def_element: toElement(player?.element),
    acc: normalizeAcc(virus?.acc, 0.9),
    navi_acc: asNum(virus?.acc, 95) + buffValue(bs.enemy_status, "acc"),
    target_evasion:
      asNum(player?.evasion, 0) + buffValue(bs.player_status, "evasion"),
    crit_chance: normalizeCrit(virus?.cr),
    blind: bs.enemy_status.blind,
    rng: Math.random,
  });

  if (!roll.hit) {
    enemyLog.push(`${virus?.name ?? "Virus"} attacked but missed.`);
    return;
  }

  const absorbed = absorbDamage(bs.player_status, roll.total, element);
  trackReflectorPrevention(bs, roll.total, absorbed.damage);
  bs.player_hp = Math.max(0, bs.player_hp - absorbed.damage);
  enemyLog.push(
    `${virus?.name ?? "Virus"} hit you for **${absorbed.damage}** dmg${roll.crit ? " (crit)" : ""}.`,
  );
  for (const note of absorbed.notes) enemyLog.push(note);
}

function chooseEnemyMove(virus: any): EnemyMove | null {
  const moves = parseEnemyMoves(virus);
  if (!moves.length) return null;

  const totalWeight = moves.reduce(
    (sum, m) => sum + Math.max(1, asNum(m.weight, 1)),
    0,
  );
  let roll = Math.random() * totalWeight;
  for (const m of moves) {
    roll -= Math.max(1, asNum(m.weight, 1));
    if (roll <= 0) return m;
  }
  return moves[moves.length - 1] ?? null;
}

function parseEnemyMoves(virus: any): EnemyMove[] {
  const out: EnemyMove[] = [];
  for (const key of ["move_1json", "move_2json", "move_3json", "move_4json"]) {
    const raw = String(virus?.[key] ?? "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") out.push(parsed as EnemyMove);
    } catch {
      // Phase 2 tolerates malformed TSV move JSON and falls back to basic enemy attacks.
    }
  }
  return out;
}

function isSupportOnlyChip(
  chip: any,
  effects: ReturnType<typeof parseEffects>,
): boolean {
  if (isReflectorChip(chip)) return true;
  const category = String(chip?.category ?? "").toLowerCase();
  const power = asNum(chip?.power, 0);
  if (power > 0) return false;
  if (
    category.includes("support") ||
    category.includes("barrier") ||
    category.includes("recovery")
  )
    return true;
  return (
    effects.some((e) => e.heal || e.barrier || e.aura || e.attackPlus) &&
    !effects.some(
      (e) => e.burn || e.poison || e.freeze || e.paralyze || e.blind,
    )
  );
}

function normalizeStatusKey(
  x: any,
): "burn" | "poison" | "freeze" | "paralyze" | "blind" | null {
  const s = String(x ?? "")
    .trim()
    .toLowerCase();
  if (s === "burn") return "burn";
  if (s === "poison") return "poison";
  if (s === "freeze" || s === "frozen") return "freeze";
  if (s === "paralyze" || s === "paralysis") return "paralyze";
  if (s === "blind") return "blind";
  return null;
}

function statusPayload(bs: BattleState): {
  status?: { player?: string; enemy?: string };
} {
  const playerStatus = statusSummary(bs.player_status);
  const enemyStatus = statusSummary(bs.enemy_status);
  return playerStatus || enemyStatus
    ? { status: { player: playerStatus, enemy: enemyStatus } }
    : {};
}

// ---------------- Utils ----------------
function toElement(x: unknown): Element {
  const s = String(x ?? "").toLowerCase();
  switch (s) {
    case "fire":
      return "Fire";
    case "aqua":
    case "water":
      return "Aqua";
    case "elec":
    case "electric":
      return "Elec";
    case "wood":
    case "grass":
      return "Wood";
    case "neutral":
    default:
      return "Neutral";
  }
}

function parseCustom(customId: string): [string, string] {
  const [prefix, battleId] = customId.split(":", 2);
  return [prefix, battleId];
}

function asNum(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toInt(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function normalizeAcc(v: any, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n > 1 ? n / 100 : n;
}

function normalizeCrit(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.06;
  return n > 1
    ? Math.max(0, Math.min(1, n / 100))
    : Math.max(0, Math.min(1, n));
}

function playerSpeed(bs: BattleState): number {
  const player = getPlayer(bs.user_id) as any;
  return Math.max(0, asNum(player?.spd, 0) + buffValue(bs.player_status, "spd"));
}

function enemySpeed(enemy: BattleEnemy): number {
  const virus = getVirusById(enemy.virus_id) as any;
  return Math.max(0, asNum(virus?.spd, 0) + buffValue(enemy.status, "spd"));
}

function fastestLivingEnemySpeed(bs: BattleState): number {
  saveActiveEnemy(bs);
  return bs.enemies
    .filter(e => e.hp > 0)
    .reduce((max, e) => Math.max(max, enemySpeed(e)), 0);
}

function playerActsFirst(bs: BattleState): boolean {
  return playerSpeed(bs) >= fastestLivingEnemySpeed(bs);
}

function runChancePct(bs: BattleState): number {
  const diff = playerSpeed(bs) - fastestLivingEnemySpeed(bs);
  return Math.max(20, Math.min(85, Math.round(50 + diff)));
}

function runChancePctFromCompat(s: any): number {
  if (s?.id && battles.has(String(s.id))) return runChancePct(battles.get(String(s.id))!);

  const p = s?.user_id ? getPlayer(String(s.user_id)) as any : null;
  const playerSpd = asNum(p?.spd ?? s?.navi_spd, 0);
  const enemies = Array.isArray(s?.enemies) ? s.enemies : [{ virus_id: s?.enemy_id ?? s?.virus_id }];
  const enemySpd = enemies.reduce((max: number, e: any) => {
    const virus = getVirusById(String(e?.virus_id ?? e?.enemy_id ?? '')) as any;
    return Math.max(max, asNum(virus?.spd, 0));
  }, 0);

  return Math.max(20, Math.min(85, Math.round(50 + playerSpd - enemySpd)));
}

function nextBattleId() {
  const n = Math.floor(Date.now() / 1000);
  const r = randInt(1000, 9999);
  return `b${n}${r}`;
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

function randInt(a: number, b: number) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function safeRespond(ix: any, payload: any) {
  try {
    if (ix.replied || ix.deferred) await ix.followUp?.(payload);
    else if (ix.isButton?.() || ix.isStringSelectMenu?.())
      await ix.reply?.(payload);
    else await ix.reply?.(payload);
  } catch {
    try {
      await ix.update?.(payload);
    } catch {}
  }
}

function resolveChipIdLoose(token: string): string | null {
  const b = getBundle();
  if (b.chips[token]) return token;

  const low = token.toLowerCase();
  for (const c of listChips() as any[]) {
    if (String(c?.id ?? "").toLowerCase() === low) return String(c.id);
    if (String(c?.name ?? "").toLowerCase() === low) return String(c.id);
  }
  return null;
}

function firstUsableChipId(): string | null {
  for (const c of listChips() as any[]) {
    const id = String(c?.id ?? "").trim();
    if (id && Number(c?.is_upgrade ?? 0) !== 1) return id;
  }
  return null;
}

function lockedChipIds(bs: BattleState): string[] {
  const idxs = selectedIndices(bs);
  return idxs.map((i) => bs.hand[i]?.id).filter(Boolean) as string[];
}

function toCompatState(bs: BattleState) {
  const p = getPlayer(bs.user_id) as any;
  return {
    id: bs.id,
    user_id: bs.user_id,
    enemy_kind: bs.enemy_kind,
    region_id: bs.region_id,
    enemy_id: bs.virus_id,
    enemy_hp: bs.enemy_hp,
    enemies: bs.enemies.map(e => ({ virus_id: e.virus_id, hp: e.hp, hp_max: e.hp_max, enemy_kind: e.enemy_kind })),
    target_enemy_index: bs.target_enemy_index,
    player_element: (p?.element as any) || "Neutral",
    player_hp: bs.player_hp,
    player_hp_max: bs.player_hp_max,
    navi_atk: p?.atk ?? 10,
    navi_def: p?.def ?? 6,
    navi_spd: p?.spd ?? 0,
    navi_acc: p?.acc ?? 90,
    navi_eva: p?.evasion ?? 10,
    turn: bs.turn,
    seed: 0,
    draw_pile: bs.deck.map((c) => c.id),
    discard_pile: bs.discard.map((c) => c.id),
    hand: bs.hand.map((c) => c.id),
    locked: lockedChipIds(bs),
    player_status: bs.player_status,
    enemy_status: bs.enemy_status,
  };
}
