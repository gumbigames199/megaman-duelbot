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

type Element = 'Neutral' | 'Fire' | 'Wood' | 'Elec' | 'Aqua';

type ChipRef = { id: string };

type BattleHandItem = {
  id: string; // IMPORTANT: this is the SELECT OPTION VALUE (must be unique per hand card instance)
  name: string;
  power?: number;
  hits?: number;
  element?: string;
  effects?: string;
  description?: string;
};

type DotState = { dur: number; pct: number };
type BattleStatuses = {
  burn?: DotState;
  poison?: DotState;
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

  // IMPORTANT:
  // This stores SELECT MENU VALUES which are card indices ("0","1","2"...),
  // NOT chip ids (so duplicates are allowed).
  selected: string[];

  is_over: boolean;

  player_status: BattleStatuses;
  enemy_status: BattleStatuses;
};

const battles = new Map<string, BattleState>();
let battleSeq = 1;

function nextBattleId() {
  return String(battleSeq++);
}

function parseCustom(customId: string): [string, string] {
  const [a, b] = String(customId ?? '').split(':');
  return [a || '', b || ''];
}

async function safeUpdate(
  ix: ButtonInteraction | StringSelectMenuInteraction,
  payload: any,
) {
  try {
    if (ix.deferred || ix.replied) return await ix.editReply(payload);
    return await ix.update(payload);
  } catch {
    // ignore
  }
}

function toInt(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}
function asNum(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function randInt(a: number, b: number) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function toElement(x: any): Element {
  const s = String(x ?? '').trim().toLowerCase();
  if (s === 'fire') return 'Fire';
  if (s === 'wood') return 'Wood';
  if (s === 'elec' || s === 'electric') return 'Elec';
  if (s === 'aqua' || s === 'water') return 'Aqua';
  return 'Neutral';
}

function getVirusName(virusId: string) {
  const v = getVirusById(virusId) as any;
  return v?.name ?? virusId;
}

// ---------------- Deck building ----------------

function buildDeckFromFolder(user_id: string): ChipRef[] {
  const rows = listFolderQty(user_id); // [{chip_id, qty}]
  const out: ChipRef[] = [];
  for (const r of rows) {
    const id = String(r.chip_id);
    const qty = Math.max(0, toInt(r.qty, 0));
    for (let i = 0; i < qty; i++) out.push({ id });
  }
  return out;
}

function fallbackDeck(): ChipRef[] {
  // extremely small fallback if folder is empty
  return [
    { id: 'Cannon' },
    { id: 'Sword' },
    { id: 'MiniBomb' },
    { id: 'Recover10' },
    { id: 'AirShot' },
  ];
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

// ---------------- Render helpers ----------------

function toHandItems(hand: ChipRef[]): BattleHandItem[] {
  // IMPORTANT: Discord select menus require unique option values.
  // A hand can contain duplicate chip ids, so we use the card index as the option value/id.
  return hand.map((c, idx) => {
    const chip = getChipById(c.id);
    return {
      id: String(idx), // unique per card instance in this hand
      name: chip?.name ?? c.id,
      power: asNum((chip as any)?.power),
      hits: asNum((chip as any)?.hits),
      element: (chip as any)?.element,
      effects: (chip as any)?.effects,
      description: (chip as any)?.description,
    };
  });
}

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
    // selectedIds must match the select option values (indices)
    selectedIds: bs.selected.slice(0, 3),
  });
}

// ---------------- Public battle entrypoints ----------------

