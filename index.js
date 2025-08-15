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
// Missions TSV URL (Thing 3)
const MISSIONS_TSV_URL = process.env.MISSIONS_TSV_URL || '';

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

// ---------- Thing 3 Config ----------
const REGIONS = ['ACDC','SciLab','Yoka','Beach','Sharo','YumLand','UnderNet'];
const ZONES = ['Area 1','Area 2','Area 3']; // label only; store internally as 1|2|3

// Dynamic upgrade price steps (per purchase)
const HP_MEMORY_COST_STEP      = parseInt(process.env.HP_MEMORY_COST_STEP      || '500', 10);
const DATA_RECONFIG_COST_STEP  = parseInt(process.env.DATA_RECONFIG_COST_STEP  || '500', 10);
const LUCKY_DATA_COST_STEP     = parseInt(process.env.LUCKY_DATA_COST_STEP     || '500', 10);

// Stat upgrade point costs (manual /navi_upgrade)
const CRIT_DODGE_COST   = parseInt(process.env.CRIT_DODGE_COST   || '5', 10);  // points for +1% crit/dodge
const HP_POINTS_PER_STEP = parseInt(process.env.HP_POINTS_PER_STEP || '50', 10); // points per +10 HP
const HP_STEP_SIZE       = parseInt(process.env.HP_STEP_SIZE       || '10', 10); // default step remains +10 HP

// 33% virus chip drop (ENV override-able 0..1)
const VIRUS_CHIP_DROP_PCT = Number(process.env.VIRUS_CHIP_DROP_PCT ?? 0.33);

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

    // Chip economy & usage
    new SlashCommandBuilder().setName('shop').setDescription('View the chip shop'),
    new SlashCommandBuilder().setName('folder').setDescription('View your owned chips'),

    new SlashCommandBuilder()
      .setName('give_chip')
      .setDescription('Give a chip from your folder to another player')
      .addUserOption((o) => o.setName('to').setDescription('Recipient').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('qty').setDescription('Quantity (default 1)').setRequired(false).setMinValue(1)),

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

    // ---------- Thing 3 New Commands ----------
    new SlashCommandBuilder()
      .setName('metroline')
      .setDescription('Travel to a region/zone')
      .addStringOption(o => o.setName('region').setDescription('Region').setRequired(true).addChoices(...REGIONS.map(r=>({name:r, value:r}))))
      .addIntegerOption(o => o.setName('zone').setDescription('Zone (1-3)').setRequired(true).setMinValue(1).setMaxValue(3)),

    new SlashCommandBuilder()
      .setName('bbs_mission')
      .setDescription('Pull a mission for your current region'),
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
  is_upgrade INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 1 -- 1 = appears in /shop; 0 = hidden (e.g., PVE drop only)
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  chip_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chip_name),
  FOREIGN KEY (chip_name) REFERENCES chips(name) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Thing 3: Player location (region/zone)
CREATE TABLE IF NOT EXISTS locations (
  user_id TEXT PRIMARY KEY,
  region  TEXT NOT NULL DEFAULT 'ACDC',
  zone    INTEGER NOT NULL DEFAULT 1
);

-- Thing 3: Per-player counts for dynamic upgrade pricing
CREATE TABLE IF NOT EXISTS upgrade_purchases (
  user_id TEXT NOT NULL,
  upgrade_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, upgrade_name)
);

-- Thing 3: Active missions (one per player)
CREATE TABLE IF NOT EXISTS missions_active (
  user_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  region TEXT NOT NULL,
  target_chip TEXT,
  target_boss TEXT,
  reward_zenny INTEGER NOT NULL DEFAULT 0,
  keep_chip INTEGER NOT NULL DEFAULT 1, -- 1 keep, 0 surrender for zenny
  status TEXT NOT NULL DEFAULT 'active', -- active|completed
  assigned_at INTEGER NOT NULL
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
try { db.exec(`ALTER TABLE chips ADD COLUMN stock INTEGER NOT NULL DEFAULT 1;`); } catch {}

// --- Status effect storage (stun / poison / holy) ---
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_stunned INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_stunned INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN p_stunned  INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN v_stunned  INTEGER NOT NULL DEFAULT 0;`); } catch {}

try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_poison_json TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_poison_json TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN p_poison_json  TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN v_poison_json  TEXT NOT NULL DEFAULT '[]';`); } catch {}

