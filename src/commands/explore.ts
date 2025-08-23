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

import { getPlayer, getRegion } from '../lib/db';
import { rollEncounter } from '../lib/regions';
import { createBattle, save } from '../lib/battle';
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

  const { viruses } = getBundle();
  const v = viruses[encounter.virusId];
  if (!v) {
    await ix.reply({ ephemeral: true, content: `⚠️ Virus ${encounter.virusId} not found in TSV.` });
    return;
  }

  // init battle state
  const battle = createBattle(ix.user.id, encounter.virusId);
  const battle = createBattle(ix.user.id, encounter.virusId, p.element);

  // public embed (battlefield)
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Encounter! ${v.name}`)
    .setDescription(v.description || '')
    .addFields({ name: 'HP', value: `${v.hp}`, inline: true })
    .setThumbnail(v.image_url || null)
    .setImage(v.anim_url || null)
    .setFooter({ text: `Battle ID: ${battle.id}` });

  await ix.reply({ embeds: [embed] });

  // ephemeral “Custom Screen” — 5 drawn chips
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick:${battle.id}`)
      .setPlaceholder('Choose up to 3 chips')
      .setMinValues(0)
      .setMaxValues(3)
      .addOptions(
        battle.hand.map((id) => {
          const c = getBundle().chips[id];
          return {
            label: c?.name || id,
            description: `${c?.element || ''} Pow:${c?.power || 0}`,
            value: id,
          };
        })
      )
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
