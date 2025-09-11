// tsv.ts
// Robust TSV loader + Zod validation for all data tables.
// - Exposes zenny_cost and is_upgrade for chips
// - Accepts flexible/optional columns (won’t crash if a column is missing)
// - Adds light referential integrity checks with console warnings
//
// Expected files in ./data:
//   chips.tsv
//   viruses.tsv
//   regions.tsv
//   drop_tables.tsv
//   missions.tsv
//   program_advances.tsv
//   shops.tsv
//
// Notes:
// - We DO NOT require bosses.tsv (boss flag now lives on viruses.tsv)
// - Zone handling: accepts “1,2,3” or “1-3” (or any mix). We store both the raw
//   string (“zone_raw”) and a computed number[] (“zones”) for convenience.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// -------------------------------
// Utilities
// -------------------------------

const DATA_DIR = path.resolve(process.cwd(), "data");

function safeReadFile(fp: string): string | null {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

function toNumber(v: unknown, def = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return def;
    const n = Number(t);
    return Number.isFinite(n) ? n : def;
  }
  return def;
}

function toBoolean(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "1" || t === "true" || t === "yes" || t === "y") return true;
    if (t === "0" || t === "false" || t === "no" || t === "n") return false;
  }
  return def;
}

function splitCSV(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseZones(zoneRaw: string | undefined | null): number[] {
  if (!zoneRaw) return [];
  const parts = zoneRaw
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const zones = new Set<number>();

  for (const p of parts) {
    const m = p.match(/^(\d+)\-(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) zones.add(i);
      }
    } else {
      const n = Number(p);
      if (Number.isFinite(n)) zones.add(n);
    }
  }

  return [...zones].sort((a, b) => a - b);
}

function parseTSV(raw: string): Array<Record<string, string>> {
  // Tolerant TSV parser: header + rows, \r\n or \n, ignores empty lines
  const lines = raw.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].split("\t").map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const rec: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      rec[header[j]] = (cols[j] ?? "").trim();
    }
    rows.push(rec);
  }
  return rows;
}

// -------------------------------
// Zod Schemas (tolerant)
// -------------------------------

/**
 * CHIPS
 * Required: id, name
 * Notable: zenny_cost (number), is_upgrade (boolean)
 * Other columns are optional and left flexible (effects, power, hits, element, codes, description, image, rarity, etc.)
 */
export const ChipRow = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),

    // Flexible/optional gameplay fields:
    code: z.string().optional(), // single letter (BN style) if you use it
    codes: z.string().optional(), // CSV variant
    element: z.string().optional(),
    power: z.union([z.string(), z.number()]).optional(),
    hits: z.union([z.string(), z.number()]).optional(),
    effects: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    rarity: z.union([z.string(), z.number()]).optional(),

    // Pricing + upgrade control:
    zenny_cost: z.union([z.string(), z.number()]).optional(),
    is_upgrade: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .transform((r) => {
    return {
      ...r,
      power: toNumber(r.power, 0),
      hits: toNumber(r.hits, 1),
      rarity: toNumber(r.rarity, 0),
      zenny_cost: toNumber(r.zenny_cost, 0),
      is_upgrade: toBoolean(r.is_upgrade, false),
    };
  });

export type ChipRow = z.infer<typeof ChipRow>;

/**
 * VIRUSES
 * Required: id, name
 * Supports:
 *  - region_id (string)
 *  - zone / zones (string list or ranges -> computed to number[])
 *  - boss OR is_boss (0/1, true/false)
 *  - element/hp/atk/def/spd/acc/eva (optional numeric stats)
 *  - image/sprite (optional for rendering)
 */
