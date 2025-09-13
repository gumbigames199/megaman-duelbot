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
import * as folder from "./commands/folder";
import * as shop from "./commands/shop";
import * as mission from "./commands/mission";
import * as leaderboard from "./commands/leaderboard";
import * as virusdex from "./commands/virusdex";
import * as chip from "./commands/chip";
import * as jackIn from "./commands/jack_in";

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
const APPLICATION_ID = must("APPLICATION_ID"); // use Application ID only (Discord Client ID)
const GUILD_ID = (process.env.GUILD_ID || "").trim(); // optional – if set, registers to that guild

// -------- client --------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Only register commands we actually ship (NO /health, NO /settings)
const commandModules = [
  start,
  profile,
  folder,
  shop,
  mission,
  leaderboard,
  virusdex,
  chip,
  jackIn,
];
const commandsJSON = commandModules
  .filter((m) => m?.data && typeof m.data.toJSON === "function")
  .map((m) => m.data.toJSON());

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
    case "folder": return folder.execute(ix);
    case "shop": return shop.execute(ix);
    case "mission": return mission.execute(ix);
    case "leaderboard": return leaderboard.execute(ix);
    case "virusdex": return virusdex.execute(ix);
    case "jack_in": return jackIn.execute(ix);
    case "chip": {
      // support either single /chip or subcommand /chip index
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
  // hub + battle/shop/jack-in buttons are centralized in jack_in
  await jackIn.handleHubButton(ix);
}

async function routeSelect(ix: StringSelectMenuInteraction) {
  await jackIn.handleSelect(ix);
}

// -------- boot --------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  try { await registerCommands(); } catch (e) { console.error("Failed to register commands:", e); }
});

client.login(TOKEN);
