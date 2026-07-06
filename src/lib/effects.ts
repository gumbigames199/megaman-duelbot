import type { Element } from './types';

export type StatusKey = 'burn' | 'freeze' | 'paralyze' | 'poison' | 'blind' | 'barrier' | 'aura';

export interface AuraState {
  element: Element | 'Neutral' | 'Any';
  hp: number;
}

export interface TimedBuffState {
  atk?: number;
  def?: number;
  acc?: number;
  evasion?: number;
  spd?: number;
  crit?: number;
  turns: number;
}

export interface StatusState {
  burn?: number;
  freeze?: number;
  paralyze?: number;
  poison?: number;
  blind?: number;
  barrier?: number;
  aura?: AuraState;
  buffs?: TimedBuffState[];
}

export type ParsedEffect = {
  burn?: { chance: number; turns: number };
  poison?: { chance: number; turns: number };
  freeze?: { chance: number; turns: number };
  paralyze?: { chance: number; turns: number };
  blind?: { chance: number; turns: number };
  barrier?: { hp: number; turns?: number };
  aura?: { element: Element | 'Neutral' | 'Any'; hp: number; turns?: number };
  heal?: { amount: number; turns?: number };
  attackPlus?: number;
};

export function parseEffects(text: string): ParsedEffect[] {
  const src = String(text || '').trim();
  if (!src) return [];

  const parts = src
    .split(/[|;]/)
    .flatMap(p => splitCommaSafe(p))
    .map(p => p.trim())
    .filter(Boolean);

  const out: ParsedEffect[] = [];
  for (const part of parts) {
    const p = part.trim();
    let m: RegExpMatchArray | null;

    m = p.match(/^Attack\s*\+\s*(\d+)$/i) || p.match(/^Atk\s*\+\s*(\d+)$/i);
    if (m) { out.push({ attackPlus: toInt(m[1], 0) }); continue; }

    m = p.match(/^Heal\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*t\s*)?\)$/i);
    if (m) { out.push({ heal: { amount: toInt(m[1], 0), turns: m[2] ? toInt(m[2], 1) : undefined } }); continue; }

    m = p.match(/^Barrier\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*t\s*)?\)$/i);
    if (m) { out.push({ barrier: { hp: toInt(m[1], 0), turns: m[2] ? toInt(m[2], 1) : undefined } }); continue; }

    m = p.match(/^Aura\s*\(\s*([A-Za-z]+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*t\s*)?\)$/i);
    if (m) { out.push({ aura: { element: toElement(m[1], true), hp: m[2] ? toInt(m[2], 100) : 100, turns: m[3] ? toInt(m[3], 1) : undefined } }); continue; }

    const status = p.match(/^(Burn|Poison|Freeze|Paralyze|Blind)\s*\(([^)]*)\)$/i);
    if (status) {
      const key = status[1].toLowerCase() as 'burn' | 'poison' | 'freeze' | 'paralyze' | 'blind';
      const parsed = parseStatusArgs(key, status[2]);
      out.push({ [key]: parsed } as ParsedEffect);
      continue;
    }
  }

  return out;
}

export function tickStart(targetHP: number, maxHP: number, s: StatusState): { hp: number; notes: string[] } {
  const notes: string[] = [];
  let hp = targetHP;

  if ((s.burn ?? 0) > 0) {
    const dmg = Math.max(1, Math.floor(maxHP * 0.05));
    hp = Math.max(0, hp - dmg);
    notes.push(`burn ${dmg}`);
  }

  if ((s.poison ?? 0) > 0) {
    const dmg = Math.max(1, Math.floor(maxHP * 0.08));
    hp = Math.max(0, hp - dmg);
    notes.push(`poison ${dmg}`);
  }

  return { hp, notes };
}

export function tickEnd(s: StatusState) {
  for (const k of ['burn', 'freeze', 'paralyze', 'poison', 'blind'] as const) {
    const val = s[k];
    if (typeof val === 'number') {
      const next = val - 1;
      if (next > 0) s[k] = next;
      else delete s[k];
    }
  }

  if (s.buffs?.length) {
    const next = s.buffs
      .map(b => ({ ...b, turns: b.turns - 1 }))
      .filter(b => b.turns > 0);
    if (next.length) s.buffs = next;
    else delete s.buffs;
  }
}

export function canActFromStatus(s: StatusState, rng: () => number): { canAct: boolean; reason?: string } {
  if ((s.freeze ?? 0) > 0) return { canAct: false, reason: 'frozen' };
  if ((s.paralyze ?? 0) > 0 && rng() < 0.5) return { canAct: false, reason: 'paralyzed' };
  return { canAct: true };
}

export function applyStatusEffect(target: StatusState, key: 'burn' | 'poison' | 'freeze' | 'paralyze' | 'blind', turns: number) {
  const t = Math.max(1, Math.trunc(turns || 1));
  target[key] = Math.max(target[key] ?? 0, t);
}

