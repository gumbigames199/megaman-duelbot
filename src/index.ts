// src/index.ts
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, Interaction
} from 'discord.js';

import loadTSVBundle from './lib/tsv';
import { invalidateBundleCache, getBundle } from './lib/data';
import { validateLetterRule } from './lib/rules';
import { battleEmbed } from './lib/render';
import { load as loadBattle, resolveTurn as resolveBattleTurn, tryRun, end, save } from './lib/battle';
import { rollRewards, rollBossRewards } from './lib/rewards';
import { progressDefeat } from './lib/missions';
import { diffNewlyUnlockedRegions } from './lib/unlock';
import { getRegion, getPlayer } from './lib/db';
import { wantDmg } from './lib/settings-util';

import * as Start from './commands/start';
import * as Profile from './commands/profile';
import * as Folder from './commands/folder';
import * as ShopCmd from './commands/shop'; // (optional legacy slash, kept if you still want it)
import * as Mission from './commands/mission';
import * as Leaderboard from './commands/leaderboard';
import * as Chip from './commands/chip';
import * as VirusDex from './commands/virusdex';
import * as JackIn from './commands/jack_in';

const TOKEN    = process.env.DISCORD_TOKEN!;
const APP_ID   = process.env.CLIENT_ID || process.env.APPLICATION_ID!;
const GUILD_ID = process.env.GUILD_ID!;
if (!TOKEN)   throw new Error('Missing DISCORD_TOKEN');
if (!APP_ID)  throw new Error('Missing CLIENT_ID/APPLICATION_ID');
if (!GUILD_ID) console.warn('⚠️ Missing GUILD_ID (commands will not register guild-scoped)');

const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

