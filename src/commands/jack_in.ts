// src/commands/jack_in.ts
import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder
} from 'discord.js';

import { listUnlocked, ensureStartUnlocked } from '../lib/unlock';
import { getBundle } from '../lib/data';
import { setRegion, getRegion, setZone } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Choose a region, then a zone, then Explore/Shop via buttons');

export async function execute(ix: ChatInputCommandInteraction) {
  // make sure the starter region is at least unlocked
  ensureStartUnlocked(ix.user.id);

  const unlocked = new Set(listUnlocked(ix.user.id));
  const regions = Object.values(getBundle().regions)
    .filter(r => unlocked.has(r.id))
    .sort((a, b) => (a.min_level || 1) - (b.min_level || 1) || a.name.localeCompare(b.name));

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
    .setImage(process.env.JACKIN_GIF_URL || regions[0].background_url || null) // fallback to region background
    .setFooter({ text: 'Step 1/3 — Region' });

  await ix.reply({ embeds: [e], components: rows, ephemeral: true });
}
