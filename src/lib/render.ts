// src/lib/rewards.ts
import { getBundle, getVirusById } from './data';
import { addZenny, addXP, grantChip, getPlayer } from './db';

const GLOBAL_DROP_RATE_MULT = envFloat('GLOBAL_DROP_RATE_MULT', 1.0);

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

export function grantVirusRewards(user_id: string, virus_id: string): RewardsResult {
  const { xp, zenny, drops, leveledUp, xpTotal, levelAfter, nextThreshold } =
    coreRoll(user_id, virus_id);

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

export function rollRewards(user_id: string, virus_id: string): {
  xp: number;
  zenny: number;
  drops: string[];
  leveledUp: number;
} {
  const { xp, zenny, drops, leveledUp } = coreRoll(user_id, virus_id);
  return { xp, zenny, drops, leveledUp };
}

export function rollBossRewards(user_id: string, virus_id: string) {
  return rollRewards(user_id, virus_id);
}

function coreRoll(user_id: string, virus_id: string) {
  const b = getBundle();
  const v = (b.viruses as any)[virus_id] || getVirusById(virus_id);
  const isBoss = !!(v as any)?.boss;

  // XP — always non-null range
  const xpRange = parseRangeNonNull((v as any)?.xp_range, VIRUS_BASE_XP_RANGE);
  let xp = rollRange(xpRange);
  if (isBoss) xp = Math.max(1, Math.round(xp * BOSS_FALLBACK_XP_MULT));

  // Zenny — always non-null range
  const zFallback = isBoss ? BOSS_FALLBACK_ZENNY_RANGE : VIRUS_BASE_ZENNY_RANGE;
  const zennyRange = parseRangeNonNull((v as any)?.zenny_range, zFallback);
  const zenny = rollRange(zennyRange);

  if (zenny > 0) addZenny(user_id, zenny);

  const beforeLevel = getPlayer(user_id)?.level ?? 1;
  const xpRes = addXP(user_id, xp);
  const leveledUp = Math.max(0, (xpRes?.level ?? beforeLevel) - beforeLevel);

  const drops = rollDropsForVirus(virus_id);
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

function rollDropsForVirus(virus_id: string): string[] {
  const b = getBundle() as any;
  const v = b.viruses[virus_id];
  const tableId = v?.drop_table_id;

  const allTables = b.dropTables ?? b.drop_tables ?? {};
  const dt = tableId ? allTables[tableId] : null;
  if (!dt) return [];

  const entries = String(dt.entries || '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const won: string[] = [];
  for (const e of entries) {
    const [idRaw, rateRaw] = e.split(':').map((s: string) => s?.trim());
    const id = idRaw || '';
    if (!id) continue;

    const baseRate = Number(rateRaw);
    const rate = clamp01(
      Number.isFinite(baseRate) ? baseRate * GLOBAL_DROP_RATE_MULT : 0
    );

    if (rate > 0 && Math.random() < rate) won.push(id);
  }
  return won;
}

// Helpers

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
  const v = Number(process.env[k]); return Number.isFinite(v) ? v : d;
}
function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x; }
