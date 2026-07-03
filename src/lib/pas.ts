// src/lib/pas.ts
import {
  chipBaseId,
  chipCode,
  getBundle,
  getChipById,
  resolveChipIdLoose,
} from './data';
import type { ProgramAdvanceRow } from './types';

export type ProgramAdvanceMatch = {
  id: string;
  name: string;
  result_chip_id: string;
  required_chip_ids: string[];
  required_letters: string;
  description?: string;
};

/** Back-compat helper: returns only the replacement chip id when a PA matches. */
export function detectPA(chosenIds: string[]): string | null {
  return detectPAResult(chosenIds)?.result_chip_id ?? null;
}

/**
 * Collapse selected exact chip variants into a Program Advance.
 * Program Advances are order-sensitive: chip 1, chip 2, and chip 3 must match
 * the TSV sequence in required_chip_ids and required_letters.
 */
export function detectPAResult(chosenIds: string[]): ProgramAdvanceMatch | null {
  const normalizedChosen = chosenIds.map(id => String(id ?? '').trim()).filter(Boolean);
  if (!normalizedChosen.length) return null;

  const b = getBundle();
  const list = Object.values((b as any).programAdvances || {}) as ProgramAdvanceRow[];
  if (!list.length) return null;

  for (const pa of list) {
    const required = parseList((pa as any).required_chip_ids ?? (pa as any).parts ?? '');
    if (!required.length) continue;
    if (required.length !== normalizedChosen.length) continue;

    const resultRaw = String((pa as any).result_chip_id ?? '').trim();
    const resultId = getChipById(resultRaw) ? resultRaw : resolveChipIdLoose(resultRaw);
    if (!resultId || !getChipById(resultId)) continue;

    if (!sequenceBasesSatisfied(normalizedChosen, required)) continue;
    if (!sequenceLettersSatisfied(normalizedChosen, String((pa as any).required_letters ?? '').trim(), required.length)) continue;

    return {
      id: String((pa as any).id || resultId),
      name: String((pa as any).name || resultRaw || resultId),
      result_chip_id: resultId,
      required_chip_ids: required,
      required_letters: String((pa as any).required_letters ?? '').trim(),
      description: String((pa as any).description ?? '').trim() || undefined,
    };
  }

  return null;
}

function parseList(raw: any): string[] {
  return String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function baseForToken(token: string): string {
  const chip = getChipById(token) as any;
  if (chip) return chipBaseId(chip) || String(chip.name ?? chip.id ?? token);

  const resolved = resolveChipIdLoose(token);
  const resolvedChip = resolved ? getChipById(resolved) as any : null;
  if (resolvedChip) return chipBaseId(resolvedChip) || String(resolvedChip.name ?? resolvedChip.id ?? token);

  return String(token ?? '').trim();
}

function normBase(s: string): string {
  return String(s ?? '').trim().toLowerCase();
}

function sequenceBasesSatisfied(chosenIds: string[], requiredTokens: string[]): boolean {
  for (let i = 0; i < requiredTokens.length; i++) {
    const chosenBase = normBase(baseForToken(chosenIds[i]));
    const requiredBase = normBase(baseForToken(requiredTokens[i]));
    if (!chosenBase || chosenBase !== requiredBase) return false;
  }
  return true;
}

function sequenceLettersSatisfied(chosenIds: string[], requiredLettersRaw: string, requiredCount: number): boolean {
  const tokens = String(requiredLettersRaw ?? '')
    .split(/[,+| ]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (!tokens.length) return true;

  // Legacy row support: a single * means no code restriction.
  if (tokens.length === 1 && tokens[0] === '*') return true;

  // Legacy row support: one non-star code applies to all required chips.
  const perSlot = tokens.length === 1 && requiredCount > 1
    ? Array.from({ length: requiredCount }, () => tokens[0])
    : tokens;

  if (perSlot.length !== requiredCount) return false;

  for (let i = 0; i < chosenIds.length; i++) {
    const required = perSlot[i];
    const chip = getChipById(chosenIds[i]) as any;
    const code = chipCode(chip).toUpperCase();

    // In a per-slot sequence, required * means the selected chip must be *.
    if (required === '*') {
      if (code !== '*') return false;
      continue;
    }

    // A selected * can substitute for a normal required code.
    if (code !== '*' && code !== required) return false;
  }

  return true;
}
