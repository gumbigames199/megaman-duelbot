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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  inlineCode,
} from 'discord.js';

import { ensureStartUnlocked, listUnlocked } from '../lib/unlock';
import { getBundle, resolveShopInventory, listVirusesForRegionZone, formatChipName, listChips, chipCode, chipIsUpgrade, getChipById } from '../lib/data';
import {
  getPlayer, setRegion, setZone, getZone, listSeenViruses, getInventory,
  addZenny, spendZenny, grantChip, removeChip,
  addHPMax, addATK, addDEF, addSPD, addACC, addEvasion, addCRIT,
  getStyleProgress, getPendingStyleElement, acceptStyleChange, declineStyleChange,
  resetStyleToNeutral, normalizeStyleElement, STYLE_CHANGE_THRESHOLD,
  getXPProgress, getScaledUpgradePrice, recordUpgradePurchase, getUpgradePurchaseCount,
} from '../lib/db';
import { startBattle } from '../lib/battle';
import { chooseScaledEncounter } from '../lib/encounter-scaling';
import { createOpenPvpChallenge } from '../lib/pvp';
import { getFolder, setFolder, validateFolder, validateFolderMinimum, MAX_FOLDER, MIN_FOLDER, maxCopiesForChip, getMaxRemovableFolderSlots, getAvailableChipQty } from '../lib/folder';
import {
  listCurrentMissions, getMissionBoard, acceptBoardMission, quitMission,
  completeReadyMissions, getQuitCooldown, formatDuration, evaluateMission,
} from '../lib/missions';

const JACK_GIF =
  process.env.JACK_IN_GIF_URL ||
  process.env.JACKIN_GIF_URL ||
  undefined;

const CONFIG_GIF =
  process.env.CONFIG_GIF_URL ||
  'https://mmntwtcgcustomcards.s3.us-west-1.amazonaws.com/netbattlers/Navi+Custom.gif';

const DATA_GIF =
  process.env.DATA_GIF_URL ||
  'https://mmntwtcgcustomcards.s3.us-west-1.amazonaws.com/netbattlers/Data.gif';

const BOSS_ENCOUNTER =
  Number(process.env.BOSS_ENCOUNTER_RATE ?? process.env.BOSS_ENCOUNTER ?? 0.10);

const MENU_PAGE_SIZE = 25;

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


function getTravelImage(): string | null {
  return JACK_GIF || null;
}

function getConfigImage(): string | null {
  const text = String(CONFIG_GIF || '').trim();
  return text || getTravelImage();
}

function getDataImage(): string | null {
  const text = String(DATA_GIF || '').trim();
  return text || getTravelImage();
}

function getRegionImage(region: any): string | null {
  const raw =
    region?.gif_url ||
    region?.anim_url ||
    region?.animation_url ||
    region?.background_url ||
    region?.image_url ||
    region?.art_url ||
    null;
  const text = String(raw ?? '').trim();
  return text || null;
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
    .setImage(getRegionImage(region) || getTravelImage())
    .setFooter({ text: 'Encounter, Travel, or Shop from this same screen.' });

  const encounterBtn = new ButtonBuilder().setCustomId('jackin:encounter').setStyle(ButtonStyle.Primary).setLabel('Encounter');
  const travelBtn    = new ButtonBuilder().setCustomId('jackin:openTravel').setStyle(ButtonStyle.Secondary).setLabel('Travel');
  const shopBtn      = new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Success).setLabel('Shop');
  const dataBtn      = new ButtonBuilder().setCustomId('jackin:openData').setStyle(ButtonStyle.Secondary).setLabel('Data');
  const bbsBtn       = new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS');
  const configBtn    = new ButtonBuilder().setCustomId('jackin:openConfig').setStyle(ButtonStyle.Secondary).setLabel('PET');
  const pvpBtn       = new ButtonBuilder().setCustomId('jackin:openPvp').setStyle(ButtonStyle.Danger).setLabel('PvP');

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(encounterBtn, travelBtn, shopBtn);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(dataBtn, bbsBtn, configBtn, pvpBtn);

  if (ix.isChatInputCommand()) {
    await ix.reply({ ephemeral: true, embeds: [embed], components: [row1, row2] });
  } else if (ix.isButton()) {
    await (ix as ButtonInteraction).update({ embeds: [embed], components: [row1, row2] });
  } else {
    await (ix as StringSelectMenuInteraction).update({ embeds: [embed], components: [row1, row2] });
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
  const player = await getPlayer(ix.user.id);
  if (!player) {
    await ix.reply({
      ephemeral: true,
      content: '❌ **NetNavi not initialized.** Run **/start** first to create your Navi, then use **/jack_in**.',
    });
    return;
  }

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
    .setImage(getTravelImage())
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
  await renderTravelHome(ix);
}

async function renderTravelHome(ix: ButtonInteraction | StringSelectMenuInteraction, notice?: string) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const b: any = getBundle();
  const { region } = getCurrentRegionForPlayer(p, b);
  const currentZone = getZone(userId) || 1;

  const desc = [
    `Current Region: **${region?.name || region?.label || p?.region_id || '—'}**`,
    `Current Zone: **${currentZone}**`,
    '',
    notice ? `📌 **${notice}**` : 'Choose whether to travel to another region or move to a different zone.',
  ];

  const embed = new EmbedBuilder()
    .setTitle('🧭 Travel')
    .setDescription(desc.join('\n'))
    .setImage(getTravelImage())
    .setFooter({ text: 'Travel stays inside your active Jack-In panel.' });

  const regionBtn = new ButtonBuilder()
    .setCustomId('jackin:travelRegion')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Change Region');

  const zoneBtn = new ButtonBuilder()
    .setCustomId('jackin:travelZone')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Change Zone')
    .setDisabled(!region);

  const backBtn = new ButtonBuilder()
    .setCustomId('jackin:back')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Back');

  await ix.update({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(regionBtn, zoneBtn, backBtn)],
  });
}

export async function onTravelRegion(ix: ButtonInteraction) {
  const userId = ix.user.id;
  await ensureStartUnlocked(userId);
  const regionsUnlocked = await listUnlocked(userId);

  if (!regionsUnlocked.length) {
    const embed = new EmbedBuilder()
      .setTitle('🧭 Change Region')
      .setDescription('❌ No regions unlocked yet.');
    await ix.update({ embeds: [embed], components: [backRow()] });
    return;
  }

  const p: any = await getPlayer(userId);
  const currentRegionId = String(p?.region_id || '');

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:selectTravelRegion')
    .setPlaceholder('Select an unlocked region')
    .addOptions(
      regionsUnlocked
        .sort((a: any, b: any) => (a.min_level || 1) - (b.min_level || 1) || String(a.name).localeCompare(String(b.name)))
        .slice(0, 25)
        .map((r: any) => ({
          label: String(r.name || r.label || r.id).slice(0, 100),
          value: String(r.id),
          description: `${String(r.id) === currentRegionId ? 'Current region • ' : ''}Min Lv ${r.min_level ?? 1} • ${r.zone_count ?? 1} zones`.slice(0, 100),
          default: String(r.id) === currentRegionId,
        })),
    );

  const embed = new EmbedBuilder()
    .setTitle('🧭 Change Region')
    .setDescription('Select an unlocked region. Changing region resets your zone to **Zone 1**.')
    .setImage(getTravelImage());

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      backRow(),
    ],
  });
}

export async function onSelectTravelRegion(ix: StringSelectMenuInteraction) {
  const userId = ix.user.id;
  const regionId = ix.values[0];
  const regionsUnlocked = await listUnlocked(userId);
  const target = regionsUnlocked.find((r: any) => String(r.id) === String(regionId));

  if (!target) {
    const embed = new EmbedBuilder()
      .setTitle('🧭 Change Region')
      .setDescription('❌ That region is not unlocked.');
    await ix.update({ embeds: [embed], components: [backRow()] });
    return;
  }

  await setRegion(userId, regionId);
  await setZone(userId, 1);
  await renderJackInHUD(ix, {
    title: 'Travel Complete',
    lines: [`Moved to **${(target as any).name || (target as any).label || (target as any).id} — Zone 1**.`],
  });
}

