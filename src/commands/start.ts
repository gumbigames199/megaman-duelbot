import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ensurePlayer, setNameAndElement, addZenny, grantChip } from '../lib/db';
import { getBundle } from '../lib/data';
import { ensureStartUnlocked } from '../lib/unlock';

function parseStarters(raw: string): Array<{ id: string; qty: number }> {
  // format: "heatshot:2,sword:1" or "heatshot, sword"
  return String(raw || '')
    .split(/[,\n]+/)
    .map(tok => {
      const m = tok.trim().match(/^([\w\-]+)(?::(\d+))?$/i);
      if (!m) return null;
      return { id: m[1], qty: Math.max(1, parseInt(m[2] || '1', 10)) };
    })
    .filter(Boolean) as any;
}

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('Create your Navi (name + element)')
  .addStringOption(o =>
    o.setName('name').setDescription('Navi name').setRequired(true).setMaxLength(24)
  )
  .addStringOption(o =>
    o
      .setName('element')
      .setDescription('Choose an element')
      .setRequired(true)
      .addChoices(
        { name: 'Fire', value: 'Fire' },
        { name: 'Wood', value: 'Wood' },
        { name: 'Elec', value: 'Elec' },
        { name: 'Aqua', value: 'Aqua' },
        { name: 'Neutral', value: 'Neutral' },
      )
  );

export async function execute(ix: ChatInputCommandInteraction) {
  const name = ix.options.getString('name', true).trim();
  const element = ix.options.getString('element', true);

  const was = ensurePlayer(ix.user.id, name, element);
  if (was && (was.name !== name || was.element !== element)) {
    setNameAndElement(ix.user.id, name, element);
  }

  // Ensure start region is unlocked & selected
  ensureStartUnlocked(ix.user.id);

  // Starter zenny (only if first-time)
  const starterZ = Math.max(0, parseInt(process.env.STARTER_ZENNY || '0', 10));
  if (starterZ > 0 && (was?.zenny ?? 0) === 0) addZenny(ix.user.id, starterZ);

  // Starter chips by TSV id (env: STARTER_CHIPS="heatshot:2,sword")
  const starters = parseStarters(process.env.STARTER_CHIPS || '');
  if (starters.length) {
    const ids = new Set(Object.keys(getBundle().chips));
    for (const s of starters) if (ids.has(s.id)) grantChip(ix.user.id, s.id, s.qty);
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${ix.user.username}.EXE`, iconURL: ix.user.displayAvatarURL() })
    .setTitle('✅ Navi Ready!')
    .setDescription(`**${name}** created.\nElement: **${element}**\nStarter Zenny: **${starterZ}**`);

  await ix.reply({
    ephemeral: true,
    embeds: [embed],
  });
}
