// src/lib/regions.ts
import { RNG } from './rng';
import { getBundle } from './data';

export type Encounter =
  | { kind: 'virus'; id: string }
  | { kind: 'boss';  id: string };

/**
 * Roll an encounter for a region (optionally filtered by zone).
 * - Respects region.encounter_rate (default 0.7).
 * - Has a rare boss chance if region.boss_id exists (default 2% via BOSS_ENCOUNTER_RATE).
 * - Otherwise picks a virus from the region's pool; if zone provided, prefers viruses with that zone.
 */
export function rollEncounter(regionId: string, zone?: number, seed?: number): Encounter | null {
  const { regions, virusPools, viruses } = getBundle();
  const r = regions[regionId];
  if (!r) return null;

  const rng = new RNG(seed ?? Date.now());

  // Region encounter gate
  const rate = Number(r.encounter_rate ?? 0.7);
  if (!rng.chance(rate)) return null;

  // Rare boss roll (if region defines one)
  const bossRate = Number(process.env.BOSS_ENCOUNTER_RATE ?? '0.02'); // 2% default
  if (r.boss_id && rng.chance(bossRate)) {
    return { kind: 'boss', id: r.boss_id };
  }

  // Virus pool roll
  const pool = virusPools[r.virus_pool_id];
  if (!pool) return null;

  const ids = String(pool.virus_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // If a zone was provided, try to filter by it; fall back to full list if filter would be empty
  const zoneFiltered = typeof zone === 'number'
    ? ids.filter(id => (viruses[id]?.zone ?? 1) === zone)
    : ids;

  const pickable = zoneFiltered.length ? zoneFiltered : ids;
  if (!pickable.length) return null;

  return { kind: 'virus', id: rng.pick(pickable) };
}
