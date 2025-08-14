// index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';

// Optional fetch polyfill for Node < 18 (no-op on >=18)
try {
  if (typeof fetch === 'undefined') {
    // eslint-disable-next-line no-undef
    await import('node-fetch').then(({ default: f }) => {
      // @ts-ignore
      global.fetch = f;
    });
  }
} catch { /* ignore */ }

// ---------- Config ----------
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '830126829352386601';

const MANUAL_UPGRADES_MODE = (process.env.MANUAL_UPGRADES_MODE || 'points').toLowerCase();
const POINTS_PER_WIN = parseInt(process.env.POINTS_PER_WIN || '1', 10);

// Per-chip cap per battle & round timing
const MAX_PER_CHIP = 4;
const ROUND_SECONDS = Math.max(15, parseInt(process.env.ROUND_SECONDS || '60', 10)); // floor at 15s

// Virus TSV URL (Google Sheets export to TSV)
const VIRUS_TSV_URL = process.env.VIRUS_TSV_URL || '';
// Chip TSV URL
const CHIP_TSV_URL = process.env.CHIP_TSV_URL || process.env.CHIPS_TSV_URL || '';

// Stat caps (ENV-overridable)
const MAX_HP_CAP = parseInt(process.env.MAX_HP_CAP || '500', 10);
const MAX_DODGE_CAP = parseInt(process.env.MAX_DODGE_CAP || '40', 10);
const MAX_CRIT_CAP = parseInt(process.env.MAX_CRIT_CAP || '25', 10);

// Virus AI caps
const VIRUS_DEFENSE_CAP_TOTAL = 5; // total defense/barrier uses per encounter
const VIRUS_DEFENSE_CAP_STREAK = 2; // consecutive defense uses before forcing attack

// Zenny emoji helpers (fallback to moneybag)
const ZENNY_EMOJI_ID = process.env.ZENNY_EMOJI_ID || '';
const ZENNY_EMOJI_NAME = process.env.ZENNY_EMOJI_NAME || 'zenny';
const zennyIcon = () => (/^\d{17,20}$/.test(ZENNY_EMOJI_ID) ? `<:${ZENNY_EMOJI_NAME}:${ZENNY_EMOJI_ID}>` : '💰');

