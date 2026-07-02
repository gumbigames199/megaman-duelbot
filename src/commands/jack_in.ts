// src/commands/jack_in.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
} from 'discord.js';

import { ensureStartUnlocked, listUnlocked } from '../lib/unlock';
import { getBundle, resolveShopInventory, listVirusesForRegionZone, formatChipName } from '../lib/data';
import {
  getPlayer, setRegion, setZone, getZone,
  addZenny, spendZenny, grantChip,
  addHPMax, addATK, addDEF, addSPD, addACC, addEvasion,
} from '../lib/db';
import { startBattle } from '../lib/battle';

const JACK_GIF =
  process.env.JACK_IN_GIF_URL ||
  process.env.JACKIN_GIF_URL ||
  undefined;

const BOSS_ENCOUNTER =
  Number(process.env.BOSS_ENCOUNTER_RATE ?? process.env.BOSS_ENCOUNTER ?? 0.10);

/* ------------------------------ helpers ------------------------------ */

function isBossFlag(v: any): boolean {
  const raw = v?.boss ?? v?.is_boss;
  if (raw === true || raw === false) return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function asArray<T = any>(maybe: any): T[] {
  if (Array.isArray(maybe)) return maybe as T[];
  if (maybe && typeof maybe === 'object') return Object.values(maybe) as T[];
  return [];
}

function pickEncounterFromEligible(eligible: any[]) {
  const bosses = eligible.filter(isBossFlag);
  const normals = eligible.filter(v => !isBossFlag(v));

  if (normals.length === 0 && bosses.length > 0) {
    const pick = bosses[Math.floor(Math.random() * bosses.length)];
    return { enemy_kind: 'boss' as const, virus: pick as any, bosses, normals };
  }

  if (bosses.length && Math.random() < BOSS_ENCOUNTER) {
    const pick = bosses[Math.floor(Math.random() * bosses.length)];
    return { enemy_kind: 'boss' as const, virus: pick as any, bosses, normals };
  }

  if (normals.length) {
    const pick = normals[Math.floor(Math.random() * normals.length)];
    return { enemy_kind: 'virus' as const, virus: pick as any, bosses, normals };
  }

  return null;
}

/** Jack-In HUD (Encounter / Travel / Shop). */
export async function renderJackInHUD(
  ix: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction,
  lastResult?: { title: string; lines?: string[] }
) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const b: any = getBundle();

  const { region } = getCurrentRegionForPlayer(p, b);
  const zone = getZone(userId) || 1;

  const desc = [
    `Region: **${region?.name || region?.label || p?.region_id || '—'}**, Zone: **${zone}**`,
  ];

  if (lastResult) {
    desc.push('', '📌 **Last Result**', `**${lastResult.title}**`);
    if (lastResult.lines?.length) desc.push(...lastResult.lines);
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ Jacked In')
    .setDescription(desc.join('\n'))
    .setImage(JACK_GIF || (region?.background_url || null))
    .setFooter({ text: 'Encounter, Travel, or Shop from this same screen.' });

  const encounterBtn = new ButtonBuilder().setCustomId('jackin:encounter').setStyle(ButtonStyle.Primary).setLabel('Encounter');
  const travelBtn    = new ButtonBuilder().setCustomId('jackin:openTravel').setStyle(ButtonStyle.Secondary).setLabel('Travel');
  const shopBtn      = new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Secondary).setLabel('Shop');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn, shopBtn);

  if (ix.isChatInputCommand()) {
    await ix.reply({ ephemeral: true, embeds: [embed], components: [row] });
  } else if (ix.isButton()) {
    await (ix as ButtonInteraction).update({ embeds: [embed], components: [row] });
  } else {
    await (ix as StringSelectMenuInteraction).update({ embeds: [embed], components: [row] });
  }
}

function getCurrentRegionForPlayer(p: any, b: any) {
  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;
  const region =
    (regionsMap ? regionsMap[p?.region_id] : null) ||
    regionsArr.find(r => String(r?.id) === String(p?.region_id));
  return { region, regionsArr, regionsMap };
}

function backRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('jackin:back').setStyle(ButtonStyle.Secondary).setLabel('Back')
  );
}

/* ------------------------------ slash ------------------------------ */

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Jack in → pick a region (dropdown), start at Zone 1, then Encounter/Travel/Shop.');

