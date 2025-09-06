// src/lib/types.ts

// -------- Chips --------
export type Chip = {
  id: string;
  name: string;
  code?: string;          // e.g., A/B/C/*
  element?: string;       // Fire/Wood/Elec/Aqua/Neutral
  power?: number;
  hits?: number;
  effects?: string;       // raw TSV effects string (e.g., "Burn(20%,2t)")
  is_upgrade?: boolean;   // shop gating
  stock?: number;         // 0/1
  zenny_cost?: number;    // shop price
  [k: string]: any;       // keep permissive for existing fields
};

// -------- Regions (level-gated) --------
export type Region = {
  id: string;
  name: string;
  zone_count: number;     // number of zones in this region
  min_level: number;      // level required to unlock
  encounter_rate?: number;
  background_url?: string;
  description?: string;
  shop_id?: string;
  [k: string]: any;
};

// -------- Viruses --------
export type Virus = {
  id: string;
  name: string;
  region: string;         // Region.id
  zones: number[];        // parsed from TSV "zone" (CSV/range)
  boss: boolean;          // true if this is the boss for that zone
  element?: string;
  hp?: number;
  atk?: number;
  def?: number;
  spd?: number;
  acc?: number;
  eva?: number;
  moves?: string;         // raw TSV moves payload if you store it there
  drop_table_id?: string;
  [k: string]: any;
};

// -------- Drop Tables / Missions / Program Advances / Shops --------
// Keep these permissive unless you want strict typing now.
export type DropTable = {
  id: string;
  entries?: string;       // implementation-defined; keep flexible
  [k: string]: any;
};

export type Mission = {
  id: string;
  name?: string;
  description?: string;
  reward_zenny?: number;
  reward_chip_ids?: string; // CSV
  [k: string]: any;
};

export type ProgramAdvance = {
  id: string;
  name?: string;
  recipe?: string;        // CSV of chip ids/codes
  result_chip_id?: string;
  [k: string]: any;
};

export type Shop = {
  id: string;
  name?: string;
  region_id?: string;
  inventory_ids?: string; // CSV of chip ids
  [k: string]: any;
};

// -------- Bundle --------
export type DataBundle = {
  chips: Record<string, Chip>;
  viruses: Record<string, Virus>;
  regions: Record<string, Region>;
  dropTables: Record<string, DropTable>;
  missions: Record<string, Mission>;
  programAdvances: Record<string, ProgramAdvance>;
  shops: Record<string, Shop>;
};
