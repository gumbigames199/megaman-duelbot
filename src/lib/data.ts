// src/lib/data.ts
import {
  getBundle as _getBundle,
  invalidateBundleCache as _invalidate,
} from './tsv';

/**
 * Normalized bundle shape used by the rest of the game.
 * - chips/viruses/regions are id-keyed maps (so commands can do b.chips[id])
 * - dropTables is an id-keyed map (so rewards can do dropTables[tableId])
 * - shopsByRegion is computed by exploding shops.tsv "entries" into per-item rows
 */
export type NormalizedBundle = {
  // id-keyed maps
  chips: Record<string, any>;
  viruses: Record<string, any>;
  regions: Record<string, any>;
  dropTables: Record<string, any>;
  missions: Record<string, any>;
  programAdvances: Record<string, any>;

  // raw lists (sometimes handy)
  chip_list: any[];
  virus_list: any[];
  region_list: any[];
  shop_list: any[];

  // computed
  shopsByRegion: Map<string, ShopItemRow[]>;
};

export function invalidateBundleCache() {
  _norm = null;
  _rawRef = null;
  _invalidate();
}

let _rawRef: any | null = null;
let _norm: NormalizedBundle | null = null;

export function getBundle(): NormalizedBundle {
  const raw = _getBundle() as any;
  if (_norm && _rawRef === raw) return _norm;
  _rawRef = raw;
  _norm = normalizeRawBundle(raw);
  return _norm;
}

/* ---------------------------------------------
 * Helpers
 * -------------------------------------------*/

