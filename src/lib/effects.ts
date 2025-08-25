// src/lib/effects.ts
export type StatusKey = 'burn' | 'freeze' | 'paralyze' | 'poison' | 'blind' | 'barrier' | 'aura';

export interface StatusState {
  burn?: number;       // turns left
  freeze?: number;     // skip next action this turn if >0
  paralyze?: number;   // 50% skip action while >0
  poison?: number;     // 8% max HP/turn (approx)
  blind?: number;      // -hit (handled in damage)
  barrier?: number;    // shield HP (absorbs until 0)
  aura?: string;       // element name that can break (or "any")
}

/**
 * Apply start-of-turn residuals (burn/poison) and return new HP + human notes.
 * NOTE: We don’t have max HP here; we approximate % off current HP so it scales gently.
 */
export function tickStart(targetHP: number, s: StatusState): { hp: number; notes: string[] } {
  const notes: string[] = [];

  // Burn: ~5% current HP (min 1)
  if (s.burn && s.burn > 0) {
    const dmg = Math.max(1, Math.floor(targetHP * 0.05));
    targetHP = Math.max(0, targetHP - dmg);
    notes.push(`burn ${dmg}`);
  }

  // Poison: ~8% current HP (min 1)
  if (s.poison && s.poison > 0) {
    const dmg = Math.max(1, Math.floor(targetHP * 0.08));
    targetHP = Math.max(0, targetHP - dmg);
    notes.push(`poison ${dmg}`);
  }

  return { hp: targetHP, notes };
}

/**
 * Decay duration-based statuses at end of turn.
 * Barrier/Aura persist until consumed/cleared by logic elsewhere.
 */
export function tickEnd(s: StatusState): void {
  const keys: (keyof StatusState)[] = ['burn', 'freeze', 'paralyze', 'poison', 'blind'];
  for (const k of keys) {
    if (typeof s[k] === 'number') {
      // @ts-expect-error index access is safe by runtime check above
      s[k] = (s[k] as number) - 1;
      // @ts-expect-error same as above
      if ((s[k] as number) <= 0) delete s[k];
    }
  }
  // barrier/aura unchanged here
}

// (Reserved hooks for future expansion)
export function startOfTurn(_s: StatusState, _who: 'player' | 'enemy'): void {}
export function endOfTurn(_s: StatusState, _who: 'player' | 'enemy'): void {}