export async function onTravelZone(ix: ButtonInteraction) {
  const userId = ix.user.id;
  const p: any = await getPlayer(userId);
  const b: any = getBundle();
  const { region } = getCurrentRegionForPlayer(p, b);

  if (!region) {
    await renderTravelHome(ix, 'No region set. Choose a region first.');
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
    .setTitle(`🧭 Change Zone — ${region.name || region.label || region.id}`)
    .setDescription([
      `Current zone: **${currentZone}**`,
      '',
      'Select a zone below. This will update the same Jack-In screen.',
    ].join('\n'))
    .setImage(getTravelImage())
    .setFooter({ text: 'Zone travel stays inside your active Jack-In panel.' });

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

  const p: any = await getPlayer(userId);
  const b: any = getBundle();
  const { region } = getCurrentRegionForPlayer(p, b);

  await renderJackInHUD(ix, {
    title: 'Travel Complete',
    lines: [`Moved to **${region?.name || region?.label || p?.region_id || 'Current Region'} — Zone ${zone}**.`],
  });
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

  const folderMinimum = validateFolderMinimum(userId, getFolder(userId));
  if (!folderMinimum.ok) {
    await renderJackInHUD(ix, {
      title: 'Folder Not Ready',
      lines: [
        `Your folder must contain exactly **${MAX_FOLDER} BattleChips** before battling.`,
        'Open **PET → Folder → Add Chips** to fill empty slots.',
      ],
    });
    return;
  }

  const b: any = getBundle();
  const regionsArr = asArray<any>(b.regions);
  const regionsMap = b.regions && !Array.isArray(b.regions) ? b.regions : null;
  const reg =
    (regionsMap ? regionsMap[regionId] : null) ||
    regionsArr.find(r => String(r?.id) === regionId);

  const requiredLevel = Number(reg?.min_level ?? 1);
  const playerLevel = Number(p?.level ?? 1);
  if (Number.isFinite(requiredLevel) && playerLevel < requiredLevel) {
    await renderJackInHUD(ix, {
      title: 'Region Locked',
      lines: [
        `**${reg?.name || reg?.label || regionId}** requires Level **${requiredLevel}**.`,
        `Your current level is **${playerLevel}**. Regions unlock by level only.`,
      ],
    });
    return;
  }

  let zone = getZone(userId) || 1;
  const maxZone = Math.max(1, Number(reg?.zone_count || 1));
  if (zone < 1 || zone > maxZone) {
    zone = 1;
    await setZone(userId, zone);
  }

  const allViruses = asArray<any>(b.viruses);
  const picked = chooseScaledEncounter({
    region_id: regionId,
    zone,
    playerLevel,
    regionMinLevel: requiredLevel,
    bossEncounterRate: BOSS_ENCOUNTER,
  });

  if (!picked) {
    const eligible = listVirusesForRegionZone({
      region_id: regionId,
      zone,
      includeNormals: true,
      includeBosses: true,
    }) as any[];
    const eligibleBosses = eligible.filter(isBossFlag);
    const eligibleNormals = eligible.filter(v => !isBossFlag(v));
    const regionSamples = Array.from(
      new Set(allViruses.map(v => String(v?.region_id ?? v?.region ?? '').trim()).filter(Boolean))
    ).slice(0, 12);

    const embed = new EmbedBuilder()
      .setTitle('⚠️ No Encounter Available')
      .setDescription(
        `No eligible encounters configured for **${reg?.name || reg?.label || regionId} / Zone ${zone}**.` +
        `

Debug — player.region_id: **${regionId}** • zone: **${zone}** • zone_count: **${reg?.zone_count ?? '?'}**` +
        `
Debug — viruses_loaded: **${allViruses.length}** • eligible: **${eligible.length}** (normals:${eligibleNormals.length} bosses:${eligibleBosses.length})` +
        (regionSamples.length ? `
Debug — virus region_id samples: ${regionSamples.join(', ')}` : '')
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
    const view = startBattle(userId, String(picked.primary.id), picked.enemy_kind, {
      returnMode: "jackin",
      enemies: picked.enemies,
    });

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
        `
Debug — player.region_id: **${regionId}** • viruses_loaded: **${allViruses.length}** • encounter_size: **${picked.enemies.length}**` +
        `
Error: ${err?.message || String(err)}`
      );
    const back = new ButtonBuilder().setCustomId('jackin:back').setStyle(ButtonStyle.Secondary).setLabel('Back');
    await ix.update({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)] });
  }

}


/* ------------------------------ Data / PET hubs ------------------------------ */

type AnyJackInInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

type ChipGroup = {
  key: string;
  name: string;
  baseId: string;
  variants: any[];
  codes: string[];
  sample: any;
};

function navButtons(...buttons: ButtonBuilder[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

function makeBackButton() {
  return new ButtonBuilder().setCustomId('jackin:back').setStyle(ButtonStyle.Secondary).setLabel('Back');
}

async function updatePanel(ix: AnyJackInInteraction, payload: { embeds: EmbedBuilder[]; components?: any[] }) {
  const anyIx: any = ix as any;
  if (typeof anyIx.update === 'function') {
    await anyIx.update({ embeds: payload.embeds, components: payload.components ?? [] });
    return;
  }
  if (typeof anyIx.reply === 'function') {
    await anyIx.reply({ embeds: payload.embeds, components: payload.components ?? [], ephemeral: true });
  }
}

/* ------------------------------ BBS Missions ------------------------------ */

export async function onOpenBbs(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('📋 BBS Mission Board')
    .setDescription([
      'Check active jobs or browse today\'s board postings.',
      '',
      '**Current** shows missions you accepted, progress, and completion status.',
      '**Board** shows 5 available missions from your unlocked regions. Open a post to view its BBS image and accept it.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'You may quit one active mission every 12 hours.' });

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:bbsCurrent').setStyle(ButtonStyle.Primary).setLabel('Current'),
      new ButtonBuilder().setCustomId('jackin:bbsBoard').setStyle(ButtonStyle.Secondary).setLabel('Board'),
      makeBackButton(),
    )],
  });
}

