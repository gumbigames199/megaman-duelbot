import { getBundle } from './data';
import { addZenny, grantChip } from './db';
import { RNG } from './rng';

function parseRange(s?: string): [number, number] {
  const m = String(s||'').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return [0, 0];
  const a = parseInt(m[1],10), b = parseInt(m[2],10);
  return [Math.min(a,b), Math.max(a,b)];
}

export function rollRewards(userId: string, virusId: string, seed?: number) {
  const { viruses, dropTables, chips } = getBundle();
  const v = viruses[virusId];
  const rng = new RNG(seed ?? Date.now());

  const [lo, hi] = parseRange(v?.zenny_range);
  const zenny = hi > lo
    ? rng.int(lo, hi)
    : Math.max(10, Math.floor((v?.hp ?? 80) / 5) + (v?.cr ?? 1) * 15);

  addZenny(userId, zenny);

  const drops: string[] = [];
  const table = v?.drop_table_id ? dropTables[v.drop_table_id] : null;
  if (table) {
    (table.entries || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
      const [id, pctStr] = entry.split(':').map(x=>x.trim());
      const pct = Number(pctStr || 0);
      if (chips[id] && rng.next() < (pct / 100)) {
        grantChip(userId, id, 1);
        drops.push(id);
      }
    });
  }
  return { zenny, drops };
}

export function rollBossRewards(userId: string, bossId: string) {
  const { bosses } = getBundle();
  const b = bosses[bossId];
  const zenny = Math.max(300, Math.floor((b?.hp ?? 800) / 2));
  addZenny(userId, zenny);
  const drops: string[] = [];
  if (b?.signature_chip_id) { grantChip(userId, b.signature_chip_id, 1); drops.push(b.signature_chip_id); }
  return { zenny, drops };
}
