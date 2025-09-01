import { getBundle } from './data';

/** Try to collapse the chosen chips into a Program Advance.
 *  Returns a replacement chipId if matched, else null.
 */
export function detectPA(chosenIds: string[]): string | null {
  if (!chosenIds.length) return null;
  const b = getBundle();
  const list = Object.values(b.programAdvances || {});
  if (!list.length) return null;

  // Build multiset of chosen
  const bag = new Map<string, number>();
  for (const id of chosenIds) bag.set(id, (bag.get(id) || 0) + 1);

  for (const pa of list) {
    const reqIds = String(pa.required_chip_ids || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (!reqIds.length) continue;

    // multiset match
    const tmp = new Map(bag);
    let ok = true;
    for (const rid of reqIds) {
      const cur = tmp.get(rid) || 0;
      if (cur <= 0) { ok = false; break; }
      tmp.set(rid, cur - 1);
    }
    if (!ok) continue;

    // letter requirement (optional): single letter like "S"
    const reqLetter = (pa.required_letters || '').trim();
    if (reqLetter && reqLetter !== '*') {
      // ensure every chosen chip has that letter
      for (const id of chosenIds) {
        const letters = (b.chips[id]?.letters || '').split(',').map(x=>x.trim());
        if (!letters.includes(reqLetter) && !letters.includes('*')) { ok = false; break; }
      }
      if (!ok) continue;
    }

    return pa.result_chip_id || null;
  }

  return null;
}
