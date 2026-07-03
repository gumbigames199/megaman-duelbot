// src/lib/folder.ts
// Central folder utilities used by both /folder command and Jack-In shop.
// - Single source of truth for MAX_FOLDER
// - Per-chip copy caps via chips.tsv (max_copies) with sane defaults
// - Validation helpers + convenience add/remaining funcs

import { getBundle, chipIsUpgrade, chipBaseId, formatChipName } from './data';
import {
  listFolder as _listFolder,
  addToFolder as _addToFolder,
  listInventory,
  db,
} from './db';

const MAX_FOLDER = envInt('MAX_FOLDER', 30);
const MIN_FOLDER = envInt('MIN_FOLDER', 20);
const DEFAULT_MAX_COPIES = envInt('DEFAULT_MAX_COPIES', 5);

export { MAX_FOLDER, MIN_FOLDER };

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

  // No upgrades allowed (STRICT: handles "0"/"1" correctly)
  for (const id of chips) {
    const c: any = b.chips[id] || {};
    if (chipIsUpgrade(c)) {
      return { ok: false, error: `Upgrades can't be placed in the folder (${c.name || id}).` };
    }
  }

  // Per-chip caps (from TSV) and inventory sanity check (soft)
  const inv = new Map(listInventory(user_id).map(r => [r.chip_id, r.qty]));
  const exactCounts = new Map<string, number>();
  const baseCounts = new Map<string, number>();
  for (const id of chips) {
    const c: any = b.chips[id] || {};
    const base = chipBaseId(c || id) || id;
    exactCounts.set(id, (exactCounts.get(id) || 0) + 1);
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }

  // Exact ownership check.
  for (const [id, qty] of exactCounts) {
    const own = inv.get(id) ?? qty; // default assume ok if inventory not tracked
    if (qty > own) {
      return { ok: false, error: `You don't own enough copies of ${displayName(id)} (need ${qty}, have ${own}).` };
    }
  }

  // BN-like copy cap is by base chip name, not by each code variant.
  for (const [base, qty] of baseCounts) {
    const representativeId = chips.find(id => chipBaseId(b.chips[id] || id) === base) || base;
    const cap = maxCopiesForChip(representativeId);
    if (qty > cap) {
      return { ok: false, error: `Too many copies of ${displayName(representativeId)} variants. Cap is ${cap}.` };
    }
  }

  return { ok: true };
}


/** Total owned non-upgrade BattleChip copies. */
export function getOwnedBattleChipQty(user_id: string): number {
  const b = getBundle();
  let total = 0;
  for (const row of listInventory(user_id)) {
    const chip: any = b.chips[row.chip_id] || {};
    if (!chip || chipIsUpgrade(chip)) continue;
    total += Math.max(0, Number(row.qty) || 0);
  }
  return total;
}

/** Exact copies of a chip currently committed to the folder. */
export function getFolderChipQty(user_id: string, chip_id: string): number {
  const id = String(chip_id);
  return getFolder(user_id).filter(x => String(x) === id).length;
}

/** Owned copies that are not currently committed to the folder. */
export function getAvailableChipQty(user_id: string, chip_id: string): number {
  const id = String(chip_id);
  const row = listInventory(user_id).find(r => String(r.chip_id) === id);
  const owned = Math.max(0, Number(row?.qty ?? 0) || 0);
  const inFolder = getFolderChipQty(user_id, id);
  return Math.max(0, owned - inFolder);
}

/** The 20-chip minimum only applies once the player owns enough chips to legally meet it. */
export function shouldEnforceMinFolder(user_id: string): boolean {
  return MIN_FOLDER > 0 && getOwnedBattleChipQty(user_id) >= MIN_FOLDER;
}

export function getMaxRemovableFolderSlots(user_id: string, currentSize = getFolder(user_id).length): number {
  if (!shouldEnforceMinFolder(user_id)) return Math.max(0, currentSize);
  return Math.max(0, currentSize - MIN_FOLDER);
}

export function validateFolderMinimum(user_id: string, chips: string[]): { ok: boolean; error?: string } {
  if (!shouldEnforceMinFolder(user_id)) return { ok: true };
  if (chips.length < MIN_FOLDER) {
    return { ok: false, error: `Folder must contain at least ${MIN_FOLDER} chips.` };
  }
  return { ok: true };
}

/** Max copies allowed for a chip (TSV max_copies or DEFAULT_MAX_COPIES). Upgrades = 0. */
export function maxCopiesForChip(id: string): number {
  const b = getBundle();
  const c: any = b.chips[id] || {};
  if (chipIsUpgrade(c)) return 0;

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
  const c: any = b.chips[chip_id] || null;

  if (!c) {
    return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap: 0, reason: 'Unknown chip.' };
  }
  if (chipIsUpgrade(c)) {
    return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap: 0, reason: 'Upgrades can’t be added to the folder.' };
  }

  const cap = maxCopiesForChip(chip_id);
  const base = chipBaseId(c || chip_id) || chip_id;
  const current = getFolder(user_id).filter(id => {
    const fc: any = b.chips[id] || {};
    return (chipBaseId(fc || id) || id) === base;
  }).length;
  const canAddOfThis = Math.max(0, cap - current);
  if (canAddOfThis <= 0) {
    return { ok: false, added: 0, remaining: getFolderRemaining(user_id), cap, reason: `Reached cap of ${cap} for ${displayName(chip_id)} variants.` };
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
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function displayName(id: string): string {
  const b = getBundle();
  const c: any = b.chips[id] || {};
  return formatChipName(c || id);
}
