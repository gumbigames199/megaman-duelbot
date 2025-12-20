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
      const rewards = grantVirusRewards(bs.user_id_
