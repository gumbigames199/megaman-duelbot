// src/lib/db.ts
// SQLite data layer (better-sqlite3) with safe migrations.
// Adds: XP/Level, stat caps, atomic spendZenny, instant upgrade support,
// name/element fields, and compatibility aliases (db, getInventory, etc).
// NEW: missions_state.counter column (compat) kept in sync with progress.
// QOL: Hard folder cap with status-returning tryAddToFolder; addToFolder honors cap.
// NEW: chip-id normalizer to migrate legacy numeric ids -> current TSV ids.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// NOTE: used only for chip-id normalization (no circular import back to db.ts)
import {
  bossFamilyMeta,
  getBundle,
  getChipById,
  getVirusById,
  listChips,
  resolveChipForGrant,
  resolveChipIdLoose,
  sellValueForChip,
} from "./data";

// -------------------------------
// Environment & Caps
// -------------------------------

const DATA_DIR = path.resolve(process.cwd(), "db");

function cleanSqlitePath(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  // Railway variables should be SQLITE_PATH=/data/game.sqlite.
  // This tolerates accidental values like =/data/game.sqlite.
  const withoutLeadingEquals = raw.replace(/^=+/, "").trim();
  if (!withoutLeadingEquals) return null;

  // Remove accidental wrapping quotes.
  return withoutLeadingEquals.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
}

const CONFIGURED_DB_PATH =
  cleanSqlitePath(process.env.SQLITE_PATH) ||
  cleanSqlitePath(process.env.SQLITE_Path) ||
  cleanSqlitePath(process.env.SQLITE_path) ||
  cleanSqlitePath(process.env.DATABASE_PATH);

const DB_PATH = CONFIGURED_DB_PATH
  ? path.resolve(CONFIGURED_DB_PATH)
  : path.join(DATA_DIR, "game.sqlite");

const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

console.log(`[db] SQLite path: ${DB_PATH}`);

const MAX_HP_CAP = toInt(process.env.MAX_HP_CAP, 500);
const MAX_ATK_CAP = toInt(process.env.MAX_ATK_CAP, 99);
const MAX_DEF_CAP = toInt(process.env.MAX_DEF_CAP, 99);
const MAX_SPD_CAP = toInt(process.env.MAX_SPD_CAP, 50);
const MAX_ACC_CAP = toInt(process.env.MAX_ACC_CAP, 150);
const MAX_EVA_CAP = toInt(process.env.MAX_EVA_CAP, 50);
const MAX_CRIT_CAP = toInt(process.env.MAX_CRIT_CAP, 25);

const STARTER_ZENNY = toInt(process.env.STARTER_ZENNY, 0);
export const STYLE_CHANGE_THRESHOLD = toInt(process.env.STYLE_CHANGE_THRESHOLD, 250);

// Folder limit (total slots = sum of qty in folder)
const FOLDER_CAP = toInt(process.env.MAX_FOLDER ?? process.env.FOLDER_CAP, 30);

// -------------------------------
// DB init
// -------------------------------

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT NULL,
  element TEXT DEFAULT NULL,
  hp_max INTEGER NOT NULL DEFAULT 100,
  atk INTEGER NOT NULL DEFAULT 0,
  def INTEGER NOT NULL DEFAULT 0,
  spd INTEGER NOT NULL DEFAULT 0,
  acc INTEGER NOT NULL DEFAULT 100,
  evasion INTEGER NOT NULL DEFAULT 0,
  crit INTEGER NOT NULL DEFAULT 0,
  zenny INTEGER NOT NULL DEFAULT 0,
  region_id TEXT DEFAULT NULL,
  region_zone INTEGER NOT NULL DEFAULT 1,
  xp_total INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chip_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS folder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chip_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS seen_viruses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  virus_id TEXT NOT NULL,
  UNIQUE (user_id, virus_id)
);

CREATE TABLE IF NOT EXISTS player_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS missions_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  state TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0, -- compat
  UNIQUE(user_id, mission_id)
);

