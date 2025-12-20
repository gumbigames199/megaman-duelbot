// src/lib/battle.ts
import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';

import { getChipById, getVirusById } from './data';
import {
  renderBattleScreen,
  renderRoundResultWithNextHand,
  renderVictoryToHub,
} from './render';
import { ensurePlayer, getPlayer, listFolder as listFolderQty } from './db';
import { grantVirusRewards } from './rewards';
import { typeMultiplier } from './rules';
import type { Element } from './types';

const DEFAULT_PLAYER_HP = 100;

type ChipRef = { id: string };

type BattleHandItem = {
  id: string; // IMPORTANT: unique option value (we use hand index as string)
  name: string; // we inject letters into this
  power?: number;
  hits?: number;
  element?: string; // only set if NOT Neutral (so UI never shows [Neutral])
  effects?: string;
  description?: string;
};

type DotStatus = { dur: number }; // duration remaining (turns)
type BattleStatuses = {
  burn?: DotStatus;   // 5% Max HP each turn start
  poison?: DotStatus; // 8% Max HP each turn start
};

type BattleState = {
  id: string;
  user_id: string;
  virus_id: string;

  player_hp: number;
  player_hp_max: number;
  enemy_hp: number;
  enemy_hp_max: number;

  turn: number;

  deck: ChipRef[];
  discard: ChipRef[];
  hand: ChipRef[];

  /**
   * Selected values from the UI.
   * These are usually hand indices ("0","1","2"...), but we also tolerate chip ids
   * for backwards compatibility (resolveTurn/index.ts).
   */
  selected: string[];

  is_over: boolean;

  player_status: BattleStatuses;
  enemy_status: BattleStatuses;
};

// ---- Element normalizer (string → Element union) ----
function toElement(x: unknown): Element {
  const s = String(x ?? '').toLowerCase();
  switch (s) {
    case 'fire': return 'Fire';
    case 'aqua':
    case 'water': return 'Aqua';
    case 'elec':
    case 'electric': return 'Elec';
    case 'wood':
    case 'grass': return 'Wood';
    case 'neutral':
    default: return 'Neutral';
  }
}

// ---------------- In-memory store ----------------
const battles = new Map<string, BattleState>();
function nextBattleId() {
  const n = Math.floor(Date.now() / 1000);
  const r = randInt(1000, 9999);
  return `b${n}${r}`;
}

