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
import { load as loadBattle, resolveTurn as resolveBattleTurn, tryRun, end } from './lib/battle';
import { rollRewards, rollBossRewards } from './lib/rewards';
import { progressDefeat } from './lib/missions';
import { unlockNextFromRegion } from './lib/unlock';
import { getRegion } from './lib/db'; // from db, not regions
import { wantDmg } from './lib/settings-util';

import * as Start from './commands/start';
import * as Profile from './commands/profile';
import * as Folder from './commands/folder';
import * as Shop from './commands/shop';
import * as Explore from './commands/explore';
import * as Mission from './commands/mission';
import * as Travel from './commands/travel';
import * as Leaderboard from './commands/leaderboard';
// import * as Boss from './commands/boss'; // removed
import * as Settings from './commands/settings';
import * as Chip from './commands/chip';
import * as VirusDex from './commands/virusdex';
import * as JackIn from './commands/jack_in';
import { handleComponent as JackInComponents } from './commands/jack_in';

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
  Start.data, Profile.data, Folder.data, Shop.data, Explore.data,
  Mission.data, /* Boss.data, */ Travel.data, Leaderboard.data, // Boss removed
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

        // refresh in-memory cache so gameplay uses new data immediately
        invalidateBundleCache();

        await ix.editReply(`📦 TSV load: **${report.ok ? 'OK' : 'ISSUES'}**\nCounts: ${counts}${warnings}${errors}`);
        return;
      }

      if (ix.commandName === 'start')        { await Start.execute(ix); return; }
      if (ix.commandName === 'profile')      { await Profile.execute(ix); return; }
      if (ix.commandName === 'folder')       { await Folder.execute(ix); return; }
      if (ix.commandName === 'shop')         { await Shop.execute(ix); return; }
      if (ix.commandName === 'explore')      { await Explore.execute(ix); return; }
      if (ix.commandName === 'mission')      { await Mission.execute(ix); return; }
      // if (ix.commandName === 'boss')      { /* removed */ return; }
      if (ix.commandName === 'travel')       { await Travel.execute(ix); return; }
      if (ix.commandName === 'leaderboard')  { await Leaderboard.execute(ix); return; }
      if (ix.commandName === 'settings')     { await Settings.execute(ix); return; }
      if (ix.commandName === 'chip')         { await Chip.execute(ix); return; }
      if (ix.commandName === 'virusdex')     { await VirusDex.execute(ix); return; }
      if (ix.commandName === 'jack_in')      { await JackIn.execute(ix); return; }
      return;
    }

    // Select menus: pick1/pick2/pick3
    if (ix.isStringSelectMenu()) {
      const [kind, battleId] = ix.customId.split(':'); // e.g. pick1:abc
      if (!kind?.startsWith('pick')) return;

      const s = loadBattle(battleId);
      if (!s || s.user_id !== ix.user.id) return;

      // which index?
      const slotIdx = ({ pick1: 0, pick2: 1, pick3: 2 } as any)[kind] ?? 0;
      const chosenId = ix.values[0]; // may be undefined if they cleared selection

      // ensure arrays sized
      while (s.locked.length < 3) s.locked.push('');

      // prevent duplicates
      if (chosenId && s.locked.includes(chosenId)) {
        await ix.reply({ ephemeral: true, content: '⚠️ Already selected that chip in another slot.' });
        return;
      }
      s.locked[slotIdx] = chosenId || '';

      // Validate letter rule on non-empty picks
      const chosen = s.locked.filter(Boolean);
      const chipRows = chosen.map(id => ({ id, letters: getBundle().chips[id]?.letters || '' }));
      if (chosen.length && !validateLetterRule(chipRows)) {
        // revert this pick
        s.locked[slotIdx] = '';
        await ix.reply({ ephemeral: true, content: '❌ Invalid combo. Chips must share a letter, exact name, or include *.' });
        return;
      }

      await ix.reply({
        ephemeral: true,
        content: `Current order: ${s.locked.filter(Boolean).join(' → ') || '—'}`,
      });
      return;
    }

    // Components
    if (ix.isButton()) {
      // let jack_in own its customIds
      if (await JackInComponents(ix)) return;

      // Battle buttons: lock or run
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

        const embed = battleEmbed(s, {
          playerName: ix.user.username,
          playerAvatar: ix.user.displayAvatarURL?.() || undefined,
          regionId: getRegion(s.user_id)?.region_id || process.env.START_REGION_ID || 'den_city',
        });
        await ix.reply({ embeds: [embed], ephemeral: false });

        const extra = wantDmg(s.user_id) ? `\n${res.log}` : '';

        if (res.outcome === 'victory') {
          let rewardText = '';
          if (s.enemy_kind === 'boss') {
            const br = rollBossRewards(s.user_id, s.enemy_id);
            const curRegion = getRegion(s.user_id)?.region_id || process.env.START_REGION_ID || 'den_city';

            // XP + level up already handled in rollBossRewards → addXP
            const unlocked = unlockNextFromRegion(s.user_id, curRegion);
            rewardText =
              `**Boss Rewards:** +${br.zenny}z • +${br.xp}xp` +
              (br.drops.length ? ` • chips: ${br.drops.join(', ')}` : '') +
              (br.leveledUp > 0 ? `\n🆙 Level Up x${br.leveledUp}` : '') +
              (unlocked.length ? `\n🔓 Unlocked: ${unlocked.join(', ')}` : '');
          } else {
            const vr = rollRewards(s.user_id, s.enemy_id);

            // XP + level up already handled in rollRewards → addXP
            progressDefeat(s.user_id, s.enemy_id);
            rewardText =
              `**Rewards:** +${vr.zenny}z • +${vr.xp}xp` +
              (vr.drops.length ? ` • chips: ${vr.drops.join(', ')}` : '') +
              (vr.leveledUp > 0 ? `\n🆙 Level Up x${vr.leveledUp}` : '');
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
