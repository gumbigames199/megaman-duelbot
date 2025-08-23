import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_DIR = './db';
const DB_PATH = path.join(DB_DIR, 'game.sqlite');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Upgrades ---
export function addHPMax(userId: string, delta: number) {
  db.prepare(`UPDATE players SET hp_max = MAX(1, hp_max + ?) WHERE user_id=?`).run(delta, userId);
}
export function addATK(userId: string, delta: number) {
  db.prepare(`UPDATE players SET atk = MAX(0, atk + ?) WHERE user_id=?`).run(delta, userId);
}

// Seen Viruses
db.exec(`CREATE TABLE IF NOT EXISTS seen_viruses (user_id TEXT, virus_id TEXT, PRIMARY KEY(user_id, virus_id));`);
const SeenPut = db.prepare(`INSERT OR IGNORE INTO seen_viruses (user_id, virus_id) VALUES (?,?)`);
const SeenList = db.prepare(`SELECT virus_id FROM seen_viruses WHERE user_id=? ORDER BY virus_id`);
export function markSeenVirus(userId: string, virusId: string) { SeenPut.run(userId, virusId); }
export function listSeenViruses(userId: string): string[] { return (SeenList.all(userId) as any[]).map(r=>r.virus_id); }

// --- Settings (per-user flags) ---
db.exec(`
CREATE TABLE IF NOT EXISTS player_settings (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);
`);

const Sget = db.prepare(`SELECT json FROM player_settings WHERE user_id=?`);
const Supsert = db.prepare(`
  INSERT INTO player_settings (user_id, json) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET json=excluded.json
`);

export function getSettings(userId: string): Record<string, any> {
  const row = Sget.get(userId) as { json?: string } | undefined;
  try { return row?.json ? JSON.parse(row.json) : {}; } catch { return {}; }
}
export function setSetting(userId: string, key: string, value: any) {
  const cur = getSettings(userId); (cur as any)[key] = value;
  Supsert.run(userId, JSON.stringify(cur));
}

/* Schema: players + inventory (+ folder slots for 30-chip folder) */
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  element TEXT NOT NULL DEFAULT 'Neutral',
  level INTEGER NOT NULL DEFAULT 1,
  exp   INTEGER NOT NULL DEFAULT 0,
  hp_max INTEGER NOT NULL DEFAULT 200,
  atk INTEGER NOT NULL DEFAULT 10,
  def INTEGER NOT NULL DEFAULT 6,
  spd INTEGER NOT NULL DEFAULT 8,
  acc INTEGER NOT NULL DEFAULT 90,
  evasion INTEGER NOT NULL DEFAULT 10,
  zenny INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  chip_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chip_id)
);
CREATE TABLE IF NOT EXISTS folder (
  user_id TEXT NOT NULL,
  slot INTEGER NOT NULL,       -- 0..29
  chip_id TEXT NOT NULL,
  PRIMARY KEY (user_id, slot)
);
`);

const selPlayer   = db.prepare(`SELECT * FROM players WHERE user_id=?`);
const insPlayer   = db.prepare(`
  INSERT INTO players (user_id,name,element,created_at) VALUES (?,?,?,?)
  ON CONFLICT(user_id) DO NOTHING
`);
const updPlayerNE = db.prepare(`UPDATE players SET name=?, element=? WHERE user_id=?`);
const updZenny    = db.prepare(`UPDATE players SET zenny=zenny+? WHERE user_id=?`);

const getInv = db.prepare(`SELECT chip_id, qty FROM inventory WHERE user_id=? AND qty>0 ORDER BY chip_id`);
const setInv = db.prepare(`
  INSERT INTO inventory (user_id,chip_id,qty) VALUES (?,?,?)
  ON CONFLICT(user_id,chip_id) DO UPDATE SET qty=excluded.qty
`);

export function ensurePlayer(userId: string, name: string, element: string) {
  if (!selPlayer.get(userId)) insPlayer.run(userId, name, element, Date.now());
  return selPlayer.get(userId);
}
export function setNameAndElement(userId: string, name: string, element: string) {
  updPlayerNE.run(name, element, userId);
}
export function getPlayer(userId: string) { return selPlayer.get(userId); }
export function addZenny(userId: string, delta: number) { updZenny.run(delta, userId); }
export function listInventory(userId: string) { return getInv.all(userId) as Array<{chip_id:string, qty:number}>; }

export function grantChip(userId: string, chipId: string, qty=1) {
  const cur = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_id=?`).get(userId, chipId)?.qty ?? 0;
  setInv.run(userId, chipId, Math.max(0, cur + qty));
}
