// src/lib/db.ts
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PlayerRow } from './types';

const DB_DIR = './db';
const DB_PATH = path.join(DB_DIR, 'game.sqlite');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ---------- ENV caps & starters ---------- */
const CAP = {
  HP:  Number(process.env.MAX_HP_CAP  ?? 600),
  ATK: Number(process.env.MAX_ATK_CAP ?? 75),
  DEF: Number(process.env.MAX_DEF_CAP ?? 50),
  SPD: Number(process.env.MAX_SPD_CAP ?? 20),
  ACC: Number(process.env.MAX_ACC_CAP ?? 100),
  EVA: Number(process.env.MAX_EVA_CAP ?? 50),
} as const;

const START = {
  HP:  Number(process.env.START_HP  ?? 200),
  ATK: Number(process.env.START_ATK ?? 10),
  DEF: Number(process.env.START_DEF ?? 6),
  SPD: Number(process.env.START_SPD ?? 8),
  ACC: Number(process.env.START_ACC ?? 90),
  EVA: Number(process.env.START_EVA ?? 10),
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/* ---------- LEVELING (NEW) ---------- */
const LVL_MAX = Number(process.env.LEVEL_MAX || 40);

// XP needed to go from level L -> L+1
function levelThreshold(lvl: number) {
  // 1→2 needs 1000, 2→3 needs 2000, … (lvl * 1000)
  return Math.max(0, lvl * 1000);
}

/* ---------- Schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  user_id   TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  element   TEXT NOT NULL DEFAULT 'Neutral',
  level     INTEGER NOT NULL DEFAULT 1,
  exp       INTEGER NOT NULL DEFAULT 0,
  hp_max    INTEGER NOT NULL DEFAULT 200,
  atk       INTEGER NOT NULL DEFAULT 10,
  def       INTEGER NOT NULL DEFAULT 6,
  spd       INTEGER NOT NULL DEFAULT 8,
  acc       INTEGER NOT NULL DEFAULT 90,
  evasion   INTEGER NOT NULL DEFAULT 10,
  zenny     INTEGER NOT NULL DEFAULT 0,
  region_id TEXT,
  region_zone INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  chip_id TEXT NOT NULL,
  qty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chip_id)
);

CREATE TABLE IF NOT EXISTS folder (
  user_id TEXT NOT NULL,
  slot    INTEGER NOT NULL,     -- 0..29
  chip_id TEXT NOT NULL,
  PRIMARY KEY (user_id, slot)
);

CREATE TABLE IF NOT EXISTS seen_viruses (
  user_id  TEXT NOT NULL,
  virus_id TEXT NOT NULL,
  PRIMARY KEY (user_id, virus_id)
);

CREATE TABLE IF NOT EXISTS player_settings (
  user_id TEXT PRIMARY KEY,
  json    TEXT NOT NULL DEFAULT '{}'
);
`);

// Ensure region_zone exists for legacy DBs
try {
  db.exec(`ALTER TABLE players ADD COLUMN region_zone INTEGER NOT NULL DEFAULT 1;`);
} catch {}

/* ---------- Statements ---------- */
const selPlayer   = db.prepare(`SELECT * FROM players WHERE user_id=?`);
const insPlayer   = db.prepare(`
  INSERT INTO players (user_id, name, element, level, exp, hp_max, atk, def, spd, acc, evasion, zenny, region_id, region_zone, created_at)
  VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?)
  ON CONFLICT(user_id) DO NOTHING
`);
const updPlayerNE = db.prepare(`UPDATE players SET name=?, element=? WHERE user_id=?`);
const updZenny    = db.prepare(`UPDATE players SET zenny = zenny + ? WHERE user_id=?`);
const updRegion   = db.prepare(`UPDATE players SET region_id = ? WHERE user_id=?`);
const updZone     = db.prepare(`UPDATE players SET region_zone=? WHERE user_id=?`);
const selRegion   = db.prepare(`SELECT region_id, region_zone FROM players WHERE user_id=?`);
const selZone     = db.prepare(`SELECT region_zone FROM players WHERE user_id=?`);

const getInv = db.prepare(`SELECT chip_id, qty FROM inventory WHERE user_id=? AND qty>0 ORDER BY chip_id`);
const setInv = db.prepare(`
  INSERT INTO inventory (user_id, chip_id, qty) VALUES (?, ?, ?)
  ON CONFLICT(user_id, chip_id) DO UPDATE SET qty=excluded.qty
`);

const SeenPut  = db.prepare(`INSERT OR IGNORE INTO seen_viruses (user_id, virus_id) VALUES (?, ?)`);
const SeenList = db.prepare(`SELECT virus_id FROM seen_viruses WHERE user_id=? ORDER BY virus_id`);

const Sget     = db.prepare(`SELECT json FROM player_settings WHERE user_id=?`);
const Supsert  = db.prepare(`
  INSERT INTO player_settings (user_id, json) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET json=excluded.json
`);

/* ---------- XP add (NEW IMPL) ---------- */
export function addXP(userId: string, delta: number): { level: number; exp: number; leveledUp: number } {
  const row = selPlayer.get(userId) as any;
  if (!row) return { level: 1, exp: 0, leveledUp: 0 };

  let level = Number(row.level || 1);
  let exp   = Math.max(0, Number(row.exp || 0) + Math.max(0, delta));
  let ups   = 0;

  // level up while we can (cap at LVL_MAX)
  while (level < LVL_MAX) {
    const need = levelThreshold(level);
    if (exp < need) break;
    exp -= need;
    level += 1;
    ups += 1;
  }

  db.prepare(`UPDATE players SET level=?, exp=? WHERE user_id=?`).run(level, exp, userId);
  return { level, exp, leveledUp: ups };
}

/* ---------- Player helpers ---------- */
export function ensurePlayer(userId: string, name: string, element: string): PlayerRow | undefined {
  insPlayer.run(
    userId,
    name,
    element,
    clamp(START.HP, 1, CAP.HP),
    clamp(START.ATK, 0, CAP.ATK),
    clamp(START.DEF, 0, CAP.DEF),
    clamp(START.SPD, 0, CAP.SPD),
    clamp(START.ACC, 0, CAP.ACC),
    clamp(START.EVA, 0, CAP.EVA),
    Date.now()
  );
  enforceCaps(userId);
  return selPlayer.get(userId) as PlayerRow | undefined;
}
export function setNameAndElement(userId: string, name: string, element: string): void {
  updPlayerNE.run(name, element, userId);
}
export function getPlayer(userId: string): PlayerRow | undefined {
  return selPlayer.get(userId) as PlayerRow | undefined;
}
export function addZenny(userId: string, delta: number): void {
  updZenny.run(delta, userId);
}

/* ---------- Stat mutators (clamped) ---------- */
export function addHPMax(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.hp_max ?? 0) + delta, 1, CAP.HP);
  db.prepare(`UPDATE players SET hp_max=? WHERE user_id=?`).run(next, userId);
}
export function addATK(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.atk ?? 0) + delta, 0, CAP.ATK);
  db.prepare(`UPDATE players SET atk=? WHERE user_id=?`).run(next, userId);
}
export function addDEF(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.def ?? 0) + delta, 0, CAP.DEF);
  db.prepare(`UPDATE players SET def=? WHERE user_id=?`).run(next, userId);
}
export function addSPD(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.spd ?? 0) + delta, 0, CAP.SPD);
  db.prepare(`UPDATE players SET spd=? WHERE user_id=?`).run(next, userId);
}
export function addACC(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.acc ?? 0) + delta, 0, CAP.ACC);
  db.prepare(`UPDATE players SET acc=? WHERE user_id=?`).run(next, userId);
}
export function addEvasion(userId: string, delta: number): void {
  const p = getPlayer(userId); if (!p) return;
  const next = clamp((p.evasion ?? 0) + delta, 0, CAP.EVA);
  db.prepare(`UPDATE players SET evasion=? WHERE user_id=?`).run(next, userId);
}

