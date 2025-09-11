// index.ts
// Bootstraps the Discord bot, registers slash commands, and routes interactions.
// Changes:
// - Removes /health from registration.
// - Excludes /settings (to remove /settings view & /settings set). We'll ship a trimmed settings later if needed.
// - Routes hub buttons & selects through jack_in, which passes battle/shop IDs downstream.
// - Supports /chip with subcommand "index" (and gracefully defaults to index if omitted).

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

// ----- Commands (adjust relative paths if your build differs) -----
import * as start from "./commands/start";
import * as profile from "./commands/profile";
import * as folder from "./commands/folder";
import * as shop from "./commands/shop";
import * as explore from "./commands/explore";
import * as mission from "./commands/mission";
import * as boss from "./commands/boss";
import * as travel from "./commands/travel";
import * as leaderboard from "./commands/leaderboard";
import * as virusdex from "./commands/virusdex";
import * as chip from "./commands/chip";
// import * as settings from "./commands/settings"; // intentionally disabled to remove /settings view & /settings set
import * as jackIn from "./commands/jack_in";

// ----- Env -----
const TOKEN = mustGetEnv("DISCORD_TOKEN");
const CLIENT_ID = mustGetEnv("CLIENT_ID");
const GUILD_ID = process.env.GUILD_ID || ""; // optional (guild register if present)

// ----- Discord Client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ----- Command Registration -----
const commandModules = [
  start,
  profile,
  folder,
  shop,
  explore,
  mission,
  boss,
  travel,
  leaderboard,
  virusdex,
  chip,
  jackIn,
  // settings, // intentionally excluded
  // health,   // if you had one, also excluded per requirements
];

const commandsJSON = commandModules
  .filter((m) => m?.data && typeof m.data.toJSON === "function")
  .map((m) => m.data.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  if (GUILD_ID) {
    console.log(`🔧 Registering guild commands to ${GUILD_ID}…`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commandsJSON,
    });
  } else {
    console.log(`🌐 Registering global commands…`);
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commandsJSON,
    });
  }
  console.log("✅ Commands registered.");
}

// ----- Ready -----
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

// ----- Interaction Routing -----
client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      await routeSlash(interaction);
      return;
    }

    // Buttons → jack_in first (it passes through battle/shop IDs)
    if (interaction.isButton()) {
      await routeButton(interaction);
      return;
    }

    // Select menus → jack_in (handles battle pick + shop select)
    if (interaction.isStringSelectMenu()) {
      await routeSelect(interaction);
      return;
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ Something went wrong.", ephemeral: true });
    }
  }
});

// ----- Routers -----

async function routeSlash(ix: ChatInputCommandInteraction) {
  const name = ix.commandName;

  switch (name) {
    case "start":       return start.execute(ix);
    case "profile":     return profile.execute(ix);
    case "folder":      return folder.execute(ix);
    case "shop":        return shop.execute(ix);
    case "explore":     return explore.execute(ix);
    case "mission":     return mission.execute(ix);
    case "boss":        return boss.execute(ix);
    case "travel":      return travel.execute(ix);
    case "leaderboard": return leaderboard.execute(ix);
    case "virusdex":    return virusdex.execute(ix);
    case "jack_in":     return jackIn.execute(ix);

    case "chip": {
      // Expect subcommand "index"
      const sub = ix.options.getSubcommand(false) || "index";
      // If your chip.ts exposes a single execute() that handles subcommands internally, just call it:
      if (typeof (chip as any).execute === "function") {
        return (chip as any).execute(ix, sub);
      }
      // Otherwise, call a specific handler if exported:
      if (sub === "index" && typeof (chip as any).executeIndex === "function") {
        return (chip as any).executeIndex(ix);
      }
      return ix.reply({ content: "Unknown subcommand.", ephemeral: true });
    }

    // case "settings": // intentionally removed from registration
    //   return settings.execute(ix);

    default:
      return ix.reply({ content: "Unknown command.", ephemeral: true });
  }
}

async function routeButton(ix: ButtonInteraction) {
  // Hub buttons (and pass-through to battle/shop) are handled in jack_in
  await jackIn.handleHubButton(ix);
}

async function routeSelect(ix: StringSelectMenuInteraction) {
  // Battle picks & shop dropdown handled in jack_in (which delegates to battle/shop)
  await jackIn.handleSelect(ix);
}

// ----- Helpers -----

function mustGetEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
  return v;
}

// ----- Start -----
client.login(TOKEN);
