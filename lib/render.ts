// src/lib/render.ts
import { EmbedBuilder } from 'discord.js';
import { getBundle } from './data';
import type { BattleState } from './battle';

export function battleEmbed(
  s: BattleState,
  opts?: { playerName?: string; playerAvatar?: string; regionId?: string }
) {
  const b = getBundle();
  const enemy = s.enemy_kind === 'boss' ? (b as any).bosses[s.enemy_id] : b.viruses[s.enemy_id];
  const regionBg = opts?.regionId ? b.regions[opts.regionId]?.background_url : undefined;

  const title = s.enemy_kind === 'boss' ? `👑 ${enemy?.name || s.enemy_id}` : `⚔️ ${enemy?.name || s.enemy_id}`;
  const e = new EmbedBuilder()
    .setTitle(`${title}  —  VS  —  ${opts?.playerName || 'You'}`)
    .setDescription(
      [
        `**Your HP:** ${s.player_hp}/${s.player_hp_max}`,
        `**Enemy HP:** ${s.enemy_hp}/${enemy?.hp ?? '?'}`,
      ].join('\n')
    )
    .setFooter({ text: `Battle ${s.id} • Turn ${s.turn}` });

  if (regionBg) e.setImage(regionBg);
  if (opts?.playerAvatar) e.setThumbnail(opts.playerAvatar);
  else if (enemy?.image_url) e.setThumbnail(enemy.image_url);

  // If enemy has an anim/big image, prefer that above the background
  if (enemy?.anim_url && !regionBg) e.setImage(enemy.anim_url);

  return e;
}
