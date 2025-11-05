// src/scripts/reload-data.ts
import 'dotenv/config';
import tsv from '../lib/tsv';
import { getBundle as getRawBundle } from '../lib/tsv';
import { getBundle as getDataBundle, invalidateBundleCache } from '../lib/data';

type Report = {
  ok: boolean;
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
};

function main() {
  // Force a fresh read from /data
  (tsv as any).invalidateBundleCache?.();
  const bundle = (getRawBundle as any)(); // raw TSV bundle

  // Normalize via data.ts (adds dropTables alias, etc.)
  invalidateBundleCache();
  const b = getDataBundle() as any;

  const report: Report = {
    ok: true,
    counts: {
      chips: (b.chips || []).length,
      viruses: (b.viruses || []).length,
      regions: (b.regions || []).length,
      drop_tables: Object.keys(b.dropTables || b.drop_tables || {}).length,
      missions: (b.missions || []).length,
      program_advances: (b.program_advances || []).length,
      shops: (b.shops || []).length,
    },
    warnings: [],
    errors: [],
  };

  // ------------------------------
  // Integrity checks (non-fatal -> warnings, fatal -> errors)
  // ------------------------------
  const regionIds = new Set<string>((b.regions || []).map((r: any) => r.id));
  const chipIds   = new Set<string>((b.chips || []).map((c: any) => c.id));
  const virusIds  = new Set<string>((b.viruses || []).map((v: any) => v.id));
  const dropTbls  = b.dropTables || b.drop_tables || {};

  // Regions referenced by viruses
  for (const v of b.viruses || []) {
    if (v.region_id && !regionIds.has(v.region_id)) {
      report.warnings.push(`Virus ${v.id} references unknown region_id "${v.region_id}".`);
    }
    if (v.drop_table_id && !(v.drop_table_id in dropTbls)) {
      report.warnings.push(`Virus ${v.id} references missing drop_table "${v.drop_table_id}".`);
    }
  }

  // Shops must reference valid region + chip
  for (const s of b.shops || []) {
    if (s.region_id && !regionIds.has(s.region_id)) {
      report.errors.push(`Shop row references unknown region_id "${s.region_id}".`);
    }
    if (s.item_id && !chipIds.has(s.item_id)) {
      report.errors.push(`Shop row in region "${s.region_id}" references unknown chip "${s.item_id}".`);
    }
  }

  // Program advances reference chips (optional sanity)
  for (const pa of b.program_advances || []) {
    const parts = String(pa.parts || '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const p of parts) {
      if (!chipIds.has(p)) {
        report.warnings.push(`Program Advance "${pa.id || pa.name}" references unknown chip "${p}".`);
      }
    }
  }

  // Missions reference viruses/regions (if present)
  for (const m of b.missions || []) {
    if (m.region_id && !regionIds.has(m.region_id)) {
      report.warnings.push(`Mission "${m.id || m.name}" references unknown region_id "${m.region_id}".`);
    }
    const defeatList = String((m as any).defeat_viruses || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const vid of defeatList) {
      if (!virusIds.has(vid)) {
        report.warnings.push(`Mission "${m.id || m.name}" references unknown virus "${vid}".`);
      }
    }
  }

  // Flip ok if any errors
  if (report.errors.length) report.ok = false;

  // Pretty output for Railway logs
  const dir = process.env.DATA_DIR || './data';
  const countsLine =
    Object.entries(report.counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(' • ') || 'none';

  console.log(`📦 TSV load from ${dir}: ${report.ok ? 'OK' : 'ISSUES'}`);
  console.log(`Counts: ${countsLine}`);

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

main();
