// index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder, // added for admin grant UI
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
const zennyIcon = () =>
  (/^\d{17,20}$/.test(ZENNY_EMOJI_ID) ? `<:${ZENNY_EMOJI_NAME}:${ZENNY_EMOJI_ID}>` : '💰');

// ---------- Starters ----------
const STARTER_ZENNY  = parseInt(process.env.STARTER_ZENNY || '0', 10);
const STARTER_CHIPS  = (process.env.STARTER_CHIPS || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
// supports "Cannon x3" or "Cannon"
function starterEntries() {
  return STARTER_CHIPS.map(s => {
    const m = s.match(/^(.*?)(?:\s*[xX]\s*(\d+))?\s*$/);
    return { name: (m?.[1] || '').trim(), qty: Math.max(1, parseInt(m?.[2] || '1', 10) || 1) };
  }).filter(x => x.name);
}

// ---------- Thing 3 Config ----------
const REGIONS = ['ACDC','SciLab','Yoka','Beach','Sharo','YumLand','UnderNet'];

// Dynamic upgrade price steps (per purchase)
const HP_MEMORY_COST_STEP      = parseInt(process.env.HP_MEMORY_COST_STEP      || '500', 10);
const DATA_RECONFIG_COST_STEP  = parseInt(process.env.DATA_RECONFIG_COST_STEP  || '500', 10);
const LUCKY_DATA_COST_STEP     = parseInt(process.env.LUCKY_DATA_COST_STEP     || '500', 10);

// Stat upgrade point costs (manual /navi_upgrade)
const CRIT_DODGE_COST    = parseInt(process.env.CRIT_DODGE_COST   || '5', 10);   // points for +1% crit/dodge
const HP_POINTS_PER_STEP = parseInt(process.env.HP_POINTS_PER_STEP || '50', 10);  // points per +10 HP
const HP_STEP_SIZE       = parseInt(process.env.HP_STEP_SIZE       || '10', 10);  // default step remains +10 HP

// 33% virus chip drop (ENV override-able 0..1)
const VIRUS_CHIP_DROP_PCT = Number(process.env.VIRUS_CHIP_DROP_PCT ?? 0.33);

// Ensure data dir exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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
        o.setName('amount').setDescription('Amount (steps for HP, +1s for crit/dodge)').setRequired(false),
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
      .setDescription('Admin: grant chips to a user (parameters)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('qty').setDescription('Qty').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
      .setName('grant_chip')
      .setDescription('Admin: open catalog to grant a chip (interactive)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('chip_remove')
      .setDescription('Admin: remove chips from a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Chip name').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('qty').setDescription('Qty').setRequired(true).setMinValue(1)),

    // NEW: Admin chip catalog pager
    new SlashCommandBuilder()
      .setName('chips_catalog')
      .setDescription('Admin: browse all chips (paged)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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

    new SlashCommandBuilder()
      .setName('bbs_mission_quit')
      .setDescription('Abandon your current mission (5-minute lockout)'),

  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  console.log(`[commands] Registering ${cmds.length} commands to guild ${GUILD_ID}…`);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: cmds });
  console.log('[commands] Guild commands registered.');
}

// ---------- DB ----------
const db = new Database('./data/data.sqlite');
db.pragma('foreign_keys = ON'); // enforce FK constraints

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
  started_at INTEGER NOT NULL,

  -- status effects
  p1_stunned INTEGER NOT NULL DEFAULT 0,
  p2_stunned INTEGER NOT NULL DEFAULT 0,
  p1_poison_json TEXT NOT NULL DEFAULT '[]',
  p2_poison_json TEXT NOT NULL DEFAULT '[]',
  p1_holy_json TEXT NOT NULL DEFAULT '[]',
  p2_holy_json TEXT NOT NULL DEFAULT '[]'
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

  started_at INTEGER NOT NULL,

  -- status effects
  p_stunned INTEGER NOT NULL DEFAULT 0,
  v_stunned INTEGER NOT NULL DEFAULT 0,
  p_poison_json TEXT NOT NULL DEFAULT '[]',
  v_poison_json TEXT NOT NULL DEFAULT '[]',
  p_holy_json TEXT NOT NULL DEFAULT '[]',
  v_holy_json TEXT NOT NULL DEFAULT '[]'
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
  status TEXT NOT NULL DEFAULT 'active', -- active|completed|abandoned
  assigned_at INTEGER NOT NULL
);

-- Thing 3: Mission cooldowns (lockouts after quitting)
CREATE TABLE IF NOT EXISTS mission_cooldowns (
  user_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  notify_channel_id TEXT
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

// 1) Cooldowns table safe migration
try { db.exec(`CREATE TABLE mission_cooldowns (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL, notify_channel_id TEXT)`); } catch {}

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
const addZenny  = db.prepare(`UPDATE navis SET zenny = zenny + ? WHERE user_id = ?`);
const setZenny  = db.prepare(`UPDATE navis SET zenny = ? WHERE user_id = ?`);
const updHP     = db.prepare(`UPDATE navis SET max_hp=? WHERE user_id=?`);
const updDodge  = db.prepare(`UPDATE navis SET dodge=? WHERE user_id=?`);
const updCrit   = db.prepare(`UPDATE navis SET crit=? WHERE user_id=?`);
const updWins   = db.prepare(`UPDATE navis SET wins=? WHERE user_id=?`);
const updLosses = db.prepare(`UPDATE navis SET losses=? WHERE user_id=?`);
const updPts    = db.prepare(`UPDATE navis SET upgrade_pts=? WHERE user_id=?`);

const getFight = db.prepare(`SELECT * FROM duel_state WHERE channel_id=?`);
const startFight = db.prepare(`
  INSERT INTO duel_state
    (channel_id,p1_id,p2_id,p1_hp,p2_hp,p1_def,p2_def,p1_counts_json,p2_counts_json,p1_special_used,p2_special_used,p1_action_json,p2_action_json,round_deadline,started_at,
     p1_stunned,p2_stunned,p1_poison_json,p2_poison_json,p1_holy_json,p2_holy_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'[]','[]','[]','[]')
`);
const updFightRound = db.prepare(`
  UPDATE duel_state
     SET p1_hp=?, p2_hp=?,
         p1_def=?, p2_def=?,
         p1_counts_json=?, p2_counts_json=?,
         p1_special_used=?, p2_special_used=?,
         p1_action_json=?, p2_action_json=?,
         round_deadline=?,
         p1_stunned=?, p2_stunned=?,
         p1_poison_json=?, p2_poison_json=?,
         p1_holy_json=?, p2_holy_json=?
   WHERE channel_id=?
`);
const endFight = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

const getPVE = db.prepare(`SELECT * FROM pve_state WHERE channel_id=?`);
const startPVE = db.prepare(`
  INSERT INTO pve_state (
    channel_id, player_id, virus_name, virus_image, virus_max_hp, virus_dodge, virus_crit, virus_is_boss, virus_moves_json, virus_zmin, virus_zmax,
    p_hp, v_hp, p_def, v_def, p_counts_json, p_special_used, v_special_used, player_action_json, virus_action_json, round_deadline, v_def_total, v_def_streak, started_at,
    p_stunned, v_stunned, p_poison_json, v_poison_json, p_holy_json, v_holy_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            0,0,'[]','[]','[]','[]')
`);
const updPVE = db.prepare(`
  UPDATE pve_state
     SET p_hp=?, v_hp=?,
         p_def=?, v_def=?,
         p_counts_json=?, p_special_used=?, v_special_used=?,
         player_action_json=?, virus_action_json=?,
         round_deadline=?,
         v_def_total=?, v_def_streak=?,
         p_stunned=?, v_stunned=?,
         p_poison_json=?, v_poison_json=?,
         p_holy_json=?, v_holy_json=?
   WHERE channel_id=?
`);
const endPVE = db.prepare(`DELETE FROM pve_state WHERE channel_id=?`);

// Chips & inventory
const getChip = db.prepare(`SELECT * FROM chips WHERE name=?`);
const listChips = db.prepare(`SELECT * FROM chips WHERE is_upgrade=0 ORDER BY name COLLATE NOCASE ASC`);
const listAllChipNames = db.prepare(`SELECT name FROM chips ORDER BY name COLLATE NOCASE ASC`);
const listShop = db.prepare(`SELECT * FROM chips WHERE stock=1 ORDER BY is_upgrade ASC, zenny_cost ASC, name COLLATE NOCASE ASC`);
const upsertChip = db.prepare(`
  INSERT INTO chips (name,image_url,effect_json,zenny_cost,is_upgrade,stock) VALUES (?,?,?,?,?,?)
   ON CONFLICT(name) DO UPDATE SET image_url=excluded.image_url,effect_json=excluded.effect_json,zenny_cost=excluded.zenny_cost,is_upgrade=excluded.is_upgrade,stock=excluded.stock
`);
const getInv = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_name=?`);
const setInv = db.prepare(`
  INSERT INTO inventory (user_id,chip_name,qty) VALUES (?,?,?)
   ON CONFLICT(user_id,chip_name) DO UPDATE SET qty=excluded.qty
`);
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
const bumpUpgCountBy = db.prepare(`
  INSERT INTO upgrade_purchases (user_id, upgrade_name, count) VALUES (?,?,?)
  ON CONFLICT(user_id, upgrade_name) DO UPDATE SET count = count + excluded.count
`);

// Missions
const getActiveMission   = db.prepare(`SELECT * FROM missions_active WHERE user_id=? AND status='active'`);
const setActiveMission   = db.prepare(`
  INSERT INTO missions_active (user_id, mission_id, region, target_chip, target_boss, reward_zenny, keep_chip, status, assigned_at)
  VALUES (?,?,?,?,?,?,?, 'active', ?)
  ON CONFLICT(user_id) DO UPDATE SET mission_id=excluded.mission_id, region=excluded.region, target_chip=excluded.target_chip, target_boss=excluded.target_boss, reward_zenny=excluded.reward_zenny, keep_chip=excluded.keep_chip, status='active', assigned_at=excluded.assigned_at
`);
const completeMission    = db.prepare(`UPDATE missions_active SET status='completed' WHERE user_id=? AND mission_id=?`);
const abandonMission     = db.prepare(`UPDATE missions_active SET status='abandoned' WHERE user_id=? AND mission_id=?`);

// Mission cooldown helpers
const getCooldown     = db.prepare(`SELECT until, notify_channel_id FROM mission_cooldowns WHERE user_id=?`);
const setCooldown     = db.prepare(`
  INSERT INTO mission_cooldowns (user_id, until, notify_channel_id) VALUES (?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, notify_channel_id=excluded.notify_channel_id
`);
const clearCooldown   = db.prepare(`DELETE FROM mission_cooldowns WHERE user_id=?`);

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

// 3) ----- Mission cooldown timers -----
const MissionCooldownTimers = new Map(); // userId -> Timeout

function clearMissionCooldownTimer(userId) {
  const t = MissionCooldownTimers.get(userId);
  if (t) { clearTimeout(t); MissionCooldownTimers.delete(userId); }
}

function scheduleMissionCooldown(userId, ms, notifyChannelId) {
  clearMissionCooldownTimer(userId);
  const until = Date.now() + ms;
  setCooldown.run(userId, until, notifyChannelId || null);

  const t = setTimeout(async () => {
    MissionCooldownTimers.delete(userId);
    clearCooldown.run(userId);

    // Try DM first; fallback to channel notice
    try {
      const user = await client.users.fetch(userId);
      await user.send('⏰ Your mission lockout has ended. You may take a new mission with **/bbs_mission**.');
    } catch {
      if (notifyChannelId) {
        try {
          const ch = await client.channels.fetch(notifyChannelId);
          await ch.send(`<@${userId}> ⏰ Your mission lockout has ended. You may take a new mission with **/bbs_mission**.`);
        } catch {}
      }
    }

  }, ms);

  MissionCooldownTimers.set(userId, t);
}

function msToClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,'0')}`;
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
      chip_drop: chipDrop,
      chip_drops: chipDrops,
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
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      console.warn(`[missions] ${res.status} from TSV URL; returning empty list.`);
      return [];
    }
    throw new Error(`Missions TSV fetch failed: ${res.status}`);
  }
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
  return String(k || '').toLowerCase().split(/[+,/\s]+/).filter(Boolean);
}
function isAttack(effect) { const kinds = extractKinds(effect); return kinds.includes('attack') || kinds.includes('break'); }
function isBreak(effect)  { const kinds = extractKinds(effect); return kinds.includes('break'); }
function isSupport(effect){ return extractKinds(effect).includes('support'); }
function isBarrier(effect){ return extractKinds(effect).includes('barrier'); }
function isDefense(effect){ return extractKinds(effect).includes('defense'); }
function isRecovery(effect){ return extractKinds(effect).includes('recovery'); }
function isSpecial(effect) { return !!effect?.special; }
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
// FIX: update only the stat fields to avoid overwriting zenny/record/points
function applyUpgrade(userId, chipRow, qty = 1) {
  const eff = readEffect(chipRow);
  const stat = String(eff?.stat || '').toLowerCase();
  const step = Number.isFinite(eff?.step) ? eff.step : 1;
  const amount = step * Math.max(1, qty);

  const cur = ensureNavi(userId);

  if (stat === 'hp')    updHP.run(Math.min(MAX_HP_CAP,    cur.max_hp + amount), userId);
  if (stat === 'dodge') updDodge.run(Math.min(MAX_DODGE_CAP, cur.dodge + amount), userId);
  if (stat === 'crit')  updCrit.run(Math.min(MAX_CRIT_CAP,  cur.crit  + amount), userId);

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

// Picks a move subject to caps & specials
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
  }

  // Respect total defense cap
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
  if (kinds.includes('paralyze')) bits.push('⚡ Paralyze (stuns next round)');
  if (kinds.includes('poison'))   bits.push('☠️ Poison (3 rounds)');
  if (kinds.includes('holy'))     bits.push('✨ Holy regen (3 rounds)');
  if (kinds.includes('repair'))   bits.push('🔧 Repair (cleanse ticks)');
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
        description: `${r.is_upgrade ? 'Upgrade' : 'Chip'} • ${r.zenny_cost} ${zennyIcon()}`.slice(0, 100)
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