export function applyBuff(target: StatusState, buff: Omit<TimedBuffState, 'turns'> & { turns?: number }) {
  const turns = Math.max(1, Math.trunc(buff.turns ?? 3));
  const item: TimedBuffState = { turns };
  for (const k of ['atk', 'def', 'acc', 'evasion', 'spd', 'crit'] as const) {
    const n = Number((buff as any)[k]);
    if (Number.isFinite(n) && n !== 0) (item as any)[k] = Math.trunc(n);
  }
  if (Object.keys(item).length > 1) target.buffs = [...(target.buffs ?? []), item];
}

export function buffValue(s: StatusState, key: 'atk' | 'def' | 'acc' | 'evasion' | 'spd' | 'crit'): number {
  return (s.buffs ?? []).reduce((sum, b) => sum + (Number((b as any)[key]) || 0), 0);
}

export function addBarrier(target: StatusState, hp: number) {
  const amount = Math.max(0, Math.trunc(hp || 0));
  if (amount <= 0) return;
  target.barrier = Math.max(target.barrier ?? 0, amount);
}

export function addAura(target: StatusState, element: Element | 'Neutral' | 'Any', hp = 100) {
  target.aura = { element, hp: Math.max(1, Math.trunc(hp || 100)) };
}

export function absorbDamage(
  target: StatusState,
  incoming: number,
  attackElement: Element | 'Neutral'
): { damage: number; notes: string[] } {
  let dmg = Math.max(0, Math.trunc(incoming || 0));
  const notes: string[] = [];
  if (dmg <= 0) return { damage: 0, notes };

  if (target.aura) {
    const required = target.aura.element;
    const canBreak = required === 'Any' || required === 'Neutral' || required === attackElement;
    if (!canBreak) {
      notes.push(`Aura blocked ${dmg}.`);
      return { damage: 0, notes };
    }

    const blocked = Math.min(target.aura.hp, dmg);
    target.aura.hp -= blocked;
    dmg -= blocked;
    notes.push(`Aura absorbed ${blocked}.`);
    if (target.aura.hp <= 0) {
      delete target.aura;
      notes.push('Aura broke.');
    }
  }

  if ((target.barrier ?? 0) > 0 && dmg > 0) {
    const blocked = Math.min(target.barrier ?? 0, dmg);
    target.barrier = Math.max(0, (target.barrier ?? 0) - blocked);
    dmg -= blocked;
    notes.push(`Barrier absorbed ${blocked}.`);
    if ((target.barrier ?? 0) <= 0) delete target.barrier;
  }

  return { damage: dmg, notes };
}

export function statusSummary(s: StatusState): string {
  const parts: string[] = [];
  if (s.burn) parts.push(`Burn ${s.burn}t`);
  if (s.poison) parts.push(`Poison ${s.poison}t`);
  if (s.freeze) parts.push(`Freeze ${s.freeze}t`);
  if (s.paralyze) parts.push(`Paralyze ${s.paralyze}t`);
  if (s.blind) parts.push(`Blind ${s.blind}t`);
  if (s.barrier) parts.push(`Barrier ${s.barrier}`);
  if (s.aura) parts.push(`Aura ${s.aura.element}/${s.aura.hp}`);
  if (s.buffs?.length) parts.push('Buffed');
  return parts.join(' • ');
}

export function tryChance(chance: number, rng: () => number): boolean {
  return rng() <= normalizeChance(chance, 1);
}

function parseStatusArgs(key: string, argText: string): { chance: number; turns: number } {
  const args = String(argText || '').split(',').map(s => s.trim()).filter(Boolean);
  let chance = 1;
  let turns = defaultTurnsForStatus(key);

  for (const a of args) {
    const pct = a.match(/^(\d+(?:\.\d+)?)\s*%$/);
    const turn = a.match(/^(\d+)\s*t$/i);
    const num = a.match(/^(\d+(?:\.\d+)?)$/);
    if (pct) chance = Math.max(0, Math.min(1, Number(pct[1]) / 100));
    else if (turn) turns = Math.max(1, toInt(turn[1], turns));
    else if (num) {
      const n = Number(num[1]);
      if (key === 'paralyze' && n > 1) chance = Math.max(0, Math.min(1, n / 100));
      else if (n <= 1) chance = Math.max(0, Math.min(1, n));
      else turns = Math.max(1, Math.trunc(n));
    }
  }

  return { chance, turns };
}

function defaultTurnsForStatus(key: string): number {
  if (key === 'freeze') return 1;
  if (key === 'paralyze') return 1;
  if (key === 'blind') return 2;
  return 2;
}

function normalizeChance(v: any, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function splitCommaSafe(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function toElement(x: unknown, allowAny = false): Element | 'Neutral' | 'Any' {
  const s = String(x ?? '').trim().toLowerCase();
  if (allowAny && (s === 'any' || s === '*')) return 'Any';
  switch (s) {
    case 'fire': return 'Fire';
    case 'aqua':
    case 'water': return 'Aqua';
    case 'elec':
    case 'electric': return 'Elec';
    case 'wood':
    case 'grass': return 'Wood';
    case 'neutral':
    default: return 'Neutral';
  }
}

function toInt(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

export function startOfTurn(_s: StatusState, _who: 'player' | 'enemy') {}
export function endOfTurn(_s: StatusState, _who: 'player' | 'enemy') {}
