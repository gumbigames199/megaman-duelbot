import { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { getChipById, getVirusById } from './data';
import { renderBattleScreen, renderRoundResultWithNextHand, renderVictoryToHub } from './render';
import { ensurePlayer, getPlayer } from './db';
import { grantVirusRewards } from './rewards';

const DEFAULT_PLAYER_HP = 100;

type ChipRef = { id: string };
type BattleHandItem = { id: string; name: string; power?: number; hits?: number; element?: string; effects?: string; description?: string; };
type BattleState = {
  id: string; user_id: string; virus_id: string;
  player_hp: number; player_hp_max: number; enemy_hp: number; enemy_hp_max: number;
  turn: number; deck: ChipRef[]; discard: ChipRef[]; hand: ChipRef[]; selected: string[]; is_over: boolean;
};

const battles = new Map<string, BattleState>();
function nextBattleId(){ const n=Math.floor(Date.now()/1000); const r=randInt(1000,9999); return `b${n}${r}`; }

export function startBattle(user_id: string, virus_id: string) {
  ensurePlayer(user_id);
  const player = getPlayer(user_id)!;
  const virus = getVirusById(virus_id);
  const enemyHP = Math.max(1, toInt((virus as any)?.hp, 100));

  const deck = buildDeckFromFolder(user_id);
  if (deck.length === 0) deck.push(...fallbackDeck());

  shuffle(deck);

  const id = nextBattleId();
  const bs: BattleState = {
    id, user_id, virus_id,
    player_hp: Math.max(1, player?.hp_max ?? DEFAULT_PLAYER_HP),
    player_hp_max: Math.max(1, player?.hp_max ?? DEFAULT_PLAYER_HP),
    enemy_hp: enemyHP, enemy_hp_max: enemyHP,
    turn: 1, deck, discard: [], hand: [], selected: [], is_over: false,
  };

  drawHand(bs);
  battles.set(id, bs);
  const view = renderBattle(bs);
  return { embed: view.embed, components: view.components }; // explicit return
}

export async function handlePick(ix: StringSelectMenuInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId); if (prefix !== 'pick') return;
  const bs = battles.get(battleId); if (!bs || bs.is_over) return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
  bs.selected = (ix.values ?? []).slice(0, 3);
  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleLock(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId); if (prefix !== 'lock') return;
  const bs = battles.get(battleId); if (!bs || bs.is_over) return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });

  const roundSummary = resolveTurn(bs);

  if (bs.player_hp <= 0 || bs.enemy_hp <= 0) {
    bs.is_over = true;
    if (bs.enemy_hp <= 0 && bs.player_hp > 0) {
      const rewards = grantVirusRewards(bs.user_id, bs.virus_id);
      const rewardLines = [
        rewards.zenny_gained ? `+${rewards.zenny_gained}z` : '',
        rewards.xp_gained ? `+${rewards.xp_gained} XP` : '',
        rewards.drops.length ? `Drops: ${rewards.drops.map(d => `**${d.item_id}** x${d.qty}`).join(', ')}` : '',
      ].filter(Boolean);
      const victoryView = renderVictoryToHub({ enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) }, victory: { title: 'Victory!', rewardLines } });
      await ix.update({ embeds: [victoryView.embed], components: victoryView.components });
      battles.delete(battleId); return;
    }
    const lossView = renderVictoryToHub({ enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) }, victory: { title: bs.player_hp <= 0 ? 'Defeat…' : 'Battle End', rewardLines: [] } });
    await ix.update({ embeds: [lossView.embed], components: lossView.components });
    battles.delete(battleId); return;
  }

  drawHand(bs);
  const nextHand = toHandItems(bs.hand);
  const hpBlock = { playerHP: bs.player_hp, playerHPMax: bs.player_hp_max, enemyHP: bs.enemy_hp, enemyHPMax: bs.enemy_hp_max };
  const view = renderRoundResultWithNextHand({ battleId, enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) }, hp: hpBlock, round: roundSummary, nextHand, selectedIds: [] });
  bs.selected = []; bs.turn += 1;
  await ix.update({ embeds: [view.embed], components: view.components });
}

export async function handleRun(ix: ButtonInteraction) {
  const [prefix, battleId] = parseCustom(ix.customId); if (prefix !== 'run') return;
  const bs = battles.get(battleId); if (!bs || bs.is_over) return safeUpdate(ix, { content: '⚠️ This battle is no longer active.', components: [], embeds: [] });
  const escaped = randInt(1, 100) <= 50;
  if (escaped) {
    bs.is_over = true;
    const view = renderVictoryToHub({ enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) }, victory: { title: 'Escaped', rewardLines: [] } });
    await ix.update({ embeds: [view.embed], components: view.components });
    battles.delete(battleId); return;
  }
  const view = renderBattle(bs);
  await ix.update({ embeds: [view.embed], components: view.components });
}