function toBoolLoose(v: any): boolean {
  // Loose coercion (used only where we truly want it).
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/**
 * STRICT upgrade flag:
 * Your TSV uses 0/1. We only treat "1"/1/true as upgrade.
 * This fixes /folder accidentally treating everything as upgrades.
 */
export function chipIsUpgrade(c: any): boolean {
  if (!c) return false;
  const raw =
    c.is_upgrade ??
    c.isUpgrade ??
    c.Is_Upgrade ??
    c.upgrade ??
    c.Upgrade;

  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;

  const s = String(raw ?? '').trim().toLowerCase();
  return s === '1' || s === 'true';
}

function parseZones(raw: any): number[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(raw.map((x) => Number(x)).filter((n) => Number.isFinite(n)))
    ).sort((a, b) => a - b);
  }
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out: number[] = [];
  for (const part of s
    .split(/[,;| ]+/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let z = a; z <= b; z++) out.push(z);
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function normStr(v: any): string {
  return String(v ?? '').trim();
}
function normLower(v: any): string {
  return normStr(v).toLowerCase();
}

/* ---------------------------------------------
 * Shop row (exploded)
 * -------------------------------------------*/

type ShopItemRow = {
  region_id: string; // region this shop belongs to
  item_id: string; // chip id
  price_override?: number;
  _shop_id?: string; // optional original shop row id
};

/* ---------------------------------------------
 * Normalize raw TSV bundle → usable bundle
 * -------------------------------------------*/

function normalizeRawBundle(raw: any): NormalizedBundle {
  const chip_list = Array.isArray(raw?.chips) ? raw.chips : [];
  const virus_list = Array.isArray(raw?.viruses) ? raw.viruses : [];
  const region_list = Array.isArray(raw?.regions) ? raw.regions : [];
  const drop_list = Array.isArray(raw?.drop_tables)
    ? raw.drop_tables
    : Array.isArray(raw?.dropTables)
      ? raw.dropTables
      : [];
  const mission_list = Array.isArray(raw?.missions) ? raw.missions : [];
  const pa_list = Array.isArray(raw?.program_advances)
    ? raw.program_advances
    : Array.isArray(raw?.programAdvances)
      ? raw.programAdvances
      : [];
  const shop_list = Array.isArray(raw?.shops) ? raw.shops : [];

  // ---- chips map ----
  const chips: Record<string, any> = {};
  for (const c of chip_list) {
    let id = normStr(c?.id);
    const name = normStr(c?.name);
    if (!id) id = name;
    if (/^\d+$/.test(id) && name) id = name;

    (c as any).id = id;

    // normalize is_upgrade to something consistent (keep original but ensure string/number stable)
    const iu = (c as any).is_upgrade;
    if (iu === '' || iu === null || iu === undefined) {
      // leave blank; chipIsUpgrade will treat as false
    } else if (iu === true) {
      (c as any).is_upgrade = '1';
    } else if (iu === false) {
      (c as any).is_upgrade = '0';
    } else {
      // keep as-is (likely "0"/"1")
      (c as any).is_upgrade = String(iu).trim();
    }

    chips[id] = c;
  }

  // ---- regions map ----
  const regions: Record<string, any> = {};
  for (const r of region_list) {
    const id = normStr(r?.id);
    if (!id) continue;

    if (!('label' in r)) (r as any).label = (r as any).name ?? id;
    if (!('name' in r) && (r as any).label) (r as any).name = (r as any).label;

    if ((r as any).zone_count != null) (r as any).zone_count = Number((r as any).zone_count) || 1;
    if ((r as any).min_level != null) (r as any).min_level = Number((r as any).min_level) || 0;
    if ((r as any).encounter_rate != null) (r as any).encounter_rate = Number((r as any).encounter_rate) || 0;

    (r as any).id = id;
    regions[id] = r;
  }

  // ---- viruses map ----
  const viruses: Record<string, any> = {};
  for (const v of virus_list) {
    const id = normStr(v?.id);
    if (!id) continue;

    // region normalization
    const rid = normStr((v as any).region_id ?? (v as any).region);
    if (rid) (v as any).region_id = rid;

    // boss normalization (your TSV uses boss 0/1)
    const boss = toBoolLoose((v as any).boss ?? (v as any).is_boss);
    (v as any).boss = boss ? 1 : 0;
    (v as any).is_boss = boss;

    // zones normalization (your TSV uses "zone"; older code used "zones")
    const z = parseZones((v as any).zones ?? (v as any).zone);
    (v as any).zones = z;

    (v as any).id = id;
    viruses[id] = v;
  }

  // ---- drop tables map ----
  const dropTables: Record<string, any> = {};
  for (const dt of drop_list) {
    const id = normStr(dt?.id);
    if (!id) continue;
    (dt as any).id = id;
    dropTables[id] = dt;
  }

  // ---- missions map ----
  const missions: Record<string, any> = {};
  for (const m of mission_list) {
    const id = normStr(m?.id);
    if (!id) continue;
    (m as any).id = id;
    missions[id] = m;
  }

  // ---- program advances map ----
  const programAdvances: Record<string, any> = {};
  for (const p of pa_list) {
    const id = normStr(p?.id);
    if (!id) continue;
    (p as any).id = id;
    programAdvances[id] = p;
  }

  // ---- explode shops.tsv into per-item rows ----
  // shops.tsv columns: id, region_id, entries
  const shopsByRegion = new Map<string, ShopItemRow[]>();

  for (const s of shop_list) {
    const shopId = normStr((s as any).id);
    const region_id = normStr((s as any).region_id);
    const entriesRaw = normStr((s as any).entries);

    if (!region_id || !entriesRaw) continue;

    const entries = entriesRaw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    for (const e of entries) {
      // allow optional inline override like "Sword:500"
      const [itemRaw, priceRaw] = e.split(':').map((x) => x.trim());
      const item_id = itemRaw;
      if (!item_id) continue;

      const row: ShopItemRow = { region_id, item_id, _shop_id: shopId };
      const pr = Number(priceRaw);
      if (Number.isFinite(pr) && pr > 0) row.price_override = pr;

      const arr = shopsByRegion.get(region_id) ?? [];
      arr.push(row);
      shopsByRegion.set(region_id, arr);
    }
  }

  return {
    chips,
    viruses,
    regions,
    dropTables,
    missions,
    programAdvances,

    chip_list,
    virus_list,
    region_list,
    shop_list,

    shopsByRegion,
  };
}

/* ---------------------------------------------
 * Simple getters
 * -------------------------------------------*/

export function getChipById(id: string | number) {
  return getBundle().chips[String(id)];
}
export function getVirusById(id: string | number) {
  return getBundle().viruses[String(id)];
}
export function getRegionById(id: string | number) {
  return getBundle().regions[String(id)];
}

// Legacy helpers (some files call these)
export function listRegions() { return Object.values(getBundle().regions); }
export function listChips()   { return Object.values(getBundle().chips); }
export function listViruses() { return Object.values(getBundle().viruses); }

/* ---------------------------------------------
 * Region resolution (id or name/label)
 * -------------------------------------------*/

function resolveRegionIdLoose(regionOrName: string): string {
  const b = getBundle();
  const key = normStr(regionOrName);
  if (!key) return key;

  // direct id hit
  if (b.regions[key]) return key;

  // case-insensitive id match
  const lower = key.toLowerCase();
  for (const r of Object.values(b.regions)) {
    if (normLower((r as any).id) === lower) return String((r as any).id ?? key);
  }

  // name/label match
  for (const r of Object.values(b.regions)) {
    const nm = normLower((r as any).name ?? (r as any).label);
    if (nm && nm === lower) return String((r as any).id ?? key);
  }

  return key;
}

/* ---------------------------------------------
 * Virus queries (tolerant)
 * -------------------------------------------*/

export function listVirusesForRegionZone(opts: {
  region_id: string;
  zone: number;
  includeNormals?: boolean;
  includeBosses?: boolean;
}): any[] {
  const { region_id, zone, includeNormals = true, includeBosses = true } = opts;

  const b = getBundle();
  const wantRegionId = resolveRegionIdLoose(region_id);
  const wantRegionIdLower = normLower(wantRegionId);

  // Also accept matching by region name/label just in case callers pass that.
  const wantRegionNameLower = normLower(b.regions[wantRegionId]?.name ?? b.regions[wantRegionId]?.label ?? '');

  const out: any[] = [];

  for (const v of Object.values(b.viruses)) {
    const vRegionRaw = normStr((v as any).region_id ?? (v as any).region);
    const vRegionLower = vRegionRaw.toLowerCase();

    // If the virus has a region_id, it must match the requested region (by id or by name/label).
    if (vRegionRaw) {
      const ok =
        vRegionLower === wantRegionIdLower ||
        (wantRegionNameLower && vRegionLower === wantRegionNameLower);
      if (!ok) continue;
    }

    const isBoss = !!((v as any).is_boss ?? false) || toBoolLoose((v as any).boss);
    if (!includeBosses && isBoss) continue;
    if (!includeNormals && !isBoss) continue;

    // zones array is normalized in normalizeRawBundle; tolerate strings just in case.
    const zArrRaw = (v as any).zones;
    const zArr: number[] = Array.isArray(zArrRaw)
      ? zArrRaw.map((x: any) => Number(x)).filter((n: any) => Number.isFinite(n))
      : [];

    // If no zones are specified, treat as "all zones"
    if (zArr.length === 0 || zArr.includes(Number(zone))) out.push(v);
  }

  return out;
}

/* ---------------------------------------------
 * Shops
 * -------------------------------------------*/

export type ResolvedShopItem = {
  region_id: string;
  item_id: string;
  name: string;
  zenny_price: number;
  is_upgrade: boolean;
  chip: any;
  shop_row: ShopItemRow;
};

export function getShopsForRegion(region_id: string): ShopItemRow[] {
  const rid = resolveRegionIdLoose(region_id);
  return getBundle().shopsByRegion.get(String(rid)) ?? [];
}

export function priceForShopItem(s: ShopItemRow, c: any): number {
  const override = Number.isFinite((s as any).price_override) ? Number((s as any).price_override) : 0;
  if (override && override > 0) return override;
  const base = Number((c as any).zenny_cost);
  return Number.isFinite(base) ? base : 0;
}

export function resolveShopInventory(region_id: string): ResolvedShopItem[] {
  const rid = resolveRegionIdLoose(region_id);
  const rows = getShopsForRegion(rid);

  const out: ResolvedShopItem[] = [];
  for (const s of rows) {
    const chip = getChipById((s as any).item_id);
    if (!chip) continue;

    out.push({
      region_id: String(rid),
      item_id: String((chip as any).id ?? (s as any).item_id),
      name: (chip as any).name ?? String((chip as any).id ?? (s as any).item_id),
      zenny_price: priceForShopItem(s, chip),
      is_upgrade: chipIsUpgrade(chip),
      chip,
      shop_row: s,
    });
  }

  out.sort((a, b) => (a.name.localeCompare(b.name) || a.item_id.localeCompare(b.item_id)));
  return out;
}

/* ---------------------------------------------
 * Virus art (robust fallbacks)
 * -------------------------------------------*/

export function getVirusArt(virusId: string | number) {
  const v = getVirusById(virusId) as any;
  if (!v) return { fallbackEmoji: '⚔️' };

  const image = v.image || v.image_url || v.art_url || null;
  const sprite = v.sprite || v.sprite_url || v.icon_url || null;

  if (image || sprite) return { image, sprite, fallbackEmoji: '⚔️' };
  return { fallbackEmoji: '⚔️' };
}

/* ---------------------------------------------
 * Reload (called by /reload_data)
 * -------------------------------------------*/

export function reloadDataFromDisk(): NormalizedBundle {
  invalidateBundleCache();
  return getBundle();
}