// ---- Slash commands (guild-scoped) ----
// Removed /health and all /settings subcommands per request.
const commands = [
  new SlashCommandBuilder()
    .setName('reload_data')
    .setDescription('Reload TSV bundle from /data (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  Start.data, Profile.data, Folder.data,
  ShopCmd.data,          // keep if you still want /shop; otherwise remove this line
  Mission.data, Leaderboard.data,
  Chip.data, VirusDex.data, JackIn.data,
].map((c: any) => c.toJSON());

async function registerCommands() {
  if (!GUILD_ID) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  console.log(`✅ Registered ${commands.length} guild commands to ${GUILD_ID}`);
}

function isAdmin(ix: Interaction): boolean {
  const anyIx = ix as any;
  return Boolean(
    anyIx.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    anyIx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
}

/* ---------- small helpers ---------- */
function buildPickRows(battleId: string, hand: string[]) {
  const { chips } = getBundle();

  const makeSelect = (slot: 1 | 2 | 3) => {
    const sel = new (require('discord.js').StringSelectMenuBuilder)()
      .setCustomId(`pick${slot}:${battleId}`)
      .setPlaceholder(`Pick ${slot}`)
      .setMinValues(0)
      .setMaxValues(1);
    const opts = (hand || []).map((cid) => {
      const c: any = chips[cid] || {};
      const name = c.name || cid;
      const code = c.code || c.letters || '';
      const pwr  = c.power || c.power_total || '';
      const hits = c.hits || 1;
      const label = `${name}${code ? ` [${code}]` : ''}${pwr ? ` ${pwr}×${hits}` : ''}`;
      return { label: label.slice(0, 100), value: cid };
    });
    if (opts.length) sel.addOptions(opts);
    return sel;
  };

  const row1 = new (require('discord.js').ActionRowBuilder)().addComponents(makeSelect(1));
  const row2 = new (require('discord.js').ActionRowBuilder)().addComponents(makeSelect(2));
  const row3 = new (require('discord.js').ActionRowBuilder)().addComponents(makeSelect(3));

  const lockBtn = new (require('discord.js').ButtonBuilder)().setCustomId(`lock:${battleId}`).setStyle(3).setLabel('Lock');
  const runBtn  = new (require('discord.js').ButtonBuilder)().setCustomId(`run:${battleId}`).setStyle(4).setLabel('Run');
  const row4 = new (require('discord.js').ActionRowBuilder)().addComponents(lockBtn, runBtn);

  return [row1, row2, row3, row4];
}

/* ---------- router ---------- */
client.on('interactionCreate', async (ix) => {
  try {
    // Slash
    if (ix.isChatInputCommand()) {
      if (ix.commandName === 'reload_data') {
        if (!isAdmin(ix)) { await ix.reply({ content: '❌ Admin only.', ephemeral: true }); return; }
        await ix.deferReply({ ephemeral: true });
        const { report } = loadTSVBundle(process.env.DATA_DIR || './data');
        const counts = Object.entries(report.counts).map(([k, v]) => `${k}:${v}`).join(' • ') || 'none';
        const warnings = report.warnings.length ? `\n⚠️ Warnings:\n- ${report.warnings.join('\n- ')}` : '';
        const errors = report.errors.length ? `\n❌ Errors:\n- ${report.errors.join('\n- ')}` : '';
        invalidateBundleCache();
        await ix.editReply(`📦 TSV load: **${report.ok ? 'OK' : 'ISSUES'}**\nCounts: ${counts}${warnings}${errors}`);
        return;
      }

      if (ix.commandName === 'start')        { await Start.execute(ix); return; }
      if (ix.commandName === 'profile')      { await Profile.execute(ix); return; }
      if (ix.commandName === 'folder')       { await Folder.execute(ix); return; }
      if (ix.commandName === 'shop')         { await ShopCmd.execute(ix); return; } // optional
      if (ix.commandName === 'mission')      { await Mission.execute(ix); return; }
      if (ix.commandName === 'leaderboard')  { await Leaderboard.execute(ix); return; }
      if (ix.commandName === 'chip')         { await Chip.execute(ix); return; }
      if (ix.commandName === 'virusdex')     { await VirusDex.execute(ix); return; }
      if (ix.commandName === 'jack_in')      { await JackIn.execute(ix); return; }
      return;
    }

    // Jack-In routing
    if (ix.isStringSelectMenu()) {
      if (ix.customId === 'jackin:selectRegion') { await JackIn.onSelectRegion(ix); return; }
      if (ix.customId === 'jackin:selectZone')   { await JackIn.onSelectZone(ix);   return; }
      if (ix.customId === 'jackin:shopSelect')   { await JackIn.onShopSelect(ix);   return; }
    }
    if (ix.isButton()) {
      if (ix.customId === 'jackin:openTravel')   { await JackIn.onOpenTravel(ix);   return; }
      if (ix.customId === 'jackin:encounter')    { await JackIn.onEncounter(ix);    return; }
      if (ix.customId === 'jackin:openShop')     { await JackIn.onOpenShop(ix);     return; }
      if (ix.customId === 'jackin:shopExit')     { await JackIn.onShopExit(ix);     return; }
      if (ix.customId.startsWith('jackin:shopBuy:')) {
        const chipId = ix.customId.split(':')[2];
        await JackIn.onShopBuy(ix, chipId);
        return;
      }
    }

    // Battle pick menus (silent & persisted)
    if (ix.isStringSelectMenu()) {
      const [kind, battleId] = ix.customId.split(':');
      if (!/^pick[123]$/.test(kind)) return;

      const s = loadBattle(battleId);
      if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }

      const slotIdx = ({ pick1: 0, pick2: 1, pick3: 2 } as any)[kind] ?? 0;
      const chosenId = ix.values[0] || '';

      while (s.locked.length < 3) s.locked.push('');

      if (chosenId && s.locked.includes(chosenId)) {
        await ix.reply({ ephemeral: true, content: '⚠️ Already selected that chip in another slot.' });
        return;
      }

      const prev = s.locked[slotIdx];
      s.locked[slotIdx] = chosenId;

      const chosen = s.locked.filter(Boolean);
      if (chosen.length) {
        const chipRows = chosen.map(id => ({ id, letters: getBundle().chips[id]?.letters || '' }));
        if (!validateLetterRule(chipRows)) {
          s.locked[slotIdx] = prev;
          await ix.reply({ ephemeral: true, content: '❌ Invalid combo. Chips must share a letter, exact name, or include *.' });
          return;
        }
      }

      save(s);
      await ix.deferUpdate();
      return;
    }

    // Battle buttons
    if (ix.isButton()) {
      const [kind, battleId] = ix.customId.split(':');
      const s = loadBattle(battleId); if (!s || s.user_id !== ix.user.id) return;

      if (kind === 'run') {
        const ok = tryRun(s);
        if (ok) { end(battleId); await ix.reply({ content: '🏃 You escaped!', ephemeral: false }); }
        else    { await ix.reply({ content: '❌ Could not escape!', ephemeral: true }); }
        // after escape, bounce to HUD
        await JackIn.renderJackInHUD(ix);
        return;
      }

      if (kind === 'lock') {
        const res = resolveBattleTurn(s, s.locked);

        const regionObj = getRegion(s.user_id);
        const regionId  = regionObj?.region_id || process.env.START_REGION_ID || 'den_city';

        // public combat screen (shows virus image via render)
        const embed = battleEmbed(s, {
          playerName: ix.user.username,
          playerAvatar: ix.user.displayAvatarURL?.() || undefined,
          regionId,
        });
        await ix.reply({ embeds: [embed], ephemeral: false });

        const extra = wantDmg(s.user_id) ? `\n${res.log}` : '';

        if (res.outcome === 'victory') {
          const before = await getPlayer(s.user_id);
          const oldLevel = Number(before?.level ?? 1);

          let rewardText = '';
          if (s.enemy_kind === 'boss') {
            const br: any = rollBossRewards(s.user_id, s.enemy_id);
            rewardText =
              `**Boss Rewards:** +${br.zenny}z` +
              (br.xp ? ` • +${br.xp}xp` : '') +
              (br.drops?.length ? ` • chips: ${br.drops.join(', ')}` : '') +
              (br.leveledUp ? `\n🆙 Level Up x${br.leveledUp}` : '');
          } else {
            const vr: any = rollRewards(s.user_id, s.enemy_id);
            progressDefeat(s.user_id, s.enemy_id);
            rewardText =
              `**Rewards:** +${vr.zenny}z` +
              (vr.xp ? ` • +${vr.xp}xp` : '') +
              (vr.drops?.length ? ` • chips: ${vr.drops.join(', ')}` : '') +
              (vr.leveledUp ? `\n🆙 Level Up x${vr.leveledUp}` : '');
          }

          const after = await getPlayer(s.user_id);
          const newLevel = Number(after?.level ?? oldLevel);
          if (newLevel > oldLevel) {
            const newly = diffNewlyUnlockedRegions(s.user_id);
            if (newly.length) {
              const msg = `🔓 New region${newly.length > 1 ? 's' : ''} unlocked: ${newly.join(', ')}\nUse **/jack_in** to enter.`;
              try { await ix.user.send(msg); } catch {}
              await ix.followUp({ content: msg, ephemeral: true });
            }
          }

          end(battleId);
          await ix.followUp({ content: `✅ Victory!${extra ? ` ${extra}` : ''}\n${rewardText}`, ephemeral: false });

          // Return to Jack-In HUD so they can continue exploring
          await JackIn.renderJackInHUD(ix);
        } else if (res.outcome === 'defeat') {
          end(battleId);
          await ix.followUp({ content: `💀 Defeat…${extra ? ` ${extra}` : ''}`, ephemeral: false });

          // Return to Jack-In HUD
          await JackIn.renderJackInHUD(ix);
        } else {
          // Ongoing: show fresh ephemeral pickers built from the NEW hand
          const rows = buildPickRows(battleId, s.hand);
          await ix.followUp({ ephemeral: true, components: rows });
          if (extra) await ix.followUp({ ephemeral: true, content: extra });
        }
        return;
      }
    }
  } catch (err: any) {
    console.error('interaction error', err);
    if (ix.isRepliable()) {
      await ix.reply({ content: `⚠️ Error: ${err?.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  await registerCommands().catch(e => console.error('registerCommands', e));
});
client.login(TOKEN);
