// src/commands/travel.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { listUnlocked } from '../lib/unlock';
import { getBundle } from '../lib/data';
import { setRegion, setZone, getRegion } from '../lib/db';

export const data = new SlashCommandBuilder()
  .setName('travel')
  .setDescription('Travel to an unlocked region or zone')
  .addStringOption(o =>
    o.setName('region_id').setDescription('Region TSV id')
  )
  .addIntegerOption(o =>
    o.setName('zone')
      .setDescription('Zone number (1..region.zone_count)')
      .setMinValue(1)
      .setMaxValue(10)
  );

export async function execute(ix: ChatInputCommandInteraction) {
  const wantRegion = ix.options.getString('region_id');
  const wantZone   = ix.options.getInteger('zone') ?? undefined;

  const bundle = getBundle();

  // If region specified, switch region (must be unlocked) and reset/validate zone
  if (wantRegion) {
    const unlocked = new Set(listUnlocked(ix.user.id));
    if (!unlocked.has(wantRegion)) {
      await ix.reply({ ephemeral: true, content: `🔒 Region not unlocked: ${wantRegion}` });
      return;
    }
    const r = bundle.regions[wantRegion];
    if (!r) {
      await ix.reply({ ephemeral: true, content: `❌ Unknown region: ${wantRegion}` });
      return;
    }
    setRegion(ix.user.id, wantRegion);
    setZone(ix.user.id, 1);
    const e = new EmbedBuilder()
      .setTitle(`🧭 Traveling to ${r.name} — Zone 1`)
      .setDescription(r.description || '')
      .setImage(r.background_url || null);
    await ix.reply({ embeds: [e], ephemeral: false });
    return;
  }

  // Otherwise, adjust zone within current region
  if (wantZone !== undefined) {
    const curRegionId = getRegion(ix.user.id)?.region_id || process.env.START_REGION_ID || 'den_city';
    const r = bundle.regions[curRegionId];
    if (!r) {
      await ix.reply({ ephemeral: true, content: `❌ Current region invalid.` });
      return;
    }
    const maxZone = Math.max(1, r.zone_count ?? 1);
    if (wantZone < 1 || wantZone > maxZone) {
      await ix.reply({ ephemeral: true, content: `❌ Zone out of range. ${r.name} has zones 1..${maxZone}.` });
      return;
    }
    setZone(ix.user.id, wantZone);
    const e = new EmbedBuilder()
      .setTitle(`🧭 ${r.name} — Zone ${wantZone}`)
      .setDescription(r.description || '')
      .setImage(r.background_url || null);
    await ix.reply({ embeds: [e], ephemeral: false });
    return;
  }

  await ix.reply({
    ephemeral: true,
    content: `ℹ️ Use /travel region_id:<id> to change region, or /travel zone:<n> to change zone.`
  });
}
