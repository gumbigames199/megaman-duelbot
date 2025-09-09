// src/lib/types.ts

/** Elements & effectiveness */
export type Element = 'Fire' | 'Aqua' | 'Elec' | 'Wood' | 'Neutral';

export const TYPE_ORDER: Element[] = ['Fire', 'Wood', 'Elec', 'Aqua']; // Fire > Wood > Elec > Aqua > Fire
export function effectiveness(attacker: Element, defender: Element): number {
  if (attacker === 'Neutral' || defender === 'Neutral') return 1.0;
  const i = TYPE_ORDER.indexOf(attacker);
  const beats = TYPE_ORDER[(i + 3) % 4];
  const loses = TYPE_ORDER[(i + 1) % 4];
  if (defender === loses) return 2.0;
  if (defender === beats) return 0.5;
  return 1.0;
}

export interface ChipRow {
  // ...existing...
  is_upgrade: number;
  max_copies?: number; // NEW
}

/** Loader/report shape used by /reload_data */
export interface LoadReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { [k: string]: number };
}

/* =========================
 * DB Rows
 * ========================= */

export interface PlayerRow {
  user_id: string;
  name?: string;

  element: Element | 'Neutral';

  level: number;
  /** Older schema used `exp`; newer code may use `xp`. Support both. */
  exp?: number;
  xp?: number;

  hp_max: number;
  atk: number;
  def: number;
  spd: number;
  acc: number;
  evasion: number;
  zenny: number;

  region_id?: string | null;
  zone?: number | null;

  [k: string]: any;
}

/* =========================
 * TSV-backed shapes
 * ========================= */

export type ChipCategory = 'Shot' | 'Sword' | 'Bomb' | 'Support' | 'Barrier' | 'Other';

export interface ChipRow {
  id: string;
  name: string;
  element: Element | 'Neutral' | string;
  letters: string;
  mb_cost: number;
  power: number;
  hits: number;
  acc: number; // 0..1
  category: ChipCategory | string;
  effects: string;
  description: string;
  image_url: string;
  rarity: number;
  zenny_cost: number;
  stock: number;
  is_upgrade: number; // 0/1
}

export interface VirusRow {
  id: string;
  name: string;
  element: Element | 'Neutral' | string;
  hp: number; atk: number; def: number; spd: number; acc: number;
  cr: number;

  region: string;

  /** NEW: parsed from TSV "zone" (e.g., "1,2,4-6") into [1,2,4,5,6] */
  zones: number[];
  /** Legacy/compat: some old code referenced a single zone number */
  zone?: number;

  drop_table_id?: string;

  image_url: string;
  anim_url: string;
  description: string;

  zenny_range: string;  // "50-120"
  xp_range: string;     // "30-60"

  move_1json?: string; move_2json?: string; move_3json?: string; move_4json?: string;

  /** 0/1 flag; bosses now live in viruses.tsv */
  boss: 0 | 1;

  stat_points?: number;

  /** Optional: some bosses may carry this on the row */
  phase_thresholds?: string;
}

export interface RegionRow {
  id: string;
  name: string;
  background_url: string;
  encounter_rate: number;

  /** Legacy fields kept optional for back-compat (not used by new model) */
  virus_pool_id?: string;
  boss_id?: string;

  shop_id?: string;
  min_level: number;
  description: string;
  field_effects?: string;
  /** NEW: number of zones (defaults to 1 if missing) */
  zone_count?: number;
  next_region_ids?: string;
}

export interface DropTableRow { id: string; entries: string; }

export interface MissionRow {
  id: string;
  name: string;
  type: 'Defeat'|'Collect'|'Escort'|'Challenge' | string;
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

/* =========================
 * Data bundle returned by loadTSVBundle()
 * (Bosses & VirusPools removed in new model)
 * ========================= */

export interface DataBundle {
  chips: Record<string, ChipRow>;
  viruses: Record<string, VirusRow>;
  regions: Record<string, RegionRow>;
  dropTables: Record<string, DropTableRow>;
  missions: Record<string, MissionRow>;
  programAdvances: Record<string, ProgramAdvanceRow>;
  shops: Record<string, ShopRow>;
}

/* =========================
 * High-level gameplay types (your newer file)
 * — alias to row types so both styles compile
 * ========================= */

export type Chip = ChipRow;
export type Region = Required<Pick<RegionRow, 'id' | 'name'>> & {
  zone_count: number;
  min_level: number;
  encounter_rate?: number;
  background_url?: string;
  description?: string;
  shop_id?: string;
} & { [k: string]: any };

export type Virus = {
  id: string;
  name: string;
  region: string;
  zones: number[];
  boss: boolean;
  element?: string;
  hp?: number; atk?: number; def?: number; spd?: number; acc?: number; eva?: number;
  moves?: string;
  drop_table_id?: string;
  [k: string]: any;
};

/* =========================
 * Back-compat stubs for removed tables
 * ========================= */

export type BossRow = never;
export type VirusPoolRow = never;