export const VirusRow = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),

    region_id: z.string().optional(),
    zone: z.string().optional(), // "1,2,3" or "1-3" etc.

    // Accept either 'boss' or 'is_boss' to be tolerant to previous data
    boss: z.union([z.string(), z.number(), z.boolean()]).optional(),
    is_boss: z.union([z.string(), z.number(), z.boolean()]).optional(),

    element: z.string().optional(),
    hp: z.union([z.string(), z.number()]).optional(),
    atk: z.union([z.string(), z.number()]).optional(),
    def: z.union([z.string(), z.number()]).optional(),
    spd: z.union([z.string(), z.number()]).optional(),
    acc: z.union([z.string(), z.number()]).optional(),
    eva: z.union([z.string(), z.number()]).optional(),

    image: z.string().optional(),
    sprite: z.string().optional(),
  })
  .transform((r) => {
    const bossFlag = r.is_boss ?? r.boss ?? false;
    const zone_raw = r.zone ?? "";
    return {
      ...r,
      is_boss: toBoolean(bossFlag, false),
      hp: toNumber(r.hp, 0),
      atk: toNumber(r.atk, 0),
      def: toNumber(r.def, 0),
      spd: toNumber(r.spd, 0),
      acc: toNumber(r.acc, 0),
      eva: toNumber(r.eva, 0),
      zone_raw,
      zones: parseZones(zone_raw),
    };
  });

export type VirusRow = z.infer<typeof VirusRow>;

/**
 * REGIONS
 * Required: id
 * Accepts name/label and zone_count (number), level_req (number), any extra metadata tolerated.
 */
export const RegionRow = z
  .object({
    id: z.string().min(1),
    region: z.string().optional(),
    name: z.string().optional(),
    zone_count: z.union([z.string(), z.number()]).optional(),
    zones: z.union([z.string(), z.number()]).optional(), // if you store “4” here
    level_req: z.union([z.string(), z.number()]).optional(),
    image: z.string().optional(),
  })
  .transform((r) => {
    // prefer explicit zone_count, fallback to zones numeric, else default 1
    const zoneCount =
      toNumber(r.zone_count, NaN) ||
      toNumber(r.zones, NaN) ||
      1;

    return {
      ...r,
      zone_count: toNumber(zoneCount, 1),
      level_req: toNumber(r.level_req, 1),
      label: r.name ?? r.region ?? r.id,
    };
  });

export type RegionRow = z.infer<typeof RegionRow>;

/**
 * DROP TABLES
 * Minimal but flexible. Common columns:
 *   source_kind: "virus" | "boss" | "mission" | ...
 *   source_id: id of the source (e.g., a virus id)
 *   item_id: id of a chip/upgrade/etc.
 *   rate: number (0..1 or 0..100, we accept both and normalize to 0..1)
 * We also accept an 'id' column if present.
 */
export const DropTableRow = z
  .object({
    id: z.string().optional(),
    source_kind: z.string().optional(),
    source_id: z.string().optional(),
    item_id: z.string().optional(),
    rate: z.union([z.string(), z.number()]).optional(),
  })
  .transform((r) => {
    let rate = toNumber(r.rate, 0);
    // Normalize if someone uses percentage scale
    if (rate > 1) rate = rate / 100;
    if (rate < 0) rate = 0;
    if (rate > 1) rate = 1;
    return { ...r, rate };
  });

export type DropTableRow = z.infer<typeof DropTableRow>;

/**
 * MISSIONS
 * Keep very flexible; require id and title where possible.
 */
export const MissionRow = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    target_kind: z.string().optional(),
    target_id: z.string().optional(),
    count: z.union([z.string(), z.number()]).optional(),
    reward_zenny: z.union([z.string(), z.number()]).optional(),
    reward_chip_ids: z.string().optional(), // CSV list in TSV
  })
  .transform((r) => {
    return {
      ...r,
      count: toNumber(r.count, 0),
      reward_zenny: toNumber(r.reward_zenny, 0),
      reward_chip_ids_list: splitCSV(r.reward_chip_ids),
    };
  });

export type MissionRow = z.infer<typeof MissionRow>;

/**
 * PROGRAM ADVANCES
 * id + result_chip_id + component chip ids/codes (CSV)
 */
export const ProgramAdvanceRow = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    components: z.string().optional(), // CSV of chip ids (or ids+codes)
    result_chip_id: z.string().min(1),
  })
  .transform((r) => {
    return {
      ...r,
      components_list: splitCSV(r.components),
    };
  });

export type ProgramAdvanceRow = z.infer<typeof ProgramAdvanceRow>;

