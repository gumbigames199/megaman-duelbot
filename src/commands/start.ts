// src/commands/start.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';

import { ensureStartUnlocked } from '../lib/unlock';
import { resolveChipForGrant } from '../lib/data';
import {
  ensurePlayer,
  getPlayer,
  listInventory,
  grantChip,
  setNameAndElement,
} from '../lib/db';
import { tryAddToFolder } from '../lib/folder';

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('Create your Navi and grant starter rewards (once).');

export async function execute(ix: ChatInputCommandInteraction) {
  const userId = ix.user.id;

  const before = getPlayer(userId);
  const createdNow = !before;
  ensurePlayer(userId);

  const current = getPlayer(userId)!;
  setNameAndElement(userId, ix.user.username, current.element ?? null);

  const invBefore = listInventory(userId);
  let granted = 0;
  let folderAdded = 0;
  const unknown: string[] = [];

  if (createdNow && invBefore.length === 0) {
    const starterText = (process.env.STARTER_CHIPS || '').trim() || 'Cannon,Cannon,Cannon,Cannon';
    const tokens = parseStarterChips(starterText);
    if (tokens.length) {
      for (const t of tokens) {
        const id = resolveChipForGrant(t);
        if (id) {
          grantChip(userId, id, 1);
          granted += 1;
          const add = tryAddToFolder(userId, id, 1);
          if (add.ok) folderAdded += add.added;
        } else {
          unknown.push(t);
        }
      }
    }
  }

  await ensureStartUnlocked(userId);
  const p = getPlayer(userId)!;

  const emb = new EmbedBuilder()
    .setTitle(`${ix.user.username}.EXE`)
    .setDescription(
      [
        'Navi Ready!',
        '',
        `**Element:** ${p.element ?? 'Neutral'}`,
        `**Level:** ${p.level}   **HP:** ${p.hp_max}`,
        `**Starter Zenny:** ${createdNow ? p.zenny : '(unchanged)'}`,
        granted ? `**Starter Chips:** +${granted}` : '',
        folderAdded ? `**Added to Folder:** +${folderAdded}` : '',
        unknown.length ? `Unknown tokens skipped: ${unknown.join(', ')}` : '',
      ].filter(Boolean).join('\n')
    );

  await ix.reply({ ephemeral: true, embeds: [emb] });
}

function parseStarterChips(text: string): string[] {
  return String(text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