export async function execute(ix: ChatInputCommandInteraction) {
  await ensureStartUnlocked(ix.user.id);

  const regionsUnlocked = await listUnlocked(ix.user.id);
  if (!regionsUnlocked.length) {
    await ix.reply({ ephemeral: true, content: '❌ No regions unlocked yet. Level up to unlock your first region.' });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectRegion')
    .setPlaceholder('Select a region to jack in')
    .addOptions(
      regionsUnlocked
        .sort((a: any, b: any) => (a.min_level || 1) - (b.min_level || 1) || String(a.name).localeCompare(String(b.name)))
        .map((r: any) => ({
          label: r.name,
          value: r.id,
          description: `Min Lv ${r.min_level ?? 1} • ${r.zone_count ?? 1} zones`,
        })),
    );

  const embed = new EmbedBuilder()
    .setTitle('🔌 Jack In')
    .setDescription('Pick a region to enter. You will start at **Zone 1**.')
    .setImage(JACK_GIF || (regionsUnlocked[0]?.background_url || null))
    .setFooter({ text: 'Step 1 — Region' });

  await ix.reply({
    ephemeral: true,
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

/* ------------------------------ selects/buttons ------------------------------ */

export async function onSelectRegion(ix: StringSelectMenuInteraction) {
  const regionId = ix.values[0];
  const userId = ix.user.id;

  await setRegion(userId, regionId);
  await setZone(userId, 1);

  await renderJackInHUD(ix);
}

export async function onOpenTravel(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const b: any = getBundle();
  const { region } = getCurrentRegionForPlayer(p, b);

  if (!region) {
    const embed = new EmbedBuilder()
      .setTitle('🧭 Travel')
      .setDescription('No region set. Use **/jack_in** first.');
    await ix.update({ embeds: [embed], components: [backRow()] });
    return;
  }

  const zoneCount = Math.max(1, Number(region.zone_count ?? 1));
  const currentZone = getZone(userId) || 1;
  const zoneSelect = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectZone')
    .setPlaceholder(`Current Zone ${currentZone} — choose a destination`)
    .addOptions(
      Array.from({ length: zoneCount }, (_, i) => {
        const z = i + 1;
        return {
          label: `Zone ${z}`,
          value: String(z),
          description: z === currentZone ? 'Current location' : `Travel to Zone ${z}`,
          default: z === currentZone,
        };
      }),
    );

  const embed = new EmbedBuilder()
    .setTitle(`🧭 Travel — ${region.name || region.label || region.id}`)
    .setDescription([
      `Current zone: **${currentZone}**`,
      '',
      'Select a zone below. This will update the same Jack-In screen.',
    ].join('\n'))
    .setImage(region.background_url || JACK_GIF || null)
    .setFooter({ text: 'Travel is now part of your active Jack-In panel.' });

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(zoneSelect),
      backRow(),
    ],
  });
}

export async function onSelectZone(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const zone = parseInt(ix.values[0], 10);
  await setZone(userId, zone);
  await renderJackInHUD(ix, { title: 'Travel Complete', lines: [`Moved to **Zone ${zone}**.`] });
}

/**
 * Encounter:
 * - chooses a virus in current region/zone
 * - immediately starts battle UI (chips select + lock/run)
 */
export async function onEncounter(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);

  const regionId = String(p?.region_id ?? '').trim();
  if (!regionId) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  const b: any = getBundle();
  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;
  const reg =
    (regionsMap ? regionsMap[regionId] : null) ||
    regionsArr.find(r => String(r?.id) === regionId);

  let zone = getZone(userId) || 1;
  const maxZone = Math.max(1, Number(reg?.zone_count || 1));
  if (zone < 1 || zone > maxZone) {
    zone = 1;
    await setZone(userId, zone);
  }

  const allViruses = asArray<any>(b.viruses);
  const eligible = listVirusesForRegionZone({
    region_id: regionId,
    zone,
    includeNormals: true,
    includeBosses: true,
  }) as any[];

  const eligibleBosses = eligible.filter(isBossFlag);
  const eligibleNormals = eligible.filter(v => !isBossFlag(v));

  const picked = pickEncounterFromEligible(eligible);
  if (!picked) {
    const regionSamples = Array.from(
      new Set(allViruses.map(v => String(v?.region_id ?? v?.region ?? '').trim()).filter(Boolean))
    ).slice(0, 12);

    const embed = new EmbedBuilder()
      .setTitle('⚠️ No Encounter Available')
      .setDescription(
        `No eligible encounters configured for **${reg?.name || reg?.label || regionId} / Zone ${zone}**.` +
        `\n\nDebug — player.region_id: **${regionId}** • zone: **${zone}** • zone_count: **${reg?.zone_count ?? '?'}**` +
        `\nDebug — viruses_loaded: **${allViruses.length}** • eligible: **${eligible.length}** (normals:${eligibleNormals.length} bosses:${eligibleBosses.length})` +
        (regionSamples.length ? `\nDebug — virus region_id samples: ${regionSamples.join(', ')}` : '')
      );
    const back = new ButtonBuilder()
      .setCustomId('jackin:back')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Back');

    await ix.update({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)],
    });
    return;
  }

  try {
    // ✅ go straight into combat UI
    const virusId = String((picked.virus as any).id);
    const view = startBattle(userId, virusId, picked.enemy_kind, { returnMode: "jackin" });

    await ix.update({
      embeds: [view.embed],
      components: view.components,
    });
  } catch (err: any) {
    console.error('onEncounter error:', err);
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Encounter Error')
      .setDescription(
        `Encounter error in **${reg?.name || reg?.label || regionId} / Zone ${zone}**.` +
        `\nDebug — player.region_id: **${regionId}** • viruses_loaded: **${allViruses.length}** • eligible: **${eligible.length}** (normals:${eligibleNormals.length} bosses:${eligibleBosses.length})` +
        `\nError: ${err?.message || String(err)}`
      );
    const back = new ButtonBuilder().setCustomId('jackin:back').setStyle(ButtonStyle.Secondary).setLabel('Back');
    await ix.update({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)] });
  }
}

