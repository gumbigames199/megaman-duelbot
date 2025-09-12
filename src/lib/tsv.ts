// lib/tsv.ts
// Minimal TSV loader with cache. Default export is callable (tsv() → getBundle())
// and also exposes properties: tsv.getBundle, tsv.invalidateBundleCache.

import fs from "node:fs";
import path from "node:path";

export type ChipRow   = { id: string; name: string; [k: string]: any };
export type VirusRow  = { id: string; name: string; region_id?: string; is_boss?: boolean; zones?: number[]; [k: string]: any };
export type RegionRow = { id: string; label: string; zone_count?: number; [k: string]: any };
export type ShopRow   = { region_id: string; item_id: string; price_override?: number; [k: string]: any };
export type ProgramAdvanceRow = { id: string; name: string; [k: string]: any };

export type DataBundle = {
  chips: ChipRow[];
  viruses: VirusRow[];
  regions: RegionRow[];
  drop_tables: any[];
  missions: any[];
  program_advances: ProgramAdvanceRow[];
  programAdvances: ProgramAdvanceRow[]; // alias for callers expecting camelCase
  shops: ShopRow[];
};

let _cache: DataBundle | null = null;
let _mtimeKey = "";

export function invalidateBundleCache() {
  _cache = null;
  _mtimeKey = "";
}

export function getBundle(): DataBundle {
  const dataDir = path.resolve(process.cwd(), "data");
  const key = mtimeKeyForDir(dataDir);
  if (_cache && _mtimeKey === key) return _cache;

  const chips      = readTSV(path.join(dataDir, "chips.tsv"));
  const virusesRaw = readTSV(path.join(dataDir, "viruses.tsv"));
  const regions    = readTSV(path.join(dataDir, "regions.tsv"));
  const drops      = readTSV(path.join(dataDir, "drop_tables.tsv"));
  const missions   = readTSV(path.join(dataDir, "missions.tsv"));
  const pas        = readTSV(path.join(dataDir, "program_advances.tsv"));
  const shops      = readTSV(path.join(dataDir, "shops.tsv"));

  const viruses: VirusRow[] = (virusesRaw as any[]).map((r) => ({
    ...r,
    is_boss: truthy((r as any).is_boss),
    zones: parseZones((r as any).zones),
  }));

  const bundle: DataBundle = {
    chips: chips as ChipRow[],
    viruses,
    regions: regions as RegionRow[],
    drop_tables: drops,
    missions,
    program_advances: pas as ProgramAdvanceRow[],
    programAdvances: pas as ProgramAdvanceRow[], // alias
    shops: shops as ShopRow[],
  };

  _cache = bundle;
  _mtimeKey = key;
  return bundle;
}

// ---------- helpers ----------

function readTSV(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const obj: any = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });
    rows.push(obj);
  }
  return rows;
}

function parseZones(v: any): number[] {
  if (!v) return [];
  const s = String(v);
  const parts = s.split(/[,|; ]+/).filter(Boolean);
  return parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
}

function truthy(v: any): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

function mtimeKeyForDir(dir: string): string {
  try {
    const names = fs.readdirSync(dir);
    const stats = names.map((n) => fs.statSync(path.join(dir, n)).mtimeMs);
    return String(Math.max(...stats, 0));
  } catch { return ""; }
}

// ---- default export (callable) ----

function tsvDefault(): DataBundle {
  return getBundle();
}
// also expose properties for both call styles
(tsvDefault as any).getBundle = getBundle;
(tsvDefault as any).invalidateBundleCache = invalidateBundleCache;

export default tsvDefault;
