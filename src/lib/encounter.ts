import { getBundle } from './data';

const BOSS_ENCOUNTER = parseFloat(process.env.BOSS_ENCOUNTER || '0.10');

export function pickEncounter(regionId: string, zone: number, rng = Math.random) {
  const { viruses } = getBundle();

  // try boss
  if (rng() < BOSS_ENCOUNTER) {
    const boss = Object.values(viruses).find(v => v.boss && v.region === regionId && v.zones.includes(zone));
    if (boss) return { enemy_kind: 'boss' as const, virus: boss };
  }

  // normal uniform
  const candidates = Object.values(viruses).filter(v => !v.boss && v.region === regionId && v.zones.includes(zone));
  if (!candidates.length) {
    throw new Error(`No non-boss encounter candidates for ${regionId} zone ${zone}`);
  }
  const pick = candidates[Math.floor(rng() * candidates.length)];
  return { enemy_kind: 'virus' as const, virus: pick };
}
