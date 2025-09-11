// src/index.ts
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, Interaction
} from 'discord.js';

import loadTSVBundle from './lib/tsv';
import { invalidateBundleCache } from './lib/data';
import { validateLetterRule } from './lib/rules';
import { battleEmbed } from './lib/render';
import { load as loadBattle, resolveTurn as resolveBattleTurn, tryRun, end, save } from './lib/battle';
import { rollRewards, rollBossRewards } from './lib/rewards';
import { progressDefeat } from './lib/missions';
import { diffNewlyUnlockedRegions } from './lib/unlock';
import { getRegion, getPlayer } from './lib/db'; // <- getZone removed
import { wantDmg } from './lib/settings-util';

import * as Start from './commands/start';
import * as Profile from './commands/profile';
import * as Folder from './commands/folder';
import * as Shop from './commands/shop';
import * as Mission from './commands/mission';
import * as Leaderboard from './commands/leaderboard';
import * as Settings from './commands/settings';
import * as Chip from './commands/chip';
import * as VirusDex from './commands/virusdex';
import * as JackIn from './commands/jack_in';

// ---- Env checks ----
const TOKEN    = process.env.DISCORD_TOKEN!;
const APP_ID   = process.env.CLIENT_ID || process.env.APPLICATION_ID!;
const GUILD_ID = process.env.GUILD_ID!;
if (!TOKEN)   throw new Error('Missing DISCORD_TOKEN');
if (!APP_ID)  throw new Error('Missing CLIENT_ID/APPLICATION_ID');
if (!GUILD_ID) console.warn('⚠️ Missing GUILD_ID (commands will not register guild-scoped)');

