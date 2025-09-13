// src/lib/data.ts
import loadTSVBundle from './tsv';
import { DataBundle } from './types';

let cache: { ts: number; bundle: DataBundle } | null = null;
const FRESH_MS = 5 * 60 * 1000;

function emptyBundle(): DataBundle {
  return {
    chips: {},
    viruses: {},
    regions: {},
    dropTables: {},
    missions: {},
    programAdvances: {},
    shops: {},
  };
}

export function invalidateBundleCache() {
  cache = null;
}

function parseZoneList(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10),
          b = parseInt(m[2], 10);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      }
      return [parseInt(trimmed, 10)];
    })
    .filter((n) => Number.isFinite(n));
}

export function getBundle(): DataBundle {
  const now = Date.now();
  if (!cache || now - cache.ts > FRESH_MS) {
    try {
      const { data } = loadTSVBundle(process.env.DATA_DIR || './data');

      // regions
      const regions: any = {};
      for (const r of Object.values<any>(data.regions || {})) {
        regions[r.id] = {
          ...r,
          zone_count: parseInt(String(r.zone_count ?? 1), 10),
          min_level: parseInt(String(r.min_level ?? 1), 10),
        };
      }

      // viruses
      const viruses: any = {};
      for (const v of Object.values<any>(data.viruses || {})) {
        viruses[v.id] = {
          ...v,
          zones: parseZoneList(v.zone),
          boss: v.boss === '1' || v.boss === 1 || v.boss === true,
        };
      }

      // --- validators ---
      const warn = console.warn;
      // unknown regions
      for (const v of Object.values<any>(viruses)) {
        if (!regions[v.region]) warn(`viruses.tsv: unknown region "${v.region}" for ${v.id}`);
        const rc = regions[v.region]?.zone_count ?? 0;
        for (const z of v.zones) {
          if (z < 1 || z > rc)
            warn(`viruses.tsv: zone ${z} out of 1..${rc} for ${v.id} in region ${v.region}`);
        }
      }
      // bosses / non-boss per zone
      const bossKey = (r: string, z: number) => `${r}#${z}`;
      const bossSeen = new Map<string, string>();
      const nonBossByZone = new Map<string, number>();
      for (const v of Object.values<any>(viruses)) {
        for (const z of v.zones) {
          const key = bossKey(v.region, z);
          if (v.boss) {
            if (bossSeen.has(key))
              warn(
                `viruses.tsv: multiple bosses for ${key}: ${bossSeen.get(key)} and ${v.id}`,
              );
            else bossSeen.set(key, v.id);
          } else {
            nonBossByZone.set(key, (nonBossByZone.get(key) ?? 0) + 1);
          }
        }
      }
      for (const r of Object.values<any>(regions)) {
        for (let z = 1; z <= r.zone_count; z++) {
          const key = bossKey(r.id, z);
          if (!nonBossByZone.get(key))
            warn(`viruses.tsv: no non-boss viruses for ${key}`);
        }
      }

      cache = {
        ts: now,
        bundle: {
          ...data,
          regions,
          viruses,
          // removed bosses & virusPools
        } as DataBundle,
      };
    } catch (e) {
      console.error('Error loading TSV bundle', e);
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
    .filter(
      (c: any) =>
        Number(c.stock) === 1 &&
        Number(c.zenny_cost || 0) > 0 &&
        !c.is_upgrade,
    )
    .sort((a: any, b: any) => {
      const az = Number(a.zenny_cost || 0),
        bz = Number(b.zenny_cost || 0);
      return (
        az - bz ||
        String(a.name || '').localeCompare(String(b.name || ''))
      );
    });
}