export function startBattle(user_id: string, virus_id: string) {
  ensurePlayer(user_id);
  const player = getPlayer(user_id)!;
  const virus = getVirusById(virus_id);
  const enemyHP = Math.max(1, toInt((virus as any)?.hp, 100));

  // NOTE: This ensures your "folder resets every battle" expectation:
  // each battle builds a fresh deck from the current folder.
  const deck = buildDeckFromFolder(user_id);
  if (deck.length === 0) deck.push(...fallbackDeck());

  shuffle(deck);

  const id = nextBattleId();
  const bs: BattleState = {
    id,
    user_id,
    virus_id,

    player_hp: Math.max(1, toInt(player.hp_max ?? player.hp ?? 100, 100)),
    player_hp_max: Math.max(1, toInt(player.hp_max ?? player.hp ?? 100, 100)),
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
  if (!bs || bs.is_over)
    return safeUpdate(ix, {
      content: '⚠️ This battle is no longer active.',
      components: [],
      embeds: [],
    });

  // values are indices ("0","1","2"...). This avoids duplicate option values.
  bs.selected = (ix.values ?? []).slice(0, 3);

  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleLock(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'lock') return;
  const bs = battles.get(battleId);
  if (!bs || bs.is_over)
    return safeUpdate(ix, {
      content: '⚠️ This battle is no longer active.',
      components: [],
      embeds: [],
    });

  const roundSummary = _resolveRoundInternal(bs);

  if (bs.player_hp <= 0 || bs.enemy_hp <= 0) {
    bs.is_over = true;

    if (bs.enemy_hp <= 0 && bs.player_hp > 0) {
      const rewards = grantVirusRewards(bs.user_id, bs.virus_id);
      const rewardLines = [
        `XP +${rewards.xp_gained} (Lv ${rewards.level_after})`,
        `Zenny +${rewards.zenny_gained}`,
        ...(rewards.drops.length
          ? rewards.drops.map((d) => `Drop: ${d.item_id} ×${d.qty}`)
          : []),
      ];

      const victoryView = renderVictoryToHub({
        enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
        victory: { title: 'Victory!', rewardLines },
      });

      await ix.update({ embeds: [victoryView.embed], components: victoryView.components });
      battles.delete(battleId); // cleanup = next battle starts fresh
      return;
    }

    const lossView = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: { title: bs.player_hp <= 0 ? 'Defeat…' : 'Battle End', rewardLines: [] },
    });

    await ix.update({ embeds: [lossView.embed], components: lossView.components });
    battles.delete(battleId); // cleanup
    return;
  }

  drawHand(bs);
  const nextHand = toHandItems(bs.hand);
  const hpBlock = {
    playerHP: bs.player_hp,
    playerHPMax: bs.player_hp_max,
    enemyHP: bs.enemy_hp,
    enemyHPMax: bs.enemy_hp_max,
  };

  const view = renderRoundResultWithNextHand({
    battleId: bs.id,
    enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
    hp: hpBlock,
    roundSummary,
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
  if (!bs || bs.is_over)
    return safeUpdate(ix, {
      content: '⚠️ This battle is no longer active.',
      components: [],
      embeds: [],
    });

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

// ---------------- Compat helpers (used by older wiring) ----------------

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

/** Load a compat state snapshot by id. */
export function load(battleId: string): any | null {
  const bs = battles.get(battleId);
  return bs ? toCompatState(bs, 'virus') : null;
}

/** Save current picks (locked) from compat state into active battle. */
export function save(s: any): void {
  if (!s?.id) return;
  const bs = battles.get(s.id);
  if (!bs) return;

  const locked = Array.isArray(s.locked) ? s.locked.filter(Boolean).slice(0, 3) : [];

  // Prefer indices if caller provides them; otherwise map chip ids -> first matching hand index.
  const out: string[] = [];
  const usedIdx = new Set<number>();

  for (const raw of locked) {
    const v = String(raw ?? '').trim();
    if (!v) continue;

    if (/^\d+$/.test(v)) {
      const idx = Number(v);
      if (Number.isFinite(idx) && idx >= 0 && idx < bs.hand.length && !usedIdx.has(idx)) {
        usedIdx.add(idx);
        out.push(String(idx));
        continue;
      }
    }

    const idx = bs.hand.findIndex((c, i) => !usedIdx.has(i) && c.id === v);
    if (idx >= 0) {
      usedIdx.add(idx);
      out.push(String(idx));
    }
  }

  bs.selected = out;
}

/** End / cleanup. */
export function end(battleId: string) {
  battles.delete(battleId);
}

// ---------------- Resolution ----------------

// Convert bs.selected (which may contain indices *or* chip ids for backwards-compat) into chip ids to execute.
// - If value is a valid index into the current hand, use that card.
// - Otherwise treat it as a chip id and match the first unused occurrence in hand.
function resolveSelectedChipIds(bs: BattleState): string[] {
  const picked: string[] = [];
  const usedIdx = new Set<number>();

  for (const raw of (bs.selected ?? []).slice(0, 3)) {
    const s = String(raw ?? '').trim();
    if (!s) continue;

    // Index path (preferred)
    if (/^\d+$/.test(s)) {
      const idx = Number(s);
      if (Number.isFinite(idx) && idx >= 0 && idx < bs.hand.length && !usedIdx.has(idx)) {
        usedIdx.add(idx);
        picked.push(bs.hand[idx].id);
        continue;
      }
    }

    // Chip-id path (legacy)
    const idx = bs.hand.findIndex((c, i) => !usedIdx.has(i) && c.id === s);
    if (idx >= 0) {
      usedIdx.add(idx);
      picked.push(bs.hand[idx].id);
    }
  }

  return picked;
}

const lastTickDamage: { player?: number; enemy?: number } = {};

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

  const selected = resolveSelectedChipIds(bs);
  const virus = getVirusById(bs.virus_id) as any;
  const defenderElem: Element = toElement(virus?.element);

  // Player uses selected chips (simple)
  for (const chipId of selected) {
    const chip = getChipById(chipId) as any;
    if (!chip) {
      playerLog.push(`Used ${chipId} (unknown) — no effect.`);
      continue;
    }

    const power = Math.max(0, asNum(chip.power, 0));
    const hits = Math.max(1, asNum(chip.hits, 1));
    const attElem: Element = toElement(chip?.element);

    // Elemental multiplier (typed)
    const mult = Number(typeMultiplier(attElem, defenderElem) || 1);
    const dmgPerHit = Math.round(power * Math.max(0.25, mult));
    const total = Math.max(0, dmgPerHit * hits);

    if (total > 0) {
      bs.enemy_hp = Math.max(0, bs.enemy_hp - total);
      const tag =
        mult > 1 ? ' (super effective!)' :
        mult < 1 ? ' (not very effective)' : '';
      playerLog.push(
        `**${chip.name}** dealt **${total}** dmg (${hits} hit${hits > 1 ? 's' : ''})${tag}.`,
      );
    } else {
      playerLog.push(`**${chip.name}** had no direct damage.`);
    }

    // Apply DOT effects from chip text/effects (first pass)
    const effText = String(chip.effects ?? chip.description ?? '');
    if (effText) {
      if (tryApplyDotFromText('burn', effText, bs.enemy_status)) {
        playerLog.push(`Enemy was **Burned**.`);
      }
      if (tryApplyDotFromText('poison', effText, bs.enemy_status)) {
        playerLog.push(`Enemy was **Poisoned**.`);
      }
    }

    if (bs.enemy_hp <= 0) break;
  }

  // Enemy attacks if alive
  if (bs.enemy_hp > 0) {
    const enemyAtk = Math.max(0, asNum(virus?.atk, randInt(5, 15)));
    const dmgToPlayer = randInt(
      Math.max(1, Math.floor(enemyAtk * 0.6)),
      Math.max(2, Math.floor(enemyAtk * 1.2)),
    );
    bs.player_hp = Math.max(0, bs.player_hp - dmgToPlayer);
    enemyLog.push(`${virus?.name ?? 'Virus'} hit you for **${dmgToPlayer}** dmg.`);
  }

  // ---- END OF TURN: decrement DOT durations ----
  decDot(bs.enemy_status);
  decDot(bs.player_status);

  return { playerLogLines: playerLog, enemyLogLines: enemyLog };
}

// ---------------- DOT helpers ----------------

function tickDot(which: 'player' | 'enemy', bs: BattleState) {
  const target = which === 'player' ? 'player_hp' : 'enemy_hp';
  const max = which === 'player' ? bs.player_hp_max : bs.enemy_hp_max;
  const st = which === 'player' ? bs.player_status : bs.enemy_status;

  let total = 0;

  if (st.burn?.dur && st.burn.dur > 0) {
    const d = Math.max(1, Math.floor(max * (st.burn.pct / 100)));
    bs[target] = Math.max(0, (bs as any)[target] - d);
    total += d;
  }
  if (st.poison?.dur && st.poison.dur > 0) {
    const d = Math.max(1, Math.floor(max * (st.poison.pct / 100)));
    bs[target] = Math.max(0, (bs as any)[target] - d);
    total += d;
  }

  if (which === 'player') lastTickDamage.player = total;
  else lastTickDamage.enemy = total;

  return total > 0;
}

function decDot(st: BattleStatuses) {
  if (st.burn?.dur) st.burn.dur = Math.max(0, st.burn.dur - 1);
  if (st.poison?.dur) st.poison.dur = Math.max(0, st.poison.dur - 1);
}

// Parse text like "Burn(20%,2t)" / "Poison(100%,3t)"
function tryApplyDotFromText(kind: 'burn' | 'poison', text: string, target: BattleStatuses) {
  const re = new RegExp(`${kind}\\((\\d+)%?,\\s*(\\d+)t\\)`, 'i');
  const m = text.match(re);
  if (!m) return false;
  const chance = Number(m[1]) || 0;
  const dur = Math.max(1, Number(m[2]) || 1);

  if (randInt(1, 100) <= chance) {
    if (kind === 'burn') target.burn = { dur, pct: 5 };   // 5% HP per turn
    if (kind === 'poison') target.poison = { dur, pct: 8 }; // 8% HP per turn
    return true;
  }
  return false;
}

// --------------- Compat conversion ----------------
function toCompatState(bs: BattleState, enemy_kind: 'virus' | 'boss') {
  const p = getPlayer(bs.user_id);
  return {
    id: bs.id,
    user_id: bs.user_id,
    enemy_kind,
    enemy_id: bs.virus_id,

    navi_hp: bs.player_hp,
    navi_hp_max: bs.player_hp_max,
    enemy_hp: bs.enemy_hp,
    enemy_hp_max: bs.enemy_hp_max,

    navi_atk: p?.atk ?? 10,
    navi_def: p?.def ?? 5,
    navi_spd: p?.spd ?? 1,
    navi_acc: p?.acc ?? 90,
    navi_eva: p?.evasion ?? 10,

    turn: bs.turn,
    seed: 0,
    draw_pile: bs.deck.map((c) => c.id),
    discard_pile: bs.discard.map((c) => c.id),
    hand: bs.hand.map((c) => c.id),

    // expose chip ids (not indices) for readability/debug
    locked: resolveSelectedChipIds(bs),

    player_status: bs.player_status,
    enemy_status: bs.enemy_status,
  };
}
