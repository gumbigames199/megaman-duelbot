// src/commands/profile.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
} from 'discord.js';
import {
  getPlayer,
  listInventory,
  getStyleProgress,
  getPendingStyleElement,
  normalizeStyleElement,
  resetStyleToNeutral,
  STYLE_CHANGE_THRESHOLD,
} from '../lib/db';
import { getChipById, chipIsUpgrade, formatChipName } from '../lib/data';
import { getAvailableChipQty } from '../lib/folder';

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your Navi profile')
  .addUserOption(o =>
    o.setName('user')
      .setDescription('View another user')
      .setRequired(false),
  );

function formatInventoryTop(userId: string, limit = 12) {
  const rows = listInventory(userId) || [];

  const pretty = rows
    .map((r: any) => {
      const rawId = String(r.chip_id);
      const available = getAvailableChipQty(userId, rawId);
      const chip: any = getChipById(rawId);
      return { chip, qty: available, rawId };
    })
    .filter(({ chip, qty }) => qty > 0 && chip && !chipIsUpgrade(chip))
    .map(({ chip, qty, rawId }) => `${formatChipName(chip || rawId)} ×${qty}`);

  if (!pretty.length) return '—';
  return pretty.slice(0, limit).join(' • ');
}

function formatStyleProgress(progress: any): string {
  const threshold = Number(progress?.threshold || STYLE_CHANGE_THRESHOLD || 250);
  return [
    `🔥 Fire: ${Number(progress?.fire_points || 0)}/${threshold}`,
    `💧 Aqua: ${Number(progress?.aqua_points || 0)}/${threshold}`,
    `⚡ Elec: ${Number(progress?.elec_points || 0)}/${threshold}`,
    `🌿 Wood: ${Number(progress?.wood_points || 0)}/${threshold}`,
  ].join('\n');
}

function styleEmoji(element: string): string {
  switch (String(element)) {
    case 'Fire': return '🔥';
    case 'Aqua': return '💧';
    case 'Elec': return '⚡';
    case 'Wood': return '🌿';
    default: return '🧬';
  }
}

function buildProfileEmbed(user: { id: string; username: string; displayAvatarURL: () => string }, notice?: string) {
  const p: any = getPlayer(user.id);
  const invLine = formatInventoryTop(user.id, 12);
  const progress = getStyleProgress(user.id);
  const pending = getPendingStyleElement(user.id);

  const desc = [
    notice ? `📌 **${notice}**` : '',
    pending ? `${styleEmoji(pending)} **${pending} Style Change Available**` : '',
  ].filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.username}.EXE`, iconURL: user.displayAvatarURL() })
    .setTitle('Navi Profile')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Current Style', value: String(p?.element ?? 'Neutral'), inline: true },
      { name: 'Level', value: String(p?.level ?? 1), inline: true },
      { name: 'HP', value: String(p?.hp_max ?? 100), inline: true },
      {
        name: 'Stats',
        value:
          `ATK ${p?.atk ?? 0} • DEF ${p?.def ?? 0} • SPD ${p?.spd ?? 0}\n` +
          `ACC ${p?.acc ?? 100}% • EVA ${p?.evasion ?? 0}% • CRIT ${p?.crit ?? 0}%`,
        inline: false,
      },
      { name: 'Style Progress', value: formatStyleProgress(progress), inline: false },
      { name: 'Zenny', value: String(p?.zenny ?? 0), inline: true },
      { name: 'Inventory Available', value: invLine, inline: false },
    );

  if (desc) embed.setDescription(desc);
  return embed;
}

function buildProfileComponents(userId: string, viewerId: string) {
  if (userId !== viewerId) return [];

  const p: any = getPlayer(userId);
  const currentStyle = normalizeStyleElement(p?.element);
  const pending = getPendingStyleElement(userId);
  const buttons: ButtonBuilder[] = [];

  if (pending) {
    buttons.push(
      new ButtonBuilder().setCustomId(`jackin:styleAccept:${pending}`).setStyle(ButtonStyle.Success).setLabel(`Accept ${pending} Style`),
      new ButtonBuilder().setCustomId(`jackin:styleDecline:${pending}`).setStyle(ButtonStyle.Secondary).setLabel('Keep Current Style'),
    );
  } else if (currentStyle) {
    buttons.push(
      new ButtonBuilder().setCustomId('profile:styleNeutralPrompt').setStyle(ButtonStyle.Danger).setLabel('Return to Neutral'),
    );
  }

  return buttons.length
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)]
    : [];
}

export async function execute(ix: ChatInputCommandInteraction) {
  const user = ix.options.getUser('user') ?? ix.user;
  const p: any = getPlayer(user.id);
  if (!p) {
    await ix.reply({ ephemeral: true, content: '❌ No profile. Run **/start** first.' });
    return;
  }

  await ix.reply({
    ephemeral: true,
    embeds: [buildProfileEmbed(user)],
    components: buildProfileComponents(user.id, ix.user.id),
  });
}

export async function onStyleNeutralPrompt(ix: ButtonInteraction) {
  const p: any = getPlayer(ix.user.id);
  const currentStyle = normalizeStyleElement(p?.element);

  if (!currentStyle) {
    await ix.update({
      embeds: [buildProfileEmbed(ix.user, 'Your Navi is already Neutral Style.')],
      components: buildProfileComponents(ix.user.id, ix.user.id),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Return to Neutral Style?')
    .setDescription([
      `Your Navi will discard **${currentStyle} Style** and return to **Neutral Style**.`,
      '',
      'This will reset all Style Change progress:',
      '🔥 Fire / 💧 Aqua / ⚡ Elec / 🌿 Wood will all return to 0.',
      '',
      'This cannot be undone.',
    ].join('\n'));

  await ix.update({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('profile:styleNeutralConfirm').setStyle(ButtonStyle.Danger).setLabel('Confirm Return to Neutral'),
      new ButtonBuilder().setCustomId('profile:styleNeutralCancel').setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
    )],
  });
}

export async function onStyleNeutralConfirm(ix: ButtonInteraction) {
  const res = resetStyleToNeutral(ix.user.id);
  await ix.update({
    embeds: [buildProfileEmbed(ix.user, `Style discarded. ${res.previous || 'Current'} Style was removed and all Style Change progress was reset.`)],
    components: buildProfileComponents(ix.user.id, ix.user.id),
  });
}

export async function onStyleNeutralCancel(ix: ButtonInteraction) {
  await ix.update({
    embeds: [buildProfileEmbed(ix.user)],
    components: buildProfileComponents(ix.user.id, ix.user.id),
  });
}
