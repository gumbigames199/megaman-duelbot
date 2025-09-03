// src/lib/unlock.ts
import { getBundle } from './data';
import { getSettings, setSetting } from './db';

const KEY = 'unlocked_regions';

function getSet(userId: string): Set<string> {
  const s = getSettings(userId) as Record<string, unknown>;
  const arr = Array.isArray(s[KEY]) ? (s[KEY] as string[]) : [];
  return new Set(arr);
}

function saveSet(userId: string, set: Set<string>) {
  const s = getSettings(userId) as Record<string, unknown>;
  s[KEY] = Array.from(set);
  setSetting(userId, KEY, s[KEY]);
}

/** List unlocked region IDs (guaranteed de-duped) */
export function listUnlocked(userId: string): string[] {
  return Array.from(getSet(userId));
}

/** True if a region is already unlocked */
export function isUnlocked(userId: string, regionId: string): boolean {
  return getSet(userId).has(regionId);
}

/** Unlock a single region (no-op if already unlocked). Returns true if newly added. */
export function unlockRegion(userId: string, regionId: string): boolean {
  const set = getSet(userId);
  const before = set.size;
  set.add(regionId);
  if (set.size !== before) saveSet(userId, set);
  return set.size !== before;
}

/**
 * Ensure the starting region is unlocked for this user.
 * Returns the full unlocked list after the operation.
 */
export function ensureStartUnlocked(userId: string): string[] {
  const start = process.env.START_REGION_ID || 'den_city';
  const set = getSet(userId);
  if (!set.has(start)) {
    set.add(start);
    saveSet(userId, set);
  }
  return Array.from(set);
}

/**
 * Ensure a specific region is unlocked (wrapper utility).
 * Returns true if it was newly unlocked.
 */
export function ensureRegionUnlocked(userId: string, regionId: string): boolean {
  return unlockRegion(userId, regionId);
}

/**
 * After beating a region’s boss (or other milestone), unlock its “next” regions.
 * Reads `next_region_ids` from TSV `regions.tsv` (comma/space separated).
 * Returns the list of region IDs that were newly unlocked.
 */
export function unlockNextFromRegion(userId: string, currentRegionId: string): string[] {
  const { regions } = getBundle();
  const cur = regions[currentRegionId];
  if (!cur) return [];

  const nextIds = String(cur.next_region_ids || '')
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!nextIds.length) return [];

  const set = getSet(userId);
  const newly: string[] = [];
  for (const id of nextIds) {
    if (!regions[id]) continue; // ignore unknown ids
    if (!set.has(id)) {
      set.add(id);
      newly.push(id);
    }
  }
  if (newly.length) saveSet(userId, set);
  return newly;
}