CREATE TABLE IF NOT EXISTS style_progress (
  user_id TEXT PRIMARY KEY NOT NULL,
  fire_points INTEGER NOT NULL DEFAULT 0,
  aqua_points INTEGER NOT NULL DEFAULT 0,
  elec_points INTEGER NOT NULL DEFAULT 0,
  wood_points INTEGER NOT NULL DEFAULT 0,
  fire_prompted INTEGER NOT NULL DEFAULT 0,
  aqua_prompted INTEGER NOT NULL DEFAULT 0,
  elec_prompted INTEGER NOT NULL DEFAULT 0,
  wood_prompted INTEGER NOT NULL DEFAULT 0,
  pending_element TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS upgrade_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chip_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, chip_id)
);

CREATE TABLE IF NOT EXISTS defeated_boss_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  boss_family_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  boss_id TEXT NOT NULL,
  defeated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, boss_family_id, version)
);
`);

// Safe migrations
safeAddColumn("players", "xp_total", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("players", "level", "INTEGER NOT NULL DEFAULT 1");
safeAddColumn("players", "crit", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("players", "name", "TEXT DEFAULT NULL");
safeAddColumn("players", "element", "TEXT DEFAULT NULL");
safeAddColumn("players", "region_zone", "INTEGER NOT NULL DEFAULT 1");
safeAddColumn("missions_state", "progress", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("missions_state", "counter", "INTEGER NOT NULL DEFAULT 0"); // <-- compat column
safeAddColumn("style_progress", "fire_points", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "aqua_points", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "elec_points", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "wood_points", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "fire_prompted", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "aqua_prompted", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "elec_prompted", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "wood_prompted", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("style_progress", "pending_element", "TEXT DEFAULT NULL");

// Indexes
db.exec(`
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory (user_id);
CREATE INDEX IF NOT EXISTS idx_folder_user ON folder (user_id);
CREATE INDEX IF NOT EXISTS idx_seen_user ON seen_viruses (user_id);
CREATE INDEX IF NOT EXISTS idx_settings_user ON player_settings (user_id);
CREATE INDEX IF NOT EXISTS idx_missions_user ON missions_state (user_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_purchases_user ON upgrade_purchases (user_id);
CREATE INDEX IF NOT EXISTS idx_defeated_boss_versions_user_family ON defeated_boss_versions (user_id, boss_family_id);
`);

// -------------------------------
// Types & utils
// -------------------------------

function toInt(v: any, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
function safeAddColumn(table: string, col: string, decl: string) {
  try {
    const row = db.prepare(`PRAGMA table_info(${table});`).all()
      .find((r: any) => r.name === col);
    if (!row) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
  } catch {}
}
function xpThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  const n = level - 1;
  return Math.round(100 * n * Math.pow(1.25, Math.max(0, n - 1)));
}

// -------------------------------
// Public API
// -------------------------------

export type Player = {
  user_id: string;
  name: string | null;
  element: string | null;
  hp_max: number;
  atk: number;
  def: number;
  spd: number;
  acc: number;
  evasion: number;
  crit: number;
  zenny: number;
  region_id: string | null;
  region_zone: number;
  xp_total: number;
  level: number;
};

export function ensurePlayer(user_id: string): Player {
  const existing = getPlayer(user_id);
  if (existing) return existing;
  db.prepare(`INSERT INTO players (user_id, zenny, region_zone) VALUES (?, ?, 1)`)
    .run(user_id, STARTER_ZENNY);
  return getPlayer(user_id)!;
}

export function getPlayer(user_id: string): Player | null {
  const row = db.prepare(`
    SELECT user_id, name, element, hp_max, atk, def, spd, acc, evasion, crit, zenny, region_id, region_zone, xp_total, level
    FROM players WHERE user_id = ?`).get(user_id);
  return (row as Player) || null;
}

export function setRegion(user_id: string, region_id: string | null) {
  ensurePlayer(user_id);
  // also reset zone to 1 on region change
  db.prepare(`UPDATE players SET region_id = ?, region_zone = 1 WHERE user_id = ?`).run(region_id, user_id);
}

// NOTE: signature matches usage in index.ts (expects {region_id, region_zone})
export function getRegion(user_id: string): { region_id?: string | null; region_zone?: number } | undefined {
  const row = db.prepare(`SELECT region_id, region_zone FROM players WHERE user_id = ?`).get(user_id) as any;
  if (!row) return undefined;
  return { region_id: row.region_id ?? null, region_zone: toInt(row.region_zone ?? 1, 1) };
}

// Zone helpers required by jack_in.ts
export function setZone(user_id: string, zone: number) {
  ensurePlayer(user_id);
  const z = Math.max(1, toInt(zone, 1));
  db.prepare(`UPDATE players SET region_zone = ? WHERE user_id = ?`).run(z, user_id);
}
export function getZone(user_id: string): number {
  const row = db.prepare(`SELECT region_zone FROM players WHERE user_id = ?`).get(user_id) as any;
  return toInt(row?.region_zone ?? 1, 1);
}

// Added for /start flow
export function setNameAndElement(user_id: string, name: string | null, element: string | null) {
  ensurePlayer(user_id);
  db.prepare(`UPDATE players SET name = ?, element = ? WHERE user_id = ?`)
    .run(name, element, user_id);
}

export type StyleElement = "Fire" | "Aqua" | "Elec" | "Wood";
export const STYLE_ELEMENTS: StyleElement[] = ["Fire", "Aqua", "Elec", "Wood"];

export type StyleProgress = {
  user_id: string;
  fire_points: number;
  aqua_points: number;
  elec_points: number;
  wood_points: number;
  fire_prompted: number;
  aqua_prompted: number;
  elec_prompted: number;
  wood_prompted: number;
  pending_element: StyleElement | null;
  threshold: number;
};

export function normalizeStyleElement(value: any): StyleElement | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "fire") return "Fire";
  if (s === "aqua" || s === "water") return "Aqua";
  if (s === "elec" || s === "electric" || s === "electricity") return "Elec";
  if (s === "wood" || s === "grass") return "Wood";
  return null;
}

function stylePointColumn(element: StyleElement): "fire_points" | "aqua_points" | "elec_points" | "wood_points" {
  return `${element.toLowerCase()}_points` as any;
}

function stylePromptColumn(element: StyleElement): "fire_prompted" | "aqua_prompted" | "elec_prompted" | "wood_prompted" {
  return `${element.toLowerCase()}_prompted` as any;
}

export function ensureStyleProgress(user_id: string): StyleProgress {
  ensurePlayer(user_id);
  db.prepare(`
    INSERT OR IGNORE INTO style_progress (user_id)
    VALUES (?)
  `).run(user_id);
  return getStyleProgress(user_id);
}

export function getStyleProgress(user_id: string): StyleProgress {
  ensurePlayer(user_id);
  db.prepare(`INSERT OR IGNORE INTO style_progress (user_id) VALUES (?)`).run(user_id);
  const row = db.prepare(`
    SELECT user_id, fire_points, aqua_points, elec_points, wood_points,
           fire_prompted, aqua_prompted, elec_prompted, wood_prompted, pending_element
    FROM style_progress
    WHERE user_id = ?
  `).get(user_id) as any;

  return {
    user_id,
    fire_points: toInt(row?.fire_points, 0),
    aqua_points: toInt(row?.aqua_points, 0),
    elec_points: toInt(row?.elec_points, 0),
    wood_points: toInt(row?.wood_points, 0),
    fire_prompted: toInt(row?.fire_prompted, 0),
    aqua_prompted: toInt(row?.aqua_prompted, 0),
    elec_prompted: toInt(row?.elec_prompted, 0),
    wood_prompted: toInt(row?.wood_prompted, 0),
    pending_element: normalizeStyleElement(row?.pending_element),
    threshold: STYLE_CHANGE_THRESHOLD,
  };
}

export function addStyleProgress(user_id: string, elementRaw: any, amount = 1): StyleProgress {
  const element = normalizeStyleElement(elementRaw);
  if (!element || amount <= 0) return getStyleProgress(user_id);

  ensureStyleProgress(user_id);
  const pointCol = stylePointColumn(element);
  db.prepare(`UPDATE style_progress SET ${pointCol} = ${pointCol} + ? WHERE user_id = ?`)
    .run(Math.max(0, toInt(amount, 0)), user_id);

  const after = getStyleProgress(user_id);
  const currentStyle = normalizeStyleElement(getPlayer(user_id)?.element) || null;
  const promptCol = stylePromptColumn(element);
  const points = toInt((after as any)[pointCol], 0);
  const hasPrompted = toInt((after as any)[promptCol], 0) > 0;

  if (!after.pending_element && currentStyle !== element && !hasPrompted && points >= STYLE_CHANGE_THRESHOLD) {
    db.prepare(`UPDATE style_progress SET pending_element = ?, ${promptCol} = 1 WHERE user_id = ?`)
      .run(element, user_id);
    return getStyleProgress(user_id);
  }

  return after;
}

export function getPendingStyleElement(user_id: string): StyleElement | null {
  return getStyleProgress(user_id).pending_element;
}

export function acceptStyleChange(user_id: string, elementRaw: any): { ok: boolean; element?: StyleElement } {
  const element = normalizeStyleElement(elementRaw);
  if (!element) return { ok: false };
  ensureStyleProgress(user_id);
  db.prepare(`UPDATE players SET element = ? WHERE user_id = ?`).run(element, user_id);
  resetStyleProgressOnly(user_id);
  return { ok: true, element };
}

export function declineStyleChange(user_id: string, elementRaw?: any): { ok: boolean; element?: StyleElement | null } {
  ensureStyleProgress(user_id);
  const element = normalizeStyleElement(elementRaw) || getPendingStyleElement(user_id);
  db.prepare(`UPDATE style_progress SET pending_element = NULL WHERE user_id = ?`).run(user_id);
  return { ok: true, element };
}

export function resetStyleToNeutral(user_id: string): { previous: string } {
  ensurePlayer(user_id);
  const previous = String(getPlayer(user_id)?.element || "Neutral");
  db.prepare(`UPDATE players SET element = ? WHERE user_id = ?`).run("Neutral", user_id);
  resetStyleProgressOnly(user_id);
  return { previous };
}

function resetStyleProgressOnly(user_id: string) {
  ensureStyleProgress(user_id);
  db.prepare(`
    UPDATE style_progress
    SET fire_points = 0, aqua_points = 0, elec_points = 0, wood_points = 0,
        fire_prompted = 0, aqua_prompted = 0, elec_prompted = 0, wood_prompted = 0,
        pending_element = NULL
    WHERE user_id = ?
  `).run(user_id);
}

// Zenny
export function addZenny(user_id: string, amount: number) {
  ensurePlayer(user_id);
  db.prepare(`UPDATE players SET zenny = MAX(0, zenny + ?) WHERE user_id = ?`)
    .run(amount, user_id);
}
export function spendZenny(user_id: string, amount: number): { ok: boolean; balance?: number } {
  if (amount <= 0) return { ok: true, balance: getPlayer(user_id)?.zenny ?? 0 };
  const tx = db.transaction((uid: string, amt: number) => {
    const row = db.prepare(`SELECT zenny FROM players WHERE user_id = ?`).get(uid) as { zenny: number } | undefined;
    if (!row) throw new Error("Player not found");
    if (row.zenny < amt) return { ok: false, balance: row.zenny };
    db.prepare(`UPDATE players SET zenny = zenny - ? WHERE user_id = ?`).run(amt, uid);
    const after = db.prepare(`SELECT zenny FROM players WHERE user_id = ?`).get(uid) as { zenny: number };
    return { ok: true, balance: after.zenny };
  });
  try { return tx(user_id, amount); } catch { return { ok: false }; }
}

// XP & Level
export function addXP(user_id: string, amount: number) {
  ensurePlayer(user_id);
  const tx = db.transaction((uid: string, delta: number) => {
    const p = db.prepare(`SELECT xp_total, level FROM players WHERE user_id = ?`).get(uid) as { xp_total: number; level: number };
    let xp = Math.max(0, toInt(p.xp_total) + Math.max(0, delta));
    let level = Math.max(1, toInt(p.level));
    while (xp >= xpThresholdForLevel(level + 1)) level += 1;
    db.prepare(`UPDATE players SET xp_total = ?, level = ? WHERE user_id = ?`).run(xp, level, uid);
    return { xp_total: xp, level, next_threshold: xpThresholdForLevel(level + 1) };
  });
  try { return tx(user_id, amount); } catch { const p = getPlayer(user_id)!; return { xp_total: p?.xp_total ?? 0, level: p?.level ?? 1, next_threshold: xpThresholdForLevel((p?.level ?? 1) + 1) }; }
}
export function getXPProgress(user_id: string) {
  const p = ensurePlayer(user_id);
  const level = Math.max(1, toInt(p.level, 1));
  const xpTotal = Math.max(0, toInt(p.xp_total, 0));
  const currentThreshold = xpThresholdForLevel(level);
  const nextThreshold = xpThresholdForLevel(level + 1);
  const neededThisLevel = Math.max(1, nextThreshold - currentThreshold);
  const intoLevel = clamp(xpTotal - currentThreshold, 0, neededThisLevel);
  return {
    xp_total: xpTotal,
    level,
    current_threshold: currentThreshold,
    next_threshold: nextThreshold,
    xp_into_level: intoLevel,
    xp_needed_for_next: neededThisLevel,
  };
}

export function getUpgradePurchaseCount(user_id: string, chip_id: string): number {
  ensurePlayer(user_id);
  const safeId = normalizeChipIdLocal(String(chip_id));
  const row = db.prepare(`SELECT qty FROM upgrade_purchases WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, safeId) as { qty: number } | undefined;
  return Math.max(0, toInt(row?.qty ?? 0, 0));
}

