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

import { getPlayer, getRegion, getZone } from '../lib/db';
import { rollEncounter } from '../lib/regions';
import { createBattle } from '../lib/battle';
import { getBundle } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('explore')
  .setDescription('Explore your current region/zone for encounters');

export async function execute(ix: ChatInputCommandInteraction) {
  const p = getPlayer(ix.user.id);
  if (!p) {
    await ix.reply({ ephemeral: true, content: '❌ No profile. Use /start first.' });
    return;
  }

  const regionId = getRegion(ix.user.id) || process.env.START_REGION_ID || 'den_city';
  const zone = getZone(ix.user.id) || 1;

  const encounter = rollEncounter(regionId, zone);
  if (!encounter) {
    await ix.reply({ ephemeral: false, content: `🌐 You explore ${regionId} (Zone ${zone})… nothing happens.` });
    return;
  }

  const { viruses, bosses, regions, chips } = getBundle();

  // Normalize enemy info based on encounter.kind
  let enemyId = encounter.id as string;
  let enemyKind: 'virus' | 'boss' = encounter.kind;
  let name = '';
  let hp = 0;
  let description = '';
  let image_url: string | undefined;
  let anim_url: string | undefined;

  if (encounter.kind === 'boss') {
    const b = bosses[encounter.id];
    if (!b) {
      await ix.reply({ ephemeral: true, content: `⚠️ Boss ${encounter.id} not found in TSV.` });
      return;
    }
    name = b.name;
    hp = b.hp;
    description = b.description || '';
    image_url = b.image_url || undefined;
    anim_url = b.anim_url || undefined;
  } else {
    const v = viruses[encounter.id];
    if (!v) {
      await ix.reply({ ephemeral: true, content: `⚠️ Virus ${encounter.id} not found in TSV.` });
      return;
    }
    name = v.name;
    hp = v.hp;
    description = v.description || '';
    image_url = v.image_url || undefined;
    anim_url = v.anim_url || undefined;
  }

  // Start battle with the correct enemy kind
  const battle = createBattle(ix.user.id, enemyId, (p.element as any) || 'Neutral', enemyKind);

  // Background preference: region bg > enemy anim > enemy image
  const r = regions[regionId];
  const bg = r?.background_url || anim_url || image_url || null;

  // Public encounter embed
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Encounter! ${name} — Zone ${zone}`)
    .setDescription(description)
    .addFields({ name: 'HP', value: String(hp), inline: true })
    .setFooter({ text: `Battle ID: ${battle.id}` });

  if (image_url) embed.setThumbnail(image_url);
  if (bg) embed.setImage(bg);

  await ix.reply({ embeds: [embed] });

  // Build 3 ordered selects: pick1, pick2, pick3 (no duplicates)
  const mkOptions = battle.hand.map((id) => {
    const c = chips[id];
    return {
      label: (c?.name || id).slice(0, 100),
      description: `${c?.element || 'Neutral'} • Pow:${c?.power ?? 0}`,
      value: id,
    };
  });

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick1:${battle.id}`)
      .setPlaceholder('1st chip')
      .setMinValues(0).setMaxValues(1)
      .addOptions(mkOptions)
  );
  const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick2:${battle.id}`)
      .setPlaceholder('2nd chip (optional)')
      .setMinValues(0).setMaxValues(1)
      .addOptions(mkOptions)
  );
  const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick3:${battle.id}`)
      .setPlaceholder('3rd chip (optional)')
      .setMinValues(0).setMaxValues(1)
      .addOptions(mkOptions)
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battle.id}`).setLabel('Lock In').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`run:${battle.id}`).setLabel('Run').setStyle(ButtonStyle.Secondary),
  );

  await ix.followUp({
    content: `Choose chips in order (1st → 3rd). You can pick fewer than 3.`,
    components: [row1, row2, row3, buttons],
    ephemeral: true,
  });
}
