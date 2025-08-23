import 'dotenv/config';
import loadTSVBundle from '../src/lib/tsv';

(async () => {
  try {
    const { report } = loadTSVBundle(process.env.DATA_DIR || './data');
    const lines = [
      `✅ Load complete`,
      `counts: ${JSON.stringify(report.counts)}`,
      report.warnings.length ? `warnings:\n- ${report.warnings.join('\n- ')}` : 'warnings: none',
      report.errors.length ? `errors:\n- ${report.errors.join('\n- ')}` : 'errors: none'
    ];
    console.log(lines.join('\n'));
    if (!report.ok) process.exitCode = 1;
  } catch (e:any) {
    console.error('Load failed:', e?.message || e);
    process.exit(1);
  }
})();
