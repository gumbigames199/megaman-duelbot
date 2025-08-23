// src/lib/regions.ts
import { RNG } from './rng';
import { getBundle } from './data';

/**
 * Roll an encounter for the given region.
 * Returns a virusId if one is encountered, otherwise null.
 */
export function rollEncounter(regionId: string, seed?: number): { virusId: string } | null {
  const { regions, virusPools } = getBundle();
  const r = regions[regionId];
  if (!r) return null;

  const rng = new RNG(seed ?? Date.now());

  // Chance to encounter based on region's encounter_rate (default 0.7)
  if (!rng.chance(r.encounter_rate ?? 0.7)) return null;

  // Find virus pool
  const pool = virusPools[r.virus_pool_id];
  if (!pool) return null;

  // Parse virus IDs
  const ids = (pool.virus_ids || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) return null;

  return { virusId: rng.pick(ids) };
}
