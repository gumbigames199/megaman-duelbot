// src/lib/rules.ts
import { Element } from './types';

/** Element cycle: Fire > Wood > Elec > Aqua > Fire */
export const TYPE_ORDER: Element[] = ['Fire', 'Wood', 'Elec', 'Aqua'];

/** BN-style effectiveness: 2.0 super, 0.5 resisted, 1.0 neutral */
export function typeMultiplier(att: Element | 'Neutral', def: Element | 'Neutral'): number {
  if (att === 'Neutral' || def === 'Neutral') return 1.0;
  const i = TYPE_ORDER.indexOf(att as Element);
  if (i < 0) return 1.0;
  const loses = TYPE_ORDER[(i + 1) % 4];
  const beats = TYPE_ORDER[(i + 3) % 4];
  if (def === loses) return 2.0;
  if (def === beats) return 0.5;
  return 1.0;
}

export type ChipRuleRef = {
  id?: string;
  name?: string;
  base_id?: string;
  baseId?: string;
  code?: string;
  letter?: string;
  letters?: string;
};

function chipBase(c: ChipRuleRef): string {
  return String(c.base_id ?? c.baseId ?? c.name ?? c.id ?? '').trim().toLowerCase();
}

function chipCodes(c: ChipRuleRef): Set<string> {
  const raw = String(c.code ?? c.letter ?? c.letters ?? '').trim();
  return new Set(
    raw
      .split(/[,+|; ]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Battle Network style chip-selection rule for up to 5 chips.
 *
 * Wildcard `*` chips are neutral helpers. They can join any otherwise-valid
 * selection and do not need to match chip name or chip code.
 *
 * The non-wildcard chips must satisfy one of these rules:
 *  - all share the same base chip name, OR
 *  - all share the same exact chip code.
 *
 * Examples:
 *  - Cannon A + Cannon B + Atk+10 * + Recover10 A => valid, because non-* chips share Cannon.
 *  - Cannon A + Sword A + Atk+10 * => valid, because non-* chips share A.
 *  - Cannon A + Sword B + Atk+10 * => invalid, because non-* chips share neither.
 */
export function validateLetterRule(chips: ChipRuleRef[]): boolean {
  if (!chips || chips.length === 0) return true;
  if (chips.length > 5) return false;

  const normalChips = chips.filter(c => !chipCodes(c).has('*'));

  // All-* selections and one real chip plus any number of * chips are legal.
  if (normalChips.length <= 1) return true;

  const bases = normalChips.map(chipBase).filter(Boolean);
  if (bases.length === normalChips.length && bases.every(b => b === bases[0])) return true;

  const codeSets = normalChips.map(chipCodes);
  if (codeSets.some(s => s.size === 0)) return false;

  const candidates = new Set<string>();
  for (const set of codeSets) {
    for (const c of set) if (c !== '*') candidates.add(c);
  }

  for (const code of candidates) {
    if (codeSets.every(set => set.has(code))) return true;
  }

  return false;
}
