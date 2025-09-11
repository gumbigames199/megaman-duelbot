// jack_in.ts
// Jack-in hub with Encounter / Travel / Shop buttons.
// - Uses render.renderJackInHub() for the hub
// - Encounter: chooseEncounterForPlayer() → startBattle()
// - Shop: inline region-scoped shop view (dropdown + Buy/Exit)
// - Travel: prompts user to run /travel (keeps this module decoupled)

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  EmbedBuilder,
  inlineCode,
} from 'discord.js';

import { ensurePlayer, getPlayer } from '../lib/db';
import { getRegionById, resolveShopInventory, priceForShopItem, getChipById } from '../lib/data';
import { renderJackInHub, HUB_IDS } from '../lib/render';
import { chooseEncounterForPlayer } from '../lib/encounter';
import { startBattle, handlePick as battleHandlePick, handleLock as battleHandleLock, handleRun as battleHandleRun } from '../lib/battle';

// Reuse the shop handlers/model so ID contracts stay consistent.
import { handleShopButton as shopHandleButton, handleShopSelect as shopHandleSelect } from '../commands/shop';

// -------------------------------
// Slash command
// -------------------------------

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Jack into the network and choose your next action');

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const p = ensurePlayer(userId);
  const regionId = p.region_id ?? (process.env.START_REGION_ID || 'den_city');
  const regionLabel = getRegionById(regionId)?.label ?? regionId;

  const hub = renderJackInHub(regionLabel);
  await interaction.reply({
    embeds: [hub.embed],
    components: hub.components,
    ephemeral: true,
  });
}

// -------------------------------
// Button router for hub actions
// -------------------------------

export async function handleHubButton(ix: ButtonInteraction) {
  const id = ix.customId;

  // ENCOUNTER → pick virus & launch battle
  if (id === HUB_IDS.ENCOUNTER) {
    try {
      const pick = await chooseEncounterForPlayer(ix.user.id);
      const view = startBattle(ix.user.id, pick.virus_id);
      await ix.update({ embeds: [view.embed], components: view.components });
    } catch (e) {
      // Stay silent to user; render hub again if something odd happened.
      const p = getPlayer(ix.user.id)!;
      const regionLabel = p.region_id ? (getRegionById(p.region_id)?.label ?? p.region_id) : '—';
      const hub = renderJackInHub(regionLabel);
      await ix.update({ embeds: [hub.embed], components: hub.components });
    }
    return;
  }

  // TRAVEL → suggest running /travel
  if (id === HUB_IDS.TRAVEL) {
    await ix.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('🧭 Travel')
          .setDescription('Use the `/travel` command to move to a new region.')
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(HUB_IDS.ENCOUNTER).setStyle(ButtonStyle.Primary).setLabel('Encounter'),
          new ButtonBuilder().setCustomId(HUB_IDS.SHOP).setStyle(ButtonStyle.Secondary).setLabel('Shop'),
        )
      ],
    });
    return;
  }

  // SHOP → open region shop view directly (no extra click)
  if (id === HUB_IDS.SHOP) {
    const p = getPlayer(ix.user.id)!;
    const regionId = p.region_id ?? (process.env.START_REGION_ID || 'den_city');
    const message = buildInlineShopMessage(ix.user.id, regionId, null);
    await ix.update({ embeds: [message.embed], components: message.components });
    return;
  }

  // Pass-through for the battle and shop custom IDs (useful if index.ts routes everything here)
  if (id.startsWith('lock:')) return battleHandleLock(ix);
  if (id.startsWith('run:')) return battleHandleRun(ix);
  if (id.startsWith('shop:')) return shopHandleButton(ix);
}

// If your index.ts routes select menus here too:
export async function handleSelect(ix: StringSelectMenuInteraction) {
  if (ix.customId.startsWith('pick:')) return battleHandlePick(ix);
  if (ix.customId === 'shop:select') return shopHandleSelect(ix);
}

// -------------------------------
// Inline Shop View (same UX as /shop, but opened from Jack-in)
// -------------------------------

function buildInlineShopMessage(
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

  let selected = selectedChipId
    ? items.find((x) => x.item_id === selectedChipId) ?? null
    : (items[0] ?? null);

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

    embed.addFields({
      name: `${selected.name} ${selected.is_upgrade ? '• Upgrade' : ''}`,
      value: [
        `Price: ${inlineCode(`${selected.zenny_price}z`)}`,
        details.length ? details.join(' • ') : '—',
      ].join('\n'),
    });
  }

  const rowSelect =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('shop:select')
        .setPlaceholder('Choose an item...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options)
    );

  // Reuse the purchase and exit IDs from commands/shop.ts:
  const buyCustomId = selected ? `shop:buy:${regionId}:${selected.item_id}` : `shop:buy:${regionId}:_`;
  const rowButtons =
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buyCustomId)
        .setStyle(ButtonStyle.Primary)
        .setLabel(selected ? `Buy (${selected.zenny_price}z)` : 'Buy')
        .setDisabled(!selected || items.length === 0),
      new ButtonBuilder()
        .setCustomId('shop:exit')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Exit')
    );

  return { embed, components: [rowSelect, rowButtons] };
}

// -------------------------------
// Small helpers
// -------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
