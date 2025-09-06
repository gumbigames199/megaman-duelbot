// src/lib/unlock.ts
import { db, getPlayer } from './db';
import { getBundle } from './data';
import type { RegionRow } from './types';

// --- table ---
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

// --- helpers ---
function starterRegionId(): string {
  return process.env.START_REGION_ID || 'den_city';
}

function playerLevel(userId: string): number {
  const p: any = getPlayer(userId) || {};
  // support both xp/level schemas; default 1
  return Number(p.level ?? 1);
}

function eligibleRegionIdsForLevel(level: number): string[] {
  const { regions } = getBundle();
  const ids = Object.keys(regions).filter(id => {
    const r = regions[id];
    const minLv = Number(r?.min_level ?? 1);
    return level >= minLv;
  });
  // Always include starter (even if its min_level > level by data mistake)
  const start = starterRegionId();
  if (!ids.includes(start) && regions[start]) ids.push(start);
  return ids;
}

// --- public API ---

/** Ensure the starter region is unlocked for this user (idempotent). */
export function ensureStartUnlocked(userId: string): void {
  const start = starterRegionId();
  Q.add.run(userId, start);
}

/**
 * Return the list of unlocked regions as RegionRow objects.
 * This function also syncs unlocked_regions to include any regions
 * the player qualifies for by level (idempotent).
 */
export function listUnlocked(userId: string): RegionRow[] {
  ensureStartUnlocked(userId);

  const level = playerLevel(userId);
  const eligibleIds = eligibleRegionIdsForLevel(level);

  // sync DB rows for any newly-eligible regions
  for (const id of eligibleIds) Q.add.run(userId, id);

  const { regions } = getBundle();
  const out = eligibleIds
    .map(id => regions[id])
    .filter(Boolean) as RegionRow[];

  return out;
}

/**
 * Compute which regions *newly* unlocked based on current level,
 * persist them, and return their names (for notifications).
 */
export function diffNewlyUnlockedRegions(userId: string): string[] {
  const level = playerLevel(userId);
  const eligible = new Set(eligibleRegionIdsForLevel(level));

  const prev = new Set<string>(
    (Q.allForUser.all(userId) as any[]).map(r => r.region_id as string)
  );

  const newly: string[] = [];
  const { regions } = getBundle();

  for (const id of eligible) {
    if (!prev.has(id)) {
      Q.add.run(userId, id);
      const name = regions[id]?.name || id;
      newly.push(name);
    }
  }
  return newly;
}

/**
 * Back-compat: original code unlocked neighbors after a boss.
 * We now gate by level, so this is a harmless no-op returning [].
 */
export function unlockNextFromRegion(_userId: string, _regionId: string): string[] {
  return [];
}
