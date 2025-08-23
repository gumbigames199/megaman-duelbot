import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} from 'discord.js';
import { getPlayer, getRegion } from '../lib/db';
import { getBundle } from '../lib/data';
import { createBattle } from '../lib/battle';

export const data = new SlashCommandBuilder()
  .setName('boss')
  .setDescription('Boss actions')
  .addSubcommand(s => s.setName('challenge').setDescription('Challenge the region boss'));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();
  if (sub !== 'challenge') return;

  const p = getPlayer(ix.user.id);
  if (!p) { await ix.reply({ ephemeral:true, content:'❌ No profile. Use /start.' }); return; }

  const regionId = getRegion(ix.user.id) || process.env.START_REGION_ID || 'den_city';
  const { regions, bosses } = getBundle();
  const r = regions[regionId];
  if (!r || !r.boss_id) { await ix.reply({ ephemeral:true, content:'❌ No boss in this region.' }); return; }
  const b = bosses[r.boss_id];
  if (!b) { await ix.reply({ ephemeral:true, content:'❌ Boss data missing in TSV.' }); return; }

  // Optional min-level gate
  if ((r.min_level || 1) > (p.level || 1)) {
    await ix.reply({ ephemeral:true, content:`🔒 Requires level ${r.min_level}.` });
    return;
  }

  const battle = createBattle(ix.user.id, r.boss_id, p.element, 'boss');

  // Public intro
  const embed = new EmbedBuilder()
    .setTitle(`👑 Boss: ${b.name}`)
    .setDescription(b.description || '')
    .setImage(b.background_url || b.anim_url || b.image_url || null)
    .setFooter({ text: battle.id });
  await ix.reply({ embeds:[embed], ephemeral:false });

  // Ephemeral hand
  const options = battle.hand.slice(0, 25).map(id => {
    const c = getBundle().chips[id];
    return { label: c?.name || id, description: `${c?.element || ''} Pow:${c?.power || 0}`, value: id };
  });
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pick:${battle.id}`)
      .setPlaceholder('Choose up to 3 chips')
      .setMinValues(0).setMaxValues(Math.min(3, options.length))
      .addOptions(options)
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lock:${battle.id}`).setLabel('Lock In').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`run:${battle.id}`).setLabel('Run').setStyle(ButtonStyle.Secondary)
  );
  await ix.followUp({ content: `Boss battle started (Battle ${battle.id}).`, components:[row, buttons], ephemeral:true });
}
