// src/lib/rewards.ts
import { getBundle } from './data';
import { addZenny, addXP, grantChip } from './db';
import { RNG } from './rng';

// helpers
function pickRange(rng: RNG, range: string, def = 0) {
  const m = String(range || '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return def;
  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return def;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return lo + Math.floor(rng.next() * (hi - lo + 1));
}

function rollDrop(rng: RNG, tableId: string): string[] {
  const dt = getBundle().dropTables[tableId];
  if (!dt) return [];
  const items = String(dt.entries || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(tok => {
      const [id, wStr] = tok.split(':').map(x => x.trim());
      const w = Number(wStr || '1');
      return { id, w: Number.isFinite(w) ? Math.max(0, w) : 1 };
    }).filter(x => x.id);

  const total = items.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return [];

  // single roll for now
  let r = rng.int(1, total);
  for (const it of items) {
    if ((r -= it.w) <= 0) return [it.id];
  }
  return [];
}

export function rollRewards(userId: string, virusId: string) {
  const b = getBundle();
  const v = b.viruses[virusId];
  const rng = new RNG();

  const zenny = pickRange(rng, v?.zenny_range || '0-0', 0);
  if (zenny > 0) addZenny(userId, zenny);

  const xp = pickRange(rng, (v as any)?.xp_range || '0-0', 0);
  const xpRes = xp > 0 ? addXP(userId, xp) : { level: 0, exp: 0, leveledUp: 0 };

  const drops = v?.drop_table_id ? rollDrop(rng, v.drop_table_id) : [];
  for (const id of drops) grantChip(userId, id, 1);

  return { zenny, xp, leveledUp: xpRes.leveledUp, drops };
}

export function rollBossRewards(userId: string, bossId: string) {
  const b = getBundle();
  const boss = (b.bosses && b.bosses[bossId]) || b.viruses[bossId]; // allow boss row or virus row flagged as boss
  const rng = new RNG();

  // bump ranges a bit for bosses if not explicitly set
  const zenny = pickRange(rng, boss?.zenny_range || '800-1500', 1000);
  if (zenny > 0) addZenny(userId, zenny);

  const xp = pickRange(rng, (boss as any)?.xp_range || '900-1800', 1200);
  const xpRes = xp > 0 ? addXP(userId, xp) : { level: 0, exp: 0, leveledUp: 0 };

  const drops = boss?.drop_table_id ? rollDrop(rng, boss.drop_table_id) : [];
  for (const id of drops) grantChip(userId, id, 1);

  return { zenny, xp, leveledUp: xpRes.leveledUp, drops };
}