// Admin: Chips catalog pager (all chips, paged)
function buildCatalogPage(rows, page=0, prefix='catalog') {
  const PER = 25;
  const totalPages = Math.max(1, Math.ceil(rows.length / PER));
  page = Math.min(totalPages - 1, Math.max(0, page));
  const start = page * PER;
  const slice = rows.slice(start, start + PER);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${prefix}:select:${page}`)
    .setPlaceholder(`Select a chip (${page+1}/${totalPages})`)
    .addOptions(slice.map(r => ({
      label: r.name.slice(0,100),
      value: r.name,
      description: `${r.is_upgrade ? 'Upgrade' : 'Chip'} • ${r.zenny_cost} ${zennyIcon()}${r.stock?'' : ' • hidden'}`
        .slice(0,100)
    })));

  const prev = new ButtonBuilder().setCustomId(`${prefix}:prev:${page}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page===0);
  const next = new ButtonBuilder().setCustomId(`${prefix}:next:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages-1);
  const close= new ButtonBuilder().setCustomId(`${prefix}:close`).setLabel('Close').setStyle(ButtonStyle.Danger);

  const rowSel = new ActionRowBuilder().addComponents(select);
  const rowNav = new ActionRowBuilder().addComponents(prev, next, close);

  const list = slice.map(r => `• **${r.name}** — ${r.is_upgrade?'Upgrade':'Chip'} — ${r.zenny_cost} ${zennyIcon()}${r.stock?'':' (hidden)'}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(prefix==='grant' ? '🎁 Grant: Chip Catalog (admin)' : '📚 Chips Catalog (admin)')
    .setDescription(list || '—')
    .setFooter({ text: `Items ${start+1}-${Math.min(rows.length,start+PER)} of ${rows.length} • Page ${page+1}/${totalPages}`});
  return { embed, components:[rowSel, rowNav], page, totalPages };
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
  const step = Number(DYN_UPGRADES.get(chipRow.name) || 0) | 0;
  if (!step) return (chipRow.zenny_cost || 0) * qty;
  const r = getUpgCount.get(userId, chipRow.name);
  const n0 = r ? (r.count || 0) : 0;
  const base = chipRow.zenny_cost || 0;
  return qty * base + step * ((qty * (2*n0 + (qty-1))) / 2);
}