// ---------------- Public (new UI) ----------------
export function startBattle(user_id: string, virus_id: string) {
  ensurePlayer(user_id);
  const player = getPlayer(user_id)!;
  const virus = getVirusById(virus_id);
  const enemyHP = Math.max(1, toInt((virus as any)?.hp, 100));

  const deck = buildDeckFromFolder(user_id);
  if (deck.length === 0) deck.push(...fallbackDeck());

  shuffle(deck);

  const id = nextBattleId();
  const hpMax = Math.max(1, toInt((player as any)?.hp_max, DEFAULT_PLAYER_HP));

  const bs: BattleState = {
    id,
    user_id,
    virus_id,
    player_hp: hpMax,
    player_hp_max: hpMax,
    enemy_hp: enemyHP,
    enemy_hp_max: enemyHP,
    turn: 1,
    deck,
    discard: [],
    hand: [],
    selected: [],
    is_over: false,
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
  if (prefix !== 'pick') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
  }

  // Values are hand indices ("0","1"...). This allows duplicate chips safely.
  bs.selected = (ix.values ?? []).slice(0, 3);

  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleLock(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'lock') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
  }

  const round = _resolveRoundInternal(bs);

  if (bs.player_hp <= 0 || bs.enemy_hp <= 0) {
    bs.is_over = true;

    if (bs.enemy_hp <= 0 && bs.player_hp > 0) {
      const rewards = grantVirusRewards(bs.user_id, bs.virus_id);
      const rewardLines = [
        rewards.zenny_gained ? `+${rewards.zenny_gained}z` : '',
        rewards.xp_gained ? `+${rewards.xp_gained} XP` : '',
        rewards.drops.length
          ? `Drops: ${rewards.drops.map((d) => `**${d.item_id}** x${d.qty}`).join(', ')}`
          : '',
      ].filter(Boolean);

      const victoryView = renderVictoryToHub({
        enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
        victory: { title: 'Victory!', rewardLines },
      });

      await ix.update({ embeds: [victoryView.embed], components: victoryView.components });
      battles.delete(battleId);
      return;
    }

    const lossView = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: { title: bs.player_hp <= 0 ? 'Defeat…' : 'Battle End', rewardLines: [] },
    });

    await ix.update({ embeds: [lossView.embed], components: lossView.components });
    battles.delete(battleId);
    return;
  }

  // New hand
  drawHand(bs);
  const nextHand = toHandItems(bs.hand);

  const hpBlock = {
    playerHP: bs.player_hp,
    playerHPMax: bs.player_hp_max,
    enemyHP: bs.enemy_hp,
    enemyHPMax: bs.enemy_hp_max,
  };

  const view = renderRoundResultWithNextHand({
    battleId,
    enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
    hp: hpBlock,
    round,
    nextHand,
    selectedIds: [],
  });

  bs.selected = [];
  bs.turn += 1;

  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleRun(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'run') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
  }

  const escaped = randInt(1, 100) <= 50;
  if (escaped) {
    bs.is_over = true;
    const view = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: { title: 'Escaped', rewardLines: [] },
    });
    await ix.update({ embeds: [view.embed], components: view.components });
    battles.delete(battleId);
    return;
  }

  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

// ---------------- Compatibility API (for index.ts & older flows) ----------------

export function startEncounterBattle(init: {
  user_id: string;
  enemy_kind: 'virus' | 'boss';
  enemy_id: string;
  region_id?: string;
  zone?: number;
}): { battleId: string; state: any } {
  const { battleId } = startBattle(init.user_id, init.enemy_id);
  const bs = battles.get(battleId)!;
  return { battleId, state: toCompatState(bs, init.enemy_kind) };
}

export function load(battleId: string): any | null {
  const bs = battles.get(battleId);
  return bs ? toCompatState(bs, 'virus') : null;
}

export function save(s: any): void {
  if (!s?.id) return;
  const bs = battles.get(s.id);
  if (!bs) return;

  const locked = Array.isArray(s.locked) ? s.locked.filter(Boolean).slice(0, 3) : [];
  // Convert chip ids (legacy) to indices where possible
  bs.selected = resolveToIndexValues(bs, locked);
}

export function end(battleId: string): void {
  battles.delete(battleId);
}

/** 50% run success. (index.ts expects this export) */
export function tryRun(_s: any): boolean {
  return Math.random() < 0.5;
}

/**
 * index.ts expects this export:
 * resolveTurn(state, chosenIds) -> { log, enemy_hp, player_hp, outcome }
 *
 * chosenIds may be chip ids (legacy) OR index values (new UI).
 */
export function resolveTurn(s: any, chosenIds: string[]) {
  if (!s?.id) throw new Error('battle state missing id');
  const bs = battles.get(s.id);
  if (!bs) throw new Error('battle not found');

  // Normalize selection into index-values
  bs.selected = resolveToIndexValues(bs, (chosenIds ?? []).filter(Boolean).slice(0, 3));

  const round = _resolveRoundInternal(bs);

  let outcome: 'ongoing' | 'victory' | 'defeat' = 'ongoing';
  if (bs.enemy_hp <= 0 && bs.player_hp > 0) outcome = 'victory';
  else if (bs.player_hp <= 0) outcome = 'defeat';

  if (outcome === 'ongoing') {
    drawHand(bs);
    bs.selected = [];
    bs.turn += 1;
  }

  s.enemy_hp = bs.enemy_hp;
  s.player_hp = bs.player_hp;
  s.hand = bs.hand.map((c: ChipRef) => c.id);
  s.locked = [];

  return {
    log: [...round.playerLogLines, ...round.enemyLogLines].join(' • ') || '—',
    enemy_hp: bs.enemy_hp,
    player_hp: bs.player_hp,
    outcome,
  };
}

