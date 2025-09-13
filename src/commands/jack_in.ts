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
import { getBundle } from '../lib/data';
import {
  getPlayer, setRegion, setZone, getZone,
  addZenny, grantChip,
  addHPMax, addATK, addDEF, addSPD, addACC, addEvasion,
} from '../lib/db';
import { startEncounterBattle } from '../lib/battle';

const JACK_GIF =
  process.env.JACK_IN_GIF_URL ||
  process.env.JACKIN_GIF_URL ||
  undefined;

const BOSS_ENCOUNTER = parseFloat(process.env.BOSS_ENCOUNTER || '0.10');

/* ------------------------------ helpers ------------------------------ */

function parseZones(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw === 'number') return Number.isFinite(raw) ? [raw] : [];
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out: number[] = [];
  for (const part of s.split(',')) {
    const p = part.trim();
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let x = a; x <= b; x++) out.push(x);
    } else {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
function isBossFlag(v: any): boolean {
  const raw = v?.boss;
  if (raw === true || raw === false) return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}
function zonesMatch(v: any, zone: number): boolean {
  const list = parseZones((v as any).zones ?? (v as any).zone);
  return list.length === 0 ? true : list.includes(zone);
}

/** Pick an encounter (boss chance, else uniform non-boss). */
function pickEncounter(regionId: string, zone: number) {
  const { viruses } = getBundle();
  const normRegion = String(regionId || '').trim();
  const inRegion = (v: any) => String(v?.region || '').trim() === normRegion && zonesMatch(v, zone);

  const inZone = Object.values(viruses).filter(inRegion);
  const bosses = inZone.filter(isBossFlag);
  const normals = inZone.filter(v => !isBossFlag(v));

  if (normals.length === 0 && bosses.length > 0) {
    return { enemy_kind: 'boss' as const, virus: bosses[0] };
  }
  if (bosses.length && Math.random() < BOSS_ENCOUNTER) {
    return { enemy_kind: 'boss' as const, virus: bosses[0] };
  }
  if (normals.length) {
    const pick = normals[Math.floor(Math.random() * normals.length)];
    return { enemy_kind: 'virus' as const, virus: pick };
  }

  throw Object.assign(
    new Error(`No encounters for region=${regionId} zone=${zone}`),
    { __encounterDebug: { inZone: inZone.length, bosses: bosses.length, normals: normals.length } }
  );
}

/** Jack-In HUD (Encounter / Travel / Shop). Exported so index.ts can reuse. */
export async function renderJackInHUD(ix: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const { regions } = getBundle();
  const region = regions[p?.region_id];
  const zone = getZone(userId) || 1;

  const embed = new EmbedBuilder()
    .setTitle('✅ Jacked In')
    .setDescription(`Region: **${region?.name || p?.region_id || '—'}**, Zone: **${zone}**`)
    .setFooter({ text: 'You can Encounter, Travel, or Shop.' });

  // Prefer jack-in GIF; fall back to region background if present
  const imageUrl = JACK_GIF || region?.background_url || '';
  if (imageUrl) embed.setImage(imageUrl);

  const encounterBtn = new ButtonBuilder().setCustomId('jackin:encounter').setStyle(ButtonStyle.Primary).setLabel('Encounter');
  const travelBtn    = new ButtonBuilder().setCustomId('jackin:openTravel').setStyle(ButtonStyle.Secondary).setLabel('Travel');
  const shopBtn      = new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Secondary).setLabel('Shop');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn, shopBtn);

  // decide whether to reply or update
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
    .setFooter({ text: 'Step 1 — Region' });

  const splash = JACK_GIF || regionsUnlocked[0]?.background_url || '';
  if (splash) embed.setImage(splash);

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
  const { regions } = getBundle();
  const region = regions[p?.region_id];

  if (!region) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  const zoneSelect = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectZone')
    .setPlaceholder(`Select a zone in ${region.name}`)
    .addOptions(
      Array.from({ length: region.zone_count || 1 }, (_, i) => {
        const z = i + 1;
        return { label: `Zone ${z}`, value: String(z) };
      }),
    );

  await ix.reply({
    ephemeral: true,
    content: `Travel within **${region.name}**: choose a zone.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(zoneSelect)],
  });
}

export async function onSelectZone(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const zone = parseInt(ix.values[0], 10);
  await setZone(userId, zone);
  await renderJackInHUD(ix);
}

/** Encounter → create battle, show an embedded header with the virus image, plus hand pickers. */
export async function onEncounter(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const regionId = p?.region_id;
  let zone = Number(p?.region_zone || 1);

  if (!regionId) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  const { regions, chips } = getBundle();
  const reg = regions[regionId];

  const maxZone = Math.max(1, Number(reg?.zone_count || 1));
  if (zone < 1 || zone > maxZone) { zone = 1; await setZone(userId, zone); }

  try {
    const { enemy_kind, virus } = pickEncounter(regionId, zone);
    const { battleId, state } = startEncounterBattle({
      user_id: userId,
      enemy_kind,
      enemy_id: virus.id,
      region_id: regionId,
      zone,
    });

    // encounter header embed with virus image
    const header = new EmbedBuilder()
      .setTitle(`${virus.name}`)
      .setDescription(`Enemy HP: **${virus.hp ?? 0}** • Kind: **${enemy_kind === 'boss' ? 'Boss' : 'Virus'}**`);
    const thumb = virus.image_url || virus.anim_url || '';
    if (thumb) header.setThumbnail(thumb);
    const bg = reg?.background_url || '';
    if (bg) header.setImage(bg);

    // build 3 pickers from opening hand
    const hand: string[] = Array.isArray(state?.hand) ? state.hand : [];
    const makeSelect = (slot: 1 | 2 | 3) => {
      const sel = new StringSelectMenuBuilder()
        .setCustomId(`pick${slot}:${battleId}`)
        .setPlaceholder(`Pick ${slot}`)
        .setMinValues(0)
        .setMaxValues(1);

      const opts = hand.map((cid) => {
        const c: any = chips[cid] || {};
        const name = c.name || cid;
        const code = c.code || c.letters || '';
        const pwr  = c.power || c.power_total || '';
        const hits = c.hits || 1;
        const label = `${name}${code ? ` [${code}]` : ''}${pwr ? ` ${pwr}×${hits}` : ''}`;
        return { label: label.slice(0, 100), value: cid };
      });
      if (opts.length) sel.addOptions(opts);
      return sel;
    };
    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(1));
    const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(2));
    const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(3));

    const lockBtn = new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock');
    const runBtn  = new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run');
    const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(lockBtn, runBtn);

    await ix.reply({
      ephemeral: true,
      embeds: [header],
      components: [row1, row2, row3, row4],
    });
  } catch (err: any) {
    if (err?.code === 'EMPTY_FOLDER') {
      await ix.reply({ ephemeral: true, content: '📁 Your folder is empty. Use **/folder** to add up to 30 chips, then try again.' });
      return;
    }
    const dbg = err?.__encounterDebug || {};
    await ix.reply({
      ephemeral: true,
      content:
        `⚠️ No eligible encounters configured for **${reg?.name || regionId} / Zone ${zone}**.` +
        `\nDebug — inZone:${dbg.inZone ?? '?'} normals:${dbg.normals ?? '?'} bosses:${dbg.bosses ?? '?'} (region zone_count=${reg?.zone_count ?? '?'})`,
    });
  }
}

/* ------------------------------ Shop flow ------------------------------ */

function parseShopEntries(entries: string): string[] {
  return String(entries || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(e => e.split(':')[0].trim()); // ignore any extra tokens, keep chip id
}
function chipPrice(id: string): number {
  const c: any = getBundle().chips[id] || {};
  const z = Number(c.zenny_cost || 0);
  return Number.isFinite(z) ? Math.max(0, z) : 0;
}
function applyUpgradeImmediate(userId: string, chip: any): string {
  const text = String(chip.effects || chip.description || '');
  const apply = (rx: RegExp) => {
    const m = text.match(rx);
    return m ? parseInt(m[1], 10) : 0;
  };
  // forgiving patterns like "HP+50", "atk +2", etc.
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
  const { regions, shops, chips } = getBundle();
  const p: any = await getPlayer(userId);
  const region = regions[p?.region_id];

  if (!region?.shop_id || !shops[region.shop_id]) {
    await ix.reply({ ephemeral: true, content: `🛒 No shop available in **${region?.name || 'this region'}**.` });
    return;
  }

  const shop = shops[region.shop_id] as any;
  const ids = parseShopEntries(shop.entries);

  const options = ids
    .map((id: string) => {
      const c: any = chips[id] || {};
      const lbl = `${c.name || id}${c.letters ? ` [${c.letters}]` : ''} — ${chipPrice(id)}z`;
      return { label: lbl.slice(0, 100), value: id };
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
    .setDescription('Pick an item, then **Buy**.\nPrices reflect chip `zenny_cost` from your TSV.');
  const bg = region.background_url || '';
  if (bg) embed.setImage(bg);

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
  const id = ix.values?.[0];
  const { chips } = getBundle();
  const c: any = chips[id] || {};
  const price = chipPrice(id);
  const embed = new EmbedBuilder()
    .setTitle(c.name || id)
    .setDescription(`${c.description || '—'}\n\nPrice: **${price}z**`);
  const thumb = c.image_url || '';
  if (thumb) embed.setThumbnail(thumb);

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
          .addOptions([{ label: `${c.name || id} — ${price}z`, value: id }])
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(buy, exit),
    ],
  });
}

export async function onShopBuy(ix: ButtonInteraction, chipId: string) {
  if (!chipId || chipId === '_none') { await ix.reply({ ephemeral: true, content: 'Please select an item first.' }); return; }
  const userId = ix.user.id;
  const { chips } = getBundle();
  const c: any = chips[chipId] || {};
  const cost = chipPrice(chipId);

  const p: any = await getPlayer(userId);
  if ((p?.zenny ?? 0) < cost) {
    await ix.reply({ ephemeral: true, content: `❌ Not enough zenny. You need **${cost}z**.` });
    return;
  }

  addZenny(userId, -cost);
  let resultMsg = '';

  if (c.is_upgrade) {
    const summary = applyUpgradeImmediate(userId, c);
    resultMsg = `✅ Purchased **${c.name || chipId}** for **${cost}z**.\nUpgrade applied: ${summary}`;
  } else {
    grantChip(userId, chipId, 1);
    resultMsg = `✅ Purchased **${c.name || chipId}** for **${cost}z**. Added to inventory.`;
  }

  await ix.reply({ ephemeral: true, content: resultMsg });
}

export async function onShopExit(ix: ButtonInteraction) {
  await renderJackInHUD(ix);
}