// Ensure data dir exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Auto-register slash commands (guild-scoped) ----------
async function registerCommands() {
  const TOKEN = process.env.DISCORD_TOKEN;
  const APP_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID;
  const GUILD_ID = process.env.GUILD_ID;

  if (!TOKEN || !APP_ID || !GUILD_ID) {
    console.warn('[commands] Skipping register: missing DISCORD_TOKEN / CLIENT_ID(APPLICATION_ID) / GUILD_ID');
    return;
  }

  const cmds = [
    new SlashCommandBuilder().setName('navi_register').setDescription('Register your Navi'),

    new SlashCommandBuilder()
      .setName('navi_upgrade')
      .setDescription('Upgrade your Navi (points/admin)')
      .addStringOption((o) =>
        o
          .setName('stat')
          .setDescription('Stat to upgrade')
          .setRequired(true)
          .addChoices({ name: 'hp', value: 'hp' }, { name: 'dodge', value: 'dodge' }, { name: 'crit', value: 'crit' }),
      )
      .addIntegerOption((o) =>
        o.setName('amount').setDescription('Optional amount (may be ignored in points mode)').setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName('navi_stats')
      .setDescription('Show Navi stats')
      .addUserOption((o) => o.setName('user').setDescription('User to inspect').setRequired(false)),

    new SlashCommandBuilder()
      .setName('duel')
      .setDescription('Challenge someone to a duel')
      .addUserOption((o) => o.setName('opponent').setDescription('Who to duel').setRequired(true)),

    new SlashCommandBuilder().setName('forfeit').setDescription('Forfeit the current duel/encounter'),

    new SlashCommandBuilder().setName('duel_state').setDescription('Show the current duel/encounter state'),

    new SlashCommandBuilder()
      .setName('navi_leaderboard')
      .setDescription('Show top players by record')
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many to list (5-25, default 10)').setRequired(false),
      ),

    // Virus Busting (PVE)
    new SlashCommandBuilder().setName('virus_busting').setDescription('Start a Virus encounter (PVE)'),

    new SlashCommandBuilder()
      .setName('virus_search')
      .setDescription('Look up Virus/Boss info')
      .addStringOption(o => o.setName('name').setDescription('Virus/Boss name').setRequired(true).setAutocomplete(true)),

    // Zenny
    new SlashCommandBuilder()
      .setName('zenny')
      .setDescription('Show Zenny balance')
      .addUserOption((o) => o.setName('user').setDescription('User to inspect').setRequired(false)),

    new SlashCommandBuilder()
      .setName('give_zenny')
      .setDescription('Give some of your Zenny to another player')
      .addUserOption((o) => o.setName('to').setDescription('Recipient').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Amount to send').setRequired(true).setMinValue(1)),

    // Chips economy & usage
    new SlashCommandBuilder().setName('shop').setDescription('View the chip shop'),

    new SlashCommandBuilder().setName('folder').setDescription('View your owned chips'),

    new SlashCommandBuilder()
      .setName('give_chip')
      .setDescription('Give chips from your folder to another player')
      .addUserOption(o => o.setName('to').setDescription('Recipient').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('qty').setDescription('Quantity').setRequired(true).setMinValue(1)),

    // Unified /use
    new SlashCommandBuilder()
      .setName('use')
      .setDescription('Play a chip (optionally chain a Support chip)')
      .addStringOption((o) => o.setName('chip').setDescription('Chip to use').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('support').setDescription('Optional Support chip to chain').setRequired(false).setAutocomplete(true)),

    // Admin chip mgmt
    new SlashCommandBuilder()
      .setName('chips_reload')
      .setDescription('Admin: reload chip list from TSV')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('chip_grant')
      .setDescription('Admin: grant chips to a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('qty').setDescription('Qty').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
      .setName('chip_remove')
      .setDescription('Admin: remove chips from a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('qty').setDescription('Qty').setRequired(true).setMinValue(1)),

    // Admin overrides
    new SlashCommandBuilder()
      .setName('stat_override')
      .setDescription('Admin: set HP/Dodge/Crit/Wins/Losses/Points for a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o =>
        o.setName('stat').setDescription('Which stat to set').setRequired(true)
         .addChoices(
           { name: 'hp', value: 'hp' },
           { name: 'dodge', value: 'dodge' },
           { name: 'crit', value: 'crit' },
           { name: 'wins', value: 'wins' },
           { name: 'losses', value: 'losses' },
           { name: 'points', value: 'points' },
         )
      )
      .addIntegerOption(o => o.setName('value').setDescription('New value').setRequired(true)),

    new SlashCommandBuilder()
      .setName('zenny_override')
      .setDescription('Admin: add Zenny to a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  console.log(`[commands] Registering ${cmds.length} commands to guild ${GUILD_ID}…`);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: cmds });
  console.log('[commands] Guild commands registered.');
}

// ---------- DB ----------
const db = new Database('./data/data.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS navis (
  user_id TEXT PRIMARY KEY,
  max_hp INTEGER NOT NULL DEFAULT 250,
  dodge  INTEGER NOT NULL DEFAULT 20,
  crit   INTEGER NOT NULL DEFAULT 5,
  wins   INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  upgrade_pts INTEGER NOT NULL DEFAULT 0,
  zenny INTEGER NOT NULL DEFAULT 0
);

-- PvP duel state (SIMULTANEOUS)
CREATE TABLE IF NOT EXISTS duel_state (
  channel_id TEXT PRIMARY KEY,
  p1_id TEXT NOT NULL,
  p2_id TEXT NOT NULL,
  p1_hp INTEGER NOT NULL,
  p2_hp INTEGER NOT NULL,
  p1_def INTEGER NOT NULL DEFAULT 0,
  p2_def INTEGER NOT NULL DEFAULT 0,
  p1_counts_json TEXT NOT NULL DEFAULT '{}',
  p2_counts_json TEXT NOT NULL DEFAULT '{}',
  p1_special_used TEXT NOT NULL DEFAULT '[]',
  p2_special_used TEXT NOT NULL DEFAULT '[]',
  p1_action_json TEXT DEFAULT NULL,
  p2_action_json TEXT DEFAULT NULL,
  round_deadline INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
);

-- PVE state (SIMULTANEOUS)
CREATE TABLE IF NOT EXISTS pve_state (
  channel_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  virus_name TEXT NOT NULL,
  virus_image TEXT,
  virus_max_hp INTEGER NOT NULL,
  virus_dodge INTEGER NOT NULL,
  virus_crit INTEGER NOT NULL,
  virus_is_boss INTEGER NOT NULL DEFAULT 0,
  virus_moves_json TEXT NOT NULL DEFAULT '[]',
  virus_zmin INTEGER NOT NULL DEFAULT 0,
  virus_zmax INTEGER NOT NULL DEFAULT 0,

  p_hp INTEGER NOT NULL,
  v_hp INTEGER NOT NULL,
  p_def INTEGER NOT NULL DEFAULT 0,
  v_def INTEGER NOT NULL DEFAULT 0,
  p_counts_json TEXT NOT NULL DEFAULT '{}',
  p_special_used TEXT NOT NULL DEFAULT '[]',
  v_special_used TEXT NOT NULL DEFAULT '[]',

  player_action_json TEXT DEFAULT NULL,
  virus_action_json  TEXT DEFAULT NULL,

  round_deadline INTEGER NOT NULL DEFAULT 0,

  -- Boss/virus AI caps
  v_def_total INTEGER NOT NULL DEFAULT 0,
  v_def_streak INTEGER NOT NULL DEFAULT 0,

  started_at INTEGER NOT NULL
);

-- Chips master & inventory
CREATE TABLE IF NOT EXISTS chips (
  name TEXT PRIMARY KEY,
  image_url TEXT,
  effect_json TEXT NOT NULL,
  zenny_cost INTEGER NOT NULL DEFAULT 0,
  is_upgrade INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  chip_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chip_name),
  FOREIGN KEY (chip_name) REFERENCES chips(name) ON UPDATE CASCADE ON DELETE RESTRICT
);
`);

// Migrations (safe no-ops)
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_action_json TEXT DEFAULT NULL;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_action_json TEXT DEFAULT NULL;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN round_deadline INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN player_action_json TEXT DEFAULT NULL;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN virus_action_json TEXT DEFAULT NULL;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN round_deadline INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN v_def_total INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN v_def_streak INTEGER NOT NULL DEFAULT 0;`); } catch {}

// Prepared statements
const getNavi = db.prepare(`SELECT * FROM navis WHERE user_id=?`);
const upsertNavi = db.prepare(`
INSERT INTO navis (user_id,max_hp,dodge,crit,wins,losses,upgrade_pts,zenny) VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET
  max_hp=excluded.max_hp,
  dodge=excluded.dodge,
  crit=excluded.crit,
  wins=excluded.wins,
  losses=excluded.losses,
  upgrade_pts=excluded.upgrade_pts,
  zenny=excluded.zenny
`);
function ensureNavi(uid) {
  const row = getNavi.get(uid);
  if (row) return row;
  upsertNavi.run(uid, 250, 20, 5, 0, 0, 0, 0);
  return { user_id: uid, max_hp: 250, dodge: 20, crit: 5, wins: 0, losses: 0, upgrade_pts: 0, zenny: 0 };
}

const setRecord = db.prepare(`UPDATE navis SET wins = wins + ?, losses = losses + ? WHERE user_id = ?`);
const addPoints = db.prepare(`UPDATE navis SET upgrade_pts = upgrade_pts + ? WHERE user_id = ?`);
const addZenny = db.prepare(`UPDATE navis SET zenny = zenny + ? WHERE user_id = ?`);
const setZenny = db.prepare(`UPDATE navis SET zenny = ? WHERE user_id = ?`);
const updHP = db.prepare(`UPDATE navis SET max_hp=? WHERE user_id=?`);
const updDodge = db.prepare(`UPDATE navis SET dodge=? WHERE user_id=?`);
const updCrit = db.prepare(`UPDATE navis SET crit=? WHERE user_id=?`);
const updWins = db.prepare(`UPDATE navis SET wins=? WHERE user_id=?`);
const updLosses = db.prepare(`UPDATE navis SET losses=? WHERE user_id=?`);
const updPts = db.prepare(`UPDATE navis SET upgrade_pts=? WHERE user_id=?`);

const getFight = db.prepare(`SELECT * FROM duel_state WHERE channel_id=?`);
const startFight = db.prepare(`
  INSERT INTO duel_state
    (channel_id,p1_id,p2_id,p1_hp,p2_hp,p1_def,p2_def,p1_counts_json,p2_counts_json,p1_special_used,p2_special_used,p1_action_json,p2_action_json,round_deadline,started_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const updFightRound = db.prepare(`
  UPDATE duel_state
     SET p1_hp=?, p2_hp=?,
         p1_def=?, p2_def=?,
         p1_counts_json=?, p2_counts_json=?,
         p1_special_used=?, p2_special_used=?,
         p1_action_json=?, p2_action_json=?,
         round_deadline=?
   WHERE channel_id=?
`);
const endFight = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

const getPVE = db.prepare(`SELECT * FROM pve_state WHERE channel_id=?`);
const startPVE = db.prepare(`
  INSERT INTO pve_state (
    channel_id, player_id, virus_name, virus_image, virus_max_hp, virus_dodge, virus_crit, virus_is_boss, virus_moves_json, virus_zmin, virus_zmax,
    p_hp, v_hp, p_def, v_def, p_counts_json, p_special_used, v_special_used, player_action_json, virus_action_json, round_deadline, v_def_total, v_def_streak, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const updPVE = db.prepare(`
  UPDATE pve_state
     SET p_hp=?, v_hp=?,
         p_def=?, v_def=?,
         p_counts_json=?, p_special_used=?, v_special_used=?,
         player_action_json=?, virus_action_json=?,
         round_deadline=?,
         v_def_total=?, v_def_streak=?
   WHERE channel_id=?
`);
const endPVE = db.prepare(`DELETE FROM pve_state WHERE channel_id=?`);

// Chips & inventory
const getChip = db.prepare(`SELECT * FROM chips WHERE name=?`);
const listChips = db.prepare(`SELECT * FROM chips WHERE is_upgrade=0 ORDER BY name COLLATE NOCASE ASC`);
const listAllChipNames = db.prepare(`SELECT name FROM chips ORDER BY name COLLATE NOCASE ASC`);
const listShop = db.prepare(`SELECT * FROM chips ORDER BY is_upgrade ASC, zenny_cost ASC, name COLLATE NOCASE ASC`);
const upsertChip = db.prepare(`
INSERT INTO chips (name,image_url,effect_json,zenny_cost,is_upgrade) VALUES (?,?,?,?,?)
ON CONFLICT(name) DO UPDATE SET image_url=excluded.image_url,effect_json=excluded.effect_json,zenny_cost=excluded.zenny_cost,is_upgrade=excluded.is_upgrade
`);
const getInv = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_name=?`);
const setInv = db.prepare(`
INSERT INTO inventory (user_id,chip_name,qty) VALUES (?,?,?)
ON CONFLICT(user_id,chip_name) DO UPDATE SET qty=excluded.qty
`);
const listInv = db.prepare(`SELECT chip_name, qty FROM inventory WHERE user_id=? AND qty>0 ORDER BY chip_name COLLATE NOCASE ASC`);

// Helpers
const normalize = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '');
const parseList = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const parseMap = (s) => { try { const v = JSON.parse(s ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const parseMoves = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const tryParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const now = () => Date.now();

// Pretty
function hpLineDuel(f) { return `HP — <@${f.p1_id}>: ${f.p1_hp} | <@${f.p2_id}>: ${f.p2_hp}`; }
function hpLinePVE(f) { return `HP — <@${f.player_id}>: ${f.p_hp} | **${f.virus_name}**: ${f.v_hp}`; }

function isAdmin(ix) {
  const hasAdminRole = ix.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
  const hasManageGuild =
    ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    ix.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
  return !!(hasAdminRole || hasManageGuild);
}

// Round timers
const RoundTimers = new Map(); // channelId -> Timeout
function clearRoundTimer(channelId) {
  const t = RoundTimers.get(channelId);
  if (t) { clearTimeout(t); RoundTimers.delete(channelId); }
}
function scheduleRoundTimer(channelId, fn) {
  clearRoundTimer(channelId);
  const t = setTimeout(fn, ROUND_SECONDS * 1000);
  RoundTimers.set(channelId, t);
}

// ---------- Virus TSV Loader ----------
const VirusCache = { ts: 0, rows: [] };
const HEADER_MAP = (h) => (h || '').toLowerCase().trim().replace(/[^\w]+/g, '_');

function parseRange(s) {
  const t = String(s || '').trim();
  if (!t) return { min: 0, max: 0 };
  const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const n = parseInt(t, 10);
  return { min: isNaN(n) ? 0 : n, max: isNaN(n) ? 0 : n };
}

function weightFor(row) {
  const sp = Number(row.stat_points || 1);
  const boss = !!row.boss;
  if (!boss) return Math.max(1, 5 - Math.max(1, Math.min(4, sp)));
  if (sp <= 5) return 1;
  if (sp === 6) return 0.6;
  return 0.4;
}

async function loadViruses(force = false) {
  const FRESH_MS = 1000 * 60 * 5;
  if (!force && VirusCache.rows.length && (Date.now() - VirusCache.ts) < FRESH_MS) return VirusCache.rows;
  if (!VIRUS_TSV_URL) return [];

  const res = await fetch(VIRUS_TSV_URL);
  if (!res.ok) throw new Error(`Virus TSV fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split('\t').map(HEADER_MAP);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx]; });

    const name = (obj.name || '').trim();
    if (!name) continue;

    const hp = parseInt(obj.hp || '0', 10) || 0;
    const dodge = parseInt(obj.dodge || '0', 10) || 0;
    const crit = parseInt(obj.crit || '0', 10) || 0;

    const m1 = obj.move1_json || obj.move_1json || obj.move_1 || '';
    const m2 = obj.move_2json || obj.move2_json || obj.move_2 || '';
    const m3 = obj.move3_json || obj.move_3 || '';
    const m4 = obj.move4_json || obj.move_4 || '';
    const moves = [];
    const pushMove = (s, fallback) => {
      if (!s) return;
      try {
        const mv = JSON.parse(s);
        if (mv && typeof mv === 'object') {
          if (!mv.name && !mv.label) mv.name = fallback;
          moves.push(mv);
        }
      } catch {}
    };
    pushMove(m1, 'Move1'); pushMove(m2, 'Move2'); pushMove(m3, 'Move3'); pushMove(m4, 'Move4');

    const sp = parseInt((obj.stat_points || '1'), 10) || 1;
    const boss = String(obj.boss || '').toLowerCase().trim();
    const isBoss = ['1','true','yes','y'].includes(boss);
    const { min: zmin, max: zmax } = parseRange(obj.zenny || obj.zenny_range || '');

    rows.push({ name, image_url: obj.image_url || '', hp, dodge, crit, moves, stat_points: sp, boss: isBoss, weight: 0, zmin, zmax });
  }

  rows.forEach(r => r.weight = weightFor(r));
  VirusCache.rows = rows;
  VirusCache.ts = Date.now();
  return rows;
}
function weightedPick(rows) {
  const total = rows.reduce((s, r) => s + (r.weight || 0), 0);
  if (total <= 0) return rows[Math.floor(Math.random() * rows.length)];
  let roll = Math.random() * total;
  for (const r of rows) { roll -= (r.weight || 0); if (roll <= 0) return r; }
  return rows[rows.length - 1];
}

