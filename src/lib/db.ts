// lib/db.ts
// SQLite data layer (better-sqlite3) with safe migrations.
// Adds: XP/Level, stat caps, atomic spendZenny, instant upgrade support,
// name/element fields, and compatibility aliases (db, getInventory, etc).

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// -------------------------------
// Environment & Caps
// -------------------------------

const DATA_DIR = path.resolve(process.cwd(), "db");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "game.sqlite");

const MAX_HP_CAP = toInt(process.env.MAX_HP_CAP, 500);
const MAX_ATK_CAP = toInt(process.env.MAX_ATK_CAP, 99);
const MAX_DEF_CAP = toInt(process.env.MAX_DEF_CAP, 99);
const MAX_SPD_CAP = toInt(process.env.MAX_SPD_CAP, 50);
const MAX_ACC_CAP = toInt(process.env.MAX_ACC_CAP, 150);
const MAX_EVA_CAP = toInt(process.env.MAX_EVA_CAP, 50);
const MAX_CRIT_CAP = toInt(process.env.MAX_CRIT_CAP, 25);

const STARTER_ZENNY = toInt(process.env.STARTER_ZENNY, 0);

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
  UNIQUE(user_id, mission_id)
);
`);

// Safe migrations
safeAddColumn("players", "xp_total", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("players", "level", "INTEGER NOT NULL DEFAULT 1");
safeAddColumn("players", "crit", "INTEGER NOT NULL DEFAULT 0");
safeAddColumn("players", "name", "TEXT DEFAULT NULL");
safeAddColumn("players", "element", "TEXT DEFAULT NULL");

// Indexes
db.exec(`
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory (user_id);
CREATE INDEX IF NOT EXISTS idx_folder_user ON folder (user_id);
CREATE INDEX IF NOT EXISTS idx_seen_user ON seen_viruses (user_id);
CREATE INDEX IF NOT EXISTS idx_settings_user ON player_settings (user_id);
CREATE INDEX IF NOT EXISTS idx_missions_user ON missions_state (user_id);
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
  xp_total: number;
  level: number;
};

export function ensurePlayer(user_id: string): Player {
  const existing = getPlayer(user_id);
  if (existing) return existing;
  db.prepare(`INSERT INTO players (user_id, zenny) VALUES (?, ?)`)
    .run(user_id, STARTER_ZENNY);
  return getPlayer(user_id)!;
}

export function getPlayer(user_id: string): Player | null {
  const row = db.prepare(`
    SELECT user_id, name, element, hp_max, atk, def, spd, acc, evasion, crit, zenny, region_id, xp_total, level
    FROM players WHERE user_id = ?`).get(user_id);
  return (row as Player) || null;
}

export function setRegion(user_id: string, region_id: string | null) {
  db.prepare(`UPDATE players SET region_id = ? WHERE user_id = ?`).run(region_id, user_id);
}
export function getRegion(user_id: string): string | null {
  const row = db.prepare(`SELECT region_id FROM players WHERE user_id = ?`).get(user_id) as any;
  return row?.region_id ?? null;
}

// Added for /start flow
export function setNameAndElement(user_id: string, name: string | null, element: string | null) {
  ensurePlayer(user_id);
  db.prepare(`UPDATE players SET name = ?, element = ? WHERE user_id = ?`)
    .run(name, element, user_id);
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
  return { xp_total: p.xp_total, level: p.level, next_threshold: xpThresholdForLevel(p.level + 1) };
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
export function addCRIT(u: string, n: number)  { applyStatDeltas(u, { crit: n }); }

// Inventory & folder
export type InventoryItem = { chip_id: string; qty: number };
export function grantChip(user_id: string, chip_id: string, qty = 1) {
  ensurePlayer(user_id);
  const row = db.prepare(`SELECT id, qty FROM inventory WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, chip_id) as { id: number; qty: number } | undefined;
  if (row) db.prepare(`UPDATE inventory SET qty = ? WHERE id = ?`).run(Math.max(0, row.qty + qty), row.id);
  else db.prepare(`INSERT INTO inventory (user_id, chip_id, qty) VALUES (?, ?, ?)`)
    .run(user_id, chip_id, Math.max(0, qty));
}
export function removeChip(user_id: string, chip_id: string, qty = 1): boolean {
  const row = db.prepare(`SELECT id, qty FROM inventory WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, chip_id) as { id: number; qty: number } | undefined;
  if (!row || row.qty < qty) return false;
  const newQty = row.qty - qty;
  if (newQty > 0) db.prepare(`UPDATE inventory SET qty = ? WHERE id = ?`).run(newQty, row.id);
  else db.prepare(`DELETE FROM inventory WHERE id = ?`).run(row.id);
  return true;
}
export function listInventory(user_id: string): InventoryItem[] {
  return db.prepare(`SELECT chip_id, qty FROM inventory WHERE user_id = ? ORDER BY chip_id`).all(user_id) as InventoryItem[];
}
export type FolderItem = { chip_id: string; qty: number };
export function addToFolder(user_id: string, chip_id: string, qty = 1) {
  ensurePlayer(user_id);
  const row = db.prepare(`SELECT id, qty FROM folder WHERE user_id = ? AND chip_id = ?`)
    .get(user_id, chip_id) as { id: number; qty: number } | undefined;
  if (row) db.prepare(`UPDATE folder SET qty = ? WHERE id = ?`).run(Math.max(0, row.qty + qty), row.id);
  else db.prepare(`INSERT INTO folder (user_id, chip_id, qty) VALUES (?, ?, ?)`).run(user_id, chip_id, Math.max(0, qty));
}
export function listFolder(user_id: string): FolderItem[] {
  return db.prepare(`SELECT chip_id, qty FROM folder WHERE user_id = ? ORDER BY chip_id`).all(user_id) as FolderItem[];
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

// Missions helpers (compat)
export type MissionState = "Available" | "Accepted" | "Completed" | "TurnedIn";
export function upsertMissionState(user_id: string, mission_id: string, state: MissionState, progress = 0) {
  ensurePlayer(user_id);
  db.prepare(`
    INSERT INTO missions_state (user_id, mission_id, state, progress)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, mission_id) DO UPDATE SET state = excluded.state, progress = excluded.progress
  `).run(user_id, mission_id, state, progress);
}
export function getMissionState(user_id: string, mission_id: string) {
  const row = db.prepare(`SELECT state, progress FROM missions_state WHERE user_id = ? AND mission_id = ?`)
    .get(user_id, mission_id) as { state: MissionState; progress: number } | undefined;
  return row ?? null;
}
export function addMissionProgress(user_id: string, mission_id: string, delta: number) {
  const cur = getMissionState(user_id, mission_id);
  const next = Math.max(0, (cur?.progress ?? 0) + Math.max(0, delta));
  upsertMissionState(user_id, mission_id, (cur?.state ?? "Accepted") as MissionState, next);
}

// -------------------------------
// Compatibility exports
// -------------------------------

export { db };                     // many files do: import { db } from '../lib/db'
export const getInventory = listInventory; // alias for older imports

export default db;
