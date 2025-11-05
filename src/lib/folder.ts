// src/lib/folder.ts
// Central folder utilities used by both /folder command and Jack-In shop.
// - Single source of truth for MAX_FOLDER
// - Per-chip copy caps via chips.tsv (max_copies) with sane defaults
// - Validation helpers + convenience add/remaining funcs

import { getBundle } from './data';
import {
  listFolder as _listFolder,
  addToFolder as _addToFolder,
  listInventory,
  db,
} from './db';

const MAX_FOLDER = envInt('MAX_FOLDER', 30);
const DEFAULT_MAX_COPIES = envInt('DEFAULT_MAX_COPIES', 5);

export { MAX_FOLDER };

// ---------- public API ----------

/** Return the folder as a flat array of chip ids (duplicates included). */
export function getFolder(user_id: string): string[] {
  const rows = _listFolder(user_id); // [{chip_id, qty}]
  const out: string[] = [];
  for (const r of rows) {
    for (let i = 0; i < Math.max(0, r.qty); i++) out.push(r.chip_id);
  }
  return out;
}

/** Replace the entire folder with a new flat list of chip ids. */
export function setFolder(user_id: string, chips: string[]) {
  // Aggregate to {chip_id -> qty}
  const agg = new Map<string, number>();
  for (const id of chips) agg.set(id, (agg.get(id) || 0) + 1);

  const tx = db.transaction((uid: string) => {
    db.prepare(`DELETE FROM folder WHERE user_id = ?`).run(uid);
    for (const [chip_id, qty] of agg) {
      if (qty > 0) {
        db.prepare(`INSERT INTO folder (user_id, chip_id, qty) VALUES (?, ?, ?)`)
          .run(uid, chip_id, qty);
      }
    }
  });
  tx(user_id);
}

/** Validate a flat folder list. Ensures size/caps and disallows upgrades. */
export function validateFolder(user_id: string, chips: string[]): { ok: boolean; error?: string } {
  const b = getBundle();

  if (chips.length > MAX_FOLDER) {
    return { ok: false, error: `Folder exceeds ${MAX_FOLDER} slots.` };
  }

  // No upgrades allowed
  for (const id of chips) {
    const c: any = b.chips[id] || {};
    if (c.is_upgrade) return { ok: false, error: `Upgrades can't be placed in the folder (${c.name || id}).` };
  }

  // Per-chip caps (from TSV) and inventory sanity check (soft)
  const inv = new Map(listInventory(user_id).map(r => [r.chip_id, r.qty]));
  const counts = new Map<string, number>();
  for (const id of chips) counts.set(id, (counts.get(id) || 0) + 1);

  for (const [id, qty] of counts) {
    const cap = maxCopiesForChip(id);
    if (qty > cap) {
      return { ok: false, error: `Too many copies of ${displayName(id)}. Cap is ${cap}.` };
    }
    // If you only add via UI this is naturally enforced, but keep a friendly guard:
    const own = inv.get(id) ?? qty; // default assume ok if inventory not tracked
    if (qty > own) {
      return { ok: false, error: `You don't own enough copies of ${displayName(id)} (need ${qty}, have ${own}).` };
    }
  }

  return { ok: true };
}

/** Max copies allowed for a chip (TSV max_copies or DEFAULT_MAX_COPIES). Upgrades = 0. */
export function maxCopiesForChip(id: string): number {
  const b = getBundle();
  const c: any = b.chips[id] || {};
  if (c.is_upgrade) return 0;
  const n = Number(c.max_copies);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  return DEFAULT_MAX_COPIES;
}

/** How many free slots remain in the folder. */
export function getFolderRemaining(user_id: string): number {
  const cur = getFolder(user_id).length;
  return Math.max(0, MAX_FOLDER - cur);
}

/** Try to add qty copies of a chip, respecting caps and capacity. */
export function tryAddToFolder(user_id: string, chip_id: string, qty = 1): {
  ok: boolean;
  added: number;
  remaining: number; // slots remaining after add
  cap: number;       // per-chip cap used
  reason?: string;
} {
  const b = getBundle();
  const c: any = b.chips[chip_id] || {};
  if (!c) return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap: 0, reason: 'Unknown chip.' };
  if (c.is_upgrade) return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap: 0, reason: 'Upgrades can’t be added to the folder.' };

  const cap = maxCopiesForChip(chip_id);
  const current = getFolder(user_id).filter(id => id === chip_id).length;
  const canAddOfThis = Math.max(0, cap - current);
  if (canAddOfThis <= 0) {
    return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap, reason: `Reached cap of ${cap} for ${displayName(chip_id)}.` };
  }

  const free = getFolderRemaining(user_id);
  if (free <= 0) {
    return { ok: false, added: 0, remaining: 0, cap, reason: 'Folder is full.' };
  }

  const toAdd = Math.min(qty, canAddOfThis, free);
  if (toAdd <= 0) {
    return { ok: false, added: 0, remaining: free, cap, reason: 'No capacity to add.' };
  }

  _addToFolder(user_id, chip_id, toAdd);
  return { ok: true, added: toAdd, remaining: getFolderRemaining(user_id), cap };
}

// ---------- small helpers ----------

function envInt(k: string, d: number): number {
  const n = Number(process.env[k]); return Number.isFinite(n) ? Math.trunc(n) : d;
}
function displayName(id: string): string {
  const b = getBundle(); const c: any = b.chips[id] || {};
  return c.name || id;
}