export async function onBbsCurrent(ix: ButtonInteraction | StringSelectMenuInteraction, notice?: string) {
  const current = listCurrentMissions(ix.user.id);
  const ready = current.filter(m => m.ready);
  const desc: string[] = [];
  if (notice) desc.push(`📌 **${notice}**`, '');

  if (!current.length) {
    desc.push('No current missions. Open the **Board** to accept a job.');
  } else {
    current.slice(0, 10).forEach((m, idx) => {
      const title = m.ready ? `**${idx + 1}. ${m.mission.name || m.mission.id} — READY**` : `**${idx + 1}. ${m.mission.name || m.mission.id}**`;
      desc.push(title);
      if (m.mission.description) desc.push(bbsTrim(String(m.mission.description), 220));
      desc.push(...m.progressLines.map(line => `  ${line}`));
      desc.push(`  Reward: ${m.rewardLines.join(' • ')}`);
      desc.push('');
    });
  }

  const quitCd = getQuitCooldown(ix.user.id);
  const embed = new EmbedBuilder()
    .setTitle('📋 BBS — Current Missions')
    .setDescription(desc.join('\n').slice(0, 3900) || '—')
    .setImage(getDataImage())
    .setFooter({ text: quitCd.ready ? 'Quit mission is available.' : `Quit cooldown: ${formatDuration(quitCd.remainingMs)} remaining.` });

  const components: any[] = [];
  if (current.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('jackin:bbsCurrentViewSelect')
      .setPlaceholder('Open a current BBS post')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(current.slice(0, 25).map((m, idx) => ({
        label: bbsTrim(`${idx + 1}. ${m.mission.name || m.mission.id}`, 100),
        value: String(m.mission.id),
        description: bbsTrim(`${m.ready ? 'READY' : 'In progress'} • View full post`, 100),
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  const buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId('jackin:bbsBoard').setStyle(ButtonStyle.Secondary).setLabel('Board'),
  ];
  if (ready.length) {
    buttons.unshift(new ButtonBuilder().setCustomId('jackin:bbsCompleteReady').setStyle(ButtonStyle.Success).setLabel('Complete Ready'));
  }
  if (current.length) {
    buttons.push(new ButtonBuilder().setCustomId('jackin:bbsQuitOpen').setStyle(ButtonStyle.Danger).setLabel('Quit Mission').setDisabled(!quitCd.ready));
  }
  buttons.push(new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS'));
  buttons.push(makeBackButton());
  components.push(navButtons(...buttons.slice(0, 5)));

  await updatePanel(ix, { embeds: [embed], components });
}

export async function onBbsBoard(ix: ButtonInteraction | StringSelectMenuInteraction, notice?: string) {
  const unlocked = (await listUnlocked(ix.user.id)).map((r: any) => String(r.id));
  const board = getMissionBoard(ix.user.id, unlocked);
  const b = getBundle() as any;

  const desc: string[] = [];
  if (notice) desc.push(`📌 **${notice}**`, '');
  if (!board.missions.length) {
    desc.push('No available BBS missions for your unlocked regions. Complete current jobs or unlock more regions.');
  } else {
    board.missions.forEach((m: any, idx: number) => {
      const ev = evaluateMission(ix.user.id, m);
      const region = b.regions?.[String(m.region_id)];
      desc.push(`**${idx + 1}. ${m.name || m.id}**`);
      desc.push(`Region: **${region?.name || region?.label || m.region_id || '—'}** • Type: **${m.type || 'Mission'}**`);
      if (m.description) desc.push(bbsTrim(String(m.description), 220));
      desc.push(`Requirement: ${ev.progressLines.map(x => x.replace(/^•\s*/, '')).join(' • ')}`);
      desc.push(`Reward: ${ev.rewardLines.join(' • ')}`);
      desc.push('');
    });
  }

  const minutes = Math.max(1, Math.ceil((board.refreshAt - Date.now()) / 60000));
  const embed = new EmbedBuilder()
    .setTitle('📋 BBS — Board')
    .setDescription(desc.join('\n').slice(0, 3900) || '—')
    .setImage(getDataImage())
    .setFooter({ text: `Board refreshes in ${minutes >= 60 ? formatDuration(minutes * 60000) : `${minutes}m`}.` });

  const components: any[] = [];
  if (board.missions.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('jackin:bbsBoardViewSelect')
      .setPlaceholder('Open a BBS post')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(board.missions.slice(0, 25).map((m: any) => ({
        label: bbsTrim(`${m.id}. ${m.name || m.id}`, 100),
        value: String(m.id),
        description: bbsTrim(`${m.type || 'Mission'} • ${m.region_id || 'Any Region'} • View post`, 100),
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  components.push(navButtons(
    new ButtonBuilder().setCustomId('jackin:bbsCurrent').setStyle(ButtonStyle.Primary).setLabel('Current'),
    new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS'),
    makeBackButton(),
  ));

  await updatePanel(ix, { embeds: [embed], components });
}

export async function onBbsBoardViewSelect(ix: StringSelectMenuInteraction) {
  const missionId = ix.values[0];
  await renderBbsMissionPost(ix, missionId);
}

export async function onBbsCurrentViewSelect(ix: StringSelectMenuInteraction) {
  const missionId = ix.values[0];
  await renderBbsCurrentMissionPost(ix, missionId);
}

export async function onBbsAccept(ix: ButtonInteraction, missionId: string) {
  const unlocked = (await listUnlocked(ix.user.id)).map((r: any) => String(r.id));
  const res = acceptBoardMission(ix.user.id, missionId, unlocked);
  if (!res.ok) {
    await onBbsBoard(ix, res.msg);
    return;
  }
  await onBbsCurrent(ix, `Accepted mission ${missionId}.`);
}

async function renderBbsMissionPost(ix: ButtonInteraction | StringSelectMenuInteraction, missionId: string, notice?: string) {
  const unlocked = (await listUnlocked(ix.user.id)).map((r: any) => String(r.id));
  const board = getMissionBoard(ix.user.id, unlocked);
  const mission = board.missions.find((m: any) => String(m.id) === String(missionId));

  if (!mission) {
    await onBbsBoard(ix, 'That BBS post is no longer available on your current board.');
    return;
  }

  const b = getBundle() as any;
  const region = b.regions?.[String(mission.region_id)];
  const ev = evaluateMission(ix.user.id, mission);
  const image = getMissionImage(mission) || getDataImage();

  const desc = [
    notice ? `📌 **${notice}**` : '',
    `Region: **${region?.name || region?.label || mission.region_id || '—'}**`,
    `Type: **${mission.type || 'Mission'}**`,
    '',
    mission.description ? String(mission.description) : '—',
    '',
    '**Requirement**',
    ...ev.progressLines.map(line => line.replace(/^•\s*/, '• ')),
    '',
    '**Reward**',
    ev.rewardLines.join(' • '),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(`📋 BBS Post — ${mission.name || mission.id}`)
    .setDescription(desc.join('\n').slice(0, 3900))
    .setImage(image)
    .setFooter({ text: `Mission ID: ${mission.id}` });

  await updatePanel(ix, {
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId(`jackin:bbsAccept:${mission.id}`).setStyle(ButtonStyle.Success).setLabel('Accept Mission'),
      new ButtonBuilder().setCustomId('jackin:bbsBoard').setStyle(ButtonStyle.Secondary).setLabel('Back to Board'),
      new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS'),
    )],
  });
}

async function renderBbsCurrentMissionPost(ix: ButtonInteraction | StringSelectMenuInteraction, missionId: string, notice?: string) {
  const current = listCurrentMissions(ix.user.id);
  const row = current.find(m => String(m.mission.id) === String(missionId));

  if (!row) {
    await onBbsCurrent(ix, 'That mission is no longer in your current BBS jobs.');
    return;
  }

  const b = getBundle() as any;
  const mission = row.mission;
  const region = b.regions?.[String(mission.region_id)];
  const image = getMissionImage(mission) || getDataImage();

  const desc = [
    notice ? `📌 **${notice}**` : '',
    row.ready ? '**READY TO COMPLETE**' : '**IN PROGRESS**',
    `Region: **${region?.name || region?.label || mission.region_id || '—'}**`,
    `Type: **${mission.type || 'Mission'}**`,
    '',
    mission.description ? String(mission.description) : '—',
    '',
    '**Progress**',
    ...row.progressLines.map(line => line.replace(/^•\s*/, '• ')),
    '',
    '**Reward**',
    row.rewardLines.join(' • '),
  ].filter(Boolean);

  const buttons: ButtonBuilder[] = [];
  if (row.ready) {
    buttons.push(new ButtonBuilder().setCustomId('jackin:bbsCompleteReady').setStyle(ButtonStyle.Success).setLabel('Complete Ready'));
  }
  buttons.push(new ButtonBuilder().setCustomId('jackin:bbsCurrent').setStyle(ButtonStyle.Secondary).setLabel('Back to Current'));
  buttons.push(new ButtonBuilder().setCustomId('jackin:openBbs').setStyle(ButtonStyle.Secondary).setLabel('BBS'));

  const embed = new EmbedBuilder()
    .setTitle(`📋 Current BBS Post — ${mission.name || mission.id}`)
    .setDescription(desc.join('\n').slice(0, 3900))
    .setImage(image)
    .setFooter({ text: `Mission ID: ${mission.id}` });

  await updatePanel(ix, {
    embeds: [embed],
    components: [navButtons(...buttons)],
  });
}

function getMissionImage(mission: any): string | null {
  const raw = mission?.image_url || mission?.image || mission?.art_url || mission?.post_url || null;
  const text = String(raw ?? '').trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

export async function onBbsCompleteReady(ix: ButtonInteraction) {
  const res = completeReadyMissions(ix.user.id);
  const lines: string[] = [];
  if (res.completed.length) lines.push(`Completed: ${res.completed.join(', ')}`);
  if (res.rewardZ) lines.push(`Rewards: +${res.rewardZ}z`);
  if (res.rewardChips.length) lines.push(`Chips: ${res.rewardChips.join(', ')}`);
  if (res.failed.length) lines.push(...res.failed);
  await onBbsCurrent(ix, lines.join(' • ') || 'No missions were ready to complete.');
}

export async function onBbsQuitOpen(ix: ButtonInteraction) {
  const current = listCurrentMissions(ix.user.id);
  const cd = getQuitCooldown(ix.user.id);
  if (!cd.ready) {
    await onBbsCurrent(ix, `Mission quit is on cooldown. Try again in ${formatDuration(cd.remainingMs)}.`);
    return;
  }
  if (!current.length) {
    await onBbsCurrent(ix, 'No active missions to quit.');
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:bbsQuitSelect')
    .setPlaceholder('Select a mission to quit')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(current.slice(0, 25).map(m => ({
      label: bbsTrim(`${m.mission.id}. ${m.mission.name || m.mission.id}`, 100),
      value: String(m.mission.id),
      description: 'Quit mission and reset progress',
    })));

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Quit Mission?')
    .setDescription([
      'Choose one mission to quit.',
      '',
      'This resets that mission\'s progress. You may quit only **one mission every 12 hours**.',
    ].join('\n'))
    .setImage(getDataImage());

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      navButtons(new ButtonBuilder().setCustomId('jackin:bbsCurrent').setStyle(ButtonStyle.Secondary).setLabel('Cancel')),
    ],
  });
}

export async function onBbsQuitSelect(ix: StringSelectMenuInteraction) {
  const missionId = ix.values[0];
  const res = quitMission(ix.user.id, missionId);
  await onBbsCurrent(ix, res.msg);
}

function bbsTrim(text: string, max: number): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export async function onOpenData(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('📡 Data')
    .setDescription([
      'Access reference data from the same Jack-In screen.',
      '',
      '**Chip Index** searches BattleChips and code variants.',
      '**VirusDex** shows only viruses you have encountered.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'Data screens do not change your current region or zone.' });

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:dataChip').setStyle(ButtonStyle.Secondary).setLabel('Chip Index'),
      new ButtonBuilder().setCustomId('jackin:dataVirus').setStyle(ButtonStyle.Secondary).setLabel('VirusDex'),
      makeBackButton(),
    )],
  });
}

export async function onDataChip(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('📦 Chip Index')
    .setDescription([
      'Browse grouped BattleChips or search by chip name/keyword.',
      '',
      'Search opens a Discord text modal. Results stay in this Jack-In panel.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'Grouped by base chip; all available codes are shown together.' });

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:dataChipAll').setStyle(ButtonStyle.Secondary).setLabel('Browse All'),
      new ButtonBuilder().setCustomId('jackin:dataChipSearch').setStyle(ButtonStyle.Secondary).setLabel('Search Chip'),
      new ButtonBuilder().setCustomId('jackin:openData').setStyle(ButtonStyle.Secondary).setLabel('Back'),
    )],
  });
}

export async function onDataChipAll(ix: ButtonInteraction) {
  await renderChipIndexPanel(ix, '', 1);
}

export async function onDataChipPage(ix: ButtonInteraction, page: number) {
  await renderChipIndexPanel(ix, '', page);
}

export async function onDataChipSearch(ix: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('jackin:chipSearchModal')
    .setTitle('Search Chip Index');

  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Chip name or keyword')
    .setPlaceholder('Sword, Cannon, Aqua, Atk+10...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await ix.showModal(modal);
}

export async function onChipSearchModal(ix: ModalSubmitInteraction) {
  const q = ix.fields.getTextInputValue('query').trim();
  await renderChipIndexPanel(ix, q, 1);
}

async function renderChipIndexPanel(ix: AnyJackInInteraction, search: string, page = 1) {
  const q = search.trim().toLowerCase();
  let groups = groupChips(listChips() as any[]).filter(g => !chipIsUpgrade(g.sample));

  if (q) {
    const exact = groups.filter((g) =>
      g.name.toLowerCase() === q ||
      g.baseId.toLowerCase() === q ||
      g.key.toLowerCase() === q
    );
    groups = exact.length ? exact : groups.filter((g) => chipGroupMatches(g, q));
  }

  groups.sort((a, b) => a.name.localeCompare(b.name) || a.baseId.localeCompare(b.baseId));

  const perPage = 12;
  const pages = Math.max(1, Math.ceil(groups.length / perPage));
  const pageClamped = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), pages);

  const baseButtons = navButtons(
    new ButtonBuilder().setCustomId('jackin:dataChipSearch').setStyle(ButtonStyle.Secondary).setLabel('Search Again'),
    new ButtonBuilder().setCustomId('jackin:dataChip').setStyle(ButtonStyle.Secondary).setLabel('Back'),
  );

  if (groups.length === 1) {
    await updatePanel(ix, { embeds: [buildChipDetailEmbed(groups[0], search)], components: [baseButtons] });
    return;
  }

  const start = (pageClamped - 1) * perPage;
  const slice = groups.slice(start, start + perPage);
  const lines = slice.map(formatChipGroupLine);
  const embed = new EmbedBuilder()
    .setTitle(search ? `📦 Chip Index — ${search}` : '📦 Chip Index — Browse')
    .setDescription([
      groups.length ? `Page **${pageClamped}/${pages}** • Showing **${slice.length}** of **${groups.length}** grouped chip(s).` : 'No matching chips found.',
      '',
      ...(lines.length ? lines : ['—']),
      '',
      q ? 'Use **Search Again** to narrow the results, or **Back** to return to Chip Index.' : 'Use **Previous** and **Next** to browse all chips, or **Search Again** for a specific chip.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'Grouped by base chip; variants are not duplicated.' });

  const components: any[] = [];
  if (!q && pages > 1) {
    components.push(navButtons(
      new ButtonBuilder()
        .setCustomId(`jackin:dataChipPage:${Math.max(1, pageClamped - 1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Previous')
        .setDisabled(pageClamped <= 1),
      new ButtonBuilder()
        .setCustomId(`jackin:dataChipPage:${Math.min(pages, pageClamped + 1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Next')
        .setDisabled(pageClamped >= pages),
    ));
  }
  components.push(baseButtons);

  await updatePanel(ix, { embeds: [embed], components });
}

export async function onDataVirus(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('🧾 VirusDex')
    .setDescription([
      'Browse encountered viruses or search by name, element, region, zone, move, or drop table.',
      '',
      'Search opens a Discord text modal. Results stay in this Jack-In panel.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'VirusDex only shows viruses you have encountered.' });

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:dataVirusAll').setStyle(ButtonStyle.Secondary).setLabel('Browse Seen'),
      new ButtonBuilder().setCustomId('jackin:dataVirusSearch').setStyle(ButtonStyle.Secondary).setLabel('Search Virus'),
      new ButtonBuilder().setCustomId('jackin:openData').setStyle(ButtonStyle.Secondary).setLabel('Back'),
    )],
  });
}

export async function onDataVirusAll(ix: ButtonInteraction) {
  await renderVirusDexPanel(ix, '', 1);
}

export async function onDataVirusPage(ix: ButtonInteraction, page: number) {
  await renderVirusDexPanel(ix, '', page);
}

export async function onDataVirusSearch(ix: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('jackin:virusSearchModal')
    .setTitle('Search VirusDex');

  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Virus name, region, element, or keyword')
    .setPlaceholder('Mettaur, Fire, ACDC, Zone 2, Blast...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await ix.showModal(modal);
}

export async function onVirusSearchModal(ix: ModalSubmitInteraction) {
  const q = ix.fields.getTextInputValue('query').trim();
  await renderVirusDexPanel(ix, q, 1);
}

async function renderVirusDexPanel(ix: AnyJackInInteraction, search: string, page: number) {
  const b = getBundle() as any;
  const q = String(search || '').trim().toLowerCase();
  let seen = listSeenViruses(ix.user.id).map(String).filter(id => b.viruses?.[id]);

  seen.sort((a, bId) => String(b.viruses[a]?.name || a).localeCompare(String(b.viruses[bId]?.name || bId)));

  if (q) {
    const exact = seen.filter(id => {
      const v = b.viruses[id];
      return String(id).toLowerCase() === q || String(v?.name || '').toLowerCase() === q;
    });
    seen = exact.length ? exact : seen.filter(id => virusDexMatches(id, b.viruses[id], b.regions, q));
  }

  const baseButtons = navButtons(
    new ButtonBuilder().setCustomId('jackin:dataVirusSearch').setStyle(ButtonStyle.Secondary).setLabel(q ? 'Search Again' : 'Search Virus'),
    new ButtonBuilder().setCustomId('jackin:dataVirus').setStyle(ButtonStyle.Secondary).setLabel('Back'),
  );

  if (!seen.length) {
    const embed = new EmbedBuilder()
      .setTitle(q ? `🧾 VirusDex — ${search}` : '🧾 VirusDex — Browse')
      .setDescription(q ? 'No encountered viruses matched that search.' : 'You have not encountered any viruses yet.')
      .setImage(getDataImage());
    await updatePanel(ix, { embeds: [embed], components: [baseButtons] });
    return;
  }

  if (seen.length === 1) {
    const embed = buildVirusDexDetailEmbed(ix.user.id, seen[0]);
    await updatePanel(ix, { embeds: [embed], components: [baseButtons] });
    return;
  }

  const perPage = 12;
  const pages = Math.max(1, Math.ceil(seen.length / perPage));
  const pageSafe = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const pageItems = seen.slice((pageSafe - 1) * perPage, pageSafe * perPage);
  const lines = pageItems.map((id, idx) => {
    const v = b.viruses[id];
    const n = (pageSafe - 1) * perPage + idx + 1;
    const location = formatVirusLocation(v, b.regions).replace(/\*\*/g, '');
    const boss = isBossFlag(v) ? ' • Boss' : '';
    return `**${n}. ${v?.name || id}** — ${v?.element || 'Neutral'} • HP ${v?.hp ?? '?'}${boss}\n${location}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(q ? `🧾 VirusDex — ${search}` : '🧾 VirusDex — Browse')
    .setDescription([
      `Page **${pageSafe}/${pages}** • Showing **${pageItems.length}** of **${seen.length}** encountered virus entr${seen.length === 1 ? 'y' : 'ies'}.`,
      '',
      ...lines,
      '',
      'Use the dropdown to open a full VirusDex entry, or search for a specific virus.',
    ].join('\n'))
    .setImage(getDataImage())
    .setFooter({ text: 'VirusDex only shows viruses you have encountered.' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:dataVirusSelect')
    .setPlaceholder(`Open VirusDex entry — Page ${pageSafe}/${pages}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageItems.map(id => {
      const v = b.viruses[id];
      return {
        label: String(v?.name || id).slice(0, 100),
        value: id,
        description: `${v?.element || 'Neutral'} • HP ${v?.hp ?? '?'} • ${formatVirusLocation(v, b.regions).replace(/\*\*/g, '')}`.slice(0, 100),
      };
    }));

  const components: any[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];

  if (!q && pages > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`jackin:dataVirusPage:${Math.max(1, pageSafe - 1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Previous')
        .setDisabled(pageSafe <= 1),
      new ButtonBuilder()
        .setCustomId(`jackin:dataVirusPage:${Math.min(pages, pageSafe + 1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Next')
        .setDisabled(pageSafe >= pages),
    ));
  }

  components.push(baseButtons);
  await updatePanel(ix, { embeds: [embed], components });
}

export async function onDataVirusSelect(ix: StringSelectMenuInteraction) {
  const id = ix.values[0];
  const embed = buildVirusDexDetailEmbed(ix.user.id, id);
  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:dataVirus').setStyle(ButtonStyle.Secondary).setLabel('Back'),
      new ButtonBuilder().setCustomId('jackin:openData').setStyle(ButtonStyle.Secondary).setLabel('Data'),
      makeBackButton(),
    )],
  });
}

function virusDexMatches(id: string, v: any, regions: Record<string, any>, q: string): boolean {
  const hay = [
    id,
    v?.name,
    v?.description,
    v?.element,
    v?.region_id,
    v?.region,
    formatVirusLocation(v, regions).replace(/\*\*/g, ''),
    String(v?.zone ?? ''),
    String(v?.zones ?? ''),
    v?.drop_table_id,
    v?.move_1json,
    v?.move_2json,
    v?.move_3json,
    v?.move_4json,
  ].map(x => String(x ?? '').toLowerCase()).join(' ');
  return hay.includes(q);
}

export async function onOpenConfig(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('📟 PET')
    .setDescription([
      'Manage your Navi and folder from the same Jack-In screen.',
      '',
      '**Profile** shows stats, zenny, and inventory preview.',
      '**Folder** lets you view, add, and remove BattleChips.',
    ].join('\n'))
    .setImage(getConfigImage());

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:configProfile').setStyle(ButtonStyle.Secondary).setLabel('Profile'),
      new ButtonBuilder().setCustomId('jackin:configFolder').setStyle(ButtonStyle.Secondary).setLabel('Folder'),
      makeBackButton(),
    )],
  });
}

