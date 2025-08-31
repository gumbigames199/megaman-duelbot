// src/lib/data.ts
import loadTSVBundle from './tsv';
import { DataBundle } from './types';

let cache: { ts: number; bundle: DataBundle } | null = null;
const FRESH_MS = 5 * 60 * 1000;

function emptyBundle(): DataBundle {
  return {
    chips: {},
    viruses: {},
    bosses: {},
    regions: {},
    virusPools: {},
    dropTables: {},
    missions: {},
    programAdvances: {},
    shops: {},
  };
}

export function invalidateBundleCache() {
  cache = null;
}

export function getBundle(): DataBundle {
  const now = Date.now();
  if (!cache || (now - cache.ts) > FRESH_MS) {
    try {
      const { data } = loadTSVBundle(process.env.DATA_DIR || './data');
      cache = { ts: now, bundle: data || emptyBundle() };
    } catch {
      cache = cache ? cache : { ts: now, bundle: emptyBundle() };
    }
  }
  return cache.bundle;
}

// helpers
export function getChipById(id: string) {
  return getBundle().chips[id];
}

export function listShopStock() {
  // expose all chips with stock=1 and zenny_cost>0 (ignore upgrades)
  return Object.values(getBundle().chips)
    .filter((c: any) => Number(c.stock) === 1 && Number(c.zenny_cost || 0) > 0 && !c.is_upgrade)
    .sort((a: any, b: any) => {
      const az = Number(a.zenny_cost || 0), bz = Number(b.zenny_cost || 0);
      return az - bz || String(a.name || '').localeCompare(String(b.name || ''));
    });
}
