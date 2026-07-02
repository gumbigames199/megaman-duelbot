// src/index.ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Interaction,
} from 'discord.js';

import loadTSVBundle from './lib/tsv';
import { invalidateBundleCache, getBundle } from './lib/data';
import { normalizeChipIds } from './lib/db';

import * as Start from './commands/start';
import * as Profile from './commands/profile';
import * as Folder from './commands/folder';
import * as ShopCmd from './commands/shop';
import * as Mission from './commands/mission';
import * as Leaderboard from './commands/leaderboard';
import * as Chip from './commands/chip';
import * as VirusDex from './commands/virusdex';
import * as JackIn from './commands/jack_in';
import * as PvP from './commands/pvp';
import * as Battle from './lib/battle';

const TOKEN = process.env.DISCORD_TOKEN!;
const APP_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID!;
const GUILD_ID = process.env.GUILD_ID!;

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!APP_ID) throw new Error('Missing CLIENT_ID/APPLICATION_ID');
if (!GUILD_ID) console.warn('⚠️ Missing GUILD_ID (commands will not register guild-scoped)');

const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

const commands = [
  new SlashCommandBuilder()
    .setName('reload_data')
    .setDescription('Reload TSV bundle from /data (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  Start.data,
  Profile.data,
  Folder.data,
  ShopCmd.data,
  Mission.data,
  Leaderboard.data,
  Chip.data,
  VirusDex.data,
  JackIn.data,
  PvP.data,
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

function countThing(x: any): number {
  if (Array.isArray(x)) return x.length;
  if (x instanceof Map) return x.size;
  if (x && typeof x === 'object') return Object.keys(x).length;
  return 0;
}

async function safeInteractionError(ix: Interaction, err: any) {
  console.error('interaction error', err);
  if (!ix.isRepliable()) return;

  const payload = { content: `⚠️ Error: ${err?.message || String(err)}`, ephemeral: true };
  try {
    const anyIx = ix as any;
    if (anyIx.replied || anyIx.deferred) await anyIx.followUp?.(payload);
    else await anyIx.reply(payload);
  } catch {}
}

client.on('interactionCreate', async (ix) => {
  try {
    if (ix.isChatInputCommand()) {
      if (ix.commandName === 'reload_data') {
        if (!isAdmin(ix)) {
          await ix.reply({ content: '❌ Admin only.', ephemeral: true });
          return;
        }

        await ix.deferReply({ ephemeral: true });

        const rawDir = process.env.DATA_DIR || './data';
        const dataDir = path.resolve(process.cwd(), rawDir);
        let exists = false;
        let files: string[] = [];

        try {
          exists = fs.existsSync(dataDir);
          if (exists) files = fs.readdirSync(dataDir).filter(f => /\.(tsv|csv|txt|json)$/i.test(f)).sort();
        } catch {}

        let report: any = null;
        try {
          const res = (loadTSVBundle as unknown as (dir?: string) => any)(dataDir);
          report = res?.report ?? res ?? null;
        } catch (e: any) {
          await ix.editReply([
            '❌ TSV loader threw an error.',
            `• CWD: \`${process.cwd()}\``,
            `• DATA_DIR: \`${rawDir}\` → \`${dataDir}\` (exists: ${exists ? 'yes' : 'no'})`,
            `• Visible files: ${files.length ? files.join(', ') : '(none found)'}`,
            `• Error: ${e?.message || e}`,
          ].join('\n'));
          return;
        }

        invalidateBundleCache();

        let liveSummary = '';
        let normalized = { fixedInventory: 0, fixedFolder: 0 };
        try {
          const b = getBundle() as any;
          normalized = normalizeChipIds();
          liveSummary =
            `Live bundle → regions:${countThing(b.regions)} chips:${countThing(b.chips)} viruses:${countThing(b.viruses)} ` +
            `shops:${countThing(b.shop_list ?? b.shops)} dropTables:${countThing(b.dropTables)} missions:${countThing(b.missions)} PAs:${countThing(b.programAdvances)}`;
        } catch (e) {
          liveSummary = `Live bundle → failed to read: ${e}`;
        }

        const counts = report?.counts
          ? Object.entries(report.counts).map(([k, v]) => `${k}:${v}`).join(' • ')
          : 'none';

        const warnings = Array.isArray(report?.warnings) && report.warnings.length
          ? `\n⚠️ Warnings:\n- ${report.warnings.join('\n- ')}`
          : '';

        const errors = Array.isArray(report?.errors) && report.errors.length
          ? `\n❌ Errors:\n- ${report.errors.join('\n- ')}`
          : '';

        await ix.editReply([
          `📦 TSV load: **${report?.ok === false ? 'ISSUES' : 'OK'}**`,
          `Counts (loader): ${counts}`,
          `Dir: \`${dataDir}\` (exists: ${exists ? 'yes' : 'no'})`,
          `Files: ${files.length ? files.join(', ') : '(none found)'}`,
          liveSummary,
          `Chip ID normalization → inventory:${normalized.fixedInventory} folder:${normalized.fixedFolder}`,
          warnings,
          errors,
        ].filter(Boolean).join('\n'));
        return;
      }

      if (ix.commandName === 'start') { await Start.execute(ix); return; }
      if (ix.commandName === 'profile') { await Profile.execute(ix); return; }
      if (ix.commandName === 'folder') { await Folder.execute(ix); return; }
      if (ix.commandName === 'shop') { await ShopCmd.execute(ix); return; }
      if (ix.commandName === 'mission') { await Mission.execute(ix); return; }
      if (ix.commandName === 'leaderboard') { await Leaderboard.execute(ix); return; }
      if (ix.commandName === 'chip') { await Chip.execute(ix); return; }
      if (ix.commandName === 'virusdex') { await VirusDex.execute(ix); return; }
      if (ix.commandName === 'jack_in') { await JackIn.execute(ix); return; }
      if (ix.commandName === 'pvp') { await PvP.execute(ix); return; }
      return;
    }

    if (ix.isStringSelectMenu()) {
      if (ix.customId === 'jackin:selectRegion') { await JackIn.onSelectRegion(ix); return; }
      if (ix.customId === 'jackin:selectZone') { await JackIn.onSelectZone(ix); return; }
      if (ix.customId === 'jackin:selectTravelRegion') { await JackIn.onSelectTravelRegion(ix); return; }
      if (ix.customId === 'jackin:shopSelect') { await JackIn.onShopSelect(ix); return; }
      if (ix.customId === 'folder:addSelect') { await Folder.onAddSelect(ix); return; }
      if (ix.customId === 'folder:removeSelect') { await Folder.onRemoveSelect(ix); return; }
      if (ix.customId === 'shop:select') { await ShopCmd.handleShopSelect(ix); return; }
      if (ix.customId.startsWith('pvp:pick:')) { await PvP.onSelect(ix); return; }
      if (ix.customId.startsWith('pick:')) { await Battle.handlePick(ix); return; }
    }

    if (ix.isButton()) {
      if (ix.customId === 'jackin:openTravel') { await JackIn.onOpenTravel(ix); return; }
      if (ix.customId === 'jackin:travelRegion') { await JackIn.onTravelRegion(ix); return; }
      if (ix.customId === 'jackin:travelZone') { await JackIn.onTravelZone(ix); return; }
      if (ix.customId === 'jackin:encounter') { await JackIn.onEncounter(ix); return; }
      if (ix.customId === 'jackin:openShop') { await JackIn.onOpenShop(ix); return; }
      if (ix.customId === 'jackin:shopExit' || ix.customId === 'jackin:back') { await JackIn.onShopExit(ix); return; }
      if (ix.customId.startsWith('jackin:shopBuy:')) {
        const chipId = ix.customId.split(':')[2];
        await JackIn.onShopBuy(ix, chipId);
        return;
      }

      if (ix.customId === 'folder:edit') { await Folder.onEdit(ix); return; }
      if (ix.customId === 'folder:addOpen') { await Folder.onOpenAdd(ix); return; }
      if (ix.customId === 'folder:removeOpen') { await Folder.onOpenRemove(ix); return; }
      if (ix.customId === 'folder:save') { await Folder.onSave(ix); return; }

      if (ix.customId.startsWith('pvp:')) { await PvP.onButton(ix); return; }
      if (ix.customId.startsWith('shop:')) { await ShopCmd.handleShopButton(ix); return; }
      if (ix.customId.startsWith('lock:')) { await Battle.handleLock(ix); return; }
      if (ix.customId.startsWith('run:')) { await Battle.handleRun(ix); return; }
    }
  } catch (err: any) {
    await safeInteractionError(ix, err);
  }
});

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  await registerCommands().catch(e => console.error('registerCommands', e));
});

client.login(TOKEN);
