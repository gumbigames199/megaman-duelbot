import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
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

// ---------- DB ----------
const db = new Database('./data/data.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS navis (
  user_id TEXT PRIMARY KEY,
  max_hp INTEGER NOT NULL DEFAULT 250,
  dodge  INTEGER NOT NULL DEFAULT 20,
  crit   INTEGER NOT NULL DEFAULT 5,
  wins   INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS duel_state (
  channel_id TEXT PRIMARY KEY,
  p1_id TEXT NOT NULL,
  p2_id TEXT NOT NULL,
  turn TEXT NOT NULL,
  p1_hp INTEGER NOT NULL,
  p2_hp INTEGER NOT NULL,
  last_hit_p1 INTEGER NOT NULL DEFAULT 0,
  last_hit_p2 INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
);
`);
try { db.exec(`ALTER TABLE navis ADD COLUMN wins   INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE navis ADD COLUMN losses INTEGER NOT NULL DEFAULT 0;`); } catch {}

const getNavi = db.prepare(`SELECT * FROM navis WHERE user_id=?`);
const upsertNavi = db.prepare(`
INSERT INTO navis (user_id,max_hp,dodge,crit,wins,losses) VALUES (?,?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET
  max_hp=excluded.max_hp,
  dodge=excluded.dodge,
  crit=excluded.crit
`);
function ensureNavi(uid) {
  const row = getNavi.get(uid);
  if (row) return row;
  upsertNavi.run(uid, 250, 20, 5, 0, 0);
  return { user_id: uid, max_hp: 250, dodge: 20, crit: 5, wins: 0, losses: 0 };
}

const setRecord = db.prepare(`UPDATE navis SET wins = wins + ?, losses = losses + ? WHERE user_id = ?`);
function awardResult(winnerId, loserId) {
  setRecord.run(1, 0, winnerId);
  setRecord.run(0, 1, loserId);
}

const getFight   = db.prepare(`SELECT * FROM duel_state WHERE channel_id=?`);
const startFight = db.prepare(`INSERT INTO duel_state (channel_id,p1_id,p2_id,turn,p1_hp,p2_hp,started_at) VALUES (?,?,?,?,?,?,?)`);
const updFight   = db.prepare(`UPDATE duel_state SET p1_hp=?,p2_hp=?,turn=?,last_hit_p1=?,last_hit_p2=? WHERE channel_id=?`);
const endFight   = db.prepare(`DELETE FROM duel_state WHERE channel_id=?`);

// Helpers
function hpLine(fight, p1hp, p2hp) {
  return `HP — <@${fight.p1_id}>: ${p1hp} | <@${fight.p2_id}>: ${p2hp}`;
}

// Sort longer chip names first to avoid "sword" grabbing "widesword"
const CHIP_KEYS_LOWER = Object.keys(CHIPS)
  .map(k => k.toLowerCase())
  .sort((a, b) => b.length - a.length);

const normalize = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '');

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

// ---------- Slash commands ----------
client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;

  if (ix.commandName === 'navi_register') {
    const row = ensureNavi(ix.user.id);
    return ix.reply({ content: `✅ Registered with **${row.max_hp} HP**, **${row.dodge}%** dodge, **${row.crit}%** crit.`, ephemeral: true });
  }

  if (ix.commandName === 'navi_upgrade') {
    const stat = ix.options.getString('stat', true); // hp|dodge|crit
    const amount = ix.options.getInteger('amount', true);
    const row = ensureNavi(ix.user.id);
    let { max_hp, dodge, crit, wins, losses } = row;
    if (stat === 'hp')    max_hp = Math.min(500, max_hp + amount);
    if (stat === 'dodge') dodge  = Math.min(40,  dodge  + amount);
    if (stat === 'crit')  crit   = Math.min(25,  crit   + amount);
    upsertNavi.run(ix.user.id, max_hp, dodge, crit, wins ?? 0, losses ?? 0);
    return ix.reply(`⬆️ ${stat.toUpperCase()} upgraded: HP ${max_hp} | Dodge ${dodge}% | Crit ${crit}%`);
  }

  if (ix.commandName === 'navi_stats') {
    const user = ix.options.getUser('user') || ix.user;
    const row = ensureNavi(user.id);
    return ix.reply(
      `📊 **${user.username}** — HP ${row.max_hp} | Dodge ${row.dodge}% | Crit ${row.crit}% | Record: **${row.wins ?? 0}-${row.losses ?? 0}**`
    );
  }

  if (ix.commandName === 'duel') {
    const target = ix.options.getUser('opponent', true);
    if (target.bot || target.id === ix.user.id)
      return ix.reply({ content: 'Pick a valid opponent.', ephemeral: true });

    const existing = getFight.get(ix.channel.id);
    if (existing) return ix.reply({ content: 'A duel is already active in this channel.', ephemeral: true });

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
      startFight.run(ix.channel.id, ix.user.id, target.id, ix.user.id, p1.max_hp, p2.max_hp, Date.now());
      return ix.followUp(`🔔 **Duel started!** ${ix.user} vs ${target}\n${ix.user} goes first. Use your MEE6/NumberMan \`/use\` chips here.`);
    } catch {
      await prompt.edit({ content: `⌛ Duel request to <@${target.id}> timed out.`, components: [] });
    }
  }

  if (ix.commandName === 'forfeit') {
    const fight = getFight.get(ix.channel.id);
    if (!fight) return ix.reply({ content: 'No active duel in this channel.', ephemeral: true });
    const winnerId = (ix.user.id === fight.p1_id) ? fight.p2_id : fight.p1_id;
    const loserId  = ix.user.id;
    awardResult(winnerId, loserId);
    endFight.run(ix.channel.id);
    return ix.reply(`🏳️ <@${loserId}> forfeits. 🏆 <@${winnerId}> wins!`);
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
      if (!actorId) break;
      const row = ensureNavi(actorId);
      let { max_hp, dodge, crit, wins, losses } = row;
      const up = UPGRADES[key];
      if (up.stat === 'hp')    max_hp = Math.min(up.max, max_hp + up.step);
      if (up.stat === 'dodge') dodge  = Math.min(up.max, dodge  + up.step);
      if (up.stat === 'crit')  crit   = Math.min(up.max, crit   + up.step);
      upsertNavi.run(actorId, max_hp, dodge, crit, wins ?? 0, losses ?? 0);
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
  // 1) Try any mention hidden in embed text/description/fields (some bots include it)
  const embedJoined = embedBits.join(' ');
  let actorId =
    (embedJoined.match(/<@!?(\d+)>/)?.[1]) ||
    (msg.content?.match(/<@!?(\d+)>/)?.[1]) ||
    msg.interaction?.user?.id;

  // 2) If not found, look back a few recent messages to find the preceding "used" line
  if (!actorId) {
    try {
      const recent = await msg.channel.messages.fetch({ limit: 6 });
      // messages are a Collection sorted by timestamp desc; find the previous NumberMan message with " used "
      const prior = [...recent.values()]
        .filter(m => m.id !== msg.id)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // oldest -> newest
        .reverse() // newest -> older
        .find(m =>
          m.author?.id === NUMBERMAN_ID &&
          typeof m.content === 'string' &&
          m.content.toLowerCase().includes(' used ') &&
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

  // ---- Combat only if a duel is active in this channel ----
  const fight = getFight.get(msg.channel.id);
  if (!fight) return;

  // Debounce near-duplicate actions (channel + actor + chip within 2s)
  if (shouldDebounce(msg.channel.id, actorId, chipKey)) {
    console.log('[DEBOUNCE] Skipping duplicate action', { channel: msg.channel.id, actorId, chipKey });
    return;
  }

  if (actorId !== fight.turn) {
    return msg.channel.send(`⏳ Not your turn, <@${actorId}>.`);
  }

  const attackerIsP1 = (actorId === fight.p1_id);
  let p1hp = fight.p1_hp, p2hp = fight.p2_hp;
  let last1 = fight.last_hit_p1, last2 = fight.last_hit_p2;
  const attackerId = actorId;
  const defenderId = attackerIsP1 ? fight.p2_id : fight.p1_id;

  // Barrier: undo opponent’s last hit
  if (CHIPS[chipKey].kind === 'barrier') {
    if (attackerIsP1) {
      if (last1 > 0) { p1hp = Math.min(p1hp + last1, ensureNavi(fight.p1_id).max_hp); last1 = 0; }
    } else {
      if (last2 > 0) { p2hp = Math.min(p2hp + last2, ensureNavi(fight.p2_id).max_hp); last2 = 0; }
    }
    const nextTurn = attackerIsP1 ? fight.p2_id : fight.p1_id;
    updFight.run(p1hp, p2hp, nextTurn, last1, last2, msg.channel.id);
    return msg.channel.send(`🛡️ <@${attackerId}> **Barrier!** Restores the last damage.  ${hpLine(fight, p1hp, p2hp)}  ➡️ <@${nextTurn}>`);
  }

  // Attack: dodge + crit
  const defStats = ensureNavi(defenderId);
  const attStats = ensureNavi(attackerId);

  const dodged = (Math.random() * 100) < defStats.dodge;
  if (dodged) {
    const nextTurn = attackerIsP1 ? fight.p2_id : fight.p1_id;
    updFight.run(p1hp, p2hp, nextTurn, last1, last2, msg.channel.id);
    return msg.channel.send(`💨 <@${defenderId}> dodged the attack!  ${hpLine(fight, p1hp, p2hp)}  ➡️ <@${nextTurn}>`);
  }

  const base = CHIPS[chipKey].dmg;
  const isCrit = (Math.random() * 100) < attStats.crit;
  const dmg = isCrit ? Math.floor((base * 3) / 2) : base;

  if (attackerIsP1) { p2hp = Math.max(0, p2hp - dmg); last2 = dmg; }
  else { p1hp = Math.max(0, p1hp - dmg); last1 = dmg; }

  const nextTurn = attackerIsP1 ? fight.p2_id : fight.p1_id;

  await msg.channel.send(
    `💥 <@${attackerId}> uses **${chipKey.toUpperCase()}** for **${dmg}**${isCrit ? ' _(CRIT!)_' : ''}.  ${hpLine(fight, p1hp, p2hp)}`
  );

  if (p1hp === 0 || p2hp === 0) {
    const winnerId = p1hp === 0 ? fight.p2_id : fight.p1_id;
    const loserId  = p1hp === 0 ? fight.p1_id : fight.p2_id;
    awardResult(winnerId, loserId);
    endFight.run(msg.channel.id);
    const wRow = getNavi.get(winnerId);
    return msg.channel.send(`🏆 **<@${winnerId}> wins!** (W-L: ${wRow?.wins ?? '—'}-${wRow?.losses ?? '—'})`);
  }

  updFight.run(p1hp, p2hp, nextTurn, last1, last2, msg.channel.id);
  msg.channel.send(`➡️ <@${nextTurn}>, your turn.`);
});

// ---------- Boot ----------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});
client.login(process.env.DISCORD_TOKEN);