// ---------- Status tick helpers ----------
function parsePois(s) {
  const arr = parseList(s);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => (x && typeof x === 'object') ? { dmg: (x.dmg|0), ticks: (x.ticks|0) } : null)
    .filter(x => x && x.dmg > 0 && x.ticks > 0)
    .slice(0,1);
}
function parseHoly(s) {
  const arr = parseList(s);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => (x && typeof x === 'object') ? { heal: (x.heal|0), ticks: (x.ticks|0) } : null)
    .filter(x => x && x.heal > 0 && x.ticks > 0)
    .slice(0,1);
}
function replacePoison(_list, dmg) { const n = Math.max(0, Math.floor(dmg)); return n > 0 ? [{ dmg: n, ticks: 3 }] : []; }
function replaceHoly(_list, heal)  { const n = Math.max(0, Math.floor(heal)); return n > 0 ? [{ heal: n, ticks: 3 }] : []; }
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
        f.p1_stunned|0, f.p2_stunned|0,
        f.p1_poison_json, f.p2_poison_json,
        f.p1_holy_json, f.p2_holy_json,
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
        f.p1_stunned|0, f.p2_stunned|0,
        f.p1_poison_json, f.p2_poison_json,
        f.p1_holy_json, f.p2_holy_json,
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

  let nextPois1 = p1Pois, nextPois2 = p2Pois;
  let nextHoly1 = p1Holy, nextHoly2 = p2Holy;

  const A1raw = decodeAction(f.p1_action_json);
  const A2raw = decodeAction(f.p2_action_json);

  // If neither acted and deadline passed, reschedule another wait
  if (!A1raw && !A2raw) {
    const nextDeadline = now() + ROUND_SECONDS * 1000;
    updFightRound.run(f.p1_hp, f.p2_hp, 0, 0, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, null, null, nextDeadline,
      f.p1_stunned|0, f.p2_stunned|0, f.p1_poison_json, f.p2_poison_json, f.p1_holy_json, f.p2_holy_json, channel.id);
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
      if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0); // fixed ce.heal
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

  // POISON → DoT if landed
  const p1IsPoison = P1.attackEff && isPoison(P1.attackEff) && !dodged1 && !cancelledByBarrier1;
  const p2IsPoison = P2.attackEff && isPoison(P2.attackEff) && !dodged2 && !cancelledByBarrier2;

  let nextPois1Local = nextPois1, nextPois2Local = nextPois2;

  if (p1IsPoison) {
    const tick = (dmg1to2 | 0) + (absorbed1 | 0);
    nextPois2Local = replacePoison(nextPois2Local, tick);
    dmg1to2 = 0;
  }
  if (p2IsPoison) {
    const tick = (dmg2to1 | 0) + (absorbed2 | 0);
    nextPois1Local = replacePoison(nextPois1Local, tick);
    dmg2to1 = 0;
  }

  nextPois1 = nextPois1Local;
  nextPois2 = nextPois2Local;

  // HOLY self-apply (non-stacking)
  const p1HolyAmt = P1.holyAmt || 0;
  const p2HolyAmt = P2.holyAmt || 0;

  let nextHoly1Local = nextHoly1, nextHoly2Local = nextHoly2;

  if (p1HolyAmt > 0) nextHoly1Local = replaceHoly(nextHoly1Local, p1HolyAmt);
  if (p2HolyAmt > 0) nextHoly2Local = replaceHoly(nextHoly2Local, p2HolyAmt);

  // REPAIR
  if (P1.repair) { nextPois1Local = []; nextHoly1Local = []; }
  if (P2.repair) { nextPois2Local = []; nextHoly2Local = []; }

  // PARALYZE: set stun for next round if the hit landed
  let paraP2 = false, paraP1 = false;
  if (P1.attackEff && isParalyze(P1.attackEff) && !dodged1 && !cancelledByBarrier1) paraP2 = true;
  if (P2.attackEff && isParalyze(P2.attackEff) && !dodged2 && !cancelledByBarrier2) paraP1 = true;

  // Immediate hp after direct dmg + instant rec (ticks after)
  let p1hp = Math.max(0, Math.min(p1.max_hp, f.p1_hp - dmg2to1 + rec1));
  let p2hp = Math.max(0, Math.min(p2.max_hp, f.p2_hp - dmg1to2 + rec2));

  // Apply ticks (poison hurts, holy heals)
  const { total: tickPoisonP1, next: poisAfterP1 } = tickPois(nextPois1Local);
  const { total: tickPoisonP2, next: poisAfterP2 } = tickPois(nextPois2Local);
  const { total: tickHolyP1,   next: holyAfterP1 } = tickHoly(nextHoly1Local);
  const { total: tickHolyP2,   next: holyAfterP2 } = tickHoly(nextHoly2Local);

  p1hp = Math.max(0, Math.min(p1.max_hp, p1hp - tickPoisonP1 + tickHolyP1));
  p2hp = Math.max(0, Math.min(p2.max_hp, p2hp - tickPoisonP2 + tickHolyP2));

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
  const p1IsBot = f.p1_id === client.user.id;
  const p2IsBot = f.p2_id === client.user.id;

  if (p1hp === 0 && p2hp === 0) {
    outcome = '🤝 **Double KO!** No W/L changes.';
  } else if (p1hp === 0) {
    outcome = `🏆 **<@${f.p2_id}> wins**!`;
    if (!p1IsBot && !p2IsBot) { setRecord.run(0, 1, f.p1_id); setRecord.run(1, 0, f.p2_id); }
  } else if (p2hp === 0) {
    outcome = `🏆 **<@${f.p1_id}> wins**!`;
    if (!p1IsBot && !p2IsBot) { setRecord.run(1, 0, f.p1_id); setRecord.run(0, 1, f.p2_id); }
  }

  // Apply stuns (for next round)
  const nextP1Stun = paraP1 ? 1 : 0;
  const nextP2Stun = paraP2 ? 1 : 0;

  // Build round lines with conditional tick visibility
  const lines = [
    `🎲 **Round resolved!**`,
    `• <@${f.p1_id}> used: ${P1.used?.map(n=>`**${n}**`).join(' + ') || '—'}`,
    `• <@${f.p2_id}> used: ${P2.used?.map(n=>`**${n}**`).join(' + ') || '—'}`,
    `• Damage dealt: <@${f.p1_id}> → **${dmg1to2}** | <@${f.p2_id}> → **${dmg2to1}**`,
    (absorbed1 || absorbed2) ? `• Absorbed by DEF: P1→**${absorbed2}** | P2→**${absorbed1}**` : null,
    (crit1 || crit2) ? `• Crits: P1→${crit1?'✅':'❌'} | P2→${crit2?'✅':'❌'}` : null,
    (dodged1 || dodged2) ? `• Dodges: P1→${dodged2?'✅':'❌'} | P2→${dodged1?'✅':'❌'}` : null,
    (tickPoisonP1 || tickPoisonP2 || nextPois1Local.length || nextPois2Local.length)
      ? `• Poison ticks: P1 **-${tickPoisonP1}** | P2 **-${tickPoisonP2}**` : null,
    (tickHolyP1 || tickHolyP2 || nextHoly1Local.length || nextHoly2Local.length)
      ? `• Holy ticks: P1 **+${tickHolyP1}** | P2 **+${tickHolyP2}**` : null,
    '',
    hpLineDuel({ ...f, p1_hp: p1hp, p2_hp: p2hp }),
  ].filter(Boolean);

  if (outcome) {
    endFight.run(channel.id);
    clearRoundTimer(channel.id);
    lines.push(outcome);
    await channel.send(lines.join('\n'));
    return;
  }

  // Persist next state and schedule next round (PvP only)
  const nextDeadline = now() + ROUND_SECONDS * 1000;
  const nextP1Counts = JSON.stringify(p1Counts);
  const nextP2Counts = JSON.stringify(p2Counts);
  const nextP1Spec = JSON.stringify(Array.from(p1Spec));
  const nextP2Spec = JSON.stringify(Array.from(p2Spec));

  db.exec(`
    UPDATE duel_state SET
      p1_hp='${p1hp}', p2_hp='${p2hp}',
      p1_def=0, p2_def=0,
      p1_counts_json='${nextP1Counts.replace(/'/g,"''")}',
      p2_counts_json='${nextP2Counts.replace(/'/g,"''")}',
      p1_special_used='${nextP1Spec.replace(/'/g,"''")}',
      p2_special_used='${nextP2Spec.replace(/'/g,"''")}',
      p1_action_json=NULL, p2_action_json=NULL,
      round_deadline='${nextDeadline}',
      p1_stunned='${nextP1Stun}', p2_stunned='${nextP2Stun}',
      p1_poison_json='${JSON.stringify(poisAfterP1).replace(/'/g,"''")}',
      p2_poison_json='${JSON.stringify(poisAfterP2).replace(/'/g,"''")}',
      p1_holy_json='${JSON.stringify(holyAfterP1).replace(/'/g,"''")}',
      p2_holy_json='${JSON.stringify(holyAfterP2).replace(/'/g,"''")}'
    WHERE channel_id='${channel.id}';
  `);

  scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));
  lines.push(`⏳ Next round: **${ROUND_SECONDS}s** — play with **/use**`);
  await channel.send(lines.join('\n'));
}

