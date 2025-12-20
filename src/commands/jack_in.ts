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
import { getBundle, resolveShopInventory, listVirusesForRegionZone } from '../lib/data';
import {
  getPlayer, setRegion, setZone, getZone,
  addZenny, spendZenny, tryAddToFolder, getFolderRemaining,
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
export async function renderJackInHUD(ix: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const b: any = getBundle();

  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;

  const region =
    (regionsMap ? regionsMap[p?.region_id] : null) ||
    regionsArr.find(r => String(r?.id) === String(p?.region_id));

  const zone = getZone(userId) || 1;

  const embed = new EmbedBuilder()
    .setTitle('✅ Jacked In')
    .setDescription(`Region: **${region?.name || region?.label || p?.region_id || '—'}**, Zone: **${zone}**`)
    .setImage(JACK_GIF || (region?.background_url || null))
    .setFooter({ text: 'You can Encounter, Travel, or Shop.' });

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

  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;

  const region =
    (regionsMap ? regionsMap[p?.region_id] : null) ||
    regionsArr.find(r => String(r?.id) === String(p?.region_id));

  if (!region) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  const zoneCount = Math.max(1, Number(region.zone_count ?? 1));
  const zoneSelect = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectZone')
    .setPlaceholder(`Select a zone in ${region.name || region.label || region.id}`)
    .addOptions(
      Array.from({ length: zoneCount }, (_, i) => {
        const z = i + 1;
        return { label: `Zone ${z}`, value: String(z) };
      }),
    );

  await ix.reply({
    ephemeral: true,
    content: `Travel within **${region.name || region.label || region.id}**: choose a zone.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(zoneSelect)],
  });
}

export async function onSelectZone(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const zone = parseInt(ix.values[0], 10);
  await setZone(userId, zone);
  await renderJackInHUD(ix);
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

    await ix.reply({
      ephemeral: true,
      content:
        `⚠️ No eligible encounters configured for **${reg?.name || reg?.label || regionId} / Zone ${zone}**.` +
        `\nDebug — player.region_id: **${regionId}** • zone: **${zone}** • zone_count: **${reg?.zone_count ?? '?'}**` +
        `\nDebug — viruses_loaded: **${allViruses.length}** • eligible: **${eligible.length}** (normals:${eligibleNormals.length} bosses:${eligibleBosses.length})` +
        (regionSamples.length ? `\nDebug — virus region_id samples: ${regionSamples.join(', ')}` : ''),
    });
    return;
  }

  try {
    // ✅ go straight into combat UI
    const virusId = String((picked.virus as any).id);
    const view = startBattle(userId, virusId);

    await ix.reply({
      ephemeral: true,
      embeds: [view.embed],
      components: view.components,
    });
  } catch (err: any) {
    console.error('onEncounter error:', err);
    await ix.reply({
      ephemeral: true,
      content:
        `⚠️ Encounter error in **${reg?.name || reg?.label || regionId} / Zone ${zone}**.` +
        `\nDebug — player.region_id: **${regionId}** • viruses_loaded: **${allViruses.length}** • eligible: **${eligible.length}** (normals:${eligibleNormals.length} bosses:${eligibleBosses.length})` +
        `\nError: ${err?.message || String(err)}`,
    });
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
  const userId = ix.user.id;
  const b: any = getBundle();
  const p: any = await getPlayer(userId);

  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;

  const region =
    (regionsMap ? regionsMap[p?.region_id] : null) ||
    regionsArr.find(r => String(r?.id) === String(p?.region_id));

  if (!region) {
    await ix.reply({ ephemeral: true, content: '🛒 No region selected. Use **/jack_in** first.' });
    return;
  }

  const items = resolveShopInventory((region as any).id ?? (region as any).name);
  if (!items.length) {
    await ix.reply({ ephemeral: true, content: `🛒 No shop available in **${region?.name || 'this region'}**.` });
    return;
  }

  const options = items
    .map((it) => {
      const lbl = `${it.name}${(it.chip as any).letters ? ` [${(it.chip as any).letters}]` : ''} — ${it.zenny_price}z`;
      return { label: lbl.slice(0, 100), value: it.item_id };
    })
    .slice(0, 25);

  const sel = new StringSelectMenuBuilder()
    .setCustomId('jackin:shopSelect')
    .setPlaceholder('Select an item to inspect/buy')
    .setMinValues(0)
    .setMaxValues(1);
  if (options.length) sel.addOptions(options);

  const buy  = new ButtonBuilder().setCustomId('jackin:shopBuy:_none').setStyle(ButtonStyle.Success).setLabel('Buy').setDisabled(true);
  const exit = new ButtonBuilder().setCustomId('jackin:shopExit').setStyle(ButtonStyle.Secondary).setLabel('Exit');

  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${region.name} Shop`)
    .setDescription('Pick an item, then **Buy**.')
    .setImage(region.background_url || JACK_GIF || null);

  await ix.reply({
    ephemeral: true,
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel),
      new ActionRowBuilder<ButtonBuilder>().addComponents(buy, exit),
    ],
  });
}

