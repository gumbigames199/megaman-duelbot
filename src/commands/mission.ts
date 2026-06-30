import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getBundle } from '../lib/data';
import { listMissionsFor, acceptMission, turnInMission } from '../lib/missions';

export const data = new SlashCommandBuilder()
  .setName('mission')
  .setDescription('Missions: list, accept, turn_in')
  .addSubcommand(s => s.setName('list').setDescription('Show missions'))
  .addSubcommand(s => s.setName('accept').setDescription('Accept a mission')
    .addStringOption(o => o.setName('id').setDescription('mission_id').setRequired(true)))
  .addSubcommand(s => s.setName('turn_in').setDescription('Turn in a completed mission')
    .addStringOption(o => o.setName('id').setDescription('mission_id').setRequired(true)));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();

  if (sub === 'list') {
    const all = getBundle().missions;
    const rows = listMissionsFor(ix.user.id);
    const lines = rows.slice(0, 25).map(r => {
      const m = all[r.mission_id];
      const need = needCount(m?.requirement);
      const counter = Math.max(0, Number((r as any).progress ?? r.counter ?? 0));
      return `**${r.mission_id}** — ${m?.name || '?'} — ${r.state} (${counter}/${need})`;
    }).join('\n') || '—';
    const e = new EmbedBuilder()
      .setTitle('📜 Missions')
      .setDescription(lines)
      .setFooter({ text: 'Defeat missions now progress only after /mission accept.' });
    await ix.reply({ ephemeral: true, embeds: [e] });
    return;
  }

  if (sub === 'accept') {
    const id = ix.options.getString('id', true).trim();
    const msg = acceptMission(ix.user.id, id);
    await ix.reply({ ephemeral: true, content: msg });
    return;
  }

  if (sub === 'turn_in') {
    const id = ix.options.getString('id', true).trim();
    const res = turnInMission(ix.user.id, id);
    const rewardText = res.ok
      ? ` +${res.rewardZ}z${res.rewardChips.length ? ` • chips: ${res.rewardChips.join(', ')}` : ''}`
      : '';
    await ix.reply({ ephemeral: !res.ok, content: `${res.msg}${rewardText}` });
  }
}

function needCount(requirement: any): number {
  const [, raw] = String(requirement || '').split(':');
  const n = Number(raw || 1);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}
