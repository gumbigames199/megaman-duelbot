// data.ts
// Thin data access layer on top of tsv.ts
// - Re-exports getBundle/invalidateBundleCache
// - Provides indexed lookups (chips/viruses/regions)
// - Region/zone-aware virus queries
// - Shop inventory resolution with correct pricing:
//     price = price_override ?? chip.zenny_cost
//
// NOTE: Boss rarity / encounter selection logic should live in encounter.ts.
//       Here we only expose clean, typed data access helpers.

import {
  getBundle as _getBundle,
  invalidateBundleCache as _invalidate,
  type DataBundle,
  type ChipRow,
  type VirusRow,
  type RegionRow,
  type ShopRow,
} from "./tsv";

// -------------------------------
// Re-exports
// -------------------------------

export function invalidateBundleCache() {
  // clearing local indices too
  _indices = null;
  _invalidate();
}

export function getBundle(): DataBundle {
  return _getBundle();
}

// -------------------------------
// Local indices (lazy)
// -------------------------------

type Indices = {
  chipById: Map<string, ChipRow>;
  virusById: Map<string, VirusRow>;
  regionById: Map<string, RegionRow>;
  shopsByRegion: Map<string, ShopRow[]>;
};

let _indices: Indices | null = null;

function buildIndices(bundle: DataBundle): Indices {
  const chipById = new Map<string, ChipRow>();
  for (const c of bundle.chips) chipById.set(c.id, c);

  const virusById = new Map<string, VirusRow>();
  for (const v of bundle.viruses) virusById.set(v.id, v);

  const regionById = new Map<string, RegionRow>();
  for (const r of bundle.regions) regionById.set(r.id, r);

  const shopsByRegion = new Map<string, ShopRow[]>();
  for (const s of bundle.shops) {
    const arr = shopsByRegion.get(s.region_id) ?? [];
    arr.push(s);
    shopsByRegion.set(s.region_id, arr);
  }

  return { chipById, virusById, regionById, shopsByRegion };
}

function indices(): Indices {
  if (_indices) return _indices;
  _indices = buildIndices(getBundle());
  return _indices;
}

// -------------------------------
// Public getters
// -------------------------------

export function getChipById(id: string): ChipRow | undefined {
  return indices().chipById.get(id);
}

export function getVirusById(id: string): VirusRow | undefined {
  return indices().virusById.get(id);
}

export function getRegionById(id: string): RegionRow | undefined {
  return indices().regionById.get(id);
}

export function listRegions(): RegionRow[] {
  return getBundle().regions;
}

export function listChips(): ChipRow[] {
  return getBundle().chips;
}

export function listViruses(): VirusRow[] {
  return getBundle().viruses;
}

// -------------------------------
// Region / Zone helpers
// -------------------------------

/**
 * Returns all viruses eligible for the given region/zone.
 * - If virus.zones is empty, treat it as eligible for all zones in that region.
 * - You can filter bosses/normals via flags.
 */
export function listVirusesForRegionZone(opts: {
  region_id: string;
  zone: number;
  includeNormals?: boolean; // default true
  includeBosses?: boolean; // default true
}): VirusRow[] {
  const { region_id, zone, includeNormals = true, includeBosses = true } = opts;
  const all = getBundle().viruses;

  return all.filter((v) => {
    if (v.region_id && v.region_id !== region_id) return false;

    const isBoss = !!v.is_boss;
    if (!includeBosses && isBoss) return false;
    if (!includeNormals && !isBoss) return false;

    // zone gating: empty zones means "all zones"
    const z = v.zones ?? [];
    if (z.length === 0) return true;
    return z.includes(zone);
  });
}

// -------------------------------
// Shop helpers (pricing, inventory)
// -------------------------------

export type ResolvedShopItem = {
  region_id: string;
  item_id: string;               // chip id
  name: string;
  zenny_price: number;           // price_override ?? chip.zenny_cost
  is_upgrade: boolean;           // passthrough from chip
  chip: ChipRow;                 // full chip row
  shop_row: ShopRow;             // original shop row (for stock/rotation if used)
};

export function getShopsForRegion(region_id: string): ShopRow[] {
  return indices().shopsByRegion.get(region_id) ?? [];
}

export function resolveShopInventory(region_id: string): ResolvedShopItem[] {
  const { chipById } = indices();
  const rows = getShopsForRegion(region_id);
  const out: ResolvedShopItem[] = [];

  for (const s of rows) {
    const chipId = s.item_id;
    if (!chipId) continue;
    const chip = chipById.get(chipId);
    if (!chip) continue;

    const price = priceForShopItem(s, chip);
    out.push({
      region_id,
      item_id: chip.id,
      name: chip.name,
      zenny_price: price,
      is_upgrade: !!chip.is_upgrade,
      chip,
      shop_row: s,
    });
  }

  // Optional: stable by name then id for nice UI display
  out.sort((a, b) => (a.name.localeCompare(b.name) || a.item_id.localeCompare(b.item_id)));
  return out;
}

export function priceForShopItem(s: ShopRow, c: ChipRow): number {
  // Respect explicit override first; otherwise chip.zenny_cost.
  const override = Number.isFinite(s.price_override) ? s.price_override! : 0;
  if (override && override > 0) return override;
  return Number.isFinite(c.zenny_cost) ? c.zenny_cost : 0;
}

// -------------------------------
// Convenience queries for UI
// -------------------------------

export type BattleHeaderArt = {
  image?: string | undefined;
  sprite?: string | undefined;
  fallbackEmoji?: string; // UI can use this if no art present
};

/**
 * Returns art fields for a given virus to render in headers.
 * UI can decide which field to prefer (image/sprite) and fallback accordingly.
 */
export function getVirusArt(virusId: string): BattleHeaderArt {
  const v = getVirusById(virusId);
  if (!v) return { fallbackEmoji: "⚔️" };
  // Allow either image or sprite, depending on what your TSV provides
  return {
    image: (v as any).image,
    sprite: (v as any).sprite,
    fallbackEmoji: "⚔️",
  };
}

// -------------------------------
// Reload helper
// -------------------------------

/**
 * Force reload data from disk and rebuild indices.
 * Useful for your /reload_data command.
 */
export function reloadDataFromDisk(): DataBundle {
  invalidateBundleCache();
  const b = getBundle();
  _indices = buildIndices(b);
  return b;
}
