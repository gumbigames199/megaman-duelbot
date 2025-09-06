// src/lib/tsv.ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ChipRow, VirusRow, RegionRow, DropTableRow,
  MissionRow, ProgramAdvanceRow, ShopRow,
  DataBundle, LoadReport
} from './types';

// --- keep: helper to parse "1,2,4-6" into [1,2,4,5,6] ---
export const parseZoneList = (raw: string): number[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .flatMap(p => {
      const s = p.trim();
      if (!s) return [];
      const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      }
      return [parseInt(s, 10)];
    })
    .filter(n => Number.isFinite(n));
};

// ---- tiny TSV parser ----
function parseTSV(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (cols[i] ?? '').trim()));
    return obj;
  });
}
function readTSV(filePath: string): Array<Record<string, string>> {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseTSV(text);
}
function n(v: string, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function b01(v: string) { return ['1', 'true', 'yes', 'y'].includes(String(v || '').toLowerCase()) ? 1 : 0; }

// ---- zod schemas (soft) ----
const chipSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), element: z.string().min(1),
  letters: z.string().min(1),
  mb_cost: z.string(), power: z.string(), hits: z.string(), acc: z.string(),
  category: z.string(), effects: z.string().optional().default(''),
  description: z.string().optional().default(''),
  image_url: z.string().optional().default(''),
  rarity: z.string(),
  zenny_cost: z.string().optional().default('0'),
  stock: z.string().optional().default('1'),
  is_upgrade: z.string().optional().default('0'),
});

const virusSchema = z.object({
  id: z.string(), name: z.string(), element: z.string(),
  hp: z.string(), atk: z.string(), def: z.string(), spd: z.string(), acc: z.string(),
  cr: z.string(),
  region: z.string(), zone: z.string().optional().default('1'), // raw CSV/range, we convert to zones[]
  drop_table_id: z.string().optional().default(''),
  image_url: z.string().optional().default(''), anim_url: z.string().optional().default(''),
  description: z.string().optional().default(''),
  zenny_range: z.string().optional().default('0-0'),
  xp_range: z.string().optional().default('10-20'),
  move_1json: z.string().optional(), move_2json: z.string().optional(),
  move_3json: z.string().optional(), move_4json: z.string().optional(),
  boss: z.string().optional(), stat_points: z.string().optional(),
});

const regionSchema = z.object({
  id: z.string(), name: z.string(),
  background_url: z.string().optional().default(''),
  encounter_rate: z.string().optional().default('0.7'),
  // removed: virus_pool_id, boss_id
  shop_id: z.string().optional().default(''),
  min_level: z.string().optional().default('1'),
  description: z.string().optional().default(''),
  field_effects: z.string().optional().default(''),
  zone_count: z.string().optional().default('1'),
  next_region_ids: z.string().optional().default(''),
});

const dropSchema = z.object({ id: z.string(), entries: z.string() });

const missionSchema = z.object({
  id: z.string(), name: z.string(), type: z.string(),
  requirement: z.string(), region_id: z.string(),
  reward_zenny: z.string().optional().default('0'),
  reward_chip_ids: z.string().optional().default(''),
  description: z.string().optional().default(''),
  image_url: z.string().optional().default(''),
});

const paSchema = z.object({
  id: z.string(), name: z.string(), result_chip_id: z.string(),
  required_chip_ids: z.string(), required_letters: z.string(),
  description: z.string().optional().default(''),
});

const shopSchema = z.object({ id: z.string(), region_id: z.string(), entries: z.string() });

// ---- loaders ----
function toChip(r: z.infer<typeof chipSchema>): ChipRow {
  return {
    id: r.id, name: r.name, element: r.element as any, letters: r.letters,
    mb_cost: n(r.mb_cost), power: n(r.power), hits: n(r.hits || '1'), acc: Number(r.acc || '0.95'),
    category: r.category as any, effects: r.effects || '', description: r.description || '',
    image_url: r.image_url || '', rarity: n(r.rarity || '1'),
    zenny_cost: n(r.zenny_cost || '0'), stock: n(r.stock || '1'), is_upgrade: b01(r.is_upgrade || '0'),
  };
}

function toVirus(r: z.infer<typeof virusSchema>): VirusRow {
  return {
    id: r.id, name: r.name, element: r.element as any,
    hp: n(r.hp), atk: n(r.atk), def: n(r.def), spd: n(r.spd), acc: n(r.acc),
    cr: n(r.cr),
    region: r.region,
    zones: parseZoneList(r.zone || '1'), // <-- convert raw zone -> zones[]
    drop_table_id: r.drop_table_id || '',
    image_url: r.image_url || '', anim_url: r.anim_url || '',
    description: r.description || '',
    zenny_range: r.zenny_range || '0-0',
    xp_range: r.xp_range || '10-20',
    move_1json: r.move_1json, move_2json: r.move_2json, move_3json: r.move_3json, move_4json: r.move_4json,
    boss: b01(r.boss || '0'),      // 0/1 flag (bosses live in viruses.tsv)
    stat_points: n(r.stat_points || '0'),
  };
}

function toRegion(r: z.infer<typeof regionSchema>): RegionRow {
  return {
    id: r.id, name: r.name, background_url: r.background_url || '',
    encounter_rate: Number(r.encounter_rate || '0.7'),
    shop_id: r.shop_id || '',
    min_level: Number(r.min_level || '1'),
    description: r.description || '', field_effects: r.field_effects || '',
    zone_count: Number(r.zone_count || '1'),
    next_region_ids: r.next_region_ids || '',
  };
}

