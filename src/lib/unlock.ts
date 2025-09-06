// src/lib/unlock.ts
import { getBundle } from './data';
import { Region } from './types';
import { getPlayer, setRegion /*, setZone */ } from './db';

/**
 * Returns all regions available at the given player level (min_level gate).
 */
export function listAvailableRegionsForLevel(level: number): Region[] {
  const { regions } = getBundle();
  return Object.values(regions).filter((r) => level >= (r.min_level ?? 1));
}

/**
 * Returns whether a given region is unlocked for a given level.
 */
export function isRegionUnlockedAtLevel(regionId: string, level: number): boolean {
  const { regions } = getBundle();
  const r = regions[regionId];
  if (!r) return false;
  return level >= (r.min_level ?? 1);
}

/**
 * Player-facing list of unlocked regions based on their current level.
 */
export async function listUnlocked(userId: string): Promise<Region[]> {
  const p: any = await getPlayer(userId);
  const level = Number(p?.level ?? 1);
  return listAvailableRegionsForLevel(level);
}

/**
 * Given an old and new level, returns just the newly unlocked regions (those that
 * were locked at oldLevel but unlocked at newLevel).
 */
export function diffNewlyUnlockedRegions(oldLevel: number, newLevel: number): Region[] {
  const prev = new Set(listAvailableRegionsForLevel(oldLevel).map((r) => r.id));
  return listAvailableRegionsForLevel(newLevel).filter((r) => !prev.has(r.id));
}

/**
 * Ensure a player has a valid starting region set.
 * - Uses START_REGION_ID from env (falls back to the first region with min_level <= player level).
 * - Does NOT force a zone; if you want Zone 1, set it at jack-in time or uncomment setZone.
 */
export async function ensureStartUnlocked(userId: string): Promise<void> {
  const p: any = await getPlayer(userId);
  const level = Number(p?.level ?? 1);

  // If player already has a region set, nothing to do.
  if (p?.region_id) return;

  const { regions } = getBundle();

  // Preferred starter from env (should have min_level <= player level)
  const envStarter = process.env.START_REGION_ID;
  if (envStarter && regions[envStarter] && isRegionUnlockedAtLevel(envStarter, level)) {
    await setRegion(userId, envStarter);
    // await setZone(userId, 1);
    return;
  }

  // Fallback: pick the lowest min_level region available to this level.
  const choices = listAvailableRegionsForLevel(level);
  if (choices.length > 0) {
    // choose the region with the lowest min_level, then stable by name
    choices.sort((a, b) => (a.min_level - b.min_level) || String(a.name).localeCompare(String(b.name)));
    await setRegion(userId, choices[0].id);
    // await setZone(userId, 1);
  }
}

/**
 * Notify a player when new regions unlock due to a level increase.
 * Sends BOTH a DM and an ephemeral follow-up on the provided interaction.
 *
 * Usage (e.g. right after you persist a level-up inside a command):
 *   const newly = diffNewlyUnlockedRegions(oldLevel, newLevel);
 *   await sendUnlockNotifications(ix, newly);
 */
export async function sendUnlockNotifications(ix: any, newly: Region[]): Promise<void> {
  if (!newly?.length) return;

  const pretty = newly
    .map((r) => `**${r.name}** (min ${r.min_level})`)
    .join(', ');

  // 1) DM the user
  try {
    const dm = await ix.user.createDM();
    await dm.send(`🎉 New regions unlocked: ${pretty}\nUse **/jack-in** to visit.`);
  } catch (err) {
    console.warn('sendUnlockNotifications: DM failed:', err);
  }

  // 2) Ephemeral follow-up on the interaction
  try {
    // Works for ChatInputCommandInteraction / ButtonInteraction / SelectMenu — any reply-capable ix
    if (typeof ix.followUp === 'function') {
      await ix.followUp({
        ephemeral: true,
        content: `🎉 New regions unlocked: ${newly.map((r) => `**${r.name}**`).join(', ')} — use **/jack-in** to visit.`,
      });
    } else if (typeof ix.reply === 'function') {
      await ix.reply({
        ephemeral: true,
        content: `🎉 New regions unlocked: ${newly.map((r) => `**${r.name}**`).join(', ')} — use **/jack-in** to visit.`,
      });
    }
  } catch (err) {
    console.warn('sendUnlockNotifications: ephemeral notify failed:', err);
  }
}

/**
 * Back-compat shim: previously boss-gated regions used `unlockNextFromRegion`.
 * With level-gated progression this is no-op; we keep the export to avoid breaking imports.
 */
export async function unlockNextFromRegion(_userId: string, _regionId: string): Promise<void> {
  // No-op under level-gated progression. Left for compatibility.
  return;
}