function renderBattle(bs: BattleState) {
  const hp = { playerHP: bs.player_hp, playerHPMax: bs.player_hp_max, enemyHP: bs.enemy_hp, enemyHPMax: bs.enemy_hp_max };
  const handItems = toHandItems(bs.hand);
  return renderBattleScreen({ battleId: bs.id, enemy: { virusId: bs.virus_id, displayName: getVirusName(bs.virus_id) }, hp, hand: handItems, selectedIds: bs.selected.slice() });
}
function toHandItems(hand: ChipRef[]): BattleHandItem[] {
  return hand.map((c) => {
    const chip = getChipById(c.id);
    return { id: c.id, name: chip?.name ?? c.id, power: asNum((chip as any)?.power), hits: asNum((chip as any)?.hits), element: (chip as any)?.element, effects: (chip as any)?.effects, description: (chip as any)?.description };
  });
}
function getVirusName(virus_id: string){ const v = getVirusById(virus_id); return v?.name ?? virus_id; }

// Deck/hand
function buildDeckFromFolder(user_id: string): ChipRef[] {
  const DB = require('./db') as typeof import('./db');
  const folder = DB.listFolder(user_id);
  const deck: ChipRef[] = [];
  for (const f of folder) for (let i=0;i<Math.max(0,f.qty);i++) deck.push({ id: f.chip_id });
  return deck;
}
function fallbackDeck(): ChipRef[] {
  const cannon = getChipById('cannon'); if (cannon) return Array.from({ length: 10 }, () => ({ id: 'cannon' }));
  const guard = getChipById('guard'); if (guard) return Array.from({ length: 10 }, () => ({ id: 'guard' }));
  const chips = (require('./data') as typeof import('./data')).listChips();
  const first = chips[0]?.id ?? 'chip_001';
  return Array.from({ length: 10 }, () => ({ id: first }));
}
function drawHand(bs: BattleState) {
  bs.discard.push(...bs.hand); bs.hand = [];
  if (bs.deck.length < 5 && bs.discard.length > 0) { shuffle(bs.discard); bs.deck.push(...bs.discard); bs.discard = []; }
  while (bs.hand.length < 5 && bs.deck.length > 0) { const card = bs.deck.shift()!; bs.hand.push(card); }
}

// Combat resolution (simple)
function resolveTurn(bs: BattleState) {
  const playerLog: string[] = []; const enemyLog: string[] = [];
  const selected = bs.selected.slice(0,3);
  for (const chipId of selected) {
    const chip = getChipById(chipId);
    if (!chip) { playerLog.push(`Used ${chipId} (unknown) — no effect.`); continue; }
    const power = asNum((chip as any).power, 0);
    const hits = Math.max(1, asNum((chip as any).hits, 1));
    const dmgTotal = Math.max(0, power) * hits;
    if (dmgTotal > 0) { bs.enemy_hp = Math.max(0, bs.enemy_hp - dmgTotal); playerLog.push(`**${chip.name}** dealt **${dmgTotal}** dmg (${hits} hit${hits>1?'s':''}).`); }
    else playerLog.push(`**${chip.name}** had no direct damage.`);
    const eff = (chip as any)?.effects; if (eff) playerLog.push(`Effects: ${eff}`);
  }
  bs.discard.push(...bs.hand.filter(h => selected.includes(h.id)));
  bs.hand = bs.hand.filter(h => !selected.includes(h.id));
  if (bs.enemy_hp <= 0) { enemyLog.push(`Enemy deleted.`); return { playerLogLines: playerLog, enemyLogLines: enemyLog }; }

  const virus = getVirusById(bs.virus_id);
  const enemyAtk = Math.max(0, asNum((virus as any)?.atk, randInt(5, 15)));
  const dmgToPlayer = randInt(Math.max(1, Math.floor(enemyAtk * 0.6)), Math.max(2, Math.floor(enemyAtk * 1.2)));
  bs.player_hp = Math.max(0, bs.player_hp - Math.max(0, dmgToPlayer));
  enemyLog.push(`${virus?.name ?? 'Virus'} hit you for **${dmgToPlayer}** dmg.`);
  return { playerLogLines: playerLog, enemyLogLines: enemyLog };
}

// utils
function parseCustom(customId: string): [string, string] { const [prefix, battleId] = customId.split(':', 2); return [prefix, battleId]; }
function asNum(v: any, d = 0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function toInt(v: any, d = 0){ const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; }
function shuffle<T>(a:T[]){ for (let i=a.length-1;i>0;i--){ const j=randInt(0,i); const t=a[i]; a[i]=a[j]; a[j]=t; } }
function randFloat(){ return Math.random(); }
function randInt(a:number,b:number){ return a + Math.floor(randFloat()*(b-a+1)); }
async function safeUpdate(ix: any, payload: any){ try{ if(ix.isRepliable?.() && !ix.deferred && !ix.replied){ await ix.reply({ ...payload, ephemeral: true }); return;} await ix.editReply?.(payload); } catch { try { await ix.update?.(payload); } catch {} } }