export async function onConfigProfile(ix: ButtonInteraction, notice?: string) {
  await ix.update({
    embeds: [buildProfileEmbed(ix.user.id, ix.user.username, ix.user.displayAvatarURL(), notice)],
    components: buildProfileComponents(ix.user.id),
  });
}

function buildProfileComponents(userId: string) {
  const p: any = getPlayer(userId);
  const currentStyle = normalizeStyleElement(p?.element);
  const pending = getPendingStyleElement(userId);

  const buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId('jackin:openConfig').setStyle(ButtonStyle.Secondary).setLabel('PET'),
  ];

  if (pending) {
    buttons.push(
      new ButtonBuilder().setCustomId(`jackin:styleAccept:${pending}`).setStyle(ButtonStyle.Success).setLabel(`Accept ${pending} Style`),
      new ButtonBuilder().setCustomId(`jackin:styleDecline:${pending}`).setStyle(ButtonStyle.Secondary).setLabel('Keep Current Style'),
    );
  } else if (currentStyle) {
    buttons.push(
      new ButtonBuilder().setCustomId('jackin:styleNeutralPrompt').setStyle(ButtonStyle.Danger).setLabel('Return to Neutral'),
    );
  }

  buttons.push(makeBackButton());
  return [navButtons(...buttons.slice(0, 5))];
}


export async function onStyleAccept(ix: ButtonInteraction, elementRaw: string) {
  const element = normalizeStyleElement(elementRaw);
  if (!element) {
    await ix.reply({ ephemeral: true, content: 'Invalid Style Change element.' });
    return;
  }

  acceptStyleChange(ix.user.id, element);
  await renderJackInHUD(ix, {
    title: `${styleEmoji(element)} ${element} Style Equipped`,
    lines: [
      `Your Navi changed to **${element} Style**.`,
      'Style Change progress has been reset.',
    ],
  });
}

export async function onStyleDecline(ix: ButtonInteraction, elementRaw: string) {
  const element = normalizeStyleElement(elementRaw) || getPendingStyleElement(ix.user.id);
  declineStyleChange(ix.user.id, elementRaw);
  await renderJackInHUD(ix, {
    title: 'Style Change Declined',
    lines: [
      `Kept current style. ${element ? `${styleEmoji(element)} ${element} Style was not applied.` : ''}`.trim(),
      'Your Style Change record remains visible in PET → Profile.',
    ],
  });
}

