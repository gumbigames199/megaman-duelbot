// src/scripts/generate-chip-codes.ts
// Expands data/chips.base.tsv into exact code-variant rows in data/chips.tsv.
// Example: Cannon with letters A,B,C,* becomes Cannon_A, Cannon_B, Cannon_C, Cannon_STAR.

import fs from 'node:fs';
import path from 'node:path';

function dataDir() {
  const raw = String(process.env.DATA_DIR || 'data').trim();
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function splitTSVLine(line: string) {
  return line.split('\t');
}

function readTSV(filePath: string): Array<Record<string, string>> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trimStart().startsWith('#'));
  if (!lines.length) return [];
  const headers = splitTSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = splitTSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

function writeTSV(filePath: string, rows: Array<Record<string, string>>) {
  if (!rows.length) throw new Error('No rows to write.');
  const headers = Object.keys(rows[0]);
  const out = [headers.join('\t')];
  for (const r of rows) out.push(headers.map(h => String(r[h] ?? '')).join('\t'));
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
}

function splitCodes(raw: string): string[] {
  return String(raw || '')
    .split(/[,|; ]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isUpgrade(r: Record<string, string>) {
  return ['1', 'true', 'yes', 'y'].includes(String(r.is_upgrade ?? '').trim().toLowerCase());
}

function codeSlug(code: string) {
  if (code === '*') return 'STAR';
  return code.toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'CODE';
}

function expandRows(baseRows: Array<Record<string, string>>) {
  const headers = Object.keys(baseRows[0] || {});
  for (const h of ['base_id', 'code', 'possible_codes']) if (!headers.includes(h)) headers.push(h);

  const out: Array<Record<string, string>> = [];
  const seen = new Set<string>();

  for (const row of baseRows) {
    const baseId = String(row.id || row.name || '').trim();
    if (!baseId) continue;
    const possibleCodes = splitCodes(row.letters || '').join(',');

    if (isUpgrade(row)) {
      const next: Record<string, string> = {};
      for (const h of headers) next[h] = row[h] ?? '';
      next.id = baseId;
      next.base_id = baseId;
      next.code = '';
      next.letters = '';
      next.possible_codes = possibleCodes;
      if (!seen.has(next.id)) {
        out.push(next);
        seen.add(next.id);
      }
      continue;
    }

    const codes = splitCodes(row.letters || '');
    if (!codes.length) codes.push('');

    for (const code of codes) {
      const next: Record<string, string> = {};
      for (const h of headers) next[h] = row[h] ?? '';
      next.id = code ? `${baseId}_${codeSlug(code)}` : baseId;
      next.base_id = baseId;
      next.code = code;
      next.letters = code;
      next.possible_codes = possibleCodes;

      if (seen.has(next.id)) throw new Error(`Duplicate generated chip id: ${next.id}`);
      out.push(next);
      seen.add(next.id);
    }
  }

  return out;
}

const dir = dataDir();
const basePath = path.join(dir, 'chips.base.tsv');
const outPath = path.join(dir, 'chips.tsv');
if (!fs.existsSync(basePath)) throw new Error(`Missing ${basePath}`);
const rows = readTSV(basePath);
const expanded = expandRows(rows);
writeTSV(outPath, expanded);
console.log(`[generate-chip-codes] ${rows.length} base rows -> ${expanded.length} code rows`);
console.log(`[generate-chip-codes] wrote ${outPath}`);
