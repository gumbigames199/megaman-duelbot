import { getBundle } from './data';
import { addZenny, addXP, grantChip } from './db';

const VIRUS_BASE_XP = envInt('VIRUS_BASE_XP', 20);
const BOSS_XP_MULTIPLIER = envFloat('BOSS_XP_MULTIPLIER', 4.0);
const VIRUS_ZENNY_MIN = envInt('VIRUS_ZENNY_MIN', 20);
const VIRUS_ZENNY_MAX = envInt('VIRUS_ZENNY_MAX', 60);
const BOSS_ZENNY_MIN = envInt('BOSS_ZENNY_MIN', 150);
const BOSS_ZENNY_MAX = envInt('BOSS_ZENNY_MAX', 300);
const GLOBAL_DROP_RATE_MULT = envFloat('GLOBAL_DROP_RATE_MULT', 1.0);

type BasicResult = { zenny: number; xp: number; drops: string[]; leveledUp: number };

export function rollRewards(userId: string, virusId: string): BasicResult {
  const b = getBundle();
  const v = (b.viruses as any)[virusId] || {};
  const isBoss = !!(v.boss || v.is_boss);

  const xp = computeXP(v);
  const zenny = computeZenny(isBoss);
  if (zenny) addZenny(userId, zenny);
  const xpRes = addXP(userId, xp);

  const drops = rollDropsForVirus(virusId);
  for (const id of drops) grantChip(userId, id, 1);

  return { zenny, xp, drops, leveledUp: 0 /* simplified level delta */ };
}

export function rollBossRewards(userId: string, virusId: string): BasicResult {
  return rollRewards(userId, virusId);
}

function computeXP(v: any): number {
  const stats = [num(v.hp), num(v.atk), num(v.def), num(v.spd)].filter(n => n > 0);
  const avg = stats.length ? stats.reduce((a,b)=>a+b,0)/stats.length : 0;
  let xp = VIRUS_BASE_XP + Math.round(avg * 0.25);
  if (v.boss || v.is_boss) xp = Math.round(xp * BOSS_XP_MULTIPLIER);
  return Math.max(1, xp);
}

function computeZenny(isBoss: boolean): number {
  const lo = isBoss ? BOSS_ZENNY_MIN : VIRUS_ZENNY_MIN;
  const hi = isBoss ? BOSS_ZENNY_MAX : VIRUS_ZENNY_MAX;
  if (hi <= lo) return Math.max(0, lo);
  return randInt(lo, hi);
}

function rollDropsForVirus(virusId: string): string[] {
  const b = getBundle();
  const out: string[] = [];
  const table = (b as any).drop_tables ?? [];
  for (const row of table) {
    const kind = String(row.source_kind ?? 'virus').toLowerCase();
    if (kind !== 'virus') continue;
    if (String(row.source_id ?? '') !== virusId) continue;
    const rate = clamp01(Number(row.rate ?? 0) * GLOBAL_DROP_RATE_MULT);
    if (rate > 0 && Math.random() <= rate) {
      const item = String(row.item_id || '').trim();
      if (item) out.push(item);
    }
  }
  return out;
}

/* utils */
function envInt(k:string,d:number){const v=process.env[k];const n=Number(v);return Number.isFinite(n)?Math.trunc(n):d;}
function envFloat(k:string,d:number){const v=process.env[k];const n=Number(v);return Number.isFinite(n)?n:d;}
function num(v:any){const n=Number(v);return Number.isFinite(n)?n:0;}
function clamp01(x:number){return x<0?0:x>1?1:x;}
function randInt(a:number,b:number){return a + Math.floor(Math.random()*(b-a+1));}
