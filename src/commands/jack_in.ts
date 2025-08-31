// src/commands/jack_in.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  Interaction,
} from 'discord.js';

import { listUnlocked, ensureStartUnlocked } from '../lib/unlock';
import { getBundle } from '../lib/data';
import { setRegion, getZone, setZone } from '../lib/db'; // <-- moved getZone/setZone here

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Choose a region, then a zone, then Explore/Shop via buttons');

export async function execute(ix: ChatInputCommandInteraction) {
  // make sure the starter region is at least unlocked
  ensureStartUnlocked(ix.user.id);

  const unlocked = new Set(listUnlocked(ix.user.id));
  const regions = Object.values(getBundle().regions)
    .filter((r) => unlocked.has(r.id))
    .sort(
      (a, b) =>
        (a.min_level || 1) - (b.min_level || 1) ||
        a.name.localeCompare(b.name)
    );

  if (!regions.length) {
    await ix.reply({ ephemeral: true, content: '❌ No regions unlocked yet.' });
    return;
  }

  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
  let cur = new ActionRowBuilder<ButtonBuilder>();
  for (const r of regions) {
    const btn = new ButtonBuilder()
      .setCustomId(`jack:r:${r.id}`)
      .setLabel(`${r.name} (Lv${r.min_level || 1}+ )`)
      .setStyle(ButtonStyle.Primary);
    if (cur.components.length >= 5) {
      rows.push(cur);
      cur = new ActionRowBuilder<ButtonBuilder>();
    }
    cur.addComponents(btn);
  }
  if (cur.components.length) rows.push(cur);

  const e = new EmbedBuilder()
    .setTitle('🔌 Jack In')
    .setDescription('Pick a region to enter.')
    .setImage(process.env.JACKIN_GIF_URL || null) // added
    .setFooter({ text: 'Step 1/3 — Region' });

  await ix.reply({ embeds: [e], components: rows, ephemeral: true });
}

// Button/component handler for region → zone → action flow
export async function handleComponent(ix: Interaction) {
  if (!ix.isButton()) return false;

  const [root, kind, a, b] = ix.customId.split(':');
  if (root !== 'jack') return false;

  const bundle = getBundle();

  // 1) Region picked
  if (kind === 'r') {
    const regionId = a;
    const r = bundle.regions[regionId];
    if (!r) {
      await ix.reply({ ephemeral: true, content: `❌ Unknown region: ${regionId}` });
      return true;
    }

    setRegion(ix.user.id, regionId);     // also resets zone to 1 in db
    const currentZone = Math.max(1, Number(getZone(ix.user.id) || 1));
    const maxZones = Math.max(1, Number((r as any).zone_count || 1));

    const zoneRows: Array<ActionRowBuilder<ButtonBuilder>> = [];
    let cur = new ActionRowBuilder<ButtonBuilder>();
    for (let z = 1; z <= Math.min(25, maxZones); z++) {
      const b = new ButtonBuilder()
        .setCustomId(`jack:z:${regionId}:${z}`)
        .setLabel(`Zone ${z}${z === currentZone ? ' • (current)' : ''}`)
        .setStyle(ButtonStyle.Secondary);
      if (cur.components.length >= 5) {
        zoneRows.push(cur);
        cur = new ActionRowBuilder<ButtonBuilder>();
      }
      cur.addComponents(b);
    }
    if (cur.components.length) zoneRows.push(cur);

    const e = new EmbedBuilder()
      .setTitle(`🔌 Jacked into ${r.name}`)
      .setDescription(r.description || '')
      .setImage(r.background_url || null)
      .setFooter({ text: 'Step 2/3 — Zone' });

    await (ix as ButtonInteraction).reply({ embeds: [e], components: zoneRows, ephemeral: true });
    return true;
  }

  // 2) Zone picked
  if (kind === 'z') {
    const regionId = a;
    const zone = Math.max(1, parseInt(b || '1', 10) || 1);
    setZone(ix.user.id, zone);

    const r = bundle.regions[regionId];
    const e = new EmbedBuilder()
      .setTitle(`${r?.name || regionId} — Zone ${zone}`)
      .setDescription('Choose what to do next.')
      .setImage(r?.background_url || null)
      .setFooter({ text: 'Step 3/3 — Action' });

    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`jack:a:explore:${regionId}:${zone}`)
        .setLabel('Explore')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`jack:a:shop:${regionId}:${zone}`)
        .setLabel('Shop')
        .setStyle(ButtonStyle.Primary),
    );

    await (ix as ButtonInteraction).reply({ embeds: [e], components: [actions], ephemeral: true });
    return true;
  }

  // 3) Actions
  if (kind === 'a') {
    const action = a; // explore | shop
    const regionId = b;
    const zone = ix.customId.split(':')[4];

    if (action === 'explore') {
      await (ix as ButtonInteraction).reply({
        ephemeral: true,
        content: `🧭 Ready to explore **${regionId} / Zone ${zone}** — use **/explore** now.`,
      });
      return true;
    }
    if (action === 'shop') {
      await (ix as ButtonInteraction).reply({
        ephemeral: true,
        content: `🛒 Opening the **${regionId}** shop: use **/shop**.`,
      });
      return true;
    }
  }

  return false;
}
