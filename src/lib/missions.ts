import { db, addZenny, grantChip } from './db';
import { getBundle } from './data';

db.exec(`
CREATE TABLE IF NOT EXISTS missions_state (
  user_id   TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'Available', -- Available|Accepted|Completed|TurnedIn
  counter   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mission_id)
);
`);

type MissionRow = {
  user_id: string;
  mission_id: string;
  state: 'Available' | 'Accepted' | 'Completed' | 'TurnedIn';
  counter: number;
};

const Q = {
  getRow: db.prepare(`SELECT * FROM missions_state WHERE user_id=? AND mission_id=?`),
  upsert: db.prepare(`
    INSERT INTO missions_state (user_id, mission_id, state, counter) VALUES (?,?,?,?)
    ON CONFLICT(user_id,mission_id) DO UPDATE SET state=excluded.state, counter=excluded.counter
  `),
  list: db.prepare(`SELECT * FROM missions_state WHERE user_id=?`),
};

export function listMissionsFor(userId: string): MissionRow[] {
  const all = getBundle().missions;
  const mine = new Map<string, MissionRow>();
  for (const id of Object.keys(all)) {
    const row = Q.getRow.get(userId, id) as MissionRow | undefined;
    mine.set(id, row ?? { user_id: userId, mission_id: id, state: 'Available', counter: 0 });
  }
  return Array.from(mine.values());
}

export function acceptMission(userId: string, id: string): string {
  const m = getBundle().missions[id];
  if (!m) return 'Unknown mission.';
  const row = Q.getRow.get(userId, id) as MissionRow | undefined;
  if (row?.state === 'Accepted') return 'Already accepted.';
  if (row?.state === 'Completed') return 'Already completed.';
  if (row?.state === 'TurnedIn') return 'Already turned in.';
  Q.upsert.run(userId, id, 'Accepted', row?.counter ?? 0);
  return 'Accepted.';
}

export function turnInMission(
  userId: string,
  id: string
): { ok: boolean; msg: string; rewardZ: number; rewardChips: string[] } {
  const m = getBundle().missions[id];
  if (!m) return { ok: false, msg: 'Unknown mission.', rewardZ: 0, rewardChips: [] };

  const row = Q.getRow.get(userId, id) as MissionRow | undefined;
  if (!row || row.state !== 'Completed') {
    return { ok: false, msg: 'Not completed yet.', rewardZ: 0, rewardChips: [] };
  }

  const rewardZ = Number(m.reward_zenny || 0) | 0;
  const chips = String(m.reward_chip_ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (rewardZ) addZenny(userId, rewardZ);
  for (const c of chips) grantChip(userId, c, 1);

  Q.upsert.run(userId, id, 'TurnedIn', row.counter);
  return { ok: true, msg: 'Turned in.', rewardZ, rewardChips: chips };
}

/** Call after defeating a virus to tick mission progress for "Defeat" missions. */
export function progressDefeat(userId: string, virusId: string): void {
  const bundle = getBundle();
  for (const m of Object.values<any>(bundle.missions)) {
    if (m.type !== 'Defeat') continue;

    const [needId, needCountStr] = String(m.requirement || '').split(':');
    if (!needId || needId !== virusId) continue;

    const needCount = Math.max(1, Number(needCountStr || '1') | 0);
    const cur = (Q.getRow.get(userId, m.id) as MissionRow | undefined) ?? {
      user_id: userId, mission_id: m.id, state: 'Available', counter: 0,
    };

    const nextCounter = Math.min(needCount, (cur.counter ?? 0) + 1);
    const nextState =
      nextCounter >= needCount
        ? 'Completed'
        : cur.state === 'Available'
        ? 'Accepted'
        : cur.state;

    Q.upsert.run(userId, m.id, nextState, nextCounter);
  }
}
