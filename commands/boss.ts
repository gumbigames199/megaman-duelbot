import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} from 'discord.js';
import { getPlayer } from '../lib/db';
import { getRegion } from '../lib/regions';
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
  if (!p) { await ix.reply({ ephemeral: true, content: '❌ No profile. Use /start.' }); return; }

  const regionId = getRegion(ix.user.id) || process.env.START_REGION_ID || 'den_city';
  const { regions, bosses, chips } = getBundle();
  const r = regions[regionId];
  if (!r || !r.boss_id) { await ix.reply({ ephemeral: true, content: '❌ No boss in this region.' }); return; }
  const b = bosses[r.boss_id];
  if (!b) { await ix.reply({ ephemeral: true, content: '❌ Boss data missing in TSV.' }); return; }

  // Optional level gate
  if ((r.min_level || 1) > (p.level || 1)) {
    await ix.reply({ ephemeral: true, content: `🔒 Requires level ${r.min_level}.` });
    return;
  }

  const battle = createBattle(ix.user.id, r.boss_id, (p.element as any) || 'Neutral', 'boss');

  // Public intro
  const embed = new EmbedBuilder()
    .setTitle(`👑 Boss: ${b.name}`)
    .setDescription(b.description || '');
  const img = b.background_url || b.anim_url || b.image_url;
  if (img) embed.setImage(img);
  embed.setFooter({ text: battle.id });

  await ix.reply({ embeds: [embed], ephemeral: false });

  // Ephemeral custom screen
  const opts = battle.hand.slice(0, 25).map(id => {
    const c = chips[id];
    return { label: (c?.name || id).slice(0, 100), description: `${c?.element || ''} Pow:${c?.power || 0}`, value: id };
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
    content: `Boss battle started (Battle ${battle.id}).`,
    components: [row, buttons],
    ephemeral: true
  });
}
