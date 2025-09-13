import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getPlayer, listInventory } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your Navi profile')
  .addUserOption(o => o.setName('user').setDescription('View another user').setRequired(false));

export async function execute(ix: ChatInputCommandInteraction) {
  const user = ix.options.getUser('user') ?? ix.user;
  const p = getPlayer(user.id);
  if (!p) { await ix.reply({ ephemeral: true, content: '❌ No profile. Run **/start** first.' }); return; }

  const inv = listInventory(user.id).slice(0, 12).map(x => `${x.chip_id} ×${x.qty}`).join(' • ') || '—';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.username}.EXE`, iconURL: user.displayAvatarURL() })
    .setTitle('Navi Profile')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Element', value: String(p.element), inline: true },
      { name: 'Level', value: String(p.level), inline: true },
      { name: 'HP', value: String(p.hp_max), inline: true },
      { name: 'Stats', value: `ATK ${p.atk} • DEF ${p.def} • SPD ${p.spd}\nACC ${p.acc}% • EVA ${p.evasion}%`, inline: false },
      { name: 'Zenny', value: String(p.zenny), inline: true },
      { name: 'Inventory (top)', value: inv, inline: false },
    );
  await ix.reply({ ephemeral: true, embeds: [embed] });
}
