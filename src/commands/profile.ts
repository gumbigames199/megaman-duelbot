// src/commands/profile.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getPlayer, listInventory } from '../lib/db';
import { getChipById, chipIsUpgrade } from '../lib/data';

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your Navi profile')
  .addUserOption(o =>
    o.setName('user')
      .setDescription('View another user')
      .setRequired(false),
  );

function formatInventoryTop(userId: string, limit = 12) {
  // listInventory returns rows like { chip_id, qty }
  const rows = listInventory(userId) || [];

  const pretty = rows
    // map to chip object
    .map((r: any) => {
      const chip: any = getChipById(r.chip_id);
      return { chip, qty: Number(r.qty ?? 0), rawId: String(r.chip_id) };
    })
    // hide upgrades from the preview line
    .filter(({ chip }) => chip && !chipIsUpgrade(chip))
    // convert to "Name ×qty"
    .map(({ chip, qty, rawId }) => `${chip?.name || rawId} ×${qty}`);

  if (!pretty.length) return '—';
  return pretty.slice(0, limit).join(' • ');
}

export async function execute(ix: ChatInputCommandInteraction) {
  const user = ix.options.getUser('user') ?? ix.user;
  const p: any = getPlayer(user.id);
  if (!p) {
    await ix.reply({ ephemeral: true, content: '❌ No profile. Run **/start** first.' });
    return;
  }

  const invLine = formatInventoryTop(user.id, 12);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.username}.EXE`, iconURL: user.displayAvatarURL() })
    .setTitle('Navi Profile')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Element', value: String(p.element ?? 'Neutral'), inline: true },
      { name: 'Level', value: String(p.level ?? 1), inline: true },
      { name: 'HP', value: String(p.hp_max ?? 100), inline: true },
      {
        name: 'Stats',
        value:
          `ATK ${p.atk ?? 0} • DEF ${p.def ?? 0} • SPD ${p.spd ?? 0}\n` +
          `ACC ${p.acc ?? 100}% • EVA ${p.evasion ?? 0}%`,
        inline: false,
      },
      { name: 'Zenny', value: String(p.zenny ?? 0), inline: true },
      { name: 'Inventory (top)', value: invLine, inline: false },
    );

  await ix.reply({ ephemeral: true, embeds: [embed] });
}
