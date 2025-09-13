// src/index.ts
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";

import * as start from "./commands/start";
import * as profile from "./commands/profile";
import * as folderCmd from "./commands/folder";
import * as shop from "./commands/shop";
import * as mission from "./commands/mission";
import * as leaderboard from "./commands/leaderboard";
import * as virusdex from "./commands/virusdex";
import * as chip from "./commands/chip";
import * as jackIn from "./commands/jack_in";

import * as battleMod from "./lib/battle";
import * as renderMod from "./lib/render";
import * as rewardsMod from "./lib/rewards";
import { getPlayer } from "./lib/db";
import { diffNewlyUnlockedRegions } from "./lib/unlock";

// ---- dynamic wrappers so we don't depend on exact named exports ----
const Battle = {
  load:
    (battleMod as any).load ||
    (battleMod as any).get ||
    (battleMod as any).loadBattle,
  save:
    (battleMod as any).save ||
    (battleMod as any).put ||
    (battleMod as any).saveBattle,
  resolveTurn:
    (battleMod as any).resolveTurn ||
    (battleMod as any).resolve ||
    (battleMod as any).step,
  tryRun:
    (battleMod as any).tryRun ||
    (battleMod as any).attemptEscape ||
    (battleMod as any).run,
  end:
    (battleMod as any).end ||
    (battleMod as any).finish ||
    (battleMod as any).close,
};

const battleEmbed =
  (renderMod as any).battleEmbed ||
  (renderMod as any).renderBattle ||
  (renderMod as any).battleView ||
  (renderMod as any).embed;

const rollRewards =
  (rewardsMod as any).rollRewards ||
  (rewardsMod as any).rollVirusRewards ||
  (rewardsMod as any).roll;

const rollBossRewards =
  (rewardsMod as any).rollBossRewards ||
  (rewardsMod as any).rollBoss ||
  (rewardsMod as any).rollBossReward;

// -------- env helpers --------
function must(k: string): string {
  const v = process.env[k];
  if (!v || !v.trim()) {
    console.error(`Missing env ${k}`);
    process.exit(1);
  }
  return v.trim();
}
const TOKEN = must("DISCORD_TOKEN");
const APPLICATION_ID = must("APPLICATION_ID");
const GUILD_ID = (process.env.GUILD_ID || "").trim();

// -------- client --------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Only register commands we actually ship (NO /health, NO /settings)
const commandModules = [
  start,
  profile,
  folderCmd,
  shop,
  mission,
  leaderboard,
  virusdex,
  chip,
  jackIn,
];
const commandsJSON = commandModules
  .filter((m) => (m as any)?.data && typeof (m as any).data.toJSON === "function")
  .map((m) => (m as any).data.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  if (GUILD_ID) {
    console.log(`🔧 Registering guild commands to ${GUILD_ID} (app ${APPLICATION_ID})…`);
    await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID), {
      body: commandsJSON,
    });
  } else {
    console.log(`🌐 Registering global commands (app ${APPLICATION_ID})…`);
    await rest.put(Routes.applicationCommands(APPLICATION_ID), {
      body: commandsJSON,
    });
  }
  console.log("✅ Commands registered.");
}

// -------- interaction routing --------
client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) return routeSlash(interaction);
    if (interaction.isButton()) return routeButton(interaction);
    if (interaction.isStringSelectMenu()) return routeSelect(interaction);
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ Something went wrong.", ephemeral: true });
    }
  }
});

async function routeSlash(ix: ChatInputCommandInteraction) {
  switch (ix.commandName) {
    case "start": return start.execute(ix);
    case "profile": return profile.execute(ix);
    case "folder": return folderCmd.execute(ix);
    case "shop": return shop.execute(ix);
    case "mission": return mission.execute(ix);
    case "leaderboard": return leaderboard.execute(ix);
    case "virusdex": return virusdex.execute(ix);
    case "jack_in": return jackIn.execute(ix);
    case "chip": {
      const sub = ix.options.getSubcommand(false) || "index";
      if (typeof (chip as any).execute === "function") return (chip as any).execute(ix, sub);
      if (sub === "index" && typeof (chip as any).executeIndex === "function") return (chip as any).executeIndex(ix);
      return ix.reply({ content: "Unknown subcommand.", ephemeral: true });
    }
    default:
      return ix.reply({ content: "Unknown command.", ephemeral: true });
  }
}

