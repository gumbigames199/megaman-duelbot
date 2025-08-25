// src/commands/explore.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { getPlayer } from '../lib/db';
import { getRegion } from '../lib/regions';
import { rollEncounter } from '../lib/regions';
import { createBattle } from '../lib/battle';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('explore')
  .setDescription('Explore your current region for encounters');

export async function execute(ix: ChatInputCommandInteraction) {
  const p = getPlayer(ix.user.id);
  if (!p) {
    await ix.reply({ ephemeral: true, content: '❌ No profile. Use /start first.' });
    return;
  }

  const regionId = getRegion(ix.user.id) || process.env.START_REGION_ID || 'den_city';
  const encounter = rollEncounter(regionId);
  if (!encounter) {
    await ix.reply({ ephemeral: false, content: `🌐 You explore ${regionId}... nothing happens.` });
    return;
  }

  const { viruses, chips } = getBundle();
  const v = viruses[encounter.virusId];
  if (!v) {
    await ix.reply({ ephemeral: true, content: `⚠️ Virus ${encounter.virusId} not found in TSV.` });
    return;
  }

  // Init battle state (pass player element)
  const battle = createBattle(ix.user.id, encounter.virusId, (p.element as any) || 'Neutral', 'virus');

  // Public embed
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Encounter! ${v.name}`)
    .setDescription(v.description || '')
    .addFields({ name: 'HP', value: String(v.hp), inline: true })
    .setFooter({ text: `Battle ID: ${battle.id}` });

  if (v.image_url) embed.setThumbnail(v.image_url);
  const big = v.anim_url || v.image_url;
  if (big) embed.setImage(big);

  await ix.reply({ embeds: [embed] });

  // Ephemeral “Custom Screen” — 5 drawn chips
  const opts = battle.hand.slice(0, 25).map((id) => {
    const c = chips[id];
    return {
      label: (c?.name || id).slice(0, 100),
      description: `${c?.element || ''} Pow:${c?.power || 0}`,
      value: id,
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick:${battle.id}`)
      .setPlaceholder('Choose up to 3 chips')
      .setMinValues(0)
      .setMaxValues(Math.min(3, opts.length || 1))
      .addOptions(opts)
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battle.id}`).setLabel('Lock In').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`run:${battle.id}`).setLabel('Run').setStyle(ButtonStyle.Secondary)
  );

  await ix.followUp({
    content: `Your hand (Battle ${battle.id}):`,
    components: [row, buttons],
    ephemeral: true,
  });
}
