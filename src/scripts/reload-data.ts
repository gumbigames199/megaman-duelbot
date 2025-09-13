// src/scripts/reload-data.ts
import 'dotenv/config';
import tsv from '../lib/tsv';

function main() {
  // Clear cache then reload
  (tsv as any).invalidateBundleCache?.();
  const bundle = tsv(); // callable default export (no args)

  // Build a report similar to your previous shape
  const report = {
    ok: true,
    counts: {
      chips: bundle.chips.length,
      viruses: bundle.viruses.length,
      regions: bundle.regions.length,
      drop_tables: bundle.drop_tables.length,
      missions: bundle.missions.length,
      program_advances: bundle.program_advances.length,
      shops: bundle.shops.length,
    },
    // You can populate these later if you add validation back in lib/tsv
    warnings: [] as string[],
    errors: [] as string[],
  };

  const dir = process.env.DATA_DIR || './data';

  // Pretty output for CI / Railway logs
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
    process.exit(1); // fail build on errors
  }

  process.exit(0);
}

main();