/* ---------- Region helpers ---------- */
export function getRegion(userId: string): { region_id?: string; region_zone?: number } | undefined {
  return selRegion.get(userId) as { region_id?: string; region_zone?: number } | undefined;
}
export function getZone(userId: string): number {
  return (selZone.get(userId) as any)?.region_zone ?? 1;
}
export function setZone(userId: string, zone: number) {
  updZone.run(Math.max(1, zone|0), userId);
}
export function setRegion(userId: string, regionId: string): void {
  updRegion.run(regionId, userId);
  setZone(userId, 1);
}

/* ---------- Inventory / Folder ---------- */
export function listInventory(userId: string): Array<{ chip_id: string; qty: number }> {
  return getInv.all(userId) as Array<{ chip_id: string; qty: number }>;
}
export function grantChip(userId: string, chipId: string, qty = 1) {
  const row = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_id=?`)
                .get(userId, chipId) as { qty?: number } | undefined;
  const cur = row?.qty ?? 0;
  setInv.run(userId, chipId, Math.max(0, cur + qty));
}

/* ---------- Virus dex ---------- */
export function markSeenVirus(userId: string, virusId: string): void { SeenPut.run(userId, virusId); }
export function listSeenViruses(userId: string): string[] {
  return (SeenList.all(userId) as Array<{ virus_id: string }>).map(r => r.virus_id);
}

/* ---------- Settings ---------- */
export function getSettings(userId: string): Record<string, unknown> {
  const row = Sget.get(userId) as { json?: string } | undefined;
  try { return row?.json ? JSON.parse(row.json) : {}; } catch { return {}; }
}
export function setSetting(userId: string, key: string, value: unknown): void {
  const cur = getSettings(userId) as Record<string, unknown>;
  cur[key] = value;
  Supsert.run(userId, JSON.stringify(cur));
}

/* ---------- Safety: enforce caps ---------- */
export function enforceCaps(userId: string) {
  const p = getPlayer(userId) as any; if (!p) return;
  const hp  = clamp(p.hp_max ?? 1, 1, CAP.HP);
  const atk = clamp(p.atk   ?? 0, 0, CAP.ATK);
  const def = clamp(p.def   ?? 0, 0, CAP.DEF);
  const spd = clamp(p.spd   ?? 0, 0, CAP.SPD);
  const acc = clamp(p.acc   ?? 0, 0, CAP.ACC);
  const eva = clamp(p.evasion ?? 0, 0, CAP.EVA);
  db.prepare(`UPDATE players SET hp_max=?, atk=?, def=?, spd=?, acc=?, evasion=? WHERE user_id=?`)
    .run(hp, atk, def, spd, acc, eva, userId);
}

/* Optional: clamp everyone (use once after changing caps) */
export function clampAllPlayers() {
  const ids = db.prepare(`SELECT user_id FROM players`).all() as Array<{user_id:string}>;
  const stmt = db.prepare(`UPDATE players SET hp_max=?, atk=?, def=?, spd=?, acc=?, evasion=? WHERE user_id=?`);
  for (const { user_id } of ids) {
    const p = selPlayer.get(user_id) as any;
    const hp  = clamp(p.hp_max ?? 1, 1, CAP.HP);
    const atk = clamp(p.atk   ?? 0, 0, CAP.ATK);
    const def = clamp(p.def   ?? 0, 0, CAP.DEF);
    const spd = clamp(p.spd   ?? 0, 0, CAP.SPD);
    const acc = clamp(p.acc   ?? 0, 0, CAP.ACC);
    const eva = clamp(p.evasion ?? 0, 0, CAP.EVA);
    stmt.run(hp, atk, def, spd, acc, eva, user_id);
  }
}
