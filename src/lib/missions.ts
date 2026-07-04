// src/lib/missions.ts
import { db, addZenny, grantChip, spendZenny, listInventory, getPlayer } from './db';
import { getBundle, getChipById, formatChipName } from './data';

const BOARD_SIZE = Math.max(1, Number(process.env.MISSION_BOARD_SIZE ?? 5) || 5);
const BOARD_REFRESH_MS = Math.max(1, Number(process.env.MISSION_BOARD_HOURS ?? 24) || 24) * 60 * 60 * 1000;
const QUIT_COOLDOWN_MS = Math.max(1, Number(process.env.MISSION_QUIT_HOURS ?? 12) || 12) * 60 * 60 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS missions_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'Available',
  progress INTEGER NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, mission_id)
);

CREATE TABLE IF NOT EXISTS mission_progress_detail (
  user_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, mission_id, target_id)
);

CREATE TABLE IF NOT EXISTS mission_bbs_board (
  user_id TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL DEFAULT 0,
  mission_ids TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mission_bbs_meta (
  user_id TEXT PRIMARY KEY,
  last_quit_at INTEGER NOT NULL DEFAULT 0
);
`);

try { db.exec(`ALTER TABLE missions_state ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE missions_state ADD COLUMN counter INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE mission_bbs_board ADD COLUMN generated_at INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE mission_bbs_board ADD COLUMN mission_ids TEXT NOT NULL DEFAULT '';`); } catch {}
try { db.exec(`ALTER TABLE mission_bbs_meta ADD COLUMN last_quit_at INTEGER NOT NULL DEFAULT 0;`); } catch {}

type MissionState = 'Available' | 'Accepted' | 'Completed' | 'TurnedIn';
export interface MissionStateRow {
  user_id: string;
  mission_id: string;
  state: MissionState;
  counter: number;
  progress: number;
}

export type MissionTarget = { id: string; qty: number };
export type ParsedMissionRequirement = {
  type: 'Defeat' | 'Obtain' | 'Zenny' | 'Other';
  targets: MissionTarget[];
  zenny?: number;
};

export type MissionEvaluation = {
  mission: any;
  state: MissionState;
  parsed: ParsedMissionRequirement;
  ready: boolean;
  progressLines: string[];
  rewardLines: string[];
};

const Q = {
  getRow: db.prepare(`
    SELECT user_id, mission_id, state,
           MAX(COALESCE(progress,0), COALESCE(counter,0)) AS progress,
           MAX(COALESCE(progress,0), COALESCE(counter,0)) AS counter
    FROM missions_state WHERE user_id=? AND mission_id=?
  `),
  upsert: db.prepare(`
    INSERT INTO missions_state (user_id, mission_id, state, progress, counter) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,mission_id)
    DO UPDATE SET state=excluded.state, progress=excluded.progress, counter=excluded.counter
  `),
  deleteDetail: db.prepare(`DELETE FROM mission_progress_detail WHERE user_id=? AND mission_id=?`),
  getDetail: db.prepare(`SELECT qty FROM mission_progress_detail WHERE user_id=? AND mission_id=? AND target_id=?`),
  upsertDetail: db.prepare(`
    INSERT INTO mission_progress_detail (user_id, mission_id, target_id, qty) VALUES (?,?,?,?)
    ON CONFLICT(user_id, mission_id, target_id) DO UPDATE SET qty=excluded.qty
  `),
  listDetails: db.prepare(`SELECT target_id, qty FROM mission_progress_detail WHERE user_id=? AND mission_id=?`),
  boardGet: db.prepare(`SELECT generated_at, mission_ids FROM mission_bbs_board WHERE user_id=?`),
  boardSet: db.prepare(`
    INSERT INTO mission_bbs_board (user_id, generated_at, mission_ids) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET generated_at=excluded.generated_at, mission_ids=excluded.mission_ids
  `),
  metaGet: db.prepare(`SELECT last_quit_at FROM mission_bbs_meta WHERE user_id=?`),
  metaSetQuit: db.prepare(`
    INSERT INTO mission_bbs_meta (user_id, last_quit_at) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_quit_at=excluded.last_quit_at
  `),
};

export function listMissionsFor(userId: string): MissionStateRow[] {
  const all = getBundle().missions;
  const rows: MissionStateRow[] = [];
  for (const id of Object.keys(all)) {
    const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
    const progress = Math.max(0, Number(row?.progress ?? row?.counter ?? 0));
    rows.push(row ?? { user_id: userId, mission_id: id, state: 'Available', progress, counter: progress });
  }
  return rows.sort((a, b) => missionSort(a.mission_id, b.mission_id));
}

export function listCurrentMissions(userId: string): MissionEvaluation[] {
  const all = getBundle().missions as Record<string, any>;
  return listMissionsFor(userId)
    .filter(r => r.state === 'Accepted' || r.state === 'Completed')
    .map(r => evaluateMission(userId, all[r.mission_id], r))
    .filter(Boolean)
    .sort((a, b) => missionSort(String(a.mission.id), String(b.mission.id)));
}

export function getMissionBoard(userId: string, unlockedRegionIds: string[]): { missions: any[]; generatedAt: number; refreshAt: number } {
  const now = Date.now();
  const existing = Q.boardGet.get(userId) as { generated_at: number; mission_ids: string } | undefined;
  const unlocked = new Set(unlockedRegionIds.map(String));

  if (existing && Number(existing.generated_at || 0) > 0 && now - Number(existing.generated_at) < BOARD_REFRESH_MS) {
    const ids = String(existing.mission_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const missions = ids.map(id => getBundle().missions[id]).filter((m: any) => m && missionIsBoardEligible(userId, m, unlocked));
    // Do not reroll early after the player accepts/quits missions; this prevents board farming.
    if (ids.length) return { missions, generatedAt: Number(existing.generated_at), refreshAt: Number(existing.generated_at) + BOARD_REFRESH_MS };
  }

  const pool = Object.values(getBundle().missions as Record<string, any>)
    .filter((m: any) => missionIsBoardEligible(userId, m, unlocked))
    .sort((a: any, b: any) => missionSort(String(a.id), String(b.id)));

  const shuffled = shuffle(pool.slice());
  const picked = shuffled.slice(0, BOARD_SIZE).sort((a: any, b: any) => missionSort(String(a.id), String(b.id)));
  Q.boardSet.run(userId, now, picked.map((m: any) => String(m.id)).join(','));
  return { missions: picked, generatedAt: now, refreshAt: now + BOARD_REFRESH_MS };
}

function missionIsBoardEligible(userId: string, m: any, unlocked: Set<string>): boolean {
  if (!m?.id) return false;
  const rid = String(m.region_id || m.region || '').trim();
  if (rid && !unlocked.has(rid)) return false;
  const row = Q.getRow.get(userId, String(m.id)) as MissionStateRow | undefined;
  if (!row) return true;
  return row.state === 'Available';
}

export function acceptMission(userId: string, id: string): string {
  const m = getBundle().missions[id];
  if (!m) return 'Unknown mission.';

  const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
  if (row?.state === 'Accepted') return 'Already accepted.';
  if (row?.state === 'Completed') return 'Already completed. Turn it in.';
  if (row?.state === 'TurnedIn') return 'Already turned in.';

  Q.deleteDetail.run(userId, id);
  Q.upsert.run(userId, id, 'Accepted', 0, 0);
  return 'Accepted.';
}

export function acceptBoardMission(userId: string, missionId: string, unlockedRegionIds: string[]): { ok: boolean; msg: string } {
  const board = getMissionBoard(userId, unlockedRegionIds);
  const onBoard = board.missions.some((m: any) => String(m.id) === String(missionId));
  if (!onBoard) return { ok: false, msg: 'That mission is not on your current BBS board.' };
  const msg = acceptMission(userId, missionId);
  return { ok: !/unknown|already/i.test(msg), msg };
}

export function quitMission(userId: string, missionId: string): { ok: boolean; msg: string; remainingMs?: number } {
  const now = Date.now();
  const meta = Q.metaGet.get(userId) as { last_quit_at: number } | undefined;
  const last = Number(meta?.last_quit_at || 0);
  const remaining = last + QUIT_COOLDOWN_MS - now;
  if (remaining > 0) {
    return { ok: false, msg: `Mission quit is on cooldown. Try again in ${formatDuration(remaining)}.`, remainingMs: remaining };
  }

  const row = Q.getRow.get(userId, missionId) as MissionStateRow | undefined;
  if (!row || (row.state !== 'Accepted' && row.state !== 'Completed')) {
    return { ok: false, msg: 'That mission is not currently active.' };
  }

  Q.deleteDetail.run(userId, missionId);
  Q.upsert.run(userId, missionId, 'Available', 0, 0);
  Q.metaSetQuit.run(userId, now);
  return { ok: true, msg: 'Mission quit. Progress was reset.' };
}

export function getQuitCooldown(userId: string): { ready: boolean; remainingMs: number } {
  const meta = Q.metaGet.get(userId) as { last_quit_at: number } | undefined;
  const last = Number(meta?.last_quit_at || 0);
  const remainingMs = Math.max(0, last + QUIT_COOLDOWN_MS - Date.now());
  return { ready: remainingMs <= 0, remainingMs };
}

export function completeMissionIfReady(userId: string, id: string): { ok: boolean; msg: string; rewardZ: number; rewardChips: string[] } {
  const m = getBundle().missions[id];
  if (!m) return { ok: false, msg: 'Unknown mission.', rewardZ: 0, rewardChips: [] };
  const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
  if (!row || (row.state !== 'Accepted' && row.state !== 'Completed')) {
    return { ok: false, msg: 'Mission is not active.', rewardZ: 0, rewardChips: [] };
  }

  const evald = evaluateMission(userId, m, row);
  if (!evald.ready) return { ok: false, msg: 'Mission requirements are not complete.', rewardZ: 0, rewardChips: [] };

  if (evald.parsed.type === 'Zenny') {
    const need = Math.max(0, Number(evald.parsed.zenny || 0));
    const spend = spendZenny(userId, need);
    if (!spend.ok) return { ok: false, msg: `Not enough Zenny. Required: ${need}z.`, rewardZ: 0, rewardChips: [] };
  }

  const rewardZ = Number(m.reward_zenny || 0) || 0;
  const rewardChips = parseRewardChips(m.reward_chip_ids);
  if (rewardZ) addZenny(userId, rewardZ);
  for (const chipId of rewardChips) grantChip(userId, chipId, 1);

  const aggregate = aggregateProgress(userId, String(id), evald.parsed);
  Q.upsert.run(userId, id, 'TurnedIn', aggregate, aggregate);
  return { ok: true, msg: `Completed ${m.name || id}.`, rewardZ, rewardChips };
}

export function completeReadyMissions(userId: string): { completed: string[]; rewardZ: number; rewardChips: string[]; failed: string[] } {
  const current = listCurrentMissions(userId).filter(m => m.ready);
  const completed: string[] = [];
  const rewardChips: string[] = [];
  let rewardZ = 0;
  const failed: string[] = [];
  for (const ev of current) {
    const res = completeMissionIfReady(userId, String(ev.mission.id));
    if (res.ok) {
      completed.push(String(ev.mission.name || ev.mission.id));
      rewardZ += res.rewardZ || 0;
      rewardChips.push(...res.rewardChips);
    } else {
      failed.push(`${ev.mission.name || ev.mission.id}: ${res.msg}`);
    }
  }
  return { completed, rewardZ, rewardChips, failed };
}

// Back-compat command helper. Prefer completeMissionIfReady in BBS.
export function turnInMission(userId: string, id: string): { ok: boolean; msg: string; rewardZ: number; rewardChips: string[] } {
  return completeMissionIfReady(userId, id);
}

/** Defeat and boss missions are opt-in. Only Accepted missions progress. */
export function progressDefeat(userId: string, virusId: string): string[] {
  const completed: string[] = [];
  const bundle = getBundle();

  for (const m of Object.values(bundle.missions) as any[]) {
    if (String(m.type || '').toLowerCase() !== 'defeat') continue;
    const parsed = parseMissionRequirement(m);
    if (!parsed.targets.some(t => String(t.id) === String(virusId))) continue;

    const row = Q.getRow.get(userId, String(m.id)) as MissionStateRow | undefined;
    if (!row || row.state !== 'Accepted') continue;

    for (const t of parsed.targets) {
      if (String(t.id) !== String(virusId)) continue;
      const cur = getTargetProgress(userId, String(m.id), String(t.id));
      const next = Math.min(Math.max(1, t.qty), cur + 1);
      Q.upsertDetail.run(userId, String(m.id), String(t.id), next);
    }

    const ready = requirementReady(userId, m, parsed);
    const aggregate = aggregateProgress(userId, String(m.id), parsed);
    const nextState: MissionState = ready ? 'Completed' : 'Accepted';
    Q.upsert.run(userId, String(m.id), nextState, aggregate, aggregate);
    if (nextState === 'Completed') completed.push(String(m.name || m.id));
  }

  return completed;
}

export function evaluateMission(userId: string, mission: any, stateRow?: MissionStateRow): MissionEvaluation {
  const row = stateRow || (Q.getRow.get(userId, String(mission?.id)) as MissionStateRow | undefined);
  const state = (row?.state || 'Available') as MissionState;
  const parsed = parseMissionRequirement(mission);
  const ready = state !== 'TurnedIn' && requirementReady(userId, mission, parsed);
  return {
    mission,
    state,
    parsed,
    ready,
    progressLines: formatProgressLines(userId, mission, parsed),
    rewardLines: formatRewardLines(mission),
  };
}

export function parseMissionRequirement(mission: any): ParsedMissionRequirement {
  const typeRaw = String(mission?.type || '').trim().toLowerCase();
  const req = String(mission?.requirement || '').trim();
  if (typeRaw === 'defeat') return { type: 'Defeat', targets: parseTargetList(req, true) };
  if (typeRaw === 'obtain') return { type: 'Obtain', targets: parseTargetList(req, false) };
  if (typeRaw === 'zenny' || typeRaw === 'pay') return { type: 'Zenny', targets: [], zenny: parseZennyRequirement(req) };
  return { type: 'Other', targets: [], zenny: 0 };
}

function parseTargetList(text: string, defaultQtyOne: boolean): MissionTarget[] {
  const cleaned = String(text || '')
    .replace(/^\s*(defeat|obtain|collect)\s+/i, '')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(',').map(part => parseTarget(part, defaultQtyOne)).filter((x): x is MissionTarget => !!x?.id);
}

function parseTarget(part: string, defaultQtyOne: boolean): MissionTarget | null {
  const s = String(part || '').trim();
  if (!s) return null;
  const pieces = s.split(':').map(x => x.trim()).filter(Boolean);
  if (pieces.length >= 2) {
    const qty = Math.max(1, Number(pieces[1]) || 1);
    return { id: pieces[0], qty };
  }
  const m = s.match(/^(?:(\d+)\s+)?(.+)$/);
  if (!m) return { id: s, qty: defaultQtyOne ? 1 : 1 };
  return { id: m[2].trim(), qty: Math.max(1, Number(m[1] || 1) || 1) };
}

function parseZennyRequirement(text: string): number {
  const m = String(text || '').match(/(\d[\d,]*)/);
  return m ? Math.max(0, Number(m[1].replace(/,/g, '')) || 0) : 0;
}

function requirementReady(userId: string, mission: any, parsed: ParsedMissionRequirement): boolean {
  if (parsed.type === 'Defeat') {
    return parsed.targets.length > 0 && parsed.targets.every(t => getTargetProgress(userId, String(mission.id), t.id) >= t.qty);
  }
  if (parsed.type === 'Obtain') {
    return parsed.targets.length > 0 && parsed.targets.every(t => ownedChipQty(userId, t.id) >= t.qty);
  }
  if (parsed.type === 'Zenny') {
    return Number(getPlayer(userId)?.zenny || 0) >= Number(parsed.zenny || 0);
  }
  return false;
}

function aggregateProgress(userId: string, missionId: string, parsed: ParsedMissionRequirement): number {
  if (parsed.type === 'Defeat') {
    return parsed.targets.reduce((n, t) => n + Math.min(t.qty, getTargetProgress(userId, missionId, t.id)), 0);
  }
  if (parsed.type === 'Obtain') {
    return parsed.targets.reduce((n, t) => n + Math.min(t.qty, ownedChipQty(userId, t.id)), 0);
  }
  if (parsed.type === 'Zenny') return Math.min(Number(parsed.zenny || 0), Number(getPlayer(userId)?.zenny || 0));
  return 0;
}

function getTargetProgress(userId: string, missionId: string, targetId: string): number {
  const row = Q.getDetail.get(userId, missionId, targetId) as { qty: number } | undefined;
  return Math.max(0, Number(row?.qty || 0));
}

function ownedChipQty(userId: string, chipId: string): number {
  const target = String(chipId || '').trim();
  if (!target) return 0;
  return (listInventory(userId) || [])
    .filter(r => String(r.chip_id) === target)
    .reduce((n, r) => n + Math.max(0, Number(r.qty || 0)), 0);
}

function formatProgressLines(userId: string, mission: any, parsed: ParsedMissionRequirement): string[] {
  if (parsed.type === 'Defeat') {
    return parsed.targets.map(t => {
      const v = (getBundle().viruses as any)[t.id];
      const name = String(v?.name || t.id);
      return `• ${name}: **${Math.min(t.qty, getTargetProgress(userId, String(mission.id), t.id))}/${t.qty}** defeated`;
    });
  }
  if (parsed.type === 'Obtain') {
    return parsed.targets.map(t => `• ${displayChipTarget(t.id)}: **${Math.min(t.qty, ownedChipQty(userId, t.id))}/${t.qty}** owned`);
  }
  if (parsed.type === 'Zenny') {
    const need = Math.max(0, Number(parsed.zenny || 0));
    const have = Math.max(0, Number(getPlayer(userId)?.zenny || 0));
    return [`• Zenny: **${Math.min(need, have)}/${need}z** ready`];
  }
  return ['• Requirement tracking unavailable.'];
}

function formatRewardLines(mission: any): string[] {
  const out: string[] = [];
  const z = Number(mission?.reward_zenny || 0);
  if (z > 0) out.push(`+${z}z`);
  const chips = parseRewardChips(mission?.reward_chip_ids);
  if (chips.length) out.push(`Chip: ${chips.map(displayChipTarget).join(', ')}`);
  return out.length ? out : ['No listed reward'];
}

function parseRewardChips(raw: any): string[] {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function displayChipTarget(chipId: string): string {
  const chip = getChipById(chipId) as any;
  if (chip) return formatChipName(chip);
  return String(chipId || '').replace(/_STAR\b/g, ' [*]').replace(/_([A-Z])\b/g, ' [$1]');
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function missionSort(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
