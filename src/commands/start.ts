// src/commands/start.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';

import { ensureStartUnlocked } from '../lib/unlock';
import { getBundle } from '../lib/data';
import {
  ensurePlayer,
  getPlayer,
  listInventory,
  grantChip,
} from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('Create your Navi and grant starter rewards (once).');

export async function execute(ix: ChatInputCommandInteraction) {
  const userId = ix.user.id;

  // Ensure player exists
  const before = getPlayer(userId);
  const createdNow = !before;
  ensurePlayer(userId);
  const p = getPlayer(userId)!;

  // Starter chips — only try to grant on very first run if inventory is empty
  const invBefore = listInventory(userId);
  let granted = 0;
  let unknown: string[] = [];

  if (createdNow && invBefore.length === 0) {
    const tokens = parseStarterChips(process.env.STARTER_CHIPS || '');
    if (tokens.length) {
      const { chips } = getBundle();
      const nameToId = buildNameToIdIndex();
      for (const t of tokens) {
        const id = resolveChipToken(t, chips, nameToId);
        if (id) {
          grantChip(userId, id, 1);
          granted += 1;
        } else {
          unknown.push(t);
        }
      }
    }
  }

  // Make sure region unlocking baseline exists
  await ensureStartUnlocked(userId);

  const emb = new EmbedBuilder()
    .setTitle(`${ix.user.username}.EXE`)
    .setDescription(
      [
        `Navi Ready!`,
        '',
        `**Element:** ${p.element ?? 'Neutral'}`,
        `**Level:** ${p.level}   **HP:** ${p.hp_max}`,
        `**Starter Zenny:** ${createdNow ? p.zenny : '(unchanged)'}`,
        granted ? `**Starter Chips:** +${granted}` : '',
        unknown.length ? `Unknown tokens skipped: ${unknown.join(', ')}` : '',
      ].filter(Boolean).join('\n')
    );

  await ix.reply({ ephemeral: true, embeds: [emb] });
}

/* ---------------- helpers ---------------- */

function parseStarterChips(text: string): string[] {
  return String(text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Build a case-insensitive name index for chips. */
function buildNameToIdIndex(): Map<string, string> {
  const { chips } = getBundle();
  const map = new Map<string, string>();
  for (const id of Object.keys(chips)) {
    const c: any = chips[id] || {};
    if (c.name) map.set(String(c.name).toLowerCase(), id);
  }
  return map;
}

/**
 * Resolve an input token to a chip id.
 * Order:
 *  1) exact id match (as-is)
 *  2) id match lowercased
 *  3) name match (case-insensitive)
 */
function resolveChipToken(
  token: string,
  chips: Record<string, any>,
  nameToId: Map<string, string>
): string | null {
  if (!token) return null;

  // exact id
  if (chips[token]) return token;

  // lowercased id
  const low = token.toLowerCase();
  const idLow = Object.prototype.hasOwnProperty.call(chips, low) ? low : null;
  if (idLow) return idLow;

  // name match
  const byName = nameToId.get(low);
  if (byName && chips[byName]) return byName;

  return null;
}
