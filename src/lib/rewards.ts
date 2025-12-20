// src/lib/rewards.ts
import { getBundle, getVirusById } from './data';
import { addZenny, addXP, grantChip, getPlayer } from './db';

/**
 * GLOBAL_DROP_RATE_MULT (optional):
 * Multiplies the overall chance that a drop happens (NOT per-chip weights).
 * Defaults to 1.0.
 */
const GLOBAL_DROP_RATE_MULT = envFloat('GLOBAL_DROP_RATE_MULT', 1.0);

/**
 * Railway env (you already have VIRUS_CHIP_DROP_RATE):
 * - VIRUS_CHIP_DROP_RATE: chance a normal virus drops a chip (0..1)
 * - BOSS_CHIP_DROP_RATE: optional override for bosses (0..1). If unset, bosses use VIRUS_CHIP_DROP_RATE.
 */
const VIRUS_CHIP_DROP_RATE = envFloat('VIRUS_CHIP_DROP_RATE', 0.33);
const BOSS_CHIP_DROP_RATE = envFloat('BOSS_CHIP_DROP_RATE', NaN);

// Fallbacks if a virus row is missing ranges
const VIRUS_BASE_XP_RANGE = [10, 20] as const;
const VIRUS_BASE_ZENNY_RANGE = [20, 60] as const;
const BOSS_FALLBACK_XP_MULT = envFloat('BOSS_XP_MULTIPLIER', 1.5);
const BOSS_FALLBACK_ZENNY_RANGE = [150, 300] as const;

export type DropGrant = { item_id: string; qty: number };
export type RewardsResult = {
  xp_gained: number;
  xp_total_after: number;
  level_after: number;
  next_threshold: number;
  zenny_gained: number;
  zenny_balance_after?: number;
  drops: DropGrant[];
  leveledUp?: number;
};

/* -------------------------------------------
 * Public (used by newer battle.ts)
 * -----------------------------------------*/
export function grantVirusRewards(user_id: string, virus_id: string): RewardsResult {
  const { xp, zenny, drops, leveledUp, xpTotal, levelAfter, nextThreshold } = coreRoll(user_id, virus_id);

  return {
    xp_gained: xp,
    xp_total_after: xpTotal,
    level_after: levelAfter,
    next_threshold: nextThreshold,
    zenny_gained: zenny,
    drops: drops.map(id => ({ item_id: id, qty: 1 })),
    leveledUp,
  };
}

/* -------------------------------------------
 * Legacy names (used by index.ts)
 * -----------------------------------------*/
export function rollRewards(user_id: string, virus_id: string): {
  xp: number;
  zenny: number;
  drops: string[];
  leveledUp: number;
} {
  const { xp, zenny, drops, leveledUp } = coreRoll(user_id, virus_id);
  return { xp, zenny, drops, leveledUp };
}

// Bosses live in viruses.tsv with boss=1. We still keep a separate name for clarity.
export function rollBossRewards(user_id: string, virus_id: string) {
  return rollRewards(user_id, virus_id);
}

/* -------------------------------------------
 * Core roll + apply
 * -----------------------------------------*/
function coreRoll(user_id: string, virus_id: string): {
  xp: number;
  zenny: number;
  drops: string[];
  leveledUp: number;
  xpTotal: number;
  levelAfter: number;
  nextThreshold: number;
} {
  const b = getBundle();

  // tolerate either b.viruses map or getVirusById fallback
  const v = (b as any).viruses?.[virus_id] || getVirusById(virus_id);
  const isBoss = !!(v as any)?.boss;

  // XP — always a concrete range
  const xpRange = parseRangeNonNull((v as any)?.xp_range, VIRUS_BASE_XP_RANGE);
  let xp = rollRange(xpRange);
  if (isBoss) xp = Math.max(1, Math.round(xp * BOSS_FALLBACK_XP_MULT));

  // Zenny — always a concrete range (no null into rollRange)
  const zFallback = isBoss ? BOSS_FALLBACK_ZENNY_RANGE : VIRUS_BASE_ZENNY_RANGE;
  const zennyRange = parseRangeNonNull((v as any)?.zenny_range, zFallback);
  const zenny = rollRange(zennyRange);

  // Apply zenny & XP (and compute leveled up)
  if (zenny > 0) addZenny(user_id, zenny);

  const beforeLevel = getPlayer(user_id)?.level ?? 1;
  const xpRes = addXP(user_id, xp);
  const leveledUp = Math.max(0, (xpRes?.level ?? beforeLevel) - beforeLevel);

  // Drops from drop table
  const drops = rollDropsForVirus(virus_id);

  // Grant chips
  for (const id of drops) grantChip(user_id, id, 1);

  return {
    xp,
    zenny,
    drops,
    leveledUp,
    xpTotal: xpRes?.xp_total ?? 0,
    levelAfter: xpRes?.level ?? beforeLevel,
    nextThreshold: xpRes?.next_threshold ?? 0,
  };
}