export function getScaledUpgradePrice(user_id: string, chip_id: string, basePrice: number): number {
  const base = Math.max(0, toInt(basePrice, 0));
  if (base <= 0) return 0;
  const count = getUpgradePurchaseCount(user_id, chip_id);
  const multiplier = Math.pow(2, Math.max(0, count));
  const scaled = base * multiplier;
  return Number.isFinite(scaled) ? Math.trunc(scaled) : base;
}

export function recordUpgradePurchase(user_id: string, chip_id: string, qty = 1): number {
  ensurePlayer(user_id);
  const safeId = normalizeChipIdLocal(String(chip_id));
  const addQty = Math.max(1, toInt(qty, 1));
  db.prepare(`
    INSERT INTO upgrade_purchases (user_id, chip_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(user_id, chip_id) DO UPDATE SET qty = qty + excluded.qty
  `).run(user_id, safeId, addQty);
  return getUpgradePurchaseCount(user_id, safeId);
}

// Stats
type StatDelta = Partial<Pick<Player, "hp_max" | "atk" | "def" | "spd" | "acc" | "evasion" | "crit">>;
export function applyStatDeltas(user_id: string, delta: StatDelta) {
  ensurePlayer(user_id);
  const p = getPlayer(user_id)!;
  const hp_max = clamp((p.hp_max + (delta.hp_max ?? 0)), 1, MAX_HP_CAP);
  const atk    = clamp((p.atk    + (delta.atk    ?? 0)), 0, MAX_ATK_CAP);
  const def    = clamp((p.def    + (delta.def    ?? 0)), 0, MAX_DEF_CAP);
  const spd    = clamp((p.spd    + (delta.spd    ?? 0)), 0, MAX_SPD_CAP);
  const acc    = clamp((p.acc    + (delta.acc    ?? 0)), 0, MAX_ACC_CAP);
  const ev     = clamp((p.evasion+ (delta.evasion?? 0)), 0, MAX_EVA_CAP);
  const crit   = clamp((p.crit   + (delta.crit   ?? 0)), 0, MAX_CRIT_CAP);
  db.prepare(`UPDATE players SET hp_max=?, atk=?, def=?, spd=?, acc=?, evasion=?, crit=? WHERE user_id=?`)
    .run(hp_max, atk, def, spd, acc, ev, crit, user_id);
}
export function addHPMax(u: string, n: number) { applyStatDeltas(u, { hp_max: n }); }
export function addATK(u: string, n: number)   { applyStatDeltas(u, { atk: n }); }
export function addDEF(u: string, n: number)   { applyStatDeltas(u, { def: n }); }
export function addSPD(u: string, n: number)   { applyStatDeltas(u, { spd: n }); }
export function addACC(u: string, n: number)   { applyStatDeltas(u, { acc: n }); }
export function addEVA(u: string, n: number)   { applyStatDeltas(u, { evasion: n }); }
// alias required by jack_in.ts
export function addEvasion(u: string, n: number) { return addEVA(u, n); }
export function addCRIT(u: string, n: number)  { applyStatDeltas(u, { crit: n }); }

