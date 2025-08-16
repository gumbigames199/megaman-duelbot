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
} from 'discord.js';
import Database from 'better-sqlite3';
import fs from 'node\:fs';

// Optional fetch polyfill for Node < 18 (no-op on >=18)
try {
if (typeof fetch === 'undefined') {
// eslint-disable-next-line no-undef
await import('node-fetch').then(({ default: f }) => {
// @ts-ignore
global.fetch = f;
});
}
} catch { /\* ignore \*/ }

// ---------- Config ----------
const ADMIN\_ROLE\_ID = process.env.ADMIN\_ROLE\_ID || '830126829352386601';

const MANUAL\_UPGRADES\_MODE = (process.env.MANUAL\_UPGRADES\_MODE || 'points').toLowerCase();
const POINTS\_PER\_WIN = parseInt(process.env.POINTS\_PER\_WIN || '1', 10);

// Per-chip cap per battle & round timing
const MAX\_PER\_CHIP = 4;
const ROUND\_SECONDS = Math.max(15, parseInt(process.env.ROUND\_SECONDS || '60', 10)); // floor at 15s

// Virus TSV URL (Google Sheets export to TSV)
const VIRUS\_TSV\_URL = process.env.VIRUS\_TSV\_URL || '';
// Chip TSV URL
const CHIP\_TSV\_URL = process.env.CHIP\_TSV\_URL || process.env.CHIPS\_TSV\_URL || '';
// Missions TSV URL (Thing 3)
const MISSIONS\_TSV\_URL = process.env.MISSIONS\_TSV\_URL || '';

// Stat caps (ENV-overridable)
const MAX\_HP\_CAP = parseInt(process.env.MAX\_HP\_CAP || '500', 10);
const MAX\_DODGE\_CAP = parseInt(process.env.MAX\_DODGE\_CAP || '40', 10);
const MAX\_CRIT\_CAP = parseInt(process.env.MAX\_CRIT\_CAP || '25', 10);

// Virus AI caps
const VIRUS\_DEFENSE\_CAP\_TOTAL = 5; // total defense/barrier uses per encounter
const VIRUS\_DEFENSE\_CAP\_STREAK = 2; // consecutive defense uses before forcing attack

// Zenny emoji helpers (fallback to moneybag)
const ZENNY\_EMOJI\_ID = process.env.ZENNY\_EMOJI\_ID || '';
const ZENNY\_EMOJI\_NAME = process.env.ZENNY\_EMOJI\_NAME || 'zenny';
const zennyIcon = () =>
(/^\d{17,20}\$/.test(ZENNY\_EMOJI\_ID) ? `<:${ZENNY_EMOJI_NAME}:${ZENNY_EMOJI_ID}>` : '💰');

// ---------- Thing 3 Config ----------
const REGIONS = \['ACDC','SciLab','Yoka','Beach','Sharo','YumLand','UnderNet'];

// Dynamic upgrade price steps (per purchase)
const HP\_MEMORY\_COST\_STEP      = parseInt(process.env.HP\_MEMORY\_COST\_STEP      || '500', 10);
const DATA\_RECONFIG\_COST\_STEP  = parseInt(process.env.DATA\_RECONFIG\_COST\_STEP  || '500', 10);
const LUCKY\_DATA\_COST\_STEP     = parseInt(process.env.LUCKY\_DATA\_COST\_STEP     || '500', 10);

// Stat upgrade point costs (manual /navi\_upgrade)
const CRIT\_DODGE\_COST    = parseInt(process.env.CRIT\_DODGE\_COST   || '5', 10);   // points for +1% crit/dodge
const HP\_POINTS\_PER\_STEP = parseInt(process.env.HP\_POINTS\_PER\_STEP || '50', 10);  // points per +10 HP
const HP\_STEP\_SIZE       = parseInt(process.env.HP\_STEP\_SIZE       || '10', 10);  // default step remains +10 HP

// 33% virus chip drop (ENV override-able 0..1)
const VIRUS\_CHIP\_DROP\_PCT = Number(process.env.VIRUS\_CHIP\_DROP\_PCT ?? 0.33);

