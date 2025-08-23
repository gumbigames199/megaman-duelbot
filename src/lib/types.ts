// Elements & effectiveness
export type Element = 'Fire' | 'Aqua' | 'Elec' | 'Wood' | 'Neutral';

export const TYPE_ORDER: Element[] = ['Fire', 'Wood', 'Elec', 'Aqua']; // Fire>Wood>Elec>Aqua>Fire
export function effectiveness(attacker: Element, defender: Element): number {
  if (attacker === 'Neutral' || defender === 'Neutral') return 1.0;
  const i = TYPE_ORDER.indexOf(attacker);
  const beats = TYPE_ORDER[(i + 3) % 4]; // previous in cycle
  const loses = TYPE_ORDER[(i + 1) % 4]; // next in cycle
  if (defender === loses) return 2.0;
  if (defender === beats) return 0.5;
  return 1.0;
}

// ---- Status / battle state helpers ----
export interface StatusState {
  burn?: number;
  poison?: number;
  paralyze?: number;
  freeze?: number;
  blind?: number;
  barrier?: number;
  aura?: string;        // e.g., 'Aqua'
  [k: string]: any;     // keep flexible for MVP
}

// ---- TSV-backed shapes ----
export type ChipCategory = 'Shot' | 'Sword' | 'Bomb' | 'Support' | 'Barrier' | 'Other';

export interface ChipRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  letters: string;           // "A,B,C,*"
  mb_cost: number;
  power: number;             // base power; 0 for support/barrier
  hits: number;              // 1+ for multi-hit
  acc: number;               // 0..1
  category: ChipCategory | string;
  effects: string;           // DSL: Burn(20%,2t) | Barrier(100) | Heal(60)
  description: string;
  image_url: string;
  rarity: number;
  zenny_cost: number;
  stock: number;             // 1 visible in shop, 0 hidden
  is_upgrade: number;        // 1 upgrade token
}

export interface VirusRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  hp: number; atk: number; def: number; spd: number; acc: number;
  cr: number;
  region: string;
  zone: number;              // 1..3
  drop_table_id: string;
  image_url: string;
  anim_url: string;
  description: string;
  zenny_range: string;       // "50-120"
  move_1json?: string; move_2json?: string; move_3json?: string; move_4json?: string;
  boss?: string | number;
  stat_points?: number;
}

export interface BossRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  hp: number; atk: number; def: number; spd: number; acc: number;
  cr: number;
  region_id: string;
  signature_chip_id?: string;
  image_url?: string;
  anim_url?: string;
  background_url?: string;
  phase_thresholds?: string;  // "0.7,0.4"
  effects?: string;           // e.g., "Aura(Fire),Barrier(200)"
}

export interface RegionRow {
  id: string;
  name: string;
  background_url: string;
  encounter_rate: number;     // 0..1
  virus_pool_id: string;
  shop_id: string;
  boss_id: string;
  min_level: number;
  description: string;
  field_effects?: string;
  next_region_ids?: string;    // "yacobus,undernet_1"
}

export interface VirusPoolRow { id: string; virus_ids: string; }            // "mettaur,bunny"
export interface DropTableRow { id: string; entries: string; }              // "heatshot:30,sword:10"

export interface MissionRow {
  id: string; name: string; type: 'Defeat' | 'Collect' | 'Escort' | 'Challenge';
  requirement: string;       // e.g., "mettaur:3"
  region_id: string;
  reward_zenny: number;
  reward_chip_ids: string;   // "heatshot" or "heatshot,elecball"
  description: string;
  image_url: string;
}

export interface ProgramAdvanceRow {
  id: string; name: string; result_chip_id: string;
  required_chip_ids: string; // "sword,wide_sword,long_sword"
  required_letters: string;  // "S" or "A,B"
  description: string;
}

export interface ShopRow { id: string; region_id: string; entries: string; } // "heatshot:500,sword:600"

export interface DataBundle {
  chips: Record<string, ChipRow>;
  viruses: Record<string, VirusRow>;
  bosses: Record<string, BossRow>;
  regions: Record<string, RegionRow>;
  virusPools: Record<string, VirusPoolRow>;
  dropTables: Record<string, DropTableRow>;
  missions: Record<string, MissionRow>;
  programAdvances: Record<string, ProgramAdvanceRow>;
  shops: Record<string, ShopRow>;
}

export interface LoadReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { [k: string]: number };
}
