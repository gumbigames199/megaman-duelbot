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
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
const isBoss = (v: any) => {
  const raw = v?.boss;
  if (raw === true || raw === false) return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};
const zonesMatch = (v: any, zone: number) => {
  const list = parseZones((v as any).zones ?? (v as any).zone);
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

  throw Object.assign(
    new Error(`No encounters for region=${regionId} zone=${zone}`),
    { __encounterDebug: { inZone: inZone.length, bosses: bosses.length, normals: normals.length } }
  );
}

/* ------------------------------ slash ------------------------------ */

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Jack in → pick a region (dropdown), start at Zone 1, then Encounter or Travel via buttons.');

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
    .setImage(JACK_GIF || regionsUnlocked[0]?.background_url || null)
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

  await ix.update({
    content: `Region: **${region?.name || p?.region_id}**, Zone: **${zone}**`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn)],
  });
}

// Encounter → start battle and show pick UI with virus art & region background
export async function onEncounter(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const regionId = p?.region_id;
  let zone = Number(p?.zone || 1);

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
        return { label: label.slice(0, 100), value: cid };
      });

      if (opts.length) select.addOptions(opts);
      return select;
    };

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(1));
    const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(2));
    const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeSelect(3));

    const lockBtn = new ButtonBuilder().setCustomId(`lock:${battleId}`).setStyle(ButtonStyle.Success).setLabel('Lock');
    const runBtn  = new ButtonBuilder().setCustomId(`run:${battleId}`).setStyle(ButtonStyle.Danger).setLabel('Run');
    const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(lockBtn, runBtn);

    const enemyKind = enemy_kind === 'boss' ? 'Boss' : 'Virus';
    const embed = new EmbedBuilder()
      .setTitle(`${virus.name} — ${enemyKind}`)
      .setDescription(`Region **${reg?.name || regionId}**, Zone **${zone}**\nPick up to **3** chips in order, then **Lock**.`)
      .setThumbnail(virus.image_url || virus.anim_url || null)
      .setImage(reg?.background_url || JACK_GIF || null);

    await ix.reply({
      ephemeral: true,
      embeds: [embed],
      components: [row1, row2, row3, row4],
    });
  } catch (err: any) {
    if (err?.code === 'EMPTY_FOLDER' || err?.message === 'EMPTY_FOLDER') {
      await ix.reply({
        ephemeral: true,
        content: '🗂️ Your folder is empty — add chips to your folder first (use **/folder**).',
      });
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