// Inventory & folder
export type InventoryItem = { chip_id: string; qty: number };

// --- chip-id normalization helpers -------------------------------

/**
 * Best-effort normalizer for legacy chip ids.
 * - If id already resolves via getChipById -> return as-is.
 * - If id is an integer string and within the array bounds of listChips(),
 *   treat it as a row index and return the corresponding chip.id.
 * - If id matches a chip name (case-insensitive), return that chip.id.
 * Otherwise return original string.
 */
function normalizeChipIdLocal(id: string): string {
  const raw = String(id ?? "").trim();
  if (!raw) return raw;

  // exact variant id or upgrade id
  if (getChipById(raw)) return raw;

  // base chip/name -> random exact variant for grants, starters, drops, and shop buys
  const grantId = resolveChipForGrant(raw);
  if (grantId && getChipById(grantId)) return grantId;

  // numeric index -> chips[row].id, kept for old local testing data
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw);
    const chips = listChips() as any[];
    if (Array.isArray(chips) && idx >= 0 && idx < chips.length) {
      const mapped = String(chips[idx]?.id ?? "");
      if (mapped && getChipById(mapped)) return mapped;
    }
  }

  const loose = resolveChipIdLoose(raw);
  if (loose && getChipById(loose)) return loose;

  return raw;
}

