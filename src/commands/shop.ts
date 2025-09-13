// commands/shop.ts
// Region shop UI & purchase flow.
// - Prices from data.resolveShopInventory() → price_override ?? chip.zenny_cost
// - Upgrades (is_upgrade=1) apply instantly via db.applyStatDeltas(), not added to inventory
// - Chips (is_upgrade=0) are granted to inventory via db.grantChip()
// - Clean dropdown → Buy/Exit flow with customId routing
//
// NOTE: We'll integrate this view into Jack-in later by calling renderShopView() from jack_in.ts.

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';

import {
  ensurePlayer,
  getPlayer,
  spendZenny,
  grantChip,
  applyStatDeltas,
  type Player,
} from '../lib/db';

import {
  getRegionById,
  resolveShopInventory,
  priceForShopItem,
  type ResolvedShopItem,
  getChipById,
} from '../lib/data';

// -------------------------------
// Command definition
// -------------------------------

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Browse and buy from the current region’s Net Shop');

// Entry point used by index.ts
export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const p = ensurePlayer(userId);
  const regionId = p.region_id ?? defaultRegionId();
  const message = buildShopMessage(userId, regionId, null);

  await interaction.reply({
    embeds: [message.embed],
    components: message.components,
    ephemeral: true,
  });
}

// -------------------------------
// Custom ID protocol & routers
// -------------------------------
//
// shop:open:<regionId>         (optional external entry)
// shop:select                  (string select customId)
// shop:buy:<regionId>:<chipId> (finalize purchase for selection)
// shop:exit                    (return to caller — jack-in will override later)

const CID = {
  OPEN: 'shop:open',
  SELECT: 'shop:select',
  BUY: 'shop:buy',
  EXIT: 'shop:exit',
};

export async function handleShopButton(ix: ButtonInteraction) {
  const { customId } = ix;
  if (customId === CID.EXIT) {
    await ix.update({
      content: 'Exited the shop.',
      components: [],
      embeds: [],
    });
    return;
  }

  if (customId.startsWith(`${CID.BUY}:`)) {
    // BUY format: shop:buy:<regionId>:<chipId>
    const parts = customId.split(':'); // ["shop","buy",regionId,chipId]
    const regionId = parts[2];
    const chipId = parts[3];

    await handleBuy(ix, regionId, chipId);
    return;
  }

  if (customId.startsWith(`${CID.OPEN}:`)) {
    const regionId = customId.split(':')[2];
    const message = buildShopMessage(ix.user.id, regionId, null);
    await ix.update({
      embeds: [message.embed],
      components: message.components,
    });
    return;
  }
}

export async function handleShopSelect(ix: StringSelectMenuInteraction) {
  if (ix.customId !== CID.SELECT) return;

  const userId = ix.user.id;
  const p = ensurePlayer(userId);
  const regionId = p.region_id ?? defaultRegionId();

  const selectedChipId = ix.values?.[0] ?? null;
  const message = buildShopMessage(userId, regionId, selectedChipId);

  await ix.update({
    embeds: [message.embed],
    components: message.components,
  });
}

// -------------------------------
// Render
// -------------------------------

function buildShopMessage(
  userId: string,
  regionId: string,
  selectedChipId: string | null
): { embed: EmbedBuilder; components: any[] } {
  const p = getPlayer(userId)!;
  const regionLabel = getRegionById(regionId)?.label ?? regionId;

  const items = resolveShopInventory(regionId);
  const options = items.map((it) => ({
    label: truncate(`${it.name}`, 75),
    description: truncate(`Price: ${it.zenny_price}z${it.is_upgrade ? ' • Upgrade' : ''}`, 100),
    value: it.item_id,
  }));

  // Ensure selected exists
  let selected = selectedChipId
    ? items.find((x) => x.item_id === selectedChipId) ?? null
    : (items[0] ?? null);

  // Embed
  const embed = new EmbedBuilder()
    .setTitle('🛒 Net Shop')
    .setDescription(
      [
        `**Region:** ${inlineCode(regionLabel)}`,
        `**Your Zenny:** ${inlineCode(String(p.zenny))}`,
        '',
        items.length
          ? 'Select an item from the dropdown, then press **Buy**.'
          : 'No items are available in this region.',
      ].join('\n')
    );

  if (selected) {
    const chip = selected.chip;
    const details: string[] = [];
    if ((chip as any).element) details.push(`Element: ${inlineCode(String((chip as any).element))}`);
    if ((chip as any).power) details.push(`Power: ${inlineCode(String((chip as any).power))}`);
    if ((chip as any).hits) details.push(`Hits: ${inlineCode(String((chip as any).hits))}`);
    if ((chip as any).effects) details.push(`Effects: ${inlineCode(String((chip as any).effects))}`);
    if ((chip as any).description) details.push(String((chip as any).description));

    embed.addFields(
      {
        name: `${selected.name} ${selected.is_upgrade ? '• Upgrade' : ''}`,
        value:
          [
            `Price: ${inlineCode(`${selected.zenny_price}z`)}`,
            details.length ? details.join(' • ') : '—',
          ].join('\n'),
      }
    );
  }

  // Components
  const rowSelect =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CID.SELECT)
        .setPlaceholder('Choose an item...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options)
    );

  const buyCustomId = selected ? `${CID.BUY}:${regionId}:${selected.item_id}` : `${CID.BUY}:${regionId}:_`;
  const rowButtons =
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buyCustomId)
        .setStyle(ButtonStyle.Primary)
        .setLabel(selected ? `Buy (${selected.zenny_price}z)` : 'Buy')
        .setDisabled(!selected || items.length === 0),
      new ButtonBuilder()
        .setCustomId(CID.EXIT)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Exit')
    );

  return { embed, components: [rowSelect, rowButtons] };
}

