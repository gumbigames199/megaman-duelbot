// lib/encounter.ts
import { listVirusesForRegionZone, getRegionById } from "./data";
import { getPlayer } from "./db";

const BOSS_ENCOUNTER_PCT = clamp01Pct(envInt('BOSS_ENCOUNTER_PCT', envInt('BOSS_ENCOUNTER', 10)));
const DEFAULT_MAX_TRIES = 8;

export type EncounterPick = { virus_id: string; is_boss: boolean; region_id: string; zone: number; };

export function chooseEncounter(region_id: string, zone: number): EncounterPick | null {
  const normals = listVirusesForRegionZone({ region_id, zone, includeNormals: true,  includeBosses: false });
  const bosses  = listVirusesForRegionZone({ region_id, zone, includeNormals: false, includeBosses: true  });
  if (normals.length === 0 && bosses.length === 0) return null;
  const bossFirst = rollPct(BOSS_ENCOUNTER_PCT);
  const pick = bossFirst ? (pickFrom(bosses) ?? pickFrom(normals)) : (pickFrom(normals) ?? pickFrom(bosses));
  const v = pick ?? (bossFirst ? (pickFrom(normals) ?? pickFrom(bosses)) : (pickFrom(bosses) ?? pickFrom(normals)));
  if (!v) return null;
  return { virus_id: v.id, is_boss: !!(v as any).is_boss, region_id, zone };
}

export async function chooseEncounterWithRetry(region_id: string, zone: number, maxTries = DEFAULT_MAX_TRIES): Promise<EncounterPick> {
  for (let i=0;i<Math.max(1,maxTries);i++){ const hit = chooseEncounter(region_id, zone); if (hit) return hit; await delay(5); }
  throw new Error(`No eligible encounters for region=${region_id}, zone=${zone} after ${maxTries} attempts.`);
}

export async function chooseEncounterForPlayer(user_id: string): Promise<EncounterPick> {
  const p = getPlayer(user_id);
  const region_id = (p?.region_id ?? process.env.START_REGION_ID ?? 'den_city');
  let zone = 1;
  const region = getRegionById(region_id);
  if (region && Number.isFinite((region as any).zone_count)) zone = clampInt(zone, 1, Math.max(1, (region as any).zone_count));
  return chooseEncounterWithRetry(region_id, zone, DEFAULT_MAX_TRIES);
}

function pickFrom<T extends { id: string }>(arr: T[] | null | undefined){ if(!arr||arr.length===0)return null; const i=randInt(0,arr.length-1); return arr[i]; }
function rollPct(pct:number){ const n=Math.max(0,Math.min(100,Math.floor(pct))); return randInt(1,100) <= n; }
function envInt(k:string,d:number){ const v=process.env[k]; const n=Number(v); return Number.isFinite(n)?Math.trunc(n):d; }
function clamp01Pct(n:number){ return n<0?0:n>100?100:n; }
function clampInt(n:number,lo:number,hi:number){ return n<lo?lo:n>hi?hi:n; }
function delay(ms:number){ return new Promise(res=>setTimeout(res,Math.max(0,ms))); }
function randFloat(){ return Math.random(); }
function randInt(a:number,b:number){ return a + Math.floor(randFloat()*(b-a+1)); }
