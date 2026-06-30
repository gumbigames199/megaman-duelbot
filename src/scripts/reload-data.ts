// src/scripts/reload-data.ts
import 'dotenv/config';
import { getBundle as getDataBundle, invalidateBundleCache } from '../lib/data';
import { normalizeChipIds } from '../lib/db';

type Report = {
  ok: boolean;
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
};

function countThing(x: any): number {
  if (Array.isArray(x)) return x.length;
  if (x instanceof Map) return x.size;
  if (x && typeof x === 'object') return Object.keys(x).length;
  return 0;
}

function asArray(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return Array.from(x.values()).flat();
  if (x && typeof x === 'object') return Object.values(x);
  return [];
}

function main() {
  invalidateBundleCache();
  const b = getDataBundle() as any;
  const normalized = normalizeChipIds();

  const chips = asArray(b.chip_list ?? b.chips);
  const viruses = asArray(b.virus_list ?? b.viruses);
  const regions = asArray(b.region_list ?? b.regions);
  const missions = asArray(b.mission_list ?? b.missions);
  const programAdvances = asArray(b.program_advance_list ?? b.programAdvances ?? b.program_advances);
  const shops = asArray(b.shop_list ?? b.shops);
  const dropTables = b.dropTables || b.drop_tables || {};

  const report: Report = {
    ok: true,
    counts: {
      chips: countThing(b.chips),
      viruses: countThing(b.viruses),
      regions: countThing(b.regions),
      drop_tables: countThing(dropTables),
      missions: countThing(b.missions),
      program_advances: countThing(b.programAdvances ?? b.program_advances),
      shops: countThing(b.shop_list ?? b.shops),
    },
    warnings: [],
    errors: [],
  };

  const regionIds = new Set<string>(regions.map((r: any) => String(r.id ?? '').trim()).filter(Boolean));
  const chipIds = new Set<string>(chips.map((c: any) => String(c.id ?? '').trim()).filter(Boolean));
  const virusIds = new Set<string>(viruses.map((v: any) => String(v.id ?? '').trim()).filter(Boolean));
  const dropTableIds = new Set<string>(asArray(dropTables).map((d: any) => String(d.id ?? '').trim()).filter(Boolean));

  checkDuplicateIds('Chip', chips, report, true);
  checkDuplicateIds('Virus', viruses, report, true);
  checkDuplicateIds('Region', regions, report, true);
  checkDuplicateIds('Drop table', asArray(dropTables), report, true);
  checkDuplicateIds('Mission', missions, report, false);
  checkDuplicateIds('Program Advance', programAdvances, report, false);

  for (const v of viruses) {
    const id = String(v.id ?? '').trim();
    if (v.region_id && !regionIds.has(String(v.region_id))) {
      report.warnings.push(`Virus ${id} references unknown region_id "${v.region_id}".`);
    }
    if (v.drop_table_id && !dropTableIds.has(String(v.drop_table_id))) {
      report.warnings.push(`Virus ${id} references missing drop_table "${v.drop_table_id}".`);
    }
    for (const key of ['move_1json', 'move_2json', 'move_3json', 'move_4json']) {
      const raw = String(v[key] ?? '').trim();
      if (!raw) continue;
      try { JSON.parse(raw); } catch { report.warnings.push(`Virus ${id} has malformed ${key}.`); }
    }
  }

  const resolvedShopItems = asArray(b.shopsByRegion);
  for (const s of shops) {
    if (s.region_id && !regionIds.has(String(s.region_id))) {
      report.errors.push(`Shop row references unknown region_id "${s.region_id}".`);
    }
  }
  for (const item of resolvedShopItems) {
    if (item.item_id && !chipIds.has(String(item.item_id))) {
      report.errors.push(`Shop in region "${item.region_id}" references unknown chip "${item.item_id}".`);
    }
  }

  for (const dt of asArray(dropTables)) {
    const entries = String(dt.entries ?? '').split(',').map((t: string) => t.trim()).filter(Boolean);
    for (const entry of entries) {
      const chipId = entry.split(':')[0].trim();
      if (chipId && !chipIds.has(chipId)) report.warnings.push(`Drop table "${dt.id}" references unknown chip "${chipId}".`);
    }
  }

  for (const pa of programAdvances) {
    const id = String(pa.id || pa.name || '?');
    const result = String(pa.result_chip_id || '').trim();
    if (result && !chipIds.has(result)) report.errors.push(`Program Advance "${id}" result_chip_id "${result}" is unknown.`);
    const parts = String(pa.required_chip_ids || pa.parts || '').split(',').map((t: string) => t.trim()).filter(Boolean);
    if (!parts.length) report.warnings.push(`Program Advance "${id}" has no required_chip_ids.`);
    for (const part of parts) if (!chipIds.has(part)) report.errors.push(`Program Advance "${id}" references unknown chip "${part}".`);
  }

  for (const m of missions) {
    const id = String(m.id || m.name || '?');
    if (m.region_id && !regionIds.has(String(m.region_id))) report.warnings.push(`Mission "${id}" references unknown region_id "${m.region_id}".`);

    if (String(m.type || '').toLowerCase() === 'defeat') {
      const [virusId, countRaw] = String(m.requirement || '').split(':').map((t: string) => t.trim());
      if (!virusId) report.warnings.push(`Mission "${id}" has blank defeat requirement.`);
      else if (!virusIds.has(virusId)) report.warnings.push(`Mission "${id}" references unknown virus "${virusId}".`);
      if (countRaw && !(Number(countRaw) > 0)) report.warnings.push(`Mission "${id}" has invalid defeat count "${countRaw}".`);
    }

    for (const chipId of String(m.reward_chip_ids || '').split(',').map((t: string) => t.trim()).filter(Boolean)) {
      if (!chipIds.has(chipId)) report.warnings.push(`Mission "${id}" rewards unknown chip "${chipId}".`);
    }
  }

  if (report.errors.length) report.ok = false;

  const dir = process.env.DATA_DIR || './data';
  const countsLine = Object.entries(report.counts).map(([k, v]) => `${k}:${v}`).join(' • ') || 'none';

  console.log(`📦 TSV load from ${dir}: ${report.ok ? 'OK' : 'ISSUES'}`);
  console.log(`Counts: ${countsLine}`);
  console.log(`Chip ID normalization: inventory:${normalized.fixedInventory} folder:${normalized.fixedFolder}`);

  if (report.warnings.length) {
    console.log('⚠️ Warnings:');
    for (const w of report.warnings) console.log('- ' + w);
  }

  if (report.errors.length) {
    console.error('❌ Errors:');
    for (const e of report.errors) console.error('- ' + e);
    process.exit(1);
  }

  process.exit(0);
}

function checkDuplicateIds(label: string, rows: any[], report: Report, hard: boolean) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    if (!id) {
      (hard ? report.errors : report.warnings).push(`${label} row missing id.`);
      continue;
    }
    if (seen.has(id)) (hard ? report.errors : report.warnings).push(`Duplicate ${label.toLowerCase()} id "${id}".`);
    seen.add(id);
  }
}

main();
