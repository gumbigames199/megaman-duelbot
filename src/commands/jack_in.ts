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
import { startEncounterBattle } from '../lib/battle'; // ⬅️ battle bootstrap

// Support either env name (yours used JACKIN_GIF_URL)
const JACK_GIF =
  process.env.JACK_IN_GIF_URL ||
  process.env.JACKIN_GIF_URL ||
  undefined;

const BOSS_ENCOUNTER = parseFloat(process.env.BOSS_ENCOUNTER || '0.10');

// --- local helper: encounter picker (boss roll -> uniform non-boss) ---
function pickEncounter(regionId: string, zone: number) {
  const { viruses } = getBundle();

  // Boss roll
  if (Math.random() < BOSS_ENCOUNTER) {
    const boss = Object.values(viruses).find(
      (v: any) => v.boss && v.region === regionId && Array.isArray(v.zones) && v.zones.includes(zone),
    );
    if (boss) return { enemy_kind: 'boss' as const, virus: boss };
  }

  // Normal (uniform among non-boss)
  const candidates = Object.values(viruses).filter(
    (v: any) => !v.boss && v.region === regionId && Array.isArray(v.zones) && v.zones.includes(zone),
  );
  if (!candidates.length) {
    throw new Error(`No non-boss encounter candidates for ${regionId} zone ${zone}`);
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { enemy_kind: 'virus' as const, virus: pick };
}

export const data = new SlashCommandBuilder()
  .setName('jack_in')
  .setDescription('Jack in → pick a region (dropdown), start at Zone 1, then Encounter or Travel via buttons.');

export async function execute(ix: ChatInputCommandInteraction) {
  // ensure at least a starter region is valid for the player’s level
  await ensureStartUnlocked(ix.user.id);

  const regionsUnlocked = await listUnlocked(ix.user.id);
  if (!regionsUnlocked.length) {
    await ix.reply({ ephemeral: true, content: '❌ No regions unlocked yet. Level up to unlock your first region.' });
    return;
  }

  // Build dropdown of available regions
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

// --- Region selected -> set region & zone=1, render Encounter + Travel ---
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

// --- Travel button -> open zone dropdown for current region ---
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

// --- Zone selected -> set zone and re-render Encounter + Travel ---
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

// --- Encounter button -> immediately create a battle and render pick UI ---
export async function onEncounter(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const regionId = p?.region_id;
  const zone = Number(p?.zone || 1);

  if (!regionId) {
    await ix.reply({ ephemeral: true, content: 'No region set. Use **/jack_in** first.' });
    return;
  }

  try {
    // 1) Choose enemy (boss roll, else uniform non-boss)
    const { enemy_kind, virus } = pickEncounter(regionId, zone);

    // 2) Start battle (creates state, draws opening hand, saves to DB)
    const { battleId, state } = startEncounterBattle({
      user_id: userId,
      enemy_kind,
      enemy_id: virus.id,
      region_id: regionId,
      zone,
    });

    // 3) Build the three pick menus from opening hand
    const hand: string[] = Array.isArray(state?.hand) ? state.hand : [];
    const chips = getBundle().chips;

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

    const lockBtn = new ButtonBuilder()
      .setCustomId(`lock:${battleId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Lock');

    const runBtn = new ButtonBuilder()
      .setCustomId(`run:${battleId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Run');

    const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(lockBtn, runBtn);

    // 4) Ephemeral battle kickoff UI
    const enemyKind = enemy_kind === 'boss' ? 'Boss' : 'Virus';
    await ix.reply({
      ephemeral: true,
      content: `⚔️ Encounter: **${virus.name}** (${enemyKind}) — pick your chips and **Lock**!`,
      components: [row1, row2, row3, row4],
    });
  } catch (err: any) {
    console.error('Encounter error:', err);
    await ix.reply({
      ephemeral: true,
      content: '⚠️ No eligible encounters configured for this zone. Please tell an admin.',
    });
  }
}
