// src/lib/data.ts
import {
  getBundle as _getBundle,
  invalidateBundleCache as _invalidate,
  type DataBundle,
  type ChipRow,
  type VirusRow,
  type RegionRow,
  type ShopRow,
} from './tsv';

export function invalidateBundleCache() { _indices = null; _invalidate(); }

// Normalize bundle once per call so callers can rely on camelCase dropTables.
export function getBundle(): DataBundle {
  const b = _getBundle() as any;
  // Provide camelCase alias even if the TSV loader used snake_case.
  if (!('dropTables' in b)) {
    b.dropTables = b.drop_tables ?? {};
  }
  return b as DataBundle;
}

type Indices = {
  chipById: Map<string, ChipRow>;
  virusById: Map<string, VirusRow>;
  regionById: Map<string, RegionRow>;
  shopsByRegion: Map<string, ShopRow[]>;
};
let _indices: Indices | null = null;

function buildIndices(b: DataBundle): Indices {
  const chipById = new Map(b.chips.map(c => [c.id, c]));
  const virusById = new Map(b.viruses.map(v => [v.id, v]));
  const regionById = new Map(b.regions.map(r => [r.id, r]));
  const shopsByRegion = new Map<string, ShopRow[]>();
  for (const s of b.shops) {
    const arr = shopsByRegion.get(s.region_id) ?? [];
    arr.push(s);
    shopsByRegion.set(s.region_id, arr);
  }
  return { chipById, virusById, regionById, shopsByRegion };
}
function indices(): Indices { return _indices ?? (_indices = buildIndices(getBundle())); }

export function getChipById(id: string)   { return indices().chipById.get(id); }
export function getVirusById(id: string)  { return indices().virusById.get(id); }
export function getRegionById(id: string) { return indices().regionById.get(id); }

export function listRegions()  { return getBundle().regions; }
export function listChips()    { return getBundle().chips; }
export function listViruses()  { return getBundle().viruses; }

export function listVirusesForRegionZone(opts: {
  region_id: string;
  zone: number;
  includeNormals?: boolean;
  includeBosses?: boolean;
}): VirusRow[] {
  const { region_id, zone, includeNormals = true, includeBosses = true } = opts;
  return getBundle().viruses.filter(v => {
    if (v.region_id && v.region_id !== region_id) return false;
    const isBoss = !!(v as any).is_boss || !!(v as any).boss;
    if (!includeBosses && isBoss) return false;
    if (!includeNormals && !isBoss) return false;
    const z = (v.zones ?? []) as number[];
    return z.length === 0 || z.includes(zone);
  });
}

export type ResolvedShopItem = {
  region_id: string;
  item_id: string;
  name: string;
  zenny_price: number;
  is_upgrade: boolean;
  chip: ChipRow;
  shop_row: ShopRow;
};
export function getShopsForRegion(region_id: string): ShopRow[] {
  return indices().shopsByRegion.get(region_id) ?? [];
}
export function priceForShopItem(s: ShopRow, c: ChipRow): number {
  const override = Number.isFinite((s as any).price_override) ? (s as any).price_override as number : 0;
  if (override && override > 0) return override;
  return Number.isFinite((c as any).zenny_cost) ? (c as any).zenny_cost : 0;
}
export function resolveShopInventory(region_id: string): ResolvedShopItem[] {
  const rows = getShopsForRegion(region_id);
  const out: ResolvedShopItem[] = [];
  for (const s of rows) {
    const chip = getChipById(s.item_id);
    if (!chip) continue;
    out.push({
      region_id, item_id: chip.id, name: chip.name, zenny_price: priceForShopItem(s, chip),
      is_upgrade: !!(chip as any).is_upgrade, chip, shop_row: s,
    });
  }
  out.sort((a, b) => (a.name.localeCompare(b.name) || a.item_id.localeCompare(b.item_id)));
  return out;
}

// -------------------------------
// Virus art (robust fallbacks)
// -------------------------------
export function getVirusArt(virusId: string) {
  const v = getVirusById(virusId) as any;
  if (!v) return { fallbackEmoji: '⚔️' };

  // Prefer explicit art fields; fall back to common TSV column names.
  const image  = v.image || v.image_url || v.art_url || null;
  const sprite = v.sprite || v.sprite_url || v.icon_url || null;

  if (image || sprite) return { image, sprite, fallbackEmoji: '⚔️' };
  return { fallbackEmoji: '⚔️' };
}

export function reloadDataFromDisk(): DataBundle {
  invalidateBundleCache();
  const b = getBundle();
  _indices = buildIndices(b);
  return b;
}