// ---------------- Render helpers ----------------
function renderBattle(bs: BattleState) {
  const hp = {
    playerHP: bs.player_hp,
    playerHPMax: bs.player_hp_max,
    enemyHP: bs.enemy_hp,
    enemyHPMax: bs.enemy_hp_max,
  };
  const handItems = toHandItems(bs.hand);

  return renderBattleScreen({
    battleId: bs.id,
    enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
    hp,
    hand: handItems,
    selectedIds: bs.selected.slice(),
  });
}

/**
 * IMPORTANT: make each option value unique by using the HAND INDEX.
 * Also: Inject letters into name, and suppress Neutral element for UI.
 */
function toHandItems(hand: ChipRef[]): BattleHandItem[] {
  return hand.map((c, idx) => {
    const chip = getChipById(c.id) as any;

    const baseName = chip?.name ?? c.id;
    const lettersRaw = String(chip?.letters ?? '').trim(); // from chips.tsv
    const letters = lettersRaw ? lettersRaw : '';

    // Always show letters in the NAME (so render.ts label always contains them).
    const name = letters ? `${baseName} [${letters}]` : baseName;

    // Only show element in UI if it's not Neutral.
    const elem = toElement(chip?.element);
    const elementForUI = elem !== 'Neutral' ? elem : undefined;

    return {
      id: String(idx), // unique per card instance
      name,
      power: asNum(chip?.power),
      hits: asNum(chip?.hits),
      element: elementForUI,
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
  for (const f of folder) {
    const chipId = String((f as any).chip_id);
    const qty = Math.max(0, toInt((f as any).qty, 0));
    for (let i = 0; i < qty; i++) deck.push({ id: chipId });
  }
  return deck;
}

function fallbackDeck(): ChipRef[] {
  const cannon = getChipById('cannon');
  if (cannon) return Array.from({ length: 10 }, () => ({ id: 'cannon' }));
  const guard = getChipById('guard');
  if (guard) return Array.from({ length: 10 }, () => ({ id: 'guard' }));
  // very last resort
  return Array.from({ length: 10 }, () => ({ id: 'chip_001' }));
}

function drawHand(bs: BattleState) {
  bs.discard.push(...bs.hand);
  bs.hand = [];

  if (bs.deck.length < 5 && bs.discard.length > 0) {
    shuffle(bs.discard);
    bs.deck.push(...bs.discard);
    bs.discard = [];
  }

  while (bs.hand.length < 5 && bs.deck.length > 0) {
    const card = bs.deck.shift()!;
    bs.hand.push(card);
  }
}

// ---------------- Selection mapping ----------------

/**
 * Converts chosen values to index-values ("0","1",...)
 * - If a value is a valid index in hand, uses it.
 * - Otherwise treats it as a chip id and picks the first matching unused card.
 */
function resolveToIndexValues(bs: BattleState, chosen: string[]): string[] {
  const out: string[] = [];
  const used = new Set<number>();

  for (const raw of chosen.slice(0, 3)) {
    const v = String(raw ?? '').trim();
    if (!v) continue;

    // Index path
    if (/^\d+$/.test(v)) {
      const idx = Number(v);
      if (Number.isFinite(idx) && idx >= 0 && idx < bs.hand.length && !used.has(idx)) {
        used.add(idx);
        out.push(String(idx));
        continue;
      }
    }

    // Chip-id path
    const idx = bs.hand.findIndex((c, i) => !used.has(i) && c.id === v);
    if (idx >= 0) {
      used.add(idx);
      out.push(String(idx));
    }
  }

  return out;
}

function selectedIndices(bs: BattleState): number[] {
  const idxs: number[] = [];
  const used = new Set<number>();

  for (const raw of (bs.selected ?? []).slice(0, 3)) {
    const v = String(raw ?? '').trim();
    if (!v) continue;

    // index
    if (/^\d+$/.test(v)) {
      const idx = Number(v);
      if (Number.isFinite(idx) && idx >= 0 && idx < bs.hand.length && !used.has(idx)) {
        used.add(idx);
        idxs.push(idx);
        continue;
      }
    }

    // legacy chip id
    const idx = bs.hand.findIndex((c, i) => !used.has(i) && c.id === v);
    if (idx >= 0) {
      used.add(idx);
      idxs.push(idx);
    }
  }

  return idxs;
}

// ---------------- Combat resolution ----------------
function _resolveRoundInternal(bs: BattleState) {
  const playerLog: string[] = [];
  const enemyLog: string[] = [];

  // ---- START OF TURN DOT (Burn/Poison) ----
  if (tickDot('enemy', bs)) {
    const d = lastTickDamage.enemy ?? 0;
    if (d > 0) enemyLog.push(`DOT dealt **${d}** to enemy.`);
  }
  if (tickDot('player', bs)) {
    const d = lastTickDamage.player ?? 0;
    if (d > 0) playerLog.push(`You took **${d}** DOT.`);
  }

  const virus = getVirusById(bs.virus_id) as any;
  const defenderElem: Element = toElement(virus?.element);

  const idxs = selectedIndices(bs);

  // Execute chips by selected card instance
  for (const idx of idxs) {
    const chipId = bs.hand[idx]?.id;
    if (!chipId) continue;

    const chip = getChipById(chipId) as any;
    if (!chip) {
      playerLog.push(`Used ${chipId} (unknown) — no effect.`);
      continue;
    }

    const power = Math.max(0, asNum(chip.power, 0));
    const hits = Math.max(1, asNum(chip.hits, 1));
    const attElem: Element = toElement(chip?.element);

    const mult = Number(typeMultiplier(attElem, defenderElem) || 1);
    const dmgPerHit = Math.round(power * Math.max(0.25, mult));
    const total = Math.max(0, dmgPerHit * hits);

    if (total > 0) {
      bs.enemy_hp = Math.max(0, bs.enemy_hp - total);
      const tag =
        mult > 1 ? ' (super effective!)' :
        mult < 1 ? ' (not very effective)' : '';
      playerLog.push(`**${chip.name}** dealt **${total}** dmg (${hits} hit${hits > 1 ? 's' : ''})${tag}.`);
    } else {
      playerLog.push(`**${chip.name}** had no direct damage.`);
    }

    // Apply status effects from chip effects text
    const effTxt = String(chip.effects ?? '');
    const applied: string[] = [];
    if (tryApplyDotFromText('burn', effTxt, bs.enemy_status)) applied.push('Burn');
    if (tryApplyDotFromText('poison', effTxt, bs.enemy_status)) applied.push('Poison');
    if (applied.length) playerLog.push(`Effects applied: ${applied.join(', ')}`);

    if (bs.enemy_hp <= 0) break;
  }

  // Move USED CARD INSTANCES to discard (by index), not by chip id
  if (idxs.length) {
    const sel = new Set(idxs);
    bs.discard.push(...idxs.map(i => bs.hand[i]).filter(Boolean));
    bs.hand = bs.hand.filter((_, i) => !sel.has(i));
  }

  if (bs.enemy_hp <= 0) {
    enemyLog.push(`Enemy deleted.`);
    return { playerLogLines: playerLog, enemyLogLines: enemyLog };
  }

  // Enemy attack (basic)
  const enemyAtk = Math.max(0, asNum(virus?.atk, randInt(5, 15)));
  const dmgToPlayer = randInt(
    Math.max(1, Math.floor(enemyAtk * 0.6)),
    Math.max(2, Math.floor(enemyAtk * 1.2)),
  );
  bs.player_hp = Math.max(0, bs.player_hp - dmgToPlayer);
  enemyLog.push(`${virus?.name ?? 'Virus'} hit you for **${dmgToPlayer}** dmg.`);

  // ---- END OF TURN: decrement DOT durations ----
  decDot(bs.enemy_status);
  decDot(bs.player_status);

  return { playerLogLines: playerLog, enemyLogLines: enemyLog };
}

// ---- DOT helpers (Burn/Poison) ----
const lastTickDamage: { player?: number; enemy?: number } = {};
function tickDot(who: 'player' | 'enemy', bs: BattleState) {
  const st = who === 'player' ? bs.player_status : bs.enemy_status;
  const maxHP = who === 'player' ? bs.player_hp_max : bs.enemy_hp_max;
  let total = 0;

  if (st.burn?.dur && st.burn.dur > 0) {
    total += Math.max(1, Math.floor(maxHP * 0.05));
  }
  if (st.poison?.dur && st.poison.dur > 0) {
    total += Math.max(1, Math.floor(maxHP * 0.08));
  }

  if (total > 0) {
    if (who === 'player') bs.player_hp = Math.max(0, bs.player_hp - total);
    else bs.enemy_hp = Math.max(0, bs.enemy_hp - total);
  }

  lastTickDamage[who] = total;
  return total > 0;
}
function decDot(st: BattleStatuses) {
  if (st.burn?.dur) st.burn.dur = Math.max(0, st.burn.dur - 1);
  if (st.poison?.dur) st.poison.dur = Math.max(0, st.poison.dur - 1);
}

// Parse text like "Burn(20%,2t)" / "Poison(100%,3t)"
function tryApplyDotFromText(kind: 'burn' | 'poison', text: string, target: BattleStatuses) {
  const re = new RegExp(`${kind}\\((\\d+)%?,\\s*(\\d+)t\\)`, 'i');
  const m = String(text ?? '').match(re);
  if (!m) return false;

  const chance = Number(m[1]) || 0;
  const dur = Math.max(1, Number(m[2]) || 1);

  if (randInt(1, 100) <= chance) {
    if (kind === 'burn') target.burn = { dur };
    else target.poison = { dur };
    return true;
  }
  return false;
}

// ---------------- Utils ----------------
function parseCustom(customId: string): [string, string] {
  const [prefix, battleId] = customId.split(':', 2);
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
async function safeUpdate(ix: any, payload: any) {
  try {
    if (ix.isRepliable?.() && !ix.deferred && !ix.replied) {
      await ix.reply({ ...payload, ephemeral: true });
      return;
    }
    await ix.editReply?.(payload);
  } catch {
    try {
      await ix.update?.(payload);
    } catch {}
  }
}

// ---------------- Compat conversion ----------------
function lockedChipIds(bs: BattleState): string[] {
  const idxs = selectedIndices(bs);
  return idxs.map(i => bs.hand[i]?.id).filter(Boolean) as string[];
}

function toCompatState(bs: BattleState, enemy_kind: 'virus' | 'boss') {
  const p = getPlayer(bs.user_id) as any;
  return {
    id: bs.id,
    user_id: bs.user_id,

    enemy_kind,
    enemy_id: bs.virus_id,
    enemy_hp: bs.enemy_hp,

    player_element: (p?.element as any) || 'Neutral',
    player_hp: bs.player_hp,
    player_hp_max: bs.player_hp_max,
    navi_atk: p?.atk ?? 10,
    navi_def: p?.def ?? 6,
    navi_acc: p?.acc ?? 90,
    navi_eva: p?.evasion ?? 10,

    turn: bs.turn,
    seed: 0,
    draw_pile: bs.deck.map((c) => c.id),
    discard_pile: bs.discard.map((c) => c.id),
    hand: bs.hand.map((c) => c.id),

    // Keep legacy expectations: chip ids here
    locked: lockedChipIds(bs),

    player_status: bs.player_status,
    enemy_status: bs.enemy_status,
  };
}
