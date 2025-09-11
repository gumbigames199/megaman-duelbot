// battle.ts
// Battle loop + UI wiring
// - End-of-round → render next chip selection immediately (3 of 5)
// - Battle end → Victory! + rewards, then Encounter/Travel/Shop hub buttons
// - Virus art in header (from data.getVirusArt via render helpers)
// - Custom IDs: pick:<battleId>, lock:<battleId>, run:<battleId>
//
// NOTES:
// • This is a focused, reliable battle loop tuned to your requested UX.
// • It uses a straightforward damage model; feel free to swap in your advanced damage.ts later.
// • Program Advances and complex status/aura systems can be layered in afterward without changing the UI contract.

import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
  ComponentType,
} from 'discord.js';

import { rngInt, rngShuffle } from './rng';
import { getChipById, getVirusById } from './data';
import { renderBattleScreen, renderRoundResultWithNextHand, renderVictoryToHub, battlePickId, battleLockId, battleRunId } from './render';
import { ensurePlayer, getPlayer } from './db';
import { grantVirusRewards } from './rewards';

// -------------------------------
// Config
// -------------------------------

const ROUND_SECONDS = toInt(process.env.ROUND_SECONDS, 60); // if you want to show timers later
const DEFAULT_PLAYER_HP = 100; // fallback if player.hp_max missing

// -------------------------------
// Types
// -------------------------------

type ChipRef = { id: string };

type BattleHandItem = {
  id: string;
  name: string;
  power?: number;
  hits?: number;
  element?: string;
  effects?: string;
  description?: string;
};

type BattleState = {
  id: string;
  user_id: string;
  virus_id: string;

  // HP
  player_hp: number;
  player_hp_max: number;
  enemy_hp: number;
  enemy_hp_max: number;

  // Turn/Deck state
  turn: number;
  deck: ChipRef[];     // remaining draw pile
  discard: ChipRef[];  // previously used chips
  hand: ChipRef[];     // current hand (up to 5)
  selected: string[];  // selected chip ids for this turn (up to 3)

  // Flags
  is_over: boolean;
};

// -------------------------------
// Battle Store (in-memory)
// -------------------------------

const battles = new Map<string, BattleState>();

function nextBattleId(): string {
  // Simple unique-ish id
  const n = Math.floor(Date.now() / 1000);
  const r = rngInt(1000, 9999);
  return `b${n}${r}`;
}

// -------------------------------
// Public API
// -------------------------------

/**
 * Starts a battle for user against a specific virus.
 * Builds a deck from the user's folder; draws initial 5-card hand;
 * returns {embed, components} for immediate rendering.
 */
export function startBattle(user_id: string, virus_id: string) {
  ensurePlayer(user_id);

  const player = getPlayer(user_id)!;
  const virus = getVirusById(virus_id);
  const enemyHP = Math.max(1, toInt((virus as any)?.hp, 100));

  const deck = buildDeckFromFolder(user_id);
  if (deck.length === 0) {
    // Safety net: if folder empty, give 10 "Cannon" if present or any chip fallback
    const fallback = fallbackDeck();
    deck.push(...fallback);
  }

  rngShuffle(deck);

  const id = nextBattleId();
  const bs: BattleState = {
    id,
    user_id,
    virus_id,
    player_hp: Math.max(1, player?.hp_max ?? DEFAULT_PLAYER_HP),
    player_hp_max: Math.max(1, player?.hp_max ?? DEFAULT_PLAYER_HP),
    enemy_hp: enemyHP,
    enemy_hp_max: enemyHP,
    turn: 1,
    deck,
    discard: [],
    hand: [],
    selected: [],
    is_over: false,
  };

  drawHand(bs);

  battles.set(id, bs);
  return renderBattle(bs);
}

/** Route a StringSelect ('pick:<battleId>') */
export async function handlePick(ix: StringSelectMenuInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'pick') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
    return;
  }

  // Keep up to 3 selected
  const incoming = (ix.values ?? []).slice(0, 3);
  bs.selected = incoming;

  // Re-render selection (no resolution; user still must press Lock)
  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

