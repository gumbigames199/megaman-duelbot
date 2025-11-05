// src/scripts/reload-data.ts
import 'dotenv/config';
import tsv from '../lib/tsv';

function main() {
  // Clear the in-memory cache (if exposed by the module), then reload.
  (tsv as any).invalidateBundleCache?.();

  // Default export is callable with no args in your setup.
  const bundle = tsv();

  // Build a lightweight report for CI/Railway logs.
  const report = {
    ok: true,
    counts: {
      chips: bundle?.chips?.length ?? 0,
      viruses: bundle?.viruses?.length ?? 0,
      regions: bundle?.regions?.length ?? 0,
      drop_tables: bundle?.drop_tables?.length ?? 0,
      missions: bundle?.missions?.length ?? 0,
      program_advances: bundle?.program_advances?.length ?? 0,
      shops: bundle?.shops?.length ?? 0,
    },
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
