// commands/start.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  inlineCode,
} from "discord.js";

import {
  ensurePlayer,
  getPlayer,
  setNameAndElement,
  setRegion,
  addZenny,
  grantChip,
  addToFolder,
} from "../lib/db";

import { getRegionById } from "../lib/data";

const START_REGION_ID = process.env.START_REGION_ID || "den_city";
const STARTER_ZENNY = num(process.env.STARTER_ZENNY, 0);
const STARTER_CHIPS = String(process.env.STARTER_CHIPS || "").trim(); // e.g. "cannon:2,sword"

export const data = new SlashCommandBuilder()
  .setName("start")
  .setDescription("Begin your Net Battlers journey")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("Your operator name")
      .setRequired(false)
  )
  .addStringOption((o) =>
    o
      .setName("element")
      .setDescription("Your starting element")
      .addChoices(
        { name: "Neutral", value: "Neutral" },
        { name: "Fire", value: "Fire" },
        { name: "Wood", value: "Wood" },
        { name: "Elec", value: "Elec" },
        { name: "Aqua", value: "Aqua" },
      )
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const name = interaction.options.getString("name");
  const element = interaction.options.getString("element");

  // create/get player
  ensurePlayer(userId);

  // apply optional name/element (separate call from ensurePlayer — fixes “Expected 1 arg, got 3”)
  if (name || element) setNameAndElement(userId, name ?? null, element ?? null);

  // ensure region
  const p0 = getPlayer(userId)!;
  if (!p0.region_id) setRegion(userId, START_REGION_ID);

  // starter currency
  if (STARTER_ZENNY > 0 && (p0.zenny ?? 0) === 0) addZenny(userId, STARTER_ZENNY);

  // starter chips/folder (only if folder is empty)
  tryGrantStarterChips(userId);

  const p = getPlayer(userId)!;
  const region = getRegionById(p.region_id || START_REGION_ID);
  const regionLabel = region?.label ?? (p.region_id || START_REGION_ID);

  const lines = [
    `**Welcome${p.name ? `, ${inlineCode(p.name)}` : ""}!**`,
    `Element: ${inlineCode(p.element || "Neutral")}`,
    `Region: ${inlineCode(regionLabel)}`,
    `HP: ${inlineCode(String(p.hp_max))} • ATK: ${inlineCode(String(p.atk))} • DEF: ${inlineCode(String(p.def))}`,
    `SPD: ${inlineCode(String(p.spd))} • ACC: ${inlineCode(String(p.acc))} • EVA: ${inlineCode(String(p.evasion))}`,
    `Zenny: ${inlineCode(String(p.zenny))}`,
    "",
    "Use `/jack_in` to Encounter, Travel, or Shop.",
  ];

  const embed = new EmbedBuilder()
    .setTitle("🚀 Net Battlers — Start")
    .setDescription(lines.join("\n"));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// -------------------- helpers --------------------

function tryGrantStarterChips(userId: string) {
  const folder = require("../lib/db") as typeof import("../lib/db");
  const items = folder.listFolder(userId);
  if (items.length > 0) return;

  const grants = parseStarterChips(STARTER_CHIPS);
  for (const g of grants) {
    grantChip(userId, g.id, g.qty);
    addToFolder(userId, g.id, g.qty);
  }
}

function parseStarterChips(s: string): { id: string; qty: number }[] {
  if (!s) return [];
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  const out: { id: string; qty: number }[] = [];
  for (const part of parts) {
    const [id, qtyStr] = part.split(":").map((x) => x.trim());
    const qty = Math.max(1, num(qtyStr, 1));
    if (id) out.push({ id, qty });
  }
  return out;
}

function num(v: any, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
