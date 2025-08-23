// src/lib/rules.ts
import { Element } from './types';

/** Element cycle: Fire > Wood > Elec > Aqua > Fire */
export const TYPE_ORDER: Element[] = ['Fire', 'Wood', 'Elec', 'Aqua'];

/** BN-style effectiveness: 2.0 super, 0.5 resisted, 1.0 neutral */
export function typeMultiplier(att: Element | 'Neutral', def: Element | 'Neutral'): number {
  if (att === 'Neutral' || def === 'Neutral') return 1.0;
  const i = TYPE_ORDER.indexOf(att as Element);
  if (i < 0) return 1.0;
  const loses = TYPE_ORDER[(i + 1) % 4]; // att beats -> loses for defender (super effective)
  const beats = TYPE_ORDER[(i + 3) % 4]; // att is resisted by -> defender beats attacker
  if (def === loses) return 2.0;
  if (def === beats) return 0.5;
  return 1.0;
}

/**
 * Letter-rule validator (up to 3 chips):
 *  ✓ All same chip name/id, OR
 *  ✓ Share a common letter (case-insensitive), with '*' acting as wildcard.
 */
export function validateLetterRule(chips: Array<{ id: string; letters: string }>): boolean {
  if (!chips || chips.length === 0) return true; // defend
  if (chips.length > 3) return false;

  // Same-name rule
  if (chips.every(c => c.id === chips[0].id)) return true;

  // Build letter sets (uppercased), allow '*' wildcard
  const letterSets = chips.map(c =>
    new Set(
      String(c.letters || '')
        .split(',')
        .map(s => s.trim().toUpperCase())
        .filter(Boolean)
    )
  );

  // Try any shared non-wildcard letter
  const candidates = [...letterSets[0]].filter(L => L !== '*');
  for (const L of candidates) {
    if (letterSets.every(set => set.has(L) || set.has('*'))) return true;
  }

  // Edge: all are wildcard-only
  if (letterSets.every(set => set.size > 0 && [...set].every(L => L === '*'))) return true;

  return false;
}
