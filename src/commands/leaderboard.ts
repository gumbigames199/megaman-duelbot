import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { db } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show top players')
  .addStringOption(o => o.setName('type').setDescription('zenny').addChoices({ name: 'zenny', value: 'zenny' }));

export async function execute(ix: ChatInputCommandInteraction) {
  const rows = db.prepare(`
    SELECT user_id, COALESCE(NULLIF(name, ''), user_id) AS name, zenny
    FROM players
    ORDER BY zenny DESC
    LIMIT 10
  `).all() as Array<{ user_id: string; name: string; zenny: number }>;

  const lines = rows.map((r, i) => `**${i + 1}.** ${r.name || r.user_id} — ${r.zenny}z`).join('\n') || '—';
  const e = new EmbedBuilder().setTitle('🏆 Leaderboard — Zenny').setDescription(lines);
  await ix.reply({ embeds: [e], ephemeral: false });
}
