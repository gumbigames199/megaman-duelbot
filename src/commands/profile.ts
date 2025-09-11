// profile.ts
// Slash command: /profile
// - Shows live stats (including upgrades applied instantly via db.ts)
// - Displays XP progress as current/next (e.g., 100/1000)
// - Shows Zenny, Level, Region, and core combat stats
// - Provides a reusable renderProfileEmbed() for other modules

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';
import {
  ensurePlayer,
  getPlayer,
  getRegion as dbGetRegion,
  getXPProgress,
  type Player,
} from '../lib/db'; // adjust relative path if needed in your project
import { getRegionById } from '../lib/data'; // region label lookup

// -------------------------------
// Command definition & handler
// -------------------------------

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your Net Battler profile');

// Main entry for index.ts to call
export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;

  // Ensure the player exists, then fetch fresh data
  ensurePlayer(userId);
  const p = getPlayer(userId)!;

  const embed = renderProfileEmbed(userId, p);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// -------------------------------
// Rendering
// -------------------------------

export function renderProfileEmbed(userId: string, p?: Player): EmbedBuilder {
  const player = p ?? getPlayer(userId)!;
  const xp = getXPProgress(userId);

  // Region label
  const regionId = player.region_id ?? null;
  const regionLabel = regionId ? (getRegionById(regionId)?.label ?? regionId) : '—';

  // XP display
  const xpLine = `${xp.xp_total}/${xp.next_threshold}`;

  // Build a clean, compact profile embed
  const embed = new EmbedBuilder()
    .setTitle('📇 Net Battler — Profile')
    .setDescription(
      [
        `**User:** <@${userId}>`,
        `**Region:** ${inlineCode(regionLabel)}`,
        `**Level:** ${inlineCode(String(xp.level))}`,
        `**XP:** ${inlineCode(xpLine)}`,
        `**Zenny:** ${inlineCode(String(player.zenny))}`,
        '',
        `**Stats**`,
        `HP Max: ${inlineCode(String(player.hp_max))}`,
        `ATK: ${inlineCode(String(player.atk))}   DEF: ${inlineCode(String(player.def))}`,
        `SPD: ${inlineCode(String(player.spd))}   ACC: ${inlineCode(String(player.acc))}`,
        `EVA: ${inlineCode(String(player.evasion))}   CRIT: ${inlineCode(String(player.crit))}`,
      ].join('\n')
    )
    .setFooter({ text: 'Use /travel to move regions, /jack-in to explore, or /folder to manage battle chips.' });

  return embed;
}
