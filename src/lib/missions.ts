// src/lib/missions.ts
import { db, addZenny, grantChip } from './db';
import { getBundle } from './data';

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
`);

try { db.exec(`ALTER TABLE missions_state ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;`); } catch {}
try { db.exec(`ALTER TABLE missions_state ADD COLUMN counter INTEGER NOT NULL DEFAULT 0;`); } catch {}

type MissionState = 'Available' | 'Accepted' | 'Completed' | 'TurnedIn';
export interface MissionStateRow {
  user_id: string;
  mission_id: string;
  state: MissionState;
  counter: number;
  progress: number;
}

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
};

export function listMissionsFor(userId: string): MissionStateRow[] {
  const all = getBundle().missions;
  const rows: MissionStateRow[] = [];
  for (const id of Object.keys(all)) {
    const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
    const progress = Math.max(0, Number(row?.progress ?? row?.counter ?? 0));
    rows.push(row ?? { user_id: userId, mission_id: id, state: 'Available', progress, counter: progress });
  }
  return rows;
}

export function acceptMission(userId: string, id: string): string {
  const m = getBundle().missions[id];
  if (!m) return 'Unknown mission.';

  const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
  if (row?.state === 'Accepted') return 'Already accepted.';
  if (row?.state === 'Completed') return 'Already completed. Turn it in.';
  if (row?.state === 'TurnedIn') return 'Already turned in.';

  const progress = Math.max(0, Number(row?.progress ?? row?.counter ?? 0));
  Q.upsert.run(userId, id, 'Accepted', progress, progress);
  return 'Accepted.';
}

export function turnInMission(userId: string, id: string): { ok: boolean; msg: string; rewardZ: number; rewardChips: string[] } {
  const m = getBundle().missions[id];
  if (!m) return { ok: false, msg: 'Unknown mission.', rewardZ: 0, rewardChips: [] };

  const row = Q.getRow.get(userId, id) as MissionStateRow | undefined;
  if (!row || row.state !== 'Completed') return { ok: false, msg: 'Not completed yet.', rewardZ: 0, rewardChips: [] };

  const rewardZ = Number(m.reward_zenny || 0);
  const chips = String(m.reward_chip_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (rewardZ) addZenny(userId, rewardZ);
  for (const c of chips) grantChip(userId, c, 1);

  const progress = Math.max(0, Number(row.progress ?? row.counter ?? 0));
  Q.upsert.run(userId, id, 'TurnedIn', progress, progress);
  return { ok: true, msg: 'Turned in.', rewardZ, rewardChips: chips };
}

/**
 * Defeat missions are opt-in. Only Accepted missions progress.
 */
export function progressDefeat(userId: string, virusId: string): string[] {
  const completed: string[] = [];
  const bundle = getBundle();

  for (const m of Object.values(bundle.missions) as any[]) {
    if (String(m.type || '').toLowerCase() !== 'defeat') continue;

    const req = parseDefeatRequirement(String(m.requirement || ''));
    if (!req || req.virusId !== virusId) continue;

    const row = Q.getRow.get(userId, m.id) as MissionStateRow | undefined;
    if (!row || row.state !== 'Accepted') continue;

    const cur = Math.max(0, Number(row.progress ?? row.counter ?? 0));
    const next = Math.min(req.needCount, cur + 1);
    const nextState: MissionState = next >= req.needCount ? 'Completed' : 'Accepted';
    Q.upsert.run(userId, m.id, nextState, next, next);

    if (nextState === 'Completed') completed.push(String(m.name || m.id));
  }

  return completed;
}

function parseDefeatRequirement(text: string): { virusId: string; needCount: number } | null {
  const [virusRaw, countRaw] = text.split(':').map(s => s.trim());
  if (!virusRaw) return null;
  const needCount = Math.max(1, Number(countRaw || 1) || 1);
  return { virusId: virusRaw, needCount };
}
