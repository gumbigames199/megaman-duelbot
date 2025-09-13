// src/commands/shop.ts
import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder
} from 'discord.js';
import { getBundle } from '../lib/data';
import { getRegion, addZenny, grantChip } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('View or buy items in the current region shop')
  .addSubcommand(sc => sc
    .setName('list')
    .setDescription('Show what this region sells'))
  .addSubcommand(sc => sc
    .setName('buy')
    .setDescription('Buy a chip by id from this region shop')
    .addStringOption(o => o.setName('chip_id').setDescription('TSV chip id').setRequired(true)));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();
  const { regions, shops, chips } = getBundle();

  const regionId = (getRegion(ix.user.id)?.region_id) || (process.env.START_REGION_ID || 'green_area');
  const region = regions[regionId];
  const shopId = region?.shop_id || '';
  const shop = shopId ? shops[shopId] : undefined;

  if (!shop) {
    await ix.reply({ ephemeral: true, content: `🛒 No shop in ${region?.name ?? regionId}.` });
    return;
  }

  // entries: "chipId:price" comma-separated
  const entries = String(shop.entries || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(e => {
      const [id, priceStr] = e.split(':').map(x => x.trim());
      return { id, price: Math.max(0, Number(priceStr) || 0) };
    });

  if (sub === 'list') {
    const lines = entries.map(({ id, price }) => {
      const c = chips[id];
      return `• **${c?.name || id}** — ${price}z`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`🛒 ${region?.name || regionId} — Shop`)
      .setDescription(lines.length ? lines.join('\n') : '_Empty_');
    await ix.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'buy') {
    const wantId = ix.options.getString('chip_id', true);
    const entry = entries.find(e => e.id === wantId);
    if (!entry) {
      await ix.reply({ ephemeral: true, content: `❌ That item is not sold in this region.` });
      return;
    }
    const price = entry.price;

    // fetch player & zenny
    const p = require('../lib/db').getPlayer(ix.user.id);
    if (!p) { await ix.reply({ ephemeral: true, content: `❌ No profile. Use /start first.` }); return; }

    if ((p.zenny ?? 0) < price) {
      await ix.reply({ ephemeral: true, content: `❌ Not enough zenny. Need ${price}z.` });
      return;
    }

    addZenny(ix.user.id, -price);
    grantChip(ix.user.id, wantId, 1);

    const c = chips[wantId];
    await ix.reply({
      ephemeral: true,
      content: `✅ Purchased **${c?.name || wantId}** for **${price}z**.`
    });
  }
}