/**
 * SHOPS
 * region_id + item reference + optional price override and stock/rotation.
 * We accept chip_id or item_id for compatibility.
 */
export const ShopRow = z
  .object({
    id: z.string().optional(),
    region_id: z.string().min(1),
    item_id: z.string().optional(),
    chip_id: z.string().optional(), // legacy/alt column
    price_override: z.union([z.string(), z.number()]).optional(),
    stock: z.union([z.string(), z.number()]).optional(),
    rotation: z.string().optional(),
  })
  .transform((r) => {
    return {
      ...r,
      item_id: r.item_id ?? r.chip_id ?? "",
      price_override: toNumber(r.price_override, 0),
      stock: toNumber(r.stock, 0),
    };
  });

export type ShopRow = z.infer<typeof ShopRow>;

// -------------------------------
// Bundle + Loaders
// -------------------------------

export type DataBundle = {
  chips: ChipRow[];
  viruses: VirusRow[];
  regions: RegionRow[];
  drop_tables: DropTableRow[];
  missions: MissionRow[];
  program_advances: ProgramAdvanceRow[];
  shops: ShopRow[];
};

let _bundleCache: { at: number; data: DataBundle } | null = null;
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

function loadTable<T>(
  filename: string,
  schema: z.ZodType<T, any, any>,
  onRow?: (row: T) => void
): T[] {
  const fp = path.join(DATA_DIR, filename);
  const raw = safeReadFile(fp);
  if (!raw) {
    console.warn(`⚠️ Missing data file: ${filename} (returning empty array)`);
    return [];
  }
  const rowsRaw = parseTSV(raw);
  const out: T[] = [];
  for (let i = 0; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    const parsed = schema.safeParse(r);
    if (!parsed.success) {
      console.warn(
        `⚠️ ${filename} row ${i + 2} failed validation:`,
        parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")
      );
      continue;
    }
    const row = parsed.data;
    if (onRow) onRow(row);
    out.push(row);
  }
  return out;
}

function indexBy<T extends { id?: string }>(arr: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of arr) {
    if (r.id) m.set(r.id, r);
  }
  return m;
}

export function invalidateBundleCache() {
  _bundleCache = null;
}

export function getBundle(): DataBundle {
  const now = Date.now();
  if (_bundleCache && now - _bundleCache.at < CACHE_MS) {
    return _bundleCache.data;
  }

  const chips = loadTable<ChipRow>("chips.tsv", ChipRow);
  const viruses = loadTable<VirusRow>("viruses.tsv", VirusRow);
  const regions = loadTable<RegionRow>("regions.tsv", RegionRow);
  const drop_tables = loadTable<DropTableRow>("drop_tables.tsv", DropTableRow);
  const missions = loadTable<MissionRow>("missions.tsv", MissionRow);
  const program_advances = loadTable<ProgramAdvanceRow>(
    "program_advances.tsv",
    ProgramAdvanceRow
  );
  const shops = loadTable<ShopRow>("shops.tsv", ShopRow);

  // Light referential integrity checks (warn only)
  const chipIdx = indexBy(chips);
  const regionIdx = indexBy(regions);

  for (const s of shops) {
    if (!s.item_id) {
      console.warn(`⚠️ shops.tsv → row missing item_id/chip_id (region_id=${s.region_id})`);
    } else if (!chipIdx.has(s.item_id)) {
      console.warn(`⚠️ shops.tsv → unknown item_id '${s.item_id}' (region_id=${s.region_id})`);
    }
    if (!regionIdx.has(s.region_id)) {
      console.warn(`⚠️ shops.tsv → unknown region_id '${s.region_id}'`);
    }
  }

  for (const v of viruses) {
    if (v.region_id && !regionIdx.has(v.region_id)) {
      console.warn(`⚠️ viruses.tsv → unknown region_id '${v.region_id}' for virus '${v.id}'`);
    }
  }

  const data: DataBundle = {
    chips,
    viruses,
    regions,
    drop_tables,
    missions,
    program_advances,
    shops,
  };

  _bundleCache = { at: now, data };
  return data;
}
