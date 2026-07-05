// src/lib/unlock.ts
import { db, getPlayer } from './db';
import { getBundle } from './data';
import type { RegionRow } from './types';

db.exec(`
  CREATE TABLE IF NOT EXISTS unlocked_regions (
    user_id   TEXT NOT NULL,
    region_id TEXT NOT NULL,
    PRIMARY KEY (user_id, region_id)
  );
`);

const Q = {
  has: db.prepare(`SELECT 1 FROM unlocked_regions WHERE user_id=? AND region_id=?`),
  add: db.prepare(`INSERT OR IGNORE INTO unlocked_regions (user_id, region_id) VALUES (?,?)`),
  allForUser: db.prepare(`SELECT region_id FROM unlocked_regions WHERE user_id=?`),
};

function starterRegionId(): string {
  return process.env.START_REGION_ID || 'green_area';
}

function playerLevel(userId: string): number {
  const p: any = getPlayer(userId) || {};
  return Number(p.level ?? 1);
}

function eligibleRegionIdsForLevel(level: number): string[] {
  const { regions } = getBundle();
  const ids = Object.keys(regions).filter(id => level >= Number((regions as any)[id]?.min_level ?? 1));
  const start = starterRegionId();
  if (!ids.includes(start) && (regions as any)[start]) ids.push(start);
  return ids;
}

export function ensureStartUnlocked(userId: string): void {
  const start = starterRegionId();
  Q.add.run(userId, start);
}

export function listUnlocked(userId: string): RegionRow[] {
  ensureStartUnlocked(userId);

  const level = playerLevel(userId);
  const eligible = eligibleRegionIdsForLevel(level);
  for (const id of eligible) Q.add.run(userId, id);

  // Region access is strictly level-gated. Ignore any legacy/boss-unlocked rows
  // that are above the player's current level.
  const allowed = new Set(eligible.map(String));
  const { regions } = getBundle();
  return Array.from(allowed).map(id => (regions as any)[id]).filter(Boolean) as RegionRow[];
}

export function diffNewlyUnlockedRegions(userId: string): string[] {
  const level = playerLevel(userId);
  const eligible = new Set(eligibleRegionIdsForLevel(level));
  const prev = currentUnlockedSet(userId);
  const newly: string[] = [];
  const { regions } = getBundle();

  for (const id of eligible) {
    if (!prev.has(id)) {
      Q.add.run(userId, id);
      newly.push(String((regions as any)[id]?.name || id));
    }
  }
  return newly;
}

/** Boss progression is disabled. Regions unlock only by player level. */
export function unlockNextFromRegion(_userId: string, _regionId: string): string[] {
  return [];
}

function currentUnlockedSet(userId: string): Set<string> {
  ensureStartUnlocked(userId);
  return new Set((Q.allForUser.all(userId) as any[]).map(r => String(r.region_id)));
}

function nextRegionIds(cur: any, regions: Record<string, any>): string[] {
  const explicit = String(cur.next_region_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(id => !!regions[id]);
  if (explicit.length) return explicit;

  const curLevel = Number(cur.min_level ?? 0);
  const ordered = Object.values(regions)
    .filter((r: any) => String(r.id) !== String(cur.id))
    .filter((r: any) => Number(r.min_level ?? 0) > curLevel)
    .sort((a: any, b: any) => Number(a.min_level ?? 0) - Number(b.min_level ?? 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)));

  const first = ordered[0] as any;
  if (!first) return [];
  const min = Number(first.min_level ?? 0);
  return ordered.filter((r: any) => Number(r.min_level ?? 0) === min).map((r: any) => String(r.id));
}