export async function onShopSelect(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const b: any = getBundle();
  const p: any = await getPlayer(userId);

  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;

  const region =
    (regionsMap ? regionsMap[p?.region_id] : null) ||
    regionsArr.find(r => String(r?.id) === String(p?.region_id));

  const items = region ? resolveShopInventory((region as any).id ?? (region as any).name) : [];
  const id = ix.values?.[0];
  const item = items.find(i => i.item_id === id);

  if (!item) {
    await ix.update({ content: '⚠️ That item is not available here.', components: [] });
    return;
  }

  const c: any = item.chip || {};
  const price = item.zenny_price;

  const embed = new EmbedBuilder()
    .setTitle(c.name || id)
    .setDescription(`${c.description || '—'}\n\nPrice: **${price}z**`)
    .setThumbnail(c.image_url || (c as any).image || null);

  const buy  = new ButtonBuilder().setCustomId(`jackin:shopBuy:${id}`).setStyle(ButtonStyle.Success).setLabel(`Buy for ${price}z`);
  const exit = new ButtonBuilder().setCustomId('jackin:shopExit').setStyle(ButtonStyle.Secondary).setLabel('Exit');

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('jackin:shopSelect')
          .setPlaceholder(`Selected: ${c.name || id}`)
          .setMinValues(0).setMaxValues(1)
          .addOptions([{ label: `${c.name || id} — ${price}z`, value: id }]),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(buy, exit),
    ],
  });
}

export async function onShopBuy(ix: ButtonInteraction, chipId: string) {
  try {
    if (!chipId || chipId === '_none') {
      await ix.reply({ ephemeral: true, content: 'Please select an item first.' });
      return;
    }

    const userId = ix.user.id;
    const b: any = getBundle();
    const p: any = await getPlayer(userId);

    const regionsArr = asArray<any>(b.regions);
    const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;

    const region =
      (regionsMap ? regionsMap[p?.region_id] : null) ||
      regionsArr.find(r => String(r?.id) === String(p?.region_id));

    if (!region) {
      await ix.reply({ ephemeral: true, content: '⚠️ Pick a region first (use /jack_in).' });
      return;
    }

    const items = resolveShopInventory((region as any).id ?? (region as any).name);
    const item = items.find(s => s.item_id === chipId);
    if (!item) {
      await ix.reply({ ephemeral: true, content: '❌ That chip is not for sale in this region.' });
      return;
    }

    const remaining = getFolderRemaining(userId);
    if (remaining <= 0 && !item.is_upgrade) {
      await ix.reply({ ephemeral: true, content: `❌ Folder is full (30/30). Remove a chip from your folder first.` });
      return;
    }

    const pay = spendZenny(userId, item.zenny_price);
    if (!pay.ok) {
      await ix.reply({ ephemeral: true, content: `❌ Not enough Zenny. You need ${item.zenny_price}z.` });
      return;
    }

    if (item.is_upgrade) {
      const summary = applyUpgradeImmediate(userId, item.chip);
      await ix.reply({
        ephemeral: true,
        content: `✅ Purchased **${item.name}** for **${item.zenny_price}z**.\nUpgrade applied: ${summary}`,
      });
      return;
    }

    const res = tryAddToFolder(userId, chipId, 1);
    if (!res.ok || res.added <= 0) {
      addZenny(userId, item.zenny_price); // refund
      const why = res.reason ? ` ${res.reason}` : '';
      await ix.reply({ ephemeral: true, content: `❌ Purchase failed.${why}` });
      return;
    }

    await ix.reply({
      ephemeral: true,
      content: `✅ Bought **${item.name}** for **${item.zenny_price}z**.\nAdded to your folder.`,
    });
  } catch (err: any) {
    console.error('onShopBuy error:', err);
    try { await ix.reply({ ephemeral: true, content: `⚠️ Error: ${err?.message || err}` }); } catch {}
  }
}

export async function onShopExit(ix: ButtonInteraction) {
  await renderJackInHUD(ix);
}
