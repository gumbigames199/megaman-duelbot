// src/lib/regions.ts
import { getBundle } from './data';
import type { VirusRow } from './types';

/** Return 1..zone_count for a region (defaults to [1]) */
export function listZones(regionId: string): number[] {
  const r = getBundle().regions[regionId];
  const n = Math.max(1, Number(r?.zone_count ?? 1));
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** All non-boss viruses available for (region, zone) */
export function listVirusesForRegionZone(regionId: string, zone: number): VirusRow[] {
  const { viruses } = getBundle();
  return Object.values(viruses).filter((v: any) =>
    !v.boss && v.region === regionId && Array.isArray(v.zones) && v.zones.includes(zone)
  ) as VirusRow[];
}

/** Boss virus for (region, zone), or null if none configured */
export function getBossForRegionZone(regionId: string, zone: number): VirusRow | null {
  const { viruses } = getBundle();
  const boss = Object.values(viruses).find((v: any) =>
    !!v.boss && v.region === regionId && Array.isArray(v.zones) && v.zones.includes(zone)
  );
  return (boss as VirusRow) || null;
}

/**
 * Uniform encounter picker for a region/zone.
 * - If boss roll succeeds and a boss exists, returns that boss.
 * - Otherwise returns a uniformly random non-boss virus.
 *
 * @throws if no non-boss viruses are configured for the zone
 */
export function pickUniformEncounter(
  regionId: string,
  zone: number,
  bossChance = 0.0,
  bossRoll = Math.random()
): { enemy_kind: 'boss' | 'virus'; virus: VirusRow } {
  if (bossRoll < bossChance) {
    const boss = getBossForRegionZone(regionId, zone);
    if (boss) return { enemy_kind: 'boss', virus: boss };
  }

  const pool = listVirusesForRegionZone(regionId, zone);
  if (!pool.length) {
    throw new Error(`No non-boss viruses configured for ${regionId} zone ${zone}`);
  }
  const virus = pool[Math.floor(Math.random() * pool.length)];
  return { enemy_kind: 'virus', virus };
}