// Ensure data dir exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Discord client
const client = new Client({
intents: \[
GatewayIntentBits.Guilds,
//GatewayIntentBits.GuildMessages, // (not needed for slash interactions)
//GatewayIntentBits.MessageContent, // (not needed for slash interactions)
],
partials: \[Partials.Channel, Partials.Message],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Auto-register slash commands (guild-scoped) ----------
async function registerCommands() {
const TOKEN = process.env.DISCORD\_TOKEN;
const APP\_ID = process.env.CLIENT\_ID || process.env.APPLICATION\_ID;
const GUILD\_ID = process.env.GUILD\_ID;

if (!TOKEN || !APP\_ID || !GUILD\_ID) {
console.warn('\[commands] Skipping register: missing DISCORD\_TOKEN / CLIENT\_ID(APPLICATION\_ID) / GUILD\_ID');
return;
}

const cmds = \[
new SlashCommandBuilder().setName('navi\_register').setDescription('Register your Navi'),

```
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

new SlashCommandBuilder()
  .setName('bbs_mission_quit')
  .setDescription('Abandon your current mission (5-minute lockout)'),
```

].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
console.log(`[commands] Registering ${cmds.length} commands to guild ${GUILD_ID}…`);
await rest.put(Routes.applicationGuildCommands(APP\_ID, GUILD\_ID), { body: cmds });
console.log('\[commands] Guild commands registered.');
}

// ---------- DB ----------
const db = new Database('./data/data.sqlite');
db.pragma('foreign\_keys = ON'); // enforce FK constraints

db.exec(\`
CREATE TABLE IF NOT EXISTS navis (
user\_id TEXT PRIMARY KEY,
max\_hp INTEGER NOT NULL DEFAULT 250,
dodge  INTEGER NOT NULL DEFAULT 20,
crit   INTEGER NOT NULL DEFAULT 5,
wins   INTEGER NOT NULL DEFAULT 0,
losses INTEGER NOT NULL DEFAULT 0,
upgrade\_pts INTEGER NOT NULL DEFAULT 0,
zenny INTEGER NOT NULL DEFAULT 0
);

\-- PvP duel state (SIMULTANEOUS)
CREATE TABLE IF NOT EXISTS duel\_state (
channel\_id TEXT PRIMARY KEY,
p1\_id TEXT NOT NULL,
p2\_id TEXT NOT NULL,
p1\_hp INTEGER NOT NULL,
p2\_hp INTEGER NOT NULL,
p1\_def INTEGER NOT NULL DEFAULT 0,
p2\_def INTEGER NOT NULL DEFAULT 0,
p1\_counts\_json TEXT NOT NULL DEFAULT '{}',
p2\_counts\_json TEXT NOT NULL DEFAULT '{}',
p1\_special\_used TEXT NOT NULL DEFAULT '\[]',
p2\_special\_used TEXT NOT NULL DEFAULT '\[]',
p1\_action\_json TEXT DEFAULT NULL,
p2\_action\_json TEXT DEFAULT NULL,
round\_deadline INTEGER NOT NULL DEFAULT 0,
started\_at INTEGER NOT NULL,

\-- status effects
p1\_stunned INTEGER NOT NULL DEFAULT 0,
p2\_stunned INTEGER NOT NULL DEFAULT 0,
p1\_poison\_json TEXT NOT NULL DEFAULT '\[]',
p2\_poison\_json TEXT NOT NULL DEFAULT '\[]',
p1\_holy\_json TEXT NOT NULL DEFAULT '\[]',
p2\_holy\_json TEXT NOT NULL DEFAULT '\[]'
);

\-- PVE state (SIMULTANEOUS)
CREATE TABLE IF NOT EXISTS pve\_state (
channel\_id TEXT PRIMARY KEY,
player\_id TEXT NOT NULL,
virus\_name TEXT NOT NULL,
virus\_image TEXT,
virus\_max\_hp INTEGER NOT NULL,
virus\_dodge INTEGER NOT NULL,
virus\_crit INTEGER NOT NULL,
virus\_is\_boss INTEGER NOT NULL DEFAULT 0,
virus\_moves\_json TEXT NOT NULL DEFAULT '\[]',
virus\_zmin INTEGER NOT NULL DEFAULT 0,
virus\_zmax INTEGER NOT NULL DEFAULT 0,

p\_hp INTEGER NOT NULL,
v\_hp INTEGER NOT NULL,
p\_def INTEGER NOT NULL DEFAULT 0,
v\_def INTEGER NOT NULL DEFAULT 0,
p\_counts\_json TEXT NOT NULL DEFAULT '{}',
p\_special\_used TEXT NOT NULL DEFAULT '\[]',
v\_special\_used TEXT NOT NULL DEFAULT '\[]',

player\_action\_json TEXT DEFAULT NULL,
virus\_action\_json  TEXT DEFAULT NULL,

round\_deadline INTEGER NOT NULL DEFAULT 0,

\-- Boss/virus AI caps
v\_def\_total INTEGER NOT NULL DEFAULT 0,
v\_def\_streak INTEGER NOT NULL DEFAULT 0,

started\_at INTEGER NOT NULL,

\-- status effects
p\_stunned INTEGER NOT NULL DEFAULT 0,
v\_stunned INTEGER NOT NULL DEFAULT 0,
p\_poison\_json TEXT NOT NULL DEFAULT '\[]',
v\_poison\_json TEXT NOT NULL DEFAULT '\[]',
p\_holy\_json TEXT NOT NULL DEFAULT '\[]',
v\_holy\_json TEXT NOT NULL DEFAULT '\[]'
);

\-- Chips master & inventory
CREATE TABLE IF NOT EXISTS chips (
name TEXT PRIMARY KEY,
image\_url TEXT,
effect\_json TEXT NOT NULL,
zenny\_cost INTEGER NOT NULL DEFAULT 0,
is\_upgrade INTEGER NOT NULL DEFAULT 0,
stock INTEGER NOT NULL DEFAULT 1 -- 1 = appears in /shop; 0 = hidden (e.g., PVE drop only)
);

CREATE TABLE IF NOT EXISTS inventory (
user\_id TEXT NOT NULL,
chip\_name TEXT NOT NULL,
qty INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY (user\_id, chip\_name),
FOREIGN KEY (chip\_name) REFERENCES chips(name) ON UPDATE CASCADE ON DELETE RESTRICT
);

\-- Thing 3: Player location (region/zone)
CREATE TABLE IF NOT EXISTS locations (
user\_id TEXT PRIMARY KEY,
region  TEXT NOT NULL DEFAULT 'ACDC',
zone    INTEGER NOT NULL DEFAULT 1
);

\-- Thing 3: Per-player counts for dynamic upgrade pricing
CREATE TABLE IF NOT EXISTS upgrade\_purchases (
user\_id TEXT NOT NULL,
upgrade\_name TEXT NOT NULL,
count INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY (user\_id, upgrade\_name)
);

\-- Thing 3: Active missions (one per player)
CREATE TABLE IF NOT EXISTS missions\_active (
user\_id TEXT PRIMARY KEY,
mission\_id TEXT NOT NULL,
region TEXT NOT NULL,
target\_chip TEXT,
target\_boss TEXT,
reward\_zenny INTEGER NOT NULL DEFAULT 0,
keep\_chip INTEGER NOT NULL DEFAULT 1, -- 1 keep, 0 surrender for zenny
status TEXT NOT NULL DEFAULT 'active', -- active|completed|abandoned
assigned\_at INTEGER NOT NULL
);

\-- Thing 3: Mission cooldowns (lockouts after quitting)
CREATE TABLE IF NOT EXISTS mission\_cooldowns (
user\_id TEXT PRIMARY KEY,
until INTEGER NOT NULL,
notify\_channel\_id TEXT
);
\`);

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
const upsertNavi = db.prepare(`  INSERT INTO navis (user_id,max_hp,dodge,crit,wins,losses,upgrade_pts,zenny) VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET
     max_hp=excluded.max_hp,
     dodge=excluded.dodge,
     crit=excluded.crit,
     wins=excluded.wins,
     losses=excluded.losses,
     upgrade_pts=excluded.upgrade_pts,
     zenny=excluded.zenny`);
function ensureNavi(uid) {
const row = getNavi.get(uid);
if (row) return row;
upsertNavi.run(uid, 250, 20, 5, 0, 0, 0, 0);
return { user\_id: uid, max\_hp: 250, dodge: 20, crit: 5, wins: 0, losses: 0, upgrade\_pts: 0, zenny: 0 };
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
const startFight = db.prepare(`  INSERT INTO duel_state
    (channel_id,p1_id,p2_id,p1_hp,p2_hp,p1_def,p2_def,p1_counts_json,p2_counts_json,p1_special_used,p2_special_used,p1_action_json,p2_action_json,round_deadline,started_at,
     p1_stunned,p2_stunned,p1_poison_json,p2_poison_json,p1_holy_json,p2_holy_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'[]','[]','[]','[]')`);
const updFightRound = db.prepare(`  UPDATE duel_state
     SET p1_hp=?, p2_hp=?,
         p1_def=?, p2_def=?,
         p1_counts_json=?, p2_counts_json=?,
         p1_special_used=?, p2_special_used=?,
         p1_action_json=?, p2_action_json=?,
         round_deadline=?,
         p1_stunned=?, p2_stunned=?,
         p1_poison_json=?, p2_poison_json=?,
         p1_holy_json=?, p2_holy_json=?
   WHERE channel_id=?`);
const endFight = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

const getPVE = db.prepare(`SELECT * FROM pve_state WHERE channel_id=?`);
const startPVE = db.prepare(`  INSERT INTO pve_state (
    channel_id, player_id, virus_name, virus_image, virus_max_hp, virus_dodge, virus_crit, virus_is_boss, virus_moves_json, virus_zmin, virus_zmax,
    p_hp, v_hp, p_def, v_def, p_counts_json, p_special_used, v_special_used, player_action_json, virus_action_json, round_deadline, v_def_total, v_def_streak, started_at,
    p_stunned, v_stunned, p_poison_json, v_poison_json, p_holy_json, v_holy_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            0,0,'[]','[]','[]','[]')`);
const updPVE = db.prepare(`  UPDATE pve_state
     SET p_hp=?, v_hp=?,
         p_def=?, v_def=?,
         p_counts_json=?, p_special_used=?, v_special_used=?,
         player_action_json=?, virus_action_json=?,
         round_deadline=?,
         v_def_total=?, v_def_streak=?,
         p_stunned=?, v_stunned=?,
         p_poison_json=?, v_poison_json=?,
         p_holy_json=?, v_holy_json=?
   WHERE channel_id=?`);
const endPVE = db.prepare(`DELETE FROM pve_state WHERE channel_id=?`);

// Chips & inventory
const getChip = db.prepare(`SELECT * FROM chips WHERE name=?`);
const listChips = db.prepare(`SELECT * FROM chips WHERE is_upgrade=0 ORDER BY name COLLATE NOCASE ASC`);
const listAllChipNames = db.prepare(`SELECT name FROM chips ORDER BY name COLLATE NOCASE ASC`);
const listShop = db.prepare(`SELECT * FROM chips WHERE stock=1 ORDER BY is_upgrade ASC, zenny_cost ASC, name COLLATE NOCASE ASC`);
const upsertChip = db.prepare(`  INSERT INTO chips (name,image_url,effect_json,zenny_cost,is_upgrade,stock) VALUES (?,?,?,?,?,?)
   ON CONFLICT(name) DO UPDATE SET image_url=excluded.image_url,effect_json=excluded.effect_json,zenny_cost=excluded.zenny_cost,is_upgrade=excluded.is_upgrade,stock=excluded.stock`);
const getInv = db.prepare(`SELECT qty FROM inventory WHERE user_id=? AND chip_name=?`);
const setInv = db.prepare(`  INSERT INTO inventory (user_id,chip_name,qty) VALUES (?,?,?)
   ON CONFLICT(user_id,chip_name) DO UPDATE SET qty=excluded.qty`);
const listInv = db.prepare(`SELECT chip_name, qty FROM inventory WHERE user_id=? AND qty>0 ORDER BY chip_name COLLATE NOCASE ASC`);

// Thing 3 prepared statements
// Locations
const getLoc = db.prepare(`SELECT region, zone FROM locations WHERE user_id=?`);
const setLoc = db.prepare(`  INSERT INTO locations (user_id,region,zone) VALUES (?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET region=excluded.region, zone=excluded.zone`);
function ensureLoc(uid) {
const r = getLoc.get(uid);
if (r) return r;
setLoc.run(uid, 'ACDC', 1);
return { region: 'ACDC', zone: 1 };
}

// Upgrade purchases
const getUpgCount = db.prepare(`SELECT count FROM upgrade_purchases WHERE user_id=? AND upgrade_name=?`);
const bumpUpgCount = db.prepare(`  INSERT INTO upgrade_purchases (user_id, upgrade_name, count) VALUES (?,?,1)
  ON CONFLICT(user_id, upgrade_name) DO UPDATE SET count = count + 1`);
const bumpUpgCountBy = db.prepare(`  INSERT INTO upgrade_purchases (user_id, upgrade_name, count) VALUES (?,?,?)
  ON CONFLICT(user_id, upgrade_name) DO UPDATE SET count = count + excluded.count`);

// Missions
const getActiveMission   = db.prepare(`SELECT * FROM missions_active WHERE user_id=? AND status='active'`);
const setActiveMission   = db.prepare(`  INSERT INTO missions_active (user_id, mission_id, region, target_chip, target_boss, reward_zenny, keep_chip, status, assigned_at)
  VALUES (?,?,?,?,?,?,?, 'active', ?)
  ON CONFLICT(user_id) DO UPDATE SET mission_id=excluded.mission_id, region=excluded.region, target_chip=excluded.target_chip, target_boss=excluded.target_boss, reward_zenny=excluded.reward_zenny, keep_chip=excluded.keep_chip, status='active', assigned_at=excluded.assigned_at`);
const completeMission    = db.prepare(`UPDATE missions_active SET status='completed' WHERE user_id=? AND mission_id=?`);
const abandonMission     = db.prepare(`UPDATE missions_active SET status='abandoned' WHERE user_id=? AND mission_id=?`);

// Mission cooldown helpers
const getCooldown     = db.prepare(`SELECT until, notify_channel_id FROM mission_cooldowns WHERE user_id=?`);
const setCooldown     = db.prepare(`  INSERT INTO mission_cooldowns (user_id, until, notify_channel_id) VALUES (?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, notify_channel_id=excluded.notify_channel_id`);
const clearCooldown   = db.prepare(`DELETE FROM mission_cooldowns WHERE user_id=?`);

// Helpers
const normalize = (s) => (s || '').toLowerCase().replace(/\[\s\_-]/g, '');
const parseList = (s) => { try { const v = JSON.parse(s ?? '\[]'); return Array.isArray(v) ? v : \[]; } catch { return \[]; } };
const parseMap  = (s) => { try { const v = JSON.parse(s ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const parseMoves= (s) => { try { const v = JSON.parse(s ?? '\[]'); return Array.isArray(v) ? v : \[]; } catch { return \[]; } };
const tryParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const now = () => Date.now();

// NEW: parse chip drop lists like "A, B | C / D"
function parseChipDrops(s) {
return String(s || '')
.split(/\[,|/]+/g)
.map(x => x.trim())
.filter(Boolean);
}

// Pretty
function hpLineDuel(f) { return `HP — <@${f.p1_id}>: ${f.p1_hp} | <@${f.p2_id}>: ${f.p2_hp}`; }
function hpLinePVE(f) { return `HP — <@${f.player_id}>: ${f.p_hp} | **${f.virus_name}**: ${f.v_hp}`; }

function isAdmin(ix) {
const hasAdminRole = ix.member?.roles?.cache?.has?.(ADMIN\_ROLE\_ID);
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
const t = setTimeout(fn, ROUND\_SECONDS \* 1000);
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

```
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
```

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
const VirusCache = { ts: 0, rows: \[] };
const HEADER\_MAP = (h) => (h || '').toLowerCase().trim().replace(/\[^\w]+/g, '\_');

function parseRange(s) {
const t = String(s || '').trim();
if (!t) return { min: 0, max: 0 };
const m = t.match(/^(\d+)\s\*-\s\*(\d+)\$/);
if (m) {
const a = parseInt(m\[1], 10), b = parseInt(m\[2], 10);
return { min: Math.min(a, b), max: Math.max(a, b) };
}
const n = parseInt(t, 10);
return { min: isNaN(n) ? 0 : n, max: isNaN(n) ? 0 : n };
}

function weightFor(row) {
const sp = Number(row\.stat\_points || 1);
const boss = !!row\.boss;
if (!boss) return Math.max(1, 5 - Math.max(1, Math.min(4, sp)));
if (sp <= 5) return 1;
if (sp === 6) return 0.6;
return 0.4;
}

async function loadViruses(force = false) {
const FRESH\_MS = 1000 \* 60 \* 5;
if (!force && VirusCache.rows.length && (Date.now() - VirusCache.ts) < FRESH\_MS) return VirusCache.rows;
if (!VIRUS\_TSV\_URL) return \[];

const res = await fetch(VIRUS\_TSV\_URL);
if (!res.ok) throw new Error(`Virus TSV fetch failed: ${res.status}`);
const text = await res.text();
const lines = text.split(/\r?\n/).filter(Boolean);
if (!lines.length) return \[];

const headers = lines\[0].split('\t').map(HEADER\_MAP);
const rows = \[];
for (let i = 1; i < lines.length; i++) {
const cols = lines\[i].split('\t');
const obj = {};
headers.forEach((h, idx) => { obj\[h] = cols\[idx]; });

```
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
```

}

rows.forEach(r => r.weight = weightFor(r));
VirusCache.rows = rows;
VirusCache.ts = Date.now();
return rows;
}
function weightedPick(rows) {
const total = rows.reduce((s, r) => s + (r.weight || 0), 0);
if (total <= 0) return rows\[Math.floor(Math.random() \* rows.length)];
let roll = Math.random() \* total;
for (const r of rows) { roll -= (r.weight || 0); if (roll <= 0) return r; }
return rows\[rows.length - 1];
}

// ---------- Chip TSV Loader ----------
const ChipsCache = { ts: 0, rows: \[] };
function parseBool(x) {
const s = String(x ?? '').trim().toLowerCase();
return \['1','true','yes','y'].includes(s);
}
async function reloadChipsFromTSV() {
if (!CHIP\_TSV\_URL) throw new Error('CHIP\_TSV\_URL (or CHIPS\_TSV\_URL) not set.');
const res = await fetch(CHIP\_TSV\_URL);
if (!res.ok) throw new Error(`Chip TSV fetch failed: ${res.status}`);
const text = await res.text();
const lines = text.split(/\r?\n/).filter(Boolean);
if (!lines.length) throw new Error('Empty chip TSV');

const headers = lines\[0].split('\t').map(HEADER\_MAP);
const rows = \[];
for (let i = 1; i < lines.length; i++) {
const cols = lines\[i].split('\t');
const obj = {}; headers.forEach((h, idx) => { obj\[h] = cols\[idx]; });
rows.push(obj);
}

const upserts = db.transaction((rows2) => {
for (const r of rows2) {
const name = (r.name || '').trim();
if (!name) continue;
const img = r.image\_url || '';

```
  // accept effect / effect_json / json_effect
  let effect_json = '{}';
  const rawEffect = r.effect ?? r.effect_json ?? r.json_effect ?? '{}';
  try { effect_json = JSON.stringify(JSON.parse(rawEffect || '{}')); } catch { effect_json = '{}'; }

  const cost = parseInt(r.zenny_cost || r.cost || '0', 10) || 0;
  const isUp = parseBool(r.upgrade ?? r.is_upgrade);
  const inStock = parseBool(r.stock ?? r.in_stock ?? r.available);

  upsertChip.run(name, img, effect_json, cost, isUp ? 1 : 0, inStock ? 1 : 0);
}
```

});
upserts(rows);

ChipsCache.ts = Date.now();
ChipsCache.rows = rows;
}

// ---------- Missions TSV Loader (Thing 3) ----------
const MissionsCache = { ts: 0, rows: \[] };

async function loadMissions(force=false) {
const FRESH\_MS = 1000 \* 60 \* 5;
if (!force && MissionsCache.rows.length && (Date.now() - MissionsCache.ts) < FRESH\_MS) return MissionsCache.rows;
if (!MISSIONS\_TSV\_URL) return \[];
const res = await fetch(MISSIONS\_TSV\_URL);
if (!res.ok) throw new Error(`Missions TSV fetch failed: ${res.status}`);
const text = await res.text();
const lines = text.split(/\r?\n/).filter(Boolean);
if (!lines.length) return \[];

const headers = lines\[0].split('\t').map(HEADER\_MAP);
const out = \[];
for (let i=1;i\<lines.length;i++){
const cols = lines\[i].split('\t');
const obj = {}; headers.forEach((h,idx)=>{ obj\[h]=cols\[idx]; });
const mission\_id = (obj.mission\_id || obj.id || '').trim();
const region = (obj.region || '').trim();
if (!mission\_id || !region) continue;
const target\_chip = (obj.target\_chip || '').trim() || null;
const target\_boss = (obj.target\_boss || '').trim() || null;
const reward\_zenny = parseInt(obj.reward\_zenny || obj.reward || '0',10) || 0;
const keep\_chip = \['1','true','yes','y'].includes(String(obj.keep\_chip||'').toLowerCase()) ? 1 : 0;
out.push({ mission\_id, region, target\_chip, target\_boss, reward\_zenny, keep\_chip });
}
MissionsCache.rows = out;
MissionsCache.ts = Date.now();
return out;
}

// ---------- Combat helpers ----------
function extractKinds(effect) {
if (!effect) return \[];
const k = effect.kinds || effect.kind || '';
if (Array.isArray(k)) return k.map((x) => String(x).toLowerCase());
return String(k || '').toLowerCase().split(/\[+,/\s]+/).filter(Boolean); // restored '+' separator
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

function readEffect(chipRow) { return tryParseJSON(chipRow?.effect\_json) || {}; }

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
const amount = step \* Math.max(1, qty);

const cur = ensureNavi(userId);
let { max\_hp, dodge, crit } = cur;

if (stat === 'hp')    max\_hp = Math.min(MAX\_HP\_CAP,    max\_hp + amount);
if (stat === 'dodge') dodge  = Math.min(MAX\_DODGE\_CAP, dodge  + amount);
if (stat === 'crit')  crit   = Math.min(MAX\_CRIT\_CAP,  crit   + amount);

upsertNavi.run(userId, max\_hp, dodge, crit, cur.wins ?? 0, cur.losses ?? 0, cur.upgrade\_pts ?? 0, cur.zenny ?? 0);
return ensureNavi(userId);
}

// action encoding
function actionChip(name) { return JSON.stringify({ type: 'chip', name }); }
function actionSupport(support, withChip) { return JSON.stringify({ type: 'support', support, with: withChip }); }
function decodeAction(s) { return tryParseJSON(s) || null; }

// Random bot chip (simple) with rule checks against per-battle limits/specials
function pickBotChipFor(f, isP1) {
const counts = parseMap(isP1 ? f.p1\_counts\_json : f.p2\_counts\_json);
const specials = new Set(parseList(isP1 ? f.p1\_special\_used : f.p2\_special\_used));
const rows = listChips.all();
const eligible = rows.filter((r) => {
const eff = readEffect(r);
if (r.is\_upgrade) return false;
if ((counts\[r.name] || 0) >= MAX\_PER\_CHIP) return false;
if (isSpecial(eff) && specials.has(r.name)) return false;
return true;
});
if (!eligible.length) return null;
const pick = eligible\[Math.floor(Math.random() \* eligible.length)];
return { type: 'chip', name: pick.name };
}

// Damage math for a single (possibly supported) attack into a defender
function computeAttackDamage({ baseChip, supportEff, defenderDEF, defenderHasBarrier, breakFlag, dodgePct, critPct }) {
if (defenderHasBarrier && !breakFlag) {
return { dmg: 0, crit: false, dodged: false, cancelledByBarrier: true, absorbed: 0 };
}
const dodged = (Math.random() \* 100) < (dodgePct || 0);
if (dodged) return { dmg: 0, crit: false, dodged: true, cancelledByBarrier: false, absorbed: 0 };

const base = Number.isFinite(baseChip?.dmg) ? baseChip.dmg : 0;
const bonus = supportEff ? supportBonus(supportEff) : 0;

const isCrit = (Math.random() \* 100) < (critPct || 0);
const critBase = isCrit ? Math.floor((base \* 3) / 2) : base;

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
const moves = parseMoves(pveRow\.virus\_moves\_json);
if (!moves.length) return null;

const usedSpecials = new Set(parseList(pveRow\.v\_special\_used));
const totalDef = Number(pveRow\.v\_def\_total || 0);
const defStreak = Number(pveRow\.v\_def\_streak || 0);

// Filter out spent specials
const notSpent = moves.filter((m) => !(m.special && usedSpecials.has((m.name || m.label || 'special'))));

// If consecutive defense >= cap → try to force attack
if (defStreak >= VIRUS\_DEFENSE\_CAP\_STREAK) {
const attacks = notSpent.filter((m) => !isDefLikeMove(m));
if (attacks.length) return attacks\[Math.floor(Math.random() \* attacks.length)];
// fall through
}

// If total defense at or above cap → avoid defense
if (totalDef >= VIRUS\_DEFENSE\_CAP\_TOTAL) {
const nonDef = notSpent.filter((m) => !isDefLikeMove(m));
if (nonDef.length) return nonDef\[Math.floor(Math.random() \* nonDef.length)];
return notSpent\[Math.floor(Math.random() \* notSpent.length)];
}

return notSpent\[Math.floor(Math.random() \* notSpent.length)];
}

// ---------- UI helpers for Shop ----------
function summarizeEffect(e) {
if (!e) return '—';
const bits = \[];
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
const start = page \* PER;
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
const close = new ButtonBuilder().setCustomId('shop\:close').setLabel('Close').setStyle(ButtonStyle.Danger);
const rowNav = new ActionRowBuilder().addComponents(prev, next, close);

const list = slice
.map(r => `• **${r.name}** — ${r.zenny_cost} ${zennyIcon()}${r.is_upgrade ? ' (Upgrade — consumed on purchase)' : ''}`)
.join('\n');

const embed = new EmbedBuilder()
.setTitle('🛒 Chip Shop')
.setDescription(`${list || '—'}\n\nPick an item from the menu below to view details & buy.`)
.setFooter({ text: `Items ${start + 1}-${Math.min(rows.length, start + PER)} of ${rows.length} • Page ${page + 1}/${totalPages}` });

return { embed, components: \[rowSel, rowNav], page, totalPages };
}

// Thing 3: Dynamic upgrade pricing
const DYN\_UPGRADES = new Map(\[
\['HP Memory', HP\_MEMORY\_COST\_STEP],
\['Data Reconfig', DATA\_RECONFIG\_COST\_STEP],
\['Lucky Data', LUCKY\_DATA\_COST\_STEP],
]);

function dynamicUpgradeCostFor(userId, chipRow) {
if (!chipRow?.is\_upgrade) return chipRow?.zenny\_cost || 0;
const step = DYN\_UPGRADES.get(chipRow\.name);
if (!step) return chipRow\.zenny\_cost || 0;
const r = getUpgCount.get(userId, chipRow\.name);
const n = r ? (r.count || 0) : 0;
return Math.max(0, (chipRow\.zenny\_cost || 0) + (n \* step));
}

// Sum arithmetic progression for buying multiple
function dynamicUpgradeTotalFor(userId, chipRow, qty) {
const step = Number(DYN\_UPGRADES.get(chipRow\.name) || 0) | 0;
if (!step) return (chipRow\.zenny\_cost || 0) \* qty;
const r = getUpgCount.get(userId, chipRow\.name);
const n0 = r ? (r.count || 0) : 0;
const base = chipRow\.zenny\_cost || 0;
return qty \* base + step \* ((qty \* (2\*n0 + (qty-1))) / 2);
}

// ---------- Status tick helpers ----------
// POISON: list of at most 1 item: { dmg\:number, ticks\:number }
function parsePois(s) {
const arr = parseList(s);
if (!Array.isArray(arr)) return \[];
return arr
.map(x => (x && typeof x === 'object') ? { dmg: (x.dmg|0), ticks: (x.ticks|0) } : null)
.filter(x => x && x.dmg > 0 && x.ticks > 0)
.slice(0,1);
}
// HOLY: list of at most 1 item: { heal\:number, ticks\:number }
function parseHoly(s) {
const arr = parseList(s);
if (!Array.isArray(arr)) return \[];
return arr
.map(x => (x && typeof x === 'object') ? { heal: (x.heal|0), ticks: (x.ticks|0) } : null)
.filter(x => x && x.heal > 0 && x.ticks > 0)
.slice(0,1);
}

// Replace (no stacking): latest amount, 3 ticks
function replacePoison(\_list, dmg) { const n = Math.max(0, Math.floor(dmg)); return n > 0 ? \[{ dmg: n, ticks: 3 }] : \[]; }
function replaceHoly(\_list, heal)  { const n = Math.max(0, Math.floor(heal)); return n > 0 ? \[{ heal: n, ticks: 3 }] : \[]; }

// Consume one tick & return total + next state
function tickPois(list) {
if (!list.length) return { total: 0, next: \[] };
const p = list\[0];
const total = Math.max(0, p.dmg|0);
const left = (p.ticks|0) - 1;
return { total, next: left > 0 ? \[{ dmg: p.dmg|0, ticks: left }] : \[] };
}
function tickHoly(list) {
if (!list.length) return { total: 0, next: \[] };
const h = list\[0];
const total = Math.max(0, h.heal|0);
const left = (h.ticks|0) - 1;
return { total, next: left > 0 ? \[{ heal: h.heal|0, ticks: left }] : \[] };
}

// ---------- Round resolution (Duels) ----------
async function resolveDuelRound(channel) {
const f0 = getFight.get(channel.id);
if (!f0) return;

// Respect stun: don't lock bot actions if stunned
let f = f0;
if (!f.p2\_action\_json && f.p2\_id === client.user.id && !(f.p2\_stunned > 0)) {
const act = pickBotChipFor(f, false);
if (act) {
updFightRound.run(
f.p1\_hp, f.p2\_hp,
f.p1\_def, f.p2\_def,
f.p1\_counts\_json, f.p2\_counts\_json,
f.p1\_special\_used, f.p2\_special\_used,
f.p1\_action\_json, JSON.stringify(act),
f.round\_deadline,
f.p1\_stunned|0, f.p2\_stunned|0,
f.p1\_poison\_json, f.p2\_poison\_json,
f.p1\_holy\_json, f.p2\_holy\_json,
channel.id
);
f = getFight.get(channel.id);
}
}
if (!f.p1\_action\_json && f.p1\_id === client.user.id && !(f.p1\_stunned > 0)) {
const act = pickBotChipFor(f, true);
if (act) {
updFightRound.run(
f.p1\_hp, f.p2\_hp,
f.p1\_def, f.p2\_def,
f.p1\_counts\_json, f.p2\_counts\_json,
f.p1\_special\_used, f.p2\_special\_used,
JSON.stringify(act), f.p2\_action\_json,
f.round\_deadline,
f.p1\_stunned|0, f.p2\_stunned|0,
f.p1\_poison\_json, f.p2\_poison\_json,
f.p1\_holy\_json, f.p2\_holy\_json,
channel.id
);
f = getFight.get(channel.id);
}
}

const p1 = ensureNavi(f.p1\_id);
const p2 = ensureNavi(f.p2\_id);

// Status at start of round
const p1WasStunned = (f.p1\_stunned || 0) > 0;
const p2WasStunned = (f.p2\_stunned || 0) > 0;

const p1Pois = parsePois(f.p1\_poison\_json);
const p2Pois = parsePois(f.p2\_poison\_json);
const p1Holy = parseHoly(f.p1\_holy\_json);
const p2Holy = parseHoly(f.p2\_holy\_json);

let nextPoisP1 = p1Pois, nextPoisP2 = p2Pois;
let nextHolyP1 = p1Holy, nextHolyP2 = p2Holy;

const A1raw = decodeAction(f.p1\_action\_json);
const A2raw = decodeAction(f.p2\_action\_json);

// If neither acted and deadline passed, reschedule another wait
if (!A1raw && !A2raw) {
const nextDeadline = now() + ROUND\_SECONDS \* 1000;
updFightRound.run(f.p1\_hp, f.p2\_hp, 0, 0, f.p1\_counts\_json, f.p2\_counts\_json, f.p1\_special\_used, f.p2\_special\_used, null, null, nextDeadline,
f.p1\_stunned|0, f.p2\_stunned|0, f.p1\_poison\_json, f.p2\_poison\_json, f.p1\_holy\_json, f.p2\_holy\_json, channel.id);
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
if (!inv) return { def: 0, barrier: false, attackEff: null, rec: 0, used: \[], supportEff: null, repair: false, holyAmt: 0 };
if (inv.type === 'chip') {
const { r, e } = rowAndEff(inv.name);
if (!r) return { def: 0, barrier: false, attackEff: null, rec: 0, used: \[], supportEff: null, repair: false, holyAmt: 0 };
let def = 0, barrier = false, attackEff = null, rec = 0;
if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
if (isBarrier(e)) barrier = true;
if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
if (isAttack(e)) attackEff = e;
const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
if (holyAmt > 0) rec = 0; // holy heals via ticks only
return { def, barrier, attackEff, rec, supportEff: null, used: \[r.name], repair: isRepair(e), holyAmt };
}
if (inv.type === 'support') {
const { r: sr, e: se } = rowAndEff(inv.support);
const { r: cr, e: ce } = rowAndEff(inv.with);
if (!sr || !cr) return { def: 0, barrier: false, attackEff: null, rec: 0, used: \[], supportEff: null, repair: false, holyAmt: 0 };
let def = 0, barrier = false, attackEff = null, rec = 0;
if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
if (isBarrier(ce)) barrier = true;
if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0); // fixed ce.heal
if (isAttack(ce)) attackEff = ce;
const holyGuess = Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : (Number.isFinite(ce.dmg) ? ce.dmg : 0));
const holyAmt = isHoly(ce) ? Math.max(0, holyGuess|0) : 0;
if (holyAmt > 0) rec = 0; // holy heals via ticks only
return { def, barrier, attackEff, rec, supportEff: se, used: \[sr.name, cr.name], repair: isRepair(ce), holyAmt };
}
}

const P1 = p1WasStunned ? { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 } : interpret(A1raw);
const P2 = p2WasStunned ? { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 } : interpret(A2raw);

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
if (p1Repaired) { nextPoisP1 = \[]; nextHolyP1 = \[]; }
if (p2Repaired) { nextPoisP2 = \[]; nextHolyP2 = \[]; }

// PARALYZE: set stun for next round if the hit landed
let paraP2 = false, paraP1 = false;
if (P1.attackEff && isParalyze(P1.attackEff) && !dodged1 && !cancelledByBarrier1) paraP2 = true;
if (P2.attackEff && isParalyze(P2.attackEff) && !dodged2 && !cancelledByBarrier2) paraP1 = true;

// Immediate hp after direct dmg + instant rec (ticks after)
let p1hp = Math.max(0, Math.min(p1.max\_hp, f.p1\_hp - dmg2to1 + rec1));
let p2hp = Math.max(0, Math.min(p2.max\_hp, f.p2\_hp - dmg1to2 + rec2));

// Apply ticks (poison hurts, holy heals) — includes the round of application
const { total: tickPoisonP1, next: poisAfterP1 } = tickPois(nextPoisP1);
const { total: tickPoisonP2, next: poisAfterP2 } = tickPois(nextPoisP2);
const { total: tickHolyP1,   next: holyAfterP1 } = tickHoly(nextHolyP1);
const { total: tickHolyP2,   next: holyAfterP2 } = tickHoly(nextHolyP2);

p1hp = Math.max(0, Math.min(p1.max\_hp, p1hp - tickPoisonP1 + tickHolyP1));
p2hp = Math.max(0, Math.min(p2.max\_hp, p2hp - tickPoisonP2 + tickHolyP2));

nextPoisP1 = poisAfterP1; nextPoisP2 = poisAfterP2;
nextHolyP1 = holyAfterP1; nextHolyP2 = holyAfterP2;

// Counters / specials
function bumpCounters(counts, specials, usedNames) {
for (const n of (usedNames || \[])) {
counts\[n] = (counts\[n] || 0) + 1;
const eff = readEffect(getChip.get(n));
if (isSpecial(eff)) specials.add(n);
}
}
let p1Counts = parseMap(f.p1\_counts\_json);
let p2Counts = parseMap(f.p2\_counts\_json);
let p1Spec = new Set(parseList(f.p1\_special\_used));
let p2Spec = new Set(parseList(f.p2\_special\_used));
bumpCounters(p1Counts, p1Spec, P1.used);
bumpCounters(p2Counts, p2Spec, P2.used);

// Outcome check
let outcome = '';
if (p1hp === 0 && p2hp === 0) {
outcome = '🤝 **Double KO!** No W/L changes.';
} else if (p1hp === 0) {
outcome = `🏆 **<@${f.p2_id}> wins**!`;
setRecord.run(0, 1, f.p1\_id);
setRecord.run(1, 0, f.p2\_id);
} else if (p2hp === 0) {
outcome = `🏆 **<@${f.p1_id}> wins**!`;
setRecord.run(1, 0, f.p1\_id);
setRecord.run(0, 1, f.p2\_id);
}

// Apply stuns (for next round)
const nextP1Stun = paraP1 ? 1 : 0;
const nextP2Stun = paraP2 ? 1 : 0;

// If fight ended, clear and announce
if (outcome) {
endFight.run(channel.id);
clearRoundTimer(channel.id);
await channel.send(\[
`🎲 **Round resolved!**`,
`• <@${f.p1_id}> used: ${P1.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• <@${f.p2_id}> used: ${P2.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• Damage dealt: <@${f.p1_id}> → **${dmg1to2}** | <@${f.p2_id}> → **${dmg2to1}**`,
`• Ticks: Poison(<@${f.p1_id}> **-${tickPoisonP1}** / <@${f.p2_id}> **-${tickPoisonP2}**), Holy(<@${f.p1_id}> **+${tickHolyP1}** / <@${f.p2_id}> **+${tickHolyP2}**)`,
`• Attack cancelled by barrier: P1→${cancelledByBarrier1?'✅':'❌'} | P2→${cancelledByBarrier2?'✅':'❌'}`,
`• Dodges: P1→${dodged2?'✅':'❌'} | P2→${dodged1?'✅':'❌'}`,
'',
hpLineDuel({ ...f, p1\_hp: p1hp, p2\_hp: p2hp }),
outcome
].join('\n'));
return;
}

// Persist next state and schedule next round
const nextDeadline = now() + ROUND\_SECONDS \* 1000;
const nextP1Counts = JSON.stringify(p1Counts);
const nextP2Counts = JSON.stringify(p2Counts);
const nextP1Spec = JSON.stringify(Array.from(p1Spec));
const nextP2Spec = JSON.stringify(Array.from(p2Spec));

db.exec(`     UPDATE duel_state SET
      p1_hp=${p1hp}, p2_hp=${p2hp},
      p1_def=0, p2_def=0,
      p1_counts_json='${nextP1Counts.replace(/'/g,"''")}',
      p2_counts_json='${nextP2Counts.replace(/'/g,"''")}',
      p1_special_used='${nextP1Spec.replace(/'/g,"''")}',
      p2_special_used='${nextP2Spec.replace(/'/g,"''")}',
      p1_action_json=NULL, p2_action_json=NULL,
      round_deadline=${nextDeadline},
      p1_stunned=${nextP1Stun}, p2_stunned=${nextP2Stun},
      p1_poison_json='${JSON.stringify(nextPoisP1).replace(/'/g,"''")}',
      p2_poison_json='${JSON.stringify(nextPoisP2).replace(/'/g,"''")}',
      p1_holy_json='${JSON.stringify(nextHolyP1).replace(/'/g,"''")}',
      p2_holy_json='${JSON.stringify(nextHolyP2).replace(/'/g,"''")}'
    WHERE channel_id='${channel.id}';
  `);

scheduleRoundTimer(channel.id, () => resolveDuelRound(channel));

const critLine = (c1,c2)=>`Crits: P1→${c1?'✅':'❌'} | P2→${c2?'✅':'❌'}`; // fixed order
await channel.send(\[
`🎲 **Round resolved!**`,
`• <@${f.p1_id}> used: ${P1.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• <@${f.p2_id}> used: ${P2.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• Damage dealt: <@${f.p1_id}> → **${dmg1to2}** | <@${f.p2_id}> → **${dmg2to1}**`,
`• Absorbed by DEF: P1→**${absorbed2}** | P2→**${absorbed1}**`,
`• ${critLine(crit1,crit2)}`,
`• Ticks: Poison(<@${f.p1_id}> **-${tickPoisonP1}** / <@${f.p2_id}> **-${tickPoisonP2}**), Holy(<@${f.p1_id}> **+${tickHolyP1}** / <@${f.p2_id}> **+${tickHolyP2}**)`,
'',
hpLineDuel({ ...f, p1\_hp: p1hp, p2\_hp: p2hp }),
`⏳ Next round: **${ROUND_SECONDS}s** — play with **/use**`
].join('\n'));
}

// ---------- Round resolution (PVE) ----------
async function resolvePveRound(channel) {
const s0 = getPVE.get(channel.id);
if (!s0) return;

const player = ensureNavi(s0.player\_id);

// Virus pick if needed
let s = s0;
if (!s.virus\_action\_json && !(s.v\_stunned > 0)) {
const mv = pickVirusMove(s);
if (mv) {
updPVE.run(
s.p\_hp, s.v\_hp,
s.p\_def, s.v\_def,
s.p\_counts\_json, s.p\_special\_used, s.v\_special\_used,
s.player\_action\_json, JSON.stringify(mv),
s.round\_deadline, s.v\_def\_total, s.v\_def\_streak,
s.p\_stunned|0, s.v\_stunned|0,
s.p\_poison\_json, s.v\_poison\_json,
s.p\_holy\_json, s.v\_holy\_json,
channel.id
);
s = getPVE.get(channel.id);
}
}

const APlayer = decodeAction(s.player\_action\_json);
const AVirus  = decodeAction(s.virus\_action\_json);

if (!APlayer && !AVirus) {
const nextDeadline = now() + ROUND\_SECONDS \* 1000;
updPVE.run(s.p\_hp, s.v\_hp, 0, 0, s.p\_counts\_json, s.p\_special\_used, s.v\_special\_used, null, null, nextDeadline, s.v\_def\_total, s.v\_def\_streak,
s.p\_stunned|0, s.v\_stunned|0, s.p\_poison\_json, s.v\_poison\_json, s.p\_holy\_json, s.v\_holy\_json, channel.id);
scheduleRoundTimer(channel.id, () => resolvePveRound(channel));
await channel.send(`⏳ New round started. Submit your chip with **/use** in **${ROUND_SECONDS}s**.\n${hpLinePVE(getPVE.get(channel.id))}`);
return;
}

const rowAndEff = (name) => {
const r = getChip.get(name);
const e = readEffect(r);
return { r, e };
};
const interpret = (inv) => {
if (!inv) return { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 };
if (inv.type === 'chip') {
const { r, e } = rowAndEff(inv.name);
if (!r) return { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 };
let def=0, barrier=false, attackEff=null, rec=0;
if (isDefense(e)) def += Number.isFinite(e.def) ? e.def : 0;
if (isBarrier(e)) barrier = true;
if (isRecovery(e)) rec += Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : 0);
if (isAttack(e)) attackEff = e;
const holyGuess = Number.isFinite(e.heal) ? e.heal : (Number.isFinite(e.rec) ? e.rec : (Number.isFinite(e.dmg) ? e.dmg : 0));
const holyAmt = isHoly(e) ? Math.max(0, holyGuess|0) : 0;
if (holyAmt > 0) rec = 0;
return { def, barrier, attackEff, rec, used:\[r.name], supportEff\:null, repair\:isRepair(e), holyAmt };
}
if (inv.type === 'support') {
const { r: sr, e: se } = rowAndEff(inv.support);
const { r: cr, e: ce } = rowAndEff(inv.with);
if (!sr || !cr) return { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 };
let def=0, barrier=false, attackEff=null, rec=0;
if (isDefense(ce)) def += Number.isFinite(ce.def) ? ce.def : 0;
if (isBarrier(ce)) barrier = true;
if (isRecovery(ce)) rec += Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : 0); // fixed ce.heal
if (isAttack(ce)) attackEff = ce;
const holyGuess = Number.isFinite(ce.heal) ? ce.heal : (Number.isFinite(ce.rec) ? ce.rec : (Number.isFinite(ce.dmg) ? ce.dmg : 0));
const holyAmt = isHoly(ce) ? Math.max(0, holyGuess|0) : 0;
if (holyAmt > 0) rec = 0;
return { def, barrier, attackEff, rec, used:\[sr.name, cr.name], supportEff: se, repair\:isRepair(ce), holyAmt };
}
return { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 };
};

const pStunned = (s.p\_stunned || 0) > 0;
const vStunned = (s.v\_stunned || 0) > 0;

const P = pStunned ? { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 } : interpret(APlayer);
const V = vStunned ? { def:0, barrier\:false, attackEff\:null, rec:0, used:\[], supportEff\:null, repair\:false, holyAmt:0 } : interpret(AVirus);

let pDEF = P.def|0, vDEF = V.def|0;
const pBarrier = !!P.barrier, vBarrier = !!V.barrier;

// AI caps tracking
let vDefTotal = Number(s.v\_def\_total||0);
let vDefStreak = Number(s.v\_def\_streak||0);
if (isDefLikeMove(AVirus)) {
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
breakFlag: isBreak(P.attackEff), dodgePct: s.virus\_dodge, critPct: player.crit,
});
({ dmg: dmgPtoV, crit: critP, dodged: dodgedP, absorbed: absorbedP, cancelledByBarrier: cancelledByBarrierP } = res);
}

let dmgVtoP=0, critV=false, dodgedV=false, absorbedV=0, cancelledByBarrierV=false;
if (V.attackEff) {
const res = computeAttackDamage({
baseChip: V.attackEff, supportEff: V.supportEff,
defenderDEF: pDEF, defenderHasBarrier: pBarrier,
breakFlag: isBreak(V.attackEff), dodgePct: player.dodge, critPct: s.virus\_crit,
});
({ dmg: dmgVtoP, crit: critV, dodged: dodgedV, absorbed: absorbedV, cancelledByBarrier: cancelledByBarrierV } = res);
}

// Immediate recovery (suppressed by enemy barrier if your attack was cancelled)
let pRec = P.rec||0; if (P.attackEff && vBarrier && !isBreak(P.attackEff)) pRec = 0;
let vRec = V.rec||0; if (V.attackEff && pBarrier && !isBreak(V.attackEff)) vRec = 0;

// Status JSONs
const pPois = parsePois(s.p\_poison\_json);
const vPois = parsePois(s.v\_poison\_json);
const pHoly = parseHoly(s.p\_holy\_json);
const vHoly = parseHoly(s.v\_holy\_json);
let nextPoisP = pPois, nextPoisV = vPois;
let nextHolyP = pHoly, nextHolyV = vHoly;

// Poison application converts immediate damage into ticks (includes absorbed)
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

// Holy application (regen ticks only)
if (P.holyAmt > 0) nextHolyP = replaceHoly(nextHolyP, P.holyAmt);
if (V.holyAmt > 0) nextHolyV = replaceHoly(nextHolyV, V.holyAmt);

// Repair: cleanse self
if (P.repair) { nextPoisP = \[]; nextHolyP = \[]; }
if (V.repair) { nextPoisV = \[]; nextHolyV = \[]; }

// Paralyze for next round (if landed)
const stunVNext = (P.attackEff && isParalyze(P.attackEff) && !dodgedP && !cancelledByBarrierP) ? 1 : 0;
const stunPNext = (V.attackEff && isParalyze(V.attackEff) && !dodgedV && !cancelledByBarrierV) ? 1 : 0;

// Immediate HP with direct dmg + instant rec (ticks later)
let php = Math.max(0, Math.min(player.max\_hp, s.p\_hp - dmgVtoP + pRec));
let vhp = Math.max(0, Math.min(s.virus\_max\_hp, s.v\_hp - dmgPtoV + vRec));

// Apply ticks
const { total: tPoisP, next: poisAfterP } = tickPois(nextPoisP);
const { total: tPoisV, next: poisAfterV } = tickPois(nextPoisV);
const { total: tHolyP, next: holyAfterP } = tickHoly(nextHolyP);
const { total: tHolyV, next: holyAfterV } = tickHoly(nextHolyV);

php = Math.max(0, Math.min(player.max\_hp, php - tPoisP + tHolyP));
vhp = Math.max(0, Math.min(s.virus\_max\_hp, vhp - tPoisV + tHolyV));

nextPoisP = poisAfterP; nextPoisV = poisAfterV;
nextHolyP = holyAfterP; nextHolyV = holyAfterV;

// Count usage & specials (player only)
const pCounts = parseMap(s.p\_counts\_json);
const pSpec = new Set(parseList(s.p\_special\_used));
for (const n of (P.used||\[])) {
pCounts\[n] = (pCounts\[n]||0) + 1;
const eff = readEffect(getChip.get(n));
if (isSpecial(eff)) pSpec.add(n);
}

// Outcome?
if (php === 0 && vhp === 0) {
endPVE.run(channel.id);
clearRoundTimer(channel.id);
await channel.send(\[
`🎲 **Round resolved!**`,
`• You used: ${P.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• Virus used: ${V.used?.map(n=>`**\${n}**`).join(' + ') || (AVirus?.name || '—')}`,
`• Damage dealt: You → **${dmgPtoV}** | Virus → **${dmgVtoP}**`,
'',
hpLinePVE({ ...s, p\_hp: php, v\_hp: vhp }),
'🤝 **Double KO!**'
].join('\n'));
return;
}
if (vhp === 0) {
// Rewards
const z = Math.max(0, Math.floor(Math.random() \* (s.virus\_zmax - s.virus\_zmin + 1)) + s.virus\_zmin);
if (z) addZenny.run(s.player\_id, z);

```
// Chip drop chance
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

// Mission completion
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
clearRoundTimer(channel.id);

await channel.send([
  `🎲 **Round resolved!**`,
  `• You used: ${P.used?.map(n=>`**${n}**`).join(' + ') || '—'}`,
  `• Virus used: ${V.used?.map(n=>`**${n}**`).join(' + ') || (AVirus?.name || '—')}`,
  `• Damage dealt: You → **${dmgPtoV}** | Virus → **${dmgVtoP}**`,
  '',
  `🏆 **Victory!** You defeated **${s.virus_name}**.`,
  z ? `+${z} ${zennyIcon()} awarded.` : '',
  dropLine,
  missionLine
].filter(Boolean).join('\n'));
return;
```

}
if (php === 0) {
endPVE.run(channel.id);
clearRoundTimer(channel.id);
await channel.send(\[
`🎲 **Round resolved!**`,
`• You used: ${P.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• Virus used: ${V.used?.map(n=>`**\${n}**`).join(' + ') || (AVirus?.name || '—')}`,
`• Damage dealt: You → **${dmgPtoV}** | Virus → **${dmgVtoP}**`,
'',
hpLinePVE({ ...s, p\_hp: php, v\_hp: vhp }),
`💀 **Defeat...** Try again with **/virus_busting**.`
].join('\n'));
return;
}

// Persist next state
const nextDeadline = now() + ROUND\_SECONDS \* 1000;
const nextCounts = JSON.stringify(pCounts);
const nextSpec = JSON.stringify(Array.from(pSpec));

db.exec(`     UPDATE pve_state SET
      p_hp=${php}, v_hp=${vhp},
      p_def=0, v_def=0,
      p_counts_json='${nextCounts.replace(/'/g,"''")}',
      p_special_used='${nextSpec.replace(/'/g,"''")}',
      player_action_json=NULL, virus_action_json=NULL,
      round_deadline=${nextDeadline},
      v_def_total=${vDefTotal}, v_def_streak=${vDefStreak},
      p_stunned=${stunPNext}, v_stunned=${stunVNext},
      p_poison_json='${JSON.stringify(nextPoisP).replace(/'/g,"''")}',
      v_poison_json='${JSON.stringify(nextPoisV).replace(/'/g,"''")}',
      p_holy_json='${JSON.stringify(nextHolyP).replace(/'/g,"''")}',
      v_holy_json='${JSON.stringify(nextHolyV).replace(/'/g,"''")}'
    WHERE channel_id='${channel.id}';
  `);

scheduleRoundTimer(channel.id, () => resolvePveRound(channel));

await channel.send(\[
`🎲 **Round resolved!**`,
`• You used: ${P.used?.map(n=>`**\${n}**`).join(' + ') || '—'}`,
`• Virus used: ${V.used?.map(n=>`**\${n}**`).join(' + ') || (AVirus?.name || '—')}`,
`• Damage dealt: You → **${dmgPtoV}** | Virus → **${dmgVtoP}**`,
`• Absorbed by DEF: You→**${absorbedV}** | Virus→**${absorbedP}**`,
`• Ticks (you/virus): Poison **-${tPoisP}**/**-${tPoisV}**, Holy **+${tHolyP}**/**+${tHolyV}**`,
'',
hpLinePVE({ ...s, p\_hp: php, v\_hp: vhp }),
`⏳ Next round: **${ROUND_SECONDS}s** — play with **/use**`
].join('\n'));
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

// ---------- Interaction handlers ----------
client.on('interactionCreate', async (ix) => {
try {
// Autocomplete
if (ix.isAutocomplete()) {
const focused = ix.options.getFocused(true);
const name = ix.commandName;

```
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

  // Chip autocompletes: show names
  const q = (focused.value || '').toLowerCase();
  const names = listAllChipNames.all().map(r => r.name);
  const opts = names.filter(n => n.toLowerCase().includes(q)).slice(0,25).map(n => ({ name:n, value:n }));
  await ix.respond(opts);
  return;
}

