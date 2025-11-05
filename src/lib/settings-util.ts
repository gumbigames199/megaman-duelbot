// src/lib/settings-util.ts
// Centralized settings & environment helpers.
// - Keeps the existing wantDmg(user_id) switch used in index.ts
// - Adds tolerant env parsing (RATE vs PCT, CSV vs JSON for STARTER_CHIPS)
// - Surfaces a typed ENV object other modules can import

import { getSettings } from './db';

/** Whether this user wants extra damage logs appended to turn results. */
export function wantDmg(user_id: string): boolean {
  try {
    const s = getSettings(user_id) as any;
    return !!(s?.wantDmg || s?.want_dmg || s?.wantDMG);
  } catch {
    return false;
  }
}

/* ---------------------------
 * Env parsing (tolerant)
 * --------------------------- */

function num(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Read boolean-ish env ("1", "true", "yes"). */
function boolEnv(k: string, d = false) {
  const v = String(process.env[k] ?? '').trim().toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

/** `VIRUS_CHIP_DROP_RATE` or legacy `VIRUS_CHIP_DROP_PCT` (converted to 0–1). */
function readDropRateBase() {
  const rate = process.env.VIRUS_CHIP_DROP_RATE;
  const pct  = process.env.VIRUS_CHIP_DROP_PCT;
  if (rate != null && rate !== '') return num(rate, 0.33);
  if (pct  != null && pct  !== '') return Math.max(0, num(pct, 33)) / 100;
  return 0.33;
}

/** Parse `STARTER_CHIPS` from CSV like "cannon:2,sword" or JSON "[]" / '["cannon"]'. */
function parseStarterChips(raw: string | undefined) {
  const text = (raw ?? '').trim();
  if (!text) return [] as { id: string; qty: number }[];

  // JSON array accepted
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        // Accept ["cannon","sword"] or [{id,qty}]
        return arr.map((entry: any) => {
          if (typeof entry === 'string') return { id: entry, qty: 1 };
          if (entry && typeof entry === 'object') {
            const id = String(entry.id || entry.chip || '').trim();
            const qty = Math.max(1, num(entry.qty ?? entry.quantity, 1));
            if (!id) return null;
            return { id, qty };
          }
          return null;
        }).filter(Boolean) as { id: string; qty: number }[];
      }
    } catch {
      // fall through to CSV
    }
  }

  // CSV "cannon:2,sword"
  return text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(tok => {
      const [idRaw, qtyRaw] = tok.split(':').map(t => t.trim());
      const id = idRaw || '';
      const qty = Math.max(1, num(qtyRaw, 1));
      return id ? { id, qty } : null;
    })
    .filter(Boolean) as { id: string; qty: number }[];
}

export const ENV = {
  // Gameplay timing
  ROUND_SECONDS: num(process.env.ROUND_SECONDS, 60),

  // Global drop mod used by rewards.ts (already supported there)
  GLOBAL_DROP_RATE_MULT: num(process.env.GLOBAL_DROP_RATE_MULT, 1.0),

  // Legacy-compatible base chip drop rate if you need it elsewhere
  VIRUS_CHIP_DROP_RATE: readDropRateBase(),

  // Starter config
  STARTER_ZENNY: num(process.env.STARTER_ZENNY, 0),
  STARTER_CHIPS: parseStarterChips(process.env.STARTER_CHIPS), // [] | CSV | JSON ok

  // Starter region
  START_REGION_ID: (process.env.START_REGION_ID || 'den_city').trim(),

  // Emoji (optional)
  ZENNY_EMOJI_ID: (process.env.ZENNY_EMOJI_ID || '').trim(),
  ZENNY_EMOJI_NAME: (process.env.ZENNY_EMOJI_NAME || 'zenny').trim(),

  // Caps (used wherever you enforce)
  MAX_HP_CAP: num(process.env.MAX_HP_CAP, 500),
  MAX_ATK_CAP: num(process.env.MAX_ATK_CAP, 99),
  MAX_DEF_CAP: num(process.env.MAX_DEF_CAP, 99),
  MAX_SPD_CAP: num(process.env.MAX_SPD_CAP, 50),
  MAX_ACC_CAP: num(process.env.MAX_ACC_CAP, 150),
  MAX_EVA_CAP: num(process.env.MAX_EVA_CAP, 50),
  MAX_CRIT_CAP: num(process.env.MAX_CRIT_CAP, 25),
};

// Convenience getters (optional usage elsewhere)
export function getRoundSeconds() { return ENV.ROUND_SECONDS; }
export function getStarterChips() { return ENV.STARTER_CHIPS.slice(); }
export function getDropRateBase() { return ENV.VIRUS_CHIP_DROP_RATE; }
