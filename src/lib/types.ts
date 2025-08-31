// Elements & effectiveness
export type Element = 'Fire' | 'Aqua' | 'Elec' | 'Wood' | 'Neutral';

export const TYPE_ORDER: Element[] = ['Fire', 'Wood', 'Elec', 'Aqua']; // Fire>Wood>Elec>Aqua>Fire
export function effectiveness(attacker: Element, defender: Element): number {
  if (attacker === 'Neutral' || defender === 'Neutral') return 1.0;
  const i = TYPE_ORDER.indexOf(attacker);
  const beats = TYPE_ORDER[(i + 3) % 4];
  const loses = TYPE_ORDER[(i + 1) % 4];
  if (defender === loses) return 2.0;
  if (defender === beats) return 0.5;
  return 1.0;
}

// ---- Player row (DB) ----
export interface PlayerRow {
  user_id: string;
  name: string;
  element: Element | 'Neutral';
  level: number;
  exp: number;
  hp_max: number;
  atk: number;
  def: number;
  spd: number;
  acc: number;
  evasion: number;
  zenny: number;
  region_id?: string | null;
}

// ---- TSV-backed shapes ----
export type ChipCategory = 'Shot' | 'Sword' | 'Bomb' | 'Support' | 'Barrier' | 'Other';

export interface ChipRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  letters: string;
  mb_cost: number;
  power: number;
  hits: number;
  acc: number;
  category: ChipCategory | string;
  effects: string;
  description: string;
  image_url: string;
  rarity: number;
  zenny_cost: number;
  stock: number;
  is_upgrade: number;
}

export interface VirusRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  hp: number; atk: number; def: number; spd: number; acc: number;
  cr: number;
  region: string;
  zone: number;                 // 1..3+
  drop_table_id: string;
  image_url: string;
  anim_url: string;
  description: string;
  zenny_range: string;          // "50-120"
  xp_range: string;             // NEW, e.g. "30-60"
  move_1json?: string; move_2json?: string; move_3json?: string; move_4json?: string;
  boss?: number | boolean;      // 0/1 or true/false
  stat_points?: number;
}

// NEW: BossRow (used by /boss and battle)
export interface BossRow {
  id: string;
  name: string;
  element: Element | 'Neutral';
  hp: number; atk: number; def: number; spd: number; acc: number;
  cr: number;
  region_id: string;
  signature_chip_id: string;
  image_url: string;
  anim_url: string;
  background_url: string;
  phase_thresholds?: string;
  effects?: string;
  description?: string; // optional to avoid hard fail if TSV omits it
}

export interface RegionRow {
  id: string;
  name: string;
  background_url: string;
  encounter_rate: number;
  virus_pool_id: string;
  shop_id: string;
  boss_id: string;
  min_level: number;
  description: string;
  field_effects?: string;
  zone_count?: number; // NEW (defaults to 1 if missing)
  next_region_ids?: string;
}

export interface VirusPoolRow { id: string; virus_ids: string; }
export interface DropTableRow { id: string; entries: string; }

export interface MissionRow {
  id: string; name: string; type: 'Defeat'|'Collect'|'Escort'|'Challenge';
  requirement: string;
  region_id: string;
  reward_zenny: number;
  reward_chip_ids: string;
  description: string;
  image_url: string;
}

export interface ProgramAdvanceRow {
  id: string; name: string; result_chip_id: string;
  required_chip_ids: string;
  required_letters: string;
  description: string;
}

export interface ShopRow { id: string; region_id: string; entries: string; }

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
