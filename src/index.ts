// src/index.ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, Interaction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} from 'discord.js';

import loadTSVBundle from './lib/tsv';
import { invalidateBundleCache, getBundle } from './lib/data';
import { validateLetterRule } from './lib/rules';
import { buildBattleHeaderEmbed } from './lib/render';
import { load as loadBattle, resolveTurn as resolveBattleTurn, tryRun, end, save } from './lib/battle';
import { rollRewards, rollBossRewards } from './lib/rewards';
import { progressDefeat } from './lib/missions';
import { diffNewlyUnlockedRegions } from './lib/unlock';
import { getPlayer } from './lib/db';
import { wantDmg } from './lib/settings-util';

import * as Start from './commands/start';
import * as Profile from './commands/profile';
import * as Folder from './commands/folder';
import * as ShopCmd from './commands/shop'; // optional slash
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

/* ---------- slash (guild-scoped) ---------- */
const commands = [
  new SlashCommandBuilder()
    .setName('reload_data')
    .setDescription('Reload TSV bundle from /data (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  Start.data, Profile.data, Folder.data,
  ShopCmd.data,          // remove if you no longer want /shop
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

/* ---------- helpers ---------- */
/** Build a single multi-select (max 3) + Lock/Run buttons from a raw hand of chip ids. */
function buildPickRows(battleId: string, hand: string[]) {
  const { chips } = getBundle();

  const select = new StringSelectMenuBuilder()
    .setCustomId(`pick:${battleId}`)
    .setPlaceholder('Select up to 3 chips…')
    .setMinValues(0)
    .setMaxValues(Math.min(3, hand.length));

  const opts = (hand || []).map((cid) => {
    const c: any = chips[cid] || {};
    const name = c.name || cid;
    const code = c.code || c.letters || '';
    const pwr  = c.power || c.power_total || '';
    const hits = c.hits || 1;
    const descBits: string[] = [];
    if (c.element) descBits.push(c.element);
    if (pwr) descBits.push(`P${pwr}${hits > 1 ? `×${hits}` : ''}`);
    if (c.effects) descBits.push(String(c.effects).replace(/\s+/g, ' ').trim());
    const description = descBits.join(' • ').slice(0, 100);
    const label = `${name}${code ? ` [${code}]` : ''}`.slice(0, 100);
    return { label, description, value: cid };
  });
  if (opts.length) select.addOptions(opts);

  const rowSel = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock'),
    new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run'),
  );

  return [rowSel, rowBtns] as const;
}

/* ---------- router ---------- */
client.on('interactionCreate', async (ix) => {
  try {
    // Slash
    if (ix.isChatInputCommand()) {
      if (ix.commandName === 'reload_data') {
        if (!isAdmin(ix)) { await ix.reply({ content: '❌ Admin only.', ephemeral: true }); return; }
        await ix.deferReply({ ephemeral: true });

        // --- Diagnostics: determine and show the data directory & files ---
        const rawDir = process.env.DATA_DIR || './data';
        const dataDir = path.resolve(process.cwd(), rawDir);
        let exists = false;
        let files: string[] = [];
        try {
          exists = fs.existsSync(dataDir);
          if (exists) files = fs.readdirSync(dataDir).filter(f => /\.(tsv|csv|txt|json)$/i.test(f)).sort();
        } catch (e) {
          // ignore fs errors, will be shown below anyway
        }

        // --- Load with strong error reporting ---
        let report: any = null;
        try {
          const res = (loadTSVBundle as unknown as (dir?: string) => any)(dataDir);
          report = res?.report ?? res ?? null;
        } catch (e: any) {
          await ix.editReply(
            [
              '❌ TSV loader threw an error.',
              `• CWD: \`${process.cwd()}\``,
              `• DATA_DIR: \`${rawDir}\` → \`${dataDir}\` (exists: ${exists ? 'yes' : 'no'})`,
              `• Visible files: ${files.length ? files.join(', ') : '(none found)'}`,
              `• Error: ${e?.message || e}`,
            ].join('\n')
          );
          return;
        }

        // Invalidate cached indices/bundle so the new data is used immediately
        invalidateBundleCache();

        // Attempt to pull live bundle to confirm visibility after reload
        let liveSummary = '';
        try {
          const b = getBundle() as any;
          const count = (x: any) =>
            Array.isArray(x) ? x.length : x ? Object.keys(x).length : 0;
          liveSummary =
            `Live bundle → regions:${count(b.regions)} chips:${count(b.chips)} viruses:${count(b.viruses)} shops:${count(b.shops)}`;
        } catch (e) {
          liveSummary = `Live bundle → (failed to read: ${e})`;
        }

        const counts =
          report?.counts
            ? Object.entries(report.counts).map(([k, v]) => `${k}:${v}`).join(' • ')
            : 'none';

        const warnings = Array.isArray(report?.warnings) && report.warnings.length
          ? `\n⚠️ Warnings:\n- ${report.warnings.join('\n- ')}`
          : '';

        const errors = Array.isArray(report?.errors) && report.errors.length
          ? `\n❌ Errors:\n- ${report.errors.join('\n- ')}`
          : '';

        await ix.editReply(
          [
            `📦 TSV load: **${report?.ok === false ? 'ISSUES' : 'OK'}**`,
            `Counts (loader): ${counts}`,
            `Dir: \`${dataDir}\` (exists: ${exists ? 'yes' : 'no'})`,
            `Files: ${files.length ? files.join(', ') : '(none found)'}`,
            liveSummary,
            warnings,
            errors,
          ].filter(Boolean).join('\n')
        );
        return;
      }

      if (ix.commandName === 'start')        { await Start.execute(ix); return; }
      if (ix.commandName === 'profile')      { await Profile.execute(ix); return; }
      if (ix.commandName === 'folder')       { await Folder.execute(ix); return; }
      if (ix.commandName === 'shop')         { await ShopCmd.execute(ix); return; } // optional slash
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

    // ---------- Folder routing (buttons & selects) ----------
    if (ix.isButton()) {
      if (ix.customId === 'folder:edit')        { await Folder.onEdit(ix); return; }
      if (ix.customId === 'folder:addOpen')     { await Folder.onOpenAdd(ix); return; }
      if (ix.customId === 'folder:removeOpen')  { await Folder.onOpenRemove(ix); return; }
      if (ix.customId === 'folder:save')        { await Folder.onSave(ix); return; }
    }
    if (ix.isStringSelectMenu()) {
      if (ix.customId === 'folder:addSelect')    { await Folder.onAddSelect(ix); return; }
      if (ix.customId === 'folder:removeSelect') { await Folder.onRemoveSelect(ix); return; }
    }

    // Battle pick menu (single multi-select)
    if (ix.isStringSelectMenu() && ix.customId.startsWith('pick:')) {
      const [, battleId] = ix.customId.split(':');
      const s = loadBattle(battleId);
      if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }

      // Chosen up to 3
      const chosen = (ix.values || []).slice(0, 3);

      // Letter rule validation
      if (chosen.length) {
        const chipRows = chosen.map(id => ({ id, letters: getBundle().chips[id]?.letters || '' }));
        if (!validateLetterRule(chipRows)) {
          await ix.reply({ ephemeral: true, content: '❌ Invalid combo. Chips must share a letter, exact name, or include *.' });
          return;
        }
      }

      // Persist (compat save)
      s.locked = chosen.slice();
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
        if (ok) {
          end(battleId);
          await ix.reply({ content: '🏃 You escaped!', ephemeral: false });
          await JackIn.renderJackInHUD(ix);
        } else {
          await ix.reply({ content: '❌ Could not escape!', ephemeral: true });
        }
        return;
      }

      if (kind === 'lock') {
        const res = resolveBattleTurn(s, s.locked);

        // Public battle header with virus art (no ⚔️)
        const virus = getBundle().viruses[s.enemy_id] || { name: s.enemy_id };
        const header = buildBattleHeaderEmbed({ virusId: s.enemy_id, displayName: virus.name || s.enemy_id })
          .setDescription([
            `**Your HP:** ${s.player_hp}/${s.player_hp_max}`,
            `**Enemy HP:** ${s.enemy_hp}/` + (virus.hp ?? '—'),
          ].join('\n'));
        await ix.reply({ embeds: [header], ephemeral: false });

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
          await JackIn.renderJackInHUD(ix); // back to hub
        } else if (res.outcome === 'defeat') {
          end(battleId);
          await ix.followUp({ content: `💀 Defeat…${extra ? ` ${extra}` : ''}`, ephemeral: false });
          await JackIn.renderJackInHUD(ix); // back to hub
        } else {
          // Ongoing: show fresh ephemeral picker built from the NEW hand
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