/** Normalize a single row in-place; returns true if updated. */
function normalizeInventoryRow(rowId: number, badId: string): boolean {
  const fixed = normalizeChipIdLocal(badId);
  if (fixed && fixed !== badId) {
    db.prepare(`UPDATE inventory SET chip_id = ? WHERE id = ?`).run(fixed, rowId);
    return true;
  }
  return false;
}
function normalizeFolderRow(rowId: number, badId: string): boolean {
  const fixed = normalizeChipIdLocal(badId);
  if (fixed && fixed !== badId) {
    db.prepare(`UPDATE folder SET chip_id = ? WHERE id = ?`).run(fixed, rowId);
    return true;
  }
  return false;
}

/**
 * Public: normalize all inventory/folder chip_ids to current TSV ids.
 * Call this right after /reload_data completes.
 */
export function normalizeChipIds(): { fixedInventory: number; fixedFolder: number } {
  let fixedInv = 0, fixedFold = 0;

  const invRows = db.prepare(`SELECT id, chip_id FROM inventory`).all() as { id: number; chip_id: string }[];
  for (const r of invRows) if (normalizeInventoryRow(r.id, String(r.chip_id))) fixedInv++;

  const foldRows = db.prepare(`SELECT id, chip_id FROM folder`).all() as { id: number; chip_id: string }[];
  for (const r of foldRows) if (normalizeFolderRow(r.id, String(r.chip_id))) fixedFold++;

  return { fixedInventory: fixedInv, fixedFolder: fixedFold };
}

