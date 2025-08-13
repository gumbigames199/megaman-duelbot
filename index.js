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
  EmbedBuilder
} from 'discord.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { CHIPS, UPGRADES } from './chips.js';

// ---------- Config ----------
// Defaults: NumberMan#3954 and ToadMan#0810
const USAGE_BOT_IDS = (process.env.USAGE_BOT_IDS || '1110053775911162056,1403989752432037898')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const NUMBERMAN_ID = '1110053775911162056';
const ADMIN_ROLE_ID = '830126829352386601';

// Upgrades mode: 'points' (default), 'admin', or 'disabled'
const MANUAL_UPGRADES_MODE = (process.env.MANUAL_UPGRADES_MODE || 'points').toLowerCase();
// Points awarded per win (default 1)
const POINTS_PER_WIN = parseInt(process.env.POINTS_PER_WIN || '1', 10);

// Per-chip cap per duel
const MAX_PER_CHIP = 4;

// Virus TSV URL (Google Sheets export to TSV)
const VIRUS_TSV_URL = process.env.VIRUS_TSV_URL || '';
// Zenny emoji helpers
const ZENNY_EMOJI_ID = process.env.ZENNY_EMOJI_ID || '1110249272433201274';
const ZENNY_EMOJI_NAME = process.env.ZENNY_EMOJI_NAME || 'zenny';
const zennyIcon = () => (/^\d{17,20}$/.test(ZENNY_EMOJI_ID) ? `<:${ZENNY_EMOJI_NAME}:${ZENNY_EMOJI_ID}>` : '💰');