export async function onStyleNeutralPrompt(ix: ButtonInteraction) {
  const p: any = getPlayer(ix.user.id);
  const currentStyle = normalizeStyleElement(p?.element);

  if (!currentStyle) {
    await onConfigProfile(ix, 'Your Navi is already Neutral Style.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Return to Neutral Style?')
    .setDescription([
      `Your Navi will discard **${currentStyle} Style** and return to **Neutral Style**.`,
      '',
      'This will reset all Style Change progress:',
      '🔥 Fire / 💧 Aqua / ⚡ Elec / 🌿 Wood will all return to 0.',
      '',
      'This cannot be undone.',
    ].join('\n'))
    .setImage(getConfigImage());

  await ix.update({
    embeds: [embed],
    components: [navButtons(
      new ButtonBuilder().setCustomId('jackin:styleNeutralConfirm').setStyle(ButtonStyle.Danger).setLabel('Confirm Return to Neutral'),
      new ButtonBuilder().setCustomId('jackin:configProfile').setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
    )],
  });
}

export async function onStyleNeutralConfirm(ix: ButtonInteraction) {
  const res = resetStyleToNeutral(ix.user.id);
  await onConfigProfile(ix, `Style discarded. ${res.previous || 'Current'} Style was removed and all Style Change progress was reset.`);
}

export async function onConfigFolder(ix: ButtonInteraction | StringSelectMenuInteraction, notice?: string) {
  const folder = getFolder(ix.user.id);
  const embed = new EmbedBuilder()
    .setTitle('🗂️ Folder')
    .setDescription([
      notice ? `📌 **${notice}**\n` : '',
      formatFolderPanel(folder),
    ].filter(Boolean).join('\n'))
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` })
    .setImage(getConfigImage());

  const addBtn = new ButtonBuilder().setCustomId('jackin:configFolderAdd').setStyle(ButtonStyle.Secondary).setLabel('Add Chips');
  const maxRemovable = getMaxRemovableFolderSlots(ix.user.id, folder.length);
  const remBtn = new ButtonBuilder().setCustomId('jackin:configFolderRemove').setStyle(ButtonStyle.Secondary).setLabel('Remove Chips').setDisabled(maxRemovable <= 0);
  const saveBtn = new ButtonBuilder().setCustomId('jackin:configFolderSave').setStyle(ButtonStyle.Success).setLabel('Save');
  const cfgBtn = new ButtonBuilder().setCustomId('jackin:openConfig').setStyle(ButtonStyle.Secondary).setLabel('Back');

  await ix.update({ embeds: [embed], components: [navButtons(addBtn, remBtn, saveBtn, cfgBtn)] });
}

export async function onConfigFolderSave(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  const v = validateFolderMinimum(ix.user.id, folder);
  if (!v.ok) {
    await onConfigFolder(ix, `Could not save folder: ${v.error}`);
    return;
  }
  await onConfigFolder(ix, 'Folder saved. Your folder is valid for battle.');
}

export async function onConfigFolderAdd(ix: ButtonInteraction, page = 0) {
  let inv = getInventory(ix.user.id);
  const folder = getFolder(ix.user.id);
  const folderCounts = countValues(folder);

  const allOptions = inv
    .filter(row => Number(row.qty) > 0)
    .map(row => {
      const chipId = String(row.chip_id);
      const chip: any = getChipById(chipId);
      return { row, chipId, chip };
    })
    .map(({ row, chipId, chip }) => ({ row, chipId, chip, available: availableOutsideFolder(row, folderCounts) }))
    .filter(({ chip, available }) => chip && !chipIsUpgrade(chip) && available > 0)
    .map(({ row, chipId, chip, available }) => {
      const cap = maxCopiesForChip(chipId);
      return {
        label: `${formatChipName(chip)} (available ${available}/${row.qty}, cap ${cap})`.slice(0, 100),
        value: chipId,
        description: String(chip?.element || 'BattleChip').slice(0, 100),
      };
    });

  const pageCount = Math.max(1, Math.ceil(allOptions.length / MENU_PAGE_SIZE));
  const pageSafe = clampPage(page, pageCount);
  const options = allOptions.slice(pageSafe * MENU_PAGE_SIZE, (pageSafe + 1) * MENU_PAGE_SIZE);

  if (!allOptions.length) {
    await onConfigFolder(ix, 'You have no available BattleChip copies outside your folder to add.');
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`jackin:folderAddSelect:${pageSafe}`)
    .setPlaceholder('Select chips to add')
    .setMinValues(1)
    .setMaxValues(Math.min(10, options.length))
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setTitle('🗂️ Add Chips')
    .setDescription(`Select owned chip copies that are not already committed to your folder. Page **${pageSafe + 1}/${pageCount}**.`)
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` })
    .setImage(getConfigImage());

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      navButtons(
        new ButtonBuilder().setCustomId(`jackin:configFolderAddPage:${Math.max(0, pageSafe - 1)}`).setStyle(ButtonStyle.Secondary).setLabel('Previous').setDisabled(pageSafe <= 0),
        new ButtonBuilder().setCustomId(`jackin:configFolderAddPage:${Math.min(pageCount - 1, pageSafe + 1)}`).setStyle(ButtonStyle.Secondary).setLabel('Next').setDisabled(pageSafe >= pageCount - 1),
        new ButtonBuilder().setCustomId('jackin:configFolder').setStyle(ButtonStyle.Secondary).setLabel('Back'),
      ),
    ],
  });
}

export async function onConfigFolderRemove(ix: ButtonInteraction) {
  const folder = getFolder(ix.user.id);
  if (!folder.length) {
    await onConfigFolder(ix, 'Folder is empty.');
    return;
  }

  const maxRemovable = getMaxRemovableFolderSlots(ix.user.id, folder.length);
  const options = folder.slice(0, 25).map((id, i) => {
    const c: any = getChipById(id) || {};
    return {
      label: `${i + 1}. ${formatChipName(c || id)}`.slice(0, 100),
      value: `${i}:${id}`,
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId('jackin:folderRemoveSelect')
    .setPlaceholder('Select folder slots to remove')
    .setMinValues(1)
    .setMaxValues(Math.min(10, options.length, maxRemovable))
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setTitle('🗂️ Remove Chips')
    .setDescription('Select one or more folder entries to remove.')
    .setFooter({ text: `${folder.length}/${MAX_FOLDER} • Required exactly ${MAX_FOLDER}` })
    .setImage(getConfigImage());

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      navButtons(new ButtonBuilder().setCustomId('jackin:configFolder').setStyle(ButtonStyle.Secondary).setLabel('Back')),
    ],
  });
}

export async function onConfigFolderAddPage(ix: ButtonInteraction, page = 0) {
  await onConfigFolderAdd(ix, page);
}

export async function onConfigFolderAddSelect(ix: StringSelectMenuInteraction) {
  let folder = getFolder(ix.user.id);
  for (const rawId of ix.values) {
    const id = String(rawId);
    const chip = getChipById(id);
    if (!chip || chipIsUpgrade(chip)) continue;
    folder = [...folder, id];
  }

  const v = validateFolder(ix.user.id, folder);
  if (!v.ok) {
    await onConfigFolder(ix, `Could not add chips: ${v.error}`);
    return;
  }

  setFolder(ix.user.id, folder);
  await onConfigFolder(ix, 'Folder updated.');
}

