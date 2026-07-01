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
 * Battle Network style chip-selection rule for up to 3 chips:
 *  - all selected chips share the same base chip name, OR
 *  - all selected chips share one chip code, OR
 *  - wildcard * can stand in for any shared code.
 */
export function validateLetterRule(chips: ChipRuleRef[]): boolean {
  if (!chips || chips.length === 0) return true;
  if (chips.length > 3) return false;

  const bases = chips.map(chipBase).filter(Boolean);
  if (bases.length === chips.length && bases.every(b => b === bases[0])) return true;

  const codeSets = chips.map(chipCodes);
  if (codeSets.some(s => s.size === 0)) return false;

  const concreteCandidates = new Set<string>();
  for (const set of codeSets) {
    for (const c of set) if (c !== '*') concreteCandidates.add(c);
  }

  for (const code of concreteCandidates) {
    if (codeSets.every(set => set.has(code) || set.has('*'))) return true;
  }

  return codeSets.every(set => set.has('*'));
}
