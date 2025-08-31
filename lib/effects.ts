// src/lib/effects.ts
export type StatusKey = 'burn' | 'freeze' | 'paralyze' | 'poison' | 'blind' | 'barrier' | 'aura';

export interface StatusState {
  burn?: number;     // turns left
  freeze?: number;   // skip next action
  paralyze?: number; // 50% skip action
  poison?: number;   // dmg over time
  blind?: number;    // -hit (handled in damage later)
  barrier?: number;  // shield hp
  aura?: string;     // element name (only that can break), or "any"
}

export function tickStart(targetHP: number, s: StatusState): { hp: number; notes: string[] } {
  const notes: string[] = [];

  // Burn: ~5% of current HP (min 1)
  if (s.burn && s.burn > 0) {
    const dmg = Math.max(1, Math.floor(targetHP * 0.05));
    targetHP = Math.max(0, targetHP - dmg);
    notes.push(`burn ${dmg}`);
  }

  // Poison: ~8% of current HP (min 1)
  if (s.poison && s.poison > 0) {
    const dmg = Math.max(1, Math.floor(targetHP * 0.08));
    targetHP = Math.max(0, targetHP - dmg);
    notes.push(`poison ${dmg}`);
  }

  return { hp: targetHP, notes };
}

export function tickEnd(s: StatusState) {
  // Decay duration-based statuses by 1
  for (const k of ['burn', 'freeze', 'paralyze', 'poison', 'blind'] as const) {
    const val = (s as Record<string, number | undefined>)[k];
    if (typeof val === 'number') {
      const next = val - 1;
      if (next > 0) {
        (s as Record<string, number>)[k] = next;
      } else {
        delete (s as Record<string, unknown>)[k];
      }
    }
  }
  // barrier/aura persist until consumed/explicitly removed
}

// Hooks (reserved for future logic)
export function startOfTurn(_s: StatusState, _who: 'player' | 'enemy') {}
export function endOfTurn(_s: StatusState, _who: 'player' | 'enemy') {}
