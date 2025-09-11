// src/lib/folder.ts
import { db, getInventory } from './db';
import { getBundle } from './data';

export const MAX_FOLDER = 30;
const DEFAULT_MAX_COPIES = 4;

const SINGLE_COPY_IDS = new Set(
  String(process.env.SINGLE_COPY_CHIPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// (Safe) ensure table exists; no-op if already created elsewhere.
db.exec(`
  CREATE TABLE IF NOT EXISTS folder (
    user_id TEXT NOT NULL,
    slot    INTEGER NOT NULL,
    chip_id TEXT NOT NULL,
    PRIMARY KEY (user_id, slot)
  );
`);

function readFolder(userId: string): string[] {
  const rows = db
    .prepare(`SELECT slot, chip_id FROM folder WHERE user_id=? ORDER BY slot ASC`)
    .all(userId) as any[];
  return rows.map(r => r.chip_id).filter(Boolean);
}

function writeFolder(userId: string, chips: string[]) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM folder WHERE user_id=?`).run(userId);
    const ins = db.prepare(`INSERT INTO folder (user_id, slot, chip_id) VALUES (?,?,?)`);
    chips.slice(0, MAX_FOLDER).forEach((id, i) => ins.run(userId, i + 1, id));
  });
  tx();
}

/** Cap logic used by both validator and UI. */
export function maxCopiesForChip(chipId: string): number {
  const c: any = getBundle().chips[chipId] || {};
  // explicit TSV override
  const tsvMax = Number(c.max_copies);
  if (Number.isFinite(tsvMax) && tsvMax > 0) return Math.min(4, Math.max(1, tsvMax));

  // “boss chip” or configured singletons
  const cat = String(c.category || '').toLowerCase();
  if (cat.includes('boss')) return 1;
  if (SINGLE_COPY_IDS.has(chipId)) return 1;

  return DEFAULT_MAX_COPIES;
}

/** Legacy getter some code still imports. */
export function getFolder(userId: string): string[] {
  return readFolder(userId);
}

/** Legacy setter some code still imports. */
export function setFolder(userId: string, chips: string[]): void {
  writeFolder(userId, chips);
}

/**
 * Legacy validator some code still imports.
 * - <= 30 chips
 * - no upgrades
 * - not more than owned in inventory
 * - not more than per-chip cap (max_copies/boss/special)
 */
export function validateFolder(
  userId: string,
  chips: string[]
): { ok: boolean; error?: string } {
  if (!Array.isArray(chips)) return { ok: false, error: 'Bad folder payload' };
  if (chips.length > MAX_FOLDER) return { ok: false, error: `Folder exceeds ${MAX_FOLDER}` };

  const bundle = getBundle();
  const invRows = getInventory(userId) as any[]; // [{chip_id, qty}]
  const inv = new Map<string, number>();
  for (const r of invRows) inv.set(r.chip_id, (inv.get(r.chip_id) || 0) + (Number(r.qty) || 0));

  const counts = new Map<string, number>();
  for (const id of chips) {
    const row: any = bundle.chips[id];
    if (!row) return { ok: false, error: `Unknown chip: ${id}` };

    // Upgrades are not playable chips
    if (row.is_upgrade) return { ok: false, error: `Upgrades cannot be added: ${row.name || id}` };

    const next = (counts.get(id) || 0) + 1;
    const cap = maxCopiesForChip(id);
    const own = inv.get(id) || 0;

    if (next > cap) return { ok: false, error: `Too many copies of ${row.name || id} (cap ${cap})` };
    if (next > own) return { ok: false, error: `Not enough inventory for ${row.name || id}` };

    counts.set(id, next);
  }

  return { ok: true };
}