export function loadTSVBundle(dir = './data'): { data: DataBundle; report: LoadReport } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};

  const rd = (f: string) => readTSV(path.join(dir, f));

  const chips = Object.fromEntries(
    rd('chips.tsv').map(row => {
      const p = chipSchema.safeParse(row);
      if (!p.success) { errors.push(`chips: ${row.id ?? row.name ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      const v = toChip(p.data);
      return [v.id, v] as const;
    }).filter(Boolean) as any
  ); counts.chips = Object.keys(chips).length;

  const viruses = Object.fromEntries(
    rd('viruses.tsv').map(row => {
      const p = virusSchema.safeParse(row);
      if (!p.success) { errors.push(`viruses: ${row.id ?? row.name ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      const v = toVirus(p.data);
      return [v.id, v] as const;
    }).filter(Boolean) as any
  ); counts.viruses = Object.keys(viruses).length;

  const regions = Object.fromEntries(
    rd('regions.tsv').map(row => {
      const p = regionSchema.safeParse(row);
      if (!p.success) { errors.push(`regions: ${row.id ?? row.name ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      const v = toRegion(p.data);
      return [v.id, v] as const;
    }).filter(Boolean) as any
  ); counts.regions = Object.keys(regions).length;

  const dropTables = Object.fromEntries(
    rd('drop_tables.tsv').map(row => {
      const p = dropSchema.safeParse(row);
      if (!p.success) { errors.push(`drop_tables: ${row.id ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      return [p.data.id, p.data as unknown as DropTableRow] as const;
    }).filter(Boolean) as any
  ); counts.drop_tables = Object.keys(dropTables).length;

  const missions = Object.fromEntries(
    rd('missions.tsv').map(row => {
      const p = missionSchema.safeParse(row);
      if (!p.success) { errors.push(`missions: ${row.id ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      const m: MissionRow = {
        ...(p.data as any),
        reward_zenny: n(p.data.reward_zenny || '0', 0),
      } as any;
      return [m.id, m] as const;
    }).filter(Boolean) as any
  ); counts.missions = Object.keys(missions).length;

  const programAdvances = Object.fromEntries(
    (fs.existsSync(path.join(dir, 'program_advances.tsv')) ? rd('program_advances.tsv') : []).map(row => {
      const p = paSchema.safeParse(row);
      if (!p.success) { errors.push(`program_advances: ${row.id ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      return [p.data.id, p.data as unknown as ProgramAdvanceRow] as const;
    }).filter(Boolean) as any
  ); counts.program_advances = Object.keys(programAdvances).length;

  const shops = Object.fromEntries(
    (fs.existsSync(path.join(dir, 'shops.tsv')) ? rd('shops.tsv') : []).map(row => {
      const p = shopSchema.safeParse(row);
      if (!p.success) { errors.push(`shops: ${row.id ?? 'unknown'} ⇒ ${p.error.issues[0]?.message}`); return null; }
      return [p.data.id, p.data as unknown as ShopRow] as const;
    }).filter(Boolean) as any
  ); counts.shops = Object.keys(shops).length;

  // ---- referential checks (light) ----
  for (const v of Object.values(viruses) as any[]) {
    if (v.region && !regions[v.region]) warnings.push(`viruses.${v.id}: unknown region "${v.region}"`);
    if (v.drop_table_id && !dropTables[v.drop_table_id]) warnings.push(`viruses.${v.id}: missing drop_table_id ${v.drop_table_id}`);
    if (!Array.isArray(v.zones) || v.zones.length === 0) warnings.push(`viruses.${v.id}: no zones parsed (zone="${(v as any).zone}")`);
  }

  for (const dt of Object.values(dropTables) as any[]) {
    const entries = String(dt.entries || '').split(',').map((x: string) => x.trim()).filter(Boolean);
    for (const e of entries) {
      const id = e.split(':')[0]?.trim();
      if (id && !chips[id]) warnings.push(`drop_tables.${dt.id}: unknown chip "${id}"`);
    }
  }

  for (const pa of Object.values(programAdvances) as any[]) {
    const req = String(pa.required_chip_ids || '').split(',').map((x: string) => x.trim()).filter(Boolean);
    const miss = req.filter((id: string) => !chips[id]);
    if (miss.length) warnings.push(`program_advances.${pa.id}: unknown chips ${miss.join(', ')}`);
    if (pa.result_chip_id && !chips[pa.result_chip_id]) warnings.push(`program_advances.${pa.id}: unknown result_chip_id ${pa.result_chip_id}`);
  }

  for (const sh of Object.values(shops) as any[]) {
    if (sh.region_id && !regions[sh.region_id]) warnings.push(`shops.${sh.id}: unknown region_id "${sh.region_id}"`);
    const entries = String(sh.entries || '').split(',').map((x: string) => x.trim()).filter(Boolean);
    for (const e of entries) {
      const id = e.split(':')[0]?.trim();
      if (id && !chips[id]) warnings.push(`shops.${sh.id}: unknown chip "${id}"`);
    }
  }

  const bundle: DataBundle = { chips, viruses, regions, dropTables, missions, programAdvances, shops };
  const ok = errors.length === 0;
  return { data: bundle, report: { ok, errors, warnings, counts } };
}

export default loadTSVBundle;
