// src/lib/regions.ts
import { getBundle } from './data';
import { RNG } from './rng';

export type Encounter = {
  kind: 'virus' | 'boss';
  id: string;         // virus id or boss id
  zone?: number;      // the zone the roll happened in (if provided)
};

/**
 * Roll an encounter for a region/zone using the data bundle.
 * - Returns { kind, id, zone? } or null if nothing spawns.
 * - region_id must be a string TSV id (e.g. "den_city").
 * - region_zone is optional; defaults to 1 when filtering zone-gated viruses.
 */
export function rollEncounter(region_id: string, region_zone?: number): Encounter | null {
  const rng = new RNG();
  const { regions, viruses, virusPools, bosses } = getBundle();

  const region = regions[region_id];
  if (!region) return null;

  const zone = Math.max(1, Number(region_zone || 1));

  // 1) Encounter gate (region-based)
  const encounterRate = Number.isFinite(region.encounter_rate)
    ? Number(region.encounter_rate)
    : 0.7;
  if (rng.float() > encounterRate) return null;

  // 2) Optional boss chance (disabled by default unless env set)
  //    You can tune this via BOSS_CHANCE=0.05 (5%) in .env, or leave 0.
  const bossChance = Math.max(0, Math.min(1, Number(process.env.BOSS_CHANCE || 0)));
  if (bossChance > 0 && region.boss_id && bosses[region.boss_id] && rng.float() < bossChance) {
    return { kind: 'boss', id: region.boss_id, zone };
  }

  // 3) Virus pool:
  //    Prefer region.virus_pool_id; if missing, fall back to all viruses tagged to this region.
  let candidateVirusIds: string[] = [];

  if (region.virus_pool_id && virusPools[region.virus_pool_id]) {
    const pool = String(virusPools[region.virus_pool_id].virus_ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // If your pool doesn’t pre-filter by zone, do it here based on the VirusRow.zone field.
    candidateVirusIds = pool.filter(id => {
      const v = viruses[id];
      if (!v) return false;
      // If a virus has a zone number, require exact match; otherwise allow it everywhere.
      return v.zone ? Number(v.zone) === zone : true;
    });
  } else {
    // Fallback: everything with v.region === region_id and zone match
    candidateVirusIds = Object.keys(viruses).filter(id => {
      const v = viruses[id];
      if (!v) return false;
      if (v.region !== region_id) return false;
      return v.zone ? Number(v.zone) === zone : true;
    });
  }

  if (candidateVirusIds.length === 0) {
    // No valid viruses for this zone/region
    return null;
  }

  const pick = candidateVirusIds[Math.floor(rng.float() * candidateVirusIds.length)];
  return { kind: 'virus', id: pick, zone };
}
