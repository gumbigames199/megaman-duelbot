// src/lib/unlock.ts
import { db } from './db';
import { getBundle } from './data';

const START_REGION = process.env.START_REGION_ID || 'green_area';

db.exec(`
CREATE TABLE IF NOT EXISTS unlocked_regions (
  user_id   TEXT NOT NULL,
  region_id TEXT NOT NULL,
  PRIMARY KEY (user_id, region_id)
);
`);

const put = db.prepare(`INSERT OR IGNORE INTO unlocked_regions (user_id, region_id) VALUES (?, ?)`);
const all = db.prepare(`SELECT region_id FROM unlocked_regions WHERE user_id=? ORDER BY region_id`);

export function listUnlocked(userId: string): string[] {
  // ensure the start region is always present
  put.run(userId, START_REGION);
  const rows = all.all(userId) as Array<{ region_id: string }>;
  const out = rows.map(r => r.region_id);
  // de-dupe just in case
  return Array.from(new Set([START_REGION, ...out]));
}

export function unlockRegion(userId: string, regionId: string): boolean {
  const { regions } = getBundle();
  if (!regions[regionId]) return false;
  put.run(userId, regionId);
  return true;
}

/** Unlock neighbors listed in regions[next_region_ids] when you clear a region */
export function unlockNextFromRegion(userId: string, regionId: string): string[] {
  const { regions } = getBundle();
  const r = regions[regionId];
  if (!r) return [];
  const next = String(r.next_region_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const gained: string[] = [];
  for (const n of next) {
    const before = listUnlocked(userId);
    if (!before.includes(n) && unlockRegion(userId, n)) gained.push(n);
  }
  return gained;
}