// ---------- Chip TSV Loader ----------
const ChipsCache = { ts: 0, rows: [] };
function parseBool(x) {
  const s = String(x ?? '').trim().toLowerCase();
  return ['1','true','yes','y'].includes(s);
}
async function reloadChipsFromTSV() {
  if (!CHIP_TSV_URL) throw new Error('CHIP_TSV_URL (or CHIPS_TSV_URL) not set.');
  const res = await fetch(CHIP_TSV_URL);
  if (!res.ok) throw new Error(`Chip TSV fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('Empty chip TSV');

  const headers = lines[0].split('\t').map(HEADER_MAP);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const obj = {}; headers.forEach((h, idx) => { obj[h] = cols[idx]; });
    rows.push(obj);
  }

  const upserts = db.transaction((rows2) => {
    for (const r of rows2) {
      const name = (r.name || '').trim();
      if (!name) continue;
      const img = r.image_url || '';

      // accept effect / effect_json / json_effect
      let effect_json = '{}';
      const rawEffect = r.effect ?? r.effect_json ?? r.json_effect ?? '{}';
      try { effect_json = JSON.stringify(JSON.parse(rawEffect || '{}')); } catch { effect_json = '{}'; }

      const cost = parseInt(r.zenny_cost || r.cost || '0', 10) || 0;
      const isUp = parseBool(r.upgrade ?? r.is_upgrade);
      upsertChip.run(name, img, effect_json, cost, isUp ? 1 : 0);
    }
  });
  upserts(rows);

  ChipsCache.ts = Date.now();
  ChipsCache.rows = rows;
}

// ---------- Combat helpers ----------
function extractKinds(effect) {
  if (!effect) return [];
  const k = effect.kinds || effect.kind || '';
  if (Array.isArray(k)) return k.map((x) => String(x).toLowerCase());
  return String(k || '').toLowerCase().split(/[+,\s/]+/).filter(Boolean);
}
function isAttack(effect) { const kinds = extractKinds(effect); return kinds.includes('attack') || kinds.includes('break'); }
function isBreak(effect) { const kinds = extractKinds(effect); return kinds.includes('break'); }
function isSupport(effect) { return extractKinds(effect).includes('support'); }
function isBarrier(effect) { return extractKinds(effect).includes('barrier'); }
function isDefense(effect) { return extractKinds(effect).includes('defense'); }
function isRecovery(effect) { return extractKinds(effect).includes('recovery'); }
function isSpecial(effect) { return !!effect?.special; }

function supportBonus(effect) {
  if (!effect) return 0;
  if (Number.isFinite(effect.add)) return effect.add;
  if (Number.isFinite(effect.dmg)) return effect.dmg;
  return 0;
}

function readEffect(chipRow) { return tryParseJSON(chipRow?.effect_json) || {}; }

function invGetQty(userId, chipName) {
  const r = getInv.get(userId, chipName);
  return r ? (r.qty || 0) : 0;
}
function invAdd(userId, chipName, delta) {
  const cur = invGetQty(userId, chipName);
  const next = Math.max(0, cur + delta);
  setInv.run(userId, chipName, next);
  return next;
}

// ----- Upgrade normalization & application -----
function pickNumeric(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return 0;
}

// map many TSV shapes to {stat, step}
function normalizeUpgradeEffect(eRaw) {
  const e = eRaw || {};
  const rawStat = String(e.stat ?? e.target ?? e.attribute ?? e.type ?? e.name ?? '').toLowerCase();
  const nameBlob = (rawStat || '').replace(/\s+/g, '');
  const statGuess =
    nameBlob.includes('hp') ? 'hp' :
    (nameBlob.includes('dodge') || nameBlob.includes('evad')) ? 'dodge' :
    (nameBlob.includes('crit')) ? 'crit' : '';

  // if stat not explicitly given, infer from explicit numeric fields
  const hpNum = Number(e.hp);
  const dodgeNum = Number(e.dodge);
  const critNum = Number(e.crit);

  let stat = statGuess;
  if (!stat) {
    if (Number.isFinite(hpNum) && Math.abs(hpNum) > 0) stat = 'hp';
    else if (Number.isFinite(dodgeNum) && Math.abs(dodgeNum) > 0) stat = 'dodge';
    else if (Number.isFinite(critNum) && Math.abs(critNum) > 0) stat = 'crit';
  }

  // delta: prefer explicit stat field, else generic add/amount/value/step
  let step = 0;
  if (stat === 'hp')    step = pickNumeric(e.step, e.value, e.amount, e.add, e.delta, hpNum);
  if (stat === 'dodge') step = pickNumeric(e.step, e.value, e.amount, e.add, e.delta, dodgeNum);
  if (stat === 'crit')  step = pickNumeric(e.step, e.value, e.amount, e.add, e.delta, critNum);

  // final fallback for generic upgrades like {add: 10}
  if (!step) step = pickNumeric(e.step, e.value, e.amount, e.add, e.delta);

  return { stat, step: Number(step) || 0 };
}

// Apply an upgrade row immediately to a user (qty supported)
function applyUpgrade(userId, chipRow, qty = 1) {
  const eff = readEffect(chipRow);
  const { stat, step } = normalizeUpgradeEffect(eff);
  const amount = (Number.isFinite(step) ? step : 0) * Math.max(1, qty);

  const cur = ensureNavi(userId);
  let { max_hp, dodge, crit } = cur;

  let deltaHP = 0, deltaDodge = 0, deltaCrit = 0;

  if (stat === 'hp' && amount) {
    const before = max_hp;
    max_hp = Math.min(MAX_HP_CAP, max_hp + amount);
    deltaHP = max_hp - before;
  }
  if (stat === 'dodge' && amount) {
    const before = dodge;
    dodge = Math.min(MAX_DODGE_CAP, dodge + amount);
    deltaDodge = dodge - before;
  }
  if (stat === 'crit' && amount) {
    const before = crit;
    crit = Math.min(MAX_CRIT_CAP, crit + amount);
    deltaCrit = crit - before;
  }

  upsertNavi.run(userId, max_hp, dodge, crit, cur.wins ?? 0, cur.losses ?? 0, cur.upgrade_pts ?? 0, cur.zenny ?? 0);
  const after = ensureNavi(userId);
  return { after, deltaHP, deltaDodge, deltaCrit };
}

// action encoding
function actionChip(name) { return JSON.stringify({ type: 'chip', name }); }
function actionSupport(support, withChip) { return JSON.stringify({ type: 'support', support, with: withChip }); }
function decodeAction(s) { return tryParseJSON(s) || null; }

// Random bot chip (simple) with rule checks against per-battle limits/specials
function pickBotChipFor(f, isP1) {
  const counts = parseMap(isP1 ? f.p1_counts_json : f.p2_counts_json);
  const specials = new Set(parseList(isP1 ? f.p1_special_used : f.p2_special_used));
  const rows = listChips.all();
  const eligible = rows.filter((r) => {
    const eff = readEffect(r);
    if (r.is_upgrade) return false;
    if (counts[r.name] >= MAX_PER_CHIP) return false;
    if (isSpecial(eff) && specials.has(r.name)) return false;
    return true;
  });
  if (!eligible.length) return null;
  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  return { type: 'chip', name: pick.name };
}

// Damage math for a single (possibly supported) attack into a defender
function computeAttackDamage({ baseChip, supportEff, defenderDEF, defenderHasBarrier, breakFlag, dodgePct, critPct }) {
  if (defenderHasBarrier && !breakFlag) {
    return { dmg: 0, crit: false, dodged: false, cancelledByBarrier: true, absorbed: 0 };
  }
  const dodged = (Math.random() * 100) < (dodgePct || 0);
  if (dodged) return { dmg: 0, crit: false, dodged: true, cancelledByBarrier: false, absorbed: 0 };

  const base = Number.isFinite(baseChip?.dmg) ? baseChip.dmg : 0;
  const bonus = supportEff ? supportBonus(supportEff) : 0;

  const isCrit = (Math.random() * 100) < (critPct || 0);
  const critBase = isCrit ? Math.floor((base * 3) / 2) : base;

  const preDef = critBase;
  const effective = breakFlag ? preDef : Math.max(0, preDef - (defenderDEF || 0));
  const absorbed = breakFlag ? 0 : (preDef - effective);

  const dmgTotal = Math.max(0, effective + bonus);
  return { dmg: dmgTotal, crit: isCrit, dodged, cancelledByBarrier: false, absorbed };
}

// ---------- Virus AI helpers ----------
function isDefLikeMove(mv) {
  if (!mv) return false;
  const kinds = extractKinds(mv);
  return kinds.includes('defense') || kinds.includes('barrier');
}
function isAtkLikeMove(mv) {
  if (!mv) return false;
  const kinds = extractKinds(mv);
  return kinds.includes('attack') || kinds.includes('break') || kinds.includes('recovery'); // allow aggressive heals if defined
}

// Picks a move subject to:
// - specials (boss) each usable once
// - total defense uses <= VIRUS_DEFENSE_CAP_TOTAL
// - no more than VIRUS_DEFENSE_CAP_STREAK consecutive defense uses (forces attack if possible)
function pickVirusMove(pveRow) {
  const moves = parseMoves(pveRow.virus_moves_json);
  if (!moves.length) return null;

  const usedSpecials = new Set(parseList(pveRow.v_special_used));
  const totalDef = Number(pveRow.v_def_total || 0);
  const defStreak = Number(pveRow.v_def_streak || 0);

  // Filter out spent specials
  const notSpent = moves.filter((m) => !(m.special && usedSpecials.has((m.name || m.label || 'special'))));

  // If consecutive defense >= cap → try to force attack
  if (defStreak >= VIRUS_DEFENSE_CAP_STREAK) {
    const attacks = notSpent.filter((m) => !isDefLikeMove(m));
    if (attacks.length) return attacks[Math.floor(Math.random() * attacks.length)];
    // fall through to other pools if none
  }

  // If total defense at or above cap → avoid defense
  if (totalDef >= VIRUS_DEFENSE_CAP_TOTAL) {
    const nonDef = notSpent.filter((m) => !isDefLikeMove(m));
    if (nonDef.length) return nonDef[Math.floor(Math.random() * nonDef.length)];
    return notSpent[Math.floor(Math.random() * notSpent.length)];
  }

  // Normal random from notSpent
  return notSpent[Math.floor(Math.random() * notSpent.length)];
}

// ---------- UI helpers for Shop ----------
function summarizeEffect(e) {
  if (!e) return '—';
  const bits = [];
  const kinds = extractKinds(e);
  if (kinds.length) bits.push(`Kinds: \`${kinds.join(', ')}\``);
  if (Number.isFinite(e.dmg)) bits.push(`DMG: **${e.dmg}**`);
  if (Number.isFinite(e.def)) bits.push(`DEF: **${e.def}**`);
  const heal = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : null);
  if (heal != null) bits.push(`Heal: **${heal}**`);
  if (e.special) bits.push('⭐ Special (once per battle)');
  return bits.join(' • ') || '—';
}
function buildShopPage(rows, page = 0) {
  const PER = 25;
  const totalPages = Math.max(1, Math.ceil(rows.length / PER));
  page = Math.min(totalPages - 1, Math.max(0, page));
  const start = page * PER;
  const slice = rows.slice(start, start + PER);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`shop:select:${page}`)
    .setPlaceholder(`Select an item (${page + 1}/${totalPages})`)
    .addOptions(
      slice.map(r => ({
        label: r.name.slice(0, 100),
        value: r.name,
        description: `${r.is_upgrade ? 'Upgrade' : 'Chip'} • ${r.zenny_cost} ${zennyIcon()}`
      })),
    );

  const rowSel = new ActionRowBuilder().addComponents(select);

  const prev = new ButtonBuilder().setCustomId(`shop:prev:${page}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0);
  const next = new ButtonBuilder().setCustomId(`shop:next:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1);
  const close = new ButtonBuilder().setCustomId('shop:close').setLabel('Close').setStyle(ButtonStyle.Danger);
  const rowNav = new ActionRowBuilder().addComponents(prev, next, close);

  const list = slice
    .map(r => `• **${r.name}** — ${r.zenny_cost} ${zennyIcon()}${r.is_upgrade ? ' (Upgrade — consumed on purchase)' : ''}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🛒 Chip Shop')
    .setDescription(`${list || '—'}\n\nPick an item from the menu below to view details & buy.`)
    .setFooter({ text: `Items ${start + 1}-${Math.min(rows.length, start + PER)} of ${rows.length} • Page ${page + 1}/${totalPages}` });

  return { embed, components: [rowSel, rowNav], page, totalPages };
}

// ---------- Round resolution (Duels) ----------
async function resolveDuelRound(channel) {
  const f0 = getFight.get(channel.id);
  if (!f0) return;

  // Ensure bot (if present) always locks an action this round
  let f = f0;
  if (!f.p2_action_json && f.p2_id === client.user.id) {
    const act = pickBotChipFor(f, false);
    if (act) {
      updFightRound.run(
        f.p1_hp, f.p2_hp,
        f.p1_def, f.p2_def,
        f.p1_counts_json, f.p2_counts_json,
        f.p1_special_used, f.p2_special_used,
        f.p1_action_json, JSON.stringify(act),
        f.round_deadline,
        channel.id
      );
      f = getFight.get(channel.id);
    }
  }
  if (!f.p1_action_json && f.p1_id === client.user.id) {
    const act = pickBotChipFor(f, true);
    if (act) {
      updFightRound.run(
        f.p1_hp, f.p2_hp,
        f.p1_def, f.p2_def,
        f.p1_counts_json, f.p2_counts_json,
        f.p1_special_used, f.p2_special_used,
        JSON.stringify(act), f.p2_action_json,
        f.round_deadline,
        channel.id
      );
      f = getFight.get(channel.id);
    }
  }

  const p1 = ensureNavi(f.p1_id);
  const p2 = ensureNavi(f.p2_id);

  const A1 = decodeAction(f.p1_action_json);
  const A2 = decodeAction(f.p2_action_json);

  // If neither acted and deadline passed, reschedule another wait
  if (!A1 && !A2) {
    const nextDeadline = now() + ROUND_SECONDS * 1000;
    updFightRound.run(f.p1_hp, f.p2_hp, 0, 0, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, null, null, nextDeadline, channel.id);
    scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));
    await channel.send(`⏳ New round started. Submit your chips with **/use** within **${ROUND_SECONDS}s**.\n${hpLineDuel(getFight.get(channel.id))}`);
    return;
  }

  // Build intents
  function rowAndEff(name) {
    const r = getChip.get(name);
    const e = readEffect(r);
    return { r, e };
  }
  function interpret(inv) {
    if (!inv) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [] };
    if (inv.type === 'chip') {
      const { r, e } = rowAndEff(inv.name);
      if (!r) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [] };
      let def = 0, barrier = false, attackEff = null, rec = 0;
      if (isDefense(e)) def = Number.isFinite(e.def) ? e.def : 0;
      if (isBarrier(e)) barrier = true;
      if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
      if (isAttack(e)) attackEff = e;
      return { def, barrier, attackEff, rec, used: [r.name] };
    }
    if (inv.type === 'support') {
      const { r: sr, e: se } = rowAndEff(inv.support);
      const { r: cr, e: ce } = rowAndEff(inv.with);
      if (!sr || !cr) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [] };
      let def = 0, barrier = false, attackEff = null, rec = 0;
      if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
      if (isBarrier(ce)) barrier = true;
      if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? e.heal : (Number.isFinite(ce.rec) ? ce.rec : 0);
      if (isAttack(ce)) attackEff = ce;
      return { def, barrier, attackEff, rec, supportEff: se, used: [sr.name, cr.name] };
    }
    return { def: 0, barrier: false, attackEff: null, rec: 0, used: [] };
  }

  const P1 = interpret(A1);
  const P2 = interpret(A2);

  let p1DEF = P1.def || 0;
  let p2DEF = P2.def || 0;
  const p1Barrier = !!P1.barrier;
  const p2Barrier = !!P2.barrier;

  let dmg1to2 = 0, crit1 = false, dodged1 = false, absorbed1 = 0, cancelledByBarrier1 = false;
  if (P1.attackEff) {
    const res = computeAttackDamage({
      baseChip: P1.attackEff, supportEff: P1.supportEff,
      defenderDEF: p2DEF, defenderHasBarrier: p2Barrier,
      breakFlag: isBreak(P1.attackEff), dodgePct: p2.dodge, critPct: p1.crit,
    });
    ({ dmg: dmg1to2, crit: crit1, dodged: dodged1, absorbed: absorbed1, cancelledByBarrier: cancelledByBarrier1 } = res);
  }

  let dmg2to1 = 0, crit2 = false, dodged2 = false, absorbed2 = 0, cancelledByBarrier2 = false;
  if (P2.attackEff) {
    const res = computeAttackDamage({
      baseChip: P2.attackEff, supportEff: P2.supportEff,
      defenderDEF: p1DEF, defenderHasBarrier: p1Barrier,
      breakFlag: isBreak(P2.attackEff), dodgePct: p1.dodge, critPct: p2.crit,
    });
    ({ dmg: dmg2to1, crit: crit2, dodged: dodged2, absorbed: absorbed2, cancelledByBarrier: cancelledByBarrier2 } = res);
  }

  let rec1 = P1.rec || 0; if (P1.attackEff && p2Barrier && !isBreak(P1.attackEff)) rec1 = 0;
  let rec2 = P2.rec || 0; if (P2.attackEff && p1Barrier && !isBreak(P2.attackEff)) rec2 = 0;

  let p1hp = Math.max(0, Math.min(p1.max_hp, f.p1_hp - dmg2to1 + rec1));
  let p2hp = Math.max(0, Math.min(p2.max_hp, f.p2_hp - dmg1to2 + rec2));

  function bumpCounters(counts, specials, usedNames) {
    for (const n of (usedNames || [])) {
      counts[n] = (counts[n] || 0) + 1;
      const eff = readEffect(getChip.get(n));
      if (isSpecial(eff)) specials.add(n);
    }
  }
  let p1Counts = parseMap(f.p1_counts_json);
  let p2Counts = parseMap(f.p2_counts_json);
  let p1Spec = new Set(parseList(f.p1_special_used));
  let p2Spec = new Set(parseList(f.p2_special_used));
  bumpCounters(p1Counts, p1Spec, P1.used);
  bumpCounters(p2Counts, p2Spec, P2.used);

  let outcome = '';
  if (p1hp === 0 && p2hp === 0) {
    outcome = '🤝 **Double KO!** No W/L changes.';
  } else if (p1hp === 0) {
    outcome = `🏆 **<@${f.p2_id}> wins!**`;
    setRecord.run(1, 0, f.p2_id);
    setRecord.run(0, 1, f.p1_id);
    if (POINTS_PER_WIN > 0) addPoints.run(POINTS_PER_WIN, f.p2_id);
    endFight.run(channel.id);
    clearRoundTimer(channel.id);
  } else if (p2hp === 0) {
    outcome = `🏆 **<@${f.p1_id}> wins!**`;
    setRecord.run(1, 0, f.p1_id);
    setRecord.run(0, 1, f.p2_id);
    if (POINTS_PER_WIN > 0) addPoints.run(POINTS_PER_WIN, f.p1_id);
    endFight.run(channel.id);
    clearRoundTimer(channel.id);
  }

  const nextDeadline = now() + ROUND_SECONDS * 1000;
  if (!outcome) {
    updFightRound.run(
      p1hp, p2hp,
      0, 0,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify([...p1Spec]), JSON.stringify([...p2Spec]),
      null, null,
      nextDeadline,
      channel.id,
    );
    scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));
  }

  function fmt(P, crit, dodged, cancelled, dmg, absorbed, rec) {
    const used = [...new Set(P.used || [])];
    const parts = [];
    if (P.supportEff && used.length === 2) parts.push(`**${used[0]}** → **${used[1]}**`);
    else if (used.length) parts.push(used.map((n) => `**${n}**`).join(' + '));
    else parts.push('did nothing');
    const extras = [];
    if (P.barrier) extras.push('🛡️ Barrier');
    if (P.def) extras.push(`🧱 DEF +${P.def}`);
    if (rec > 0) extras.push(`💚 +${rec}`);
    if (P.attackEff) {
      if (cancelled) extras.push('❌ cancelled');
      else if (dodged) extras.push('💨 dodged');
      else extras.push(`💥 ${dmg}${crit ? ' _(CRIT!)_' : ''}${absorbed > 0 ? ` (DEF absorbed ${absorbed})` : ''}`);
    }
    return `${parts.join(' ')}${extras.length ? ` → ${extras.join(' | ')}` : ''}`;
  }

  const header = `🎬 **Round Results**\n• <@${f.p1_id}> ${fmt(P1, crit1, dodged1, cancelledByBarrier1, dmg1to2, absorbed1, rec1)}\n• <@${f.p2_id}> ${fmt(P2, crit2, dodged2, cancelledByBarrier2, dmg2to1, absorbed2, rec2)}\n${hpLineDuel({ ...f, p1_hp: p1hp, p2_hp: p2hp })}`;
  await channel.send(outcome ? `${header}\n\n${outcome}` : `${header}\n\n➡️ Next round: submit with **/use** within **${ROUND_SECONDS}s**.`);
}

// ---------- Round resolution (PVE) ----------
async function resolvePVERound(channel) {
  const f = getPVE.get(channel.id);
  if (!f) return;

  const player = ensureNavi(f.player_id);

  const Aplayer = decodeAction(f.player_action_json);
  let Avirus = decodeAction(f.virus_action_json);

  if (!Avirus) {
    const mv = pickVirusMove(f);
    if (mv) Avirus = { type: 'chip', name: mv.name || mv.label || 'Move' };
  }

  if (!Aplayer && !Avirus) {
    const nextDeadline = now() + ROUND_SECONDS * 1000;
    updPVE.run(f.p_hp, f.v_hp, 0, 0, f.p_counts_json, f.p_special_used, f.v_special_used, null, null, nextDeadline, f.v_def_total, f.v_def_streak, channel.id);
    scheduleRoundTimer(channel.id, () => resolvePVERound(channel));
    const embed = new EmbedBuilder()
      .setTitle(`👾 ${f.virus_name}`)
      .setDescription(`**HP** ${f.v_hp} / ${f.virus_max_hp} | **Dodge** ${f.virus_dodge}% | **Crit** ${f.virus_crit}%`)
      .setImage(f.virus_image || null)
      .setFooter({ text: 'Virus Busting' });
    await channel.send({ content: `⏳ New round started. Submit with **/use** within **${ROUND_SECONDS}s**.\n${hpLinePVE(f)}`, embeds: [embed] });
    return;
  }

  // Intents
  function chipRowOrNull(name) { return getChip.get(name) || null; }
  function effectFromName(name) { const r = chipRowOrNull(name); return { r, e: readEffect(r) }; }

  function intentFromAction(action, isVirus) {
    if (!action) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], mv: null };
    if (action.type === 'chip') {
      if (isVirus) {
        const mv = parseMoves(f.virus_moves_json).find(m => (m.name || m.label || '').toLowerCase() === String(action.name || '').toLowerCase());
        if (!mv) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], mv: null };
        let def = 0, barrier = false, attackEff = null, rec = 0;
        if (isDefense(mv)) def = Number.isFinite(mv.def) ? mv.def : 0;
        if (isBarrier(mv)) barrier = true;
        if (isRecovery(mv)) rec += Number.isFinite(mv.heal) ? mv.heal : (Number.isFinite(mv.rec) ? mv.rec : 0);
        if (isAttack(mv)) attackEff = mv;
        return { def, barrier, attackEff, rec, used: [], mv };
      } else {
        const { r, e } = effectFromName(action.name);
        if (!r) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], mv: null };
        let def = 0, barrier = false, attackEff = null, rec = 0;
        if (isDefense(e)) def = Number.isFinite(e.def) ? e.def : 0;
        if (isBarrier(e)) barrier = true;
        if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
        if (isAttack(e)) attackEff = e;
        return { def, barrier, attackEff, rec, used: [r.name], mv: null };
      }
    }
    if (action.type === 'support' && !isVirus) {
      const s = effectFromName(action.support), c = effectFromName(action.with);
      if (!s.r || !c.r) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], mv: null };
      let def = 0, barrier = false, attackEff = null, rec = 0;
      if (isDefense(c.e)) def += Number.isFinite(c.e.def) ? c.e.def : 0;
      if (isBarrier(c.e)) barrier = true;
      if (isRecovery(c.e)) rec += Number.isFinite(c.e.heal) ? c.e.heal : (Number.isFinite(c.e.rec) ? c.e.rec : 0);
      if (isAttack(c.e)) attackEff = c.e;
      return { def, barrier, attackEff, rec, supportEff: s.e, used: [s.r.name, c.r.name], mv: null };
    }
    return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], mv: null };
  }

  const PP = intentFromAction(Aplayer, false);
  const PV = intentFromAction(Avirus, true);

  let pDEF = PP.def || 0;
  let vDEF = PV.def || 0;
  const pBarrier = !!PP.barrier;
  const vBarrier = !!PV.barrier;

  // Player attacks virus
  let dmgPtoV = 0, critP = false, dodgedP = false, absorbedP = 0, cancelledByBarrierP = false;
  if (PP.attackEff) {
    const res = computeAttackDamage({
      baseChip: PP.attackEff, supportEff: PP.supportEff,
      defenderDEF: vDEF, defenderHasBarrier: vBarrier,
      breakFlag: isBreak(PP.attackEff),
      dodgePct: f.virus_dodge, critPct: player.crit
    });
    ({ dmg: dmgPtoV, crit: critP, dodged: dodgedP, absorbed: absorbedP, cancelledByBarrier: cancelledByBarrierP } = res);
  }

  // Virus attacks player
  let dmgVtoP = 0, critV = false, dodgedV = false, absorbedV = 0, cancelledByBarrierV = false;
  if (PV.attackEff) {
    const res = computeAttackDamage({
      baseChip: PV.attackEff, supportEff: null,
      defenderDEF: pDEF, defenderHasBarrier: pBarrier,
      breakFlag: isBreak(PV.attackEff),
      dodgePct: player.dodge, critPct: f.virus_crit
    });
    ({ dmg: dmgVtoP, crit: critV, dodged: dodgedV, absorbed: absorbedV, cancelledByBarrier: cancelledByBarrierV } = res);
  }

  let recP = PP.rec || 0; if (PP.attackEff && vBarrier && !isBreak(PP.attackEff)) recP = 0;
  let recV = PV.rec || 0; if (PV.attackEff && pBarrier && !isBreak(PV.attackEff)) recV = 0;

  let php = Math.max(0, Math.min(player.max_hp, f.p_hp - dmgVtoP + recP));
  let vhp = Math.max(0, Math.min(f.virus_max_hp, f.v_hp - dmgPtoV + recV));

  // Update player per-battle counters & specials
  function bumpPlayerCounters(used) {
    const counts = parseMap(f.p_counts_json);
    let pSpec = new Set(parseList(f.p_special_used));
    for (const n of (used || [])) {
      counts[n] = (counts[n] || 0) + 1;
      const eff = readEffect(getChip.get(n));
      if (isSpecial(eff)) pSpec.add(n);
    }
    return { counts, pSpec };
  }
  const { counts: pCounts, pSpec } = bumpPlayerCounters(PP.used);

  // Virus special tracking (boss only)
  let vSpec = new Set(parseList(f.v_special_used));
  if (PV.mv?.special) {
    const nm = PV.mv.name || PV.mv.label || 'special';
    vSpec.add(nm);
  }

  // Defense cap accounting for virus
  let nextDefTotal = f.v_def_total || 0;
  let nextDefStreak = PV.mv && isDefLikeMove(PV.mv) ? Math.min(VIRUS_DEFENSE_CAP_STREAK, (f.v_def_streak || 0) + 1) : 0;
  if (PV.mv && isDefLikeMove(PV.mv)) nextDefTotal = Math.min(VIRUS_DEFENSE_CAP_TOTAL, nextDefTotal + 1);

  // Outcome
  let outcome = '';
  if (php === 0 && vhp === 0) {
    outcome = '🤝 **Double KO!**';
    endPVE.run(channel.id);
    clearRoundTimer(channel.id);
  } else if (vhp === 0) {
    // Zenny and STAT POINTS based on virus stat_points
    const z = Math.max(f.virus_zmin || 0, Math.min(f.virus_zmax || 0, Math.floor(Math.random() * ((f.virus_zmax || 0) - (f.virus_zmin || 0) + 1)) + (f.virus_zmin || 0)));
    if (z > 0) addZenny.run(z, f.player_id);

    // derive stat points from cached TSV record of this virus
    let sp = 1;
    try {
      const vr = VirusCache.rows.find(r => (r.name || '').toLowerCase() === (f.virus_name || '').toLowerCase());
      sp = Math.max(1, parseInt(vr?.stat_points || '1', 10) || 1);
    } catch {}
    addPoints.run(sp, f.player_id);

    outcome = `🏆 **<@${f.player_id}> wins!** You earned **${z}** ${zennyIcon()} and **${sp}** upgrade point${sp === 1 ? '' : 's'}.`;
    endPVE.run(channel.id);
    clearRoundTimer(channel.id);
  } else if (php === 0) {
    outcome = `💀 **${f.virus_name}** wins! Better luck next time.`;
    endPVE.run(channel.id);
    clearRoundTimer(channel.id);
  }

  if (!outcome) {
    const nextDeadline = now() + ROUND_SECONDS * 1000;
    updPVE.run(
      php, vhp,
      0, 0, // reset temp DEF
      JSON.stringify(pCounts), JSON.stringify([...pSpec]), JSON.stringify([...vSpec]),
      null, null,
      nextDeadline,
      nextDefTotal, nextDefStreak,
      channel.id
    );
    scheduleRoundTimer(channel.id, () => resolvePVERound(channel));
  }

  const embed = new EmbedBuilder()
    .setTitle(`👾 ${f.virus_name}`)
    .setDescription(`**HP** ${vhp} / ${f.virus_max_hp} | **Dodge** ${f.virus_dodge}% | **Crit** ${f.virus_crit}%`)
    .setImage(f.virus_image || null)
    .setFooter({ text: 'Virus Busting' });

  function fmtP(label, P, crit, dodged, cancelled, dmg, absorbed, rec) {
    const used = [...new Set(P.used || [])];
    const parts = [];
    if (P.supportEff && used.length === 2) parts.push(`**${used[0]}** → **${used[1]}**`);
    else if (used.length) parts.push(used.map((n) => `**${n}**`).join(' + '));
    else parts.push('did nothing');

    const extras = [];
    if (P.barrier) extras.push('🛡️ Barrier');
    if (P.def) extras.push(`🧱 DEF +${P.def}`);
    if (rec > 0) extras.push(`💚 +${rec}`);
    if (P.attackEff) {
      if (cancelled) extras.push('❌ cancelled');
      else if (dodged) extras.push('💨 dodged');
      else { extras.push(`💥 ${dmg}${crit ? ' _(CRIT!)_' : ''}${absorbed > 0 ? ` (DEF absorbed ${absorbed})` : ''}`); }
    }
    return `• ${label} ${parts.join(' ')}${extras.length ? ` → ${extras.join(' | ')}` : ''}`;
  }

  const lineP = fmtP(`<@${f.player_id}>`, PP, critP, dodgedP, cancelledByBarrierP, dmgPtoV, absorbedP, recP);
  const lineV = fmtP(`**${f.virus_name}**`, PV, critV, dodgedV, cancelledByBarrierV, dmgVtoP, absorbedV, recV);

  const header = `🎬 **Round Results**\n${lineP}\n${lineV}\n${hpLinePVE({ ...f, p_hp: php, v_hp: vhp })}`;
  await channel.send(outcome ? { content: `${header}\n\n${outcome}`, embeds: [embed] } : { content: `${header}\n\n➡️ Next round: submit with **/use** within **${ROUND_SECONDS}s**.`, embeds: [embed] });
}

// ---------- Slash commands & interactions ----------
client.on('interactionCreate', async (ix) => {
  try {
    // SHOP UI interactivity
    if (ix.isStringSelectMenu() && ix.customId.startsWith('shop:select:')) {
      const name = ix.values?.[0];
      const chip = getChip.get(name);
      if (!chip) return ix.reply({ ephemeral: true, content: 'That item no longer exists.' });

      const eff = readEffect(chip);
      const tag = chip.is_upgrade ? '🧩 Upgrade' : '🔹 Chip';
      const e = new EmbedBuilder()
        .setTitle(`${tag} — ${chip.name}`)
        .setDescription(`Cost: **${chip.zenny_cost}** ${zennyIcon()}\n${summarizeEffect(eff)}`);
      if (chip.image_url) e.setImage(chip.image_url);

      const act = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`shop:buy:1:${encodeURIComponent(chip.name)}`).setLabel('Buy ×1').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`shop:buy:5:${encodeURIComponent(chip.name)}`).setLabel('Buy ×5').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('shop:dismiss').setLabel('Close').setStyle(ButtonStyle.Secondary),
      );

      return ix.reply({ ephemeral: true, embeds: [e], components: [act] });
    }

    if (ix.isButton()) {
      if (ix.customId === 'shop:close') {
        return ix.update({ content: 'Shop closed.', embeds: [], components: [] });
      }
      if (ix.customId === 'shop:dismiss') {
        return ix.reply({ ephemeral: true, content: 'Closed.' });
      }
      if (ix.customId.startsWith('shop:prev:') || ix.customId.startsWith('shop:next:')) {
        const rows = listShop.all();
        const cur = Number(ix.customId.split(':').pop());
        const totalPages = Math.max(1, Math.ceil(rows.length / 25));
        const nextPage = ix.customId.startsWith('shop:prev:')
          ? Math.max(0, cur - 1)
          : Math.min(totalPages - 1, cur + 1);
        const ui = buildShopPage(rows, nextPage);
        return ix.update({ embeds: [ui.embed], components: ui.components });
      }
      if (ix.customId.startsWith('shop:buy:')) {
        const [, , qtyStr, encName] = ix.customId.split(':');
        const qty = Math.max(1, parseInt(qtyStr, 10) || 1);
        const name = decodeURIComponent(encName || '');
        const chip = getChip.get(name);
        if (!chip) return ix.reply({ ephemeral: true, content: 'That item no longer exists.' });

        const buyer = ensureNavi(ix.user.id);
        const total = (chip.zenny_cost || 0) * qty;
        if ((buyer.zenny ?? 0) < total) {
          return ix.reply({ ephemeral: true, content: `Not enough Zenny. Cost is **${total}** ${zennyIcon()}` });
        }
        addZenny.run(-total, ix.user.id);

        if (chip.is_upgrade) {
          const { after, deltaHP, deltaDodge, deltaCrit } = applyUpgrade(ix.user.id, chip, qty);
          const deltas = [
            deltaHP ? `HP **${after.max_hp}** (_${deltaHP >= 0 ? '+' : ''}${deltaHP}_)` : `HP **${after.max_hp}**`,
            `Dodge **${after.dodge}%**${deltaDodge ? ` (_${deltaDodge >= 0 ? '+' : ''}${deltaDodge}_)` : ''}`,
            `Crit **${after.crit}%**${deltaCrit ? ` (_${deltaCrit >= 0 ? '+' : ''}${deltaCrit}_)` : ''}`,
          ].join(', ');
          return ix.reply({ ephemeral: true, content: `🧩 Applied **${chip.name}** ×${qty}. New stats — ${deltas}.` });
        } else {
          const next = invAdd(ix.user.id, chip.name, qty);
          return ix.reply({ ephemeral: true, content: `👜 Purchased **${chip.name}** ×${qty}. You now own **${next}**.` });
        }
      }
    }

    // Autocomplete
    if (ix.isAutocomplete()) {
      const focused = ix.options.getFocused(true);
      const query = String(focused.value || '').toLowerCase();

      if (ix.commandName === 'chip_grant' || ix.commandName === 'chip_remove') {
        const names = listAllChipNames.all().map((r) => r.name);
        const filtered = names.filter((n) => n.toLowerCase().includes(query)).slice(0, 25);
        return ix.respond(filtered.map((n) => ({ name: n, value: n })));
      }

      if (ix.commandName === 'give_chip') {
        // suggest from sender's inventory
        const invNames = listInv.all(ix.user.id)
          .map((r) => r.chip_name)
          .filter(n => (getChip.get(n)?.is_upgrade ?? 0) === 0);
        const filtered = invNames.filter((n) => n.toLowerCase().includes(query)).slice(0, 25);
        return ix.respond(filtered.map((n) => ({ name: n, value: n })));
      }

      if (ix.commandName === 'use') {
        const invNames = listInv.all(ix.user.id)
          .map((r) => r.chip_name)
          .filter(n => (getChip.get(n)?.is_upgrade ?? 0) === 0);

        const items = invNames.map((n) => ({ n, eff: readEffect(getChip.get(n)) })).filter((x) => x.eff);
        let pool = invNames;
        if (focused.name === 'support') pool = items.filter((x) => isSupport(x.eff)).map((x) => x.n);
        if (focused.name === 'chip')    pool = items.filter((x) => !isSupport(x.eff)).map((x) => x.n);

        const filtered = pool.filter((n) => n.toLowerCase().includes(query)).slice(0, 25);
        return ix.respond(filtered.map((n) => ({ name: n, value: n })));
      }

      if (ix.commandName === 'virus_search') {
        try {
          const viruses = await loadViruses();
          const filtered = viruses
            .map(v => v.name)
            .filter(n => n.toLowerCase().includes(query))
            .slice(0, 25);
          return ix.respond(filtered.map((n) => ({ name: n, value: n })));
        } catch {
          return ix.respond([]);
        }
      }

      const names = listAllChipNames.all().map((r) => r.name);
      const filtered = names.filter((n) => n.toLowerCase().includes(query)).slice(0, 25);
      return ix.respond(filtered.map((n) => ({ name: n, value: n })));
    }

    if (!ix.isChatInputCommand()) return;

    if (ix.commandName === 'navi_register') {
      const row = ensureNavi(ix.user.id);
      return ix.reply({ content: `✅ Registered with **${row.max_hp} HP**, **${row.dodge}%** dodge, **${row.crit}%** crit.`, ephemeral: true });
    }

    if (ix.commandName === 'navi_upgrade') {
      if (MANUAL_UPGRADES_MODE === 'disabled') {
        return ix.reply({ content: 'Manual upgrades are disabled. Earn upgrades via wins or upgrade chips.', ephemeral: true });
      }
      const canAdmin =
        ix.member?.roles?.cache?.has?.(ADMIN_ROLE_ID) ||
        ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
        ix.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

      if (MANUAL_UPGRADES_MODE === 'admin' && !canAdmin) {
        return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
      }

      const stat = ix.options.getString('stat', true); // hp|dodge|crit
      if (!['hp', 'dodge', 'crit'].includes(stat)) {
        return ix.reply({ content: 'Stat must be one of: hp, dodge, crit.', ephemeral: true });
      }

      const row = ensureNavi(ix.user.id);
      let { max_hp, dodge, crit, wins, losses, upgrade_pts } = row;

      if (MANUAL_UPGRADES_MODE === 'points') {
        if ((upgrade_pts ?? 0) < 1) {
          return ix.reply({ content: 'You have no upgrade points. Win duels or defeat viruses to earn them!', ephemeral: true });
        }
      }

      const STEP = { hp: 10, dodge: 1, crit: 1 }[stat];
      const CAP = { hp: MAX_HP_CAP, dodge: MAX_DODGE_CAP, crit: MAX_CRIT_CAP }[stat];

      let before, after;
      if (stat === 'hp') { before = max_hp; max_hp = Math.min(CAP, max_hp + STEP); after = max_hp; }
      if (stat === 'dodge') { before = dodge; dodge = Math.min(CAP, dodge + STEP); after = dodge; }
      if (stat === 'crit') { before = crit; crit = Math.min(CAP, crit + STEP); after = crit; }

      if (after === before) {
        return ix.reply({ content: `Your ${stat.toUpperCase()} is already at the cap (${CAP}).`, ephemeral: true });
      }

      upsertNavi.run(ix.user.id, max_hp, dodge, crit, wins ?? 0, losses ?? 0, upgrade_pts ?? 0, row.zenny ?? 0);

      if (MANUAL_UPGRADES_MODE === 'points') {
        db.prepare(`UPDATE navis SET upgrade_pts = upgrade_pts - 1 WHERE user_id = ?`).run(ix.user.id);
        upgrade_pts = (upgrade_pts ?? 0) - 1;
      }

      return ix.reply(
        `⬆️ ${stat.toUpperCase()} +${STEP} (now **${after}**) — ` +
        (MANUAL_UPGRADES_MODE === 'points' ? `Points left: **${Math.max(0, upgrade_pts)}**` : `Admin-applied.`),
      );
    }

    if (ix.commandName === 'navi_stats') {
      const user = ix.options.getUser('user') || ix.user;
      const row = ensureNavi(user.id);

      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);
      let curHpNow = null, defNow = 0;

      if (f) {
        if (user.id === f.p1_id) { curHpNow = f.p1_hp; defNow = f.p1_def ?? 0; }
        if (user.id === f.p2_id) { curHpNow = f.p2_hp; defNow = f.p2_def ?? 0; }
      }
      if (pve && user.id === pve.player_id) {
        curHpNow = pve.p_hp; defNow = pve.p_def ?? defNow;
      }

      const hpStr = curHpNow != null ? `${row.max_hp} (current: ${curHpNow})` : `${row.max_hp}`;

      return ix.reply(
        `📊 **${user.username}** — HP ${hpStr} | Dodge ${row.dodge}% | Crit ${row.crit}% | ` +
        `Record: **${row.wins ?? 0}-${row.losses ?? 0}** | Points: **${row.upgrade_pts ?? 0}** | ` +
        `Zenny: **${row.zenny ?? 0} ${zennyIcon()}** | Def (temp): **${defNow}**`,
      );
    }

    if (ix.commandName === 'virus_search') {
      try {
        const name = ix.options.getString('name', true);
        const viruses = await loadViruses();
        const v = viruses.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
        if (!v) return ix.reply({ content: 'No matching virus/boss found.', ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`👾 ${v.name}${v.boss ? ' — ⭐ BOSS' : ''}`)
          .setDescription(`**HP** ${v.hp} | **Dodge** ${v.dodge}% | **Crit** ${v.crit}%\nZenny: ${v.zmin}-${v.zmax}`)
          .setImage(v.image_url || null)
          .setFooter({ text: 'Virus Search' });

        return ix.reply({ embeds: [embed] });
      } catch (e) {
        console.error('virus_search error:', e);
        return ix.reply({ content: 'Could not load Virus data. Check VIRUS_TSV_URL and sharing.', ephemeral: true });
      }
    }

    if (ix.commandName === 'virus_busting') {
      if (getFight.get(ix.channel.id) || getPVE.get(ix.channel.id)) {
        return ix.reply({ content: 'There is already a duel/encounter active in this channel.', ephemeral: true });
      }
      ensureNavi(ix.user.id);
      let viruses = [];
      try { viruses = await loadViruses(); } catch (e) {
        console.error('Virus TSV load failed:', e);
        return ix.reply('Could not load Virus data. Check VIRUS_TSV_URL and sharing settings.');
      }
      if (!viruses.length) return ix.reply('No viruses available. Populate your TSV and try again.');

      const pick = weightedPick(viruses);

      startPVE.run(
        ix.channel.id,
        ix.user.id,
        pick.name,
        pick.image_url || '',
        pick.hp, pick.dodge, pick.crit,
        pick.boss ? 1 : 0,
        JSON.stringify(pick.moves),
        pick.zmin || 0,
        pick.zmax || 0,
        ensureNavi(ix.user.id).max_hp,
        pick.hp,
        0, 0,
        '{}',
        '[]', '[]',
        null, null,
        now() + ROUND_SECONDS * 1000,
        0, 0, // v_def_total, v_def_streak
        Date.now(),
      );

      scheduleRoundTimer(ix.channel.id, () => resolvePVERound(ix.channel));

      const embed = new EmbedBuilder()
        .setTitle(`👾 Encounter: ${pick.name}`)
        .setDescription(`**HP** ${pick.hp} | **Dodge** ${pick.dodge}% | **Crit** ${pick.crit}%\n${pick.boss ? '⭐ **BOSS** (specials once each)' : 'Basic Virus'}`)
        .setImage(pick.image_url || null)
        .setFooter({ text: 'Virus Busting — simultaneous rounds' });

      await ix.reply({ content: `🐸 **Virus Busting started!** Submit your chip with **/use** within **${ROUND_SECONDS}s** each round.`, embeds: [embed] });
      return;
    }

    if (ix.commandName === 'duel') {
      const target = ix.options.getUser('opponent', true);

      if (getPVE.get(ix.channel.id)) {
        return ix.reply({ content: 'A Virus encounter is active here. Finish it before starting a duel.', ephemeral: true });
      }
      if (target.id === ix.user.id) {
        return ix.reply({ content: 'You can’t duel yourself.', ephemeral: true });
      }

      const existing = getFight.get(ix.channel.id);
      if (existing) return ix.reply({ content: 'A duel is already active in this channel.', ephemeral: true });

      ensureNavi(ix.user.id);
      ensureNavi(target.id);

      if (!target.bot || target.id === client.user.id) {
        if (!target.bot) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('accept_duel').setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('decline_duel').setLabel('Decline').setStyle(ButtonStyle.Danger),
          );
          const prompt = await ix.reply({
            content: `⚔️ <@${target.id}>, **${ix.user.username}** challenges you to a duel! Do you accept?`,
            components: [row],
            fetchReply: true,
          });
          try {
            const click = await prompt.awaitMessageComponent({
              componentType: ComponentType.Button,
              time: 60_000,
              filter: (i) => i.user.id === target.id && (i.customId === 'accept_duel' || i.customId === 'decline_duel'),
            });

            if (click.customId === 'decline_duel') {
              await click.update({ content: `❌ <@${target.id}> declined the duel.`, components: [] });
              return;
            }
            await click.update({ content: `✅ <@${target.id}> accepted! Setting up the duel...`, components: [] });
          } catch {
            await prompt.edit({ content: `⌛ Duel request to <@${target.id}> timed out.`, components: [] });
            return;
          }
        } else {
          await ix.reply(`🐸 **Scrimmage started!** ${ix.user} vs <@${client.user.id}> (simultaneous rounds).\nSubmit with **/use** within **${ROUND_SECONDS}s** each round. *(Scrimmage — no W/L or points)*`);
        }

        const p1 = ensureNavi(ix.user.id), p2 = ensureNavi(target.id);
        startFight.run(
          ix.channel.id,
          ix.user.id,
          target.id,
          p1.max_hp,
          p2.max_hp,
          0, 0,
          '{}', '{}',
          '[]', '[]',
          null, null,
          now() + ROUND_SECONDS * 1000,
          Date.now(),
        );
        scheduleRoundTimer(ix.channel.id, () => resolveDuelRound(ix.channel));

        await ix.followUp(`🎬 **Round started.** Submit your chip with **/use** within **${ROUND_SECONDS}s**.\n${hpLineDuel({ p1_id: ix.user.id, p2_id: target.id, p1_hp: p1.max_hp, p2_hp: p2.max_hp })}`);

        if (target.bot && target.id === client.user.id) {
          // Immediately lock a bot move for R1
          const f = getFight.get(ix.channel.id);
          const botAct = pickBotChipFor(f, false);
          if (botAct) {
            updFightRound.run(
              f.p1_hp, f.p2_hp,
              f.p1_def, f.p2_def,
              f.p1_counts_json, f.p2_counts_json,
              f.p1_special_used, f.p2_special_used,
              f.p1_action_json, JSON.stringify(botAct),
              f.round_deadline,
              ix.channel.id,
            );
            await ix.followUp('🤖 Bot locked its move.');
          }
        }
        return;
      }

      return ix.reply({ content: 'Pick a valid opponent (no external bots).', ephemeral: true });
    }

    if (ix.commandName === 'forfeit') {
      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);
      if (!f && !pve) return ix.reply({ content: 'No active duel/encounter in this channel.', ephemeral: true });

      if (f) {
        const winnerId = (ix.user.id === f.p1_id) ? f.p2_id : f.p1_id;
        const loserId = ix.user.id;
        setRecord.run(1, 0, winnerId);
        setRecord.run(0, 1, loserId);
        if (POINTS_PER_WIN > 0) addPoints.run(POINTS_PER_WIN, winnerId);
        endFight.run(ix.channel.id);
        clearRoundTimer(ix.channel.id);
        return ix.reply(`🏳️ <@${loserId}> forfeits. 🏆 <@${winnerId}> wins!`);
      }

      if (pve) {
        endPVE.run(ix.channel.id);
        clearRoundTimer(ix.channel.id);
        return ix.reply(`🏳️ You fled from **${pve.virus_name}**. No rewards or penalties.`);
      }
    }

    if (ix.commandName === 'duel_state') {
      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);
      if (!f && !pve) return ix.reply({ content: 'No active duel/encounter in this channel.', ephemeral: true });

      if (f) {
        const left = Math.max(0, Math.ceil((f.round_deadline - now()) / 1000));
        const a1 = decodeAction(f.p1_action_json);
        const a2 = decodeAction(f.p2_action_json);
        const lines = [
          `🧭 **Duel (Simultaneous)**`,
          `Round ends in: **${left}s**`,
          `P1: <@${f.p1_id}> — HP **${f.p1_hp}** | Pending: ${a1 ? '`LOCKED`' : '`—`'}`,
          `P2: <@${f.p2_id}> — HP **${f.p2_hp}** | Pending: ${a2 ? '`LOCKED`' : '`—`'}`,
        ];
        return ix.reply(lines.join('\n'));
      }

      if (pve) {
        const left = Math.max(0, Math.ceil((pve.round_deadline - now()) / 1000));
        const aP = decodeAction(pve.player_action_json);
        const aV = decodeAction(pve.virus_action_json);
        const embed = new EmbedBuilder()
          .setTitle(`👾 ${pve.virus_name}`)
          .setDescription(`**HP** ${pve.v_hp} / ${pve.virus_max_hp} | **Dodge** ${pve.virus_dodge}% | **Crit** ${pve.virus_crit}%`)
          .setImage(pve.virus_image || null)
          .setFooter({ text: 'Virus Busting' });
        const lines = [
          `🧭 **Virus Encounter (Simultaneous)**`,
          `Round ends in: **${left}s**`,
          `Player: <@${pve.player_id}> — HP **${pve.p_hp}** | Pending: ${aP ? '`LOCKED`' : '`—`'}`,
          `Virus: **${pve.virus_name}** — HP **${pve.v_hp}** | Pending: ${aV ? '`LOCKED`' : '`—`'}`,
        ];
        return ix.reply({ content: lines.join('\n'), embeds: [embed] });
      }
    }

    // Zenny views/transfers
    if (ix.commandName === 'zenny') {
      const user = ix.options.getUser('user') || ix.user;
      const row = ensureNavi(user.id);
      return ix.reply(`💰 **${user.username}** has **${row.zenny ?? 0}** ${zennyIcon()}`);
    }

    if (ix.commandName === 'give_zenny') {
      const to = ix.options.getUser('to', true);
      const amt = ix.options.getInteger('amount', true);
      if (to.id === ix.user.id) return ix.reply({ content: 'You cannot send Zenny to yourself.', ephemeral: true });
      if (amt <= 0) return ix.reply({ content: 'Amount must be positive.', ephemeral: true });
      const fromRow = ensureNavi(ix.user.id);
      ensureNavi(to.id);
      if ((fromRow.zenny ?? 0) < amt) {
        return ix.reply({ content: `Not enough Zenny. You have **${fromRow.zenny ?? 0}** ${zennyIcon()}`, ephemeral: true });
      }
      addZenny.run(-amt, ix.user.id);
      addZenny.run(+amt, to.id);
      return ix.reply(`✅ Transferred **${amt}** ${zennyIcon()} from <@${ix.user.id}> to <@${to.id}>.`);
    }

    // Chip transfers
    if (ix.commandName === 'give_chip') {
      const to = ix.options.getUser('to', true);
      const name = ix.options.getString('name', true);
      const qty = ix.options.getInteger('qty', true);

      if (to.id === ix.user.id) return ix.reply({ content: 'You cannot send chips to yourself.', ephemeral: true });
      if (qty <= 0) return ix.reply({ content: 'Quantity must be positive.', ephemeral: true });

      const chip = getChip.get(name);
      if (!chip) return ix.reply({ content: 'Unknown chip.', ephemeral: true });
      if (chip.is_upgrade) return ix.reply({ content: 'Upgrades aren’t inventory items — they apply on purchase and can’t be transferred.', ephemeral: true });

      const have = invGetQty(ix.user.id, name);
      if (have < qty) return ix.reply({ content: `You only have **${have}** of **${name}**.`, ephemeral: true });

      // move inventory
      invAdd(ix.user.id, name, -qty);
      ensureNavi(to.id);
      invAdd(to.id, name, +qty);

      return ix.reply(`📦 Transferred **${qty}× ${name}** from <@${ix.user.id}> to <@${to.id}>.`);
    }

    // Shop
    if (ix.commandName === 'shop') {
      const rows = listShop.all();
      if (!rows.length) return ix.reply('Shop is empty. Ask an admin to `/chips_reload`.');
      const ui = buildShopPage(rows, 0);
      return ix.reply({ ephemeral: true, embeds: [ui.embed], components: ui.components });
    }

    // Folder (hide upgrades)
    if (ix.commandName === 'folder') {
      const rows = listInv.all(ix.user.id).filter(r => (getChip.get(r.chip_name)?.is_upgrade ?? 0) === 0);
      if (!rows.length) return ix.reply('Your folder is empty. Use `/shop` to get chips.');
      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);
      let counts = {};
      if (f) {
        const mine = (ix.user.id === f.p1_id) ? f.p1_counts_json : (ix.user.id === f.p2_id ? f.p2_counts_json : '{}');
        counts = parseMap(mine);
      } else if (pve && ix.user.id === pve.player_id) {
        counts = parseMap(pve.p_counts_json);
      }
      const lines = rows.map((r) => {
        const used = counts[r.chip_name] || 0;
        const eff = readEffect(getChip.get(r.chip_name));
        const tag = isSpecial(eff) ? '⭐' : '•';
        return `${tag} **${r.chip_name}** — x${r.qty} ${used ? `(used ${used}/${MAX_PER_CHIP} this battle)` : ''}`;
      });
      return ix.reply(`📂 **Your Folder**\n${lines.join('\n')}`);
    }

    // Unified /use
    if (ix.commandName === 'use') {
      const chipName = ix.options.getString('chip', true);
      const supportName = ix.options.getString('support');

      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);

      let context = null;
      if (f && (ix.user.id === f.p1_id || ix.user.id === f.p2_id)) context = 'duel';
      else if (pve && ix.user.id === pve.player_id) context = 'pve';
      else return ix.reply({ content: 'No active battle for you in this channel.', ephemeral: true });

      const haveChip = invGetQty(ix.user.id, chipName);
      if (haveChip <= 0) return ix.reply({ content: `You don’t own **${chipName}**.`, ephemeral: true });

      let useSupport = false;
      if (supportName) {
        const haveSupport = invGetQty(ix.user.id, supportName);
        if (haveSupport <= 0) return ix.reply({ content: `You don’t own **${supportName}**.`, ephemeral: true });
        const sEff = readEffect(getChip.get(supportName));
        const cEff = readEffect(getChip.get(chipName));
        if (!isSupport(sEff)) return ix.reply({ content: `**${supportName}** is not a Support chip.`, ephemeral: true });
        if (isSupport(cEff)) return ix.reply({ content: `Your primary chip must not be Support.`, ephemeral: true });
        useSupport = true;
      }

      function canUseChip(countsJson, specialsJson, name) {
        const counts = parseMap(countsJson);
        const specials = new Set(parseList(specialsJson));
        const row = getChip.get(name);
        if (!row) return { ok: false, reason: 'Unknown chip.' };
        if (row.is_upgrade) return { ok: false, reason: 'Upgrades are applied on purchase and cannot be used in battle.' };
        const eff = readEffect(row);
        if ((counts[name] || 0) >= MAX_PER_CHIP) return { ok: false, reason: `**${name}** is exhausted (**${MAX_PER_CHIP}/${MAX_PER_CHIP}**) this battle.` };
        if (isSpecial(eff) && specials.has(name)) return { ok: false, reason: `You’ve already used **${name}** (special) this battle.` };
        return { ok: true, row, eff };
      }

      if (context === 'duel') {
        const already = ix.user.id === f.p1_id ? f.p1_action_json : f.p2_action_json;
        if (already) return ix.reply({ content: 'You already locked your action this round.', ephemeral: true });

        const mineCounts = (ix.user.id === f.p1_id) ? f.p1_counts_json : f.p2_counts_json;
        const mineSpecs = (ix.user.id === f.p1_id) ? f.p1_special_used : f.p2_special_used;

        const chkC = canUseChip(mineCounts, mineSpecs, chipName);
        if (!chkC.ok) return ix.reply({ content: chkC.reason, ephemeral: true });

        let actJson;
        if (useSupport) {
          const chkS = canUseChip(mineCounts, mineSpecs, supportName);
          if (!chkS.ok) return ix.reply({ content: chkS.reason, ephemeral: true });
          invAdd(ix.user.id, supportName, -1);
          invAdd(ix.user.id, chipName, -1);
          actJson = actionSupport(supportName, chipName);
        } else {
          invAdd(ix.user.id, chipName, -1);
          actJson = actionChip(chipName);
        }

        if (ix.user.id === f.p1_id) {
          updFightRound.run(f.p1_hp, f.p2_hp, f.p1_def, f.p2_def, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, actJson, f.p2_action_json, f.round_deadline, ix.channel.id);
        } else {
          updFightRound.run(f.p1_hp, f.p2_hp, f.p1_def, f.p2_def, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, f.p1_action_json, actJson, f.round_deadline, ix.channel.id);
        }
        await ix.reply(`🔒 Locked **${useSupport ? `${supportName} → ${chipName}` : chipName}** for this round.`);

        // NEW: instant-resolve vs ToadMan (bot) — lock bot move immediately if needed
        let ff = getFight.get(ix.channel.id);
        const myIsP1 = ix.user.id === ff.p1_id;
        const oppId = myIsP1 ? ff.p2_id : ff.p1_id;
        const oppActionLocked = myIsP1 ? !!ff.p2_action_json : !!ff.p1_action_json;

        if (oppId === client.user.id && !oppActionLocked) {
          const botAct = pickBotChipFor(ff, !myIsP1 ? true : false);
          if (botAct) {
            if (myIsP1) {
              updFightRound.run(ff.p1_hp, ff.p2_hp, ff.p1_def, ff.p2_def, ff.p1_counts_json, ff.p2_counts_json, ff.p1_special_used, ff.p2_special_used, ff.p1_action_json, JSON.stringify(botAct), ff.round_deadline, ix.channel.id);
            } else {
              updFightRound.run(ff.p1_hp, ff.p2_hp, ff.p1_def, ff.p2_def, ff.p1_counts_json, ff.p2_counts_json, ff.p1_special_used, ff.p2_special_used, JSON.stringify(botAct), ff.p2_action_json, ff.round_deadline, ix.channel.id);
            }
            ff = getFight.get(ix.channel.id);
          }
        }

        if (ff.p1_action_json && ff.p2_action_json) {
          clearRoundTimer(ix.channel.id);
          await resolveDuelRound(ix.channel);
        }
        return;
      } else {
        // PVE
        if (pve.player_action_json) return ix.reply({ content: 'You already locked your action this round.', ephemeral: true });
        const chkC = canUseChip(pve.p_counts_json, pve.p_special_used, chipName);
        if (!chkC.ok) return ix.reply({ content: chkC.reason, ephemeral: true });

        let actJson;
        if (useSupport) {
          const chkS = canUseChip(pve.p_counts_json, pve.p_special_used, supportName);
          if (!chkS.ok) return ix.reply({ content: chkS.reason, ephemeral: true });
          invAdd(ix.user.id, supportName, -1);
          invAdd(ix.user.id, chipName, -1);
          actJson = actionSupport(supportName, chipName);
        } else {
          invAdd(ix.user.id, chipName, -1);
          actJson = actionChip(chipName);
        }

        updPVE.run(pve.p_hp, pve.v_hp, pve.p_def, pve.v_def, pve.p_counts_json, pve.p_special_used, pve.v_special_used, actJson, pve.virus_action_json, pve.round_deadline, pve.v_def_total, pve.v_def_streak, ix.channel.id);
        await ix.reply(`🔒 Locked **${useSupport ? `${supportName} → ${chipName}` : chipName}** for this round.`);
        const fp = getPVE.get(ix.channel.id);
        if (fp.player_action_json) {
          if (!fp.virus_action_json) {
            const mv = pickVirusMove(fp);
            if (mv) updPVE.run(fp.p_hp, fp.v_hp, fp.p_def, fp.v_def, fp.p_counts_json, fp.p_special_used, fp.v_special_used, fp.player_action_json, JSON.stringify({ type: 'chip', name: mv.name || mv.label || 'Move' }), fp.round_deadline, fp.v_def_total, fp.v_def_streak, ix.channel.id);
          }
          clearRoundTimer(ix.channel.id);
          await resolvePVERound(ix.channel);
        }
        return;
      }
    }

    // Admin: chips_reload
    if (ix.commandName === 'chips_reload') {
      if (!isAdmin(ix)) return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
      try {
        await reloadChipsFromTSV();
        return ix.reply('✅ Chip list reloaded from TSV.');
      } catch (e) {
        console.error(e);
        return ix.reply({ content: 'Failed to reload chips. Check CHIP_TSV_URL and sharing settings.', ephemeral: true });
      }
    }

    // Admin: chip_grant / chip_remove
    if (ix.commandName === 'chip_grant' || ix.commandName === 'chip_remove') {
      if (!isAdmin(ix)) return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
      const user = ix.options.getUser('user', true);
      const name = ix.options.getString('name', true);
      const qty = ix.options.getInteger('qty', true);
      const chip = getChip.get(name);
      if (!chip) return ix.reply({ content: 'Unknown chip.', ephemeral: true });

      if (chip.is_upgrade) {
        if (ix.commandName === 'chip_grant') {
          const { after, deltaHP, deltaDodge, deltaCrit } = applyUpgrade(user.id, chip, qty);
          const deltas = [
            deltaHP ? `HP **${after.max_hp}** (_${deltaHP >= 0 ? '+' : ''}${deltaHP}_)` : `HP **${after.max_hp}**`,
            `Dodge **${after.dodge}%**${deltaDodge ? ` (_${deltaDodge >= 0 ? '+' : ''}${deltaDodge}_)` : ''}`,
            `Crit **${after.crit}%**${deltaCrit ? ` (_${deltaCrit >= 0 ? '+' : ''}${deltaCrit}_)` : ''}`,
          ].join(', ');
          return ix.reply(`🧩 Applied upgrade **${chip.name}** ×${qty} to <@${user.id}>. New stats — ${deltas}.`);
        } else {
          return ix.reply({ content: 'Upgrades aren’t inventory items and can’t be removed. Use `/stat_override` if you need to adjust stats.', ephemeral: true });
        }
      }

      const delta = ix.commandName === 'chip_grant' ? qty : -qty;
      const next = invAdd(user.id, name, delta);
      return ix.reply(`🛠️ ${ix.commandName === 'chip_grant' ? 'Granted' : 'Removed'} **${Math.abs(delta)}** of **${name}** for <@${user.id}>. They now have **${next}**.`);
    }

    // Admin: stat_override
    if (ix.commandName === 'stat_override') {
      if (!isAdmin(ix)) return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });

      const user  = ix.options.getUser('user', true);
      const stat  = ix.options.getString('stat', true);
      const value = ix.options.getInteger('value', true);

      ensureNavi(user.id);
      const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

      if (stat === 'hp')         updHP.run(clamp(value, 1, MAX_HP_CAP), user.id);
      else if (stat === 'dodge') updDodge.run(clamp(value, 0, MAX_DODGE_CAP), user.id);
      else if (stat === 'crit')  updCrit.run(clamp(value, 0, MAX_CRIT_CAP), user.id);
      else if (stat === 'wins')  updWins.run(Math.max(0, value), user.id);
      else if (stat === 'losses')updLosses.run(Math.max(0, value), user.id);
      else if (stat === 'points')updPts.run(Math.max(0, value), user.id);
      else return ix.reply({ content: 'Unknown stat.', ephemeral: true });

      const r = ensureNavi(user.id);
      return ix.reply({
        content:
          `✅ Updated <@${user.id}> — ` +
          `HP **${r.max_hp}**, Dodge **${r.dodge}%**, Crit **${r.crit}%**, ` +
          `Record **${r.wins}-${r.losses}**, Points **${r.upgrade_pts}**.`,
        ephemeral: true
      });
    }

    if (ix.commandName === 'zenny_override') {
      if (!isAdmin(ix)) return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
      const user = ix.options.getUser('user', true);
      const amt  = ix.options.getInteger('amount', true);
      ensureNavi(user.id);
      addZenny.run(amt, user.id);
      const cur = ensureNavi(user.id);
      return ix.reply({ content: `✅ Updated Zenny for <@${user.id}>: **${cur.zenny}** ${zennyIcon()} (Δ ${amt >= 0 ? '+' : ''}${amt})`, ephemeral: true });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try { await ix.reply({ content: 'Something went wrong. Check logs.', ephemeral: true }); } catch {}
  }
});

// ---------- Boot ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
});
client.login(process.env.DISCORD_TOKEN);