export async function onConfigFolderRemoveSelect(ix: StringSelectMenuInteraction) {
  const folder = getFolder(ix.user.id);
  const indexes = ix.values
    .map(v => parseInt(String(v).split(':')[0], 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a);

  for (const idx of indexes) {
    if (idx >= 0 && idx < folder.length) folder.splice(idx, 1);
  }

  const v = validateFolder(ix.user.id, folder);
  if (!v.ok) {
    await onConfigFolder(ix, `Could not remove chips: ${v.error}`);
    return;
  }

  setFolder(ix.user.id, folder);
  await onConfigFolder(ix, 'Folder updated.');
}


function xpBar(userId: string): string {
  const xp = getXPProgress(userId) as any;
  const cur = Math.max(0, Number(xp?.xp_into_level ?? 0));
  const max = Math.max(1, Number(xp?.xp_needed_for_next ?? xp?.next_threshold ?? 1));
  const ratio = Math.max(0, Math.min(1, cur / max));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  return `${cur} XP ${'🟦'.repeat(filled)}${'⬛'.repeat(empty)} ${max} XP`;
}

function buildProfileEmbed(userId: string, username: string, avatarUrl: string, notice?: string) {
  const p: any = getPlayer(userId);
  const invLine = formatInventoryTop(userId, 12);
  const progress = getStyleProgress(userId);
  const currentStyle = String(p?.element || 'Neutral');
  const pending = getPendingStyleElement(userId);

  const desc = [
    notice ? `📌 **${notice}**` : '',
    pending ? `${styleEmoji(pending)} **${pending} Style Change Available**` : '',
  ].filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}.EXE`, iconURL: avatarUrl })
    .setTitle('⚙️ Navi Profile')
    .setThumbnail(avatarUrl)
    .setImage(getConfigImage())
    .addFields(
      { name: '🧬 Current Style', value: currentStyle, inline: true },
      { name: '⭐ Level', value: String(p?.level ?? 1), inline: true },
      { name: '❤️ HP', value: String(p?.hp_max ?? 100), inline: true },
      { name: '🔵 EXP', value: xpBar(userId), inline: false },
      {
        name: '📊 Stats',
        value:
          `ATK ${p?.atk ?? 0} • DEF ${p?.def ?? 0} • SPD ${p?.spd ?? 0}\n` +
          `ACC ${p?.acc ?? 100}% • EVA ${p?.evasion ?? 0}% • CRIT ${p?.crit ?? 0}%`,
        inline: false,
      },
      { name: '🧬 Style Progress', value: formatStyleProgress(progress), inline: false },
      { name: '💰 Zenny', value: String(p?.zenny ?? 0), inline: true },
      { name: '🎒 Inventory Preview', value: invLine, inline: false },
    );

  if (desc) embed.setDescription(desc);
  return embed;
}

function formatStyleProgress(progress: any): string {
  const threshold = Number(progress?.threshold || STYLE_CHANGE_THRESHOLD || 500);
  return [
    `🔥 Fire: ${Number(progress?.fire_points || 0)}/${threshold}`,
    `💧 Aqua: ${Number(progress?.aqua_points || 0)}/${threshold}`,
    `⚡ Elec: ${Number(progress?.elec_points || 0)}/${threshold}`,
    `🌿 Wood: ${Number(progress?.wood_points || 0)}/${threshold}`,
  ].join('\n');
}

function styleEmoji(element: string): string {
  switch (String(element)) {
    case 'Fire': return '🔥';
    case 'Aqua': return '💧';
    case 'Elec': return '⚡';
    case 'Wood': return '🌿';
    default: return '🧬';
  }
}


function formatInventoryTop(userId: string, limit = 12): string {
  const rows = getInventory(userId) || [];
  const pretty = rows
    .map((r: any) => {
      const rawId = String(r.chip_id);
      const chip: any = getChipById(rawId);
      const available = getAvailableChipQty(userId, rawId);
      return { chip, qty: available, rawId };
    })
    .filter(({ chip, qty }) => qty > 0 && chip && !chipIsUpgrade(chip))
    .map(({ chip, qty, rawId }) => `${formatChipName(chip || rawId)} ×${qty}`);
  return pretty.length ? pretty.slice(0, limit).join(' • ') : '—';
}

function formatFolderPanel(chips: string[]): string {
  if (!chips.length) return '— (empty)';
  const counts = countValues(chips);
  const lines: string[] = [];
  for (const [id, qty] of counts) {
    const c: any = getChipById(id) || {};
    lines.push(`• ${formatChipName(c || id)} ×${qty}`);
  }
  return lines.slice(0, 30).join('\n');
}

function clampPage(page: number, pageCount: number): number {
  const p = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.max(0, Math.min(Math.max(1, pageCount) - 1, p));
}

function countValues(values: string[]) {
  const out = new Map<string, number>();
  for (const v of values) out.set(String(v), (out.get(String(v)) || 0) + 1);
  return out;
}

function availableOutsideFolder(row: any, folderCounts: Map<string, number>): number {
  const owned = Math.max(0, Number(row?.qty ?? 0) || 0);
  const inFolder = Math.max(0, folderCounts.get(String(row?.chip_id)) || 0);
  return Math.max(0, owned - inFolder);
}

function groupChips(chips: any[]): ChipGroup[] {
  const byKey = new Map<string, any[]>();
  for (const c of chips) {
    if (!c) continue;
    const name = clean(c.name ?? c.id);
    const baseId = clean(c.base_id ?? c.baseId ?? c.base ?? name);
    const key = (baseId || name || clean(c.id)).toLowerCase();
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }

  const groups: ChipGroup[] = [];
  for (const [key, variants] of byKey) {
    variants.sort((a, b) => codeSortValue(codeOf(a)) - codeSortValue(codeOf(b)) || clean(a.id).localeCompare(clean(b.id)));
    const sample = variants.find((c) => chipImage(c)) ?? variants[0] ?? {};
    const name = clean(sample?.name ?? sample?.base_id ?? sample?.id ?? key);
    const baseId = clean(sample?.base_id ?? sample?.baseId ?? sample?.base ?? name);
    groups.push({ key, name, baseId, variants, codes: collectCodes(variants), sample });
  }
  return groups;
}

function chipGroupMatches(g: ChipGroup, q: string): boolean {
  if (!q) return true;
  if (g.name.toLowerCase().includes(q)) return true;
  if (g.baseId.toLowerCase().includes(q)) return true;
  if (g.key.toLowerCase().includes(q)) return true;
  if (g.codes.some((c) => c.toLowerCase().includes(q))) return true;
  return g.variants.some((c) => [c.id, c.name, c.base_id, c.baseId, c.element, c.category, c.effects, c.description, c.rarity]
    .map(x => clean(x).toLowerCase()).some(x => x.includes(q)));
}

function buildChipDetailEmbed(group: ChipGroup, rawSearch: string) {
  const c = group.sample ?? {};
  const stats = [
    statLine('Element', c.element),
    statLine('Category', c.category),
    statLine('Power', numText(c.power)),
    statLine('Hits', numText(c.hits)),
    statLine('Accuracy', pctText(c.acc)),
    statLine('MB', numText(c.mb_cost ?? c.mb)),
    statLine('Rarity', numText(c.rarity)),
    statLine('Price', priceText(c.zenny_cost)),
    statLine('Max Copies', numText(c.max_copies)),
  ].filter(Boolean).join('\n') || '—';

  const pa = findProgramAdvanceForChip(group);
  const idFieldName = pa ? 'Program Advance ID' : 'Variant IDs';
  const idFieldValue = pa
    ? inlineCode(clean(pa.id ?? c.id ?? group.baseId ?? group.key))
    : group.variants.map(v => inlineCode(clean(v.id))).join(' ') || '—';

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (pa) {
    fields.push({ name: 'Program Advance Combo', value: formatProgramAdvanceCombo(pa), inline: false });
  } else {
    fields.push({ name: 'Codes', value: group.codes.length ? group.codes.map(x => inlineCode(x)).join(' ') : '—', inline: false });
  }
  fields.push(
    { name: 'Stats', value: stats, inline: false },
    { name: 'Effects', value: clean(c.effects) || '—', inline: false },
    { name: idFieldName, value: idFieldValue, inline: false },
  );

  const embed = new EmbedBuilder()
    .setTitle(`📦 Chip Index — ${group.name}`)
    .setDescription(clean(c.description) || '—')
    .addFields(...fields)
    .setFooter({ text: `Base ID: ${group.baseId || group.key}` });
  const img = chipImage(c);
  embed.setImage(img || getDataImage());
  return embed;
}

function formatChipGroupLine(group: ChipGroup): string {
  const c = group.sample ?? {};
  const pa = findProgramAdvanceForChip(group);
  const heading = pa
    ? `PA Combo: ${formatProgramAdvanceCombo(pa)}`
    : `Codes: ${inlineCode(group.codes.length ? group.codes.join(', ') : '—')}`;
  const bits = [
    clean(c.element) && clean(c.element) !== 'Neutral' ? clean(c.element) : '',
    numText(c.power) ? `P${numText(c.power)}` : '',
    Number(c.hits) > 1 ? `x${c.hits}` : '',
    priceText(c.zenny_cost),
  ].filter(Boolean);
  return `**${group.name}** — ${heading}\n${bits.join(' • ') || '—'}`;
}

function findProgramAdvanceForChip(group: ChipGroup): any | null {
  const b = getBundle() as any;
  const rows = Object.values(b.programAdvances ?? {}) as any[];
  if (!rows.length) return null;

  const ids = new Set<string>();
  for (const v of group.variants ?? []) {
    addLookupId(ids, v?.id);
    addLookupId(ids, v?.base_id);
    addLookupId(ids, v?.baseId);
    addLookupId(ids, v?.base);
  }
  addLookupId(ids, group.baseId);
  addLookupId(ids, group.key);
  addLookupId(ids, group.name);

  return rows.find((pa) => {
    const result = clean(pa?.result_chip_id ?? pa?.resultChipId ?? pa?.result ?? '');
    const paId = clean(pa?.id ?? '');
    return ids.has(result.toLowerCase()) || ids.has(paId.toLowerCase());
  }) ?? null;
}

function addLookupId(ids: Set<string>, value: any) {
  const text = clean(value).toLowerCase();
  if (text) ids.add(text);
}

function formatProgramAdvanceCombo(pa: any): string {
  const chipIds = splitPaList(pa?.required_chip_ids ?? pa?.requiredChipIds ?? pa?.chip_ids ?? pa?.chips);
  const letters = splitPaList(pa?.required_letters ?? pa?.requiredLetters ?? pa?.letters ?? pa?.codes);

  if (chipIds.length) {
    return chipIds.map((chipId, i) => {
      const code = normalizeCode(letters[i] ?? '');
      return code ? `${clean(chipId)} [${code}]` : clean(chipId);
    }).join(' + ');
  }

  return clean(pa?.description) || '—';
}

function splitPaList(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(clean).filter(Boolean);
  return String(raw ?? '')
    .split(/[,;|]/)
    .map(clean)
    .filter(Boolean);
}

function buildVirusDexDetailEmbed(userId: string, id: string) {
  const b = getBundle() as any;
  const seen = new Set(listSeenViruses(userId).map(String));
  const v = b.viruses?.[id];

  if (!v || !seen.has(id)) {
    return new EmbedBuilder()
      .setTitle('🧾 VirusDex — Unknown Entry')
      .setDescription(`You have not encountered ${inlineCode(id)} yet.`)
      .setImage(getDataImage());
  }

  const embed = new EmbedBuilder()
    .setTitle(`🦠 VirusDex — ${v.name || id}`)
    .setDescription(v.description || 'No description recorded.')
    .addFields(
      { name: '🧬 Element', value: String(v.element || 'Neutral'), inline: true },
      { name: '❤️ HP', value: String(v.hp || 0), inline: true },
      { name: '⭐ CR', value: String(v.cr || 1), inline: true },
      { name: '📍 Location', value: formatVirusLocation(v, b.regions), inline: false },
      { name: '📊 Stats', value: [`ATK ${v.atk ?? 0}`, `DEF ${v.def ?? 0}`, `SPD ${v.spd ?? 0}`, `ACC ${formatAcc(v.acc)}`].join(' • '), inline: false },
      { name: '⚔️ Moveset', value: formatMoves(v), inline: false },
      { name: '🎁 Possible Drops', value: formatDrops(v, b.dropTables), inline: false },
    )
    .setImage(v.anim_url || v.image_url || getDataImage())
    .setFooter({ text: `id: ${id}` });
  return embed;
}

function formatMoves(v: any): string {
  const rawMoves = [v.move_1json, v.move_2json, v.move_3json, v.move_4json]
    .map((raw, i) => parseMove(raw, i + 1))
    .filter((m): m is any => !!m);
  if (!rawMoves.length) return '—';
  return rawMoves.map((m, i) => {
    const name = safeMoveText(m.name) || `Move ${i + 1}`;
    const kind = safeMoveText(m.kind) ? titleCase(safeMoveText(m.kind)) : 'Move';
    const parts: string[] = [];
    const element = safeMoveText(m.element);
    if (element) parts.push(element);
    if (isScalarMoveValue(m.power) && String(m.power).trim() !== '') parts.push(`PWR ${m.power}`);
    if (isScalarMoveValue(m.hits) && Number(m.hits) > 1) parts.push(`${m.hits} hits`);
    if (isScalarMoveValue(m.acc) && String(m.acc).trim() !== '') parts.push(`${formatAcc(m.acc)} acc`);

    // Hide structured move metadata such as { burn: ... } / { atk: ... }.
    // Those objects are useful to the battle engine but render as "[object Object]" in Discord.
    const fx = scalarMoveText(m.effects ?? m.effect ?? m.status);
    if (fx) parts.push(fx);

    return `**${i + 1}. ${name}** — ${kind}${parts.length ? ` • ${parts.join(' • ')}` : ''}`;
  }).join('\n');
}

function parseMove(raw: any, slot: number): any | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;

  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { name: `Move ${slot}`, kind: text };
}

function isScalarMoveValue(v: any): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function safeMoveText(v: any): string {
  if (!isScalarMoveValue(v)) return '';
  const text = String(v ?? '').trim();
  return text === '[object Object]' ? '' : text;
}

function scalarMoveText(v: any): string {
  return safeMoveText(v);
}

function formatVirusLocation(v: any, regions: Record<string, any>): string {
  const regionId = String(v.region_id ?? v.region ?? '').trim();
  const region = regionId ? regions?.[regionId] : null;
  const regionName = region?.name || region?.label || regionId || 'Unknown region';

  const zones = normalizeVirusZones(v.zones ?? v.zone);
  const zoneText = zones.length
    ? zones.map(z => `Zone ${z}`).join(', ')
    : 'All zones / unspecified';

  return `**${regionName}** — ${zoneText}`;
}

function normalizeVirusZones(raw: any): number[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map(n => Number(n)).filter(n => Number.isFinite(n)))).sort((a, b) => a - b);
  }

  const text = String(raw ?? '').trim();
  if (!text) return [];

  const out: number[] = [];
  for (const part of text.split(/[,;| ]+/).map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      for (let z = a; z <= b; z++) out.push(z);
    } else {
      const n = Number(part);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function formatDrops(v: any, dropTables: Record<string, any>): string {
  const tableId = String(v.drop_table_id || '').trim();
  if (!tableId) return '—';
  const table = dropTables?.[tableId];
  if (!table) return inlineCode(tableId);
  const entriesRaw = String(table.entries || table.item_ids || table.chip_ids || '').trim();
  if (!entriesRaw) return inlineCode(tableId);
  const entries = entriesRaw.split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
  return entries.length ? entries.map(e => `• ${displayDropToken(e)}`).join('\n') : inlineCode(tableId);
}

function displayDropToken(token: string): string {
  return String(token || '').trim().replace(/_STAR\b/g, ' [*]').replace(/_([A-Z])\b/g, ' [$1]') || '—';
}

function collectCodes(variants: any[]): string[] {
  const possible = clean(variants.find((c) => clean(c.possible_codes))?.possible_codes);
  const ordered = possible ? possible.split(/[,;| ]+/).map(normalizeCode).filter(Boolean) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of ordered) if (!seen.has(c)) { seen.add(c); out.push(c); }
  for (const v of variants) {
    const c = normalizeCode(codeOf(v));
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out.sort((a, b) => codeSortValue(a) - codeSortValue(b) || a.localeCompare(b));
}

function codeOf(c: any): string {
  return normalizeCode(chipCode(c) || c?.code || c?.letter || c?.letters);
}

function normalizeCode(v: any): string {
  const s = clean(v);
  if (!s) return '';
  if (s === '*' || s.toUpperCase() === 'STAR') return '*';
  return s.toUpperCase();
}

function codeSortValue(code: string): number {
  const c = normalizeCode(code);
  if (c === '*') return 999;
  const ch = c.charCodeAt(0);
  return Number.isFinite(ch) ? ch : 500;
}

function statLine(label: string, value: any): string {
  const s = clean(value);
  return s ? `${label}: ${s}` : '';
}

function numText(v: any): string {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? String(n) : '';
}

function pctText(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function priceText(v: any): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n}z` : '';
}