async function routeButton(ix: ButtonInteraction) {
  // Folder editing
  if (ix.customId === "folder:edit") return folderCmd.onEdit(ix);
  if (ix.customId === "folder:save") return folderCmd.onSave(ix);
  if (ix.customId === "folder:addOpen") return folderCmd.onOpenAdd(ix);
  if (ix.customId === "folder:removeOpen") return folderCmd.onOpenRemove(ix);

  // Jack-in hub (travel + encounter)
  if (ix.customId === "jackin:openTravel") return jackIn.onOpenTravel(ix);
  if (ix.customId === "jackin:encounter") return jackIn.onEncounter(ix);

  // Battle actions
  if (ix.customId.startsWith("lock:")) {
    const battleId = ix.customId.split(":")[1];
    const s = Battle.load?.(battleId);
    if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }
    await ix.deferReply({ ephemeral: false });

    const res = Battle.resolveTurn?.(s) ?? {};
    Battle.save?.(battleId, s);

    const emb = battleEmbed?.(s as any, {
      playerName: ix.user.username,
      playerAvatar: ix.user.displayAvatarURL(),
    });

    if ((res as any).outcome === "victory") {
      let text = "";
      if (s.enemy_kind === "boss") {
        const r: any = rollBossRewards?.(s.user_id, s.enemy_id) ?? {};
        (rewardsMod as any).progressDefeat?.(s.user_id, s.enemy_id); // in case wired there
        text =
          `**Rewards:** +${r.zenny ?? 0}z` +
          (r.xp ? ` • +${r.xp}xp` : "") +
          (r.grants?.length ? ` • chips: ${r.grants.join(", ")}` : "");
      } else {
        const r: any = rollRewards?.(s.user_id, s.enemy_id) ?? {};
        // missions.ts usually handles progress; keep old call in your rewards if needed
        text =
          `**Rewards:** +${r.zenny ?? 0}z` +
          (r.xp ? ` • +${r.xp}xp` : "") +
          (r.drops?.length ? ` • chips: ${r.drops.join(", ")}` : "");
      }

      const before = getPlayer(s.user_id);
      const after = getPlayer(s.user_id);
      if (after && before && (after as any).level > (before as any).level) {
        const unlocked = diffNewlyUnlockedRegions(s.user_id);
        if (unlocked.length) {
          try { await ix.user.send(`🔓 New region(s) unlocked: ${unlocked.join(", ")}`); } catch {}
        }
      }

      Battle.end?.(battleId);
      await ix.followUp({ embeds: emb ? [emb] : [], content: `✅ Victory!\n${text}`, ephemeral: false });
    } else if ((res as any).outcome === "defeat") {
      Battle.end?.(battleId);
      await ix.followUp({ embeds: emb ? [emb] : [], content: `💀 Defeat…`, ephemeral: false });
    } else {
      await ix.followUp({ embeds: emb ? [emb] : [], ephemeral: false });
    }
    return;
  }

  if (ix.customId.startsWith("run:")) {
    const battleId = ix.customId.split(":")[1];
    const s = Battle.load?.(battleId);
    if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }

    await ix.deferReply({ ephemeral: false });
    const ok = !!Battle.tryRun?.(s);
    if (ok) {
      Battle.end?.(battleId);
      await ix.followUp({ content: "🏃 Escaped successfully.", ephemeral: false });
    } else {
      const emb = battleEmbed?.(s as any, {
        playerName: ix.user.username,
        playerAvatar: ix.user.displayAvatarURL(),
      });
      await ix.followUp({ embeds: emb ? [emb] : [], ephemeral: false });
    }
    return;
  }

  await ix.deferUpdate();
}

async function routeSelect(ix: StringSelectMenuInteraction) {
  // Folder selects
  if (ix.customId === "folder:addSelect") return folderCmd.onAddSelect(ix);
  if (ix.customId === "folder:removeSelect") return folderCmd.onRemoveSelect(ix);

  // Jack-in selects
  if (ix.customId === "jackin:selectRegion") return jackIn.onSelectRegion(ix);
  if (ix.customId === "jackin:selectZone") return jackIn.onSelectZone(ix);

  // Battle pick menus: pick1:, pick2:, pick3:
  if (/^pick[123]:/.test(ix.customId)) {
    const [kind, battleId] = ix.customId.split(":");
    const s = Battle.load?.(battleId);
    if (!s || s.user_id !== ix.user.id) { await ix.deferUpdate(); return; }
    const slotIdx = ({ pick1: 0, pick2: 1, pick3: 2 } as any)[kind] ?? 0;
    const choice = ix.values?.[0] || "";
    s.picks = s.picks ?? ["", "", ""];
    s.picks[slotIdx] = choice;
    Battle.save?.(battleId, s);
    await ix.deferUpdate();
    return;
  }

  await ix.deferUpdate();
}

// -------- boot --------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  try { await registerCommands(); } catch (e) { console.error("Failed to register commands:", e); }
});

client.login(TOKEN);