// ---------- Round resolution (PVE) ----------
async function resolvePveRound(channel) {
  const s0 = getPVE.get(channel.id);
  if (!s0) return;

  const player = ensureNavi(s0.player_id);

  // Virus pick if needed (no timers in PVE)
  let s = s0;
  if (!s.virus_action_json && !(s.v_stunned > 0)) {
    const mv = pickVirusMove(s);
    if (mv) {
      updPVE.run(
        s.p_hp, s.v_hp,
        s.p_def, s.v_def,
        s.p_counts_json, s.p_special_used, s.v_special_used,
        s.player_action_json, JSON.stringify(mv),
        0, s.v_def_total, s.v_def_streak,
        s.p_stunned|0, s.v_stunned|0,
        s.p_poison_json, s.v_poison_json,
        s.p_holy_json, s.v_holy_json,
        channel.id
      );
      s = getPVE.get(channel.id);
    }
  }

  const APlayer = decodeAction(s.player_action_json);
  const AVirus  = decodeAction(s.virus_action_json);

  if (!APlayer && !AVirus) {
    // Just prompt; no timer
    await channel.send(`▶️ Your turn. Play with **/use**.\n${hpLinePVE(getPVE.get(channel.id))}`);
    return;
  }

  const rowAndEff = (name) => {
    const r = getChip.get(name);
    const e = readEffect(r);
    return { r, e };
  };

  const interpret = (inv) => {
    const empty = { def:0, barrier:false, attackEff:null, rec:0, used:[], supportEff:null, repair:false, holyAmt:0 };
    if (!inv) return empty;

    const looksLikeVirusMove =
      inv && !inv.type &&
      (inv.kinds || inv.kind ||
       Number.isFinite(inv.dmg) || Number.isFinite(inv.def) ||
       Number.isFinite(inv.heal) || Number.isFinite(inv.rec) || inv.special);

    if (looksLikeVirusMove) {
      const e = inv;
      let def=0, barrier=false, attackEff=null, rec=0;
      if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
      if (isBarrier(e)) barrier = true;
      if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
      if (isAttack(e))  attackEff = e;
      const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
      const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0;
      const usedName = e.name || e.label || 'Move';
      return { def, barrier, attackEff, rec, used:[usedName], supportEff:null, repair:isRepair(e), holyAmt };
    }

    if (inv.type === 'chip') {
      const { r, e } = rowAndEff(inv.name);
      if (!r) return empty;
      let def=0, barrier=false, attackEff=null, rec=0;
      if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
      if (isBarrier(e)) barrier = true;
      if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
      if (isAttack(e))  attackEff = e;
      const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
      const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0;
      return { def, barrier, attackEff, rec, used:[r.name], supportEff:null, repair:isRepair(e), holyAmt };
    }

    if (inv.type === 'support') {
      const { r: sr, e: se } = rowAndEff(inv.support);
      const { r: cr, e: ce } = rowAndEff(inv.with);
      if (!sr || !cr) return empty;
      let def=0, barrier=false, attackEff=null, rec=0;
      if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
      if (isBarrier(ce)) barrier = true;
      if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0);
      if (isAttack(ce))  attackEff = ce;
      const holyGuess = Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : (Number.isFinite(ce.dmg) ? ce.dmg : 0));
      const holyAmt = isHoly(ce) ? Math.max(0, holyGuess|0) : 0;
      if (holyAmt > 0) rec = 0;
      return { def, barrier, attackEff, rec, used:[sr.name, cr.name], supportEff: se, repair:isRepair(ce), holyAmt };
    }

    return empty;
  };

  const pStunned = (s.p_stunned || 0) > 0;
  const vStunned = (s.v_stunned || 0) > 0;

  const P = pStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], supportEff:null, repair:false, holyAmt:0 } : interpret(APlayer);
  const V = vStunned ? { def:0, barrier:false, attackEff:null, rec:0, used:[], supportEff:null, repair:false, holyAmt:0 } : interpret(AVirus);

  let pDEF = P.def|0, vDEF = V.def|0;
  const pBarrier = !!P.barrier, vBarrier = !!V.barrier;

  // AI caps tracking
  let vDefTotal = Number(s.v_def_total||0);
  let vDefStreak = Number(s.v_def_streak||0);
  if (AVirus && isDefLikeMove(AVirus)) {
    vDefTotal++;
    vDefStreak++;
  } else {
    vDefStreak = 0;
  }

  // Damage
  let dmgPtoV=0, critP=false, dodgedP=false, absorbedP=0, cancelledByBarrierP=false;
  if (P.attackEff) {
    const res = computeAttackDamage({
      baseChip: P.attackEff, supportEff: P.supportEff,
      defenderDEF: vDEF, defenderHasBarrier: vBarrier,
      breakFlag: isBreak(P.attackEff), dodgePct: s.virus_dodge, critPct: player.crit,
    });
    ({ dmg: dmgPtoV, crit: critP, dodged: dodgedP, absorbed: absorbedP, cancelledByBarrier: cancelledByBarrierP } = res);
  }

  let dmgVtoP=0, critV=false, dodgedV=false, absorbedV=0, cancelledByBarrierV=false;
  if (V.attackEff) {
    const res = computeAttackDamage({
      baseChip: V.attackEff, supportEff: V.supportEff,
      defenderDEF: pDEF, defenderHasBarrier: pBarrier,
      breakFlag: isBreak(V.attackEff), dodgePct: player.dodge, critPct: s.virus_crit,
    });
    ({ dmg: dmgVtoP, crit: critV, dodged: dodgedV, absorbed: absorbedV, cancelledByBarrier: cancelledByBarrierV } = res);
  }

  // Immediate recovery (suppressed by enemy barrier if your attack was cancelled)
  let pRec = P.rec||0; if (P.attackEff && vBarrier && !isBreak(P.attackEff)) pRec = 0;
  let vRec = V.rec||0; if (V.attackEff && pBarrier && !isBreak(V.attackEff)) vRec = 0;

  // Status JSONs
  const pPois = parsePois(s.p_poison_json);
  const vPois = parsePois(s.v_poison_json);
  const pHoly = parseHoly(s.p_holy_json);
  const vHoly = parseHoly(s.v_holy_json);
  let nextPoisP = pPois, nextPoisV = vPois;
  let nextHolyP = pHoly, nextHolyV = vHoly;

  if (P.attackEff && isPoison(P.attackEff) && !dodgedP && !cancelledByBarrierP) {
    const t = (dmgPtoV|0) + (absorbedP|0);
    nextPoisV = replacePoison(nextPoisV, t);
    dmgPtoV = 0;
  }
  if (V.attackEff && isPoison(V.attackEff) && !dodgedV && !cancelledByBarrierV) {
    const t = (dmgVtoP|0) + (absorbedV|0);
    nextPoisP = replacePoison(nextPoisP, t);
    dmgVtoP = 0;
  }

  if (P.holyAmt > 0) nextHolyP = replaceHoly(nextHolyP, P.holyAmt);
  if (V.holyAmt > 0) nextHolyV = replaceHoly(nextHolyV, V.holyAmt);

  if (P.repair) { nextPoisP = []; nextHolyP = []; }
  if (V.repair) { nextPoisV = []; nextHolyV = []; }

  const stunVNext = (P.attackEff && isParalyze(P.attackEff) && !dodgedP && !cancelledByBarrierP) ? 1 : 0;
  const stunPNext = (V.attackEff && isParalyze(V.attackEff) && !dodgedV && !cancelledByBarrierV) ? 1 : 0;

  let php = Math.max(0, Math.min(player.max_hp, s.p_hp - dmgVtoP + pRec));
  let vhp = Math.max(0, Math.min(s.virus_max_hp, s.v_hp - dmgPtoV + vRec));

  const { total: tPoisP, next: poisAfterP } = tickPois(nextPoisP);
  const { total: tPoisV, next: poisAfterV } = tickPois(nextPoisV);
  const { total: tHolyP, next: holyAfterP } = tickHoly(nextHolyP);
  const { total: tHolyV, next: holyAfterV } = tickHoly(nextHolyV);

  php = Math.max(0, Math.min(player.max_hp, php - tPoisP + tHolyP));
  vhp = Math.max(0, Math.min(s.virus_max_hp, vhp - tPoisV + tHolyV));

  const pCounts = parseMap(s.p_counts_json);
  const pSpec = new Set(parseList(s.p_special_used));
  for (const n of (P.used || [])) {
    pCounts[n] = (pCounts[n] || 0) + 1;
    const eff = readEffect(getChip.get(n));
    if (isSpecial(eff)) pSpec.add(n);
  }

  const vSpec = new Set(parseList(s.v_special_used));
  if (AVirus?.special) {
    const vUsedName =
      (V.used && V.used[0]) ||
      AVirus.name ||
      AVirus.label ||
      'special';
    vSpec.add(vUsedName);
  }

  const lines = [
    `🎲 **Round resolved!**`,
    `• You used: ${P.used?.map(n=>`**${n}**`).join(' + ') || '—'}`,
    `• Virus used: ${V.used?.map(n=>`**${n}**`).join(' + ') || (AVirus?.name || '—')}`,
    `• Damage dealt: You → **${dmgPtoV}** | Virus → **${dmgVtoP}**`,
    (absorbedP || absorbedV) ? `• Absorbed by DEF: You→**${absorbedV}** | Virus→**${absorbedP}**` : null,
    (critP || critV) ? `• Crits: You→${critP?'✅':'❌'} | Virus→${critV?'✅':'❌'}` : null,
    (dodgedP || dodgedV) ? `• Dodges: You→${dodgedV?'✅':'❌'} | Virus→${dodgedP?'✅':'❌'}` : null,
    (tPoisP || tPoisV || nextPoisP.length || nextPoisV.length) ? `• Poison ticks: You **-${tPoisP}** | Virus **-${tPoisV}**` : null,
    (tHolyP || tHolyV || nextHolyP.length || nextHolyV.length) ? `• Holy ticks: You **+${tHolyP}** | Virus **+${tHolyV}**` : null,
    '',
    hpLinePVE({ ...s, p_hp: php, v_hp: vhp }),
  ].filter(Boolean);

  if (php === 0 && vhp === 0) {
    endPVE.run(channel.id);
    await channel.send(lines.concat('🤝 **Double KO!**').join('\n'));
    return;
  }
  if (vhp === 0) {
    const z = Math.max(0, Math.floor(Math.random() * (s.virus_zmax - s.virus_zmin + 1)) + s.virus_zmin);
    if (z) addZenny.run(s.player_id, z);

    let dropLine = '';
    if (Math.random() < VIRUS_CHIP_DROP_PCT) {
      try {
        const viruses = await loadViruses(false);
        const vr = viruses.find(v => v.name === s.virus_name);
        const drops = vr?.chip_drops || [];
        if (drops.length) {
          const pick = drops[Math.floor(Math.random() * drops.length)];
          invAdd(s.player_id, pick, 1);
          dropLine = `\n📦 Chip drop: **${pick}** (+1)`;
        }
      } catch {}
    }

    let missionLine = '';
    try {
      const am = getActiveMission.get(s.player_id);
      if (am) {
        const chipMatch = am.target_chip && (P.used||[]).some(n => normalize(n) === normalize(am.target_chip));
        const bossMatch = am.target_boss && normalize(s.virus_name) === normalize(am.target_boss);
        if (chipMatch || bossMatch) {
          completeMission.run(s.player_id, am.mission_id);
          if (am.reward_zenny) addZenny.run(s.player_id, am.reward_zenny);
          missionLine = `\n🧾 Mission **${am.mission_id}** completed! +${am.reward_zenny} ${zennyIcon()}`;
        }
      }
    } catch {}

    endPVE.run(channel.id);
    await channel.send(lines.concat([`🏆 **Victory!** You defeated **${s.virus_name}**.`, z ? `+${z} ${zennyIcon()} awarded.` : '', dropLine, missionLine].filter(Boolean)).join('\n'));
    return;

  }
  if (php === 0) {
    endPVE.run(channel.id);
    await channel.send(lines.concat(`💀 **Defeat...** Try again with **/virus_busting**.`).join('\n'));
    return;
  }

  // Persist next state (no timer)
  const nextCounts = JSON.stringify(pCounts);
  const nextSpec = JSON.stringify(Array.from(pSpec));

  db.exec(`
    UPDATE pve_state SET
      p_hp='${php}', v_hp='${vhp}',
      p_def=0, v_def=0,
      p_counts_json='${nextCounts.replace(/'/g,"''")}',
      p_special_used='${nextSpec.replace(/'/g,"''")}',
      v_special_used='${JSON.stringify(Array.from(vSpec)).replace(/'/g,"''")}',
      player_action_json=NULL, virus_action_json=NULL,
      round_deadline='0',
      v_def_total='${vDefTotal}', v_def_streak='${vDefStreak}',
      p_stunned='${stunPNext}', v_stunned='${stunVNext}',
      p_poison_json='${JSON.stringify(poisAfterP).replace(/'/g,"''")}',
      v_poison_json='${JSON.stringify(poisAfterV).replace(/'/g,"''")}',
      p_holy_json='${JSON.stringify(holyAfterP).replace(/'/g,"''")}',
      v_holy_json='${JSON.stringify(holyAfterV).replace(/'/g,"''")}'
    WHERE channel_id='${channel.id}';
  `);

  // Immediately prompt next action (no countdown)
  await channel.send(lines.concat(`▶️ Your turn. Play with **/use**.`).join('\n'));
}

