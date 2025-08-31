import { db } from './db';
import { getBundle } from './data';

const MAX_DUP = Number(process.env.FOLDER_MAX_DUP || 4);
const MEM_CAP = Number(process.env.FOLDER_MEM_CAP || 80);

export function getFolder(userId: string): string[] {
  const rows = db.prepare(`SELECT chip_id FROM folder WHERE user_id=? ORDER BY slot`).all(userId) as any[];
  return rows.map(r => r.chip_id);
}

export function setFolder(userId: string, ids: string[]) {
  db.prepare(`DELETE FROM folder WHERE user_id=?`).run(userId);
  const ins = db.prepare(`INSERT INTO folder (user_id, slot, chip_id) VALUES (?,?,?)`);
  ids.forEach((id, i) => ins.run(userId, i, id));
}

export function validateFolder(ids: string[]): { ok: boolean; msg?: string } {
  const b = getBundle();
  const counts: Record<string, number> = {};
  let mem = 0;

  for (const id of ids) {
    if (!b.chips[id]) return { ok:false, msg:`Unknown chip: ${id}` };
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > MAX_DUP) return { ok:false, msg:`Too many copies of ${id} (max ${MAX_DUP})` };
    mem += Number(b.chips[id].mb_cost || 0);
  }
  if (mem > MEM_CAP) return { ok:false, msg:`Memory ${mem}/${MEM_CAP} exceeded` };
  if (ids.length !== 30) return { ok:false, msg:`Folder must have exactly 30 chips` };
  return { ok:true };
}
