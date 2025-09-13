// lib/rewards.ts
import { getBundle, getVirusById } from "./data";
import { grantChip, addZenny, addXP } from "./db";

const VIRUS_BASE_XP = envInt("VIRUS_BASE_XP", 20);
const BOSS_XP_MULTIPLIER = envFloat("BOSS_XP_MULTIPLIER", 4.0);
const VIRUS_ZENNY_MIN = envInt("VIRUS_ZENNY_MIN", 20);
const VIRUS_ZENNY_MAX = envInt("VIRUS_ZENNY_MAX", 60);
const BOSS_ZENNY_MIN = envInt("BOSS_ZENNY_MIN", 150);
const BOSS_ZENNY_MAX = envInt("BOSS_ZENNY_MAX", 300);
const GLOBAL_DROP_RATE_MULT = envFloat("GLOBAL_DROP_RATE_MULT", 1.0);

export type DropGrant = { item_id: string; qty: number };
export type RewardsResult = {
  xp_gained: number; xp_total_after: number; level_after: number; next_threshold: number;
  zenny_gained: number; zenny_balance_after?: number;
  drops: DropGrant[];
};

export function grantVirusRewards(user_id: string, virus_id: string): RewardsResult {
  const virus = getVirusById(virus_id);
  const isBoss = !!virus?.is_boss;

  const xp = computeXPForVirus(virus);
  const zenny = computeZennyForVirus(isBoss);

  if (zenny > 0) addZenny(user_id, zenny);
  const xpRes = addXP(user_id, xp);

  const drops = rollVirusDrops(virus_id);
  for (const d of drops) grantChip(user_id, d.item_id, d.qty);

  return {
    xp_gained: xp, xp_total_after: xpRes.xp_total, level_after: xpRes.level, next_threshold: xpRes.next_threshold,
    zenny_gained: zenny, drops,
  };
}

export function grantMissionRewards(user_id: string, opts: { zenny?: number; chip_ids?: string[]; }): RewardsResult {
  const z = Math.max(0, opts.zenny ?? 0);
  if (z > 0) addZenny(user_id, z);
  const drops: DropGrant[] = [];
  for (const id of opts.chip_ids ?? []) { grantChip(user_id, id, 1); drops.push({ item_id: id, qty: 1 }); }
  return { xp_gained: 0, xp_total_after: 0, level_after: 0, next_threshold: 0, zenny_gained: z, drops };
}

function computeXPForVirus(virus: ReturnType<typeof getVirusById>): number {
  if (!virus) return VIRUS_BASE_XP;
  const stats = [num((virus as any).hp), num((virus as any).atk), num((virus as any).def), num((virus as any).spd)].filter(n => n > 0);
  const avg = stats.length ? stats.reduce((a,b)=>a+b,0)/stats.length : 0;
  let xp = VIRUS_BASE_XP + Math.round(avg * 0.25);
  if ((virus as any).is_boss) xp = Math.round(xp * BOSS_XP_MULTIPLIER);
  return Math.max(1, xp);
}
function computeZennyForVirus(isBoss: boolean): number {
  const lo = isBoss ? BOSS_ZENNY_MIN : VIRUS_ZENNY_MIN;
  const hi = isBoss ? BOSS_ZENNY_MAX : VIRUS_ZENNY_MAX;
  if (hi <= lo) return Math.max(0, lo);
  return randInt(lo, hi);
}
function rollVirusDrops(virus_id: string): DropGrant[] {
  const b = getBundle();
  const out: DropGrant[] = [];
  for (const row of b.drop_tables) {
    const kind = String(row.source_kind ?? "virus").toLowerCase();
    if (kind !== "virus") continue;
    if (String(row.source_id ?? "") !== virus_id) continue;
    const rate = clamp01((Number(row.rate ?? 0)) * GLOBAL_DROP_RATE_MULT);
    if (rate <= 0) continue;
    if (randFloat() <= rate) {
      const item = String(row.item_id ?? "");
      if (item) out.push({ item_id: item, qty: 1 });
    }
  }
  return groupDrops(out);
}

function envInt(k:string,d:number){const v=process.env[k];const n=Number(v);return Number.isFinite(n)?Math.trunc(n):d;}
function envFloat(k:string,d:number){const v=process.env[k];const n=Number(v);return Number.isFinite(n)?n:d;}
function num(v:any){const n=Number(v);return Number.isFinite(n)?n:0;}
function clamp01(x:number){return x<0?0:x>1?1:x;}
function groupDrops(ds:DropGrant[]){if(ds.length<=1) return ds; const m=new Map<string,number>(); for(const d of ds){m.set(d.item_id,(m.get(d.item_id)||0)+d.qty);} return [...m].map(([item_id,qty])=>({item_id,qty}));}

// tiny RNG
function randFloat(){return Math.random();}
function randInt(a:number,b:number){return a + Math.floor(randFloat()*(b-a+1));}