// ---------- Virus selection ----------
async function pickVirusForUser(userId) {
  const loc = ensureLoc(userId);
  const viruses = await loadViruses(false);
  let pool = viruses;
  if (loc?.region) pool = pool.filter(v => !v.region || normalize(v.region) === normalize(loc.region));
  if (loc?.zone)   pool = pool.filter(v => !v.zone || Number(v.zone) === Number(loc.zone));
  if (!pool.length) pool = viruses;
  return weightedPick(pool);
}

// Give starters (zenny + chips) if the user looks fresh
function grantStartersIfNeeded(userId) {
  const n = ensureNavi(userId);
  if (STARTER_ZENNY > 0 && (n.zenny|0) < STARTER_ZENNY) {
    setZenny.run(STARTER_ZENNY, userId);
  }
  const owned = listInv.all(userId).reduce((s,r)=>s + (r.qty||0), 0);
  if (owned === 0 && STARTER_CHIPS.length) {
    for (const ent of starterEntries()) {
      invAdd(userId, ent.name, ent.qty);
    }
  }
}

// ---------- Admin Grant UI state ----------
const GrantState = new Map(); // adminUserId -> { chipName, qty, targetUserId, page }

// ---------- Interaction handlers ----------
client.on('interactionCreate', async (ix) => {
  try {
    // -------- Autocomplete --------
    if (ix.isAutocomplete()) {
      const focused = ix.options.getFocused(true);
      const name = ix.commandName;

      if (name === 'virus_search' && focused.name === 'name') {
        const viruses = await loadViruses(false);
        const q = (focused.value || '').toLowerCase();
        const opts = viruses
          .filter(v => !q || v.name.toLowerCase().includes(q))
          .slice(0, 25)
          .map(v => ({ name: v.name, value: v.name }));
        await ix.respond(opts);
        return;
      }

      // Personalized autocomplete for /use: only user's folder; for 'support' filter by support kind
      if (name === 'use') {
        const q = (focused.value || '').toLowerCase();
        const inv = listInv.all(ix.user.id); // [{chip_name, qty}]
        const names = inv.map(r => r.chip_name);
        let rows = names.map(n => getChip.get(n)).filter(Boolean);
        if (focused.name === 'support') {
          rows = rows.filter(r => isSupport(readEffect(r)));
        } else if (focused.name === 'chip') {
          rows = rows.filter(r => !r.is_upgrade);
        }
        const opts = rows
          .filter(r => r.name.toLowerCase().includes(q))
          .sort((a,b)=> a.name.localeCompare(b.name))
          .slice(0,25)
          .map(r => ({ name:r.name, value:r.name }));
        await ix.respond(opts);
        return;
      }

      // Admin chip_grant/remove autocomplete (global names, 25 max due to Discord)
      if ((name === 'chip_grant' || name === 'chip_remove') && focused.name === 'name') {
        const q = (focused.value || '').toLowerCase();
        const names = listAllChipNames.all().map(r => r.name);
        const opts = names.filter(n => n.toLowerCase().includes(q)).slice(0,25).map(n => ({ name:n, value:n }));
        await ix.respond(opts);
        return;
      }

      // Default: global names
      const q = (focused.value || '').toLowerCase();
      const names = listAllChipNames.all().map(r => r.name);
      const opts = names
        .filter(n => n.toLowerCase().includes(q))
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));
      await ix.respond(opts);
      return;
    }

    // -------- Buttons/Menus (Components) --------
    if (ix.isButton() || ix.isStringSelectMenu() || ix.isUserSelectMenu()) {
      const id = ix.customId || '';
      // --- Shop pager ---
      if (id.startsWith('shop:')) {
        const parts = id.split(':'); // shop:action:page
        const action = parts[1];
        const page = parseInt(parts[2] || '0', 10) || 0;

        const rows = listShop.all();
        if (!rows.length) {
          await ix.reply({ content: '🛒 The shop is empty.', ephemeral: true });
          return;
        }

        if (ix.isStringSelectMenu() && action === 'select') {
          const name = (ix.values && ix.values[0]) || null;
          const r = name ? getChip.get(name) : null;
          if (!r) return ix.deferUpdate();

          const eff = readEffect(r);
          const embed = new EmbedBuilder()
            .setTitle(`${r.is_upgrade ? '🧩 Upgrade' : '🎴 Chip'} — ${r.name}`)
            .setDescription(summarizeEffect(eff))
            .addFields(
              { name: 'Price', value: `${dynamicUpgradeCostFor(ix.user.id, r)} ${zennyIcon()}`, inline: true },
              { name: 'Stock', value: r.stock ? 'Available' : 'Hidden', inline: true }
            );

          const buy1 = new ButtonBuilder().setCustomId(`shop:buy:${r.name}:1:${page}`).setLabel('Buy 1').setStyle(ButtonStyle.Primary);
          const buy5 = new ButtonBuilder().setCustomId(`shop:buy:${r.name}:5:${page}`).setLabel('Buy 5').setStyle(ButtonStyle.Secondary);
          const close = new ButtonBuilder().setCustomId(`shop:close`).setLabel('Close').setStyle(ButtonStyle.Danger);
          const back  = new ButtonBuilder().setCustomId(`shop:back:${page}`).setLabel('Back').setStyle(ButtonStyle.Secondary);

          await ix.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(buy1, buy5, back, close)] });
          return;
        }

        if (action === 'buy') {
          const [_shop, _buy, chipName, qtyStr, fromPage] = id.split(':');
          const qty = Math.max(1, parseInt(qtyStr || '1', 10) || 1);
          const row = getChip.get(chipName);
          if (!row) return ix.reply({ content: '❌ That item no longer exists.', ephemeral: true });

          const total = row.is_upgrade ? dynamicUpgradeTotalFor(ix.user.id, row, qty) : (row.zenny_cost || 0) * qty;
          const you = ensureNavi(ix.user.id);
          if ((you.zenny | 0) < total) {
            await ix.reply({ content: `❌ Not enough ${zennyIcon()}. You need **${total}**.`, ephemeral: true });
            return;
          }

          // Deduct & grant
          addZenny.run(ix.user.id, -total);
          if (row.is_upgrade) {
            applyUpgrade(ix.user.id, row, qty);
            bumpUpgCountBy.run(ix.user.id, row.name, qty);
          } else {
            invAdd(ix.user.id, row.name, qty);
          }

          await ix.reply({ content: `✅ Purchased **${qty}× ${row.name}** for **${total}** ${zennyIcon()}.`, ephemeral: true });

          // Return to the same page
          const { embed, components } = buildShopPage(rows, parseInt(fromPage || '0', 10) || 0);
          try {
            await ix.message.edit({ embeds: [embed], components });
          } catch {}
          return;
        }

        if (action === 'prev' || action === 'next' || action === 'back') {
          const at = action === 'prev' ? Math.max(0, page - 1) : (action === 'next' ? page + 1 : page);
          const { embed, components } = buildShopPage(rows, at);
          await ix.update({ embeds: [embed], components });
          return;
        }
        if (action === 'close') {
         try { await ix.message.delete(); }
catch { await ix.deferUpdate(); }
          return;
        }
      }

      // --- Catalog (admin browse) ---
      if (id.startsWith('catalog:') && isAdmin(ix)) {
        const rows = listAllChipNames.all().map(({ name }) => getChip.get(name)).filter(Boolean);
        const [prefix, action, pageStr] = id.split(':');
        const page = parseInt(pageStr || '0', 10) || 0;

        if (ix.isStringSelectMenu() && action === 'select') {
          const name = (ix.values && ix.values[0]) || null;
          const r = name ? getChip.get(name) : null;
          if (!r) return ix.deferUpdate();
          const eff = readEffect(r);
          const embed = new EmbedBuilder()
            .setTitle(`📚 ${r.is_upgrade ? 'Upgrade' : 'Chip'} — ${r.name}`)
            .setDescription(summarizeEffect(eff))
            .addFields(
              { name: 'Price', value: `${r.zenny_cost} ${zennyIcon()}`, inline: true },
              { name: 'In Shop', value: r.stock ? 'Yes' : 'No', inline: true }
            );
          const back = new ButtonBuilder().setCustomId(`catalog:back:${page}`).setLabel('Back').setStyle(ButtonStyle.Secondary);
          const close= new ButtonBuilder().setCustomId(`catalog:close`).setLabel('Close').setStyle(ButtonStyle.Danger);
          await ix.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(back, close)] });
          return;
        }

        if (action === 'prev' || action === 'next' || action === 'back') {
          const at = action === 'prev' ? Math.max(0, page - 1) : (action === 'next' ? page + 1 : page);
          const { embed, components } = buildCatalogPage(rows, at, 'catalog');
          await ix.update({ embeds: [embed], components });
          return;
        }
        if (action === 'close') {
          try { await ix.message.delete(); }
catch { await ix.deferUpdate(); }
          return;
        }
      }

      // --- Grant (admin interactive grant) ---
      if (id.startsWith('grant:') && isAdmin(ix)) {
        const rows = listAllChipNames.all().map(({ name }) => getChip.get(name)).filter(Boolean);
        const [prefix, action, pageStr] = id.split(':');
        const page = parseInt(pageStr || '0', 10) || 0;
        const state = GrantState.get(ix.user.id) || { page: 0 };

        // Select a chip from catalog
        if (ix.isStringSelectMenu() && action === 'select') {
          const name = (ix.values && ix.values[0]) || null;
          if (!name) return ix.deferUpdate();
          state.chipName = name;
          GrantState.set(ix.user.id, state);

          const pickUser = new UserSelectMenuBuilder().setCustomId(`grant:user:${page}`).setPlaceholder('Pick a recipient…').setMinValues(1).setMaxValues(1);
          const rowUser = new ActionRowBuilder().addComponents(pickUser);
          const qty1 = new ButtonBuilder().setCustomId(`grant:qty:${page}:1`).setLabel('+1').setStyle(ButtonStyle.Primary);
          const qty5 = new ButtonBuilder().setCustomId(`grant:qty:${page}:5`).setLabel('+5').setStyle(ButtonStyle.Secondary);
          const give = new ButtonBuilder().setCustomId(`grant:do:${page}`).setLabel('Grant').setStyle(ButtonStyle.Success).setDisabled(!state.targetUserId);
          const back = new ButtonBuilder().setCustomId(`grant:back:${page}`).setLabel('Back').setStyle(ButtonStyle.Secondary);
          const close= new ButtonBuilder().setCustomId(`grant:close`).setLabel('Close').setStyle(ButtonStyle.Danger);

          state.qty = state.qty || 1;
          GrantState.set(ix.user.id, state);

          await ix.update({
            content: `🎁 **Granting ${name}**\nQty: **${state.qty}**\nTarget: ${state.targetUserId ? `<@${state.targetUserId}>` : '*none*'}`,
            embeds: [],
            components: [rowUser, new ActionRowBuilder().addComponents(qty1, qty5, give, back, close)]
          });
          return;
        }

        // Pick user
        if (ix.isUserSelectMenu() && action === 'user') {
          const uid = (ix.values && ix.values[0]) || null;
          state.targetUserId = uid;
          GrantState.set(ix.user.id, state);
          await ix.update({ content: `🎁 **Granting ${state.chipName || '(pick a chip)'}**\nQty: **${state.qty || 1}**\nTarget: ${uid ? `<@${uid}>` : '*none*'}` });
          return;
        }

        if (action === 'qty') {
          const amt = parseInt((id.split(':')[3]) || '1', 10) || 1;
          state.qty = Math.max(1, (state.qty || 1) + amt);
          GrantState.set(ix.user.id, state);
          await ix.update({ content: `🎁 **Granting ${state.chipName || '(pick a chip)'}**\nQty: **${state.qty}**\nTarget: ${state.targetUserId ? `<@${state.targetUserId}>` : '*none*'}` });
          return;
        }

        if (action === 'do') {
          if (!state.chipName || !state.targetUserId) {
            await ix.reply({ content: '❌ Pick a chip and a target user first.', ephemeral: true });
            return;
          }
          invAdd(state.targetUserId, state.chipName, state.qty || 1);
          await ix.reply({ content: `✅ Granted **${state.qty || 1}× ${state.chipName}** to <@${state.targetUserId}>.`, ephemeral: true });
          return;
        }

        if (action === 'prev' || action === 'next' || action === 'back') {
          const at = action === 'prev' ? Math.max(0, page - 1) : (action === 'next' ? page + 1 : page);
          const { embed, components } = buildCatalogPage(rows, at, 'grant');
          await ix.update({ content: '', embeds: [embed], components });
          return;
        }

        if (action === 'close') {
          GrantState.delete(ix.user.id);
         try { await ix.message.delete(); } catch { await ix.deferUpdate(); }
          return;
        }
      }

      // Unknown component: ignore
      return;
    }

    // -------- Slash Commands --------
    if (!ix.isChatInputCommand()) return;

    // Shared helpers
    const requireNoCombat = async () => {
      if (getFight.get(ix.channelId) || getPVE.get(ix.channelId)) {
        await ix.reply({ content: '⛔ There is already an active duel/encounter in this channel.', ephemeral: true });
        return false;
      }
      return true;
    };

    switch (ix.commandName) {
      case 'navi_register': {
        const exists = getNavi.get(ix.user.id);
        if (exists) { await ix.reply({ content: '✅ You already have a Navi.', ephemeral: true }); }
        else {
          ensureNavi(ix.user.id);
          grantStartersIfNeeded(ix.user.id);
          await ix.reply({ content: '🆕 Navi registered! Use **/shop** and **/folder** to get started.', ephemeral: true });
        }
        break;
      }

      case 'navi_stats': {
        const target = ix.options.getUser('user') || ix.user;
        const n = ensureNavi(target.id);
        await ix.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`📊 Navi Stats — ${target.username}`)
              .addFields(
                { name: 'Max HP', value: String(n.max_hp), inline: true },
                { name: 'Dodge', value: `${n.dodge}%`, inline: true },
                { name: 'Crit', value: `${n.crit}%`, inline: true },
                { name: 'Record', value: `${n.wins}-${n.losses}`, inline: true },
                { name: 'Points', value: String(n.upgrade_pts), inline: true },
                { name: 'Zenny', value: `${n.zenny} ${zennyIcon()}`, inline: true },
              )
          ],
          ephemeral: false
        });
        break;
      }

      case 'navi_upgrade': {
        const stat = ix.options.getString('stat', true);
        const amount = ix.options.getInteger('amount') ?? 1;
        const n = ensureNavi(ix.user.id);

        if (MANUAL_UPGRADES_MODE === 'points') {
          // Spend upgrade points
          if (stat === 'hp') {
            const steps = Math.max(1, amount | 0);
            const cost = steps * HP_POINTS_PER_STEP;
            if (n.upgrade_pts < cost) return ix.reply({ content: `❌ Need **${cost}** points. You have **${n.upgrade_pts}**.`, ephemeral: true });
            const newHP = Math.min(MAX_HP_CAP, n.max_hp + (HP_STEP_SIZE * steps));
            updHP.run(newHP, ix.user.id);
            addPoints.run(-cost, ix.user.id);
            return ix.reply({ content: `✅ +${HP_STEP_SIZE * steps} Max HP (now **${newHP}**). Spent **${cost}** pts.`, ephemeral: true });
          }
          // crit/dodge
          const cost = CRIT_DODGE_COST * Math.max(1, amount | 0);
          if (n.upgrade_pts < cost) return ix.reply({ content: `❌ Need **${cost}** points. You have **${n.upgrade_pts}**.`, ephemeral: true });
          if (stat === 'dodge') {
            const v = Math.min(MAX_DODGE_CAP, n.dodge + Math.max(1, amount | 0));
            updDodge.run(v, ix.user.id);
            addPoints.run(-cost, ix.user.id);
            return ix.reply({ content: `✅ +${Math.max(1, amount | 0)} Dodge (now **${v}%**). Spent **${cost}** pts.`, ephemeral: true });
          }
          if (stat === 'crit') {
            const v = Math.min(MAX_CRIT_CAP, n.crit + Math.max(1, amount | 0));
            updCrit.run(v, ix.user.id);
            addPoints.run(-cost, ix.user.id);
            return ix.reply({ content: `✅ +${Math.max(1, amount | 0)} Crit (now **${v}%**). Spent **${cost}** pts.`, ephemeral: true });
          }
          return ix.reply({ content: '❌ Invalid stat.', ephemeral: true });
        } else {
          // Admin/manual mode only; points not used
          return ix.reply({ content: 'ℹ️ Manual upgrade mode is not points-based. Use **/shop** upgrades or admin commands.', ephemeral: true });
        }
      }

      case 'navi_leaderboard': {
        const limit = Math.min(25, Math.max(5, ix.options.getInteger('limit') ?? 10));
        const rows = db.prepare(`SELECT user_id, wins, losses FROM navis ORDER BY (wins - losses) DESC, wins DESC LIMIT ?`).all(limit);
        if (!rows.length) return ix.reply('No players yet.');
        const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> — **${r.wins}-${r.losses}**`).join('\n');
        await ix.reply({ embeds: [new EmbedBuilder().setTitle('🏆 Leaderboard').setDescription(lines)] });
        break;
      }

      case 'zenny': {
        const target = ix.options.getUser('user') || ix.user;
        const n = ensureNavi(target.id);
        await ix.reply(`${zennyIcon()} **${target.username}** has **${n.zenny}**.`);
        break;
      }

      case 'shop': {
        const rows = listShop.all();
        if (!rows.length) return ix.reply('🛒 The shop is empty.');
        const { embed, components } = buildShopPage(rows, 0);
        await ix.reply({ embeds: [embed], components });
        break;
      }

      case 'folder': {
        const inv = listInv.all(ix.user.id);
        if (!inv.length) return ix.reply('📂 Your folder is empty.');
        const lines = inv.map(r => `• **${r.chip_name}** × ${r.qty}`).join('\n');
        await ix.reply({ embeds: [new EmbedBuilder().setTitle('📂 Your Folder').setDescription(lines)] });
        break;
      }

      case 'give_chip': {
        const to = ix.options.getUser('to', true);
        const name = ix.options.getString('name', true);
        const qty = Math.max(1, ix.options.getInteger('qty') ?? 1);
        if (to.id === ix.user.id) return ix.reply({ content: '❌ You cannot give chips to yourself.', ephemeral: true });
        const row = getChip.get(name);
        if (!row || row.is_upgrade) return ix.reply({ content: '❌ Invalid chip.', ephemeral: true });
        const have = invGetQty(ix.user.id, name);
        if (have < qty) return ix.reply({ content: `❌ You only have **${have}**.`, ephemeral: true });
        invAdd(ix.user.id, name, -qty);
        invAdd(to.id, name, qty);
        await ix.reply(`🎁 <@${ix.user.id}> gave **${qty}× ${name}** to <@${to.id}>.`);
        break;
      }

      case 'chips_reload': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        await ix.deferReply({ ephemeral: true });
        try {
          await reloadChipsFromTSV();
          await ix.editReply('✅ Chips reloaded from TSV.');
        } catch (e) {
          await ix.editReply(`❌ Reload failed: ${String(e.message || e)}`);
        }
        break;
      }

      case 'chips_catalog': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        const rows = listAllChipNames.all().map(({ name }) => getChip.get(name)).filter(Boolean);
        if (!rows.length) return ix.reply({ content: 'No chips loaded.', ephemeral: true });
        const { embed, components } = buildCatalogPage(rows, 0, 'catalog');
        await ix.reply({ embeds: [embed], components, ephemeral: true });
        break;
      }

      case 'chip_grant': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        const rows = listAllChipNames.all().map(({ name }) => getChip.get(name)).filter(Boolean);
        if (!rows.length) return ix.reply({ content: 'No chips loaded.', ephemeral: true });
        GrantState.set(ix.user.id, { page: 0, qty: 1 });
        const { embed, components } = buildCatalogPage(rows, 0, 'grant');
        await ix.reply({ embeds: [embed], components, ephemeral: true });
        break;
      }

      case 'chip_remove': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        const target = ix.options.getUser('user', true);
        const name = ix.options.getString('name', true);
        const qty = Math.max(1, ix.options.getInteger('qty', true));
        const have = invGetQty(target.id, name);
        if (!have) return ix.reply({ content: `❌ ${target.username} has none.`, ephemeral: true });
        invAdd(target.id, name, -Math.min(qty, have));
        await ix.reply({ content: `🗑️ Removed **${Math.min(qty, have)}× ${name}** from ${target}.`, ephemeral: true });
        break;
      }

      case 'chip_grant' /* param grant */: // (kept for completeness)
      case 'grant_chip': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        // Already handled above; keeping the alias
        await ix.reply({ content: 'Use the interactive grant UI.', ephemeral: true });
        break;
      }

      case 'stat_override': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        const target = ix.options.getUser('user', true);
        const which = ix.options.getString('stat', true);
        const value = ix.options.getInteger('value', true);
        ensureNavi(target.id);
        const map = { hp: updHP, dodge: updDodge, crit: updCrit, wins: updWins, losses: updLosses, points: updPts };
        const fn = map[which];
        if (!fn) return ix.reply({ content: '❌ Invalid stat.', ephemeral: true });
        fn.run(value, target.id);
        await ix.reply({ content: `✅ Set **${which}** to **${value}** for ${target}.`, ephemeral: true });
        break;
      }

      case 'give_zenny': {
        const to = ix.options.getUser('to', true);
        const amt = Math.max(1, ix.options.getInteger('amount', true));
        if (to.id === ix.user.id) return ix.reply({ content: '❌ You cannot pay yourself.', ephemeral: true });
        const me = ensureNavi(ix.user.id);
        ensureNavi(to.id); // <-- keep this version
        if ((me.zenny | 0) < amt) return ix.reply({ content: `❌ You need **${amt}** ${zennyIcon()}.`, ephemeral: true });
        addZenny.run(ix.user.id, -amt);
        addZenny.run(to.id, amt);
        await ix.reply(`💸 <@${ix.user.id}> sent **${amt}** ${zennyIcon()} to <@${to.id}>.`);
        break;
      }

      case 'zenny_override': {
        if (!isAdmin(ix)) return ix.reply({ content: '⛔ Admins only.', ephemeral: true });
        const target = ix.options.getUser('user', true);
        const amount = ix.options.getInteger('amount', true);
        ensureNavi(target.id);
        addZenny.run(target.id, amount);
        await ix.reply({ content: `✅ Added **${amount}** ${zennyIcon()} to ${target}.`, ephemeral: true });
        break;
      }

      case 'duel': {
        const opp = ix.options.getUser('opponent', true);
        if (opp.id === ix.user.id) return ix.reply({ content: '❌ You cannot duel yourself.', ephemeral: true });
        if (!(await requireNoCombat())) return;
        const p1 = ensureNavi(ix.user.id);
        const p2 = ensureNavi(opp.id);
        const deadline = now() + ROUND_SECONDS * 1000;
        startFight.run(ix.channelId, ix.user.id, opp.id, p1.max_hp, p2.max_hp, 0, 0, '{}', '{}', '[]', '[]', null, null, deadline, now());
        scheduleRoundTimer(ix.channelId, () => resolveDuelRound(ix.channel));
        await ix.reply(`⚔️ **Duel started!**\n${hpLineDuel(getFight.get(ix.channelId))}\n⏳ Play with **/use** within **${ROUND_SECONDS}s**.`);
        break;
      }

      case 'forfeit': {
        const f = getFight.get(ix.channelId);
        const pve = getPVE.get(ix.channelId);
        if (!f && !pve) return ix.reply({ content: '❌ No active duel/encounter here.', ephemeral: true });
        if (f) {
          const loser = ix.user.id;
          const winner = f.p1_id === loser ? f.p2_id : f.p1_id;
          const p1IsBot = f.p1_id === client.user.id;
          const p2IsBot = f.p2_id === client.user.id;
          if (!p1IsBot && !p2IsBot) {
            setRecord.run(f.p1_id === winner ? 1 : 0, f.p1_id === loser ? 1 : 0, f.p1_id);
            setRecord.run(f.p2_id === winner ? 1 : 0, f.p2_id === loser ? 1 : 0, f.p2_id);
          }
          endFight.run(ix.channelId);
          clearRoundTimer(ix.channelId);
          await ix.reply(`🏳️ <@${loser}> forfeited. <@${winner}> wins!`);
          return;
        }
        if (pve) {
          endPVE.run(ix.channelId);
          await ix.reply('🏳️ Encounter ended.');
        }
        break;
      }

      case 'duel_state': {
        const f = getFight.get(ix.channelId);
        const pve = getPVE.get(ix.channelId);
        if (!f && !pve) return ix.reply('No active duel/encounter here.');
        if (f) {
          await ix.reply(`⚔️ Duel\n${hpLineDuel(f)}\n⏳ Deadline: ${f.round_deadline ? msToClock(f.round_deadline - now()) : '—'}`);
        } else {
          await ix.reply(`🦠 Encounter vs **${pve.virus_name}**\n${hpLinePVE(pve)}`);
        }
        break;
      }

      case 'use': {
        const chipName = ix.options.getString('chip', true);
        const supportName = ix.options.getString('support');

        // Work out context: Duel or PVE
        const f = getFight.get(ix.channelId);
        const pve = getPVE.get(ix.channelId);
        if (!f && !pve) return ix.reply({ content: '❌ No active duel/encounter in this channel.', ephemeral: true });

        // Inventory check (own only; support must be support-type)
        const chipRow = getChip.get(chipName);
        if (!chipRow || chipRow.is_upgrade) return ix.reply({ content: '❌ Invalid attack chip.', ephemeral: true });
        if (invGetQty(ix.user.id, chipName) <= 0) return ix.reply({ content: `❌ You do not own **${chipName}**.`, ephemeral: true });

        let action = actionChip(chipName);

        if (supportName) {
          const supRow = getChip.get(supportName);
          if (!supRow) return ix.reply({ content: '❌ Support chip not found.', ephemeral: true });
          if (!isSupport(readEffect(supRow))) return ix.reply({ content: '❌ That chip is not a Support chip.', ephemeral: true });
          if (invGetQty(ix.user.id, supportName) <= 0) return ix.reply({ content: `❌ You do not own **${supportName}**.`, ephemeral: true });
          action = actionSupport(supportName, chipName);
        }

        // Enforce per-battle limits / specials
        const countsRow = (name, counts) => (counts[name] || 0);
        if (f) {
          const isP1 = f.p1_id === ix.user.id;
          if (!isP1 && f.p2_id !== ix.user.id) return ix.reply({ content: '❌ You are not part of this duel.', ephemeral: true });

          const counts = parseMap(isP1 ? f.p1_counts_json : f.p2_counts_json);
          const specials = new Set(parseList(isP1 ? f.p1_special_used : f.p2_special_used));

          const usedNames = supportName ? [supportName, chipName] : [chipName];
          for (const nm of usedNames) {
            const row = getChip.get(nm); const eff = readEffect(row);
            if ((countsRow(nm, counts) | 0) >= MAX_PER_CHIP) {
              return ix.reply({ content: `❌ **${nm}** reached the per-battle limit (${MAX_PER_CHIP}).`, ephemeral: true });
            }
            if (isSpecial(eff) && specials.has(nm)) {
              return ix.reply({ content: `❌ **${nm}** is Special and can be used only once per battle.`, ephemeral: true });
            }
          }

          // Record action
          if (isP1) {
            updFightRound.run(f.p1_hp, f.p2_hp, f.p1_def, f.p2_def, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, action, f.p2_action_json, f.round_deadline, f.p1_stunned|0, f.p2_stunned|0, f.p1_poison_json, f.p2_poison_json, f.p1_holy_json, f.p2_holy_json, ix.channelId);
          } else {
            updFightRound.run(f.p1_hp, f.p2_hp, f.p1_def, f.p2_def, f.p1_counts_json, f.p2_counts_json, f.p1_special_used, f.p2_special_used, f.p1_action_json, action, f.round_deadline, f.p1_stunned|0, f.p2_stunned|0, f.p1_poison_json, f.p2_poison_json, f.p1_holy_json, f.p2_holy_json, ix.channelId);
          }
          await ix.reply({ content: `✅ Action locked in.`, ephemeral: true });

          // If both ready or deadline passed, resolve
          const nowRow = getFight.get(ix.channelId);
          if (nowRow.p1_action_json && nowRow.p2_action_json) {
            clearRoundTimer(ix.channelId);
            await resolveDuelRound(ix.channel);
          }
          return;
        }

        if (pve) {
          if (pve.player_id !== ix.user.id) return ix.reply({ content: '❌ This is not your encounter.', ephemeral: true });
          if (pve.player_action_json) return ix.reply({ content: '❌ You have already acted. Wait for resolution.', ephemeral: true });

          updPVE.run(pve.p_hp, pve.v_hp, pve.p_def, pve.v_def, pve.p_counts_json, pve.p_special_used, pve.v_special_used, action, pve.virus_action_json, 0, pve.v_def_total, pve.v_def_streak, pve.p_stunned|0, pve.v_stunned|0, pve.p_poison_json, pve.v_poison_json, pve.p_holy_json, pve.v_holy_json, ix.channelId);
          await ix.reply({ content: `✅ Action locked.`, ephemeral: true });
          await resolvePveRound(ix.channel);
          return;
        }
        break;
      }

      case 'virus_busting': {
        if (!(await requireNoCombat())) return;
        grantStartersIfNeeded(ix.user.id);

        const v = await pickVirusForUser(ix.user.id);
        if (!v) return ix.reply('❌ No viruses configured.');
        const me = ensureNavi(ix.user.id);
        const s = {
          channel_id: ix.channelId,
          player_id: ix.user.id,
          virus_name: v.name,
          virus_image: v.image_url || null,
          virus_max_hp: Math.max(1, v.hp | 0),
          virus_dodge: Math.max(0, v.dodge | 0),
          virus_crit: Math.max(0, v.crit | 0),
          virus_is_boss: v.boss ? 1 : 0,
          virus_moves_json: JSON.stringify(v.moves || []),
          virus_zmin: v.zmin | 0,
          virus_zmax: v.zmax | 0,
          p_hp: me.max_hp | 0,
          v_hp: Math.max(1, v.hp | 0),
          p_def: 0, v_def: 0,
          p_counts_json: '{}',
          p_special_used: '[]',
          v_special_used: '[]',
        };
        startPVE.run(
          s.channel_id, s.player_id, s.virus_name, s.virus_image, s.virus_max_hp, s.virus_dodge, s.virus_crit, s.virus_is_boss,
          s.virus_moves_json, s.virus_zmin, s.virus_zmax,
          s.p_hp, s.v_hp, s.p_def, s.v_def, s.p_counts_json, s.p_special_used, s.v_special_used,
          null, null, 0, 0, 0, now()
        );
        await ix.reply(`🦠 **Encounter!** A wild **${v.name}** appeared.\n${hpLinePVE(getPVE.get(ix.channelId))}\n▶️ Your turn. Play with **/use**.`);
        break;
      }

      case 'virus_search': {
        const name = ix.options.getString('name', true);
        const list = await loadViruses(false);
        const v = list.find(x => normalize(x.name) === normalize(name)) || list.find(x => x.name.toLowerCase().includes(name.toLowerCase()));
        if (!v) return ix.reply({ content: '❌ Not found.', ephemeral: true });
        const effLines = (v.moves || []).map(m => `• **${m.name || m.label || 'Move'}** — ${summarizeEffect(m)}`).join('\n') || '—';
        const embed = new EmbedBuilder()
          .setTitle(`${v.boss ? '👑 Boss' : '🦠 Virus'} — ${v.name}`)
          .setDescription(effLines)
          .addFields(
            { name: 'HP', value: String(v.hp | 0), inline: true },
            { name: 'Dodge', value: `${v.dodge | 0}%`, inline: true },
            { name: 'Crit', value: `${v.crit | 0}%`, inline: true },
            { name: 'Region', value: v.region || 'Any', inline: true },
            { name: 'Zone', value: v.zone ? String(v.zone) : 'Any', inline: true },
            { name: 'Zenny', value: v.zmin === v.zmax ? `${v.zmin}` : `${v.zmin}-${v.zmax}`, inline: true },
          );
        if (v.image_url) embed.setThumbnail(v.image_url);
        await ix.reply({ embeds: [embed], ephemeral: false });
        break;
      }

      case 'metroline': {
        const region = ix.options.getString('region', true);
        const zone = ix.options.getInteger('zone', true);
        setLoc.run(ix.user.id, region, zone);
        await ix.reply(`🚇 Traveled to **${region}** (Zone ${zone}).`);
        break;
      }

      case 'bbs_mission': {
        // Cooldown check
        const cd = getCooldown.get(ix.user.id);
        if (cd && (cd.until > Date.now())) {
          return ix.reply({ content: `⏳ You are on cooldown for **${msToClock(cd.until - Date.now())}**.`, ephemeral: true });
        }

        // Already have one?
        const existing = getActiveMission.get(ix.user.id);
        if (existing) {
          return ix.reply({ content: `📌 You already have mission **${existing.mission_id}** in **${existing.region}**.`, ephemeral: true });
        }

        // Assign
        const loc = ensureLoc(ix.user.id);
        const missions = await loadMissions(false);
        const pool = missions.filter(m => normalize(m.region) === normalize(loc.region));
        if (!pool.length) return ix.reply({ content: '❌ No missions available for your region.', ephemeral: true });
        const m = pool[Math.floor(Math.random() * pool.length)];

        setActiveMission.run(ix.user.id, m.mission_id, m.region, m.target_chip, m.target_boss, m.reward_zenny, m.keep_chip ? 1 : 0, Date.now());
        await ix.reply(`📝 New mission **${m.mission_id}** for **${m.region}**.\nGoal: ${m.target_chip ? `Use **${m.target_chip}**` : ''}${m.target_boss ? `${m.target_chip ? ' or ' : ''}Defeat **${m.target_boss}**` : ''}\nReward: **${m.reward_zenny}** ${zennyIcon()}`);
        break;
      }

      case 'bbs_mission_quit': {
        const am = getActiveMission.get(ix.user.id);
        if (!am) return ix.reply({ content: '❌ You have no active mission.', ephemeral: true });
        abandonMission.run(ix.user.id, am.mission_id);
        const LOCK_MS = 5 * 60 * 1000; // 5 minutes
        scheduleMissionCooldown(ix.user.id, LOCK_MS, ix.channelId);
        await ix.reply(`🗑️ Mission **${am.mission_id}** abandoned. Cooldown **5:00** started.`);
        break;
      }

      default:
        await ix.reply({ content: '🤖 Unknown command.', ephemeral: true });
        break;
    }
  } catch (err) {
    console.error('[interaction] error:', err);
    try {
      if (typeof ix.reply === 'function') await ix.reply({ content: '⚠️ An error occurred.', ephemeral: true });
    } catch {}
  }
});

// ---------- Ready / Login ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.warn('Command register failed:', e.message || e); }

  // Re-arm any active mission cooldowns on startup
  try {
    const rows = db.prepare(`SELECT user_id, until, notify_channel_id FROM mission_cooldowns`).all();
    const nowT = Date.now();
    for (const r of rows) {
      const ms = Math.max(0, (r.until | 0) - nowT);
      if (ms > 0) scheduleMissionCooldown(r.user_id, ms, r.notify_channel_id);
      else clearCooldown.run(r.user_id);
    }
  } catch {}
});

client.login(process.env.DISCORD_TOKEN);
