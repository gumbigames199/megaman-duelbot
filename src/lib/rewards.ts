// src/lib/rewards.ts
import { getBundle } from './data';
import { RNG } from './rng';

/** Standard virus rewards (zenny + optional chip from drop table). */
export function rollRewards(userId: string, virusId: string) {
  const { viruses, dropTables } = getBundle();
  const v = viruses[virusId];
  const rng = new RNG();

  // zenny from "10-30" style range
  const [lo, hi] = String(v?.zenny_range ?? '0-0').split('-').map(x => Number(x) || 0);
  const zenny = lo + Math.floor(rng.float() * Math.max(0, hi - lo + 1));

  // drops from virus drop_table_id
  const drops: string[] = [];
  const dt = v?.drop_table_id ? dropTables[v.drop_table_id] : undefined;
  if (dt && dt.entries) {
    // parse "chipA:2, chipB:1"
    const pool = String(dt.entries).split(',').map(s => s.trim()).filter(Boolean);
    const expanded: string[] = [];
    for (const entry of pool) {
      const [id, wStr] = entry.split(':').map(s => s.trim());
      const w = Math.max(1, Number(wStr) || 1);
      for (let i = 0; i < w; i++) expanded.push(id);
    }
    if (expanded.length) {
      const rate = Number(process.env.VIRUS_CHIP_DROP_RATE) || 0.33;
      if (rng.float() < rate) {
        drops.push(expanded[Math.floor(rng.float() * expanded.length)]);
      }
    }
  }

  return { zenny, drops };
}

/** Boss rewards are separate from virus rewards. */
export function rollBossRewards(userId: string, bossId: string) {
  const { bosses } = getBundle();
  const b = bosses[bossId];
  const rng = new RNG();

  // simple zenny based on CR (tune as needed)
  const base = Math.max(1, Number(b?.cr || 10));
  const zenny = 50 * base + Math.floor(rng.float() * 25 * base);

  // boss drops: prefer signature chip if present
  const drops: string[] = [];
  if (b?.signature_chip_id) drops.push(b.signature_chip_id);

  return { zenny, drops };
}
