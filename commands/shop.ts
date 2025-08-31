import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder
} from 'discord.js';
import { listShopStock, getChipById } from '../lib/data';
import { addZenny, grantChip, getPlayer, addHPMax, addATK } from '../lib/db';

const HP_COST   = Number(process.env.UPGRADE_HP_COST   || 1200);
const HP_DELTA  = Number(process.env.UPGRADE_HP_DELTA  || 20);
const ATK_COST  = Number(process.env.UPGRADE_ATK_COST  || 1500);
const ATK_DELTA = Number(process.env.UPGRADE_ATK_DELTA || 2);

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Browse & buy')
  .addSubcommand(s=>s.setName('list').setDescription('Show stock'))
  .addSubcommand(s=>s.setName('buy').setDescription('Buy an item')
    .addStringOption(o=>o.setName('id').setDescription('chip_id | hp_memory | powerup').setRequired(true))
    .addIntegerOption(o=>o.setName('qty').setDescription('Quantity').setMinValue(1)));

export async function execute(ix: ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();

  if (sub === 'list') {
    const stock = listShopStock().slice(0, 25);
    const chipLines = stock.map(c => `• **${c.id}** — ${c.name} — ${c.zenny_cost}z`).join('\n') || '—';
    const upgLines = [
      `• **hp_memory** — +${HP_DELTA} HP — ${HP_COST}z`,
      `• **powerup** — +${ATK_DELTA} ATK — ${ATK_COST}z`,
    ].join('\n');
    const e = new EmbedBuilder()
      .setTitle('🛒 Shop')
      .addFields(
        { name: 'Chips', value: chipLines },
        { name: 'Upgrades', value: upgLines },
      );
    await ix.reply({ ephemeral:true, embeds:[e] });
    return;
  }

  if (sub === 'buy') {
    const id = ix.options.getString('id', true).trim().toLowerCase();
    const qty = ix.options.getInteger('qty', false) ?? 1;
    const p = getPlayer(ix.user.id);
    if (!p) { await ix.reply({ ephemeral:true, content:'❌ No profile. Use /start.' }); return; }

    // Upgrades
    if (id === 'hp_memory' || id === 'powerup') {
      const cost = (id === 'hp_memory' ? HP_COST : ATK_COST) * qty;
      if (p.zenny < cost) { await ix.reply({ ephemeral:true, content:`❌ Need ${cost}z, you have ${p.zenny}z.` }); return; }
      addZenny(ix.user.id, -cost);
      if (id === 'hp_memory') addHPMax(ix.user.id, HP_DELTA * qty);
      else addATK(ix.user.id, ATK_DELTA * qty);
      await ix.reply({ ephemeral:true, content:`✅ Bought ${id} ×${qty} for ${cost}z.` });
      return;
    }

    // Chips
    const chip = getChipById(id);
    if (!chip || chip.stock !== 1 || (chip.zenny_cost|0) <= 0) {
      await ix.reply({ ephemeral:true, content:'❌ Not purchasable.' }); return;
    }
    const total = chip.zenny_cost * qty;
    if (p.zenny < total) { await ix.reply({ ephemeral:true, content:`❌ Need ${total}z, you have ${p.zenny}z.` }); return; }

    addZenny(ix.user.id, -total);
    grantChip(ix.user.id, id, qty);
    await ix.reply({ ephemeral:true, content:`✅ Bought ${id} ×${qty} for ${total}z.` });
  }
}
