// src/lib/regions.ts
import { getBundle } from './data';
import { RNG } from './rng';

export type Encounter = {
  kind: 'virus' | 'boss';
  id: string;        // virus_id or boss_id
  zone?: number;     // optional: zone the encounter came from
};

/**
 * Roll an encounter for a region/zone.
 * - Uses regions.tsv.encounter_rate (defaults to 0.7).
 * - If region.virus_pool_id is set, uses that pool; otherwise filters viruses by region id.
 * - If a boss_id exists on the region, you can optionally gate it by zone or add a small chance.
 */
export function rollEncounter(region_id: string, region_zone?: number): Encounter | null {
  const { regions, viruses, virusPools } = getBundle();
  const r = regions[region_id];
  if (!r) return null;

  const rng = new RNG();

  // Encounter check
  const rate = Number.isFinite(r.encounter_rate) ? Number(r.encounter_rate) : 0.7;
  if (!rng.chance(rate)) return null;

  // Build virus candidate list
  let candidates: string[] = [];

  if (r.virus_pool_id && virusPools[r.virus_pool_id]) {
    const ids = String(virusPools[r.virus_pool_id].virus_ids || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);
    candidates = ids.filter(id => {
      const v = viruses[id];
      if (!v) return false;
      if (v.region && v.region !== region_id) return false;
      if (typeof region_zone === 'number' && v.zone && v.zone > region_zone) return false;
      return true;
    });
  } else {
    // Fallback: all viruses that list this region (and not above the zone)
    candidates = Object.keys(viruses).filter(id => {
      const v = viruses[id];
      if (!v) return false;
      if (v.region && v.region !== region_id) return false;
      if (typeof region_zone === 'number' && v.zone && v.zone > region_zone) return false;
      return true;
    });
  }

  if (!candidates.length) return null;

  const virusId = rng.pick(candidates);
  return { kind: 'virus', id: virusId, zone: region_zone };
}