/* ------------------------------ Shop flow ------------------------------ */

// Upgrade effect parser -> immediate stat application
function applyUpgradeImmediate(userId: string, chip: any): string {
  const text = String(chip.effects || chip.description || '');
  const apply = (rx: RegExp) => {
    const m = text.match(rx);
    return m ? parseInt(m[1], 10) : 0;
  };
  const dHP  = apply(/(?:hp_max|max\s*hp|hp)\s*([+-]?\d+)/i);
  const dATK = apply(/atk\s*([+-]?\d+)/i);
  const dDEF = apply(/def\s*([+-]?\d+)/i);
  const dSPD = apply(/spd\s*([+-]?\d+)/i);
  const dACC = apply(/acc\s*([+-]?\d+)/i);
  const dEVA = apply(/(?:eva|evasion)\s*([+-]?\d+)/i);

  if (dHP)  addHPMax(userId, dHP);
  if (dATK) addATK(userId, dATK);
  if (dDEF) addDEF(userId, dDEF);
  if (dSPD) addSPD(userId, dSPD);
  if (dACC) addACC(userId, dACC);
  if (dEVA) addEvasion(userId, dEVA);

  const parts: string[] = [];
  if (dHP)  parts.push(`HP+${dHP}`);
  if (dATK) parts.push(`ATK+${dATK}`);
  if (dDEF) parts.push(`DEF+${dDEF}`);
  if (dSPD) parts.push(`SPD+${dSPD}`);
  if (dACC) parts.push(`ACC+${dACC}`);
  if (dEVA) parts.push(`EVA+${dEVA}`);
  return parts.join(' • ') || 'applied';
}

export async function onOpenShop(ix: ButtonInteraction) {
  await renderJackInShop(ix, null);
}

