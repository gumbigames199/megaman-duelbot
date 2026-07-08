import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { db } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show the top NetOps by level, boss progress, and zenny');

type LeaderboardRow = {
  user_id: string;
  name: string | null;
  level: number;
  boss_defeats: number;
  zenny: number;
};

function displayName(row: LeaderboardRow): string {
  const savedName = String(row.name ?? '').trim();
  if (savedName) return savedName;
  return `<@${row.user_id}>`;
}

export async function execute(ix: ChatInputCommandInteraction) {
  const rows = db.prepare(`
    SELECT
      p.user_id,
      NULLIF(TRIM(COALESCE(p.name, '')), '') AS name,
      COALESCE(p.level, 1) AS level,
      COALESCE(COUNT(dbv.id), 0) AS boss_defeats,
      COALESCE(p.zenny, 0) AS zenny
    FROM players p
    LEFT JOIN defeated_boss_versions dbv
      ON dbv.user_id = p.user_id
    GROUP BY p.user_id
    ORDER BY
      COALESCE(p.level, 1) DESC,
      boss_defeats DESC,
      COALESCE(p.zenny, 0) DESC,
      LOWER(COALESCE(NULLIF(TRIM(p.name), ''), p.user_id)) ASC
    LIMIT 10
  `).all() as LeaderboardRow[];

  const lines = rows.map((r, i) => {
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    return `${rank} ${displayName(r)} — Lv **${r.level}** • Bosses **${r.boss_defeats}** • ${r.zenny}z`;
  }).join('\n') || '—';

  const embed = new EmbedBuilder()
    .setTitle('🏆 NetOp Leaderboard')
    .setDescription(lines)
    .setFooter({ text: 'Ranked by Level → Bosses Defeated → Zenny tiebreaker' });

  await ix.reply({ embeds: [embed], ephemeral: false, allowedMentions: { parse: [] } });
}