try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_holy_json TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_holy_json TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN p_holy_json  TEXT NOT NULL DEFAULT '[]';`); } catch {}
try { db.exec(`ALTER TABLE pve_state  ADD COLUMN v_holy_json  TEXT NOT NULL DEFAULT '[]';`); } catch {}

// Prepared statements
const getNavi = db.prepare(`SELECT * FROM navis WHERE user_id=?`);
const upsertNavi = db.prepare(
  `INSERT INTO navis (user_id,max_hp,dodge,crit,wins,losses,upgrade_pts,zenny) VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET
     max_hp=excluded.max_hp,
     dodge=excluded.dodge,
     crit=excluded.crit,
     wins=excluded.wins,
     losses=excluded.losses,
     upgrade_pts=excluded.upgrade_pts,
     zenny=excluded.zenny`
);
function ensureNavi(uid) {
  const row = getNavi.get(uid);
  if (row) return row;
  upsertNavi.run(uid, 250, 20, 5, 0, 0, 0, 0);
  return { user_id: uid, max_hp: 250, dodge: 20, crit: 5, wins: 0, losses: 0, upgrade_pts: 0, zenny: 0 };
}

const setRecord = db.prepare(`UPDATE navis SET wins = wins + ?, losses = losses + ? WHERE user_id = ?`);
const addPoints = db.prepare(`UPDATE navis SET upgrade_pts = upgrade_pts + ? WHERE user_id = ?`);
const addZenny  = db.prepare(`UPDATE navis SET zenny = zenny + ? WHERE user_id = ?`);
const setZenny  = db.prepare(`UPDATE navis SET zenny = ? WHERE user_id = ?`);
const updHP     = db.prepare(`UPDATE navis SET max_hp=? WHERE user_id=?`);
const updDodge  = db.prepare(`UPDATE navis SET dodge=? WHERE user_id=?`);
const updCrit   = db.prepare(`UPDATE navis SET crit=? WHERE user_id=?`);
const updWins   = db.prepare(`UPDATE navis SET wins=? WHERE user_id=?`);
const updLosses = db.prepare(`UPDATE navis SET losses=? WHERE user_id=?`);
const updPts    = db.prepare(`UPDATE navis SET upgrade_pts=? WHERE user_id=?`);

const getFight = db.prepare(`SELECT * FROM duel_state WHERE channel_id=?`);
const startFight = db.prepare(
  `INSERT INTO duel_state
    (channel_id,p1_id,p2_id,p1_hp,p2_hp,p1_def,p2_def,p1_counts_json,p2_counts_json,p1_special_used,p2_special_used,p1_action_json,p2_action_json,round_deadline,started_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const updFightRound = db.prepare(
  `UPDATE duel_state
     SET p1_hp=?, p2_hp=?,
         p1_def=?, p2_def=?,
         p1_counts_json=?, p2_counts_json=?,
         p1_special_used=?, p2_special_used=?,
         p1_action_json=?, p2_action_json=?,
         round_deadline=?
   WHERE channel_id=?`
);
const endFight = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

const getPVE = db.prepare(`SELECT * FROM pve_state WHERE channel_id=?`);
const startPVE = db.prepare(
  `INSERT INTO pve_state (
    channel_id, player_id, virus_name, virus_image, virus_max_hp, virus_dodge, virus_crit, virus_is_boss, virus_moves_json, virus_zmin, virus_zmax,
    p_hp, v_hp, p_def, v_def, p_counts_json, p_special_used, v_special_used, player_action_json, virus_action_json, round_deadline, v_def_total, v_def_streak, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const updPVE = db.prepare(
  `UPDATE pve_state
     SET p_hp=?, v_hp=?,
         p_def=?, v_def=?,
         p_counts_json=?, p_special_used=?, v_special_used=?,
         player_action_json=?, virus_action_json=?,
         round_deadline=?,
         v_def_total=?, v_def_streak=?
   WHERE channel_id=?`
);
const endPVE = db.prepare(`DELETE FROM pve_state WHERE channel_id=?`);

// Chips & inventory
const getChip = db.prepare(`SELECT * FROM chips WHERE name=?`);
const listChips = db.prepare(`SELECT * FROM chips WHERE is_upgrade=0 ORDER BY name COLLATE NOCASE ASC`);
const listAllChipNames = db.prepare(`SELECT name FROM chips ORDER BY name COLLATE NOCASE ASC`);
const listShop = db.prepare(`SELECT * FROM chips WHERE stock=1 ORDER BY is_upgrade ASC, zenny_cost ASC, name COLLATE NOCASE ASC`);
const upsertChip = db.prepare(
  `INSERT INTO chips (name,image_url,effect_json,zenny_cost,is_upgrade,stock) VALUES (?,?,?,?,?,?)
   ON CONFLICT(name) DO UPDATE SET image_url=excluded.image_url,effect_json=excluded.effect_json,zenny_cost=excluded.zenny_cost,is_upgrade=excluded.is_upgrade,stock=excluded.stock`
);
const getInv = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_name=?`);
const setInv = db.prepare(
  `INSERT INTO inventory (user_id,chip_name,qty) VALUES (?,?,?)
   ON CONFLICT(user_id,chip_name) DO UPDATE SET qty=excluded.qty`
);
const listInv = db.prepare(`SELECT chip_name, qty FROM inventory WHERE user_id=? AND qty>0 ORDER BY chip_name COLLATE NOCASE ASC`);

// Thing 3 prepared statements
// Locations
const getLoc = db.prepare(`SELECT region, zone FROM locations WHERE user_id=?`);
const setLoc = db.prepare(`
INSERT INTO locations (user_id,region,zone) VALUES (?,?,?)
ON CONFLICT(user_id) DO UPDATE SET region=excluded.region, zone=excluded.zone
`);
function ensureLoc(uid) {
  const r = getLoc.get(uid);
  if (r) return r;
  setLoc.run(uid, 'ACDC', 1);
  return { region: 'ACDC', zone: 1 };
}

// Upgrade purchases
const getUpgCount = db.prepare(`SELECT count FROM upgrade_purchases WHERE user_id=? AND upgrade_name=?`);
const bumpUpgCount = db.prepare(`
INSERT INTO upgrade_purchases (user_id, upgrade_name, count) VALUES (?,?,1)
ON CONFLICT(user_id, upgrade_name) DO UPDATE SET count = count + 1
`);

// Missions
const getActiveMission   = db.prepare(`SELECT * FROM missions_active WHERE user_id=? AND status='active'`);
const setActiveMission   = db.prepare(`
INSERT INTO missions_active (user_id, mission_id, region, target_chip, target_boss, reward_zenny, keep_chip, status, assigned_at)
VALUES (?,?,?,?,?,?,?, 'active', ?)
ON CONFLICT(user_id) DO UPDATE SET mission_id=excluded.mission_id, region=excluded.region, target_chip=excluded.target_chip, target_boss=excluded.target_boss, reward_zenny=excluded.reward_zenny, keep_chip=excluded.keep_chip, status='active', assigned_at=excluded.assigned_at
`);
const completeMission    = db.prepare(`UPDATE missions_active SET status='completed' WHERE user_id=? AND mission_id=?`);

// Helpers
const normalize = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '');
const parseList = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const parseMap  = (s) => { try { const v = JSON.parse(s ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const parseMoves= (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const tryParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const now = () => Date.now();

// NEW: parse chip drop lists like "A, B | C / D"
function parseChipDrops(s) {
  return String(s || '')
    .split(/[,\|/]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

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

    // Thing 3: region/zone/chip_drop (supports multiple)
    const region  = (obj.region || '').trim() || null;
    const zoneNum = parseInt(obj.zone || obj.area || '0', 10) || 0; // 1..3
    const rawDrop = (obj.chip_drop || obj.chipdrop || '').trim();
    const chipDrop = rawDrop || '';
    const chipDrops = parseChipDrops(rawDrop);

    rows.push({
      name,
      image_url: obj.image_url || '',
      hp, dodge, crit,
      moves,
      stat_points: sp,
      boss: isBoss,
      weight: 0,
      zmin, zmax,
      region,
      zone: zoneNum,
      chip_drop: chipDrop,      // original single-value field kept
      chip_drops: chipDrops,    // new: array of possible drops
    });
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
      const inStock = parseBool(r.stock ?? r.in_stock ?? r.available);

      upsertChip.run(name, img, effect_json, cost, isUp ? 1 : 0, inStock ? 1 : 0);
    }
  });
  upserts(rows);

  ChipsCache.ts = Date.now();
  ChipsCache.rows = rows;
}

// ---------- Missions TSV Loader (Thing 3) ----------
const MissionsCache = { ts: 0, rows: [] };

async function loadMissions(force=false) {
  const FRESH_MS = 1000 * 60 * 5;
  if (!force && MissionsCache.rows.length && (Date.now() - MissionsCache.ts) < FRESH_MS) return MissionsCache.rows;
  if (!MISSIONS_TSV_URL) return [];
  const res = await fetch(MISSIONS_TSV_URL);
  if (!res.ok) throw new Error(`Missions TSV fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split('\t').map(HEADER_MAP);
  const out = [];
  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split('\t');
    const obj = {}; headers.forEach((h,idx)=>{ obj[h]=cols[idx]; });
    const mission_id = (obj.mission_id || obj.id || '').trim();
    const region = (obj.region || '').trim();
    if (!mission_id || !region) continue;
    const target_chip = (obj.target_chip || '').trim() || null;
    const target_boss = (obj.target_boss || '').trim() || null;
    const reward_zenny = parseInt(obj.reward_zenny || obj.reward || '0',10) || 0;
    const keep_chip = ['1','true','yes','y'].includes(String(obj.keep_chip||'').toLowerCase()) ? 1 : 0;
    out.push({ mission_id, region, target_chip, target_boss, reward_zenny, keep_chip });
  }
  MissionsCache.rows = out;
  MissionsCache.ts = Date.now();
  return out;
}

// ---------- Combat helpers ----------
function extractKinds(effect) {
  if (!effect) return [];
  const k = effect.kinds || effect.kind || '';
  if (Array.isArray(k)) return k.map((x) => String(x).toLowerCase());
  return String(k || '').toLowerCase().split(/[+,\s/]+/).filter(Boolean);
}
function isAttack(effect) { const kinds = extractKinds(effect); return kinds.includes('attack') || kinds.includes('break'); }
function isBreak(effect)  { const kinds = extractKinds(effect); return kinds.includes('break'); }
function isSupport(effect){ return extractKinds(effect).includes('support'); }
function isBarrier(effect){ return extractKinds(effect).includes('barrier'); }
function isDefense(effect){ return extractKinds(effect).includes('defense'); }
function isRecovery(effect){ return extractKinds(effect).includes('recovery'); }
function isSpecial(effect) { return !!effect?.special; }
// NEW kinds
function isParalyze(effect){ return extractKinds(effect).includes('paralyze'); }
function isPoison(effect){   return extractKinds(effect).includes('poison'); }
function isHoly(effect){     return extractKinds(effect).includes('holy'); }
function isRepair(effect){   return extractKinds(effect).includes('repair'); }

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

// Apply an upgrade row immediately to a user (qty supported)
function applyUpgrade(userId, chipRow, qty = 1) {
  const eff = readEffect(chipRow);
  const stat = String(eff?.stat || '').toLowerCase();
  const step = Number.isFinite(eff?.step) ? eff.step : 1;
  const amount = step * Math.max(1, qty);

  const cur = ensureNavi(userId);
  let { max_hp, dodge, crit } = cur;

  if (stat === 'hp')    max_hp = Math.min(MAX_HP_CAP,    max_hp + amount);
  if (stat === 'dodge') dodge  = Math.min(MAX_DODGE_CAP, dodge  + amount);
  if (stat === 'crit')  crit   = Math.min(MAX_CRIT_CAP,  crit   + amount);

  upsertNavi.run(userId, max_hp, dodge, crit, cur.wins ?? 0, cur.losses ?? 0, cur.upgrade_pts ?? 0, cur.zenny ?? 0);
  return ensureNavi(userId);
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
    if ((counts[r.name] || 0) >= MAX_PER_CHIP) return false;
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
  return kinds.includes('attack') || kinds.includes('break') || kinds.includes('recovery');
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
    // fall through
  }

  // If total defense at or above cap → avoid defense
  if (totalDef >= VIRUS_DEFENSE_CAP_TOTAL) {
    const nonDef = notSpent.filter((m) => !isDefLikeMove(m));
    if (nonDef.length) return nonDef[Math.floor(Math.random() * nonDef.length)];
    return notSpent[Math.floor(Math.random() * notSpent.length)];
  }

  return notSpent[Math.floor(Math.random() * notSpent.length)];
}

// ---------- UI helpers for Shop ----------
function summarizeEffect(e) {
  if (!e) return '—';
  const bits = [];
  const kinds = extractKinds(e);
  if (kinds.length) bits.push(`Kinds: ${kinds.join(', ')}`);
  if (Number.isFinite(e.dmg)) bits.push(`DMG: **${e.dmg}**`);
  if (Number.isFinite(e.def)) bits.push(`DEF: **${e.def}**`);
  const heal = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : null);
  if (heal != null) bits.push(`Heal: **${heal}**`);
  if (e.special) bits.push('⭐ Special (once per battle)');
  // New kind tips
  if (kinds.includes('paralyze')) bits.push('⚡ Paralyze (stuns next round)');
  if (kinds.includes('poison'))   bits.push('☠️ Poison (3 rounds)');
  if (kinds.includes('holy'))     bits.push('✨ Holy regen (3 rounds)');
  if (kinds.includes('repair'))   bits.push('🔧 Repair (cleanse ticks)');
  return bits.join(' • ') || '—';
}
function buildShopPage(rows, page = 0, userIdForDynamicCost=null) {
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

// Thing 3: Dynamic upgrade pricing
const DYN_UPGRADES = new Map([
  ['HP Memory', HP_MEMORY_COST_STEP],
  ['Data Reconfig', DATA_RECONFIG_COST_STEP],
  ['Lucky Data', LUCKY_DATA_COST_STEP],
]);

function dynamicUpgradeCostFor(userId, chipRow) {
  if (!chipRow?.is_upgrade) return chipRow?.zenny_cost || 0;
  const step = DYN_UPGRADES.get(chipRow.name);
  if (!step) return chipRow.zenny_cost || 0;
  const r = getUpgCount.get(userId, chipRow.name);
  const n = r ? (r.count || 0) : 0;
  return Math.max(0, (chipRow.zenny_cost || 0) + (n * step));
}

// Sum arithmetic progression for buying multiple
function dynamicUpgradeTotalFor(userId, chipRow, qty) {
  const step = DYN_UPGRADES.get(chipRow.name);
  if (!step) return (chipRow.zenny_cost || 0) * qty;
  const r = getUpgCount.get(userId, chipRow.name);
  const n0 = r ? (r.count || 0) : 0;
  const base = chipRow.zenny_cost || 0;
  return qty * base + step * ((qty * (2*n0 + (qty-1))) / 2);
}

// ---------- Status tick helpers ----------
// POISON: list of at most 1 item: { dmg:number, ticks:number }
function parsePois(s) {
  const arr = parseList(s);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => (x && typeof x === 'object') ? { dmg: (x.dmg|0), ticks: (x.ticks|0) } : null)
    .filter(x => x && x.dmg > 0 && x.ticks > 0)
    .slice(0,1);
}
// HOLY: list of at most 1 item: { heal:number, ticks:number }
function parseHoly(s) {
  const arr = parseList(s);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => (x && typeof x === 'object') ? { heal: (x.heal|0), ticks: (x.ticks|0) } : null)
    .filter(x => x && x.heal > 0 && x.ticks > 0)
    .slice(0,1);
}

// Replace (no stacking): latest amount, 3 ticks
function replacePoison(_list, dmg) { const n = Math.max(0, Math.floor(dmg)); return n > 0 ? [{ dmg: n, ticks: 3 }] : []; }
function replaceHoly(_list, heal)  { const n = Math.max(0, Math.floor(heal)); return n > 0 ? [{ heal: n, ticks: 3 }] : []; }

// Consume one tick & return total + next state
function tickPois(list) {
  if (!list.length) return { total: 0, next: [] };
  const p = list[0];
  const total = Math.max(0, p.dmg|0);
  const left = (p.ticks|0) - 1;
  return { total, next: left > 0 ? [{ dmg: p.dmg|0, ticks: left }] : [] };
}
function tickHoly(list) {
  if (!list.length) return { total: 0, next: [] };
  const h = list[0];
  const total = Math.max(0, h.heal|0);
  const left = (h.ticks|0) - 1;
  return { total, next: left > 0 ? [{ heal: h.heal|0, ticks: left }] : [] };
}

// ---------- Round resolution (Duels) ----------
async function resolveDuelRound(channel) {
  const f0 = getFight.get(channel.id);
  if (!f0) return;

  // Respect stun: don't lock bot actions if stunned
  let f = f0;
  if (!f.p2_action_json && f.p2_id === client.user.id && !(f.p2_stunned > 0)) {
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
  if (!f.p1_action_json && f.p1_id === client.user.id && !(f.p1_stunned > 0)) {
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

  // Status at start of round
  const p1WasStunned = (f.p1_stunned || 0) > 0;
  const p2WasStunned = (f.p2_stunned || 0) > 0;

  const p1Pois = parsePois(f.p1_poison_json);
  const p2Pois = parsePois(f.p2_poison_json);
  const p1Holy = parseHoly(f.p1_holy_json);
  const p2Holy = parseHoly(f.p2_holy_json);

  let nextPoisP1 = p1Pois, nextPoisP2 = p2Pois;
  let nextHolyP1 = p1Holy, nextHolyP2 = p2Holy;

  const A1raw = decodeAction(f.p1_action_json);
  const A2raw = decodeAction(f.p2_action_json);

  // If neither acted and deadline passed, reschedule another wait
  if (!A1raw && !A2raw) {
    const nextDeadline = now() + ROUND_SECONDS * 1000;
    updFightRound.run(f.p1_hp, f.p2_hp, 0, 0, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, null, null, nextDeadline, channel.id);
    scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));
    await channel.send(`⏳ New round started. Submit your chips with **/use** within **${ROUND_SECONDS}s**.\n${hpLineDuel(getFight.get(channel.id))}`);
    return;
  }

  // Build intents, stunned => null action
  function rowAndEff(name) {
    const r = getChip.get(name);
    const e = readEffect(r);
    return { r, e };
  }
  function interpret(inv) {
    if (!inv) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], supportEff: null, repair: false, holyAmt: 0 };
    if (inv.type === 'chip') {
      const { r, e } = rowAndEff(inv.name);
      if (!r) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], supportEff: null, repair: false, holyAmt: 0 };
      let def = 0, barrier = false, attackEff = null, rec = 0;
      if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
      if (isBarrier(e)) barrier = true;
      if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
      if (isAttack(e)) attackEff = e;
      const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
      const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0; // holy heals via ticks only
      return { def, barrier, attackEff, rec, supportEff: null, used: [r.name], repair: isRepair(e), holyAmt };
    }
    if (inv.type === 'support') {
      const { r: sr, e: se } = rowAndEff(inv.support);
      const { r: cr, e: ce } = rowAndEff(inv.with);
      if (!sr || !cr) return { def: 0, barrier: false, attackEff: null, rec: 0, used: [], supportEff: null, repair: false, holyAmt: 0 };
      let def = 0, barrier = false, attackEff = null, rec = 0;
      if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
      if (isBarrier(ce)) barrier = true;
      if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0);
      if (isAttack(ce)) attackEff = ce;
      const holyGuess = Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : (Number.isFinite(ce.dmg) ? ce.dmg : 0));
      const holyAmt = isHoly(ce) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0; // holy heals via ticks only
      return { def, barrier, attackEff, rec, supportEff: se, used: [sr.name, cr.name], repair: isRepair(ce), holyAmt };
    }
  }

  const P1 = p1WasStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], supportEff:null, repair:false, holyAmt:0 } : interpret(A1raw);
  const P2 = p2WasStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], supportEff:null, repair:false, holyAmt:0 } : interpret(A2raw);

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

  // Immediate recovery (suppressed if your attack is cancelled by enemy barrier and it's not Break)
  let rec1 = P1.rec || 0; if (P1.attackEff && p2Barrier && !isBreak(P1.attackEff)) rec1 = 0;
  let rec2 = P2.rec || 0; if (P2.attackEff && p1Barrier && !isBreak(P2.attackEff)) rec2 = 0;

  // POISON apply (must land). Convert immediate damage → DoT ticks (no upfront hit)
  if (P1.attackEff && isPoison(P1.attackEff) && !dodged1 && !cancelledByBarrier1) {
    const tick = (dmg1to2|0) + (absorbed1|0);
    nextPoisP2 = replacePoison(nextPoisP2, tick);
    dmg1to2 = 0;
  }
  if (P2.attackEff && isPoison(P2.attackEff) && !dodged2 && !cancelledByBarrier2) {
    const tick = (dmg2to1|0) + (absorbed2|0);
    nextPoisP1 = replacePoison(nextPoisP1, tick);
    dmg2to1 = 0;
  }

  // HOLY self-apply (non-stacking) — ticks only (no immediate heal)
  if (P1.holyAmt > 0) nextHolyP1 = replaceHoly(nextHolyP1, P1.holyAmt);
  if (P2.holyAmt > 0) nextHolyP2 = replaceHoly(nextHolyP2, P2.holyAmt);

  // REPAIR: cleanse self before ticks (wipes newly applied same-round)
  const p1Repaired = !!P1.repair;
  const p2Repaired = !!P2.repair;
  if (p1Repaired) { nextPoisP1 = []; nextHolyP1 = []; }
  if (p2Repaired) { nextPoisP2 = []; nextHolyP2 = []; }

  // PARALYZE: set stun for next round if the hit landed
  let paraP2 = false, paraP1 = false;
  if (P1.attackEff && isParalyze(P1.attackEff) && !dodged1 && !cancelledByBarrier1) paraP2 = true;
  if (P2.attackEff && isParalyze(P2.attackEff) && !dodged2 && !cancelledByBarrier2) paraP1 = true;

  // Immediate hp after direct dmg + instant rec (ticks after)
  let p1hp = Math.max(0, Math.min(p1.max_hp, f.p1_hp - dmg2to1 + rec1));
  let p2hp = Math.max(0, Math.min(p2.max_hp, f.p2_hp - dmg1to2 + rec2));

  // Apply ticks (poison hurts, holy heals) — includes the round of application
  const { total: tickPoisonP1, next: poisAfterP1 } = tickPois(nextPoisP1);
  const { total: tickPoisonP2, next: poisAfterP2 } = tickPois(nextPoisP2);
  const { total: tickHolyP1,   next: holyAfterP1 } = tickHoly(nextHolyP1);
  const { total: tickHolyP2,   next: holyAfterP2 } = tickHoly(nextHolyP2);

  p1hp = Math.max(0, Math.min(p1.max_hp, p1hp - tickPoisonP1 + tickHolyP1));
  p2hp = Math.max(0, Math.min(p2.max_hp, p2hp - tickPoisonP2 + tickHolyP2));

  nextPoisP1 = poisAfterP1; nextPoisP2 = poisAfterP2;
  nextHolyP1 = holyAfterP1; nextHolyP2 = holyAfterP2;

  // Counters / specials
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

  // Outcome check
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

  // Persist + schedule
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
    // Clear consumed stuns, set new stuns for next round
    const nextP1Stun = paraP1 ? 1 : 0; // set if newly paralyzed this round
    const nextP2Stun = paraP2 ? 1 : 0;
    db.prepare(`UPDATE duel_state SET p1_stunned=?, p2_stunned=? WHERE channel_id=?`).run(nextP1Stun, nextP2Stun, channel.id);
    db.prepare(`UPDATE duel_state SET p1_poison_json=?, p2_poison_json=? WHERE channel_id=?`).run(JSON.stringify(nextPoisP1), JSON.stringify(nextPoisP2), channel.id);
    db.prepare(`UPDATE duel_state SET p1_holy_json=?, p2_holy_json=? WHERE channel_id=?`).run(JSON.stringify(nextHolyP1), JSON.stringify(nextHolyP2), channel.id);

    scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));
  }

  function fmt(P, crit, dodged, cancelled, dmg, absorbed, rec, stunnedNow=false, poisonTick=0, holyTick=0, repaired=false) {
    if (stunnedNow) return `was **⚡ STUNNED** and could not act`;
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
      else extras.push(`💥 ${dmg}${crit ? ' _(CRIT!)_' : ''}${absorbed > 0 ?  ` (DEF absorbed ${absorbed})` : ''}`);
    }
    if (repaired) extras.push('🔧 cleansed');
    if (poisonTick > 0) extras.push(`☠️ ${poisonTick}`);
    if (holyTick   > 0) extras.push(`✨ +${holyTick}`);
    return `${parts.join(' ')}${extras.length ?  ` → ${extras.join(' | ')}` : ''}`;
  }

  const header =
    `🎬 **Round Results**\n` +
    `• <@${f.p1_id}> ${fmt(P1, crit1, dodged1, cancelledByBarrier1, dmg1to2, absorbed1, rec1, p1WasStunned, tickPoisonP1, tickHolyP1, p1Repaired)}\n` +
    `• <@${f.p2_id}> ${fmt(P2, crit2, dodged2, cancelledByBarrier2, dmg2to1, absorbed2, rec2, p2WasStunned, tickPoisonP2, tickHolyP2, p2Repaired)}\n` +
    `${hpLineDuel({ ...f, p1_hp: p1hp, p2_hp: p2hp })}` +
    `${(paraP2 || paraP1) ? `\n${paraP2 ? `⚡ <@${f.p2_id}> is **stunned** next round.` : ''}${paraP1 ? `\n⚡ <@${f.p1_id}> is **stunned** next round.` : ''}` : ''}`;

  await channel.send(outcome ? `${header}\n\n${outcome}` : `${header}\n\n➡️ Next round: submit with **/use** within **${ROUND_SECONDS}s**.`);
}

// ---------- Round resolution (PVE) ----------
async function resolvePVERound(channel) {
  const f = getPVE.get(channel.id);
  if (!f) return;

  const player = ensureNavi(f.player_id);

  const pWasStunned = (f.p_stunned || 0) > 0;
  const vWasStunned = (f.v_stunned || 0) > 0;

  const pPois = parsePois(f.p_poison_json), vPois = parsePois(f.v_poison_json);
  const pHoly = parseHoly(f.p_holy_json),   vHoly = parseHoly(f.v_holy_json);

  let nextPoisP = pPois, nextPoisV = vPois;
  let nextHolyP = pHoly, nextHolyV = vHoly;

  const Aplayer = decodeAction(f.player_action_json);
  let Avirus = decodeAction(f.virus_action_json);

  if (!Avirus && !vWasStunned) {
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

  function chipRowOrNull(name) { return getChip.get(name) || null; }
  function effectFromName(name) { const r = chipRowOrNull(name); return { r, e: readEffect(r) }; }

  function intentFromAction(action, isVirus) {
    const base = { def:0, barrier:false, attackEff:null, rec:0, used:[], mv:null, moveName:null, supportEff:null, repair:false, holyAmt:0 };
    if (!action) return base;

    if (action.type === 'chip') {
      if (isVirus) {
        const mv = parseMoves(f.virus_moves_json).find(m => (m.name || m.label || '').toLowerCase() === String(action.name || '').toLowerCase());
        if (!mv) return base;
        let def=0, barrier=false, attackEff=null, rec=0;
        if (isDefense(mv)) def += Number.isFinite(mv.def) ? mv.def : 0;
        if (isBarrier(mv)) barrier = true;
        if (isRecovery(mv)) rec += Number.isFinite(mv.heal) ? mv.heal : (Number.isFinite(mv.rec) ? mv.rec : 0);
        if (isAttack(mv)) attackEff = mv;
        const holyGuess = Number.isFinite(mv.heal) ? mv.heal : (Number.isFinite(mv.rec) ? mv.rec : (Number.isFinite(mv.dmg) ? mv.dmg : 0));
        const holyAmt = isHoly(mv) ? Math.max(0, holyGuess|0) : 0;
        if (holyAmt > 0) rec = 0; // holy is ticks-only
        return { def, barrier, attackEff, rec, used:[mv.name || mv.label || 'Move'], mv, moveName: (mv.name || mv.label || 'Move'), supportEff:null, repair: isRepair(mv), holyAmt };
      } else {
        const r = getChip.get(action.name); const e = readEffect(r);
        if (!r) return base;
        let def=0, barrier=false, attackEff=null, rec=0;
        if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
        if (isBarrier(e)) barrier = true;
        if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
        if (isAttack(e)) attackEff = e;
        const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
        const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
        if (holyAmt > 0) rec = 0; // holy is ticks-only
        return { def, barrier, attackEff, rec, used:[r.name], mv:null, moveName:r.name, supportEff:null, repair: isRepair(e), holyAmt };
      }
    }

    if (action.type === 'support' && !isVirus) {
      const s = getChip.get(action.support), c = getChip.get(action.with);
      const se = readEffect(s), ce = readEffect(c);
      if (!s || !c) return base;
      let def=0, barrier=false, attackEff=null, rec=0;
      if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
      if (isBarrier(ce)) barrier = true;
      if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0);
      if (isAttack(ce)) attackEff = ce;
      const holyGuess = Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : (Number.isFinite(ce.dmg) ? ce.dmg : 0));
      const holyAmt = isHoly(ce) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0; // holy is ticks-only
      return { def, barrier, attackEff, rec, used:[s.name, c.name], mv:null, moveName:c.name, supportEff:se, repair: isRepair(ce), holyAmt };
    }

    return base;
  }

  const PP = pWasStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], mv:null, moveName:null, supportEff:null, repair:false, holyAmt:0 } : intentFromAction(Aplayer, false);
  const PV = vWasStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], mv:null, moveName:null, supportEff:null, repair:false, holyAmt:0 } : intentFromAction(Avirus, true);

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

  // Immediate recovery
  let recP = PP.rec || 0; if (PP.attackEff && vBarrier && !isBreak(PP.attackEff)) recP = 0;
  let recV = PV.rec || 0; if (PV.attackEff && pBarrier && !isBreak(PV.attackEff)) recV = 0;

  // POISON apply (landed) → convert to 3 ticks; no upfront hit
  if (PP.attackEff && isPoison(PP.attackEff) && !dodgedP && !cancelledByBarrierP) {
    const tick = (dmgPtoV|0) + (absorbedP|0);
    nextPoisV = replacePoison(nextPoisV, tick);
    dmgPtoV = 0;
  }
  if (PV.attackEff && isPoison(PV.attackEff) && !dodgedV && !cancelledByBarrierV) {
    const tick = (dmgVtoP|0) + (absorbedV|0);
    nextPoisP = replacePoison(nextPoisP, tick);
    dmgVtoP = 0;
  }

  // HOLY (self) — ticks only (no immediate rec)
  if (PP.holyAmt > 0) nextHolyP = replaceHoly(nextHolyP, PP.holyAmt);
  if (PV.holyAmt > 0) nextHolyV = replaceHoly(nextHolyV, PV.holyAmt);

  // REPAIR (self) before ticks
  const pRepaired = !!PP.repair;
  const vRepaired = !!PV.repair;
  if (pRepaired) { nextPoisP = []; nextHolyP = []; }
  if (vRepaired) { nextPoisV = []; nextHolyV = []; }

  // PARALYZE (landed) → stun target next round
  const paraV = PP.attackEff && isParalyze(PP.attackEff) && !dodgedP && !cancelledByBarrierP;
  const paraP = PV.attackEff && isParalyze(PV.attackEff) && !dodgedV && !cancelledByBarrierV;

  // Immediate hp
  let php = Math.max(0, Math.min(player.max_hp, f.p_hp - dmgVtoP + recP));
  let vhp = Math.max(0, Math.min(f.virus_max_hp, f.v_hp - dmgPtoV + recV));

  // Ticks (include this round)
  const { total: tickPoisonP, next: poisAfterP } = tickPois(nextPoisP);
  const { total: tickPoisonV, next: poisAfterV } = tickPois(nextPoisV);
  const { total: tickHolyP,   next: holyAfterP } = tickHoly(nextHolyP);
  const { total: tickHolyV,   next: holyAfterV } = tickHoly(nextHolyV);

  php = Math.max(0, Math.min(player.max_hp, php - tickPoisonP + tickHolyP));
  vhp = Math.max(0, Math.min(f.virus_max_hp, vhp - tickPoisonV + tickHolyV));

  nextPoisP = poisAfterP; nextPoisV = poisAfterV;
  nextHolyP = holyAfterP; nextHolyV = holyAfterV;

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
    // Always award stat points (from TSV stat_points)
    let sp = 1;
    try {
      const vr = VirusCache.rows.find(r => (r.name || '').toLowerCase() === (f.virus_name || '').toLowerCase());
      sp = Math.max(1, parseInt(vr?.stat_points || '1', 10) || 1);
    } catch {}

    addPoints.run(sp, f.player_id);

    // Chip drop OR Zenny (supports multiple chip_drops)
    let dropChipName = '';
    try {
      const vr = VirusCache.rows.find(r =>
        (r.name || '').toLowerCase() === (f.virus_name || '').toLowerCase()
      );

      const pool =
        (vr?.chip_drops && vr.chip_drops.length) ? vr.chip_drops.slice()
        : (vr?.chip_drop ? [vr.chip_drop] : []);

      const rolledChip = pool.length && Math.random() < VIRUS_CHIP_DROP_PCT;

      if (rolledChip) {
        // Pick a random candidate and award if it exists & isn’t an upgrade
        const pickName = pool[Math.floor(Math.random() * pool.length)];
        const chipRow = getChip.get(pickName);
        if (chipRow && !chipRow.is_upgrade) {
          invAdd(f.player_id, chipRow.name, 1);
          dropChipName = chipRow.name;
        }
      }
    } catch {}

    let z = 0;
    if (!dropChipName) {
      // No chip drop -> roll zenny range
      z = Math.max(f.virus_zmin || 0,
        Math.min(f.virus_zmax || 0,
          Math.floor(Math.random() * ((f.virus_zmax || 0) - (f.virus_zmin || 0) + 1)) + (f.virus_zmin || 0)
        )
      );
      if (z > 0) addZenny.run(z, f.player_id);
    }

    // Mission completion checks
    const mission = getActiveMission.get(f.player_id);
    if (mission) {
      let completed = false;
      if (mission.target_boss && mission.target_boss.toLowerCase() === (f.virus_name || '').toLowerCase()) {
        completed = true;
      } else if (mission.target_chip && dropChipName && mission.target_chip.toLowerCase() === dropChipName.toLowerCase()) {
        completed = true;
      }

      if (completed) {
        // If mission requires surrendering the chip, remove it and award zenny
        if (!mission.keep_chip && mission.target_chip && dropChipName && dropChipName.toLowerCase() === mission.target_chip.toLowerCase()) {
          const have = invGetQty(f.player_id, dropChipName);
          if (have > 0) invAdd(f.player_id, dropChipName, -1);
        }
        if (mission.reward_zenny > 0) addZenny.run(mission.reward_zenny, f.player_id);
        completeMission.run(f.player_id, mission.mission_id);
        outcome = `🏆 **<@${f.player_id}> wins!** ${dropChipName ? `You got **${dropChipName}**.` : `You earned **${z}** ${zennyIcon()}.`} + **${sp}** point${sp===1?'':'s'}.\n✅ **Mission completed** — Reward: **${mission.reward_zenny}** ${zennyIcon()}${mission.keep_chip? ' (Chip kept)' : ' (Chip surrendered)'}!`;
      }
    }

    if (!outcome) {
      outcome = `🏆 **<@${f.player_id}> wins!** ${dropChipName ? `You got **${dropChipName}**.` : `You earned **${z}** ${zennyIcon()}.`} + **${sp}** upgrade point${sp===1?'':'s'}.`;
    }

    endPVE.run(channel.id);
    clearRoundTimer(channel.id);
  } else if (php === 0) {
    outcome = `💀 **${f.virus_name}** wins! Better luck next time.`;
    endPVE.run(channel.id);
    clearRoundTimer(channel.id);
  }

  // If still ongoing, persist state and schedule next round; else announce result
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
    // Clear consumed stuns, set new for next round + statuses
    const nextPStun = paraP ? 1 : 0;
    const nextVStun = paraV ? 1 : 0;
    db.prepare(`UPDATE pve_state SET p_stunned=?, v_stunned=? WHERE channel_id=?`).run(nextPStun, nextVStun, channel.id);
    db.prepare(`UPDATE pve_state SET p_poison_json=?, v_poison_json=? WHERE channel_id=?`).run(JSON.stringify(nextPoisP), JSON.stringify(nextPoisV), channel.id);
    db.prepare(`UPDATE pve_state SET p_holy_json=?, v_holy_json=? WHERE channel_id=?`).run(JSON.stringify(nextHolyP), JSON.stringify(nextHolyV), channel.id);

    scheduleRoundTimer(channel.id, () => resolvePVERound(channel));
  }

  const embed = new EmbedBuilder()
    .setTitle(`👾 ${f.virus_name}`)
    .setDescription(`**HP** ${vhp} / ${f.virus_max_hp} | **Dodge** ${f.virus_dodge}% | **Crit** ${f.virus_crit}%`)
    .setImage(f.virus_image || null)
    .setFooter({ text: 'Virus Busting' });

  function fmtP(label, P, crit, dodged, cancelled, dmg, absorbed, rec, stunnedNow=false, poisonTick=0, holyTick=0, repaired=false) {
    if (stunnedNow) return `• ${label} was **⚡ STUNNED** and could not act`;
    const used = [...new Set(P.used || [])];
    const parts = [];
    if (P.supportEff && used.length === 2) parts.push(`**${used[0]}** → **${used[1]}**`);
    else if (used.length) parts.push(used.map((n)=>`**${n}**`).join(' + '));
    else parts.push('did nothing');
    const extras = [];
    if (P.barrier) extras.push('🛡️ Barrier');
    if (P.def) extras.push(`🧱 DEF +${P.def}`);
    if (rec > 0) extras.push(`💚 +${rec}`);
    if (P.attackEff) {
      if (cancelled) extras.push('❌ cancelled');
      else if (dodged) extras.push('💨 dodged');
      else extras.push(`💥 ${dmg}${crit ? ' _(CRIT!)_' : ''}${absorbed > 0 ?  ` (DEF absorbed ${absorbed})` : ''}`);
    }
    if (repaired) extras.push('🔧 cleansed');
    if (poisonTick > 0) extras.push(`☠️ ${poisonTick}`);
    if (holyTick   > 0) extras.push(`✨ +${holyTick}`);
    return `• ${label} ${parts.join(' ')}${extras.length ?  ` → ${extras.join(' | ')}` : ''}`;
  }

  const lineP = fmtP(`<@${f.player_id}>`, PP, critP, dodgedP, cancelledByBarrierP, dmgPtoV, absorbedP, recP, pWasStunned, tickPoisonP, tickHolyP, pRepaired);
  const lineV = fmtP(`**${PV.moveName || f.virus_name}**`, PV, critV, dodgedV, cancelledByBarrierV, dmgVtoP, absorbedV, recV, vWasStunned, tickPoisonV, tickHolyV, vRepaired);

  const header = `🎬 **Round Results**\n${lineP}\n${lineV}\n${hpLinePVE({ ...f, p_hp: php, v_hp: vhp })}` +
    `${(paraV || paraP) ? `\n${paraV ? '⚡ Virus is **stunned** next round.' : ''}${paraP ? `\n⚡ <@${f.player_id}> is **stunned** next round.` : ''}` : ''}`;

  await channel.send(outcome ? { content: `${header}\n\n${outcome}`, embeds: [embed] } : { content: `${header}\n\n➡️ Next round: submit with **/use** within **${ROUND_SECONDS}s**.`, embeds: [embed] });
}

// ---------- Interactions ----------
client.on('interactionCreate', async (ix) => {
  try {
    // SHOP UI interactivity
    if (ix.isStringSelectMenu() && ix.customId.startsWith('shop:select:')) {
      const name = ix.values?.[0];
      const chip = getChip.get(name);
      if (!chip) return ix.reply({ ephemeral: true, content: 'That item no longer exists.' });

      const eff = readEffect(chip);
      const tag = chip.is_upgrade ? '🧩 Upgrade' : '🔹 Chip';
      const effectiveCost = chip.is_upgrade ? dynamicUpgradeCostFor(ix.user.id, chip) : (chip.zenny_cost || 0);
      const e = new EmbedBuilder()
        .setTitle(`${tag} — ${chip.name}`)
        .setDescription(`Cost: **${effectiveCost}** ${zennyIcon()}${chip.is_upgrade && DYN_UPGRADES.has(chip.name) ? ' (dynamic)' : ''}\n${summarizeEffect(eff)}`);
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
        const ui = buildShopPage(rows, nextPage, ix.user.id);
        return ix.update({ embeds: [ui.embed], components: ui.components });
      }
      if (ix.customId.startsWith('shop:buy:')) {
        const [, , qtyStr, encName] = ix.customId.split(':');
        const qty = Math.max(1, parseInt(qtyStr, 10) || 1);
        const name = decodeURIComponent(encName || '');
        const chip = getChip.get(name);
        if (!chip) return ix.reply({ ephemeral: true, content: 'That item no longer exists.' });

        const buyer = ensureNavi(ix.user.id);
        const total = chip.is_upgrade && DYN_UPGRADES.has(chip.name)
          ? dynamicUpgradeTotalFor(ix.user.id, chip, qty)
          : (chip.zenny_cost || 0) * qty;

        if ((buyer.zenny ?? 0) < total) {
          return ix.reply({ ephemeral: true, content: `Not enough Zenny. Cost is **${total}** ${zennyIcon()}` });
        }
        addZenny.run(-total, ix.user.id);

        if (chip.is_upgrade) {
          // Apply and bump count per unit
          for (let i = 0; i < qty; i++) bumpUpgCount.run(ix.user.id, chip.name);
          const after = applyUpgrade(ix.user.id, chip, qty);
          return ix.reply({ ephemeral: true, content: `🧩 Applied **${chip.name}** ×${qty}. New stats — HP **${after.max_hp}**, Dodge **${after.dodge}%**, Crit **${after.crit}%**.` });
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

      if (ix.commandName === 'chip_grant' || ix.commandName === 'chip_remove' || ix.commandName === 'give_chip') {
        const names = listAllChipNames.all().map((r) => r.name);
        const filtered = names.filter((n) => n.toLowerCase().includes(query)).slice(0, 25);
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

    // ---------- Basic account ----------
    if (ix.commandName === 'navi_register') {
      const row = ensureNavi(ix.user.id);
      ensureLoc(ix.user.id);
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

      if (MANUAL_UPGRADES_MODE === 'points') {
        const rowNow = ensureNavi(ix.user.id);
        let needPts = 0;
        if (stat === 'hp') needPts = HP_POINTS_PER_STEP; // for +10 HP
        if (stat === 'dodge' || stat === 'crit') needPts = CRIT_DODGE_COST;

        if ((rowNow.upgrade_pts ?? 0) < needPts) {
          return ix.reply({ content: `Not enough upgrade points. **${needPts}** required for this upgrade.`, ephemeral: true });
        }

        // Apply step
        const STEP = { hp: HP_STEP_SIZE, dodge: 1, crit: 1 }[stat];
        const CAP  = { hp: MAX_HP_CAP,   dodge: MAX_DODGE_CAP, crit: MAX_CRIT_CAP }[stat];

        let { max_hp, dodge, crit, wins, losses, upgrade_pts } = rowNow;
        const before = { hp:max_hp, dodge, crit }[stat];

        if (stat === 'hp')    max_hp = Math.min(CAP, max_hp + STEP);
        if (stat === 'dodge') dodge  = Math.min(CAP, dodge  + STEP);
        if (stat === 'crit')  crit   = Math.min(CAP,  crit  + STEP);

        const after = { hp:max_hp, dodge, crit }[stat];
        if (after === before) {
          return ix.reply({ content: `Your ${stat.toUpperCase()} is already at the cap (${CAP}).`, ephemeral: true });
        }

        upsertNavi.run(ix.user.id, max_hp, dodge, crit, wins ?? 0, losses ?? 0, (upgrade_pts ?? 0) - needPts, rowNow.zenny ?? 0);
        return ix.reply(`⬆️ ${stat.toUpperCase()} +${STEP} (now **${after}**) — Points spent: **${needPts}**, Left: **${Math.max(0, (upgrade_pts ?? 0) - needPts)}**`);
      }

      // Admin path (no points cost, single step as before)
      const row = ensureNavi(ix.user.id);
      let { max_hp, dodge, crit, wins, losses, upgrade_pts } = row;

      const STEP = { hp: 10, dodge: 1, crit: 1 }[stat];
      const CAP = { hp: MAX_HP_CAP, dodge: MAX_DODGE_CAP, crit: MAX_CRIT_CAP }[stat];

      const before = { hp:max_hp, dodge, crit }[stat];
      if (stat === 'hp')    max_hp = Math.min(CAP, max_hp + STEP);
      if (stat === 'dodge') dodge  = Math.min(CAP, dodge  + STEP);
      if (stat === 'crit')  crit   = Math.min(CAP,  crit  + STEP);
      const after = { hp:max_hp, dodge, crit }[stat];

      if (after === before) {
        return ix.reply({ content: `Your ${stat.toUpperCase()} is already at the cap (${CAP}).`, ephemeral: true });
      }
      upsertNavi.run(ix.user.id, max_hp, dodge, crit, wins ?? 0, losses ?? 0, upgrade_pts ?? 0, row.zenny ?? 0);
      return ix.reply(`⬆️ ${stat.toUpperCase()} +${STEP} (now **${after}**) — Admin-applied.`);
    }

    if (ix.commandName === 'navi_stats') {
      const user = ix.options.getUser('user') || ix.user;
      const row = ensureNavi(user.id);
      ensureLoc(user.id);

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
      const loc = ensureLoc(user.id);

      return ix.reply(
        `📊 **${user.username}** — HP ${hpStr} | Dodge ${row.dodge}% | Crit ${row.crit}% | ` +
        `Record: **${row.wins ?? 0}-${row.losses ?? 0}** | Points: **${row.upgrade_pts ?? 0}** | ` +
        `Zenny: **${row.zenny ?? 0} ${zennyIcon()}** | Def (temp): **${defNow}** | Location: **${loc.region} — Area ${loc.zone}**`
      );
    }

    if (ix.commandName === 'navi_leaderboard') {
      let limit = ix.options.getInteger('limit') ?? 10;
      limit = Math.max(5, Math.min(25, limit));
      const rows = db.prepare(`SELECT user_id, wins, losses FROM navis ORDER BY wins DESC, losses ASC LIMIT ?`).all(limit);
      if (!rows.length) return ix.reply('No registered players yet.');
      const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> — **${r.wins}-${r.losses}**`);
      return ix.reply(`🏅 **Top Players**\n${lines.join('\n')}`);
    }

    // ---------- Search ----------
    if (ix.commandName === 'virus_search') {
      try {
        const name = ix.options.getString('name', true);
        const viruses = await loadViruses();
        const v = viruses.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
        if (!v) return ix.reply({ content: 'No matching virus/boss found.', ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`👾 ${v.name}${v.boss ? ' — ⭐ BOSS' : ''}`)
          .setDescription(`**HP** ${v.hp} | **Dodge** ${v.dodge}% | **Crit** ${v.crit}%\nZenny: ${v.zmin}-${v.zmax}\nRegion: ${v.region || '—'} • Zone: ${v.zone || '—'}\nChip Drop: ${(v.chip_drops?.length ? v.chip_drops.join(', ') : (v.chip_drop || '—'))}`)
          .setImage(v.image_url || null)
          .setFooter({ text: 'Virus Search' });

        return ix.reply({ embeds: [embed] });
      } catch (e) {
        console.error('virus_search error:', e);
        return ix.reply({ content: 'Could not load Virus data. Check VIRUS_TSV_URL and sharing.', ephemeral: true });
      }
    }

    // ---------- PvE ----------
    if (ix.commandName === 'virus_busting') {
      if (getFight.get(ix.channel.id) || getPVE.get(ix.channel.id)) {
        return ix.reply({ content: 'There is already a duel/encounter active in this channel.', ephemeral: true });
      }
      ensureNavi(ix.user.id);
      const loc = ensureLoc(ix.user.id);

      let viruses = [];
      try { viruses = await loadViruses(); } catch (e) {
        console.error('Virus TSV load failed:', e);
        return ix.reply('Could not load Virus data. Check VIRUS_TSV_URL and sharing settings.');
      }
      if (!viruses.length) return ix.reply('No viruses available. Populate your TSV and try again.');

      // Location-filtered pool
      let pickPool = viruses.filter(v => {
        const okRegion = !v.region || v.region.toLowerCase() === loc.region.toLowerCase();
        const okZone = !v.zone || (parseInt(v.zone, 10) === loc.zone);
        return okRegion && okZone;
      });
      if (!pickPool.length) pickPool = viruses; // fallback if TSV not region-tagged

      const pick = weightedPick(pickPool);

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

      await ix.reply({ content: `🐸 **Virus Busting started!** (${loc.region} — Area ${loc.zone}) Submit your chip with **/use** within **${ROUND_SECONDS}s** each round.`, embeds: [embed] });
      return;
    }

    // ---------- PvP ----------
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
              f.p1_hp, f.p2_hp, f.p1_def, f.p2_def,
              f.p1_counts_json, f.p2_counts_json,
              f.p1_special_used, f.p2_special_used,
              f.p1_action_json, JSON.stringify(botAct),
              f.round_deadline, ix.channel.id
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
        const a1 = !!f.p1_action_json;
        const a2 = !!f.p2_action_json;

        const pp1 = parsePois(f.p1_poison_json || '[]')[0];
        const pp2 = parsePois(f.p2_poison_json || '[]')[0];
        const hh1 = parseHoly(f.p1_holy_json   || '[]')[0];
        const hh2 = parseHoly(f.p2_holy_json   || '[]')[0];

        const s1  = (f.p1_stunned || 0) > 0 ? ' • **⚡ STUNNED**' : '';
        const s2  = (f.p2_stunned || 0) > 0 ? ' • **⚡ STUNNED**' : '';
        const pz1 = pp1 ? ` • ☠️ ${pp1.dmg} (${pp1.ticks}r)` : '';
        const pz2 = pp2 ? ` • ☠️ ${pp2.dmg} (${pp2.ticks}r)` : '';
        const ho1 = hh1 ? ` • ✨ ${hh1.heal} (${hh1.ticks}r)` : '';
        const ho2 = hh2 ? ` • ✨ ${hh2.heal} (${hh2.ticks}r)` : '';

        const lines = [
          `🧭 **Duel (Simultaneous)**`,
          `Round ends in: **${left}s**`,
          `P1: <@${f.p1_id}> — HP **${f.p1_hp}** | Pending: ${a1 ? 'LOCKED' : '—'}${s1}${pz1}${ho1}`,
          `P2: <@${f.p2_id}> — HP **${f.p2_hp}** | Pending: ${a2 ? 'LOCKED' : '—'}${s2}${pz2}${ho2}`,
        ];
        return ix.reply(lines.join('\n'));
      }

      if (pve) {
        const left = Math.max(0, Math.ceil((pve.round_deadline - now()) / 1000));
        const aP = decodeAction(pve.player_action_json);
        const aV = decodeAction(pve.virus_action_json);

        const pp = parsePois(pve.p_poison_json || '[]')[0];
        const pv = parsePois(pve.v_poison_json || '[]')[0];
        const hp = parseHoly(pve.p_holy_json   || '[]')[0];
        const hv = parseHoly(pve.v_holy_json   || '[]')[0];

        const sP = (pve.p_stunned || 0) > 0 ? ' • **⚡ STUNNED**' : '';
        const sV = (pve.v_stunned || 0) > 0 ? ' • **⚡ STUNNED**' : '';
        const pzP = pp ? ` • ☠️ ${pp.dmg} (${pp.ticks}r)` : '';
        const pzV = pv ? ` • ☠️ ${pv.dmg} (${pv.ticks}r)` : '';
        const hoP = hp ? ` • ✨ ${hp.heal} (${hp.ticks}r)` : '';
        const hoV = hv ? ` • ✨ ${hv.heal} (${hv.ticks}r)` : '';

        const embed = new EmbedBuilder()
          .setTitle(`👾 ${pve.virus_name}`)
          .setDescription(`**HP** ${pve.v_hp} / ${pve.virus_max_hp} | **Dodge** ${pve.virus_dodge}% | **Crit** ${pve.virus_crit}%`)
          .setImage(pve.virus_image || null)
          .setFooter({ text: 'Virus Busting' });

        const lines = [
          `🧭 **Virus Encounter (Simultaneous)**`,
          `Round ends in: **${left}s**`,
          `Player: <@${pve.player_id}> — HP **${pve.p_hp}** | Pending: ${aP ? 'LOCKED' : '—'}${sP}${pzP}${hoP}`,
          `Virus: **${pve.virus_name}** — HP **${pve.v_hp}** | Pending: ${aV ? 'LOCKED' : '—'}${sV}${pzV}${hoV}`,
        ];
        return ix.reply({ content: lines.join('\n'), embeds: [embed] });
      }
    }

    // ---------- Economy ----------
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

    // Chip transfer
    if (ix.commandName === 'give_chip') {
      const to = ix.options.getUser('to', true);
      const name = ix.options.getString('name', true);
      let qty = ix.options.getInteger('qty') ?? 1;
      qty = Math.max(1, qty);

      if (to.id === ix.user.id) return ix.reply({ content: 'You cannot send chips to yourself.', ephemeral: true });

      const chip = getChip.get(name);
      if (!chip) return ix.reply({ content: 'Unknown chip.', ephemeral: true });
      if (chip.is_upgrade) return ix.reply({ content: 'Upgrades are applied on purchase and cannot be transferred.', ephemeral: true });

      const have = invGetQty(ix.user.id, name);
      if (have < qty) return ix.reply({ content: `You only have **${have}** of **${name}**.`, ephemeral: true });

      ensureNavi(to.id);
      invAdd(ix.user.id, name, -qty);
      invAdd(to.id, name, +qty);
      return ix.reply(`📦 Transferred **${qty}× ${name}** from <@${ix.user.id}> to <@${to.id}>.`);
    }

    // Shop
    if (ix.commandName === 'shop') {
      const rows = listShop.all();
      if (!rows.length) return ix.reply('Shop is empty. Ask an admin to /chips_reload.');
      const ui = buildShopPage(rows, 0, ix.user.id);
      return ix.reply({ ephemeral: true, embeds: [ui.embed], components: ui.components });
    }

    // Folder (hide upgrades)
    if (ix.commandName === 'folder') {
      const rows = listInv.all(ix.user.id).filter(r => (getChip.get(r.chip_name)?.is_upgrade ?? 0) === 0);
      if (!rows.length) return ix.reply('Your folder is empty. Use /shop to get chips.');
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
          const after = applyUpgrade(user.id, chip, qty);
          return ix.reply(`🧩 Applied upgrade **${chip.name}** ×${qty} to <@${user.id}>. New stats — HP **${after.max_hp}**, Dodge **${after.dodge}%**, Crit **${after.crit}%**.`);
        } else {
          return ix.reply({ content: 'Upgrades aren’t inventory items and can’t be removed. Use /stat_override if you need to adjust stats.', ephemeral: true });
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

    // ---------- Thing 3 Commands ----------
    if (ix.commandName === 'metroline') {
      const region = ix.options.getString('region', true);
      const zone = ix.options.getInteger('zone', true);
      if (!REGIONS.includes(region) || zone < 1 || zone > 3) {
        return ix.reply({ content: 'Invalid region/zone.', ephemeral: true });
      }
      setLoc.run(ix.user.id, region, zone);
      return ix.reply(`🚇 You travel to **${region} — Area ${zone}**. Encounters here will pull from this location.`);
    }

    if (ix.commandName === 'bbs_mission') {
      ensureNavi(ix.user.id);
      const loc = ensureLoc(ix.user.id);
      const existing = getActiveMission.get(ix.user.id);
      if (existing) {
        return ix.reply(`🗒️ You already have an active mission (**${existing.mission_id}**, region **${existing.region}**).\nTarget: ${existing.target_boss ? `Boss **${existing.target_boss}**` : `Chip **${existing.target_chip}**`}\nReward: **${existing.reward_zenny}** ${zennyIcon()} • Keep Chip: ${existing.keep_chip ? 'Yes' : 'No'}`);
      }
      let missions = [];
      try { missions = await loadMissions(); } catch (e) { console.error(e); }
      const pool = missions.filter(m => m.region.toLowerCase() === loc.region.toLowerCase());
      if (!pool.length) return ix.reply(`No missions available for **${loc.region}**.`);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      setActiveMission.run(ix.user.id, pick.mission_id, pick.region, pick.target_chip, pick.target_boss, pick.reward_zenny, pick.keep_chip ? 1 : 0, Date.now());
      return ix.reply(`📡 **BBS Mission** acquired for **${pick.region}**!\n• Target: ${pick.target_boss ? `Boss **${pick.target_boss}**` : `Chip **${pick.target_chip}**`}\n• Reward: **${pick.reward_zenny}** ${zennyIcon()} • Keep Chip: ${pick.keep_chip ? 'Yes' : 'No'}\n(Area undisclosed — explore ${pick.region}.)`);
    }

    // ---------- Unified /use ----------
    if (ix.commandName === 'use') {
      const chipName = ix.options.getString('chip', true);
      const supportName = ix.options.getString('support');

      const f = getFight.get(ix.channel.id);
      const pve = getPVE.get(ix.channel.id);

      let context = null;
      if (f && (ix.user.id === f.p1_id || ix.user.id === f.p2_id)) context = 'duel';
      else if (pve && ix.user.id === pve.player_id) context = 'pve';
      else return ix.reply({ content: 'No active battle for you in this channel.', ephemeral: true });

      // Block move input if stunned this round (prevents losing chips while stunned)
      if (context === 'duel') {
        const amP1 = ix.user.id === f.p1_id;
        const stunned = amP1 ? (f.p1_stunned > 0) : (f.p2_stunned > 0);
        if (stunned) return ix.reply({ content: '⚡ You are stunned this round and cannot act.', ephemeral: true });
      } else {
        if (pve.p_stunned > 0) return ix.reply({ content: '⚡ You are stunned this round and cannot act.', ephemeral: true });
      }

      const haveChip = invGetQty(ix.user.id, chipName);
      if (haveChip <= 0) return ix.reply({ content: `You don’t own **${chipName}**.`, ephemeral: true });

      let useSupport = false;
      if (supportName) {
        const haveSupport = invGetQty(ix.user.id, supportName);
        if (haveSupport <= 0) return ix.reply({ content: `You don’t own **${supportName}**.`, ephemeral: true });
        const sEff = readEffect(getChip.get(supportName));
        const cEff = readEffect(getChip.get(chipName));
        if (!isSupport(sEff)) return ix.reply({ content: `**${supportName}** is not a Support chip.`, ephemeral: true });
        if (isSupport(cEff)) return ix.reply({ content: 'Your primary chip must not be Support.', ephemeral: true });
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
        const mineSpecs  = (ix.user.id === f.p1_id) ? f.p1_special_used : f.p2_special_used;

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

        // Persist my action
        if (ix.user.id === f.p1_id) {
          updFightRound.run(
            f.p1_hp, f.p2_hp, f.p1_def, f.p2_def,
            f.p1_counts_json, f.p2_counts_json,
            f.p1_special_used, f.p2_special_used,
            actJson, f.p2_action_json,
            f.round_deadline, ix.channel.id
          );
        } else {
          updFightRound.run(
            f.p1_hp, f.p2_hp, f.p1_def, f.p2_def,
            f.p1_counts_json, f.p2_counts_json,
            f.p1_special_used, f.p2_special_used,
            f.p1_action_json, actJson,
            f.round_deadline, ix.channel.id
          );
        }

        // Messaging: hide move in human PvP, show details in scrimmage
        const opponentId = (ix.user.id === f.p1_id) ? f.p2_id : f.p1_id;
        const oppIsBot = opponentId === client.user.id;
        const detailed = useSupport ? `${supportName} → ${chipName}` : chipName;

        if (oppIsBot) {
          await ix.reply(`🔒 Locked **${detailed}** for this round.`);
        } else {
          await ix.reply({ content: `🔒 Locked <@${ix.user.id}>`, ephemeral: false });
          await ix.followUp({ content: `🔒 Locked **${detailed}** for this round.`, ephemeral: true });
        }

        // Refresh fight row
        let ff = getFight.get(ix.channel.id);

        // If opponent is the bot and not stunned, lock its move immediately and resolve now
        if (oppIsBot) {
          const botIsP1 = ff.p1_id === client.user.id;
          const botStunned = botIsP1 ? (ff.p1_stunned > 0) : (ff.p2_stunned > 0);
          const botAlreadyLocked = botIsP1 ? !!ff.p1_action_json : !!ff.p2_action_json;
          if (!botAlreadyLocked && !botStunned) {
            const botAct = pickBotChipFor(ff, botIsP1);
            if (botAct) {
              if (botIsP1) {
                updFightRound.run(
                  ff.p1_hp, ff.p2_hp, ff.p1_def, ff.p2_def,
                  ff.p1_counts_json, ff.p2_counts_json,
                  ff.p1_special_used, ff.p2_special_used,
                  JSON.stringify(botAct), ff.p2_action_json,
                  ff.round_deadline, ix.channel.id
                );
              } else {
                updFightRound.run(
                  ff.p1_hp, ff.p2_hp, ff.p1_def, ff.p2_def,
                  ff.p1_counts_json, ff.p2_counts_json,
                  ff.p1_special_used, ff.p2_special_used,
                  ff.p1_action_json, JSON.stringify(botAct),
                  ff.round_deadline, ix.channel.id
                );
              }
              ff = getFight.get(ix.channel.id);
            }
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
          if (!fp.virus_action_json && !(fp.v_stunned > 0)) {
            const mv = pickVirusMove(fp);
            if (mv) updPVE.run(fp.p_hp, fp.v_hp, fp.p_def, fp.v_def, fp.p_counts_json, fp.p_special_used, fp.v_special_used, fp.player_action_json, JSON.stringify({ type: 'chip', name: mv.name || mv.label || 'Move' }), fp.round_deadline, fp.v_def_total, fp.v_def_streak, ix.channel.id);
          }
          clearRoundTimer(ix.channel.id);
          await resolvePVERound(ix.channel);
        }
        return;
      }
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