/* -------------------------------------------
 * Drops
 *
 * Your design (recommended):
 *  - Railway env VIRUS_CHIP_DROP_RATE controls IF a drop happens.
 *  - drop_tables.tsv entries choose WHAT drops.
 *
 * drop_tables.tsv format supported:
 *  - "ChipA,ChipB,ChipC"                => uniform weights
 *  - "ChipA:50,ChipB:5"                 => weighted selection (50 vs 5)
 *  - "ChipA:0.5,ChipB:0.1"              => fractional weights also supported
 * -----------------------------------------*/
type ParsedDrop = { id: string; weight: number };

function rollDropsForVirus(virus_id: string): string[] {
  const b = getBundle();
  const v = (b as any).viruses?.[virus_id] || getVirusById(virus_id);
  if (!v) return [];

  const isBoss = !!(v as any)?.boss;
  const tableId = String((v as any)?.drop_table_id ?? '').trim();
  if (!tableId) return [];

  const dt = getDropTableById(b, tableId);
  if (!dt) return [];

  const parsed = parseDropEntries(String((dt as any).entries ?? ''), b);
  if (parsed.length === 0) return [];

  // Chance that ANY drop happens
  const baseChance = isBoss
    ? (Number.isFinite(BOSS_CHIP_DROP_RATE) ? BOSS_CHIP_DROP_RATE : VIRUS_CHIP_DROP_RATE)
    : VIRUS_CHIP_DROP_RATE;

  const chance = clamp01(baseChance * GLOBAL_DROP_RATE_MULT);
  if (chance <= 0) return [];
  if (Math.random() >= chance) return [];

  const picked = weightedPick(parsed);
  return picked ? [picked] : [];
}

function parseDropEntries(entries: string, b: any): ParsedDrop[] {
  const chipsMap = (b as any).chips;
  const chipsArr = Array.isArray((b as any).chips) ? (b as any).chips : null;

  const hasChip = (id: string) => {
    if (!id) return false;
    if (chipsMap && typeof chipsMap === 'object' && !Array.isArray(chipsMap)) return !!chipsMap[id];
    if (chipsArr) return chipsArr.some((c: any) => String(c?.id ?? c?.name ?? '').trim() === id);
    return true; // if we can't verify, don't block
  };

  const out: ParsedDrop[] = [];
  const parts = entries
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  for (const p of parts) {
    const [idRaw, wRaw] = p.split(':').map(s => s?.trim());
    const id = String(idRaw ?? '').trim();
    if (!id) continue;
    if (!hasChip(id)) continue;

    let weight = 1;
    const n = Number(wRaw);
    if (Number.isFinite(n) && n > 0) weight = n;

    out.push({ id, weight });
  }

  return out;
}

function weightedPick(items: ParsedDrop[]): string | null {
  let total = 0;
  for (const it of items) total += Math.max(0, it.weight);
  if (!(total > 0)) return null;

  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(0, it.weight);
    if (r <= 0) return it.id;
  }
  return items[items.length - 1]?.id ?? null;
}

function getDropTableById(b: any, tableId: string): any | null {
  // Preferred: normalized map
  const map1 = (b as any).dropTables;
  if (map1 && typeof map1 === 'object' && !Array.isArray(map1)) return map1[tableId] ?? null;

  // Alternate: snake map
  const map2 = (b as any).drop_tables;
  if (map2 && typeof map2 === 'object' && !Array.isArray(map2)) return map2[tableId] ?? null;

  // Alternate: array of rows
  const arr = Array.isArray((b as any).drop_tables) ? (b as any).drop_tables
    : Array.isArray((b as any).dropTables) ? (b as any).dropTables
    : null;

  if (arr) return arr.find((x: any) => String(x?.id ?? '').trim() === tableId) ?? null;

  return null;
}

/* -------------------------------------------
 * Helpers
 * -----------------------------------------*/
function parseRangeNonNull(
  s: any,
  fallback: readonly [number, number]
): [number, number] {
  const text = String(s ?? '').trim();
  const m = text.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return [lo, hi];
  }
  return [fallback[0], fallback[1]];
}

function rollRange(range: [number, number] | readonly [number, number]) {
  const lo = range[0], hi = range[1];
  if (hi <= lo) return Math.max(0, lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function envFloat(k: string, d: number) {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
}
function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x; }
