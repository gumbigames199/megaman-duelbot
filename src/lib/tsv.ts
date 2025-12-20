// src/lib/tsv.ts
// Minimal TSV loader w/ cache.
// - Reads TSVs from DATA_DIR (Railway) or ./data (local)
// - Returns raw row objects (strings) — normalization happens in lib/data.ts
// - Exposes getBundle() + invalidateBundleCache()
// - Default export is callable (tsv() -> getBundle()) and also has properties.

import fs from 'node:fs';
import path from 'node:path';

export type ChipRow = { id?: string; name?: string; [k: string]: any };
export type VirusRow = { id?: string; name?: string; [k: string]: any };
export type RegionRow = { id?: string; name?: string; label?: string; [k: string]: any };
export type ShopRow = { id?: string; region_id?: string; entries?: string; [k: string]: any };
export type ProgramAdvanceRow = { id?: string; name?: string; [k: string]: any };

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
let _mtimeKey = '';

export function invalidateBundleCache() {
  _cache = null;
  _mtimeKey = '';
}

function resolveDataDir(): string {
  const fromEnv = String(process.env.DATA_DIR ?? '').trim();
  // If DATA_DIR is absolute, use it; if relative, resolve from CWD.
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), 'data');
}

export function getBundle(): DataBundle {
  const dataDir = resolveDataDir();

  const key = mtimeKeyForDir(dataDir);
  if (_cache && key && key === _mtimeKey) return _cache;

  const chips = readTSV(path.join(dataDir, 'chips.tsv'));
  const viruses = readTSV(path.join(dataDir, 'viruses.tsv'));
  const regions = readTSV(path.join(dataDir, 'regions.tsv'));
  const drop_tables = readTSV(path.join(dataDir, 'drop_tables.tsv'));
  const missions = readTSV(path.join(dataDir, 'missions.tsv'));
  const program_advances = readTSV(path.join(dataDir, 'program_advances.tsv'));
  const shops = readTSV(path.join(dataDir, 'shops.tsv'));

  _cache = {
    chips,
    viruses,
    regions,
    drop_tables,
    missions,
    program_advances,
    programAdvances: program_advances, // alias
    shops,
  };
  _mtimeKey = key;

  return _cache;
}

/* ------------------------------ TSV reader ------------------------------ */

function readTSV(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !l.trimStart().startsWith('#'));

  if (lines.length === 0) return [];

  const headers = splitTSVLine(lines[0]).map((h) => h.trim());
  const out: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitTSVLine(lines[i]);

    // Skip if the row is effectively blank
    const anyData = cols.some((c) => String(c ?? '').trim().length > 0);
    if (!anyData) continue;

    const row: any = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      row[key] = cols[c] ?? '';
    }
    out.push(row);
  }

  return out;
}

function splitTSVLine(line: string): string[] {
  // TSVs are simple in your project (no quoted cells needed), so split on tabs.
  return line.split('\t');
}

function mtimeKeyForDir(dir: string): string {
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.tsv'));
    const stats = names.map((n) => fs.statSync(path.join(dir, n)).mtimeMs);
    return String(Math.max(...stats, 0));
  } catch {
    return '';
  }
}

/* ------------------------------ default export ------------------------------ */

function tsvDefault(): DataBundle {
  return getBundle();
}

(tsvDefault as any).getBundle = getBundle;
(tsvDefault as any).invalidateBundleCache = invalidateBundleCache;

export default tsvDefault;