function chipImage(c: any): string | null {
  const raw = c?.image_url || c?.image || c?.art_url || c?.icon_url || null;
  const s = clean(raw);
  return s || null;
}

function clean(v: any): string {
  return String(v ?? '').trim();
}

function formatAcc(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v || '—');
  if (n <= 1) return `${Math.round(n * 100)}%`;
  return `${Math.round(n)}%`;
}

function titleCase(v: string): string {
  const s = v.trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/* ------------------------------ Shop flow ------------------------------ */

// Upgrade effect parser -> immediate stat application
function applyUpgradeImmediate(userId: string, chip: any): { ok: boolean; summary: string } {
  const delta = parseUpgradeStatDeltas(chip);

  if (delta.hp_max) addHPMax(userId, delta.hp_max);
  if (delta.atk) addATK(userId, delta.atk);
  if (delta.def) addDEF(userId, delta.def);
  if (delta.spd) addSPD(userId, delta.spd);
  if (delta.acc) addACC(userId, delta.acc);
  if (delta.evasion) addEvasion(userId, delta.evasion);
  if (delta.crit) addCRIT(userId, delta.crit);

  const parts: string[] = [];
  if (delta.hp_max) parts.push(`HP+${delta.hp_max}`);
  if (delta.atk) parts.push(`ATK+${delta.atk}`);
  if (delta.def) parts.push(`DEF+${delta.def}`);
  if (delta.spd) parts.push(`SPD+${delta.spd}`);
  if (delta.acc) parts.push(`ACC+${delta.acc}`);
  if (delta.evasion) parts.push(`EVA+${delta.evasion}`);
  if (delta.crit) parts.push(`CRIT+${delta.crit}`);

  return parts.length
    ? { ok: true, summary: parts.join(' • ') }
    : { ok: false, summary: 'no stat delta found' };
}

type UpgradeDelta = {
  hp_max: number;
  atk: number;
  def: number;
  spd: number;
  acc: number;
  evasion: number;
  crit: number;
};

function parseUpgradeStatDeltas(chip: any): UpgradeDelta {
  const delta: UpgradeDelta = { hp_max: 0, atk: 0, def: 0, spd: 0, acc: 0, evasion: 0, crit: 0 };
  const text = [
    chip?.effects,
    chip?.description,
    chip?.name,
    chip?.id,
    chip?.base_id,
  ].map(v => String(v ?? '').trim()).filter(Boolean).join(' | ');

  const seen = new Set<string>();
  const rx = /\b(max\s*hp|hp\s*max|hpmax|hp|attack|atk|defense|def|speed|spd|accuracy|acc|evasion|eva|crit|critical)\s*(?:by|:)?\s*(?:\+|plus\s*)?\s*([+-]?\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const stat = normalizeUpgradeStatKey(m[1]);
    const amount = parseInt(m[2], 10) || 0;
    if (!stat || amount === 0) continue;
    const key = `${stat}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (stat === 'hp_max') delta.hp_max += amount;
    else if (stat === 'atk') delta.atk += amount;
    else if (stat === 'def') delta.def += amount;
    else if (stat === 'spd') delta.spd += amount;
    else if (stat === 'acc') delta.acc += amount;
    else if (stat === 'evasion') delta.evasion += amount;
    else if (stat === 'crit') delta.crit += amount;
  }

  return delta;
}

function normalizeUpgradeStatKey(k: string): keyof UpgradeDelta | null {
  const s = String(k || '').replace(/\s+/g, '').toLowerCase();
  if (s === 'hp' || s === 'maxhp' || s === 'hpmax') return 'hp_max';
  if (s === 'atk' || s === 'attack') return 'atk';
  if (s === 'def' || s === 'defense') return 'def';
  if (s === 'spd' || s === 'speed') return 'spd';
  if (s === 'acc' || s === 'accuracy') return 'acc';
  if (s === 'eva' || s === 'evasion') return 'evasion';
  if (s === 'crit' || s === 'critical') return 'crit';
  return null;
}


function effectiveShopPrice(userId: string, item: any): number {
  const base = Number(item?.zenny_price ?? 0);
  if (!item?.is_upgrade) return Number.isFinite(base) ? Math.max(0, Math.trunc(base)) : 0;
  return getScaledUpgradePrice(userId, String(item.item_id), base);
}

function upgradePurchaseLabel(userId: string, item: any): string {
  if (!item?.is_upgrade) return '';
  const count = getUpgradePurchaseCount(userId, String(item.item_id));
  return count > 0 ? ` • Upgrade purchase #${count + 1}` : ' • First upgrade purchase';
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
      .setImage(getRegionImage(region) || getTravelImage());
    await ix.update({
      embeds: [embed],
      components: [navButtons(new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Secondary).setLabel('Back'))],
    });
    return;
  }

  const selected = selectedId
    ? items.find(i => i.item_id === selectedId) || null
    : null;

  const options = items
    .map((it) => ({
      label: `${it.name} — ${effectiveShopPrice(userId, it)}z`.slice(0, 100),
      value: it.item_id,
      description: `${it.is_upgrade ? 'Upgrade' : 'BattleChip'}${upgradePurchaseLabel(userId, it)}${it.chip?.element ? ` • ${it.chip.element}` : ''}`.slice(0, 100),
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
    .setLabel(selected ? `Buy for ${effectiveShopPrice(userId, selected)}z` : 'Buy')
    .setDisabled(!selected);
  const sell = new ButtonBuilder()
    .setCustomId('jackin:shopSellOpen')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Sell Chips');
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
    .setImage(getRegionImage(region) || getTravelImage());

  if (selected) {
    const c: any = selected.chip || {};
    const details = [
      `Price: **${effectiveShopPrice(userId, selected)}z**${selected.is_upgrade ? ` (base ${selected.zenny_price}z${upgradePurchaseLabel(userId, selected)})` : ''}`, 
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
      new ActionRowBuilder<ButtonBuilder>().addComponents(buy, sell, exit),
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

    const price = effectiveShopPrice(userId, item);
    const pay = spendZenny(userId, price);
    if (!pay.ok) {
      await renderJackInShop(ix, chipId, `Not enough Zenny. You need ${price}z.`);
      return;
    }

    if (item.is_upgrade) {
      const applied = applyUpgradeImmediate(userId, item.chip);
      if (!applied.ok) {
        addZenny(userId, price);
        await renderJackInShop(ix, chipId, `Could not apply ${item.name}; purchase refunded. Reason: ${applied.summary}.`);
        return;
      }
      recordUpgradePurchase(userId, item.item_id, 1);
      const nextPrice = getScaledUpgradePrice(userId, item.item_id, item.zenny_price);
      await renderJackInShop(ix, chipId, `Purchased ${item.name} for ${price}z. Upgrade applied: ${applied.summary}. Next purchase: ${nextPrice}z.`);
      return;
    }

    grantChip(userId, chipId, 1);
    await renderJackInShop(ix, chipId, `Bought ${item.name} for ${price}z. Added to inventory.`);
  } catch (err: any) {
    console.error('onShopBuy error:', err);
    try {
      const embed = new EmbedBuilder().setTitle('⚠️ Shop Error').setDescription(String(err?.message || err));
      await ix.update({ embeds: [embed], components: [backRow()] });
    } catch {}
  }
}


function salePriceForChip(chip: any): number {
  const n = Number(chip?.zenny_cost ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.floor(n / 2));
}

function sellableInventoryRows(userId: string) {
  const folderCounts = countValues(getFolder(userId));
  return getInventory(userId)
    .filter(row => Number(row.qty) > 0)
    .map(row => {
      const chipId = String(row.chip_id);
      const chip: any = getChipById(chipId);
      const available = availableOutsideFolder(row, folderCounts);
      return { row, chipId, chip, salePrice: salePriceForChip(chip), available };
    })
    .filter(({ chip, available }) => chip && !chipIsUpgrade(chip) && available > 0);
}

async function renderJackInSellShop(
  ix: ButtonInteraction | StringSelectMenuInteraction,
  selectedId: string | null,
  notice?: string,
  page = 0,
) {
  const userId = ix.user.id;
  const b: any = getBundle();
  const p: any = await getPlayer(userId);
  const { region } = getCurrentRegionForPlayer(p, b);
  const sellable = sellableInventoryRows(userId);

  if (!sellable.length) {
    const embed = new EmbedBuilder()
      .setTitle('💰 Sell BattleChips')
      .setDescription([
        notice ? `📌 **${notice}**` : '',
        'You have no available BattleChip copies outside your folder that can be sold.',
        '',
        'Folder-committed copies are protected; extra copies can still be sold.',
      ].filter(Boolean).join('\n'))
      .setImage(region ? (getRegionImage(region) || getTravelImage()) : getTravelImage());
    await ix.update({
      embeds: [embed],
      components: [navButtons(new ButtonBuilder().setCustomId('jackin:openShop').setStyle(ButtonStyle.Secondary).setLabel('Back'))],
    });
    return;
  }

  const selected = selectedId
    ? sellable.find(x => x.chipId === selectedId) || null
    : null;

  const pageCount = Math.max(1, Math.ceil(sellable.length / MENU_PAGE_SIZE));
  const selectedIndex = selected ? sellable.findIndex(x => x.chipId === selected.chipId) : -1;
  const pageSafe = selectedIndex >= 0 ? Math.floor(selectedIndex / MENU_PAGE_SIZE) : clampPage(page, pageCount);
  const options = sellable
    .slice(pageSafe * MENU_PAGE_SIZE, (pageSafe + 1) * MENU_PAGE_SIZE)
    .map(({ row, chipId, chip, salePrice, available }) => ({
      label: `${formatChipName(chip)} — sell ${salePrice}z`.slice(0, 100),
      value: chipId,
      description: `Available ${available} of ${row.qty} owned`.slice(0, 100),
      default: selected?.chipId === chipId,
    }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`jackin:shopSellSelect:${pageSafe}`)
    .setPlaceholder(selected ? `Selected: ${formatChipName(selected.chip)}` : 'Select a chip to sell')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const sellBtn = new ButtonBuilder()
    .setCustomId(`jackin:shopSell:${selected?.chipId || '_none'}:${pageSafe}`)
    .setStyle(ButtonStyle.Success)
    .setLabel(selected ? `Sell for ${selected.salePrice}z` : 'Sell')
    .setDisabled(!selected);

  const backBtn = new ButtonBuilder()
    .setCustomId('jackin:openShop')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Back');

  const embed = new EmbedBuilder()
    .setTitle('💰 Sell BattleChips')
    .setDescription([
      `Your Zenny: **${p?.zenny ?? 0}z**`,
      '',
      notice ? `📌 **${notice}**` : `Select an available BattleChip copy outside your folder. Page **${pageSafe + 1}/${pageCount}**. Sale value is half listed price.`,
    ].join('\n'))
    .setImage(region ? (getRegionImage(region) || getTravelImage()) : getTravelImage());

  if (selected) {
    const chip: any = selected.chip || {};
    embed.addFields({
      name: formatChipName(chip),
      value: [
        `Listed Price: **${priceText(chip.zenny_cost) || '0z'}**`,
        `Sell Value: **${selected.salePrice}z**`,
        `Owned: **${selected.row.qty}**`,
        `Available to Sell: **${selected.available}**`,
        chip.element ? `Element: **${chip.element}**` : '',
        Number.isFinite(Number(chip.power)) && Number(chip.power) > 0 ? `Power: **${chip.power}**` : '',
        chip.effects ? `Effects: ${String(chip.effects)}` : '',
      ].filter(Boolean).join('\n'),
    });
    const img = chipImage(chip);
    if (img) embed.setThumbnail(img);
  }

  await ix.update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`jackin:shopSellPage:${Math.max(0, pageSafe - 1)}`).setStyle(ButtonStyle.Secondary).setLabel('Previous').setDisabled(pageSafe <= 0),
        new ButtonBuilder().setCustomId(`jackin:shopSellPage:${Math.min(pageCount - 1, pageSafe + 1)}`).setStyle(ButtonStyle.Secondary).setLabel('Next').setDisabled(pageSafe >= pageCount - 1),
        sellBtn,
        backBtn,
      ),
    ],
  });
}