// -------------------------------
// Purchases
// -------------------------------

async function handleBuy(ix: ButtonInteraction, regionId: string, chipId: string | undefined) {
  const userId = ix.user.id;
  const p = ensurePlayer(userId);

  const inv = resolveShopInventory(regionId);
  const item = inv.find((x) => x.item_id === chipId);
  if (!item) {
    await ix.reply({ content: '⚠️ That item is no longer available.', ephemeral: true });
    return;
  }

  // Check funds
  const price = priceForShopItem(item.shop_row, item.chip);
  const spend = spendZenny(userId, price);
  if (!spend.ok) {
    await ix.reply({ content: `❌ Not enough zenny. You need ${price}z.`, ephemeral: true });
    return;
  }

  // Apply purchase
  let resultText = '';
  if (item.is_upgrade) {
    const applied = applyUpgradeChip(userId, chipId!);
    if (!applied.ok) {
      // Refund if upgrade failed to parse/apply
      // (rare; protects against malformed TSV)
      spendZenny(userId, -price);
      await ix.reply({ content: `⚠️ Could not apply upgrade. Purchase canceled & refunded.`, ephemeral: true });
      return;
    }
    resultText = `✅ Applied upgrade **${item.name}**.`;
  } else {
    grantChip(userId, item.item_id, 1);
    resultText = `✅ Purchased **${item.name}** and added to your inventory.`;
  }

  // Re-render shop with fresh balance & keep same selection
  const message = buildShopMessage(userId, regionId, chipId ?? null);
  await ix.update({
    embeds: [message.embed],
    components: message.components,
  });

  await ix.followUp({
    content: `${resultText}  New balance: ${spend.balance}z`,
    ephemeral: true,
  });
}

// -------------------------------
// Upgrade application
// -------------------------------
//
// We parse effects strings for simple upgrade semantics like:
//   "Atk+20", "Def+10", "Spd+1", "Acc+5", "Eva+5", "HP+50"
//   "Atkx2" (multiply current attack by 2, clamped to cap)
// Multiple can be pipe- or comma-separated e.g. "Atk+20, Def+10"
// Unknown tokens are ignored (no crash).

function applyUpgradeChip(userId: string, chipId: string): { ok: boolean } {
  const chip = getChipById(chipId);
  if (!chip) return { ok: false };
  const eff = String((chip as any).effects ?? '').trim();
  if (!eff) {
    // No explicit effects still OK (some upgrades could be passive unlocks later)
    return { ok: true };
  }

  const tokens = eff.split(/[,\|]/).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: true };

  // We need the current player values to compute multipliers
  const p = getPlayer(userId)!;

  let delta = { hp_max: 0, atk: 0, def: 0, spd: 0, acc: 0, evasion: 0, crit: 0 };

  for (const t of tokens) {
    // +N patterns
    const plus = t.match(/^([A-Za-z]+)\s*\+\s*(-?\d+)$/i);
    if (plus) {
      const stat = normalizeStatKey(plus[1]);
      const amount = parseInt(plus[2], 10) || 0;
      if (!stat) continue;

      if (stat === 'hp' || stat === 'hp_max') delta.hp_max += amount;
      else if (stat === 'atk') delta.atk += amount;
      else if (stat === 'def') delta.def += amount;
      else if (stat === 'spd') delta.spd += amount;
      else if (stat === 'acc') delta.acc += amount;
      else if (stat === 'eva' || stat === 'evasion') delta.evasion += amount;
      else if (stat === 'crit') delta.crit += amount;
      continue;
    }

    // xN patterns (multipliers)
    const mult = t.match(/^([A-Za-z]+)\s*x\s*(\d+(?:\.\d+)?)$/i);
    if (mult) {
      const stat = normalizeStatKey(mult[1]);
      const factor = Number(mult[2]);
      if (!stat || !Number.isFinite(factor) || factor <= 0) continue;

      if (stat === 'atk') {
        delta.atk += Math.round(p.atk * (factor - 1));
      } else if (stat === 'def') {
        delta.def += Math.round(p.def * (factor - 1));
      } else if (stat === 'spd') {
        delta.spd += Math.round(p.spd * (factor - 1));
      } else if (stat === 'acc') {
        delta.acc += Math.round(p.acc * (factor - 1));
      } else if (stat === 'eva' || stat === 'evasion') {
        delta.evasion += Math.round(p.evasion * (factor - 1));
      } else if (stat === 'crit') {
        delta.crit += Math.round(p.crit * (factor - 1));
      } else if (stat === 'hp' || stat === 'hp_max') {
        delta.hp_max += Math.round(p.hp_max * (factor - 1));
      }
      continue;
    }

    // Unknown token → ignore
  }

  applyStatDeltas(userId, delta);
  return { ok: true };
}

function normalizeStatKey(k: string): string | null {
  const s = k.trim().toLowerCase();
  if (s === 'hp' || s === 'hpmax' || s === 'hp_max' || s === 'health') return 'hp_max';
  if (s === 'atk' || s === 'attack') return 'atk';
  if (s === 'def' || s === 'defense') return 'def';
  if (s === 'spd' || s === 'speed') return 'spd';
  if (s === 'acc' || s === 'accuracy') return 'acc';
  if (s === 'eva' || s === 'evasion' || s === 'dodge') return 'evasion';
  if (s === 'crit' || s === 'critical') return 'crit';
  return null;
}

// -------------------------------
// Utilities
// -------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function defaultRegionId(): string {
  // Fallback if the player has no region; you may wire this to START_REGION_ID
  return process.env.START_REGION_ID || 'den_city';
}