/** Route a Button ('lock:<battleId>') */
export async function handleLock(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'lock') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
    return;
  }

  // Resolve the turn using selected chips
  const roundSummary = resolveTurn(bs);

  // Check end condition
  if (bs.player_hp <= 0 || bs.enemy_hp <= 0) {
    bs.is_over = true;

    // Rewards + Victory screen (if player won)
    if (bs.enemy_hp <= 0 && bs.player_hp > 0) {
      const rewards = grantVirusRewards(bs.user_id, bs.virus_id);

      const rewardLines = [
        rewards.zenny_gained ? `+${rewards.zenny_gained}z` : '',
        rewards.xp_gained ? `+${rewards.xp_gained} XP` : '',
        rewards.drops.length ? `Drops: ${rewards.drops.map(d => `**${d.item_id}** x${d.qty}`).join(', ')}` : '',
      ].filter(Boolean);

      const victoryView = renderVictoryToHub({
        enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
        victory: { title: 'Victory!', rewardLines },
      });

      await ix.update({ embeds: [victoryView.embed], components: victoryView.components });
      // Cleanup battle
      battles.delete(battleId);
      return;
    }

    // Player lost or double-KO: still go back to hub with a loss message
    const lossView = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: {
        title: bs.player_hp <= 0 ? 'Defeat…' : 'Battle End',
        rewardLines: [],
      },
    });

    await ix.update({ embeds: [lossView.embed], components: lossView.components });
    battles.delete(battleId);
    return;
  }

  // Otherwise, continue battle: draw next hand, clear selection, show results + next selection
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
    round: roundSummary,
    nextHand,
    selectedIds: [],
  });

  // Reset selection for the new turn
  bs.selected = [];
  bs.turn += 1;

  await ix.update({ embeds: [view.embed], components: view.components });
}

/** Route a Button ('run:<battleId>') — 50% escape chance */
export async function handleRun(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId);
  if (prefix !== 'run') return;

  const bs = battles.get(battleId);
  if (!bs || bs.is_over) {
    await safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
    return;
  }

  const escaped = rngInt(1, 100) <= 50;
  if (escaped) {
    bs.is_over = true;

    // Return to hub with a note
    const view = renderVictoryToHub({
      enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) },
      victory: { title: 'Escaped', rewardLines: [] },
    });

    await ix.update({ embeds: [view.embed], components: view.components });
    battles.delete(battleId);
    return;
  }

  // Failed to run — just re-render the same selection screen
  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

// -------------------------------
// Rendering helpers
// -------------------------------

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

function toHandItems(hand: ChipRef[]): BattleHandItem[] {
  return hand.map((c) => {
    const chip = getChipById(c.id);
    return {
      id: c.id,
      name: chip?.name ?? c.id,
      power: asNum((chip as any)?.power),
      hits: asNum((chip as any)?.hits),
      element: (chip as any)?.element,
      effects: (chip as any)?.effects,
      description: (chip as any)?.description,
    };
  });
}

function getVirusName(virus_id: string): string {
  const v = getVirusById(virus_id);
  return v?.name ?? virus_id;
}

// -------------------------------
// Deck / Hand
// -------------------------------

function buildDeckFromFolder(user_id: string): ChipRef[] {
  // Lazy import to avoid circular deps in some bundlers
  const DB = require('./db') as typeof import('./db');
  const folder = DB.listFolder(user_id); // [{chip_id, qty}]
  const deck: ChipRef[] = [];
  for (const f of folder) {
    for (let i = 0; i < Math.max(0, f.qty); i++) deck.push({ id: f.chip_id });
  }
  return deck;
}

function fallbackDeck(): ChipRef[] {
  // Try a few common basics by id; otherwise generate 10 copies of the first chip in data
  const cannon = getChipById('cannon');
  if (cannon) return Array.from({ length: 10 }, () => ({ id: 'cannon' }));
  const guard = getChipById('guard');
  if (guard) return Array.from({ length: 10 }, () => ({ id: 'guard' }));
  const chips = (require('./data') as typeof import('./data')).listChips();
  const first = chips[0]?.id ?? 'chip_001';
  return Array.from({ length: 10 }, () => ({ id: first }));
}

