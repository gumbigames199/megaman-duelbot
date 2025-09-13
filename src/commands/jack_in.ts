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
import { getPlayer, setRegion, setZone } from '../lib/db';
import { startEncounterBattle } from '../lib/battle';
import { battleEmbed } from '../lib/render';

// region background (supports both env names)
const JACK_GIF =
  process.env.JACK_IN_GIF_URL ||
  process.env.JACKIN_GIF_URL ||
  undefined;

const BOSS_ENCOUNTER = parseFloat(process.env.BOSS_ENCOUNTER || '0.10');

/* ------------------------------ helpers ------------------------------ */

// parse "1,2,4-6" → [1,2,4,5,6]
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
  return out;
}

const isBoss = (v: any) => String(v?.category || '').toLowerCase().includes('boss');
const zonesMatch = (v: any, zone: number) => {
  const list = parseZones(v?.zones);
  return list.length === 0 ? true : list.includes(zone);
};

function pickEncounter(regionId: string, zone: number) {
  const { viruses } = getBundle();
  const normRegion = String(regionId || '').trim();
  const inRegion = (v: any) => String(v?.region || '').trim() === normRegion && zonesMatch(v, zone);

  const inZone = Object.values(viruses).filter(inRegion);
  const bosses = inZone.filter(isBoss);
  const normals = inZone.filter(v => !isBoss(v));

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

  throw new Error(`NO_ENCOUNTERS`);
}

/* ------------------------------ slash ------------------------------ */

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Jack in to a region, travel zones, and start encounters');

export async function execute(ix: ChatInputCommandInteraction) {
  ensureStartUnlocked(ix.user.id);
  const unlocked = listUnlocked(ix.user.id);
  const { regions } = getBundle();

  const options = unlocked
    .map(id => ({ id, name: regions[id]?.name || id }))
    .map(r => ({ label: r.name, value: r.id }))
    .slice(0, 25);

  if (!options.length) {
    await ix.reply({ ephemeral: true, content: 'No regions unlocked yet.' });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectRegion')
    .setPlaceholder('Select a region')
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const embed = new EmbedBuilder()
    .setTitle('Jack-In')
    .setDescription('Pick a region to enter.')
    .setImage(JACK_GIF || null);

  await ix.reply({ ephemeral: false, embeds: [embed], components: [row] });
}

export async function onSelectRegion(ix: StringSelectMenuInteraction) {
  const regionId = ix.values[0];
  const userId = ix.user.id;

  await setRegion(userId, regionId);
  await setZone(userId, 1);

  const { regions } = getBundle();
  const region = regions[regionId];

  const embed = new EmbedBuilder()
    .setTitle('✅ Jacked In')
    .setDescription(`Region: **${region?.name || regionId}**, Zone: **1**`)
    .setImage(JACK_GIF || region?.background_url || null)
    .setFooter({ text: 'You can Encounter or Travel.' });

  const encounterBtn = new ButtonBuilder()
    .setCustomId('jackin:encounter')
    .setStyle(ButtonStyle.Primary)
    .setLabel('Encounter');

  const travelBtn = new ButtonBuilder()
    .setCustomId('jackin:openTravel')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Travel');

  await ix.update({
    content: '',
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn)],
  });
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
        const z = String(i + 1);
        return { label: `Zone ${z}`, value: z };
      })
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

  const p: any = await getPlayer(userId);
  const { regions } = getBundle();
  const region = regions[p?.region_id];

  const encounterBtn = new ButtonBuilder()
    .setCustomId('jackin:encounter')
    .setStyle(ButtonStyle.Primary)
    .setLabel('Encounter');

  const travelBtn = new ButtonBuilder()
    .setCustomId('jackin:openTravel')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Travel');

  const embed = new EmbedBuilder()
    .setTitle('🗺️ Travelled')
    .setDescription(`Region: **${region?.name || p?.region_id}**, Zone: **${zone}**`)
    .setImage(JACK_GIF || region?.background_url || null);

  await ix.update({
    content: '',
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn)],
  });
}

// Encounter → start battle and show pick UI with virus art & region background
export async function onEncounter(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const regionId = p?.region_id;
  let zone = Number(p?.region_zone || p?.zone || 1);

  if (!regionId) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  const { regions, chips } = getBundle();
  const reg = regions[regionId];
  const maxZone = Math.max(1, Number(reg?.zone_count || 1));
  if (zone < 1 || zone > maxZone) { zone = 1; await setZone(userId, zone); }

  // Strict region+zone search; retry a handful of times to avoid flukes; never spill to other zones/regions.
  let enemy_kind: 'virus' | 'boss' = 'virus';
  let virus: any = null;
  for (let i = 0; i < 10; i++) {
    try {
      const res = pickEncounter(regionId, zone);
      enemy_kind = res.enemy_kind;
      virus = res.virus;
      break;
    } catch {}
  }
  if (!virus) {
    // As requested: do not emit ephemeral debug; just quietly no-op.
    await ix.deferUpdate();
    return;
  }

  const { battleId, state } = startEncounterBattle({
    user_id: userId,
    enemy_kind,
    enemy_id: virus.id,
    region_id: regionId,
    zone,
  });

  const hand: string[] = Array.isArray(state?.hand) ? state.hand : [];

  const makeSelect = (slot: 1 | 2 | 3) => {
    const select = new StringSelectMenuBuilder()
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
      return { label, value: cid };
    });
    if (opts.length) select.addOptions(opts);
    return select;
  };

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(1));
  const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(2));
  const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(3));

  const lockBtn = new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock Turn');
  const runBtn  = new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Secondary).setLabel('Run');

  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(lockBtn, runBtn);

  const embed = battleEmbed(state, {
    playerName: ix.user.username,
    playerAvatar: ix.user.displayAvatarURL(),
    regionId,
  });

  await ix.reply({
    ephemeral: false,
    embeds: [embed],
    components: [row1, row2, row3, row4],
  });
}
