import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getSettings, setSetting } from '../lib/db';
export function wantDmg(userId: string) {
  const s = getSettings(userId);
  return !!s.dmg_numbers;
}

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Personal toggles')
  .addSubcommand(s=>s.setName('view').setDescription('Show your settings'))
  .addSubcommand(s=>s.setName('set').setDescription('Set a flag')
    .addStringOption(o=>o.setName('key').setDescription('dm_turns | fast_text | dmg_numbers').setRequired(true))
    .addStringOption(o=>o.setName('value').setDescription('on|off').setRequired(true)));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();

  if (sub === 'view') {
    const s = getSettings(ix.user.id);
    const e = new EmbedBuilder()
      .setTitle('⚙️ Settings')
      .setDescription([
        `dm_turns: ${s.dm_turns ? 'on' : 'off'}`,
        `fast_text: ${s.fast_text ? 'on' : 'off'}`,
        `dmg_numbers: ${s.dmg_numbers ? 'on' : 'off'}`
      ].join('\n'));
    await ix.reply({ ephemeral:true, embeds:[e] });
    return;
  }

  if (sub === 'set') {
    const key = ix.options.getString('key', true);
    const val = ix.options.getString('value', true).toLowerCase();
    const allow = new Set(['dm_turns','fast_text','dmg_numbers']);
    if (!allow.has(key)) { await ix.reply({ ephemeral:true, content:'❌ Unknown key.' }); return; }
    if (!['on','off'].includes(val)) { await ix.reply({ ephemeral:true, content:'❌ Value must be on|off.' }); return; }
    setSetting(ix.user.id, key, val === 'on');
    await ix.reply({ ephemeral:true, content:`✅ ${key} → ${val}` });
  }
}