// ---- Client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ---- Slash commands (guild-scoped) ----
const commands = [
  new SlashCommandBuilder().setName('health').setDescription('Bot status (ephemeral)'),
  new SlashCommandBuilder()
    .setName('reload_data')
    .setDescription('Reload TSV bundle from /data (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  Start.data, Profile.data, Folder.data, Shop.data,
  Mission.data, Leaderboard.data,
  Settings.data, Chip.data, VirusDex.data, JackIn.data,
].map((c: any) => c.toJSON());

// ---- Register (guild) ----
async function registerCommands() {
  if (!GUILD_ID) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  console.log(`✅ Registered ${commands.length} guild commands to ${GUILD_ID}`);
}

// ---- Helpers ----
function isAdmin(ix: Interaction): boolean {
  const anyIx = ix as any;
  return Boolean(
    anyIx.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    anyIx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
}

// ---- Interaction handler (slash + components) ----
client.on('interactionCreate', async (ix) => {
  try {
    // Slash commands
    if (ix.isChatInputCommand()) {
      if (ix.commandName === 'health') {
        await ix.reply({ content: '✅ Alive. Data path ready. Use /reload_data to validate TSVs.', ephemeral: true });
        return;
      }
      if (ix.commandName === 'reload_data') {
        if (!isAdmin(ix)) { await ix.reply({ content: '❌ Admin only.', ephemeral: true }); return; }
        await ix.deferReply({ ephemeral: true });

        const { report } = loadTSVBundle(process.env.DATA_DIR || './data');
        const counts = Object.entries(report.counts).map(([k, v]) => `${k}:${v}`).join(' • ') || 'none';
        const warnings = report.warnings.length ? `\n⚠️ Warnings:\n- ${report.warnings.join('\n- ')}` : '';
        const errors = report.errors.length ? `\n❌ Errors:\n- ${report.errors.join('\n- ')}` : '';

        invalidateBundleCache(); // refresh in-memory bundle

        await ix.editReply(`📦 TSV load: **${report.ok ? 'OK' : 'ISSUES'}**\nCounts: ${counts}${warnings}${errors}`);
        return;
      }

      if (ix.commandName === 'start')        { await Start.execute(ix); return; }
      if (ix.commandName === 'profile')      { await Profile.execute(ix); return; }
      if (ix.commandName === 'folder')       { await Folder.execute(ix); return; }
      if (ix.commandName === 'shop')         { await Shop.execute(ix); return; }
      if (ix.commandName === 'mission')      { await Mission.execute(ix); return; }
      if (ix.commandName === 'leaderboard')  { await Leaderboard.execute(ix); return; }
      if (ix.commandName === 'settings')     { await Settings.execute(ix); return; }
      if (ix.commandName === 'chip')         { await Chip.execute(ix); return; }
      if (ix.commandName === 'virusdex')     { await VirusDex.execute(ix); return; }
      if (ix.commandName === 'jack_in')      { await JackIn.execute(ix); return; }
      return;
    }

    /* ---------- Folder UI routing ---------- */
    if (ix.isButton()) {
      if (ix.customId === 'folder:edit')        { await Folder.onEdit(ix);        return; }
      if (ix.customId === 'folder:save')        { await Folder.onSave(ix);        return; }
      if (ix.customId === 'folder:addOpen')     { await Folder.onOpenAdd(ix);     return; }
      if (ix.customId === 'folder:removeOpen')  { await Folder.onOpenRemove(ix);  return; }
    }
    if (ix.isStringSelectMenu()) {
      if (ix.customId === 'folder:addSelect')    { await Folder.onAddSelect(ix);    return; }
      if (ix.customId === 'folder:removeSelect') { await Folder.onRemoveSelect(ix); return; }
    }

    /* ---------- Jack-In routing ---------- */
    if (ix.isStringSelectMenu()) {
      if (ix.customId === 'jackin:selectRegion') { await JackIn.onSelectRegion(ix); return; }
      if (ix.customId === 'jackin:selectZone')   { await JackIn.onSelectZone(ix);   return; }
    }
    if (ix.isButton()) {
      if (ix.customId === 'jackin:openTravel')   { await JackIn.onOpenTravel(ix);   return; }
      if (ix.customId === 'jackin:encounter')    { await JackIn.onEncounter(ix);    return; }
    }

    /* ---------- Battle pick menus: silent + persisted ---------- */
    if (ix.isStringSelectMenu()) {
      const [kind, battleId] = ix.customId.split(':'); // e.g. pick1:abc
      if (!/^pick[123]$/.test(kind)) return;

      const s = loadBattle(battleId);
      if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }

      const slotIdx = ({ pick1: 0, pick2: 1, pick3: 2 } as any)[kind] ?? 0;
      const chosenId = ix.values[0] || ''; // allow clearing (min=0)

      while (s.locked.length < 3) s.locked.push('');

      if (chosenId && s.locked.includes(chosenId)) {
        await ix.reply({ ephemeral: true, content: '⚠️ Already selected that chip in another slot.' });
        return;
      }

      const prev = s.locked[slotIdx];
      s.locked[slotIdx] = chosenId;

      const chosen = s.locked.filter(Boolean);
      if (chosen.length) {
        const chipRows = chosen.map(id => ({ id, letters: (getBundle().chips as any)[id]?.letters || '' }));
        if (!validateLetterRule(chipRows)) {
          s.locked[slotIdx] = prev; // revert
          await ix.reply({ ephemeral: true, content: '❌ Invalid combo. Chips must share a letter, exact name, or include *.' });
          return;
        }
      }

      save(s);               // persist the pick
      await ix.deferUpdate(); // no message clutter
      return;
    }

    /* ---------- Battle buttons: lock or run ---------- */
    if (ix.isButton()) {
      const [kind, battleId] = ix.customId.split(':');
      const s = loadBattle(battleId); if (!s || s.user_id !== ix.user.id) return;

      if (kind === 'run') {
        const ok = tryRun(s);
        if (ok) {
          end(battleId);
          await ix.reply({ content: '🏃 You escaped!', ephemeral: false });
        } else {
          await ix.reply({ content: '❌ Could not escape!', ephemeral: true });
        }
        return;
      }

      if (kind === 'lock') {
        const res = resolveBattleTurn(s, s.locked);

        const regionObj = getRegion(s.user_id);
        const regionId  = regionObj?.region_id || process.env.START_REGION_ID || 'den_city';

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
        } else if (res.outcome === 'defeat') {
          end(battleId);
          await ix.followUp({ content: `💀 Defeat…${extra ? ` ${extra}` : ''}`, ephemeral: false });
        } else {
          await ix.followUp({ content: `Select next turn via the ephemeral menu.${extra ? `\n${extra}` : ''}`, ephemeral: true });
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

// ---- Boot ----
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  await registerCommands().catch(e => console.error('registerCommands', e));
});
client.login(TOKEN);