export async function onShopSellOpen(ix: ButtonInteraction) {
  await renderJackInSellShop(ix, null);
}

export async function onShopSellPage(ix: ButtonInteraction, page = 0) {
  await renderJackInSellShop(ix, null, undefined, page);
}

export async function onShopSellSelect(ix: StringSelectMenuInteraction) {
  const page = Number(ix.customId.split(':')[2] || '0');
  await renderJackInSellShop(ix, ix.values?.[0] || null, undefined, page);
}

export async function onShopSell(ix: ButtonInteraction, chipId: string, page = 0) {
  if (!chipId || chipId === '_none') {
    await renderJackInSellShop(ix, null, 'Please select a BattleChip first.', page);
    return;
  }

  const userId = ix.user.id;
  const sellable = sellableInventoryRows(userId);
  const item = sellable.find(x => x.chipId === chipId);
  if (!item) {
    await renderJackInSellShop(ix, null, 'That chip cannot be sold. All owned copies may be committed to your folder or no longer in your inventory.', page);
    return;
  }

  const removed = removeChip(userId, chipId, 1);
  if (!removed) {
    await renderJackInSellShop(ix, chipId, 'Could not remove that chip from inventory.', page);
    return;
  }

  addZenny(userId, item.salePrice);
  await renderJackInSellShop(ix, null, `Sold ${formatChipName(item.chip)} for ${item.salePrice}z.`, page);
}


/* ------------------------------ PvP Hub ------------------------------ */

export async function onOpenPvp(ix: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('⚔️ PvP')
    .setDescription([
      'Create an open NetBattle challenge in this channel.',
      '',
      'Any other player can accept the duel.',
    ].join('\n'))
    .setImage(getTravelImage())
    .setFooter({ text: 'PvP alpha: no rewards are granted.' });

  const createBtn = new ButtonBuilder()
    .setCustomId('jackin:pvpOpenChallenge')
    .setStyle(ButtonStyle.Primary)
    .setLabel('Create Open Challenge');
  const backBtn = new ButtonBuilder()
    .setCustomId('jackin:back')
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Back');

  await ix.update({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(createBtn, backBtn)],
  });
}

export async function onPvpOpenChallenge(ix: ButtonInteraction) {
  await createOpenPvpChallenge(ix);
}

export async function onShopExit(ix: ButtonInteraction) {
  await renderJackInHUD(ix);
}