// ------------------------------------------------------------------

export function grantChip(user_id: string, chip_id: string, qty = 1) {
  ensurePlayer(user_id);
  const safeId = normalizeChipIdLocal(String(chip_id)); // keep new inserts normalized
  const row = db.prepare(`SELECT id, qty FROM inventory WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, safeId) as { id: number; qty: number } | undefined;
  if (row) db.prepare(`UPDATE inventory SET qty = ? WHERE id = ?`).run(Math.max(0, row.qty + qty), row.id);
  else db.prepare(`INSERT INTO inventory (user_id, chip_id, qty) VALUES (?, ?, ?)`)
    .run(user_id, safeId, Math.max(0, qty));
}
export function removeChip(user_id: string, chip_id: string, qty = 1): boolean {
  const safeId = normalizeChipIdLocal(String(chip_id));
  const row = db.prepare(`SELECT id, qty FROM inventory WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, safeId) as { id: number; qty: number } | undefined;
  if (!row || row.qty < qty) return false;
  const newQty = row.qty - qty;
  if (newQty > 0) db.prepare(`UPDATE inventory SET qty = ? WHERE id = ?`).run(newQty, row.id);
  else db.prepare(`DELETE FROM inventory WHERE id = ?`).run(row.id);
  return true;
}
export function sellChip(user_id: string, chip_id: string, qty = 1): { ok: boolean; zenny: number; qty: number; reason?: string } {
  ensurePlayer(user_id);
  const safeId = normalizeChipIdLocal(String(chip_id));
  const amount = Math.max(1, toInt(qty, 1));
  const chip = getChipById(safeId);
  if (!chip) return { ok: false, zenny: 0, qty: 0, reason: "Unknown chip." };

  const row = db.prepare(`SELECT id, qty FROM inventory WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, safeId) as { id: number; qty: number } | undefined;
  if (!row || row.qty < amount) return { ok: false, zenny: 0, qty: 0, reason: "Not enough copies." };

  const newQty = row.qty - amount;
  if (newQty > 0) db.prepare(`UPDATE inventory SET qty = ? WHERE id = ?`).run(newQty, row.id);
  else db.prepare(`DELETE FROM inventory WHERE id = ?`).run(row.id);

  const gained = sellValueForChip(chip) * amount;
  if (gained > 0) addZenny(user_id, gained);
  return { ok: true, zenny: gained, qty: amount };
}

export function listInventory(user_id: string): InventoryItem[] {
  return db.prepare(`SELECT chip_id, qty FROM inventory WHERE user_id = ? ORDER BY chip_id`).all(user_id) as InventoryItem[];
}

// ---- Folder helpers with CAP enforcement ----
export type FolderItem = { chip_id: string; qty: number };

/** Total used slots (sum of qty across all folder rows). */
export function getFolderCount(user_id: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(qty), 0) AS n FROM folder WHERE user_id = ?`).get(user_id) as any;
  return toInt(row?.n ?? 0, 0);
}

