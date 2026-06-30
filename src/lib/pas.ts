// src/lib/pas.ts
import { getBundle, getChipById } from './data';
import type { ProgramAdvanceRow } from './types';

export type ProgramAdvanceMatch = {
  id: string;
  name: string;
  result_chip_id: string;
  required_chip_ids: string[];
  required_letters: string;
  description?: string;
};

/**
 * Back-compat helper: returns only the replacement chip id when a PA matches.
 */
export function detectPA(chosenIds: string[]): string | null {
  return detectPAResult(chosenIds)?.result_chip_id ?? null;
}

/**
 * Collapse the chosen chips into a Program Advance when the selected chip multiset
 * satisfies a row in program_advances.tsv.
 */
export function detectPAResult(chosenIds: string[]): ProgramAdvanceMatch | null {
  const normalizedChosen = chosenIds.map(id => String(id ?? '').trim()).filter(Boolean);
  if (!normalizedChosen.length) return null;

  const b = getBundle();
  const list = Object.values((b as any).programAdvances || {}) as ProgramAdvanceRow[];
  if (!list.length) return null;

  const chosenBag = makeBag(normalizedChosen);

  for (const pa of list) {
    const required = String((pa as any).required_chip_ids ?? (pa as any).parts ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (!required.length) continue;
    if (required.length !== normalizedChosen.length) continue;

    const resultId = String((pa as any).result_chip_id ?? '').trim();
    if (!resultId || !getChipById(resultId)) continue;

    if (!bagEquals(chosenBag, makeBag(required))) continue;
    if (!lettersSatisfied(normalizedChosen, String((pa as any).required_letters ?? '').trim())) continue;

    return {
      id: String((pa as any).id || resultId),
      name: String((pa as any).name || resultId),
      result_chip_id: resultId,
      required_chip_ids: required,
      required_letters: String((pa as any).required_letters ?? '').trim(),
      description: String((pa as any).description ?? '').trim() || undefined,
    };
  }

  return null;
}

function makeBag(ids: string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const id of ids) bag.set(id, (bag.get(id) || 0) + 1);
  return bag;
}

function bagEquals(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, qty] of a) if ((b.get(id) || 0) !== qty) return false;
  return true;
}

function lettersSatisfied(chosenIds: string[], requiredLettersRaw: string): boolean {
  const requiredLetters = requiredLettersRaw
    .split(/[,+| ]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!requiredLetters.length) return true;
  if (requiredLetters.includes('*')) return true;

  const b = getBundle() as any;
  for (const chipId of chosenIds) {
    const letters = String(b.chips?.[chipId]?.letters || '')
      .split(/[,+| ]+/)
      .map((x: string) => x.trim())
      .filter(Boolean);

    if (!letters.includes('*') && !requiredLetters.some(req => letters.includes(req))) return false;
  }
  return true;
}
