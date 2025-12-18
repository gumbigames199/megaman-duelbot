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
  // Normalize keys to strings so "104" and 104 both work everywhere.
  const chipById   = new Map<string, ChipRow>(b.chips.map(c   => [String((c as any).id), c]));
  const virusById  = new Map<string, VirusRow>(b.viruses.map(v => [String((v as any).id), v]));
  const regionById = new Map<string, RegionRow>(b.regions.map(r => [String((r as any).id), r]));

  const shopsByRegion = new Map<string, ShopRow[]>();
  for (const s of b.shops) {
    const rid = String((s as any).region_id ?? '');
    const arr = shopsByRegion.get(rid) ?? [];
    arr.push(s);
    shopsByRegion.set(rid, arr);
  }
  return { chipById, virusById, regionById, shopsByRegion };
}
function indices(): Indices { return _indices ?? (_indices = buildIndices(getBundle())); }

export function getChipById(id: string | number)   { return indices().chipById.get(String(id)); }
export function getVirusById(id: string | number)  { return indices().virusById.get(String(id)); }
export function getRegionById(id: string | number) { return indices().regionById.get(String(id)); }

export function listRegions()  { return getBundle().regions; }
export function listChips()    { return getBundle().chips; }
export function listViruses()  { return getBundle().viruses; }

// Robust upgrade detector (handles is_upgrade / Is_Upgrade / true/false / 1/0 / "yes")
export function chipIsUpgrade(c: any): boolean {
  const raw = c?.is_upgrade ?? c?.Is_Upgrade ?? c?.isUpgrade ?? c?.upgrade;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number')  return raw === 1;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

export function listVirusesForRegionZone(opts: {
  region_id: string;
  zone: number;
  includeNormals?: boolean;
  includeBosses?: boolean;
}): VirusRow[] {
  const { region_id, zone, includeNormals = true, includeBosses = true } = opts;
  const wantRegion = String(region_id);
  return getBundle().viruses.filter(v => {
    const vRegion = String((v as any).region_id ?? (v as any).region ?? '');
    if (vRegion && vRegion !== wantRegion) return false;
    const isBoss = !!(v as any).is_boss || !!(v as any).boss;
    if (!includeBosses && isBoss) return false;
    if (!includeNormals && !isBoss) return false;
    const z = ((v as any).zones ?? []) as number[];
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
  return indices().shopsByRegion.get(String(region_id)) ?? [];
}

export function priceForShopItem(s: ShopRow, c: ChipRow): number {
  const override = Number.isFinite((s as any).price_override) ? Number((s as any).price_override) : 0;
  if (override && override > 0) return override;
  return Number.isFinite((c as any).zenny_cost) ? Number((c as any).zenny_cost) : 0;
}

export function resolveShopInventory(region_id: string): ResolvedShopItem[] {
  const rows = getShopsForRegion(region_id);
  const out: ResolvedShopItem[] = [];
  for (const s of rows) {
    const chip = getChipById((s as any).item_id);
    if (!chip) continue;
    out.push({
      region_id: String(region_id),
      item_id: String((chip as any).id),
      name: (chip as any).name ?? String((chip as any).id),
      zenny_price: priceForShopItem(s, chip),
      is_upgrade: chipIsUpgrade(chip),
      chip,
      shop_row: s,
    });
  }
  out.sort((a, b) => (a.name.localeCompare(b.name) || a.item_id.localeCompare(b.item_id)));
  return out;
}

// -------------------------------
// Virus art (robust fallbacks)
// -------------------------------
export function getVirusArt(virusId: string | number) {
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
