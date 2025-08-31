// src/lib/settings-util.ts
export function wantDmg(_userId: string): boolean {
  return String(process.env.DMG_NUMBERS || 'off').toLowerCase() === 'on';
}
