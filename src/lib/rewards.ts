// src/lib/rewards.ts
import { getBundle } from './data';
import { db, getPlayer, addZenny, grantChip } from './db';

// ENV
const DROP_PCT = parseFloat(process.env.VIRUS_CHIP_DROP_PCT || '0.33'); // non-boss drop chance
const BOSS_DROP_PCT = parseFloat(process.env.BOSS_DROP_PCT || '1.0');   // boss drop chance (default guaranteed)

/** What callers expect back (index.ts shows these fields) */
export type RewardResult = {
  zenny: number;
  xp?: number;
  drops?: string[];    // chip display names
  leveledUp?: number;  // how many levels gained this grant
};

/** Simple XP curve: next level requirement grows gently with level */
function xpForNext(level: number): number {
  // Tunable: start 100, add linear + mild superlinear growth
  return Math.max(50, Math.floor(100 + 40 * (level - 1) + Math.pow(level, 1.35) * 8));
}

/** Apply XP and handle level-ups. Returns { xpGained, leveledUp } */
function applyXp(userId: string, gain: number): { xpGained: number; leveledUp: number } {
  if (!Number.isFinite(gain) || gain <= 0) return { xpGained: 0, leveledUp: 0 };

  const p: any = getPlayer(userId) || {};
  let level = Number(p.level ?? 1);
  let xp = Number(p.xp ?? 0) + gain;
  let ups = 0;

  while (xp >= xpForNext(level)) {
    xp -= xpForNext(level);
    level += 1;
    ups += 1;
  }

  // Persist (be tolerant if schema lacks xp/level; SQLite will error silently in dev logs if cols don't exist)
  try {
    db.prepare(`UPDATE players SET xp=?, level=? WHERE user_id=?`).run(xp, level, userId);
  } catch (e) {
    // If schema doesn't include xp/level yet, just ignore; caller checks level via getPlayer later.
    // console.warn('applyXp: xp/level columns missing', e);
  }
  return { xpGained: gain, leveledUp: ups };
}

/** Roll a chip from a CSV list of ids; return the chosen chip id or null */
function rollFromEntriesCSV(csv: string | undefined, rng: () => number = Math.random): string | null {
  if (!csv) return null;
  const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return null;
  const idx = Math.floor(rng() * ids.length);
  return ids[idx] || null;
}

function computeZenny(virus: any, boss: boolean): number {
  // Derive a value if not explicitly provided: based on stats with boss multiplier
  const hp = Number(virus?.hp ?? 80);
  const atk = Number(virus?.atk ?? 10);
  const def = Number(virus?.def ?? 6);
  const base = Math.max(20, Math.floor(hp / 4 + atk * 2 + def * 1.5));
  return boss ? Math.floor(base * 2.5) : base;
}

function computeXP(virus: any, boss: boolean): number {
  const hp = Number(virus?.hp ?? 80);
  const atk = Number(virus?.atk ?? 10);
  const def = Number(virus?.def ?? 6);
  const base = Math.max(10, Math.floor(hp / 6 + atk * 1.5 + def));
  return boss ? Math.floor(base * 2) : base;
}

/** Core drop logic for a given virus row and drop probability */
function rollDropsForVirus(userId: string, virus: any, pct: number): string[] {
  const { dropTables, chips } = getBundle() as any;
  const out: string[] = [];

  // Only roll if a drop table is linked and chance succeeds
  const dt = virus?.drop_table_id ? dropTables?.[virus.drop_table_id] : null;
  if (!dt) return out;

  if (Math.random() < pct) {
    const chosenId = rollFromEntriesCSV(dt.entries);
    if (chosenId && chips[chosenId]) {
      grantChip(userId, chosenId);
      const name = chips[chosenId]?.name || chosenId;
      out.push(name);
    }
  }
  return out;
}

/** Non-boss rewards: uniform drop chance (DROP_PCT), moderate zenny/xp */
export function rollRewards(userId: string, enemyVirusId: string): RewardResult {
  const { viruses } = getBundle() as any;
  const virus = viruses?.[enemyVirusId];

  const zenny = computeZenny(virus, false);
  addZenny(userId, zenny);

  const xpGain = computeXP(virus, false);
  const { leveledUp } = applyXp(userId, xpGain);

  const drops = rollDropsForVirus(userId, virus, DROP_PCT);

  return { zenny, xp: xpGain, drops, leveledUp };
}

/** Boss rewards: bigger zenny/xp, default guaranteed drop (BOSS_DROP_PCT) */
export function rollBossRewards(userId: string, enemyVirusId: string): RewardResult {
  const { viruses } = getBundle() as any;
  const virus = viruses?.[enemyVirusId];

  const zenny = computeZenny(virus, true);
  addZenny(userId, zenny);

  const xpGain = computeXP(virus, true);
  const { leveledUp } = applyXp(userId, xpGain);

  const drops = rollDropsForVirus(userId, virus, BOSS_DROP_PCT);

  return { zenny, xp: xpGain, drops, leveledUp };
}
