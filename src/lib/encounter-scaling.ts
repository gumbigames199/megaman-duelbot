import { getEncounterRuleByRegion, listVirusesForRegionZone } from './data';

export type EncounterEnemy = {
  virus_id: string;
  enemy_kind: 'virus' | 'boss';
};

export type ScaledEncounter = {
  enemy_kind: 'virus' | 'boss';
  primary: any;
  enemies: EncounterEnemy[];
  rule: any | null;
  debug: {
    normals: number;
    bosses: number;
    targetSize: number;
    budget: number;
  };
};

const DEFAULT_BOSS_ENCOUNTER = Number(process.env.BOSS_ENCOUNTER_RATE ?? process.env.BOSS_ENCOUNTER ?? 0.10);

function isBossFlag(v: any): boolean {
  const raw = v?.boss ?? v?.is_boss;
  if (raw === true || raw === false) return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function rollPct(pct: number): boolean {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Math.random() * 100 < Math.min(100, Math.max(0, n));
}

function pickOne<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function asInt(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function threatScore(v: any): number {
  const hp = Math.max(0, Number(v?.hp) || 0);
  const atk = Math.max(0, Number(v?.atk) || 0);
  const def = Math.max(0, Number(v?.def) || 0);
  const statusText = JSON.stringify(v ?? {}).toLowerCase();
  let score = 1;
  score += Math.floor(hp / 80);
  score += Math.floor(atk / 30);
  score += Math.floor(def / 40);
  if (statusText.includes('paralyze') || statusText.includes('freeze')) score += 1;
  if (statusText.includes('poison') || statusText.includes('burn')) score += 1;
  return Math.max(1, score);
}

function defaultRuleForRegion(regionMinLevel: number) {
  const band = Math.max(0, Math.floor(regionMinLevel / 5));
  return {
    min_player_level: regionMinLevel,
    encounter_budget: Math.max(2, 2 + band),
    min_enemies: band >= 4 ? 2 : 1,
    max_enemies: band >= 3 ? 3 : band >= 1 ? 2 : 1,
    multi_enemy_chance: Math.min(85, band * 10),
    overlevel_bonus_every: 5,
    overlevel_bonus_chance: 20,
    boss_support_max: band >= 7 ? 2 : band >= 3 ? 1 : 0,
    boss_support_chance: Math.min(65, band * 8),
  };
}

function targetNormalSize(_rule: any, _playerLevel: number, _regionMinLevel: number): number {
  const roll = Math.random();
  if (roll < 0.50) return 1;
  if (roll < 0.80) return 2;
  return 3;
}


function buildNormalGroup(normals: any[], targetSize: number, _budget: number): any[] {
  const pool = normals.filter(Boolean);
  if (!pool.length) return [];

  const out: any[] = [];
  const count = Math.max(1, Math.min(3, Math.trunc(Number(targetSize) || 1)));
  for (let i = 0; i < count; i++) {
    const pick = pickOne(pool);
    if (pick) out.push(pick);
  }
  return out;
}


function buildBossGroup(boss: any, _normals: any[], _rule: any): any[] {
  return [boss];
}


export function chooseScaledEncounter(opts: {
  region_id: string;
  zone: number;
  playerLevel: number;
  regionMinLevel?: number;
  bossEncounterRate?: number;
}): ScaledEncounter | null {
  const regionMinLevel = Math.max(1, asInt(opts.regionMinLevel, 1));
  const playerLevel = Math.max(1, asInt(opts.playerLevel, 1));
  const rule = getEncounterRuleByRegion(opts.region_id) || defaultRuleForRegion(regionMinLevel);
  const budget = Math.max(1, asInt(rule?.encounter_budget, 2));

  const eligible = listVirusesForRegionZone({
    region_id: opts.region_id,
    zone: opts.zone,
    includeNormals: true,
    includeBosses: true,
  }) as any[];

  const bosses = eligible.filter(isBossFlag);
  const normals = eligible.filter(v => !isBossFlag(v));

  if (!bosses.length && !normals.length) return null;

  const bossRate = Number.isFinite(opts.bossEncounterRate) ? Number(opts.bossEncounterRate) : DEFAULT_BOSS_ENCOUNTER;
  const wantBoss = bosses.length > 0 && (normals.length === 0 || Math.random() < Math.max(0, Math.min(1, bossRate)));

  if (wantBoss) {
    const boss = pickOne(bosses)!;
    const group = buildBossGroup(boss, normals, rule);
    return {
      enemy_kind: 'boss',
      primary: boss,
      enemies: group.map((v, i) => ({ virus_id: String(v.id), enemy_kind: i === 0 ? 'boss' : 'virus' })),
      rule,
      debug: { normals: normals.length, bosses: bosses.length, targetSize: group.length, budget },
    };
  }

  const targetSize = targetNormalSize(rule, playerLevel, regionMinLevel);
  const group = buildNormalGroup(normals.length ? normals : bosses, targetSize, budget);
  if (!group.length) return null;

  return {
    enemy_kind: 'virus',
    primary: group[0],
    enemies: group.map(v => ({ virus_id: String(v.id), enemy_kind: isBossFlag(v) ? 'boss' : 'virus' })),
    rule,
    debug: { normals: normals.length, bosses: bosses.length, targetSize: group.length, budget },
  };
}
