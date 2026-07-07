import { Element } from './types';
import { typeMultiplier } from './rules';

export interface DamageCtx {
  chip_pow: number;
  hits: number;
  navi_atk: number;
  target_def: number;
  chip_element: Element | 'Neutral';
  navi_element: Element | 'Neutral';
  crit_chance?: number;   // 0..1 or 0..100 accepted
  acc?: number;           // 0..1 or 0..100 accepted
  navi_acc?: number;      // 0..100
  target_evasion?: number;// 0..100
  def_element?: Element | 'Neutral';
  blind?: number;         // turns/status magnitude; any positive value applies a hit penalty
  rng: () => number;
}

export type DamageRoll = {
  hit: boolean;
  crit: boolean;
  total: number;
  perHit: number;
  hits: number;
  multiplier: number;
  hitChance: number;
};

export function rollHit(ctx: DamageCtx): boolean {
  return ctx.rng() < hitChance(ctx);
}

export function rollCrit(ctx: DamageCtx): boolean {
  return ctx.rng() < normalizeChance(ctx.crit_chance ?? 0.06, 0.06);
}

export function computeDamage(ctx: DamageCtx): number {
  return resolveDamageRoll(ctx).total;
}

export function resolveDamageRoll(ctx: DamageCtx): DamageRoll {
  const hc = hitChance(ctx);
  const hit = ctx.rng() < hc;
  if (!hit) {
    return { hit: false, crit: false, total: 0, perHit: 0, hits: Math.max(1, Math.trunc(ctx.hits || 1)), multiplier: 1, hitChance: hc };
  }

  const critChance = normalizeChance(ctx.crit_chance ?? 0.06, 0.06);
  const crit = ctx.rng() < critChance;
  const hits = Math.max(1, Math.trunc(Number(ctx.hits) || 1));
  const power = Math.max(0, Number(ctx.chip_pow) || 0);

  const atk = Math.max(0, Number(ctx.navi_atk) || 0);
  const def = Math.max(0, Number(ctx.target_def) || 0);
  const atkScale = 1 + atk / 40;
  const defScale = 1 + def / 45;
  const elemMult = typeMultiplier(ctx.chip_element, ctx.def_element ?? 'Neutral');
  const stab = ctx.chip_element !== 'Neutral' && ctx.chip_element === ctx.navi_element ? envFloat('STAB_MULT', 1.15) : 1.0;
  const critMult = crit ? envFloat('CRIT_MULT', 1.5) : 1.0;
  const randomMult = 0.95 + 0.10 * ctx.rng();
  const multiplier = elemMult * stab * critMult;

  const raw = power * (atkScale / defScale) * multiplier * randomMult;
  const perHit = Math.max(1, Math.floor(raw));

  let total = 0;
  for (let i = 0; i < hits; i++) {
    total += Math.max(1, Math.floor(perHit * Math.pow(0.85, i)));
  }

  return { hit, crit, total, perHit, hits, multiplier: elemMult, hitChance: hc };
}

export function hitChance(ctx: DamageCtx): number {
  const chipAcc = normalizeChance(ctx.acc ?? 0.95, 0.95);
  const naviAcc = clamp((Number(ctx.navi_acc ?? 100) || 100) / 100, 0.10, 2.00);
  const evasionPenalty = clamp((Number(ctx.target_evasion ?? 0) || 0) / 100, 0, 0.85);
  const blindPenalty = (ctx.blind && ctx.blind > 0) ? 0.70 : 1.00;

  return clamp(chipAcc * naviAcc * (1 - evasionPenalty) * blindPenalty, 0.05, 0.98);
}

function normalizeChance(v: any, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function envFloat(k: string, fallback: number): number {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