// Ensure data dir exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Small helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Auto-register slash commands (guild-scoped) ----------
async function registerCommands() {
  const TOKEN    = process.env.DISCORD_TOKEN;
  const APP_ID   = process.env.CLIENT_ID || process.env.APPLICATION_ID;
  const GUILD_ID = process.env.GUILD_ID; // set this in Railway for your server

  if (!TOKEN || !APP_ID || !GUILD_ID) {
    console.warn('[commands] Skipping register: missing DISCORD_TOKEN / CLIENT_ID(APPLICATION_ID) / GUILD_ID');
    return;
  }

  const cmds = [
    new SlashCommandBuilder()
      .setName('navi_register')
      .setDescription('Register your Navi'),

    new SlashCommandBuilder()
      .setName('navi_upgrade')
      .setDescription('Upgrade your Navi (points/admin)')
      .addStringOption(o =>
        o.setName('stat').setDescription('Stat to upgrade').setRequired(true)
         .addChoices({ name: 'hp', value: 'hp' }, { name: 'dodge', value: 'dodge' }, { name: 'crit', value: 'crit' })
      )
      .addIntegerOption(o =>
        o.setName('amount').setDescription('Optional amount (may be ignored in points mode)').setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('navi_stats')
      .setDescription('Show Navi stats')
      .addUserOption(o => o.setName('user').setDescription('User to inspect').setRequired(false)),

    new SlashCommandBuilder()
      .setName('duel')
      .setDescription('Challenge someone to a duel')
      .addUserOption(o => o.setName('opponent').setDescription('Who to duel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('forfeit')
      .setDescription('Forfeit the current duel'),

    new SlashCommandBuilder()
      .setName('duel_state')
      .setDescription('Show the current duel state (HP, temp Defense, turn, specials used)'),

    new SlashCommandBuilder()
      .setName('navi_leaderboard')
      .setDescription('Show top players by record')
      .addIntegerOption(o =>
        o.setName('limit').setDescription('How many to list (5-25, default 10)').setRequired(false)
      ),

    // NEW: Virus Busting (PVE)
    new SlashCommandBuilder()
      .setName('virus_busting')
      .setDescription('Start a Virus encounter (PVE)'),

    // NEW: Zenny balance
    new SlashCommandBuilder()
      .setName('zenny')
      .setDescription('Show Zenny balance')
      .addUserOption(o => o.setName('user').setDescription('User to inspect').setRequired(false)),

    // NEW: Give Zenny
    new SlashCommandBuilder()
      .setName('give_zenny')
      .setDescription('Give some of your Zenny to another player')
      .addUserOption(o => o.setName('to').setDescription('Recipient').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to send').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
      .setName('stat_override')
      .setDescription('Admin-only: set or add to a player stat')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addStringOption(o =>
        o.setName('stat').setDescription('Stat to modify').setRequired(true).addChoices(
          { name: 'HP', value: 'hp' },
          { name: 'Dodge', value: 'dodge' },
          { name: 'Crit', value: 'crit' },
          { name: 'Wins', value: 'wins' },
          { name: 'Losses', value: 'losses' },
          { name: 'Points', value: 'points' },
          { name: 'Zenny', value: 'zenny' }
        )
      )
      .addStringOption(o =>
        o.setName('mode').setDescription('How to apply the value').setRequired(true)
          .addChoices({ name: 'Set exact value', value: 'set' }, { name: 'Add to current', value: 'add' })
      )
      .addIntegerOption(o => o.setName('value').setDescription('Value to set/add').setRequired(true)),
  ].map(c => c.toJSON());

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
CREATE TABLE IF NOT EXISTS duel_state (
  channel_id TEXT PRIMARY KEY,
  p1_id TEXT NOT NULL,
  p2_id TEXT NOT NULL,
  turn TEXT NOT NULL,
  p1_hp INTEGER NOT NULL,
  p2_hp INTEGER NOT NULL,
  p1_def INTEGER NOT NULL DEFAULT 0,
  p2_def INTEGER NOT NULL DEFAULT 0,
  p1_counts_json TEXT NOT NULL DEFAULT '{}',
  p2_counts_json TEXT NOT NULL DEFAULT '{}',
  p1_special_used TEXT NOT NULL DEFAULT '[]',
  p2_special_used TEXT NOT NULL DEFAULT '[]',
  last_hit_p1 INTEGER NOT NULL DEFAULT 0,
  last_hit_p2 INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
);
-- NEW: PVE virus state per channel
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

  turn TEXT NOT NULL, -- 'player' | 'virus'
  p_hp INTEGER NOT NULL,
  v_hp INTEGER NOT NULL,
  p_def INTEGER NOT NULL DEFAULT 0,
  v_def INTEGER NOT NULL DEFAULT 0,
  p_counts_json TEXT NOT NULL DEFAULT '{}',
  p_special_used TEXT NOT NULL DEFAULT '[]', -- player's specials used (chips)
  v_special_used TEXT NOT NULL DEFAULT '[]', -- boss specials used (move names that are special:true)
  last_hit_p INTEGER NOT NULL DEFAULT 0,
  last_hit_v INTEGER NOT NULL DEFAULT 0,

  started_at INTEGER NOT NULL
);
`);
// Safe migrations for older DBs
try { db.exec(`ALTER TABLE navis ADD COLUMN wins            INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE navis ADD COLUMN losses          INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE navis ADD COLUMN upgrade_pts     INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE navis ADD COLUMN zenny           INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_def      INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_def      INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_counts_json TEXT NOT NULL DEFAULT '{}';`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p2_counts_json TEXT NOT NULL DEFAULT '{}';`); } catch {}
try { db.exec(`ALTER TABLE duel_state ADD COLUMN p1_special_used TEXT NOT NULL DEFAULT '[]';`); } catch {}

// PVE migrations
try { db.exec(`ALTER TABLE pve_state ADD COLUMN virus_zmin INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN virus_zmax INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE pve_state ADD COLUMN v_special_used TEXT NOT NULL DEFAULT '[]';`); } catch {}

const getNavi = db.prepare(`SELECT * FROM navis WHERE user_id=?`);
const upsertNavi = db.prepare(`
INSERT INTO navis (user_id,max_hp,dodge,crit,wins,losses,upgrade_pts,zenny) VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET
  max_hp=excluded.max_hp,
  dodge=excluded.dodge,
  crit=excluded.crit
`);
function ensureNavi(uid) {
  const row = getNavi.get(uid);
  if (row) return row;
  upsertNavi.run(uid, 250, 20, 5, 0, 0, 0, 0);
  return { user_id: uid, max_hp: 250, dodge: 20, crit: 5, wins: 0, losses: 0, upgrade_pts: 0, zenny: 0 };
}

const setRecord  = db.prepare(`UPDATE navis SET wins = wins + ?, losses = losses + ? WHERE user_id = ?`);
const addPoints  = db.prepare(`UPDATE navis SET upgrade_pts = upgrade_pts + ? WHERE user_id = ?`);
const addZenny   = db.prepare(`UPDATE navis SET zenny = zenny + ? WHERE user_id = ?`);
const setZenny   = db.prepare(`UPDATE navis SET zenny = ? WHERE user_id = ?`);
const updHP      = db.prepare(`UPDATE navis SET max_hp=?      WHERE user_id=?`);
const updDodge   = db.prepare(`UPDATE navis SET dodge=?       WHERE user_id=?`);
const updCrit    = db.prepare(`UPDATE navis SET crit=?        WHERE user_id=?`);
const updWins    = db.prepare(`UPDATE navis SET wins=?        WHERE user_id=?`);
const updLosses  = db.prepare(`UPDATE navis SET losses=?      WHERE user_id=?`);
const updPts     = db.prepare(`UPDATE navis SET upgrade_pts=? WHERE user_id=?`);

function awardResult(winnerId, loserId) {
  setRecord.run(1, 0, winnerId);
  setRecord.run(0, 1, loserId);
  if (POINTS_PER_WIN > 0) addPoints.run(POINTS_PER_WIN, winnerId); // +points to winner
}

const getFight   = db.prepare(`SELECT * FROM duel_state WHERE channel_id=?`);
const startFight = db.prepare(`
  INSERT INTO duel_state
    (channel_id,p1_id,p2_id,turn,p1_hp,p2_hp,p1_def,p2_def,p1_counts_json,p2_counts_json,p1_special_used,p2_special_used,started_at)
  VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const updFight   = db.prepare(`
  UPDATE duel_state
     SET p1_hp=?, p2_hp=?,
         p1_def=?, p2_def=?,
         p1_counts_json=?, p2_counts_json=?,
         p1_special_used=?, p2_special_used=?,
         turn=?, last_hit_p1=?, last_hit_p2=?
   WHERE channel_id=?
`);
const endFight   = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

// PVE prepared statements
const getPVE = db.prepare(`SELECT * FROM pve_state WHERE channel_id=?`);
const startPVE = db.prepare(`
  INSERT INTO pve_state (
    channel_id, player_id, virus_name, virus_image, virus_max_hp, virus_dodge, virus_crit, virus_is_boss, virus_moves_json, virus_zmin, virus_zmax,
    turn, p_hp, v_hp, p_def, v_def, p_counts_json, p_special_used, v_special_used, last_hit_p, last_hit_v, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const updPVE = db.prepare(`
  UPDATE pve_state
     SET p_hp=?, v_hp=?,
         p_def=?, v_def=?,
         p_counts_json=?, p_special_used=?, v_special_used=?,
         turn=?, last_hit_p=?, last_hit_v=?
   WHERE channel_id=?
`);
const endPVE = db.prepare(`DELETE FROM pve_state WHERE channel_id=?`);

// Helpers
function hpLine(f, p1hp, p2hp) {
  return `HP — <@${f.p1_id}>: ${p1hp} | <@${f.p2_id}>: ${p2hp}`;
}
function hpLinePVE(f, php, vhp) {
  return `HP — <@${f.player_id}>: ${php} | **${f.virus_name}**: ${vhp}`;
}
const normalize = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '');
const parseList = (s) => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
};
const parseMap = (s) => {
  try {
    const v = JSON.parse(s ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};
const parseMoves = (s) => {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const isScrimmage = (f) => !!f && (f.p1_id === client.user?.id || f.p2_id === client.user?.id);

// --- Micro-debounce to avoid double-processing near-duplicate action lines ---
const recentActions = new Map(); // key => timestamp
function shouldDebounce(channelId, actorId, chipKey, ms = 2000) {
  const now = Date.now();
  const key = `${channelId}:${actorId}:${chipKey}`;
  const last = recentActions.get(key) || 0;
  if (now - last < ms) return true;
  recentActions.set(key, now);
  return false;
}

// NEW: Track ToadMan's consecutive chip usage per channel (to avoid 3+ repeats)
const botLastUse = new Map(); // channelId -> { chip: string|null, streak: number }

// ---------- Virus TSV Loader ----------
const VirusCache = { ts: 0, rows: [] };
const HEADER_MAP = (h) => (h || '').toLowerCase().trim().replace(/[^\w]+/g, '_'); // "stat points" -> "stat_points"

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
  const sp = Number(row.stat_points || row.statpoint || row.stat || 1);
  const boss = !!row.boss;
  // Basic viruses (1..4): 1 most common -> 4 least
  // weights: 1->4, 2->3, 3->2, 4->1
  if (!boss) return Math.max(1, 5 - Math.max(1, Math.min(4, sp)));
  // Bosses (5..7): small weights (rarer)
  // 5 -> 1, 6 -> 0.6, 7 -> 0.4 (tune later)
  if (sp <= 5) return 1;
  if (sp === 6) return 0.6;
  return 0.4;
}

async function loadViruses(force = false) {
  const FRESH_MS = 1000 * 60 * 5; // 5 min
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

    // Moves (support move1_json, move_2json/move2_json, move3_json, move4_json)
    const m1 = obj.move1_json || obj.move_1json || '';
    const m2 = obj.move_2json || obj.move2_json || '';
    const m3 = obj.move3_json || '';
    const m4 = obj.move4_json || '';
    const moves = [];
    const pushMove = (s, fallback) => {
      if (!s) return;
      try {
        const mv = JSON.parse(s);
        if (mv && typeof mv === 'object') {
          if (!mv.name) mv.name = fallback;
          moves.push(mv);
        }
      } catch {}
    };
    pushMove(m1, 'Move1');
    pushMove(m2, 'Move2');
    pushMove(m3, 'Move3');
    pushMove(m4, 'Move4');

    const sp = parseInt((obj.stat_points || obj.statpoint || '1'), 10) || 1;
    const boss = String(obj.boss || '').toLowerCase().trim();
    const isBoss = ['1','true','yes','y'].includes(boss);

    const { min: zmin, max: zmax } = parseRange(obj.zenny || obj.zenny_range || '');

    rows.push({
      name,
      image_url: obj.image_url || '',
      hp, dodge, crit,
      moves,
      stat_points: sp,
      boss: isBoss,
      weight: 0, // filled later
      zmin, zmax
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
  for (const r of rows) {
    roll -= (r.weight || 0);
    if (roll <= 0) return r;
  }
  return rows[rows.length - 1];
}

/* ============================
   SMART AI MEMORY + SCORERS
   ============================ */
// --- AI memory (per channel + actorTag) ---
const aiMem = new Map(); // key: `${channelId}:${actorTag}` -> { lastMove, repeat, nonAttackStreak }
function getAIMem(channelId, actorTag) {
  const key = `${channelId}:${actorTag}`;
  let m = aiMem.get(key);
  if (!m) { m = { lastMove: null, repeat: 0, nonAttackStreak: 0 }; aiMem.set(key, m); }
  return { key, m };
}
function clearAIMemForChannel(channelId) {
  for (const k of aiMem.keys()) if (k.startsWith(`${channelId}:`)) aiMem.delete(k);
}

// Generic scorer for CHIPS (ToadMan / PvP bot)
// tier: 'wild' | 'boss'
function pickAIMove({ channelId, f, actorId, counts, specialsUsed, tier }) {
  const isP1   = (actorId === f.p1_id);
  const myHP   = isP1 ? f.p1_hp : f.p2_hp;
  const myDEF  = isP1 ? (f.p1_def ?? 0) : (f.p2_def ?? 0);
  const myMax  = ensureNavi(actorId).max_hp;
  const oppHP  = isP1 ? f.p2_hp : f.p1_hp;
  const oppDEF = isP1 ? (f.p2_def ?? 0) : (f.p1_def ?? 0);
  const lastHitMe = isP1 ? f.last_hit_p1 : f.last_hit_p2;

  const { m } = getAIMem(channelId, actorId);

  let moves = Object.keys(CHIPS).map(name => ({ name, ...CHIPS[name] }));
  let eligible = moves.filter(x => {
    if (!x) return false;
    if ((counts[x.name] || 0) >= MAX_PER_CHIP) return false;
    if (x.special && specialsUsed.includes(x.name)) return false;
    if (x.kind === 'recovery' && myHP >= myMax) return false;
    if (x.kind === 'barrier' && (lastHitMe || 0) <= 0) return false;
    return true;
  });
  if (!eligible.length) eligible = moves.slice();

  let best = null, bestScore = -1e9;
  for (const mv of eligible) {
    const kind = mv.kind;
    const dmg  = Number.isFinite(mv.dmg)  ? mv.dmg  : 0;

    let s = 0;

    if (kind === 'attack')  s += 50 + dmg;
    if (kind === 'defense') s += 20 + (tier === 'boss' ? 10 : 0);
    if (kind === 'recovery') {
      if (myHP <= myMax * 0.30) s += 55;
      else if (myHP <= myMax * 0.50) s += 30;
    }
    if (kind === 'barrier') s += lastHitMe > 0 ? 35 : 5;

    if (kind === 'attack' && oppHP <= Math.max(0, dmg - oppDEF)) s += 40 + (tier === 'boss' ? 20 : 0);
    if (kind === 'attack') s += Math.max(0, 20 - oppDEF * 0.5);

    if (kind === 'defense' && lastHitMe > 0) s += Math.min(40, lastHitMe * 0.5);
    if (kind === 'recovery' && lastHitMe > 0) s += 10;

    if (m.lastMove === mv.name) s -= (m.repeat >= 2 ? 999 : 15 + m.repeat * 10);
    if (kind !== 'attack' && m.nonAttackStreak >= 2) s -= 60 + (tier === 'boss' ? 20 : 0);
    if (kind === 'defense' && myDEF > 0) s -= 30;

    if (mv.special && !specialsUsed.includes(mv.name)) {
      s += 20 + (tier === 'boss' ? 25 : 10);
      if (kind === 'attack' && oppHP <= Math.max(0, dmg - oppDEF)) s += 50;
      if (kind === 'recovery' && myHP <= myMax * 0.35) s += 30;
    }

    s += Math.random() * 6;

    if (s > bestScore) { bestScore = s; best = mv; }
  }

  return { move: best };
}

// Scorer for BOSS viruses (uses virus move list)
function pickBossMove(pve) {
  const moves = parseMoves(pve.virus_moves_json);
  if (!moves.length) return null;

  const usedSet = new Set(parseList(pve.v_special_used));
  const vHP   = pve.v_hp;
  const vDEF  = pve.v_def || 0;
  const vMax  = pve.virus_max_hp;
  const pHP   = pve.p_hp;
  const pDEF  = pve.p_def || 0;
  const lastV = pve.last_hit_v || 0;

  const { m } = getAIMem(pve.channel_id || 'chan', 'VIRUS');

  // Filter eligibility
  let eligible = moves.filter(mv => {
    const kind = String(mv.kind || '').toLowerCase();
    if (mv.special && usedSet.has(mv.name || mv.label || 'special')) return false;
    if (kind === 'recovery' && vHP >= vMax) return false;
    if (kind === 'barrier' && lastV <= 0) return false;
    return true;
  });
  if (!eligible.length) eligible = moves.slice();

  let best = null, bestScore = -1e9;
  for (const mv of eligible) {
    const name = mv.name || mv.label || 'Move';
    const kind = String(mv.kind || '').toLowerCase();
    const dmg  = Number.isFinite(mv.dmg) ? mv.dmg : 0;
    const heal = Number.isFinite(mv.heal) ? mv.heal : (Number.isFinite(mv.rec) ? mv.rec : 0);

    let s = 0;

    if (kind === 'attack')  s += 50 + dmg;
    if (kind === 'defense') s += 30;
    if (kind === 'recovery') {
      if (vHP <= vMax * 0.30) s += 60;
      else if (vHP <= vMax * 0.50) s += 30;
    }
    if (kind === 'barrier') s += lastV > 0 ? 40 : 0;

    // Finisher pressure (estimate through player's DEF)
    if (kind === 'attack' && pHP <= Math.max(0, dmg - pDEF)) s += 60;
    if (kind === 'attack') s += Math.max(0, 20 - pDEF * 0.5);

    // React to damage taken
    if (kind === 'defense' && lastV > 0) s += Math.min(45, lastV * 0.5);
    if (kind === 'recovery' && lastV > 0) s += 10;

    // Anti-spam / anti-turtle
    if (m.lastMove === name) s -= (m.repeat >= 2 ? 999 : 20 + m.repeat * 12);
    if (kind !== 'attack' && m.nonAttackStreak >= 2) s -= 75; // bosses avoid stalling
    if (kind === 'defense' && vDEF > 0) s -= 30;

    // Specials once — prioritize when impactful
    if (mv.special && !usedSet.has(name)) {
      s += 35;
      if (kind === 'attack' && pHP <= Math.max(0, dmg - pDEF)) s += 50;
      if (kind === 'recovery' && vHP <= vMax * 0.35) s += 30;
    }

    s += Math.random() * 6;
    if (s > bestScore) { bestScore = s; best = mv; }
  }

  return best || null;
}

/* ============================
   END SMART AI
   ============================ */

// ---------- Bot (ToadMan) turn logic for scrimmage ----------
// REPLACED: uses smart scorer
function pickBotChip(channelId, f) {
  const myCounts     = parseMap(f.turn === f.p1_id ? f.p1_counts_json : f.p2_counts_json);
  const specialsUsed = parseList(f.turn === f.p1_id ? f.p1_special_used : f.p2_special_used);
  const { move }     = pickAIMove({ channelId, f, actorId: f.turn, counts: myCounts, specialsUsed, tier: 'boss' });
  return move?.name || Object.keys(CHIPS)[0];
}

async function botTakeTurn(channel) {
  // Re-fetch latest fight
  const f = getFight.get(channel.id);
  if (!f || f.turn !== client.user.id) return; // not our turn or no fight

  const attackerIsP1 = (client.user.id === f.p1_id);
  let p1hp = f.p1_hp, p2hp = f.p2_hp;
  let p1def = f.p1_def ?? 0, p2def = f.p2_def ?? 0;
  let p1Spec = parseList(f.p1_special_used), p2Spec = parseList(f.p2_special_used);
  let p1Counts = parseMap(f.p1_counts_json), p2Counts = parseMap(f.p2_counts_json);
  let last1 = f.last_hit_p1, last2 = f.last_hit_p2;
  const attackerId = client.user.id;
  const defenderId = attackerIsP1 ? f.p2_id : f.p1_id;

  const chipKey = pickBotChip(channel.id, f) || Object.keys(CHIPS)[0];
  const chip = CHIPS[chipKey];
  if (!chip) return;

  // Update AI memory (variety & anti-turtle)
  {
    const { m } = getAIMem(channel.id, attackerId);
    if (m.lastMove === chipKey) m.repeat = (m.repeat || 1) + 1;
    else { m.lastMove = chipKey; m.repeat = 1; }
    const k = CHIPS[chipKey]?.kind;
    if (k === 'attack') m.nonAttackStreak = 0;
    else m.nonAttackStreak = (m.nonAttackStreak || 0) + 1;
  }

  // Record consecutive usage for ToadMan (avoid >2 in a row)
  {
    const prev = botLastUse.get(channel.id) || { chip: null, streak: 0 };
    const updated = (prev.chip === chipKey)
      ? { chip: chipKey, streak: prev.streak + 1 }
      : { chip: chipKey, streak: 1 };
    botLastUse.set(channel.id, updated);
  }

  // Counter check & increment
  const myCounts = attackerIsP1 ? p1Counts : p2Counts;
  const alreadyUsed = myCounts[chipKey] || 0;
  if (alreadyUsed >= MAX_PER_CHIP) {
    await sleep(300);
    return botTakeTurn(channel);
  }
  const usedNow = alreadyUsed + 1;
  myCounts[chipKey] = usedNow;

  let specialJustUsed = false;
  if (chip.special) {
    const usedArr = attackerIsP1 ? p1Spec : p2Spec;
    if (usedArr.includes(chipKey)) {
      await sleep(300);
      return botTakeTurn(channel);
    }
    usedArr.push(chipKey);
    specialJustUsed = true;
  }

  // Kinds
  if (chip.kind === 'barrier') {
    const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
    if (attackerIsP1) {
      if (last1 > 0) { p1hp = Math.min(p1hp + last1, ensureNavi(f.p1_id).max_hp); last1 = 0; }
    } else {
      if (last2 > 0) { p2hp = Math.min(p2hp + last2, ensureNavi(f.p2_id).max_hp); last2 = 0; }
    }
    if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

    updFight.run(
      p1hp, p2hp,
      p1def, p2def,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify(p1Spec), JSON.stringify(p2Spec),
      nextTurn, last1, last2, channel.id
    );
    return channel.send(
      `🛡️ <@${attackerId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''}! ` +
      `Restores the last damage.  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`
    );
  }

  if (chip.kind === 'defense') {
    const val = Number.isFinite(chip.def) ? chip.def : 0;
    if (attackerIsP1) p1def = Math.max(0, p1def + val);
    else              p2def = Math.max(0, p2def + val);
    const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;

    updFight.run(
      p1hp, p2hp,
      p1def, p2def,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify(p1Spec), JSON.stringify(p2Spec),
      nextTurn, last1, last2, channel.id
    );
    return channel.send(
      `🧱 <@${attackerId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
      `and raises Defense by **${val}** until their next turn. ➡️ <@${nextTurn}>`
    );
  }

  if (chip.kind === 'recovery') {
    const healVal = Number.isFinite(chip.heal) ? chip.heal : (Number.isFinite(chip.rec) ? chip.rec : 0);
    const stats = ensureNavi(attackerId);
    const maxhp = stats.max_hp;
    let healed = 0;
    if (attackerIsP1) {
      const before = p1hp;
      p1hp = Math.min(maxhp, p1hp + healVal);
      healed = p1hp - before;
    } else {
      const before = p2hp;
      p2hp = Math.min(maxhp, p2hp + healVal);
      healed = p2hp - before;
    }
    const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
    if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

    updFight.run(
      p1hp, p2hp,
      p1def, p2def,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify(p1Spec), JSON.stringify(p2Spec),
      nextTurn, last1, last2, channel.id
    );
    return channel.send(
      `💚 <@${attackerId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
      `and recovers **${healed}** HP.  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`
    );
  }

  // Attack: dodge + crit + defense absorption
  const defStats = ensureNavi(defenderId);
  const attStats = ensureNavi(attackerId);

  const dodged = (Math.random() * 100) < defStats.dodge;
  if (dodged) {
    const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
    if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;
    updFight.run(
      p1hp, p2hp,
      p1def, p2def,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify(p1Spec), JSON.stringify(p2Spec),
      nextTurn, last1, last2, channel.id
    );
    return channel.send(`💨 <@${defenderId}> dodged **${chipKey}** (${usedNow}/${MAX_PER_CHIP})!  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`);
  }

  const base = Number.isFinite(chip.dmg) ? chip.dmg : 0;
  const isCrit = (Math.random() * 100) < attStats.crit;
  const preDef = isCrit ? Math.floor((base * 3) / 2) : base;

  const defenderDef = attackerIsP1 ? p2def : p1def;
  const dmg = Math.max(0, preDef - defenderDef);
  const absorbed = preDef - dmg;

  if (attackerIsP1) { p2hp = Math.max(0, p2hp - dmg); last2 = dmg; }
  else { p1hp = Math.max(0, p1hp - dmg); last1 = dmg; }

  let nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
  if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

  let line =
    `💥 <@${attackerId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${isCrit ? ' _(CRIT!)_' : ''} ` +
    `for **${dmg}**.`;
  if (absorbed > 0) line += ` 🛡️ Defense absorbed **${absorbed}**.`;
  line += `  ${hpLine(f, p1hp, p2hp)}`;

  await channel.send(line);

  if (p1hp === 0 || p2hp === 0) {
    // Scrimmage end: NO W/L or points awarded
    const winnerId = p1hp === 0 ? f.p2_id : f.p1_id;
    endFight.run(channel.id);
    botLastUse.delete(channel.id);
    clearAIMemForChannel(channel.id);
    const scrimNote = ' _(scrimmage — no W/L or points)_';
    return channel.send(`🏆 **<@${winnerId}> wins!**${scrimNote}`);
  }

  updFight.run(
    p1hp, p2hp,
    p1def, p2def,
    JSON.stringify(p1Counts), JSON.stringify(p2Counts),
    JSON.stringify(p1Spec), JSON.stringify(p2Spec),
    nextTurn, last1, last2, channel.id
  );
  await channel.send(`➡️ <@${nextTurn}>, your turn.`);
}

// Helper to schedule bot move if next turn is ToadMan
async function maybeBotTurn(channel, nextTurnId) {
  if (nextTurnId !== client.user.id) return;
  await sleep(1200);
  return botTakeTurn(channel);
}

// ---------- Virus (PVE) bot logic (basic) ----------
function pickVirusMove(pve) {
  const moves = parseMoves(pve.virus_moves_json);
  if (!moves.length) return null;

  // Enforce boss special once (also applies for non-boss but harmless)
  const used = new Set(parseList(pve.v_special_used));
  const avail = moves.filter(m => !m?.special || !used.has(m.name || m.label || 'special'));
  if (!avail.length) return null;

  // Simple priorities for basic viruses
  const vHP = pve.v_hp;
  const vMax = pve.virus_max_hp;
  const lowHP = vHP / vMax <= 0.4;
  const kind = k => avail.filter(m => (m.kind || '').toLowerCase() === k);
  const heals = kind('recovery');
  const defs  = kind('defense');
  const atks  = kind('attack');
  const bars  = kind('barrier');

  let pool = avail;
  if (lowHP && heals.length) pool = heals;
  else if ((pve.v_def || 0) <= 0 && defs.length) pool = defs;
  else if (atks.length) pool = atks;
  else if (bars.length) pool = bars;

  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- Boss virus AI uses smart scorer ----------
async function virusTakeTurn(channel) {
  const f = getPVE.get(channel.id);
  if (!f || f.turn !== 'virus') return;

  let php = f.p_hp, vhp = f.v_hp;
  let pdef = f.p_def || 0, vdef = f.v_def || 0;
  let pCounts = parseMap(f.p_counts_json);
  let pSpec   = parseList(f.p_special_used);
  let vSpec   = parseList(f.v_special_used);
  let lastP   = f.last_hit_p, lastV = f.last_hit_v;

  const mv = f.virus_is_boss ? pickBossMove(f) : pickVirusMove(f);
  if (!mv) {
    // pass turn if nothing valid
    const next = 'player';
    if (next === 'player') pdef = 0; else vdef = 0;
    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
    return channel.send(`…${f.virus_name} hesitates. ➡️ <@${f.player_id}>, your turn.`);
  }

  const name = (mv.name || 'Move');
  const kind = String(mv.kind || '').toLowerCase();
  let line = '';

  // mark special if used (boss only)
  let specialTag = '';
  if (mv.special) {
    const tag = (mv.name || 'special');
    if (!vSpec.includes(tag)) {
      vSpec.push(tag);
      specialTag = ' _(special used)_';
    }
  }

  // Update boss memory (variety & anti-turtle)
  if (f.virus_is_boss) {
    const { m } = getAIMem(channel.id, 'VIRUS');
    if (m.lastMove === name) m.repeat = (m.repeat || 1) + 1;
    else { m.lastMove = name; m.repeat = 1; }
    if (kind === 'attack') m.nonAttackStreak = 0;
    else m.nonAttackStreak = (m.nonAttackStreak || 0) + 1;
  }

  if (kind === 'barrier') {
    if (lastV > 0) { vhp = Math.min(vhp + lastV, f.virus_max_hp); lastV = 0; }
    const next = 'player';
    if (next === 'player') pdef = 0; else vdef = 0;
    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
    return channel.send(`🛡️ **${f.virus_name}** uses **${name.toUpperCase()}**${specialTag}! Restores last damage.  ${hpLinePVE(f, php, vhp)} ➡️ <@${f.player_id}>`);
  }

  if (kind === 'defense') {
    const val = Number.isFinite(mv.def) ? mv.def : 0;
    vdef = Math.max(0, vdef + val);
    const next = 'player';
    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
    return channel.send(`🧱 **${f.virus_name}** uses **${name.toUpperCase()}**${specialTag} and raises Defense by **${val}** until its next turn. ➡️ <@${f.player_id}>`);
  }

  if (kind === 'recovery') {
    const healVal = Number.isFinite(mv.heal) ? mv.heal : (Number.isFinite(mv.rec) ? mv.rec : 0);
    const before = vhp;
    vhp = Math.min(f.virus_max_hp, vhp + healVal);
    const healed = vhp - before;
    const next = 'player';
    if (next === 'player') pdef = 0; else vdef = 0;
    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
    return channel.send(`💚 **${f.virus_name}** uses **${name.toUpperCase()}**${specialTag} and recovers **${healed}** HP.  ${hpLinePVE(f, php, vhp)} ➡️ <@${f.player_id}>`);
  }

  // attack
  const playerStats = ensureNavi(f.player_id);
  const dodged = (Math.random() * 100) < playerStats.dodge;
  if (dodged) {
    const next = 'player';
    if (next === 'player') pdef = 0; else vdef = 0;
    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
    return channel.send(`💨 <@${f.player_id}> dodged **${name}**!  ${hpLinePVE(f, php, vhp)} ➡️ <@${f.player_id}>`);
  }

  const base = Number.isFinite(mv.dmg) ? mv.dmg : 0;
  const isCrit = (Math.random() * 100) < (f.virus_crit || 0);
  const preDef = isCrit ? Math.floor((base * 3) / 2) : base;
  const eff = Math.max(0, preDef - pdef);
  const absorbed = preDef - eff;

  php = Math.max(0, php - eff);
  lastP = eff;

  const next = php === 0 ? 'done' : 'player';
  if (next === 'player') pdef = 0; else if (next === 'virus') vdef = 0;

  line = `💥 **${f.virus_name}** uses **${name.toUpperCase()}**${specialTag} for **${eff}**${isCrit ? ' _(CRIT!)_' : ''}.`;
  if (absorbed > 0) line += ` 🛡️ Defense absorbed **${absorbed}**.`;
  line += `  ${hpLinePVE(f, php, vhp)}`;
  await channel.send(line);

  if (php === 0 || vhp === 0) {
    // End and settle rewards if player won
    const playerWon = vhp === 0;
    const z = playerWon ? Math.max(f.virus_zmin || 0, Math.min(f.virus_zmax || 0, Math.floor(Math.random() * ((f.virus_zmax||0)-(f.virus_zmin||0)+1)) + (f.virus_zmin||0))) : 0;
    endPVE.run(channel.id);
    clearAIMemForChannel(channel.id);
    if (playerWon && z > 0) addZenny.run(z, f.player_id);
    if (playerWon) {
      return channel.send(`🏆 **<@${f.player_id}> wins!** You earned **${z}** ${zennyIcon()}.`);
    } else {
      return channel.send(`💀 **${f.virus_name}** wins! Better luck next time.`);
    }
  }

  updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, channel.id);
  await channel.send(`➡️ <@${f.player_id}>, your turn.`);
}

// ---------- Slash commands ----------
client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;

  if (ix.commandName === 'navi_register') {
    const row = ensureNavi(ix.user.id);
    return ix.reply({ content: `✅ Registered with **${row.max_hp} HP**, **${row.dodge}%** dodge, **${row.crit}%** crit.`, ephemeral: true });
  }

  // Points-based, admin-guardable upgrade
  if (ix.commandName === 'navi_upgrade') {
    if (MANUAL_UPGRADES_MODE === 'disabled') {
      return ix.reply({ content: 'Manual upgrades are disabled. Earn upgrades via wins or upgrade chips.', ephemeral: true });
    }

    const hasAdminRole = ix.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
    const hasManageGuild =
      ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      ix.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

    if (MANUAL_UPGRADES_MODE === 'admin' && !(hasAdminRole || hasManageGuild)) {
      return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
    }

    const stat = ix.options.getString('stat', true); // 'hp' | 'dodge' | 'crit'
    if (!['hp','dodge','crit'].includes(stat)) {
      return ix.reply({ content: 'Stat must be one of: hp, dodge, crit.', ephemeral: true });
    }

    const row = ensureNavi(ix.user.id);
    let { max_hp, dodge, crit, wins, losses, upgrade_pts } = row;

    if (MANUAL_UPGRADES_MODE === 'points') {
      if ((upgrade_pts ?? 0) < 1) {
        return ix.reply({ content: 'You have no upgrade points. Win duels to earn them!', ephemeral: true });
      }
    }

    const STEP = { hp: 10, dodge: 1, crit: 1 }[stat];
    const CAP  = { hp: 500, dodge: 40, crit: 25 }[stat];

    let before, after;
    if (stat === 'hp')    { before = max_hp; max_hp = Math.min(CAP, max_hp + STEP); after = max_hp; }
    if (stat === 'dodge') { before = dodge;  dodge  = Math.min(CAP,  dodge  + STEP); after = dodge;  }
    if (stat === 'crit')  { before = crit;   crit   = Math.min(CAP,  crit   + STEP); after = crit;   }

    if (after === before) {
      return ix.reply({ content: `Your ${stat.toUpperCase()} is already at the cap (${CAP}).`, ephemeral: true });
    }

    upsertNavi.run(ix.user.id, max_hp, dodge, crit, wins ?? 0, losses ?? 0, upgrade_pts ?? 0, row.zenny ?? 0);

    // Spend a point only in points mode
    if (MANUAL_UPGRADES_MODE === 'points') {
      db.prepare(`UPDATE navis SET upgrade_pts = upgrade_pts - 1 WHERE user_id = ?`).run(ix.user.id);
      upgrade_pts = (upgrade_pts ?? 0) - 1;
    }

    return ix.reply(
      `⬆️ ${stat.toUpperCase()} +${STEP} (now **${after}**) — ` +
      (MANUAL_UPGRADES_MODE === 'points'
        ? `Points left: **${Math.max(0, upgrade_pts)}**`
        : `Admin-applied.`)
    );
  }

  if (ix.commandName === 'navi_stats') {
    const user = ix.options.getUser('user') || ix.user;
    const row = ensureNavi(user.id);

    // Pull current temporary Defense if this channel has an active duel
    const f = getFight.get(ix.channel.id);
    let defNow = 0;
    if (f) {
      if (user.id === f.p1_id) defNow = f.p1_def ?? 0;
      else if (user.id === f.p2_id) defNow = f.p2_def ?? 0;
    }

    // PVE def as well if applicable and querying the player
    const pve = getPVE.get(ix.channel.id);
    if (pve && user.id === pve.player_id) defNow = pve.p_def ?? defNow;

    return ix.reply(
      `📊 **${user.username}** — HP ${row.max_hp} | Dodge ${row.dodge}% | Crit ${row.crit}% | ` +
      `Record: **${row.wins ?? 0}-${row.losses ?? 0}** | Points: **${row.upgrade_pts ?? 0}** | Zenny: **${row.zenny ?? 0} ${zennyIcon()}** | Def (temp): **${defNow}**`
    );
  }

  if (ix.commandName === 'virus_busting') {
    // Check for active duel/pve
    if (getFight.get(ix.channel.id) || getPVE.get(ix.channel.id)) {
      return ix.reply({ content: 'There is already a duel/encounter active in this channel.', ephemeral: true });
    }

    ensureNavi(ix.user.id);
    // load viruses
    let viruses = [];
    try {
      viruses = await loadViruses();
    } catch (e) {
      console.error('Virus TSV load failed:', e);
      return ix.reply('Could not load Virus data. Check VIRUS_TSV_URL and sharing settings.');
    }
    if (!viruses.length) {
      return ix.reply('No viruses available. Populate your TSV and try again.');
    }

    // pick one with weights
    const pick = weightedPick(viruses);

    const first = Math.random() < 0.5 ? 'player' : 'virus';

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

      first,
      ensureNavi(ix.user.id).max_hp,
      pick.hp,
      0, 0,
      '{}',
      '[]', '[]',
      0, 0,
      Date.now()
    );

    // Clear any stale AI memory for this channel
    clearAIMemForChannel(ix.channel.id);

    const embed = new EmbedBuilder()
      .setTitle(`👾 Encounter: ${pick.name}`)
      .setDescription(`**HP** ${pick.hp} | **Dodge** ${pick.dodge}% | **Crit** ${pick.crit}%\n${pick.boss ? '⭐ **BOSS** (special once)' : 'Basic Virus'}`)
      .setImage(pick.image_url || null)
      .setFooter({ text: 'Virus Busting — no W/L changes' });

    const firstLine = first === 'player'
      ? `🎲 Random roll: <@${ix.user.id}> goes first.`
      : `🎲 Random roll: **${pick.name}** goes first.`;

    await ix.reply({ content: `🐸 **Virus Busting started!** ${firstLine}`, embeds: [embed] });

    if (first === 'virus') {
      await sleep(1200);
      return virusTakeTurn(ix.channel);
    }
    return;
  }

  if (ix.commandName === 'duel') {
    const target = ix.options.getUser('opponent', true);
    if (getPVE.get(ix.channel.id)) {
      return ix.reply({ content: 'A Virus encounter is active here. Finish it before starting a duel.', ephemeral: true });
    }
    if (target.bot && target.id !== client.user.id) {
      return ix.reply({ content: 'Pick a valid opponent (no external bots).', ephemeral: true });
    }
    if (target.id === ix.user.id) {
      return ix.reply({ content: 'You can’t duel yourself.', ephemeral: true });
    }

    const existing = getFight.get(ix.channel.id);
    if (existing) return ix.reply({ content: 'A duel is already active in this channel.', ephemeral: true });

    // Scrimmage vs ToadMan (this bot)
    if (target.id === client.user.id) {
      const p1 = ensureNavi(ix.user.id);
      const p2 = ensureNavi(client.user.id);

      // random first
      const firstId = Math.random() < 0.5 ? ix.user.id : client.user.id;

      startFight.run(
        ix.channel.id,
        ix.user.id,
        client.user.id,
        firstId,
        p1.max_hp,
        p2.max_hp,
        0, 0,
        '{}', '{}',
        '[]', '[]',
        Date.now()
      );

      // reset bot streak tracker & AI memory for this channel
      botLastUse.delete(ix.channel.id);
      clearAIMemForChannel(ix.channel.id);

      const firstMention = `<@${firstId}>`;
      await ix.reply(
        `🐸 **Scrimmage started!** ${ix.user} vs <@${client.user.id}>\n` +
        `🎲 Random roll: ${firstMention} goes first. *(Scrimmage — no W/L or points)*`
      );

      if (firstId === client.user.id) {
        await sleep(1200);
        return botTakeTurn(ix.channel);
      }
      return;
    }

    // Normal PvP flow (with accept buttons)
    ensureNavi(ix.user.id);
    ensureNavi(target.id);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('accept_duel').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('decline_duel').setLabel('Decline').setStyle(ButtonStyle.Danger)
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
        filter: i => i.user.id === target.id && (i.customId === 'accept_duel' || i.customId === 'decline_duel')
      });

      if (click.customId === 'decline_duel') {
        await click.update({ content: `❌ <@${target.id}> declined the duel.`, components: [] });
        return;
      }

      await click.update({ content: `✅ <@${target.id}> accepted! Setting up the duel...`, components: [] });

      const p1 = ensureNavi(ix.user.id), p2 = ensureNavi(target.id);

      // 🎲 Randomize who goes first
      const firstId = Math.random() < 0.5 ? ix.user.id : target.id;

      startFight.run(
        ix.channel.id,
        ix.user.id,          // p1_id stays requester
        target.id,           // p2_id stays target
        firstId,             // turn = randomized
        p1.max_hp,
        p2.max_hp,
        0, 0,
        '{}', '{}',
        '[]', '[]',
        Date.now()
      );

      // reset trackers for this channel
      botLastUse.delete(ix.channel.id);
      clearAIMemForChannel(ix.channel.id);

      const firstMention = `<@${firstId}>`;
      return ix.followUp(
        `🔔 **Duel started!** ${ix.user} vs ${target}\n` +
        `🎲 Random roll: ${firstMention} goes first. Use your MEE6/NumberMan \`/use\` chips here.`
      );
    } catch {
      await prompt.edit({ content: `⌛ Duel request to <@${target.id}> timed out.`, components: [] });
    }
  }

  if (ix.commandName === 'forfeit') {
    const f = getFight.get(ix.channel.id);
    const pve = getPVE.get(ix.channel.id);
    if (!f && !pve) return ix.reply({ content: 'No active duel/encounter in this channel.', ephemeral: true });

    if (f) {
      const scrim = isScrimmage(f);
      const winnerId = (ix.user.id === f.p1_id) ? f.p2_id : f.p1_id;
      const loserId  = ix.user.id;
      if (!scrim) awardResult(winnerId, loserId); // no penalty in scrimmage
      endFight.run(ix.channel.id);
      botLastUse.delete(ix.channel.id);
      clearAIMemForChannel(ix.channel.id);
      const note = scrim ? ' (scrimmage — no penalty)' : '';
      return ix.reply(`🏳️ <@${loserId}> forfeits.${note} 🏆 <@${winnerId}> wins!`);
    }

    if (pve) {
      endPVE.run(ix.channel.id);
      clearAIMemForChannel(ix.channel.id);
      return ix.reply(`🏳️ You fled from **${pve.virus_name}**. No rewards or penalties.`);
    }
  }

  // read-only duel state
  if (ix.commandName === 'duel_state') {
    const f = getFight.get(ix.channel.id);
    const pve = getPVE.get(ix.channel.id);

    if (!f && !pve) return ix.reply({ content: 'No active duel/encounter in this channel.', ephemeral: true });

    if (f) {
      const p1Spec = parseList(f.p1_special_used);
      const p2Spec = parseList(f.p2_special_used);
      const lines = [
        `🧭 **Duel State**${isScrimmage(f) ? ' *(Scrimmage)*' : ''}`,
        `Turn: <@${f.turn}>`,
        `P1: <@${f.p1_id}> — HP **${f.p1_hp}** | DEF **${f.p1_def ?? 0}** | Specials: ${p1Spec.length ? p1Spec.join(', ') : '—'}`,
        `P2: <@${f.p2_id}> — HP **${f.p2_hp}** | DEF **${f.p2_def ?? 0}** | Specials: ${p2Spec.length ? p2Spec.join(', ') : '—'}`
      ];
      return ix.reply(lines.join('\n'));
    }

    // PVE state
    const p1Spec = parseList(pve.p_special_used);
    const vSpec = parseList(pve.v_special_used);
    const embed = new EmbedBuilder()
      .setTitle(`👾 ${pve.virus_name}`)
      .setImage(pve.virus_image || null)
      .setFooter({ text: 'Virus Busting' });

    const lines = [
      `🧭 **Virus Encounter**${pve.virus_is_boss ? ' *(BOSS)*' : ''}`,
      `Turn: **${pve.turn}**`,
      `Player: <@${pve.player_id}> — HP **${pve.p_hp}** | DEF **${pve.p_def ?? 0}** | Specials: ${p1Spec.length ? p1Spec.join(', ') : '—'}`,
      `Virus: **${pve.virus_name}** — HP **${pve.v_hp}** | DEF **${pve.v_def ?? 0}** | Specials used: ${vSpec.length ? vSpec.join(', ') : '—'}`
    ];
    return ix.reply({ content: lines.join('\n'), embeds: [embed] });
  }

  // leaderboard
  if (ix.commandName === 'navi_leaderboard') {
    let limit = ix.options.getInteger('limit') ?? 10;
    limit = Math.min(25, Math.max(5, limit));

    const rows = db.prepare(`
      SELECT user_id, wins, losses
      FROM navis
      ORDER BY wins DESC, losses ASC
      LIMIT ?
    `).all(limit);

    if (!rows.length) return ix.reply('No players registered yet.');

    const lines = rows.map((r, i) => {
      const games = (r.wins ?? 0) + (r.losses ?? 0);
      const wr = games > 0 ? ((r.wins / games) * 100).toFixed(1) : '0.0';
      return `#${i + 1} — <@${r.user_id}> — **${r.wins}-${r.losses}** (${wr}% WR)`;
    });

    return ix.reply(`🏆 **Leaderboard (Top ${rows.length})**\n` + lines.join('\n'));
  }

  // NEW: Zenny balance
  if (ix.commandName === 'zenny') {
    const user = ix.options.getUser('user') || ix.user;
    const row = ensureNavi(user.id);
    return ix.reply(`💰 **${user.username}** has **${row.zenny ?? 0}** ${zennyIcon()}.`);
  }

  // NEW: Give Zenny
  if (ix.commandName === 'give_zenny') {
    const to = ix.options.getUser('to', true);
    const amt = ix.options.getInteger('amount', true);

    if (to.id === ix.user.id) return ix.reply({ content: 'You cannot send Zenny to yourself.', ephemeral: true });
    if (amt <= 0) return ix.reply({ content: 'Amount must be positive.', ephemeral: true });

    const fromRow = ensureNavi(ix.user.id);
    ensureNavi(to.id);

    if ((fromRow.zenny ?? 0) < amt) {
      return ix.reply({ content: `Not enough Zenny. You have **${fromRow.zenny ?? 0}** ${zennyIcon()}.`, ephemeral: true });
    }

    addZenny.run(-amt, ix.user.id);
    addZenny.run(+amt, to.id);

    return ix.reply(`✅ Transferred **${amt}** ${zennyIcon()} from <@${ix.user.id}> to <@${to.id}>.`);
  }

  // Admin-only stat override (now supports zenny)
  if (ix.commandName === 'stat_override') {
    const hasAdminRole = ix.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
    const hasManageGuild =
      ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      ix.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);

    const isAdmin = hasAdminRole || hasManageGuild;
    if (!isAdmin) {
      return ix.reply({ content: 'Only admins can use this command.', ephemeral: true });
    }

    const user = ix.options.getUser('user', true);
    const stat = ix.options.getString('stat', true);   // hp|dodge|crit|wins|losses|points|zenny
    const mode = ix.options.getString('mode', true);   // set|add
    const value = ix.options.getInteger('value', true);

    const row = ensureNavi(user.id);

    const CAPS = { hp: 500, dodge: 40, crit: 25 };
    const MINS = { hp: 1, dodge: 0, crit: 0, wins: 0, losses: 0, points: 0, zenny: 0 };

    const cur = {
      hp: row.max_hp,
      dodge: row.dodge,
      crit: row.crit,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      points: row.upgrade_pts ?? 0,
      zenny: row.zenny ?? 0
    };

    if (!Object.prototype.hasOwnProperty.call(cur, stat)) {
      return ix.reply({ content: 'Stat must be one of: hp, dodge, crit, wins, losses, points, zenny.', ephemeral: true });
    }
    if (!['set','add'].includes(mode)) {
      return ix.reply({ content: 'Mode must be "set" or "add".', ephemeral: true });
    }

    let next = mode === 'set' ? value : (cur[stat] + value);

    if (stat === 'hp')    next = Math.min(CAPS.hp,    Math.max(MINS.hp,    next));
    if (stat === 'dodge') next = Math.min(CAPS.dodge, Math.max(MINS.dodge, next));
    if (stat === 'crit')  next = Math.min(CAPS.crit,  Math.max(MINS.crit,  next));
    if (stat === 'wins')      next = Math.max(MINS.wins,   next);
    if (stat === 'losses')    next = Math.max(MINS.losses, next);
    if (stat === 'points')    next = Math.max(MINS.points, next);
    if (stat === 'zenny')     next = Math.max(MINS.zenny,  next);

    if (stat === 'hp')        updHP.run(next, user.id);
    else if (stat === 'dodge') updDodge.run(next, user.id);
    else if (stat === 'crit')  updCrit.run(next, user.id);
    else if (stat === 'wins')  updWins.run(next, user.id);
    else if (stat === 'losses') updLosses.run(next, user.id);
    else if (stat === 'points') updPts.run(next, user.id);
    else if (stat === 'zenny')  setZenny.run(next, user.id);

    return ix.reply(`🛠️ Overrode **${stat.toUpperCase()}** for <@${user.id}>: ${cur[stat]} → **${next}** (mode: ${mode}).`);
  }
});