function drawHand(bs: BattleState) {
  // Move any remaining hand into discard before drawing fresh 5
  bs.discard.push(...bs.hand);
  bs.hand = [];

  // Refill deck from discard if needed
  if (bs.deck.length < 5 && bs.discard.length > 0) {
    rngShuffle(bs.discard);
    bs.deck.push(...bs.discard);
    bs.discard = [];
  }

  while (bs.hand.length < 5 && bs.deck.length > 0) {
    const card = bs.deck.shift()!;
    bs.hand.push(card);
  }
}

// -------------------------------
// Combat Resolution (simple, safe)
// -------------------------------

function resolveTurn(bs: BattleState) {
  const playerLog: string[] = [];
  const enemyLog: string[] = [];

  // --- Player phase ---
  // Execute selected chips in the order they appear in selection array.
  const selected = bs.selected.slice(0, 3);
  for (const chipId of selected) {
    const chip = getChipById(chipId);
    if (!chip) {
      playerLog.push(`Used ${chipId} (unknown) — no effect.`);
      continue;
    }

    // Calculate damage
    const power = asNum((chip as any).power, 0);
    const hits = Math.max(1, asNum((chip as any).hits, 1));
    const dmgTotal = Math.max(0, power) * hits;

    if (dmgTotal > 0) {
      bs.enemy_hp = Math.max(0, bs.enemy_hp - dmgTotal);
      playerLog.push(`**${chip.name}** dealt **${dmgTotal}** dmg (${hits} hit${hits > 1 ? 's' : ''}).`);
    } else {
      playerLog.push(`**${chip.name}** had no direct damage.`);
    }

    // Basic side-effects text (non-functional stubs to avoid crashes; wire real effects later)
    const eff = (chip as any)?.effects;
    if (eff) {
      playerLog.push(`Effects: ${eff}`);
    }
  }

  // Discard used cards
  bs.discard.push(...bs.hand.filter(h => selected.includes(h.id)));
  // Remove only the selected ones from hand; keep unplayed in hand until next draw replaces entire hand
  bs.hand = bs.hand.filter(h => !selected.includes(h.id));

  // Early out if enemy defeated
  if (bs.enemy_hp <= 0) {
    enemyLog.push(`Enemy deleted.`);
    return { playerLogLines: playerLog, enemyLogLines: enemyLog };
  }

  // --- Enemy phase (simple strike) ---
  // Use virus atk to shape damage if present; else roll a small range.
  const virus = getVirusById(bs.virus_id);
  const enemyAtk = Math.max(0, asNum((virus as any)?.atk, rngInt(5, 15)));
  const dmgToPlayer = rngInt(Math.max(1, Math.floor(enemyAtk * 0.6)), Math.max(2, Math.floor(enemyAtk * 1.2)));
  bs.player_hp = Math.max(0, bs.player_hp - dmgToPlayer);
  enemyLog.push(`${virus?.name ?? 'Virus'} hit you for **${dmgToPlayer}** dmg.`);

  return { playerLogLines: playerLog, enemyLogLines: enemyLog };
}

// -------------------------------
// Utilities
// -------------------------------

function parseCustom(customId: string): [string, string] {
  const [prefix, battleId] = customId.split(':', 2);
  return [prefix, battleId];
}

function asNum(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toInt(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

async function safeUpdate(
  ix: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction,
  payload: any
) {
  try {
    if (ix.isRepliable() && !ix.deferred && !ix.replied) {
      await ix.reply({ ...payload, ephemeral: true });
      return;
    }
    await ix.editReply?.(payload);
  } catch {
    try { await ix.update?.(payload); } catch {}
  }
}

// -------------------------------
// Optional: command starter (if you want /boss or /encounter to call directly)
// -------------------------------

export async function startBattleCommand(interaction: ChatInputCommandInteraction, virus_id: string) {
  const userId = interaction.user.id;
  const view = startBattle(userId, virus_id);
  await interaction.reply({ embeds: [view.embed], components: view.components, ephemeral: true });
}

// For index.ts routers:
//  - if (ix.isStringSelectMenu() && ix.customId.startsWith('pick:')) await battle.handlePick(ix)
//  - if (ix.isButton() && ix.customId.startsWith('lock:')) await battle.handleLock(ix)
//  - if (ix.isButton() && ix.customId.startsWith('run:')) await battle.handleRun(ix)
