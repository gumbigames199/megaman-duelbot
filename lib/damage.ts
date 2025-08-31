import { Element } from './types';
import { typeMultiplier } from './rules';

export interface DamageCtx {
  chip_pow: number;             // chip.power
  hits: number;                 // chip.hits (≥1)
  navi_atk: number;             // player atk
  target_def: number;           // enemy def
  chip_element: Element | 'Neutral';
  navi_element: Element | 'Neutral';
  crit_chance?: number;         // default 0.06
  acc?: number;                 // chip acc (0..1), default 0.95
  navi_acc?: number;            // player acc% (e.g., 90)
  target_evasion?: number;      // enemy evasion% (e.g., 10)
  def_element?: Element | 'Neutral';
  rng: () => number;            // uniform [0,1)
}

export function rollHit(ctx: DamageCtx): boolean {
  const chipAcc = ctx.acc ?? 0.95;
  const hit = clamp(
    chipAcc * ((ctx.navi_acc ?? 90) / Math.max(1, ctx.target_evasion ?? 10)),
    0.05, 0.98
  );
  return ctx.rng() < hit;
}
export function rollCrit(ctx: DamageCtx): boolean {
  const p = clamp(ctx.crit_chance ?? 0.06, 0, 1);
  return ctx.rng() < p;
}

export function computeDamage(ctx: DamageCtx): number {
  // base
  const ScaledAtk = 1 + (ctx.navi_atk / 40);
  const ScaledDef = 1 + (ctx.target_def / 40);
  const eff = typeMultiplier(ctx.chip_element, ctx.def_element ?? 'Neutral');
  const stab = ctx.chip_element === ctx.navi_element ? 1.2 : 1.0;
  const crit = rollCrit(ctx) ? 1.5 : 1.0;
  const rnd = 0.95 + 0.10 * ctx.rng();
  const raw = ctx.chip_pow * (ScaledAtk / ScaledDef) * eff * stab * crit * rnd;

  // multi‑hit decay
  const perHit = Math.max(0, Math.floor(raw));
  let total = 0;
  for (let k = 0; k < Math.max(1, ctx.hits); k++) {
    total += Math.floor(perHit * Math.pow(0.85, k));
  }
  return total;
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