// ---------- Message listener (trigger from NumberMan EMBED) ----------
client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;

  // Only react to our usage bots
  const isUsageBot =
    USAGE_BOT_IDS.includes(msg.author?.id) ||
    (msg.applicationId && USAGE_BOT_IDS.includes(msg.applicationId)) ||
    (msg.webhookId && USAGE_BOT_IDS.includes(msg.webhookId));

  if (!isUsageBot) return;

  // ---- DIAGNOSTIC LOG (trim noisy fields) ----
  console.log('[USAGE MSG]', {
    authorId: msg.author?.id,
    hasEmbeds: !!msg.embeds?.length,
    content: msg.content
  });
  if (msg.embeds?.length) {
    console.log('[USAGE EMBEDS]', msg.embeds.map(e => ({
      title: e.title, footer: e.footer?.text
    })));
  }

  // --- Upgrades: allow detecting anywhere (content or embed text) ---
  const embedBits = (msg.embeds || []).flatMap(e => [
    e.title || '',
    e.description || '',
    ...(e.fields || []).flatMap(f => [f.name || '', f.value || '']),
    e.footer?.text || ''
  ]);
  const allTextLower = [msg.content || '', ...embedBits].join(' ').toLowerCase();
  for (const key of Object.keys(UPGRADES)) {
    if (allTextLower.includes(key.toLowerCase())) {
      const actorId =
        (msg.content?.match(/<@!?(\d+)>/)?.[1]) ||
        (embedBits.join(' ').match(/<@!?(\d+)>/)?.[1]) ||
        msg.interaction?.user?.id;
      if (!actorId) {
        console.log('[UPGRADE] Found upgrade word but no actor mention/user.', { mid: msg.id });
        return; // exit handler
      }
      const row = ensureNavi(actorId);
      let { max_hp, dodge, crit, wins, losses } = row;
      const up = UPGRADES[key];
      if (up.stat === 'hp')    max_hp = Math.min(up.max, max_hp + up.step);
      if (up.stat === 'dodge') dodge  = Math.min(up.max, dodge  + up.step);
      if (up.stat === 'crit')  crit   = Math.min(up.max, crit   + up.step);
      upsertNavi.run(actorId, max_hp, dodge, crit, wins ?? 0, losses ?? 0, row.upgrade_pts ?? 0, row.zenny ?? 0);
      await msg.channel.send(`🧩 <@${actorId}> used **${key.toUpperCase()}** → HP ${max_hp} | Dodge ${dodge}% | Crit ${crit}%`);
      return;
    }
  }

  // --- Focus on NumberMan EMBED with chip title ---
  if (msg.author?.id !== NUMBERMAN_ID || !msg.embeds?.length) return;

  // Find a chip name from the embed TITLE
  let chipKey = null;
  const titles = msg.embeds.map(e => e.title).filter(Boolean);
  if (titles.length) {
    const keys = Object.keys(CHIPS);
    const normKeys = keys.map(k => normalize(k));
    outer: for (const t of titles) {
      const tn = normalize(t);
      for (let i = 0; i < keys.length; i++) {
        const kn = normKeys[i];
        if (tn === kn || tn.startsWith(kn)) {
          chipKey = keys[i];
          break outer;
        }
      }
    }
  }
  if (!chipKey) return; // not a chip embed

  // Resolve actor:
  const embedJoined = embedBits.join(' ');
  let actorId =
    (embedJoined.match(/<@!?(\d+)>/)?.[1]) ||
    (msg.content?.match(/<@!?(\d+)>/)?.[1]) ||
    msg.interaction?.user?.id;

  if (!actorId) {
    try {
      const recent = await msg.channel.messages.fetch({ limit: 10 });
      const prior = [...recent.values()]
        .filter(m => m.id !== msg.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp) // newest first
        .find(m =>
          m.author?.id === NUMBERMAN_ID &&
          typeof m.content === 'string' &&
          /\bused\b/i.test(m.content) &&
          (msg.createdTimestamp - m.createdTimestamp) < 10_000 // within 10s window
        );
      actorId = prior?.content?.match(/<@!?(\d+)>/)?.[1] || null;
    } catch (e) {
      console.warn('Failed to fetch recent messages to resolve actor:', e);
    }
  }
  if (!actorId) {
    console.log('[USAGE MSG] Could not resolve actor for embed-only chip.');
    return;
  }

  // ---- If a PvP duel is active in this channel ----
  const f = getFight.get(msg.channel.id);
  const pve = getPVE.get(msg.channel.id);

  if (!f && !pve) return;

  // Debounce near-duplicate actions (channel + actor + chip within 2s)
  if (shouldDebounce(msg.channel.id, actorId, chipKey)) {
    console.log('[DEBOUNCE] Skipping duplicate action', { channel: msg.channel.id, actorId, chipKey });
    return;
  }

  // ===== PvP branch =====
  if (f) {
    if (actorId !== f.turn) {
      return msg.channel.send(`⏳ Not your turn, <@${actorId}>.`);
    }

    const attackerIsP1 = (actorId === f.p1_id);
    let p1hp = f.p1_hp, p2hp = f.p2_hp;
    let p1def = f.p1_def ?? 0, p2def = f.p2_def ?? 0;
    let p1Spec = parseList(f.p1_special_used), p2Spec = parseList(f.p2_special_used);
    let p1Counts = parseMap(f.p1_counts_json), p2Counts = parseMap(f.p2_counts_json);
    let last1 = f.last_hit_p1, last2 = f.last_hit_p2;
    const attackerIdReal = actorId;
    const defenderId = attackerIsP1 ? f.p2_id : f.p1_id;

    const chip = CHIPS[chipKey];
    if (!chip) return;

    // SPECIAL LIMITER
    let specialJustUsed = false;
    if (chip.special) {
      const usedArr = attackerIsP1 ? p1Spec : p2Spec;
      if (usedArr.includes(chipKey)) {
        return msg.channel.send(`⛔ <@${attackerIdReal}> you’ve already used **${chipKey}** this duel.`);
      }
      usedArr.push(chipKey);
      specialJustUsed = true;
    }

    // PER-CHIP LIMIT (4/duel)
    const myCounts = attackerIsP1 ? p1Counts : p2Counts;
    const alreadyUsed = myCounts[chipKey] || 0;
    if (alreadyUsed >= MAX_PER_CHIP) {
      return msg.channel.send(`⛔ **${chipKey}** is exhausted (**${MAX_PER_CHIP}/${MAX_PER_CHIP}**) this duel.`);
    }
    const usedNow = alreadyUsed + 1;
    myCounts[chipKey] = usedNow;

    // Barrier
    if (chip.kind === 'barrier') {
      const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;

      if (attackerIsP1) {
        if (last1 > 0) { p1hp = Math.min(p1hp + last1, ensureNavi(f.p1_id).max_hp); last1 = 0; }
      } else {
        if (last2 > 0) { p2hp = Math.min(p2hp + last2, ensureNavi(f.p2_id).max_hp); last2 = 0; }
      }

      if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

      updFight.run(
        p1hp, p2hp,
        p1def, p2def,
        JSON.stringify(p1Counts), JSON.stringify(p2Counts),
        JSON.stringify(p1Spec), JSON.stringify(p2Spec),
        nextTurn, last1, last2, msg.channel.id
      );
      await msg.channel.send(
        `🛡️ <@${attackerIdReal}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''}! ` +
        `Restores the last damage.  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`
      );
      return maybeBotTurn(msg.channel, nextTurn);
    }

    // Defense
    if (chip.kind === 'defense') {
      const val = Number.isFinite(chip.def) ? chip.def : 0;
      if (attackerIsP1) p1def = Math.max(0, p1def + val);
      else              p2def = Math.max(0, p2def + val);

      const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
      updFight.run(
        p1hp, p2hp,
        p1def, p2def,
        JSON.stringify(p1Counts), JSON.stringify(p2Counts),
        JSON.stringify(p1Spec), JSON.stringify(p2Spec),
        nextTurn, last1, last2, msg.channel.id
      );
      await msg.channel.send(
        `🧱 <@${attackerIdReal}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
        `and raises Defense by **${val}** until their next turn. ➡️ <@${nextTurn}>`
      );
      return maybeBotTurn(msg.channel, nextTurn);
    }

    // Recovery
    if (chip.kind === 'recovery') {
      const healVal = Number.isFinite(chip.heal) ? chip.heal : (Number.isFinite(chip.rec) ? chip.rec : 0);
      const stats = ensureNavi(attackerIdReal);
      const maxhp = stats.max_hp;

      let healed = 0;
      if (attackerIsP1) {
        const before = p1hp;
        p1hp = Math.min(maxhp, p1hp + healVal);
        healed = p1hp - before;
      } else {
        const before = p2hp;
        p2hp = Math.min(maxhp, p2hp + healVal);
        healed = p2hp - before;
      }

      const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
      if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

      updFight.run(
        p1hp, p2hp,
        p1def, p2def,
        JSON.stringify(p1Counts), JSON.stringify(p2Counts),
        JSON.stringify(p1Spec), JSON.stringify(p2Spec),
        nextTurn, last1, last2, msg.channel.id
      );

      await msg.channel.send(
        `💚 <@${attackerIdReal}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
        `and recovers **${healed}** HP.  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`
      );
      return maybeBotTurn(msg.channel, nextTurn);
    }

    // Attack
    const defStats = ensureNavi(defenderId);
    const attStats = ensureNavi(attackerIdReal);

    const dodged = (Math.random() * 100) < defStats.dodge;
    if (dodged) {
      const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
      if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;
      updFight.run(
        p1hp, p2hp,
        p1def, p2def,
        JSON.stringify(p1Counts), JSON.stringify(p2Counts),
        JSON.stringify(p1Spec), JSON.stringify(p2Spec),
        nextTurn, last1, last2, msg.channel.id
      );
      await msg.channel.send(`💨 <@${defenderId}> dodged **${chipKey}** (${usedNow}/${MAX_PER_CHIP})!  ${hpLine(f, p1hp, p2hp)}  ➡️ <@${nextTurn}>`);
      return maybeBotTurn(msg.channel, nextTurn);
    }

    const base = Number.isFinite(chip.dmg) ? chip.dmg : 0;
    const isCrit = (Math.random() * 100) < attStats.crit;
    const preDef = isCrit ? Math.floor((base * 3) / 2) : base;

    const defenderDef = attackerIsP1 ? p2def : p1def;
    const dmg = Math.max(0, preDef - defenderDef);
    const absorbed = preDef - dmg;

    if (attackerIsP1) { p2hp = Math.max(0, p2hp - dmg); last2 = dmg; }
    else { p1hp = Math.max(0, p1hp - dmg); last1 = dmg; }

    const nextTurn = attackerIsP1 ? f.p2_id : f.p1_id;
    if (nextTurn === f.p1_id) p1def = 0; else p2def = 0;

    let line =
      `💥 <@${attackerIdReal}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${isCrit ? ' _(CRIT!)_' : ''} ` +
      `for **${dmg}**.`;
    if (absorbed > 0) line += ` 🛡️ Defense absorbed **${absorbed}**.`;
    line += `  ${hpLine(f, p1hp, p2hp)}`;

    await msg.channel.send(line);

    if (p1hp === 0 || p2hp === 0) {
      const winnerId = p1hp === 0 ? f.p2_id : f.p1_id;
      const loserId  = p1hp === 0 ? f.p1_id : f.p2_id;

      const scrim = isScrimmage(f);
      if (!scrim) {
        awardResult(winnerId, loserId);
        endFight.run(msg.channel.id);
        botLastUse.delete(msg.channel.id);
        clearAIMemForChannel(msg.channel.id);
        const wRow = getNavi.get(winnerId);
        return msg.channel.send(`🏆 **<@${winnerId}> wins!** (W-L: ${wRow?.wins ?? '—'}-${wRow?.losses ?? '—'})`);
      } else {
        endFight.run(msg.channel.id);
        botLastUse.delete(msg.channel.id);
        clearAIMemForChannel(msg.channel.id);
        return msg.channel.send(`🏆 **<@${winnerId}> wins!** _(scrimmage — no W/L or points)_`);
      }
    }

    updFight.run(
      p1hp, p2hp,
      p1def, p2def,
      JSON.stringify(p1Counts), JSON.stringify(p2Counts),
      JSON.stringify(p1Spec), JSON.stringify(p2Spec),
      nextTurn, last1, last2, msg.channel.id
    );
    await msg.channel.send(`➡️ <@${nextTurn}>, your turn.`);
    return maybeBotTurn(msg.channel, nextTurn);
  }

  // ===== PVE branch =====
  if (pve) {
    if (actorId !== pve.player_id) {
      return msg.channel.send(`⏳ Not your turn, <@${actorId}>.`);
    }
    if (pve.turn !== 'player') {
      return msg.channel.send(`⏳ Not your turn, <@${actorId}>.`);
    }

    let php = pve.p_hp, vhp = pve.v_hp;
    let pdef = pve.p_def || 0, vdef = pve.v_def || 0;
    let pCounts = parseMap(pve.p_counts_json);
    let pSpec   = parseList(pve.p_special_used);
    let vSpec   = parseList(pve.v_special_used);
    let lastP   = pve.last_hit_p, lastV = pve.last_hit_v;

    const chip = CHIPS[chipKey];
    if (!chip) return;

    // Player specials once
    let specialJustUsed = false;
    if (chip.special) {
      if (pSpec.includes(chipKey)) {
        return msg.channel.send(`⛔ <@${actorId}> you’ve already used **${chipKey}** this encounter.`);
      }
      pSpec.push(chipKey);
      specialJustUsed = true;
    }

    // Player per-chip limit 4/duel
    const alreadyUsed = pCounts[chipKey] || 0;
    if (alreadyUsed >= MAX_PER_CHIP) {
      return msg.channel.send(`⛔ **${chipKey}** is exhausted (**${MAX_PER_CHIP}/${MAX_PER_CHIP}**) this encounter.`);
    }
    const usedNow = alreadyUsed + 1;
    pCounts[chipKey] = usedNow;

    // Barrier
    if (chip.kind === 'barrier') {
      const next = 'virus';
      if (lastP > 0) { php = Math.min(php + lastP, ensureNavi(actorId).max_hp); lastP = 0; }
      if (next === 'player') pdef = 0; else vdef = 0;
      updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, msg.channel.id);
      await msg.channel.send(
        `🛡️ <@${actorId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''}! ` +
        `Restores the last damage.  ${hpLinePVE(pve, php, vhp)}  ➡️ **${pve.virus_name}**`
      );
      await sleep(1200);
      return virusTakeTurn(msg.channel);
    }

    // Defense
    if (chip.kind === 'defense') {
      const val = Number.isFinite(chip.def) ? chip.def : 0;
      pdef = Math.max(0, pdef + val);
      const next = 'virus';
      updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, msg.channel.id);
      await msg.channel.send(
        `🧱 <@${actorId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
        `and raises Defense by **${val}** until your next turn. ➡️ **${pve.virus_name}**`
      );
      await sleep(1200);
      return virusTakeTurn(msg.channel);
    }

    // Recovery
    if (chip.kind === 'recovery') {
      const healVal = Number.isFinite(chip.heal) ? chip.heal : (Number.isFinite(chip.rec) ? chip.rec : 0);
      const stats = ensureNavi(actorId);
      const maxhp = stats.max_hp;
      const before = php;
      php = Math.min(maxhp, php + healVal);
      const healed = php - before;

      const next = 'virus';
      if (next === 'player') pdef = 0; else vdef = 0;
      updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, msg.channel.id);

      await msg.channel.send(
        `💚 <@${actorId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${specialJustUsed ? ' _(special used)_' : ''} ` +
        `and recovers **${healed}** HP.  ${hpLinePVE(pve, php, vhp)}  ➡️ **${pve.virus_name}**`
      );
      await sleep(1200);
      return virusTakeTurn(msg.channel);
    }

    // Attack
    const dodged = (Math.random() * 100) < (pve.virus_dodge || 0);
    if (dodged) {
      const next = 'virus';
      if (next === 'player') pdef = 0; else vdef = 0;
      updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, msg.channel.id);
      await msg.channel.send(`💨 **${pve.virus_name}** dodged **${chipKey}** (${usedNow}/${MAX_PER_CHIP})!  ${hpLinePVE(pve, php, vhp)}  ➡️ **${pve.virus_name}**`);
      await sleep(1200);
      return virusTakeTurn(msg.channel);
    }

    const attStats = ensureNavi(actorId);
    const base = Number.isFinite(chip.dmg) ? chip.dmg : 0;
    const isCrit = (Math.random() * 100) < attStats.crit;
    const preDef = isCrit ? Math.floor((base * 3) / 2) : base;

    const eff = Math.max(0, preDef - vdef);
    const absorbed = preDef - eff;

    vhp = Math.max(0, vhp - eff);
    lastV = eff;

    const next = vhp === 0 ? 'done' : 'virus';
    if (next === 'player') pdef = 0; else vdef = 0;

    let line =
      `💥 <@${actorId}> uses **${chipKey.toUpperCase()}** (${usedNow}/${MAX_PER_CHIP})${isCrit ? ' _(CRIT!)_' : ''} ` +
      `for **${eff}**.`;
    if (absorbed > 0) line += ` 🛡️ Defense absorbed **${absorbed}**.`;
    line += `  ${hpLinePVE(pve, php, vhp)}`;
    await msg.channel.send(line);

    if (vhp === 0 || php === 0) {
      const playerWon = vhp === 0;
      const z = playerWon ? Math.max(pve.virus_zmin || 0, Math.min(pve.virus_zmax || 0, Math.floor(Math.random() * ((pve.virus_zmax||0)-(pve.virus_zmin||0)+1)) + (pve.virus_zmin||0))) : 0;
      endPVE.run(msg.channel.id);
      clearAIMemForChannel(msg.channel.id);
      if (playerWon && z > 0) addZenny.run(z, actorId);
      if (playerWon) {
        return msg.channel.send(`🏆 **<@${actorId}> wins!** You earned **${z}** ${zennyIcon()}.`);
      } else {
        return msg.channel.send(`💀 **${pve.virus_name}** wins! Better luck next time.`);
      }
    }

    updPVE.run(php, vhp, pdef, vdef, JSON.stringify(pCounts), JSON.stringify(pSpec), JSON.stringify(vSpec), next, lastP, lastV, msg.channel.id);
    await sleep(1200);
    return virusTakeTurn(msg.channel);
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