/** Remaining slots before hitting FOLDER_CAP. */
export function getFolderRemaining(user_id: string): number {
  return Math.max(0, FOLDER_CAP - getFolderCount(user_id));
}

/** Status-returning add respecting the folder cap. */
export function tryAddToFolder(
  user_id: string,
  chip_id: string,
  qty = 1
): { ok: boolean; added: number; remaining: number; cap: number; reason?: string } {
  ensurePlayer(user_id);
  const want = Math.max(0, toInt(qty, 0));
  if (want <= 0) return { ok: true, added: 0, remaining: getFolderRemaining(user_id), cap: FOLDER_CAP };

  const remaining = getFolderRemaining(user_id);
  if (remaining <= 0) {
    return { ok: false, added: 0, remaining: 0, cap: FOLDER_CAP, reason: `Folder is full (${FOLDER_CAP}/${FOLDER_CAP}).` };
  }

  const addNow = Math.min(remaining, want);
  const safeId = normalizeChipIdLocal(String(chip_id));

  const row = db.prepare(`SELECT id, qty FROM folder WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, safeId) as { id: number; qty: number } | undefined;

  if (row) {
    db.prepare(`UPDATE folder SET qty = ? WHERE id = ?`).run(Math.max(0, row.qty + addNow), row.id);
  } else {
    db.prepare(`INSERT INTO folder (user_id, chip_id, qty) VALUES (?, ?, ?)`).run(user_id, safeId, addNow);
  }

  const remAfter = getFolderRemaining(user_id);
  return {
    ok: addNow > 0,
    added: addNow,
    remaining: remAfter,
    cap: FOLDER_CAP,
    ...(addNow < want ? { reason: `Only ${addNow} could be added; folder cap ${FOLDER_CAP} reached.` } : {})
  };
}

/**
 * Back-compat wrapper: adds up to remaining capacity; silently ignores overflow.
 * Prefer calling tryAddToFolder from new code so you can show a user-facing message.
 */
export function addToFolder(user_id: string, chip_id: string, qty = 1) {
  tryAddToFolder(user_id, chip_id, qty);
}

export function listFolder(user_id: string): FolderItem[] {
  return db.prepare(`SELECT chip_id, qty FROM folder WHERE user_id = ? ORDER BY chip_id`).all(user_id) as FolderItem[];
}


// Boss version progression
export type BossDefeatRecord = {
  boss_family_id: string;
  version: number;
  boss_id: string;
  defeated_at?: string;
};

export function listDefeatedBossVersions(user_id: string, boss_family_id: string): number[] {
  ensurePlayer(user_id);
  const rows = db.prepare(`
    SELECT version FROM defeated_boss_versions
    WHERE user_id = ? AND boss_family_id = ?
    ORDER BY version ASC
  `).all(user_id, boss_family_id) as { version: number }[];
  return rows.map(r => toInt(r.version, 0)).filter(n => n > 0);
}

export function hasDefeatedBossVersion(user_id: string, boss_family_id: string, version: number): boolean {
  ensurePlayer(user_id);
  const row = db.prepare(`
    SELECT 1 AS ok FROM defeated_boss_versions
    WHERE user_id = ? AND boss_family_id = ? AND version = ?
    LIMIT 1
  `).get(user_id, boss_family_id, Math.max(1, toInt(version, 1))) as { ok: number } | undefined;
  return !!row;
}

function maxKnownBossVersion(familyId: string): number {
  const bundle = getBundle() as any;
  let max = 0;
  for (const v of Object.values(bundle.viruses || {}) as any[]) {
    if (!v?.is_boss && !v?.boss) continue;
    const meta = bossFamilyMeta(v);
    if (String(meta.family_id) === String(familyId)) max = Math.max(max, meta.version);
  }
  return max || 1;
}

export function recordBossDefeat(user_id: string, boss_id: string): {
  ok: boolean;
  family_id?: string;
  version?: number;
  inserted?: boolean;
  next_unlocked?: number | null;
} {
  ensurePlayer(user_id);
  const boss = getVirusById(boss_id) as any;
  if (!boss || !(boss.is_boss || boss.boss)) return { ok: false };

  const meta = bossFamilyMeta(boss);
  if (!meta.family_id || meta.version < 1) return { ok: false };

  const before = hasDefeatedBossVersion(user_id, meta.family_id, meta.version);
  db.prepare(`
    INSERT OR IGNORE INTO defeated_boss_versions (user_id, boss_family_id, version, boss_id)
    VALUES (?, ?, ?, ?)
  `).run(user_id, meta.family_id, meta.version, boss_id);

  const inserted = !before;
  const maxVersion = maxKnownBossVersion(meta.family_id);
  const nextVersion = inserted && meta.version < maxVersion ? meta.version + 1 : null;

  return {
    ok: true,
    family_id: meta.family_id,
    version: meta.version,
    inserted,
    next_unlocked: nextVersion,
  };
}

// Seen viruses
export function markSeenVirus(user_id: string, virus_id: string) {
  ensurePlayer(user_id);
  try { db.prepare(`INSERT OR IGNORE INTO seen_viruses (user_id, virus_id) VALUES (?, ?)`).run(user_id, virus_id); } catch {}
}
export function listSeenViruses(user_id: string): string[] {
  const rows = db.prepare(`SELECT virus_id FROM seen_viruses WHERE user_id = ? ORDER BY virus_id`).all(user_id) as { virus_id: string }[];
  return rows.map(r => r.virus_id);
}

// Settings (kv)
export type PlayerSettings = Record<string, string>;
export function getSettings(user_id: string): PlayerSettings {
  const rows = db.prepare(`SELECT key, value FROM player_settings WHERE user_id = ?`).all(user_id) as { key: string; value: string }[];
  const out: PlayerSettings = {}; for (const r of rows) out[r.key] = r.value; return out;
}
export function setSetting(user_id: string, key: string, value: string) {
  ensurePlayer(user_id);
  db.prepare(`
    INSERT INTO player_settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(user_id, key, value);
}

// Missions helpers (compat with both progress & counter)
export type MissionState = "Available" | "Accepted" | "Completed" | "TurnedIn";

export function upsertMissionState(user_id: string, mission_id: string, state: MissionState, progress = 0) {
  ensurePlayer(user_id);
  db.prepare(`
    INSERT INTO missions_state (user_id, mission_id, state, progress, counter)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mission_id)
    DO UPDATE SET state = excluded.state, progress = excluded.progress, counter = excluded.counter
  `).run(user_id, mission_id, state, progress, progress);
}

export function getMissionState(user_id: string, mission_id: string) {
  const row = db.prepare(`
    SELECT state, COALESCE(progress, counter, 0) AS progress
    FROM missions_state WHERE user_id = ? AND mission_id = ?
  `).get(user_id, mission_id) as { state: MissionState; progress: number } | undefined;
  return row ?? null;
}

export function addMissionProgress(user_id: string, mission_id: string, delta: number) {
  const cur = getMissionState(user_id, mission_id);
  const next = Math.max(0, (cur?.progress ?? 0) + Math.max(0, delta));
  db.prepare(`
    INSERT INTO missions_state (user_id, mission_id, state, progress, counter)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mission_id)
    DO UPDATE SET progress = excluded.progress, counter = excluded.counter
  `).run(user_id, mission_id, (cur?.state ?? "Accepted") as MissionState, next, next);
}

// -------------------------------
// Compatibility exports
// -------------------------------

export { db };                             // many files do: import { db } from '../lib/db'
export const getInventory = listInventory; // alias for older imports

export default db;
