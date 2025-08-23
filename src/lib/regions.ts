// src/lib/regions.ts
import { RNG } from './rng';
import { getBundle } from './data';
import { db } from './db';

/** Default start region (env overrideable) */
const START_REGION = process.env.START_REGION_ID || 'den_city';

/** Ensure players.region_id exists; ignore if it already does. */
(function ensureRegionColumn() {
  try {
    db.exec(`ALTER TABLE players ADD COLUMN region_id TEXT`);
  } catch { /* column exists */ }
  try {
    // Backfill NULLs with START_REGION
    db.prepare(`UPDATE players SET region_id = COALESCE(region_id, ?) WHERE region_id IS NULL`).run(START_REGION);
  } catch { /* table will exist already in db.ts; safe to ignore here */ }
})();

/** Get a player's current region_id (or START_REGION if unset). */
export function getRegion(userId: string): string {
  const row = db.prepare(`SELECT region_id FROM players WHERE user_id=?`).get(userId) as { region_id?: string } | undefined;
  return row?.region_id || START_REGION;
}

/** Set a player's current region_id. */
export function setRegion(userId: string, regionId: string): void {
  db.prepare(`UPDATE players SET region_id=? WHERE user_id=?`).run(regionId, userId);
}

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
  if (!rng.chance(Number(r.encounter_rate ?? 0.7))) return null;

  // Virus pool
  const pool = virusPools[r.virus_pool_id];
  if (!pool) return null;

  // Parse virus IDs
  const ids = String(pool.virus_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) return null;

  return { virusId: rng.pick(ids) };
}