if (!ix.isChatInputCommand() && !ix.isButton() && !ix.isStringSelectMenu()) return;

// -------- Commands --------
if (ix.isChatInputCommand()) {
  const cmd = ix.commandName;

  if (cmd === 'navi_register') {
    const row = ensureNavi(ix.user.id);
    await ix.reply({ content: `✅ Registered. Max HP **${row.max_hp}**, Dodge **${row.dodge}%**, Crit **${row.crit}%**.`, ephemeral: true });
    return;
  }

  if (cmd === 'navi_stats') {
    const user = ix.options.getUser('user') || ix.user;
    const n = ensureNavi(user.id);
    const loc = ensureLoc(user.id);
    const inv = listInv.all(user.id);
    const chipsOwned = inv.reduce((a,c)=>a+c.qty,0);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${user.username}'s Navi`)
      .setDescription([
        `HP **${n.max_hp}** • Dodge **${n.dodge}%** • Crit **${n.crit}%**`,
        `Record **${n.wins}-${n.losses}**`,
        `${zennyIcon()} **${n.zenny}** • Points **${n.upgrade_pts}**`,
        `📍 Region **${loc.region}** / Zone **${loc.zone}**`,
        `🧾 Chips: **${chipsOwned}**`
      ].join('\n'))
      .setThumbnail(user.displayAvatarURL());
    await ix.reply({ embeds:[embed] });
    return;
  }

  if (cmd === 'navi_leaderboard') {
    const limit = Math.min(25, Math.max(5, ix.options.getInteger('limit') || 10));
    const rows = db.prepare(`SELECT user_id, wins, losses FROM navis ORDER BY wins DESC, losses ASC LIMIT ?`).all(limit);
    const lines = rows
      .map((r,i)=> `**${i+1}.** <@${r.user_id}> — **${r.wins}-${r.losses}**`)
      .join('\n') || '—';
    await ix.reply({ embeds: [ new EmbedBuilder().setTitle('🏆 Leaderboard').setDescription(lines) ] });
    return;
  }

  if (cmd === 'navi_upgrade') {
    const stat = ix.options.getString('stat');
    let amount = ix.options.getInteger('amount') || 1;
    const n = ensureNavi(ix.user.id);

    if (MANUAL_UPGRADES_MODE === 'points') {
      if (stat === 'hp') {
        const steps = Math.max(1, Math.floor((amount||1)));
        const cost = steps * Math.ceil(HP_POINTS_PER_STEP);
        if ((n.upgrade_pts|0) < cost) { await ix.reply({ content:`❌ Need **${cost}** points. You have **${n.upgrade_pts}**.`, ephemeral:true }); return; }
        const nextHP = Math.min(MAX_HP_CAP, n.max_hp + (steps * HP_STEP_SIZE));
        updHP.run(nextHP, ix.user.id);
        updPts.run(n.upgrade_pts - cost, ix.user.id);
        await ix.reply(`🧬 Max HP increased to **${nextHP}** (spent ${cost} points).`);
      } else if (stat === 'dodge') {
        const steps = Math.max(1, Math.floor(amount));
        const cost = steps * CRIT_DODGE_COST;
        if ((n.upgrade_pts|0) < cost) { await ix.reply({ content:`❌ Need **${cost}** points. You have **${n.upgrade_pts}**.`, ephemeral:true }); return; }
        const next = Math.min(MAX_DODGE_CAP, n.dodge + steps);
        updDodge.run(next, ix.user.id);
        updPts.run(n.upgrade_pts - cost, ix.user.id);
        await ix.reply(`🧬 Dodge increased to **${next}%** (spent ${cost} points).`);
      } else if (stat === 'crit') {
        const steps = Math.max(1, Math.floor(amount));
        const cost = steps * CRIT_DODGE_COST;
        if ((n.upgrade_pts|0) < cost) { await ix.reply({ content:`❌ Need **${cost}** points. You have **${n.upgrade_pts}**.`, ephemeral:true }); return; }
        const next = Math.min(MAX_CRIT_CAP, n.crit + steps);
        updCrit.run(next, ix.user.id);
        updPts.run(n.upgrade_pts - cost, ix.user.id);
        await ix.reply(`🧬 Crit increased to **${next}%** (spent ${cost} points).`);
      } else {
        await ix.reply({ content:'❌ Invalid stat.', ephemeral:true });
      }
    } else {
      // admin-only mode
      if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin-only in this mode.', ephemeral:true }); return; }
      const clamp = (s,val) => s==='hp' ? Math.min(MAX_HP_CAP, Math.max(1,val)) :
                               (s==='dodge' ? Math.min(MAX_DODGE_CAP, Math.max(0,val)) :
                               (s==='crit' ? Math.min(MAX_CRIT_CAP, Math.max(0,val)) : val));
      if (stat === 'hp') { updHP.run(clamp('hp', (n.max_hp + amount)), ix.user.id); }
      if (stat === 'dodge') { updDodge.run(clamp('dodge', (n.dodge + amount)), ix.user.id); }
      if (stat === 'crit') { updCrit.run(clamp('crit', (n.crit + amount)), ix.user.id); }
      await ix.reply('✅ Updated.');
    }
    return;
  }

  if (cmd === 'duel') {
    const opp = ix.options.getUser('opponent');
    if (!opp || opp.id === ix.user.id) { await ix.reply({ content:'❌ Pick another user.', ephemeral:true }); return; }
    if (getFight.get(ix.channel.id) || getPVE.get(ix.channel.id)) { await ix.reply({ content:'❌ A fight/encounter is already running in this channel.', ephemeral:true }); return; }
    const p1 = ensureNavi(ix.user.id);
    const p2 = ensureNavi(opp.id);
    startFight.run(
      ix.channel.id, ix.user.id, opp.id,
      p1.max_hp, p2.max_hp,
      0, 0, '{}', '{}', '[]', '[]',
      null, null, now() + ROUND_SECONDS*1000, now()
    );
    scheduleRoundTimer(ix.channel.id, () => resolveDuelRound(ix.channel));
    await ix.reply([
      `⚔️ **Duel started!** <@${ix.user.id}> vs <@${opp.id}>`,
      `⏳ Play your chips with **/use** (you may chain a Support).`,
      `Timer: **${ROUND_SECONDS}s**`,
      hpLineDuel(getFight.get(ix.channel.id))
    ].join('\n'));
    return;
  }

  if (cmd === 'forfeit') {
    const f = getFight.get(ix.channel.id);
    const s = getPVE.get(ix.channel.id);
    if (!f && !s) { await ix.reply({ content:'❌ No duel/encounter here.', ephemeral:true }); return; }
    if (f) {
      const loser = (ix.user.id === f.p1_id) ? f.p1_id : (ix.user.id === f.p2_id ? f.p2_id : null);
      if (!loser) { await ix.reply({ content:'❌ Only participants may forfeit.', ephemeral:true }); return; }
      const winner = (loser === f.p1_id) ? f.p2_id : f.p1_id;
      setRecord.run(0,1,loser);
      setRecord.run(1,0,winner);
      endFight.run(ix.channel.id);
      clearRoundTimer(ix.channel.id);
      await ix.reply(`🏳️ **<@${loser}> forfeits!** <@${winner}> wins!`);
    } else {
      if (ix.user.id !== s.player_id) { await ix.reply({ content:'❌ Only the participant may forfeit.', ephemeral:true }); return; }
      endPVE.run(ix.channel.id);
      clearRoundTimer(ix.channel.id);
      await ix.reply('🏳️ You left the encounter.');
    }
    return;
  }

  if (cmd === 'duel_state') {
    const f = getFight.get(ix.channel.id);
    const s = getPVE.get(ix.channel.id);
    if (!f && !s) { await ix.reply('— No active duel/encounter here.'); return; }
    if (f) { await ix.reply(hpLineDuel(f)); return; }
    if (s) { await ix.reply(hpLinePVE(s)); return; }
  }

  if (cmd === 'zenny') {
    const user = ix.options.getUser('user') || ix.user;
    const n = ensureNavi(user.id);
    await ix.reply(`${zennyIcon()} **${user.username}** has **${n.zenny}** Zenny.`);
    return;
  }

  if (cmd === 'give_zenny') {
    const to = ix.options.getUser('to');
    const amount = ix.options.getInteger('amount') || 0;
    if (!to || amount <= 0) { await ix.reply({ content:'❌ Specify a valid recipient and amount.', ephemeral:true }); return; }
    const me = ensureNavi(ix.user.id);
    if ((me.zenny|0) < amount) { await ix.reply({ content:`❌ Not enough ${zennyIcon()}.`, ephemeral:true }); return; }
    setZenny.run(me.zenny - amount, ix.user.id);
    addZenny.run(to.id, amount);
    await ix.reply(`✅ Sent **${amount}** ${zennyIcon()} to <@${to.id}>.`);
    return;
  }

  if (cmd === 'shop') {
    const rows = listShop.all();
    const { embed, components } = buildShopPage(rows, 0);
    await ix.reply({ embeds:[embed], components });
    return;
  }

  if (cmd === 'folder') {
    const inv = listInv.all(ix.user.id);
    const lines = inv.map(r=>`• **${r.chip_name}** × **${r.qty}**`).join('\n') || '—';
    await ix.reply({ embeds:[ new EmbedBuilder().setTitle('📁 Your Folder').setDescription(lines) ] });
    return;
  }

  if (cmd === 'give_chip') {
    const to = ix.options.getUser('to');
    const name = ix.options.getString('name');
    const qty = ix.options.getInteger('qty') || 1;
    if (!to || !name || qty <= 0) { await ix.reply({ content:'❌ Provide recipient, chip, qty.', ephemeral:true }); return; }
    const have = invGetQty(ix.user.id, name);
    if (have < qty) { await ix.reply({ content:`❌ You only have **${have}** of **${name}**.`, ephemeral:true }); return; }
    invAdd(ix.user.id, name, -qty);
    invAdd(to.id, name, qty);
    await ix.reply(`✅ Gave **${qty}× ${name}** to <@${to.id}>.`);
    return;
  }

  if (cmd === 'chips_reload') {
    if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin only.', ephemeral:true }); return; }
    try {
      await reloadChipsFromTSV();
      await ix.reply('✅ Chips reloaded.');
    } catch (e) {
      await ix.reply({ content:`❌ ${e.message}`, ephemeral:true });
    }
    return;
  }

  if (cmd === 'chip_grant') {
    if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin only.', ephemeral:true }); return; }
    const user = ix.options.getUser('user');
    const name = ix.options.getString('name');
    const qty = ix.options.getInteger('qty') || 1;
    if (!getChip.get(name)) { await ix.reply({ content:'❌ Unknown chip.', ephemeral:true }); return; }
    invAdd(user.id, name, qty);
    await ix.reply(`✅ Granted **${qty}× ${name}** to <@${user.id}>.`);
    return;
  }

  if (cmd === 'chip_remove') {
    if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin only.', ephemeral:true }); return; }
    const user = ix.options.getUser('user');
    const name = ix.options.getString('name');
    const qty = ix.options.getInteger('qty') || 1;
    const have = invGetQty(user.id, name);
    invAdd(user.id, name, -Math.min(have, qty));
    await ix.reply(`✅ Removed up to **${qty}× ${name}** from <@${user.id}>.`);
    return;
  }

  if (cmd === 'stat_override') {
    if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin only.', ephemeral:true }); return; }
    const user = ix.options.getUser('user');
    const stat = ix.options.getString('stat');
    const value = ix.options.getInteger('value');
    if (stat==='hp') updHP.run(Math.min(MAX_HP_CAP, Math.max(1,value)), user.id);
    if (stat==='dodge') updDodge.run(Math.min(MAX_DODGE_CAP, Math.max(0,value)), user.id);
    if (stat==='crit') updCrit.run(Math.min(MAX_CRIT_CAP, Math.max(0,value)), user.id);
    if (stat==='wins') updWins.run(Math.max(0,value), user.id);
    if (stat==='losses') updLosses.run(Math.max(0,value), user.id);
    if (stat==='points') updPts.run(Math.max(0,value), user.id);
    await ix.reply('✅ Updated.');
    return;
  }

  if (cmd === 'zenny_override') {
    if (!isAdmin(ix)) { await ix.reply({ content:'❌ Admin only.', ephemeral:true }); return; }
    const user = ix.options.getUser('user');
    const amt = ix.options.getInteger('amount') || 0;
    addZenny.run(user.id, amt);
    await ix.reply(`✅ Added **${amt}** ${zennyIcon()} to <@${user.id}>.`);
    return;
  }

  if (cmd === 'virus_search') {
    const name = ix.options.getString('name');
    const viruses = await loadViruses(false);
    const v = viruses.find(x => normalize(x.name) === normalize(name)) || viruses.find(x => x.name.toLowerCase().includes(name.toLowerCase()));
    if (!v) { await ix.reply('❌ Not found.'); return; }
    const m = (v.moves||[]).map(o=>{
      const kinds = extractKinds(o);
      const line = [
        `• **${o.name || o.label || 'Move'}**`,
        kinds.length ? `(${kinds.join(', ')})` : '',
        Number.isFinite(o.dmg) ? `DMG ${o.dmg}` : '',
        Number.isFinite(o.def) ? `DEF ${o.def}` : '',
        Number.isFinite(o.heal) ? `Heal ${o.heal}` : (Number.isFinite(o.rec) ? `Heal ${o.rec}` : ''),
        o.special ? '⭐Special' : ''
      ].filter(Boolean).join(' ');
      return line;
    }).join('\n') || '—';
    const drops = (v.chip_drops||[]).length ? v.chip_drops.join(', ') : (v.chip_drop||'—');
    const desc = [
      `HP **${v.hp}** • Dodge **${v.dodge}%** • Crit **${v.crit}%**${v.boss?' • 💀 **Boss**':''}`,
      `Zenny **${v.zmin}–${v.zmax}**`,
      `Region **${v.region||'Any'}** / Zone **${v.zone||'Any'}**`,
      '',
      `Moves:\n${m}`,
      '',
      `Possible chip drops (chance ${Math.round(VIRUS_CHIP_DROP_PCT*100)}%): ${drops || '—'}`
    ].join('\n');
    const emb = new EmbedBuilder().setTitle(`🦠 ${v.name}`).setDescription(desc);
    if (v.image_url) emb.setThumbnail(v.image_url);
    await ix.reply({ embeds:[emb] });
    return;
  }

  if (cmd === 'virus_busting') {
    if (getFight.get(ix.channel.id) || getPVE.get(ix.channel.id)) { await ix.reply({ content:'❌ Already running here.', ephemeral:true }); return; }
    const v = await pickVirusForUser(ix.user.id);
    const me = ensureNavi(ix.user.id);
    startPVE.run(
      ix.channel.id, ix.user.id,
      v.name, v.image_url||null,
      v.hp|0, v.dodge|0, v.crit|0, v.boss?1:0,
      JSON.stringify(v.moves||[]), v.zmin|0, v.zmax|0,
      me.max_hp|0, v.hp|0, 0, 0, '{}', '[]', '[]', null, null, now()+ROUND_SECONDS*1000, 0, 0, now(),
      0, 0, '[]', '[]', '[]', '[]'
    );
    scheduleRoundTimer(ix.channel.id, () => resolvePveRound(ix.channel));
    const here = ensureLoc(ix.user.id);
    await ix.reply([
      `🦠 **Encounter!** ${v.boss?'💀 **Boss** — ':''}**${v.name}** appears!`,
      `Region filter: ${here.region} / Zone ${here.zone}`,
      `⏳ Play with **/use** (you may chain a Support). Timer **${ROUND_SECONDS}s**`,
      hpLinePVE(getPVE.get(ix.channel.id))
    ].join('\n'));
    return;
  }

  if (cmd === 'use') {
    const chip = ix.options.getString('chip');
    const support = ix.options.getString('support');
    const f = getFight.get(ix.channel.id);
    const s = getPVE.get(ix.channel.id);
    if (!f && !s) { await ix.reply({ content:'❌ No active duel/encounter here.', ephemeral:true }); return; }

    // Validate chips exist
    const chipRow = getChip.get(chip);
    if (!chipRow || chipRow.is_upgrade) { await ix.reply({ content:'❌ Invalid chip.', ephemeral:true }); return; }

    let supportRow = null;
    if (support) {
      supportRow = getChip.get(support);
      if (!supportRow || supportRow.is_upgrade) { await ix.reply({ content:'❌ Invalid Support chip.', ephemeral:true }); return; }
      if (!isSupport(readEffect(supportRow))) { await ix.reply({ content:'❌ The support chip must have kind "support".', ephemeral:true }); return; }
    }

    // Folder ownership check
    if (invGetQty(ix.user.id, chip) <= 0) { await ix.reply({ content:`❌ You do not own **${chip}**.`, ephemeral:true }); return; }
    if (support && invGetQty(ix.user.id, support) <= 0) { await ix.reply({ content:`❌ You do not own **${support}**.`, ephemeral:true }); return; }

    if (f) {
      if (ix.user.id !== f.p1_id && ix.user.id !== f.p2_id) { await ix.reply({ content:'❌ Only participants may act.', ephemeral:true }); return; }
      const isP1 = ix.user.id === f.p1_id;

      // per-battle limits & specials
      const counts = parseMap(isP1 ? f.p1_counts_json : f.p2_counts_json);
      const specials = new Set(parseList(isP1 ? f.p1_special_used : f.p2_special_used));
      const useNames = [chipRow.name].concat(supportRow ? [supportRow.name] : []);
      for (const n of useNames) {
        const r = getChip.get(n);
        if ((counts[n]||0) >= MAX_PER_CHIP) { await ix.reply({ content:`❌ Per-battle limit reached for **${n}** (max ${MAX_PER_CHIP}).`, ephemeral:true }); return; }
        if (isSpecial(readEffect(r)) && specials.has(n)) { await ix.reply({ content:`❌ **${n}** is Special and already used this battle.`, ephemeral:true }); return; }
      }

      // Stun check
      if ((isP1 && (f.p1_stunned||0)>0) || (!isP1 && (f.p2_stunned||0)>0)) {
        await ix.reply({ content:`⚡ You are stunned and cannot act this round.`, ephemeral:true });
        return;
      }

      const act = support ? actionSupport(supportRow.name, chipRow.name) : actionChip(chipRow.name);
      if (isP1) {
        updFightRound.run(
          f.p1_hp, f.p2_hp,
          f.p1_def, f.p2_def,
          f.p1_counts_json, f.p2_counts_json,
          f.p1_special_used, f.p2_special_used,
          act, f.p2_action_json,
          f.round_deadline,
          f.p1_stunned|0, f.p2_stunned|0,
          f.p1_poison_json, f.p2_poison_json,
          f.p1_holy_json, f.p2_holy_json,
          ix.channel.id
        );
      } else {
        updFightRound.run(
          f.p1_hp, f.p2_hp,
          f.p1_def, f.p2_def,
          f.p1_counts_json, f.p2_counts_json,
          f.p1_special_used, f.p2_special_used,
          f.p1_action_json, act,
          f.round_deadline,
          f.p1_stunned|0, f.p2_stunned|0,
          f.p1_poison_json, f.p2_poison_json,
          f.p1_holy_json, f.p2_holy_json,
          ix.channel.id
        );
      }
      await ix.reply(`✅ Action queued.`);
      const f2 = getFight.get(ix.channel.id);
      if (f2.p1_action_json && f2.p2_action_json) {
        clearRoundTimer(ix.channel.id);
        await resolveDuelRound(ix.channel);
      }
      return;
    }

    if (s) {
      if (ix.user.id !== s.player_id) { await ix.reply({ content:'❌ Only the participant may act.', ephemeral:true }); return; }
      if ((s.p_stunned||0) > 0) { await ix.reply({ content:`⚡ You are stunned and cannot act this round.`, ephemeral:true }); return; }

      // per-encounter limits & specials
      const counts = parseMap(s.p_counts_json);
      const specials = new Set(parseList(s.p_special_used));
      const useNames = [chipRow.name].concat(supportRow ? [supportRow.name] : []);
      for (const n of useNames) {
        if ((counts[n]||0) >= MAX_PER_CHIP) { await ix.reply({ content:`❌ Per-encounter limit reached for **${n}** (max ${MAX_PER_CHIP}).`, ephemeral:true }); return; }
        if (isSpecial(readEffect(getChip.get(n))) && specials.has(n)) { await ix.reply({ content:`❌ **${n}** is Special and already used this encounter.`, ephemeral:true }); return; }
      }

      const act = support ? actionSupport(supportRow.name, chipRow.name) : actionChip(chipRow.name);
      updPVE.run(
        s.p_hp, s.v_hp,
        s.p_def, s.v_def,
        s.p_counts_json, s.p_special_used, s.v_special_used,
        act, s.virus_action_json,
        s.round_deadline, s.v_def_total, s.v_def_streak,
        s.p_stunned|0, s.v_stunned|0,
        s.p_poison_json, s.v_poison_json,
        s.p_holy_json, s.v_holy_json,
        ix.channel.id
      );
      await ix.reply(`✅ Action queued.`);
      const s2 = getPVE.get(ix.channel.id);
      if (s2.player_action_json && s2.virus_action_json) {
        clearRoundTimer(ix.channel.id);
        await resolvePveRound(ix.channel);
      }
      return;
    }
  }

  if (cmd === 'metroline') {
    const region = ix.options.getString('region');
    const zone = ix.options.getInteger('zone');
    if (!REGIONS.includes(region) || ![1,2,3].includes(zone)) {
      await ix.reply({ content:'❌ Invalid region/zone.', ephemeral:true }); return;
    }
    setLoc.run(ix.user.id, region, zone);
    await ix.reply(`🚆 Moved to **${region} / Area ${zone}**.`);
    return;
  }

  if (cmd === 'bbs_mission') {
    // cooldown?
    const lock = getCooldown.get(ix.user.id);
    if (lock && (lock.until > Date.now())) {
      await ix.reply({ content:`⏳ You're locked out for **${msToClock(lock.until - Date.now())}**.`, ephemeral:true });
      return;
    }

    const loc = ensureLoc(ix.user.id);
    const all = await loadMissions(false);
    const pool = all.filter(m => normalize(m.region) === normalize(loc.region));
    if (!pool.length) { await ix.reply('❌ No missions for your region right now.'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setActiveMission.run(ix.user.id, pick.mission_id, pick.region, pick.target_chip, pick.target_boss, pick.reward_zenny, pick.keep_chip, Date.now());

    const lines = [
      `🧾 **Mission ${pick.mission_id}** — Region **${pick.region}**`,
      pick.target_chip ? `• Play chip **${pick.target_chip}** during a successful bust` : '',
      pick.target_boss ? `• Defeat boss **${pick.target_boss}**` : '',
      `• Reward: **${pick.reward_zenny}** ${zennyIcon()}`,
      `Use **/bbs_mission_quit** to abandon (5m lockout).`
    ].filter(Boolean).join('\n');
    await ix.reply(lines);
    return;
  }

  if (cmd === 'bbs_mission_quit') {
    const am = getActiveMission.get(ix.user.id);
    if (!am) { await ix.reply({ content:'❌ No active mission.', ephemeral:true }); return; }
    abandonMission.run(ix.user.id, am.mission_id);
    scheduleMissionCooldown(ix.user.id, 5 * 60 * 1000, ix.channel.id);
    await ix.reply('🛑 Mission abandoned. ⏰ 5-minute lockout started.');
    return;
  }

  // Fallback
  await ix.reply({ content:'❌ Unknown command.', ephemeral:true });
}

// -------- Component handlers (Shop pagination & selection) --------
if (ix.isStringSelectMenu() && ix.customId.startsWith('shop:select:')) {
  const page = parseInt(ix.customId.split(':')[2], 10) || 0;
  const name = ix.values[0];
  const row = getChip.get(name);
  if (!row) { await ix.reply({ content:'❌ Not found.', ephemeral:true }); return; }
  const eff = readEffect(row);
  const desc = summarizeEffect(eff);
  const dynCost = dynamicUpgradeCostFor(ix.user.id, row);
  const embed = new EmbedBuilder()
    .setTitle(`${row.is_upgrade ? '🧬 Upgrade' : '💾 Chip'} — ${row.name}`)
    .setDescription([
      row.image_url ? `[image](${row.image_url})` : '',
      desc,
      '',
      `${zennyIcon()} Cost: **${row.is_upgrade ? `${dynCost} (dynamic)` : row.zenny_cost}**`
    ].filter(Boolean).join('\n'));

  // PATCH #1: upgrades => only Buy 1; chips => Buy 1 / Buy 5
  const rowBtns = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop:buy:${name}:1`).setLabel('Buy 1').setStyle(ButtonStyle.Primary)
  );
  if (!row.is_upgrade) {
    rowBtns.addComponents(
      new ButtonBuilder().setCustomId(`shop:buy:${name}:5`).setLabel('Buy 5').setStyle(ButtonStyle.Secondary)
    );
  }
  rowBtns.addComponents(new ButtonBuilder().setCustomId('shop:close').setLabel('Close').setStyle(ButtonStyle.Danger));

  await ix.reply({ embeds:[embed], components:[rowBtns], ephemeral:true });
  return;
}

if (ix.isButton()) {
  if (ix.customId === 'shop:close') {
    // Attempt to delete if not ephemeral (ephemeral can't be deleted)
    try {
      if (!ix.message?.flags?.has?.(4096)) { // EPHEMERAL flag
        await ix.message.delete();
      }
    } catch {}
    await ix.reply({ content:'🛑 Closed.', ephemeral:true });
    return;
  }
  if (ix.customId.startsWith('shop:prev:') || ix.customId.startsWith('shop:next:')) {
    const parts = ix.customId.split(':');
    const dir = parts[1];
    const page = parseInt(parts[2], 10) || 0;
    const rows = listShop.all();
    const nextPage = dir === 'prev' ? Math.max(0, page-1) : Math.min(Math.ceil(rows.length/25)-1, page+1);
    const { embed, components } = buildShopPage(rows, nextPage);
    await ix.update({ embeds:[embed], components });
    return;
  }
  if (ix.customId.startsWith('shop:buy:')) {
    // PATCH #2: server-side clamp for upgrades
    const [, , name, qtyStr] = ix.customId.split(':');
    let qty = Math.max(1, parseInt(qtyStr, 10) || 1);
    const row = getChip.get(name);
    if (!row) { await ix.reply({ content:'❌ Not found.', ephemeral:true }); return; }

    if (row.is_upgrade) qty = 1; // enforce upgrades one-at-a-time

    const n = ensureNavi(ix.user.id);
    const cost = row.is_upgrade
      ? Math.floor(dynamicUpgradeTotalFor(ix.user.id, row, qty)) // qty=1 for upgrades after clamp
      : (row.zenny_cost * qty);

    if ((n.zenny|0) < cost) { await ix.reply({ content:`❌ Need **${cost}** ${zennyIcon()}. You have **${n.zenny}**.`, ephemeral:true }); return; }

    setZenny.run(n.zenny - cost, ix.user.id);

    if (row.is_upgrade) {
      applyUpgrade(ix.user.id, row, 1);               // force 1
      bumpUpgCountBy.run(ix.user.id, row.name, 1);    // force 1
      await ix.reply(`✅ Purchased **1× ${row.name}**. Stats updated. (-${cost} ${zennyIcon()})`);
    } else {
      invAdd(ix.user.id, row.name, qty);
      await ix.reply(`✅ Purchased **${qty}× ${row.name}** to your folder. (-${cost} ${zennyIcon()})`);
    }
    return;
  }
}
```

} catch (e) {
console.error('interaction error', e);
try {
if (ix.replied || ix.deferred) {
await ix.followUp({ content:'❌ Error.', ephemeral\:true });
} else {
await ix.reply({ content:'❌ Error. Check logs.', ephemeral\:true });
}
} catch {}
}
});

// Optional: clean timers on channel delete to avoid leaks
client.on('channelDelete', (ch) => {
clearRoundTimer(ch.id);
});

// ---------- Login & ready ----------
client.once('ready', async () => {
console.log(`Logged in as ${client.user.tag}`);
try { await registerCommands(); } catch (e) { console.warn('Register failed:', e?.message); }
});

client.login(process.env.DISCORD\_TOKEN);
