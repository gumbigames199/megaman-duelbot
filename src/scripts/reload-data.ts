// src/scripts/reload-data.ts
import 'dotenv/config';
import loadTSVBundle from '../lib/tsv';

const dir = process.env.DATA_DIR || './data';
const { report } = loadTSVBundle(dir);

// Pretty output for CI / Railway logs
const counts = Object.entries(report.counts || {})
  .map(([k, v]) => `${k}:${v}`)
  .join(' • ') || 'none';

console.log(`📦 TSV load from ${dir}: ${report.ok ? 'OK' : 'ISSUES'}`);
console.log(`Counts: ${counts}`);

if (report.warnings?.length) {
  console.log('⚠️ Warnings:');
  for (const w of report.warnings) console.log('- ' + w);
}

if (report.errors?.length) {
  console.error('❌ Errors:');
  for (const e of report.errors) console.error('- ' + e);
  // Fail the process if errors so Railway build can stop
  process.exit(1);
}

process.exit(0);
