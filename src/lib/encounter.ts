// encounter.ts
// Encounter selection logic — STRICT to (region_id, zone).
// - Never widens to other zones or regions.
// - Never emits user-facing "no encounters" messages.
// - Internally retries selection a few times (in case boss roll conflicts with empty pools).
//
// Public API:
//   chooseEncounter(region_id: string, zone: number): EncounterPick | null   (sync, single pass with safety checks)
//   chooseEncounterWithRetry(region_id: string, zone: number, maxTries=8): Promise<EncounterPick>  (async, silent retries)
//   chooseEncounterForPlayer(user_id: string): Promise<EncounterPick>        (uses player's region, clamps zone to region bounds)
//
// Notes:
// - Zone handling: a virus with empty zones[] is considered eligible for ALL zones in that region (see data.ts).
// - Boss rarity: controlled by env BOSS_ENCOUNTER_PCT (0–100). If boss pool is empty, we fall back to normals (and vice versa).
// - If both boss and normal pools are truly empty for the requested (region, zone), we keep retrying silently up to maxTries,
//   then return null to caller. Callers should use the async helpers which already retry and only throw if still null.

import { rngInt } from './rng';
import {
  listVirusesForRegionZone,
  getRegionById,
} from './data';
import { getPlayer } from './db';

// -------------------------------
// Config
// -------------------------------

const BOSS_ENCOUNTER_PCT = clamp01Pct(envInt('BOSS_ENCOUNTER_PCT', envInt('BOSS_ENCOUNTER', 10))); // legacy var support
const DEFAULT_MAX_TRIES = 8;

// -------------------------------
// Types
// -------------------------------

export type EncounterPick = {
  virus_id: string;
  is_boss: boolean;
  region_id: string;
  zone: number;
};

// -------------------------------
// Public API
// -------------------------------

/**
 * Single-pass chooser confined to (region_id, zone).
 * Returns null only if there are truly no eligible viruses in that exact bucket.
 */
export function chooseEncounter(region_id: string, zone: number): EncounterPick | null {
  // Build pools once for this exact (region, zone)
  const normals = listVirusesForRegionZone({ region_id, zone, includeNormals: true,  includeBosses: false });
  const bosses  = listVirusesForRegionZone({ region_id, zone, includeNormals: false, includeBosses: true  });

  // If both empty, nothing can be picked here.
  if (normals.length === 0 && bosses.length === 0) {
    // Silent failure (no user notification) — caller should retry later or handle null.
    return null;
  }

  // Decide which pool to try first based on boss roll
  const tryBossFirst = rollPct(BOSS_ENCOUNTER_PCT);

  // Attempt pick respecting priority, but strictly within these two pools
  const pick = tryBossFirst
    ? (pickFromPool(bosses)  ?? pickFromPool(normals))
    : (pickFromPool(normals) ?? pickFromPool(bosses));

  if (!pick) {
    // If our priority order found nothing (e.g., bossFirst but bosses empty), flip order once
    const fallback = tryBossFirst
      ? (pickFromPool(normals) ?? pickFromPool(bosses))
      : (pickFromPool(bosses)  ?? pickFromPool(normals));

    if (!fallback) {
      // Shouldn't happen given earlier check, but stay safe & silent.
      return null;
    }
    return { virus_id: fallback.id, is_boss: !!(fallback as any).is_boss, region_id, zone };
  }

  return { virus_id: pick.id, is_boss: !!(pick as any).is_boss, region_id, zone };
}

/**
 * Async helper: silently retries within the SAME (region, zone) up to maxTries.
 * Never widens scope; never notifies the user. Throws only if still null after retries.
 */
export async function chooseEncounterWithRetry(
  region_id: string,
  zone: number,
  maxTries = DEFAULT_MAX_TRIES
): Promise<EncounterPick> {
  for (let i = 0; i < Math.max(1, maxTries); i++) {
    const hit = chooseEncounter(region_id, zone);
    if (hit) return hit;

    // Small micro-delay to allow for any concurrent data reloads (no-op if none)
    // Not strictly necessary; keep ultra short to avoid UX impact.
    await microDelay(5);
  }
  // Final failure stays internal; upstream can decide what to do (e.g., log & re-trigger)
  throw new Error(`No eligible encounters for region=${region_id}, zone=${zone} after ${maxTries} attempts.`);
}

/**
 * Player-oriented helper with safe zone clamp to region bounds. Uses retry helper.
 */
export async function chooseEncounterForPlayer(user_id: string): Promise<EncounterPick> {
  const p = getPlayer(user_id);
  const region_id = (p?.region_id ?? process.env.START_REGION_ID ?? 'den_city');

  // Clamp zone to region bounds; default zone 1
  let zone = 1;
  const region = getRegionById(region_id);
  if (region && Number.isFinite(region.zone_count)) {
    zone = clampInt(zone, 1, Math.max(1, (region.zone_count as number)));
  }

  return chooseEncounterWithRetry(region_id, zone, DEFAULT_MAX_TRIES);
}

// -------------------------------
// Internals
// -------------------------------

function pickFromPool<T extends { id: string }>(arr: T[] | undefined | null): T | null {
  if (!arr || arr.length === 0) return null;
  const idx = rngInt(0, arr.length - 1);
  return arr[idx];
}

function rollPct(pct0to100: number): boolean {
  const n = Math.max(0, Math.min(100, Math.floor(pct0to100)));
  const r = rngInt(1, 100);
  return r <= n;
}

function envInt(key: string, d: number): number {
  const v = process.env[key];
  if (v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function clamp01Pct(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function microDelay(ms: number) {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}
