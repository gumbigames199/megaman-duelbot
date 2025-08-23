import { db, setRegion, getRegion } from './db';
import { getBundle } from './data';

db.exec(`
CREATE TABLE IF NOT EXISTS unlocked_regions (
  user_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  PRIMARY KEY (user_id, region_id)
);
`);

const qHas = db.prepare(`SELECT 1 FROM unlocked_regions WHERE user_id=? AND region_id=?`);
const qAdd = db.prepare(`INSERT OR IGNORE INTO unlocked_regions (user_id, region_id) VALUES (?,?)`);
const qList= db.prepare(`SELECT region_id FROM unlocked_regions WHERE user_id=? ORDER BY region_id`);

export function hasRegion(userId: string, regionId: string) {
  return !!qHas.get(userId, regionId);
}
export function unlockRegion(userId: string, regionId: string) {
  qAdd.run(userId, regionId);
}
export function listUnlocked(userId: string): string[] {
  return (qList.all(userId) as Array<{region_id:string}>).map(r=>r.region_id);
}

export function ensureStartUnlocked(userId: string) {
  const start = process.env.START_REGION_ID || 'den_city';
  unlockRegion(userId, start);
  if (!getRegion(userId)) setRegion(userId, start);
}

// Unlock next regions when a boss is beaten
export function unlockNextFromRegion(userId: string, currentRegionId: string) {
  const r = getBundle().regions[currentRegionId];
  const nexts = String(r?.next_region_ids || '').split(',').map(s=>s.trim()).filter(Boolean);
  for (const id of nexts) unlockRegion(userId, id);
  return nexts;
}
