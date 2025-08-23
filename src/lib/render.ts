import { EmbedBuilder } from 'discord.js';
import { getBundle } from './data';
import { BattleState } from './battle';

function bar(cur: number, max: number, width = 20) {
  const pct = Math.max(0, Math.min(1, cur / Math.max(1, max)));
  const full = Math.round(pct * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function battleEmbed(s: BattleState) {
  const v = getBundle().viruses[s.enemy_id] || getBundle().bosses?.[s.enemy_id];
  const vMax = v?.hp ?? 1;
  const pMax = s.player_hp_max;
  const phaseTxt = s.enemy_kind === 'boss' && s.phase_index ? ` • Phase ${s.phase_index}` : '';

  return new EmbedBuilder()
    .setTitle(`⚔️ ${v?.name || s.enemy_id} — Turn ${s.turn}${phaseTxt}`)
    .addFields(
      { name: 'You', value: `HP ${s.player_hp}/${pMax}\n\`${bar(s.player_hp, pMax)}\`\n${s.player_element}`, inline: false },
      { name: v?.name || 'Enemy', value: `HP ${s.enemy_hp}/${vMax}\n\`${bar(s.enemy_hp, vMax)}\`\n${v?.element ?? '?'}`, inline: false },
      { name: 'Your hand', value: s.hand.join(' • ') || '—', inline: false },
    )
    .setImage(v?.anim_url || v?.image_url || null)
    .setFooter({ text: s.id });
}