async function renderJackInShop(
  ix: ButtonInteraction | StringSelectMenuInteraction,
  selectedId: string | null,
  notice?: string
) {
  const userId = ix.user.id;
  const b: any = getBundle();
  const p: any = await getPlayer(userId);
  const { region } = getCurrentRegionForPlayer(p, b);

  if (!region) {
    const embed = new EmbedBuilder()
      .setTitle('🛒 Net Shop')
      .setDescription('No region selected. Use **/jack_in** first.');
    await ix.update({ embeds: [embed], components: [backRow()] });
    return;
  }

  const items = resolveShopInventory((region as any).id ?? (region as any).name);
  if (!items.length) {
    const embed = new EmbedBuilder()
      .setTitle(`🛒 ${region?.name || 'Region'} Shop`)
      .setDescription(`No shop inventory is available in **${region?.name || 'this region'}**.`)
      .setImage(region.background_url || JACK_GIF || null);
    await ix.update({ embeds: [embed], components: [backRow()] });
    return;
  }

  const selected = selectedId
    ? items.find(i => i.item_id === selectedId) || null
    : null;

  const options = items
    .map((it) => ({
      label: `${it.name} — ${it.zenny_price}z`.slice(0, 100),
      value: it.item_id,
      description: `${it.is_upgrade ? 'Upgrade' : 'BattleChip'}${it.chip?.element ? ` • ${it.chip.element}` : ''}`.slice(0, 100),
      default: selected?.item_id === it.item_id,
    }))
    .slice(0, 25);

  const sel = new StringSelectMenuBuilder()
    .setCustomId('jackin:shopSelect')
    .setPlaceholder(selected ? `Selected: ${selected.name}` : 'Select an item to inspect/buy')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const buy = new ButtonBuilder()
    .setCustomId(`jackin:shopBuy:${selected?.item_id || '_none'}`)
    .setStyle(ButtonStyle.Success)
    .setLabel(selected ? `Buy for ${selected.zenny_price}z` : 'Buy')
    .setDisabled(!selected);
  const exit = new ButtonBuilder().setCustomId('jackin:shopExit').setStyle(ButtonStyle.Secondary).setLabel('Back');

  const desc = [
    `Region: **${region.name || region.label || region.id}**`,
    `Your Zenny: **${p?.zenny ?? 0}z**`,
    '',
    notice ? `📌 **${notice}**` : 'Pick an item, then press **Buy**.',
  ];

  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${region.name || region.label || region.id} Shop`)
    .setDescription(desc.join('\n'))
    .setImage(region.background_url || JACK_GIF || null);

  if (selected) {
    const c: any = selected.chip || {};
    const details = [
      `Price: **${selected.zenny_price}z**`,
      `Type: **${selected.is_upgrade ? 'Upgrade' : 'BattleChip'}**`,
      c.element ? `Element: **${c.element}**` : '',
      Number.isFinite(Number(c.power)) && Number(c.power) > 0 ? `Power: **${c.power}**` : '',
      Number.isFinite(Number(c.hits)) && Number(c.hits) > 1 ? `Hits: **${c.hits}**` : '',
      c.effects ? `Effects: ${String(c.effects)}` : '',
      c.description ? `\n${String(c.description)}` : '',
    ].filter(Boolean).join('\n');

    embed.addFields({ name: selected.name || formatChipName(c || selected.item_id), value: details || '—' });
    const img = c.image_url || c.image || null;
    if (img) embed.setThumbnail(String(img));
  }

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel),
      new ActionRowBuilder<ButtonBuilder>().addComponents(buy, exit),
    ],
  });
}

export async function onShopSelect(ix: StringSelectMenuInteraction) {
  const id = ix.values?.[0] || null;
  await renderJackInShop(ix, id);
}

export async function onShopBuy(ix: ButtonInteraction, chipId: string) {
  try {
    if (!chipId || chipId === '_none') {
      await renderJackInShop(ix, null, 'Please select an item first.');
      return;
    }

    const userId = ix.user.id;
    const b: any = getBundle();
    const p: any = await getPlayer(userId);
    const { region } = getCurrentRegionForPlayer(p, b);

    if (!region) {
      const embed = new EmbedBuilder()
        .setTitle('🛒 Net Shop')
        .setDescription('Pick a region first from **/jack_in**.');
      await ix.update({ embeds: [embed], components: [backRow()] });
      return;
    }

    const items = resolveShopInventory((region as any).id ?? (region as any).name);
    const item = items.find(s => s.item_id === chipId);
    if (!item) {
      await renderJackInShop(ix, null, 'That chip is not for sale in this region.');
      return;
    }

    const pay = spendZenny(userId, item.zenny_price);
    if (!pay.ok) {
      await renderJackInShop(ix, chipId, `Not enough Zenny. You need ${item.zenny_price}z.`);
      return;
    }

    if (item.is_upgrade) {
      const summary = applyUpgradeImmediate(userId, item.chip);
      await renderJackInShop(ix, chipId, `Purchased ${item.name} for ${item.zenny_price}z. Upgrade applied: ${summary}.`);
      return;
    }

    grantChip(userId, chipId, 1);
    await renderJackInShop(ix, chipId, `Bought ${item.name} for ${item.zenny_price}z. Added to inventory.`);
  } catch (err: any) {
    console.error('onShopBuy error:', err);
    try {
      const embed = new EmbedBuilder().setTitle('⚠️ Shop Error').setDescription(String(err?.message || err));
      await ix.update({ embeds: [embed], components: [backRow()] });
    } catch {}
  }
}

export async function onShopExit(ix: ButtonInteraction) {
  await renderJackInHUD(ix);
}
